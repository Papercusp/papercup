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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// P-006: the budget gate reads its flag and opens its escalation through
// DYNAMIC imports (the module keeps heavyweight deps out of the launch path's
// static graph), so both seams are mocked at the module level. State lives in
// vi.hoisted so the factory closures survive hoisting.
const budgetGateFlag = vi.hoisted(() => ({ value: true, throws: false }));
const escalated = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => {
    if (budgetGateFlag.throws) throw new Error('flag infra down');
    return budgetGateFlag.value;
  },
}));
vi.mock('./agent-tools/coordination/escalations', () => ({
  openEscalation: async (identity: unknown, input: Record<string, unknown>) => {
    escalated.calls.push({ identity, ...input });
    return {};
  },
}));
import {
  GOAL_LAUNCH_DEFAULTS,
  UNLIMITED_CEILING,
  goalLaunchSettingsSchema,
  launchProfileSchema,
  foldLaunchProfile,
  GOAL_LAUNCH_ROLES,
  isGoalLaunchRole,
  readGoalLaunchSettings,
  writeGoalLaunchSettings,
  resolveCeiling,
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
  /** P-006 budget fixture by goal id — budget_cents as pg hands it over (bigint
   *  ⇒ string) and spent_cents as the jsonb scalar `metadata->'spentCents'`. */
  budget?: Record<
    string,
    { budget_cents?: number | string | null; spent_cents?: unknown; spent_cents_at?: string | null }
  >;
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
    if (text.includes('SELECT launch_settings')) {
      const goalId = vals[0] as string;
      const known = goalId in (opts.settings ?? {}) || goalId in (opts.budget ?? {});
      if (!known) return Promise.resolve([]);
      const b = opts.budget?.[goalId];
      return Promise.resolve([
        {
          launch_settings: opts.settings?.[goalId] ?? null,
          budget_cents: b?.budget_cents ?? null,
          spent_cents: b?.spent_cents ?? null,
          spent_cents_at: b?.spent_cents_at ?? null,
        },
      ]);
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
      roles: { grading: { model: 'opus', effort: 'xhigh', account: 'auto' } },
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
      goalLaunchSettingsSchema.safeParse({ roles: { grading: { modle: 'opus' } } }).success,
    ).toBe(false);
  });

  it('rejects a non-positive ceiling — 0 agents is a paused goal, not a launch policy', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 0 }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: -1 }).success).toBe(false);
  });

  it('allows null — which since D-015 means "unpinned", not "no ceiling"', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: null }).success).toBe(true);
  });

  it('accepts the explicit unlimited literal on either ceiling', () => {
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: UNLIMITED_CEILING }).success).toBe(true);
    expect(goalLaunchSettingsSchema.safeParse({ maxPerFleet: UNLIMITED_CEILING }).success).toBe(true);
  });

  it('rejects any OTHER string, so a typo cannot read as an opt-out', () => {
    // 'unlimted' silently accepted would store a ceiling nobody enforces while
    // the panel shows it as set — the exact class .strict() exists to catch, one
    // level down at the value.
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 'unlimted' }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: 'none' }).success).toBe(false);
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: '12' }).success).toBe(false);
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
    roles: { grading: { model: 'opus' } },
  };

  it('layers the slot profile over defaults', () => {
    expect(foldLaunchProfile(settings, 'grading')).toEqual({
      model: 'opus',
      effort: 'medium',
      carry: 'warm',
    });
  });

  it('falls back to defaults for a slot with no profile', () => {
    expect(foldLaunchProfile(settings, 'test').model).toBe('sonnet');
  });

  it('lets an explicit caller request beat the stored policy', () => {
    // The settings are standing policy; a value the caller just chose
    // deliberately for THIS launch is not something policy should override.
    expect(foldLaunchProfile(settings, 'grading', { model: 'haiku' }).model).toBe('haiku');
  });

  it('leaves an unset key ABSENT so the composer applies the system default', () => {
    // Not `account: undefined` and not an invented value — absent, so
    // buildAgentLaunchCommand reaches defaultLaunchAccount() as it does today.
    expect('account' in foldLaunchProfile(settings, 'grading')).toBe(false);
  });

  it('ignores empty strings from a half-filled form', () => {
    expect(foldLaunchProfile(settings, 'grading', { model: '' }).model).toBe('opus');
  });

  it('returns an empty profile when a goal has no settings at all', () => {
    expect(foldLaunchProfile(null, 'grading')).toEqual({});
  });
});

describe('D-016 / WI-38048 — profiles bind by launch SLOT, never by psu --role', () => {
  // THE DEFECT THIS PINS. `roles` used to take free-text keys and the launch
  // doors looked them up by psu `--role`. Persona is `su` for ~every session
  // (measured: 121 of 124 live), so a profile the owner configured for a
  // contract slot matched nothing — the panel read as configured while every
  // launch ignored it. Both halves are asserted here: a psu role can no longer
  // be STORED, and a real slot actually BINDS.

  it('accepts every slot the GOAL contract enumerates', () => {
    // Guards the count too: the contract lists SEVEN slots and goals:start uses
    // an eighth (`goal`). WI-38048's own prose said "six" — building to that
    // number silently refuses two slots that are already in use.
    expect(GOAL_LAUNCH_ROLES).toHaveLength(8);
    for (const slot of GOAL_LAUNCH_ROLES) {
      const r = goalLaunchSettingsSchema.safeParse({ roles: { [slot]: { model: 'opus' } } });
      expect(r.success, `slot ${slot} should be storable`).toBe(true);
    }
  });

  it('REFUSES a psu --role as a profile key — the exact key the old doors passed', () => {
    // `su` is what launch-on-plan / launch-agent / fleet-headcount-action all
    // fed the lookup. Storing it has to fail at WRITE time, because a stored
    // key that binds nothing is indistinguishable from a working setting.
    expect(goalLaunchSettingsSchema.safeParse({ roles: { su: { model: 'opus' } } }).success).toBe(
      false,
    );
    expect(goalLaunchSettingsSchema.safeParse({ roles: { scout: { model: 'opus' } } }).success).toBe(
      false,
    );
  });

  it('REFUSES free-text keys generally, so a typo cannot masquerade as a slot', () => {
    for (const key of ['reviewer', 'builder', 'dev', 'plan-fleet-membr', '']) {
      expect(
        goalLaunchSettingsSchema.safeParse({ roles: { [key]: { model: 'opus' } } }).success,
        `key ${JSON.stringify(key)} must not be storable`,
      ).toBe(false);
    }
  });

  it('BINDS: a slot profile reaches the effective launch knobs, not just the document', () => {
    // D-016's verification standard — prove BINDING, not WRITING. The old code
    // saved this document perfectly well and bound none of it.
    const settings: GoalLaunchSettings = {
      defaults: { model: 'sonnet' },
      roles: {
        'plan-fleet-member': { model: 'opus', effort: 'xhigh' },
        'drain-fleet-member': { model: 'haiku' },
      },
    };
    expect(foldLaunchProfile(settings, 'plan-fleet-member')).toEqual({
      model: 'opus',
      effort: 'xhigh',
    });
    // and the slots do not bleed into one another
    expect(foldLaunchProfile(settings, 'drain-fleet-member').model).toBe('haiku');
    expect(foldLaunchProfile(settings, 'grading').model).toBe('sonnet');
  });

  it('isGoalLaunchRole separates a slot from a persona', () => {
    expect(isGoalLaunchRole('plan-fleet-leader')).toBe(true);
    expect(isGoalLaunchRole('goal')).toBe(true);
    expect(isGoalLaunchRole('su')).toBe(false);
    expect(isGoalLaunchRole(undefined)).toBe(false);
  });
});

describe('readGoalLaunchSettings', () => {
  it('reports "none declared" for a NULL column — the common case, not an error', async () => {
    const r = await readGoalLaunchSettings('g1', mockSql({ settings: { g1: null } }));
    expect(r).toEqual({
      settings: null,
      error: null,
      // P-006: budget truth rides the same row read; a goal with nothing
      // declared resolves an all-null truth, not an absent one.
      budget: { budgetCents: null, spentCents: null, spentCentsAt: null },
    });
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
    // maxAgents is opted out EXPLICITLY so this isolates the per-fleet leg.
    // Leaving it unset used to do that; since D-015 an unset ceiling is the
    // default (12), and a fixture with 20 live agents would be refused by the
    // GOAL leg before the fleet leg is ever reached — the test would still pass
    // for a while, then start asserting the wrong mechanism.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      fleetSlug: 'f1',
      sql: base({ maxAgents: UNLIMITED_CEILING, maxPerFleet: 5 }, { total: 20, fleet: 5 }),
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

  it('skips the headcount query only when BOTH ceilings are explicitly unlimited', async () => {
    // The resolver is on every launch path; it must not add a count query to
    // launches it cannot refuse. Since D-015 that is the RARE case — a goal has
    // to have opted out of both ceilings by name to get here.
    const seen: string[] = [];
    await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: UNLIMITED_CEILING, maxPerFleet: UNLIMITED_CEILING } },
        seen,
      }),
    });
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(false);
  });
});

describe('resolveGoalLaunch — the D-015 system defaults', () => {
  /**
   * The regression these pin is not "the numbers changed". It is that an
   * UNPINNED goal used to be UNGOVERNED: with both ceilings null, `needsCount`
   * went false, the headcount was never taken and nothing could be refused —
   * while D-004 had already deleted the capacity preflight on the premise that
   * these ceilings were doing the work. Nine of eleven live goals were in that
   * state when it was found.
   */

  it('governs a goal that has pinned NOTHING — the case that was ungoverned', async () => {
    const seen: string[] = [];
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      // No settings row at all: the shape 9 of 11 live goals were in.
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, headcount: { g1: { total: 0, fleet: 0 } }, seen }),
    });
    expect(r.ceilings.maxAgents).toBe(GOAL_LAUNCH_DEFAULTS.maxAgents);
    expect(r.ceilings.maxPerFleet).toBe(GOAL_LAUNCH_DEFAULTS.maxPerFleet);
    // The count is the proof it is ENFORCEABLE, not merely reported: a ceiling
    // nobody counts against refuses nothing.
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(true);
  });

  it('actually REFUSES an unpinned goal at the default, rather than reporting a number it ignores', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        headcount: { g1: { total: GOAL_LAUNCH_DEFAULTS.maxAgents, fleet: 0 } },
      }),
    });
    expect(r.refusal?.reason).toBe('goal_max_agents');
    expect(r.refusal?.limit).toBe(GOAL_LAUNCH_DEFAULTS.maxAgents);
  });

  it('says the ceiling was a DEFAULT, so nobody hunts the panel for a number they never typed', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        headcount: { g1: { total: GOAL_LAUNCH_DEFAULTS.maxAgents, fleet: 0 } },
      }),
    });
    expect(r.refusal?.message).toContain('system default');
  });

  it('does NOT claim a default when the owner pinned the number themselves', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: 2 } },
        headcount: { g1: { total: 2, fleet: 0 } },
      }),
    });
    expect(r.refusal?.limit).toBe(2);
    expect(r.refusal?.message).not.toContain('system default');
  });

  it('a pinned ceiling beats the default in BOTH directions', async () => {
    const lower = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: { maxAgents: 3 } }, headcount: { g1: { total: 0, fleet: 0 } } }),
    });
    expect(lower.ceilings.maxAgents).toBe(3);
    const higher = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({ modeSubject: { 'su-goal': 'g1' }, settings: { g1: { maxAgents: 400 } }, headcount: { g1: { total: 0, fleet: 0 } } }),
    });
    expect(higher.ceilings.maxAgents).toBe(400);
  });

  it('lets an owner opt a goal OUT entirely, and admits a launch the default would refuse', async () => {
    // The owner-directed half of D-015: absent means "defaulted", so ungoverned
    // has to remain SAYABLE — and saying it has to actually work.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      count: 50,
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: UNLIMITED_CEILING } },
        headcount: { g1: { total: 999, fleet: 0 } },
      }),
    });
    expect(r.ceilings.maxAgents).toBeNull();
    expect(r.refusal).toBeNull();
  });

  it('opting ONE ceiling out leaves the OTHER on its default — they are independent', async () => {
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      fleetSlug: 'f1',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { maxAgents: UNLIMITED_CEILING } },
        headcount: { g1: { total: 999, fleet: GOAL_LAUNCH_DEFAULTS.maxPerFleet } },
      }),
    });
    expect(r.ceilings.maxAgents).toBeNull();
    expect(r.ceilings.maxPerFleet).toBe(GOAL_LAUNCH_DEFAULTS.maxPerFleet);
    expect(r.refusal?.reason).toBe('fleet_max_agents');
  });

  it('applies NO ceiling when there is no goal in scope — defaults are per-GOAL, not global', async () => {
    // A launch outside any goal is not a goal launch. Defaulting it to 12 would
    // put a goal-mode ceiling on every ordinary spawn in the workspace.
    const r = await resolveGoalLaunch({ workspaceId: WS, launcherOwnerId: 'su-nobody', sql: mockSql({}) });
    expect(r.goalId).toBeNull();
    expect(r.ceilings).toEqual({ maxAgents: null, maxPerFleet: null });
    expect(r.refusal).toBeNull();
  });
});

describe('resolveCeiling — the three states stay three', () => {
  it('maps each state to its own outcome', () => {
    expect(resolveCeiling(undefined, 12)).toBe(12);
    expect(resolveCeiling(null, 12)).toBe(12);
    expect(resolveCeiling(UNLIMITED_CEILING, 12)).toBeNull();
    expect(resolveCeiling(7, 12)).toBe(7);
  });

  it('keeps unlimited and unpinned DISTINGUISHABLE — collapsing them is the original bug', () => {
    expect(resolveCeiling(UNLIMITED_CEILING, 12)).not.toBe(resolveCeiling(undefined, 12));
  });

  it('defaults are above the contract floor of 8', () => {
    // The GOAL contract obliges a goal agent + a standing drain fleet + one plan
    // fleet. A default below that refuses the fleet the contract mandates, so
    // the default itself would be the bug. This guards the NUMBER against a
    // well-meaning trim.
    expect(GOAL_LAUNCH_DEFAULTS.maxAgents).toBeGreaterThanOrEqual(8);
    // And a goal must be able to run more than one fleet at a time, or
    // "parallelize hard" is unreachable by construction.
    expect(GOAL_LAUNCH_DEFAULTS.maxAgents).toBeGreaterThan(GOAL_LAUNCH_DEFAULTS.maxPerFleet * 2);
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
  it('hands down the per-SLOT profile the goal declared', async () => {
    // D-016: keyed by launch slot. Before that, this passed psu `--role` and so
    // only ever bound for a goal whose owner had guessed a psu role string.
    const r = await resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      goalRole: 'grading',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        settings: { g1: { defaults: { model: 'sonnet', carry: 'warm' }, roles: { grading: { model: 'opus' } } } },
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

/**
 * P-006 (goal-mode-design-intent-hardening-2026-08-16): goals.budget_cents is a
 * BINDING launch ceiling over the PLATFORM spend snapshot. The invariants:
 *
 *   • the ceiling is INCLUSIVE — spent == budget refuses (the off-by-one that
 *     admits one launch past every budget is pinned by a permanent wrong
 *     comparator, the falsifiability control);
 *   • D-003 — a declared budget with NO platform snapshot degrades, it never
 *     guesses (a null from a careful platform outranks an invented figure);
 *   • the kill-switch (flag OFF) is deliberate config and silent, while a flag
 *     INFRA failure is a declared-but-unenforced ceiling and must be reported;
 *   • the refusal escalates the OWNER, deduped per goal, attributed to the
 *     refused launcher.
 */
describe('P-006: the budget launch gate', () => {
  beforeEach(() => {
    budgetGateFlag.value = true;
    budgetGateFlag.throws = false;
    escalated.calls.length = 0;
  });

  const launchWithBudget = (
    budget: { budget_cents?: number | string | null; spent_cents?: unknown; spent_cents_at?: string | null },
    seen?: string[],
  ) =>
    resolveGoalLaunch({
      workspaceId: WS,
      launcherOwnerId: 'su-goal',
      sql: mockSql({
        modeSubject: { 'su-goal': 'g1' },
        budget: { g1: budget },
        ...(seen ? { seen } : {}),
      }),
    });

  it('refuses at spent == budget (the ceiling is inclusive) and skips the headcount read', async () => {
    const seen: string[] = [];
    const r = await launchWithBudget(
      { budget_cents: 5000, spent_cents: 5000, spent_cents_at: '2026-08-17T03:00:00Z' },
      seen,
    );
    expect(r.refusal).not.toBeNull();
    expect(r.refusal!.reason).toBe('goal_budget_exceeded');
    expect(r.refusal!.limit).toBe(5000);
    expect(r.refusal!.current).toBe(5000);
    expect(r.refusal!.message).toContain('5000');
    // A formed budget refusal makes the headcount read pure overhead.
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(false);
  });

  it('CONTROL (falsifiability): the exclusive comparator admits the boundary the gate refuses', async () => {
    // Permanent wrong implementation — the natural mutant. If the gate ever
    // regresses from >= to >, the boundary case above and this pairing catch it:
    // the control PASSES a spent==budget launch that the real gate refuses.
    const wrongExceeds = (spent: number, budget: number): boolean => spent > budget;
    expect(wrongExceeds(5000, 5000)).toBe(false); // the mutant admits it…
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 5000 });
    expect(r.refusal?.reason).toBe('goal_budget_exceeded'); // …the real gate refuses it
  });

  it('admits under budget, surfaces the truth for display, and the agent ceilings still apply', async () => {
    const seen: string[] = [];
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 4999 }, seen);
    expect(r.refusal).toBeNull();
    expect(r.budget).toEqual({ budgetCents: 5000, spentCents: 4999, spentCentsAt: null });
    // Under budget the D-015 default ceilings still get their headcount.
    expect(seen.some((s) => s.includes('FROM harness_shared.session_briefs b'))).toBe(true);
  });

  it('coerces the bigint string budget_cents pg actually hands over', async () => {
    const r = await launchWithBudget({ budget_cents: '7000', spent_cents: 7000 });
    expect(r.refusal?.reason).toBe('goal_budget_exceeded');
    expect(r.refusal?.limit).toBe(7000);
  });

  it('D-003: a declared budget with NO snapshot degrades — never guesses, never refuses', async () => {
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: null });
    expect(r.refusal).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons.some((s) => s.includes('budget ceiling not enforced'))).toBe(true);
    expect(r.degradedReasons.some((s) => s.includes('no platform spend snapshot'))).toBe(true);
  });

  it('garbage spentCents reads as UNKNOWN (degraded), never as 0-spent (admit-on-garbage)', async () => {
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 'not-a-number' });
    expect(r.refusal).toBeNull();
    expect(r.budget?.spentCents).toBeNull();
    expect(r.degradedReasons.some((s) => s.includes('budget ceiling not enforced'))).toBe(true);
  });

  it('no budget declared → the gate is silent (no refusal, no degradation)', async () => {
    const r = await launchWithBudget({ budget_cents: null, spent_cents: 9999 });
    expect(r.refusal).toBeNull();
    expect(r.degradedReasons.filter((s) => s.includes('budget'))).toEqual([]);
    expect(r.budget).toEqual({ budgetCents: null, spentCents: 9999, spentCentsAt: null });
  });

  it('kill-switch: flag OFF admits over-budget launches SILENTLY (deliberate config, not degradation)', async () => {
    budgetGateFlag.value = false;
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 9999 });
    expect(r.refusal).toBeNull();
    expect(r.degradedReasons.filter((s) => s.includes('budget'))).toEqual([]);
    expect(escalated.calls.length).toBe(0);
  });

  it('flag INFRA failure fails OPEN but is REPORTED — a declared ceiling silently unenforced is the bug', async () => {
    budgetGateFlag.throws = true;
    const r = await launchWithBudget({ budget_cents: 5000, spent_cents: 9999 });
    expect(r.refusal).toBeNull();
    expect(r.degradedReasons.some((s) => s.includes('flag read failed'))).toBe(true);
  });

  it('escalates the owner on refusal: blocker severity, deduped per goal, attributed to the launcher', async () => {
    await launchWithBudget({ budget_cents: 5000, spent_cents: 6000 });
    await vi.waitFor(() => expect(escalated.calls.length).toBe(1));
    const call = escalated.calls[0]!;
    expect(call.severity).toBe('blocker');
    const meta = call.meta as Record<string, unknown>;
    expect(meta.dedupKind).toBe('goal-budget-exceeded');
    expect(meta.subjectSignature).toBe(`${WS}:g1`);
    expect((call.identity as { ownerId: string }).ownerId).toBe('su-goal');
  });
});
