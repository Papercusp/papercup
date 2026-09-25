import { describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { GoalHolderLike } from './goal-liveness-watchdog';
import {
  GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
  GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
  GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT,
  claimSpecFilterConstrainsGoal,
  claimSpecIsGoalScoped,
  classifyDelegatedDrainFleetLiveness,
  classifyDrainWorkerLiveness,
  decideGoalDrainFleetRelaunch,
  goalDrainRelaunchEligibility,
  goalPinnedRemedySpec,
  makeResolveFleetLiveness,
  resolveGoalPinWritability,
  type GoalPinWritabilityProbe,
  parseGoalDrainRespawnLedger,
  claimSpecIsPlanScoped,
  classifyGoalDrainFleet,
  classifyGoalPlanFleetCoverage,
  fleetKey,
  readGoalPlanFleetObservation,
  runGoalDrainFleetSweepOnce,
  scanGoalDrainFleets,
  type DrainFleetLiveness,
  type DrainFleetSpecScope,
  type GoalDrainAlert,
  type GoalDrainFleetSweepDeps,
  type GoalDrainRelaunchResult,
  type GoalDrainRowLike,
  type GoalPlanFleetCohort,
} from './goal-drain-fleet-watchdog';
import { DEFAULT_CLAIM_SPEC, type ClaimSpec, type FilterNode } from '../scheduler/claim-spec';
import { evaluateCollapseGuard } from '../scheduler/spec-pool-preview';

const NOW = 1_800_000_000_000;
const PAST_GRACE = NOW - GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS - 60_000;

function makeGoal(over: Partial<GoalDrainRowLike> = {}): GoalDrainRowLike {
  return {
    goalId: 'g-1',
    workspaceId: 'ws',
    title: 'ship the thing',
    createdAtMs: PAST_GRACE,
    drainFleet: null,
    ...over,
  };
}

function makeHolder(over: Partial<GoalHolderLike> = {}): GoalHolderLike {
  return { goalId: 'g-1', workspaceId: 'ws', ownerId: 'su-a', setAtMs: PAST_GRACE, ...over };
}

function makeVerdict(
  ownerId: string,
  sessionState: LivenessVerdict['sessionState'],
  selfWake?: LivenessVerdict['selfWake'],
): LivenessVerdict {
  return {
    ownerId,
    sessionState,
    wakeable: sessionState !== 'ended',
    liveTurn: sessionState === 'live',
    confirmLiveness: null,
    heartbeatFresh: sessionState !== 'ended',
    ...(selfWake === undefined ? {} : { selfWake }),
  };
}

const verdicts = (...vs: LivenessVerdict[]) => new Map(vs.map((v) => [v.ownerId, v]));
const fleets = (entries: Record<string, DrainFleetLiveness>) => new Map(Object.entries(entries));
const scopes = (entries: Record<string, DrainFleetSpecScope> = {}) => new Map(Object.entries(entries));

describe('P-014 drain worker liveness', () => {
  it('does not let a healthy leader conceal a fleet with zero live workers', () => {
    expect(classifyDrainWorkerLiveness('su-leader', ['su-leader'], verdicts(
      makeVerdict('su-leader', 'live'),
    ))).toBe('dead');
    expect(classifyDrainWorkerLiveness('su-leader', ['su-leader', 'su-dead-worker'], verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-dead-worker', 'ended'),
    ))).toBe('dead');
  });

  it('keeps verified worker coverage even with an unresolved peer, and suppresses when no worker is verified', () => {
    const members = ['su-leader', 'su-unresolved', 'su-worker'];
    expect(classifyDrainWorkerLiveness('su-leader', members, verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'live'),
    ))).toBe('alive');
    expect(classifyDrainWorkerLiveness('su-leader', members, verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'ended'),
    ))).toBe('unknown');
  });

  it('requires a distinct live delegated leader and holder coupling', () => {
    const members = ['su-holder', 'su-leader', 'su-worker'];
    const live = verdicts(makeVerdict('su-holder', 'live'), makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'live'));
    expect(classifyDelegatedDrainFleetLiveness('su-holder', null, false, members, live)).toBe('dead');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-holder', true, members, live)).toBe('dead');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', false, members, live)).toBe('dead');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', true, members, live)).toBe('alive');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', true, members,
      verdicts(makeVerdict('su-worker', 'live')))).toBe('unknown');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', true, members,
      verdicts(makeVerdict('su-leader', 'ended'), makeVerdict('su-worker', 'live')))).toBe('dead');
  });

  it('uses the current holder for coupling, even when the fleet owner column is stale', async () => {
    const read = vi.fn(async (parts: TemplateStringsArray) => {
      const statement = parts.join(' ');
      if (statement.includes('FROM harness_shared.agent_fleets')) return [{
        workspace_id: 'ws', fleet_slug: 'drain-1', owner: 'su-old-holder', leader_owner_id: 'su-leader',
      }];
      if (statement.includes('FROM harness_shared.coord_presence')) return [
        { workspace_id: 'ws', fleet_slug: 'drain-1', owner_id: 'su-leader' },
        { workspace_id: 'ws', fleet_slug: 'drain-1', owner_id: 'su-worker' },
      ];
      if (statement.includes('FROM harness_shared.agent_couplings')) return [{
        workspace_id: 'ws', agent_a: 'su-current-holder', agent_b: 'su-leader',
      }];
      throw new Error(`unexpected query: ${statement}`);
    });
    const resolve = makeResolveFleetLiveness(read as unknown as Sql, async () => verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'live'),
    ));
    const drain = await resolve([{ workspaceId: 'ws', fleetSlug: 'drain-1', holderOwnerId: 'su-current-holder' }]);
    expect(drain.get(fleetKey('ws', 'drain-1'))).toBe('alive');
    // Plan fleets use this resolver too; they do not require a GOAL coupling.
    const plan = await resolve([{ workspaceId: 'ws', fleetSlug: 'drain-1' }]);
    expect(plan.get(fleetKey('ws', 'drain-1'))).toBe('alive');
  });
});

describe('classifyGoalDrainFleet', () => {
  it('alerts no-drain-fleet-declared on a live-held goal past the kickoff grace', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toMatchObject({
      reason: 'no-drain-fleet-declared',
      goalId: 'g-1',
      liveHolders: ['su-a'],
    });
  });

  it('stays silent inside the kickoff grace window', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ createdAtMs: NOW - 60_000 }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent on an UNHELD goal — the liveness sibling owns that alarm', () => {
    const alert = classifyGoalDrainFleet(makeGoal(), [], verdicts(), fleets({}), scopes(), NOW);
    expect(alert).toBeNull();
  });

  it('stays silent when every holder is dead — abandoned is the sibling territory', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder({ ownerId: 'su-dead' })],
      verdicts(makeVerdict('su-dead', 'ended')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('a holder with NO oracle verdict is UNKNOWN, never promoted to held-alive', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder({ ownerId: 'su-mystery' })],
      verdicts(), // oracle degraded — no entry
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('parked holder with selfWake none does not count as alive', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder({ ownerId: 'su-costume' })],
      verdicts(makeVerdict('su-costume', 'parked', 'none')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('declared + fleet alive + goal-scoped lane is healthy', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'goal-scoped' }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('declared + fleet dead alerts drain-fleet-dead', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'dead' }),
      scopes(),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-dead', drainFleet: 'drain-1' });
  });

  it('declared + no fleets-table row alerts drain-fleet-not-found', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'gone' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'gone')]: 'not-found' }),
      scopes(),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-not-found' });
  });

  it('unknown fleet liveness suppresses — a degraded read is not a dead fleet', () => {
    for (const missing of [fleets({ [fleetKey('ws', 'drain-1')]: 'unknown' as const }), fleets({})]) {
      const alert = classifyGoalDrainFleet(
        makeGoal({ drainFleet: 'drain-1' }),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        missing,
        scopes(),
        NOW,
      );
      expect(alert).toBeNull();
    }
  });

  // ── D-005: held correctly also means SCOPED correctly ────────────────────
  it('an ALIVE fleet with a pot-wide lane alerts drain-fleet-not-goal-scoped', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'not-goal-scoped' }),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-not-goal-scoped', drainFleet: 'drain-1' });
  });

  it('an ALIVE fleet whose spec could not be read suppresses — unknown never alarms', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'unknown' }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('a DEAD fleet wins over a bad scope — one classifier verdict per goal', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'dead' }),
      scopes({ 'g-1': 'not-goal-scoped' }),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-dead' });
  });

  it('an ALIVE fleet whose goal cohort is STARVED suppresses — the remedy would be refused', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'goal-cohort-starved' }),
      NOW,
    );
    expect(alert).toBeNull();
  });
});

/**
 * EI-23748092951882673 — the D-005 obligation and the scheduler's starvation
 * guard must never be armed against each other.
 *
 * The measured conflict: the watchdog demanded a `goal`-pinned lane; writing one
 * collapsed the claimable match 4430 -> 13 of 4444; `evaluateCollapseGuard`
 * correctly refused it; and the only documented way past the refusal was
 * `confirmCollapse:true`, which would actually starve the fleet. An agent that
 * OBEYED the alarm was steered into the damaging action.
 *
 * These tests pin the invariant that resolves it: THE WATCHDOG MUST NOT DEMAND A
 * WRITE THE SCHEDULER WOULD REFUSE. They compose the real remedy builder with
 * the real guard — no mock of either — so the two cannot drift apart silently.
 */
describe('goalPinnedRemedySpec — obligation and scheduler guard share one oracle', () => {
  const kindOnly: ClaimSpec = {
    ...DEFAULT_CLAIM_SPEC,
    view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } as FilterNode },
  };

  it('builds a spec the D-005 predicate itself accepts — the remedy satisfies the alarm', () => {
    expect(claimSpecIsGoalScoped(goalPinnedRemedySpec(DEFAULT_CLAIM_SPEC, 'g-1'), 'g-1')).toBe(true);
    expect(claimSpecIsGoalScoped(goalPinnedRemedySpec(kindOnly, 'g-1'), 'g-1')).toBe(true);
  });

  it('preserves the incumbent narrowing instead of discarding the lane', () => {
    expect(JSON.stringify(goalPinnedRemedySpec(kindOnly, 'g-1').view.filter)).toContain('"kind"');
  });

  it('pins POSITIVELY and specifically — it does not satisfy a different goal', () => {
    expect(claimSpecIsGoalScoped(goalPinnedRemedySpec(kindOnly, 'g-1'), 'g-2')).toBe(false);
  });

  it('the scheduler REFUSES the remedy at the measured incident numbers (4430 -> 13 of 4444)', () => {
    const remedy = goalPinnedRemedySpec(kindOnly, 'g-1');
    const verdict = evaluateCollapseGuard({
      matched: 13,
      pool: 4444,
      previousMatched: 4430,
      previousSource: 'authored',
      confirm: false,
      filter: remedy.view.filter,
      previousFilter: kindOnly.view.filter,
    });
    expect(verdict.refuse).toBe(true);
    // ...so the watchdog MUST read that pair as 'goal-cohort-starved', and
    // classifying it must yield NO alert. An alert here is precisely the bug:
    // it steers the reader toward confirmCollapse:true, which starves the fleet.
    expect(
      classifyGoalDrainFleet(
        makeGoal({ drainFleet: 'drain-1' }),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
        scopes({ 'g-1': 'goal-cohort-starved' }),
        NOW,
      ),
    ).toBeNull();
  });

  // POSITIVE CONTROL: the fix must NOT silence D-005 wholesale. A goal whose
  // cohort is genuinely populated still gets its obligation, because there the
  // pinned write lands. Without this, "suppress everything" would also pass.
  it('a POPULATED goal cohort is still an obligation — the guard accepts, so the alarm fires', () => {
    const remedy = goalPinnedRemedySpec(kindOnly, 'g-1');
    const verdict = evaluateCollapseGuard({
      matched: 900, // well above max(ABS_FLOOR, ceil(4430 * RATIO)) = 222
      pool: 4444,
      previousMatched: 4430,
      previousSource: 'authored',
      confirm: false,
      filter: remedy.view.filter,
      previousFilter: kindOnly.view.filter,
    });
    expect(verdict.refuse).toBe(false);
    expect(
      classifyGoalDrainFleet(
        makeGoal({ drainFleet: 'drain-1' }),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
        scopes({ 'g-1': 'not-goal-scoped' }),
        NOW,
      ),
    ).toMatchObject({ reason: 'drain-fleet-not-goal-scoped' });
  });
});

/**
 * The probe that decides whether to alarm. These use the REAL
 * `evaluateCollapseGuard` with faked COUNTS, so the thresholds under test are the
 * scheduler's own — a change to RATIO/ABS_FLOOR moves these tests, which is the
 * point: the watchdog's demand is defined by the guard, not by a second copy of it.
 */
describe('resolveGoalPinWritability — only alarm when the remedy is a legal write', () => {
  const kindOnly: ClaimSpec = {
    ...DEFAULT_CLAIM_SPEC,
    view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } as FilterNode },
  };
  type GuardInput = Parameters<GoalPinWritabilityProbe['guard']>[0];

  /** `counts` is the preview queue in call order: [candidate(remedy), previous(incumbent)]. */
  function probe(counts: Array<{ matched: number; pool: number }>, spy?: { calls: GuardInput[] }): GoalPinWritabilityProbe {
    const queue = [...counts];
    return {
      preview: async () => queue.shift() ?? { matched: 0, pool: 0 },
      guard: (input) => {
        spy?.calls.push(input);
        return evaluateCollapseGuard(input);
      },
    };
  }

  it('STARVED: an authored pot-wide lane whose pin collapses the pool does NOT alarm', async () => {
    await expect(
      resolveGoalPinWritability(kindOnly, 'g-1', 'ws', probe([
        { matched: 13, pool: 4444 },
        { matched: 4430, pool: 4444 },
      ])),
    ).resolves.toBe('goal-cohort-starved');
  });

  it('OBLIGATION: an authored lane whose pin keeps a real cohort still alarms', async () => {
    await expect(
      resolveGoalPinWritability(kindOnly, 'g-1', 'ws', probe([
        { matched: 900, pool: 4444 },
        { matched: 4430, pool: 4444 },
      ])),
    ).resolves.toBe('not-goal-scoped');
  });

  it('NO stored spec: measures against DEFAULT and reports previousSource "default"', async () => {
    const spy = { calls: [] as GuardInput[] };
    await expect(
      resolveGoalPinWritability(null, 'g-1', 'ws', probe([{ matched: 40, pool: 4444 }], spy)),
    ).resolves.toBe('not-goal-scoped');
    expect(spy.calls[0]).toMatchObject({ previousSource: 'default', previousMatched: null });
  });

  it('an EMPTY goal cohort with no stored spec is starved, not an obligation', async () => {
    await expect(
      resolveGoalPinWritability(null, 'g-1', 'ws', probe([{ matched: 0, pool: 4444 }])),
    ).resolves.toBe('goal-cohort-starved');
  });

  // ANTI-FOOTGUN. confirmCollapse:true is the override whose USE is the documented
  // harm in EI-23748092951882673. The watchdog asks "would this be REFUSED?", and
  // must never ask "could it be FORCED?" — a true here re-arms the original trap.
  it('NEVER asks the guard to ignore the collapse — confirm is always false', async () => {
    const spy = { calls: [] as GuardInput[] };
    await resolveGoalPinWritability(kindOnly, 'g-1', 'ws', probe([
      { matched: 13, pool: 4444 },
      { matched: 4430, pool: 4444 },
    ], spy));
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].confirm).toBe(false);
  });

  it('a DEGRADED probe is unknown and suppresses — never a false obligation', async () => {
    await expect(
      resolveGoalPinWritability(kindOnly, 'g-1', 'ws', {
        preview: async () => {
          throw new Error('pg down');
        },
        guard: () => {
          throw new Error('unreachable');
        },
      }),
    ).resolves.toBe('unknown');
  });

  it('measures the PINNED remedy against the INCUMBENT — not the same spec twice', async () => {
    const seen: ClaimSpec[] = [];
    await resolveGoalPinWritability(kindOnly, 'g-1', 'ws', {
      preview: async (spec) => {
        seen.push(spec);
        return { matched: 900, pool: 4444 };
      },
      guard: (i) => evaluateCollapseGuard(i),
    });
    expect(seen).toHaveLength(2);
    expect(claimSpecIsGoalScoped(seen[0], 'g-1')).toBe(true); // candidate IS the pinned remedy
    expect(claimSpecIsGoalScoped(seen[1], 'g-1')).toBe(false); // previous is the incumbent lane
  });
});

describe('readGoalPlanFleetObservation', () => {
  it('reuses the watchdog cohort and liveness classifier without side effects', async () => {
    const result = await readGoalPlanFleetObservation(
      {} as Sql,
      { workspaceId: 'ws', goalId: 'g-1' },
      {
        readGoals: async () => ({ goals: [makeGoal()], holders: [makeHolder()] }),
        resolveLiveness: async () => verdicts(makeVerdict('su-a', 'live')),
        resolveFleetLiveness: async () => fleets({}),
        readCohort: async () => ({
          status: 'known',
          plans: [
            {
              goalId: 'g-1',
              workspaceId: 'ws',
              harnessSlug: 'papercusp',
              planSlug: 'plan-a',
              itemIds: ['P-001'],
              targetingFleets: [],
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      status: 'known',
      applicablePlanCount: 1,
      alert: { reason: 'started-plan-no-live-targeting-fleet', planSlug: 'plan-a' },
    });
  });

  it('keeps an unreadable cohort unknown instead of manufacturing no demand', async () => {
    const result = await readGoalPlanFleetObservation(
      {} as Sql,
      { workspaceId: 'ws', goalId: 'g-1' },
      {
        readGoals: async () => ({ goals: [makeGoal()], holders: [makeHolder()] }),
        resolveLiveness: async () => verdicts(makeVerdict('su-a', 'live')),
        resolveFleetLiveness: async () => fleets({}),
        readCohort: async () => ({ status: 'unknown', plans: [] }),
      },
    );
    expect(result).toEqual({ status: 'unknown', alert: null, applicablePlanCount: null });
  });
});

describe('claimSpecFilterConstrainsGoal — the D-005 scope predicate', () => {
  const leaf = { field: 'goal', op: '=', value: 'g-1' };

  it('accepts the positive = leaf and the in form containing the goal', () => {
    expect(claimSpecFilterConstrainsGoal(leaf, 'g-1')).toBe(true);
    expect(claimSpecFilterConstrainsGoal({ field: 'goal', op: 'in', value: ['g-0', 'g-1'] }, 'g-1')).toBe(true);
  });

  it('rejects a leaf for a DIFFERENT goal', () => {
    expect(claimSpecFilterConstrainsGoal(leaf, 'g-2')).toBe(false);
    expect(claimSpecFilterConstrainsGoal({ field: 'goal', op: 'in', value: ['g-0'] }, 'g-1')).toBe(false);
  });

  it('accepts the leaf nested under all (AND narrows)', () => {
    const filter = { all: [{ field: 'kind', op: 'in', value: ['bug'] }, leaf] };
    expect(claimSpecFilterConstrainsGoal(filter, 'g-1')).toBe(true);
  });

  it('an any is scoped only when EVERY branch is (OR widens)', () => {
    expect(claimSpecFilterConstrainsGoal({ any: [leaf, leaf] }, 'g-1')).toBe(true);
    expect(claimSpecFilterConstrainsGoal({ any: [leaf, { field: 'kind', op: '=', value: 'bug' }] }, 'g-1')).toBe(false);
  });

  it('the WI-37711 trap: a negated or != goal leaf NEVER counts as scoping', () => {
    // `goal` is NULLABLE — the negative form silently excludes every unstamped
    // row in the SQL compiler, which is why only the positive form scopes.
    expect(claimSpecFilterConstrainsGoal({ not: leaf }, 'g-1')).toBe(false);
    expect(claimSpecFilterConstrainsGoal({ field: 'goal', op: '!=', value: 'g-2' }, 'g-1')).toBe(false);
  });

  it('an empty / absent filter (the pot-wide default) never counts', () => {
    expect(claimSpecFilterConstrainsGoal(undefined, 'g-1')).toBe(false);
    expect(claimSpecFilterConstrainsGoal({}, 'g-1')).toBe(false);
  });
});

describe('GOAL plan-fleet obligation classifier', () => {
  const plan = (
    planSlug: string,
    targetingFleets: Array<{
      fleetSlug: string;
      liveness: DrainFleetLiveness;
      liveClaimItemIds: string[];
    }> = [],
    itemIds = ['P-001'],
  ) => ({
    goalId: 'g-1',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    planSlug,
    itemIds,
    targetingFleets,
  });
  const cohort = (...plans: ReturnType<typeof plan>[]): GoalPlanFleetCohort => ({
    status: 'known',
    plans,
  });

  it('accepts the positive plan =/in claim-spec forms and rejects widening/negative forms', () => {
    expect(claimSpecIsPlanScoped({ view: { filter: { field: 'plan', op: '=', value: 'p-1' } } }, 'p-1')).toBe(true);
    expect(claimSpecIsPlanScoped({ view: { filter: { field: 'plan', op: 'in', value: ['p-0', 'p-1'] } } }, 'p-1')).toBe(
      true,
    );
    expect(claimSpecIsPlanScoped({ view: { filter: { not: { field: 'plan', op: '=', value: 'p-2' } } } }, 'p-1')).toBe(
      false,
    );
    expect(
      claimSpecIsPlanScoped(
        {
          view: {
            filter: {
              any: [
                { field: 'plan', op: '=', value: 'p-1' },
                { field: 'kind', op: '=', value: 'bug' },
              ],
            },
          },
        },
        'p-1',
      ),
    ).toBe(false);
  });

  it('healthy: a live targeting fleet with a live claim on a non-terminal item is silent', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-healthy', [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: ['P-001'] }])),
    );
    expect(result).toBeNull();
  });

  it('Leg A: a non-empty started plan with no live targeting fleet alarms', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-no-fleet')),
    );
    expect(result).toMatchObject({
      reason: 'started-plan-no-live-targeting-fleet',
      planSlug: 'p-no-fleet',
      itemIds: ['P-001'],
    });
  });

  it('Leg B: a live targeting fleet with zero live claims on the plan alarms', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-unclaimed', [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: [] }])),
    );
    expect(result).toMatchObject({
      reason: 'started-plan-targeting-fleet-zero-live-claims',
      planSlug: 'p-unclaimed',
    });
  });

  it('unknown cohort or targeting-fleet liveness suppresses rather than alarming', () => {
    const args = [makeGoal(), [makeHolder()], verdicts(makeVerdict('su-a', 'live'))] as const;
    expect(classifyGoalPlanFleetCoverage(...args, { status: 'unknown', plans: [] })).toBeNull();
    expect(
      classifyGoalPlanFleetCoverage(
        ...args,
        cohort(plan('p-unknown', [{ fleetSlug: 'fleet-a', liveness: 'unknown', liveClaimItemIds: [] }])),
      ),
    ).toBeNull();
  });

  it('an empty/completed started plan and a goal without a positively-live holder stay silent', () => {
    expect(
      classifyGoalPlanFleetCoverage(
        makeGoal(),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        cohort(plan('p-empty', [], [])),
      ),
    ).toBeNull();
    expect(
      classifyGoalPlanFleetCoverage(makeGoal(), [makeHolder()], verdicts(), cohort(plan('p-no-fleet'))),
    ).toBeNull();
  });

  it('exactly one classifier speaks per goal, deterministically preferring Leg A', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-b', [{ fleetSlug: 'fleet-b', liveness: 'alive', liveClaimItemIds: [] }]), plan('p-a')),
    );
    expect(result).toMatchObject({ reason: 'started-plan-no-live-targeting-fleet', planSlug: 'p-a' });
  });
});

describe('scanGoalDrainFleets', () => {
  it('classifies each goal independently', () => {
    const goals = [makeGoal({ goalId: 'g-bad' }), makeGoal({ goalId: 'g-ok', drainFleet: 'drain-ok' })];
    const holders = [makeHolder({ goalId: 'g-bad' }), makeHolder({ goalId: 'g-ok' })];
    const out = scanGoalDrainFleets(
      goals,
      holders,
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-ok')]: 'alive' }),
      scopes({ 'g-ok': 'goal-scoped' }),
      NOW,
    );
    expect(out.map((a) => a.goalId)).toEqual(['g-bad']);
  });
});

describe('runGoalDrainFleetSweepOnce', () => {
  const sql = null as unknown as Sql; // every dep is injected; sql must never be touched

  const baseDeps = () => ({
    readGoals: vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1' })],
      holders: [makeHolder()],
    })),
    resolveLiveness: vi.fn(async () => verdicts(makeVerdict('su-a', 'live'))),
    resolveFleetLiveness: vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const })),
    resolveFleetSpecScopes: vi.fn(async () => scopes()),
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
    ...relaunchDeps(),
  });

  it('skips entirely when the flag is off', async () => {
    const deps = { ...baseDeps(), flagEnabled: vi.fn(async () => false) };
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 0, escalated: 0, skipped: true, relaunched: 0, relaunchCapped: 0 });
    expect(deps.readGoals).not.toHaveBeenCalled();
  });

  it('escalates AND emits for a dead declared fleet', async () => {
    const deps = baseDeps();
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0 });
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-dead' }));
  });

  it('resolves liveness only for holders of active goals, and fleet liveness only for declared fleets', async () => {
    const deps = baseDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1' }), makeGoal({ goalId: 'g-2', drainFleet: null })],
      holders: [makeHolder(), makeHolder({ goalId: 'g-closed', ownerId: 'su-irrelevant' })],
    }));
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.resolveLiveness).toHaveBeenCalledWith(['su-a']);
    expect(deps.resolveFleetLiveness).toHaveBeenCalledWith([{
      workspaceId: 'ws', fleetSlug: 'drain-1', holderOwnerId: 'su-a',
    }]);
  });

  it('a failed escalate is contained and the emit still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = baseDeps();
      deps.escalate = vi.fn(async () => {
        throw new Error('escalation surface down');
      });
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res).toEqual({ scanned: 1, escalated: 0, skipped: false, relaunched: 0, relaunchCapped: 0 });
      expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('escalate failed for g-1'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed emit is contained and still counts the escalation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = baseDeps();
      deps.emitDrainDead = vi.fn(async () => {
        throw new Error('event engine down');
      });
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('event emit failed for g-1'));
    } finally {
      warn.mockRestore();
    }
  });

  it('control: a deliberately-wrong classifier premise would be caught here', async () => {
    // Calibration for the suppress rules — a healthy fleet must produce ZERO
    // escalations; if classifyGoalDrainFleet ever fired on alive fleets this
    // canary fails, proving the suite can catch that class of defect.
    const deps = baseDeps();
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const }));
    deps.resolveFleetSpecScopes = vi.fn(async () => scopes({ 'g-1': 'goal-scoped' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 0, skipped: false, relaunched: 0, relaunchCapped: 0 });
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.emitDrainDead).not.toHaveBeenCalled();
    // D-005: scope was actually consulted for the alive pair — an implementation
    // that skips the check entirely would also produce zero escalations here.
    expect(deps.resolveFleetSpecScopes).toHaveBeenCalledWith([
      { workspaceId: 'ws', fleetSlug: 'drain-1', goalId: 'g-1' },
    ]);
  });

  // ── D-005 ────────────────────────────────────────────────────────────────
  it('escalates drain-fleet-not-goal-scoped for an ALIVE fleet on a pot-wide lane', async () => {
    const deps = baseDeps();
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const }));
    deps.resolveFleetSpecScopes = vi.fn(async () => scopes({ 'g-1': 'not-goal-scoped' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0 });
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-not-goal-scoped' }));
  });

  it('spec scopes are resolved ONLY for alive fleets — dead ones already have their verdict', async () => {
    const deps = baseDeps(); // baseDeps liveness: dead
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.resolveFleetSpecScopes).toHaveBeenCalledWith([]);
  });
});

// ── WI-2140699: the relaunch leg ──────────────────────────────────────────────

/** Inert relaunch-leg deps: every ledger write records, nothing launches unless a test says so. */
function relaunchDeps(): Pick<
  GoalDrainFleetSweepDeps,
  | 'relaunchFlagEnabled'
  | 'markDrainDead'
  | 'reserveRelaunchSlot'
  | 'clearDrainLedger'
  | 'relaunchDrainFleet'
  | 'notifyRelaunch'
  | 'escalateRelaunchExhausted'
  | 'deadGraceMs'
> {
  return {
    relaunchFlagEnabled: vi.fn(async () => true),
    // Default: the episode began a full grace ago, so the timing leg says relaunch.
    markDrainDead: vi.fn(async () => NOW - GOAL_DRAIN_FLEET_DEAD_GRACE_MS),
    reserveRelaunchSlot: vi.fn(async () => ({ kind: 'reserved' as const, attemptsInWindow: 1 })),
    clearDrainLedger: vi.fn(async () => {}),
    relaunchDrainFleet: vi.fn(
      async (): Promise<GoalDrainRelaunchResult> => ({ fleetSlug: 'drain-1', ownerId: 'su-drain-1', warnings: [] }),
    ),
    notifyRelaunch: vi.fn(async () => {}),
    escalateRelaunchExhausted: vi.fn(async () => {}),
    deadGraceMs: GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
  };
}

describe('goalDrainRelaunchEligibility (pure gate)', () => {
  const dead = { reason: 'drain-fleet-dead' as const };
  it('a dead or missing declared fleet on a standing goal is eligible', () => {
    expect(goalDrainRelaunchEligibility(dead, { standing: true, drainRespawn: null })).toEqual({ eligible: true });
    expect(
      goalDrainRelaunchEligibility({ reason: 'drain-fleet-not-found' }, { standing: true, drainRespawn: null }),
    ).toEqual({ eligible: true });
  });
  it('an outcome (non-standing) goal keeps the report-only posture', () => {
    expect(goalDrainRelaunchEligibility(dead, { standing: false, drainRespawn: null })).toEqual({
      eligible: false,
      why: 'not-standing',
    });
    expect(goalDrainRelaunchEligibility(dead, { drainRespawn: null })).toMatchObject({ why: 'not-standing' });
  });
  it('undeclared / mis-scoped reasons are holder decisions, never relaunches', () => {
    for (const reason of ['no-drain-fleet-declared', 'drain-fleet-not-goal-scoped'] as const) {
      expect(goalDrainRelaunchEligibility({ reason }, { standing: true, drainRespawn: null })).toEqual({
        eligible: false,
        why: 'reason-not-relaunchable',
      });
    }
  });
  it('a spent budget (needsHuman) holds until a human clears it', () => {
    expect(
      goalDrainRelaunchEligibility(dead, { standing: true, drainRespawn: { deadSinceMs: 1, needsHuman: true } }),
    ).toEqual({ eligible: false, why: 'needs-human' });
  });
});

describe('decideGoalDrainFleetRelaunch (pure timing)', () => {
  it('waits inside the dead grace, relaunches at/after it', () => {
    expect(decideGoalDrainFleetRelaunch(NOW - 1, NOW)).toMatchObject({
      kind: 'wait',
      remainingMs: GOAL_DRAIN_FLEET_DEAD_GRACE_MS - 1,
    });
    expect(decideGoalDrainFleetRelaunch(NOW - GOAL_DRAIN_FLEET_DEAD_GRACE_MS, NOW)).toMatchObject({
      kind: 'relaunch',
      deadForMs: GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
    });
    expect(decideGoalDrainFleetRelaunch(NOW - 3 * GOAL_DRAIN_FLEET_DEAD_GRACE_MS, NOW, 60_000)).toMatchObject({
      kind: 'relaunch',
    });
  });
  it('a future or non-finite stamp reads as "just now" — one more sweep of patience, never a relaunch off a bad clock', () => {
    expect(decideGoalDrainFleetRelaunch(NOW + 5_000, NOW)).toMatchObject({ kind: 'wait', deadSinceMs: NOW });
    expect(decideGoalDrainFleetRelaunch(Number.NaN, NOW)).toMatchObject({ kind: 'wait', deadSinceMs: NOW });
  });
});

describe('parseGoalDrainRespawnLedger', () => {
  it('reads a well-formed ledger, tolerates numeric strings, and treats junk as no episode', () => {
    expect(parseGoalDrainRespawnLedger({ deadSinceMs: 5, needsHuman: true })).toEqual({
      deadSinceMs: 5,
      needsHuman: true,
    });
    expect(parseGoalDrainRespawnLedger({ deadSinceMs: '7' })).toEqual({ deadSinceMs: 7, needsHuman: false });
    expect(parseGoalDrainRespawnLedger({ attempts: [1, 2] })).toEqual({ deadSinceMs: null, needsHuman: false });
    expect(parseGoalDrainRespawnLedger(null)).toBeNull();
    expect(parseGoalDrainRespawnLedger('x')).toBeNull();
    expect(parseGoalDrainRespawnLedger([1])).toBeNull();
  });
});

describe('runGoalDrainFleetSweepOnce — relaunch leg (WI-2140699)', () => {
  const sql = null as unknown as Sql;
  const standingGoal = () =>
    makeGoal({ drainFleet: 'drain-1', standing: true, installSlug: 'papercusp', drainRespawn: null });

  const deadStandingDeps = () => ({
    readGoals: vi.fn(async () => ({ goals: [standingGoal()], holders: [makeHolder()] })),
    resolveLiveness: vi.fn(async () => verdicts(makeVerdict('su-a', 'live'))),
    resolveFleetLiveness: vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const })),
    resolveFleetSpecScopes: vi.fn(async () => scopes()),
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
    ...relaunchDeps(),
  });

  it('GUARD: a standing goal whose declared fleet stayed dead past the grace gets exactly ONE relaunch, the ledger is charged first, and the holder is told', async () => {
    const deps = deadStandingDeps();
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 1, relaunchCapped: 0 });
    // the report-only rail still fires for the parked holder…
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-dead', standing: true }));
    expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
    // …and the relaunch leg ran in ledger order: mark → reserve → launch → notify
    expect(deps.markDrainDead).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'g-1' }), NOW);
    expect(deps.reserveRelaunchSlot).toHaveBeenCalledTimes(1);
    expect(deps.relaunchDrainFleet).toHaveBeenCalledTimes(1);
    const [alert, goal] = (deps.relaunchDrainFleet as ReturnType<typeof vi.fn>).mock.calls[0] as [
      GoalDrainAlert,
      GoalDrainRowLike,
    ];
    expect(alert.liveHolders).toEqual(['su-a']);
    expect(goal.installSlug).toBe('papercusp');
    expect(deps.notifyRelaunch).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: 'g-1' }),
      expect.objectContaining({ goalId: 'g-1' }),
      expect.objectContaining({ fleetSlug: 'drain-1', ownerId: 'su-drain-1' }),
    );
    expect(deps.escalateRelaunchExhausted).not.toHaveBeenCalled();
    expect(deps.clearDrainLedger).not.toHaveBeenCalled();
    // reservation happens BEFORE the launch — a crash mid-launch still costs the budget
    const order = (name: keyof typeof deps) => (deps[name] as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(order('markDrainDead')).toBeLessThan(order('reserveRelaunchSlot'));
    expect(order('reserveRelaunchSlot')).toBeLessThan(order('relaunchDrainFleet'));
  });

  it('a missing (not-found) declared fleet on a standing goal relaunches the same way', async () => {
    const deps = deadStandingDeps();
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'not-found' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 1, relaunchCapped: 0 });
    expect(deps.relaunchDrainFleet).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'drain-fleet-not-found' }),
      expect.anything(),
    );
  });

  it('inside the dead grace it only stamps the clock — no reservation, no launch', async () => {
    const deps = deadStandingDeps();
    deps.markDrainDead = vi.fn(async () => NOW); // first sighting this sweep
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0 });
    expect(deps.markDrainDead).toHaveBeenCalledTimes(1);
    expect(deps.reserveRelaunchSlot).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
  });

  it('GUARD: a spent budget launches nothing and escalates the give-up exactly once per sweep', async () => {
    const deps = deadStandingDeps();
    deps.reserveRelaunchSlot = vi.fn(async () => ({
      kind: 'capped' as const,
      attemptsInWindow: GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT,
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 0, relaunchCapped: 1 });
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
    expect(deps.escalateRelaunchExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: 'g-1' }),
      GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT,
    );
  });

  it('once the ledger says needsHuman the leg is skipped before any write', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1', standing: true, drainRespawn: { deadSinceMs: 1, needsHuman: true } })],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0 });
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.relaunchFlagEnabled).not.toHaveBeenCalled();
  });

  it('an OUTCOME goal (standing:false) keeps the pre-WI-2140699 posture: report + emit, never launch, no ledger writes', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1', standing: false })],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0 });
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ standing: false }));
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.relaunchFlagEnabled).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
  });

  it('the relaunch flag is the kill-switch: OFF keeps reporting and writes nothing', async () => {
    const deps = deadStandingDeps();
    deps.relaunchFlagEnabled = vi.fn(async () => false);
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0 });
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
  });

  it('the flag is read at most once per sweep, and only when some alert is eligible', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [
        standingGoal(),
        makeGoal({ goalId: 'g-2', drainFleet: 'drain-2', standing: true, installSlug: 'papercusp' }),
      ],
      holders: [makeHolder(), makeHolder({ goalId: 'g-2' })],
    }));
    deps.resolveFleetLiveness = vi.fn(async () =>
      fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const, [fleetKey('ws', 'drain-2')]: 'dead' as const }),
    );
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 2 });
    expect(deps.relaunchFlagEnabled).toHaveBeenCalledTimes(1);
  });

  it('a launch that throws is contained: the sweep continues, nothing else is charged, and the failure is logged with the budget note', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = deadStandingDeps();
      deps.relaunchDrainFleet = vi.fn(async () => {
        throw new Error('launch-su down');
      });
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0 });
      expect(deps.notifyRelaunch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('relaunch failed for g-1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('budget charged'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a fleet that reads ALIVE again ends the episode: the ledger (dead clock + needsHuman) is cleared', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [
        makeGoal({ drainFleet: 'drain-1', standing: true, drainRespawn: { deadSinceMs: NOW - 1, needsHuman: true } }),
        makeGoal({
          goalId: 'g-clean',
          drainFleet: 'drain-clean',
          standing: true,
          drainRespawn: { deadSinceMs: null, needsHuman: false },
        }),
      ],
      holders: [makeHolder(), makeHolder({ goalId: 'g-clean' })],
    }));
    deps.resolveFleetLiveness = vi.fn(async () =>
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const, [fleetKey('ws', 'drain-clean')]: 'alive' as const }),
    );
    deps.resolveFleetSpecScopes = vi.fn(async () =>
      scopes({ 'g-1': 'goal-scoped' as const, 'g-clean': 'goal-scoped' as const }),
    );
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 2, escalated: 0, skipped: false, relaunched: 0, relaunchCapped: 0 });
    expect(deps.clearDrainLedger).toHaveBeenCalledTimes(1);
    expect(deps.clearDrainLedger).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'g-1' }));
  });

  it('an UNKNOWN fleet verdict never clears the ledger (conservative rule holds on the way out too)', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [
        makeGoal({ drainFleet: 'drain-1', standing: true, drainRespawn: { deadSinceMs: NOW - 1, needsHuman: false } }),
      ],
      holders: [makeHolder()],
    }));
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'unknown' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 0, relaunched: 0 });
    expect(deps.clearDrainLedger).not.toHaveBeenCalled();
    expect(deps.markDrainDead).not.toHaveBeenCalled();
  });
});
