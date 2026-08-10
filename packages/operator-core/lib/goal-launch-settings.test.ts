/**
 * Per-goal launch settings + the one launch resolver
 * (goal-mode-hardening-2026-08-10 P-004, D-009) over a mock sql seam (no PG).
 *
 * The invariant under test is not "a number comes back". It is that the two
 * D-005 ceilings COMPOSE and that neither can be silently skipped:
 *
 *   • a fleet member counts against its fleet's cap AND the goal's total, so a
 *     fleet with room can still be refused by the goal — the case a per-fleet
 *     cap alone would wave through, and the reason D-005 asks for both;
 *   • a ceiling that cannot be COUNTED is reported as unenforced rather than
 *     passing silently, because "no refusal" and "no ceiling applied" are
 *     otherwise indistinguishable to a caller;
 *   • the goal is resolved from the LAUNCHER and never accepted as an argument,
 *     which is what stops a future launch door from dropping goal context by
 *     forgetting to pass it (D-008's constraint, made structural).
 *
 * WHAT A MOCK CANNOT PROVE: that the headcount SQL's liveness join and its
 * boot-grace leg select the right rows. A mock returns whatever fixture it is
 * handed. That half is verified against live PG separately; these tests pin the
 * DECISION logic sitting on top of it.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  goalLaunchSettingsSchema,
  launchProfileSchema,
  foldLaunchProfile,
  readGoalLaunchSettings,
  writeGoalLaunchSettings,
  resolveGoalLaunch,
  type GoalLaunchSettings,
} from './goal-launch-settings';

interface MockOpts {
  /** agent_modes rows — an entry here means that owner RUNS the goal. */
  modeSubject?: Record<string, string>;
  /** session_briefs.goal_id — an entry means that owner INHERITED the goal. */
  inherited?: Record<string, string>;
  /** launch_settings by goal id. */
  settings?: Record<string, unknown>;
  /** headcount fixture by goal id. */
  headcount?: Record<string, { total: number; fleet: number }>;
  /** Force a hard failure on any statement matching this. */
  failOn?: RegExp;
  /** Statements the mock actually saw, for structural assertions. */
  seen?: string[];
}

function mockSql(opts: MockOpts = {}): Sql {
  const fn = (first: unknown, ...vals: unknown[]): unknown => {
    if (!Array.isArray(first) || !('raw' in (first as object))) return { __in: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
    opts.seen?.push(text);
    if (opts.failOn?.test(text)) return Promise.reject(new Error('boom'));

    // resolveGoalContext leg 1 — does this owner RUN a goal?
    if (text.includes('SELECT subject FROM harness_shared.agent_modes')) {
      const owner = vals[1] as string;
      const subj = opts.modeSubject?.[owner];
      return Promise.resolve(subj ? [{ subject: subj }] : []);
    }
    // resolveGoalContext leg 2 — did this owner INHERIT one?
    if (text.includes('SELECT goal_id FROM harness_shared.session_briefs')) {
      const owner = vals[0] as string;
      const g = opts.inherited?.[owner];
      return Promise.resolve(g ? [{ goal_id: g }] : []);
    }
    if (text.includes('SELECT launch_settings FROM harness_shared.goals')) {
      const goalId = vals[0] as string;
      if (!(goalId in (opts.settings ?? {}))) return Promise.resolve([]);
      return Promise.resolve([{ launch_settings: opts.settings![goalId] }]);
    }
    if (text.includes('FROM harness_shared.session_briefs b')) {
      // Located by VALUE, not by index. A positional lookup here silently
      // returns the zero fixture if the query's parameter order ever changes,
      // which reads as "nothing is running" and turns every ceiling test green
      // for the wrong reason.
      const goalId = (vals as unknown[]).find(
        (v) => typeof v === 'string' && v in (opts.headcount ?? {}),
      ) as string | undefined;
      const hc = (goalId ? opts.headcount?.[goalId] : undefined) ?? { total: 0, fleet: 0 };
      return Promise.resolve([{ total: hc.total, fleet: hc.fleet }]);
    }
    if (text.includes('UPDATE harness_shared.goals')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

const WS = 'ws-1';

describe('goalLaunchSettingsSchema', () => {
  it('accepts a full document', () => {
    const doc: GoalLaunchSettings = {
      maxAgents: 12,
      maxPerFleet: 4,
      defaults: { agent: 'claude', model: 'sonnet', effort: 'high', carry: 'warm' },
      roles: { reviewer: { model: 'opus', effort: 'xhigh', account: 'auto' } },
    };
    expect(goalLaunchSettingsSchema.safeParse(doc).success).toBe(true);
  });

  it('REJECTS an unknown key rather than silently dropping it', () => {
    // The owner hand-edits this in the P-005 panel. A typo that parses is a
    // setting that reads back as present while the launch ignores it.
    const r = goalLaunchSettingsSchema.safeParse({ maxAgent: 5 });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown key inside a role profile too', () => {
    expect(
      goalLaunchSettingsSchema.safeParse({ roles: { dev: { modle: 'opus' } } }).success,
    ).toBe(false);
  });

  it('rejects a non-positive ceiling — 0 agents is a paused goal, not a launch policy', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 0 }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: -1 }).success).toBe(false);
  });

  it('allows null to mean "no ceiling"', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: null }).success).toBe(true);
  });

  it('constrains carry and contextSize to the values psu honours', () => {
    expect(launchProfileSchema.safeParse({ carry: 'warm' }).success).toBe(true);
    expect(launchProfileSchema.safeParse({ carry: 'hot' }).success).toBe(false);
    expect(launchProfileSchema.safeParse({ contextSize: 'trimmed' }).success).toBe(true);
    expect(launchProfileSchema.safeParse({ contextSize: 'medium' }).success).toBe(false);
  });
});

describe('foldLaunchProfile', () => {
  const settings: GoalLaunchSettings = {
    defaults: { model: 'sonnet', effort: 'medium', carry: 'warm' },
    roles: { reviewer: { model: 'opus' } },
  };

  it('layers role over defaults', () => {
    expect(foldLaunchProfile(settings, 'reviewer')).toEqual({
      model: 'opus',
      effort: 'medium',
      carry: 'warm',
    });
  });

  it('falls back to defaults for a role with no profile', () => {
    expect(foldLaunchProfile(settings, 'builder').model).toBe('sonnet');
  });

  it('lets an explicit caller request beat the stored policy', () => {
    // The settings are standing policy; a value the caller just chose
    // deliberately for THIS launch is not something policy should override.
    expect(foldLaunchProfile(settings, 'reviewer', { model: 'haiku' }).model).toBe('haiku');
  });

  it('leaves an unset key ABSENT so the composer applies the system default', () => {
    // Not `account: undefined` and not an invented value — absent, so
    // buildAgentLaunchCommand reaches defaultLaunchAccount() as it does today.
    expect('account' in foldLaunchProfile(settings, 'reviewer')).toBe(false);
  });

  it('ignores empty strings from a half-filled form', () => {
    expect(foldLaunchProfile(settings, 'reviewer', { model: '' }).model).toBe('opus');
  });

  it('returns an empty profile when a goal has no settings at all', () => {
    expect(foldLaunchProfile(null, 'reviewer')).toEqual({});
  });
});

describe('readGoalLaunchSettings', () => {
  it('reports "none declared" for a NULL column — the common case, not an error', async () => {
    const r = await readGoalLaunchSettings('g1', mockSql({ settings: { g1: null } }));
    expect(r).toEqual({ settings: null, error: null });
  });

  it('parses a jsonb string as readily as an object', async () => {
    const r = await readGoalLaunchSettings('g1', mockSql({ settings: { g1: '{"maxAgents":3}' } }));
    expect(r.settings?.maxAgents).toBe(3);
  });

  it('reports a MALFORMED document as an error instead of treating it as absent', async () => {
    // Absent means "no ceiling declared" — a legitimate state. Malformed means
    // the owner declared one and it is NOT in force. Collapsing the two hides
    // exactly the case they need to hear about.
    const r = await readGoalLaunchSettings('g1', mockSql({ settings: { g1: { maxAgents: -5 } } }));
    expect(r.settings).toBeNull();
    expect(r.error).toMatch(/invalid/i);
  });

  it('fails soft on a dead database', async () => {
    const r = await readGoalLaunchSettings('g1', mockSql({ failOn: /goals/ }));
    expect(r.settings).toBeNull();
    expect(r.error).toBe('boom');
  });
});

describe('writeGoalLaunchSettings', () => {
  it('refuses to persist an invalid document', async () => {
    const r = await writeGoalLaunchSettings('g1', { maxAgents: 0 } as GoalLaunchSettings, mockSql());
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('accepts null as an explicit clear', async () => {
    const seen: string[] = [];
    const r = await writeGoalLaunchSettings('g1', null, mockSql({ seen }));
    expect(r.ok).toBe(true);
    expect(seen.some((s) => s.includes('UPDATE harness_shared.goals'))).toBe(true);
  });
});

describe('resolveGoalLaunch — goal resolution', () => {
  it('resolves the goal from the LAUNCHER and takes no goalId argument', async () => {
    // Structural: the signature has no goalId. This asserts the behaviour that
    // makes that safe — a launcher running a goal yields that goal with nothing
    // passed in.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' } }),
    });
    expect(r.goalId).toBe('g1');
  });

  it('resolves the INHERITED goal for a launcher that merely works under one', async () => {
    // Transitivity: a fleet member spawning a helper keeps the goal, so the
    // grandchild is bounded by the same ceiling as the goal agent's own spawns.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-member',
      sql: mockSql({ inherited: { 'su-member': 'g1' } }),
    });
    expect(r.goalId).toBe('g1');
  });

  it('is inert with no goal in scope — no ceiling, no profile, not degraded', async () => {
    const r = await resolveGoalLaunch({ workspaceId: WS, launcherOwnerId: 'su-x', sql: mockSql() });
    expect(r.goalId).toBeNull();
    expect(r.refusal).toBeNull();
    expect(r.ceilings).toEqual({ maxAgents: null, maxPerFleet: null });
    expect(r.degraded).toBe(false);
  });
});

describe('resolveGoalLaunch — the D-005 ceilings', () => {
  const base = (settings: unknown, headcount: { total: number; fleet: number }) =>
    mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: settings }, headcount: { g1: headcount } });

  it('admits a launch with headroom', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: base({ maxAgents: 10 }, { total: 3, fleet: 0 }),
    });
    expect(r.refusal).toBeNull();
    expect(r.headcount.total).toBe(3);
  });

  it('refuses the N+1th agent', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: base({ maxAgents: 4 }, { total: 4, fleet: 0 }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
    expect(r.refusal?.limit).toBe(4);
    expect(r.refusal?.current).toBe(4);
  });

  it('refuses an over-large BATCH once, up front', async () => {
    // A fleet of 10 against room for 3 is refused here rather than discovered on
    // the 4th spawn with 3 half-briefed members already running.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      count: 10,
      sql: base({ maxAgents: 10 }, { total: 7, fleet: 0 }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
    expect(r.refusal?.requested).toBe(10);
  });

  it('refuses on the per-fleet cap', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      fleetSlug: 'f1',
      sql: base({ maxPerFleet: 5 }, { total: 20, fleet: 5 }),
    });
    expect(r.refusal?.reason).toBe('fleet_max_agents');
  });

  it('COMPOSES: a fleet with room is still refused when the GOAL is full', async () => {
    // The load-bearing D-005 case. A per-fleet cap alone waves this through —
    // the fleet has 1 of 5 — and the goal quietly runs 12 agents against a
    // ceiling of 12. The goal ceiling must be checked independently of the fleet.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      fleetSlug: 'f1',
      sql: base({ maxAgents: 12, maxPerFleet: 5 }, { total: 12, fleet: 1 }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
  });

  it('skips the headcount query entirely when no ceiling is declared', async () => {
    // The resolver is on every launch path; it must not add a count query to
    // launches it cannot refuse.
    const seen: string[] = [];
    await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: { defaults: { model: 'opus' } } }, seen }),
    });
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(false);
  });
});

describe('resolveGoalLaunch — degradation is REPORTED, never silent', () => {
  it('fails OPEN when the headcount cannot be taken, and says the ceiling was not enforced', async () => {
    // Failing closed would brick every launch in the workspace on a transient
    // error, including the launches needed to repair it. But "no refusal" must
    // not be readable as "within the ceiling".
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: 1 } },
        failOn: /FROM harness_shared\.session_briefs b/,
      }),
    });
    expect(r.refusal).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons.join(' ')).toMatch(/ceiling not enforced/);
  });

  it('reports an unreadable settings document without blocking the launch', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: { maxAgents: 'lots' } } }),
    });
    expect(r.refusal).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons.join(' ')).toMatch(/launch settings not applied/);
  });
});

describe('resolveGoalLaunch — profile hand-down', () => {
  it('hands down the per-role profile the goal declared', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      role: 'reviewer',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { defaults: { model: 'sonnet', carry: 'warm' }, roles: { reviewer: { model: 'opus' } } } },
      }),
    });
    expect(r.effective).toEqual({ model: 'opus', carry: 'warm' });
  });

  it('actually goes through the mode-subject lookup (mock fidelity)', async () => {
    // Guards the mock against itself: every ceiling assertion above depends on
    // the mode-subject leg matching a query the resolver really makes. If that
    // statement's text ever moves, the mock stops matching, `goalId` comes back
    // null, and the ceiling tests all pass by resolving no goal at all.
    const seen: string[] = [];
    await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, seen }),
    });
    expect(seen.some((s) => s.includes('SELECT subject FROM harness_shared.agent_modes'))).toBe(true);
  });
});
