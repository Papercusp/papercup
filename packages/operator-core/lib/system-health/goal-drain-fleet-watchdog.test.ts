import { describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { GoalHolderLike } from './goal-liveness-watchdog';
import {
  GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
  claimSpecFilterConstrainsGoal,
  classifyGoalDrainFleet,
  fleetKey,
  runGoalDrainFleetSweepOnce,
  scanGoalDrainFleets,
  type DrainFleetLiveness,
  type DrainFleetSpecScope,
  type GoalDrainRowLike,
} from './goal-drain-fleet-watchdog';

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
    expect(
      claimSpecFilterConstrainsGoal({ any: [leaf, { field: 'kind', op: '=', value: 'bug' }] }, 'g-1'),
    ).toBe(false);
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

describe('scanGoalDrainFleets', () => {
  it('classifies each goal independently', () => {
    const goals = [
      makeGoal({ goalId: 'g-bad' }),
      makeGoal({ goalId: 'g-ok', drainFleet: 'drain-ok' }),
    ];
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
    resolveFleetLiveness: vi.fn(
      async () => fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const }),
    ),
    resolveFleetSpecScopes: vi.fn(async () => scopes()),
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
  });

  it('skips entirely when the flag is off', async () => {
    const deps = { ...baseDeps(), flagEnabled: vi.fn(async () => false) };
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 0, escalated: 0, skipped: true });
    expect(deps.readGoals).not.toHaveBeenCalled();
  });

  it('escalates AND emits for a dead declared fleet', async () => {
    const deps = baseDeps();
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false });
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'drain-fleet-dead' }),
    );
  });

  it('resolves liveness only for holders of active goals, and fleet liveness only for declared fleets', async () => {
    const deps = baseDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1' }), makeGoal({ goalId: 'g-2', drainFleet: null })],
      holders: [
        makeHolder(),
        makeHolder({ goalId: 'g-closed', ownerId: 'su-irrelevant' }),
      ],
    }));
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.resolveLiveness).toHaveBeenCalledWith(['su-a']);
    expect(deps.resolveFleetLiveness).toHaveBeenCalledWith([
      { workspaceId: 'ws', fleetSlug: 'drain-1' },
    ]);
  });

  it('a failed escalate is contained and the emit still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = baseDeps();
      deps.escalate = vi.fn(async () => {
        throw new Error('escalation surface down');
      });
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res).toEqual({ scanned: 1, escalated: 0, skipped: false });
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
      expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false });
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
    deps.resolveFleetLiveness = vi.fn(
      async () => fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const }),
    );
    deps.resolveFleetSpecScopes = vi.fn(async () => scopes({ 'g-1': 'goal-scoped' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 0, skipped: false });
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
    deps.resolveFleetLiveness = vi.fn(
      async () => fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const }),
    );
    deps.resolveFleetSpecScopes = vi.fn(async () => scopes({ 'g-1': 'not-goal-scoped' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false });
    expect(deps.escalate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'drain-fleet-not-goal-scoped' }),
    );
  });

  it('spec scopes are resolved ONLY for alive fleets — dead ones already have their verdict', async () => {
    const deps = baseDeps(); // baseDeps liveness: dead
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.resolveFleetSpecScopes).toHaveBeenCalledWith([]);
  });
});
