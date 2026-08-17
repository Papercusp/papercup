/**
 * Goal-context resolution + launch-time inheritance
 * (goal-mode-hardening-2026-08-10 P-002, D-008) over a mock sql seam (no PG).
 *
 * The invariant these tests exist to pin is NOT "the resolver returns a string".
 * It is that goal PROVENANCE and GOAL MODE are separable: a descendant must
 * attribute its work to the goal while never becoming the goal's agent. A
 * regression that re-fused them would still pass a naive "does goal_id stamp?"
 * test, because stamping is precisely what a wrongly-inherited mode row also
 * achieves — so the mode-row assertion below is the load-bearing one.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  resolveGoalContext,
  getInheritedGoalContext,
  setInheritedGoalContext,
  stampPlanGoalProvenance,
} from './goal-context';
import { goalIdFromModes, isGoalSessionModes, GOAL_MODE } from './goal-session';
import { modeById, axisKeyFor } from './registry';

interface ModeRow {
  workspace_id: string;
  owner_id: string;
  axis_key: string;
  mode: string;
  subject: string | null;
}

/**
 * In-memory agent_modes + session_briefs behind a postgres.js-shaped tagged
 * template, matching the mockSql discipline in store.test.ts. `failOn` forces
 * the "column does not exist / PG down" path the fail-soft legs must survive.
 */
interface PlanRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  goal_id: string | null;
}

function mockSql(opts: { modes?: ModeRow[]; briefs?: Array<{ owner_id: string; workspace_id: string; goal_id: string | null }>; plans?: PlanRow[]; failOn?: RegExp } = {}) {
  const modes = [...(opts.modes ?? [])];
  const briefs = [...(opts.briefs ?? [])];
  const plans = [...(opts.plans ?? [])];

  const fn = (first: unknown, ...vals: unknown[]): unknown => {
    if (!Array.isArray(first) || !('raw' in (first as object))) return { __in: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
    if (opts.failOn?.test(text)) return Promise.reject(new Error('column "goal_id" does not exist'));

    if (text.includes('UPDATE harness_shared.harness_plans')) {
      const [goalId, ws, harness, slug] = vals as string[];
      for (const p of plans) {
        if (p.workspace_id !== ws || p.harness_slug !== harness || p.plan_slug !== slug) continue;
        // Faithful to the statement's OWN predicate: the `goal_id IS NULL`
        // guard is honored only when the SQL still carries it. Dropping the
        // clause in production makes this mock overwrite — which is exactly
        // what fails the first-attribution test below (falsifiability: the
        // mock must not hardcode the invariant the SQL is supposed to state).
        if (!text.includes('goal_id IS NULL') || p.goal_id == null) p.goal_id = goalId;
      }
      return Promise.resolve([]);
    }
    if (text.includes('SELECT subject FROM harness_shared.agent_modes')) {
      const [ws, owner, axis, mode] = vals as string[];
      const row = modes.find(
        (m) => m.workspace_id === ws && m.owner_id === owner && m.axis_key === axis && m.mode === mode,
      );
      return Promise.resolve(row ? [{ subject: row.subject }] : []);
    }
    if (text.includes('SELECT goal_id FROM harness_shared.session_briefs')) {
      const [owner, ws] = vals as string[];
      const row = briefs.find((b) => b.owner_id === owner && b.workspace_id === ws);
      return Promise.resolve(row ? [{ goal_id: row.goal_id }] : []);
    }
    if (text.includes('INSERT INTO harness_shared.session_briefs')) {
      const [owner, ws, goalId] = vals as string[];
      const existing = briefs.find((b) => b.owner_id === owner);
      if (existing) existing.goal_id = goalId;
      else briefs.push({ owner_id: owner, workspace_id: ws, goal_id: goalId });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as Sql, briefs, plans };
}

const WS = 'ws-1';

// Derived from the registry, never hardcoded: GOAL's axis is 'overlay', not
// 'goal', and a mock that assumed otherwise returned no rows — which reads as
// "this agent runs no goal", i.e. a green-looking false negative. Deriving it
// means a future axis change moves the mock with the code instead of silently
// unhooking these tests.
const GOAL_AXIS = axisKeyFor(modeById(GOAL_MODE)!);

function goalMode(ownerId: string, subject: string | null): ModeRow {
  return { workspace_id: WS, owner_id: ownerId, axis_key: GOAL_AXIS, mode: GOAL_MODE, subject };
}

describe('resolveGoalContext', () => {
  it('resolves the goal an agent RUNS from its own goal-mode subject', async () => {
    const { sql } = mockSql({ modes: [goalMode('agent-a', 'goal-42')] });
    expect(await resolveGoalContext(WS, 'agent-a', sql)).toBe('goal-42');
  });

  it('resolves an INHERITED goal for an agent with no goal-mode row — the P-002 case', async () => {
    // The fleet member: launched by a goal agent, never in GOAL mode itself.
    const { sql } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }] });
    expect(await resolveGoalContext(WS, 'member-1', sql)).toBe('goal-42');
  });

  it('returns null for an agent attached to no goal at all (the common case)', async () => {
    const { sql } = mockSql();
    expect(await resolveGoalContext(WS, 'ordinary-agent', sql)).toBeNull();
  });

  it('prefers the goal it RUNS over the goal it inherited', async () => {
    // A goal agent spawned by a higher-level goal agent. Its work belongs to the
    // goal it manages, not its parent's — the opposite order would silently
    // re-parent a whole sub-portfolio's work to the grandparent.
    const { sql } = mockSql({
      modes: [goalMode('sub-manager', 'goal-child')],
      briefs: [{ owner_id: 'sub-manager', workspace_id: WS, goal_id: 'goal-parent' }],
    });
    expect(await resolveGoalContext(WS, 'sub-manager', sql)).toBe('goal-child');
  });

  it('treats a goal-mode row with no subject as no goal, falling through to inherited', async () => {
    // The measured-real state: an agent entered GOAL mode but has not filed its
    // goal yet (goal-session.ts). It must not resolve to a bogus stamp.
    const { sql } = mockSql({
      modes: [goalMode('pending', null)],
      briefs: [{ owner_id: 'pending', workspace_id: WS, goal_id: 'goal-inherited' }],
    });
    expect(await resolveGoalContext(WS, 'pending', sql)).toBe('goal-inherited');
  });

  it('refuses to resolve across a wildcard workspace', async () => {
    const { sql } = mockSql({ briefs: [{ owner_id: 'x', workspace_id: '*', goal_id: 'goal-42' }] });
    expect(await resolveGoalContext('*', 'x', sql)).toBeNull();
  });

  it('degrades to null rather than throwing when the brief read fails', async () => {
    // A node that has not yet applied migration 785. Provenance is a decoration:
    // losing it must never fail the creation it was decorating.
    const { sql } = mockSql({ failOn: /session_briefs/ });
    await expect(resolveGoalContext(WS, 'member-1', sql)).resolves.toBeNull();
  });
});

describe('setInheritedGoalContext', () => {
  it('records the goal on a session with no prior brief row', async () => {
    const { sql, briefs } = mockSql();
    expect(await setInheritedGoalContext(WS, 'member-1', 'goal-42', sql)).toBe(true);
    expect(briefs).toEqual([{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }]);
    expect(await getInheritedGoalContext(WS, 'member-1', sql)).toBe('goal-42');
  });

  it('re-parents an existing row — a relaunch under a different goal wins', async () => {
    const { sql } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-old' }] });
    await setInheritedGoalContext(WS, 'member-1', 'goal-new', sql);
    expect(await getInheritedGoalContext(WS, 'member-1', sql)).toBe('goal-new');
  });

  it('reports failure instead of throwing, so a launch is never blocked', async () => {
    const { sql } = mockSql({ failOn: /INSERT INTO harness_shared.session_briefs/ });
    await expect(setInheritedGoalContext(WS, 'member-1', 'goal-42', sql)).resolves.toBe(false);
  });

  it('refuses an empty goal id rather than writing a blank stamp', async () => {
    const { sql, briefs } = mockSql();
    expect(await setInheritedGoalContext(WS, 'member-1', '', sql)).toBe(false);
    expect(briefs).toEqual([]);
  });
});

describe('inheriting goal context does NOT confer GOAL mode', () => {
  it('leaves a descendant off the goal boards while still resolving its goal', async () => {
    // THE P-002 INVARIANT. A fleet member inherits provenance through
    // session_briefs, so its work stamps goal_id — but it has no goal-mode row,
    // so goal-session's predicates still read it as an ordinary session and it
    // keeps appearing in the sessions pane. Fusing the two would hide every
    // fleet member into a goal card, which is silent in the direction that
    // matters: nobody files a bug about a session they cannot see.
    const { sql } = mockSql({ briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }] });

    expect(await resolveGoalContext(WS, 'member-1', sql)).toBe('goal-42');

    const memberModes: Array<{ mode: string; subject?: string | null }> = [{ mode: 'auto' }];
    expect(goalIdFromModes(memberModes)).toBeNull();
    expect(isGoalSessionModes(memberModes)).toBe(false);
  });

  it('still recognises the goal AGENT itself as a goal session', async () => {
    const { sql } = mockSql({ modes: [goalMode('agent-a', 'goal-42')] });
    expect(await resolveGoalContext(WS, 'agent-a', sql)).toBe('goal-42');

    const agentModes = [{ mode: 'goal', subject: 'goal-42' }];
    expect(goalIdFromModes(agentModes)).toBe('goal-42');
    expect(isGoalSessionModes(agentModes)).toBe(true);
  });
});

describe('stampPlanGoalProvenance (migration 791 / goal-mode-design-intent-hardening P-003)', () => {
  const planRow = (goal: string | null = null): PlanRow => ({
    workspace_id: WS,
    harness_slug: 'hive-home',
    plan_slug: 'the-plan',
    goal_id: goal,
  });
  const stampArgs = (ownerId: string) => ({
    workspaceId: WS,
    harnessSlug: 'hive-home',
    planSlug: 'the-plan',
    ownerId,
  });

  it('stamps a plan created by an agent RUNNING a goal', async () => {
    const { sql, plans } = mockSql({ modes: [goalMode('agent-a', 'goal-42')], plans: [planRow()] });
    expect(await stampPlanGoalProvenance({ ...stampArgs('agent-a'), sql })).toBe('goal-42');
    expect(plans[0]!.goal_id).toBe('goal-42');
  });

  it('stamps a plan created by an agent that INHERITED its goal — a launched descendant', async () => {
    const { sql, plans } = mockSql({
      briefs: [{ owner_id: 'member-1', workspace_id: WS, goal_id: 'goal-42' }],
      plans: [planRow()],
    });
    expect(await stampPlanGoalProvenance({ ...stampArgs('member-1'), sql })).toBe('goal-42');
    expect(plans[0]!.goal_id).toBe('goal-42');
  });

  it('writes nothing for a goal-less creator — the common case stays NULL', async () => {
    const { sql, plans } = mockSql({ plans: [planRow()] });
    expect(await stampPlanGoalProvenance({ ...stampArgs('ordinary-agent'), sql })).toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });

  it('NEVER overwrites an existing stamp — first attribution wins, a later editor cannot re-parent', async () => {
    // The mock honors the statement's own `goal_id IS NULL` predicate, so this
    // fails if production drops that clause — not because the mock hardcodes it.
    const { sql, plans } = mockSql({
      modes: [goalMode('agent-b', 'goal-B')],
      plans: [planRow('goal-A')],
    });
    await stampPlanGoalProvenance({ ...stampArgs('agent-b'), sql });
    expect(plans[0]!.goal_id).toBe('goal-A');
  });

  it('no argument can name the goal: the goal id is only ever the RESOLVED context', async () => {
    // The args type carries workspace/harness/plan/owner — there is no goalId
    // input to smuggle. A creator resolving to no goal stamps nothing even when
    // a caller tries to pass one; the excess property is a TS error, and at
    // runtime the resolver (not the argument) decides.
    const { sql, plans } = mockSql({ plans: [planRow()] });
    const smuggled = { ...stampArgs('ordinary-agent'), goalId: 'goal-evil', sql } as Parameters<
      typeof stampPlanGoalProvenance
    >[0];
    expect(await stampPlanGoalProvenance(smuggled)).toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });

  it('degrades to null rather than throwing when the plans UPDATE fails', async () => {
    const { sql, plans } = mockSql({
      modes: [goalMode('agent-a', 'goal-42')],
      plans: [planRow()],
      failOn: /UPDATE harness_shared.harness_plans/,
    });
    await expect(stampPlanGoalProvenance({ ...stampArgs('agent-a'), sql })).resolves.toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });

  it('refuses a wildcard workspace and missing identifiers', async () => {
    const { sql, plans } = mockSql({ modes: [goalMode('agent-a', 'goal-42')], plans: [planRow()] });
    expect(
      await stampPlanGoalProvenance({ ...stampArgs('agent-a'), workspaceId: '*', sql }),
    ).toBeNull();
    expect(
      await stampPlanGoalProvenance({ ...stampArgs('agent-a'), ownerId: undefined as unknown as string, sql }),
    ).toBeNull();
    expect(plans[0]!.goal_id).toBeNull();
  });
});
