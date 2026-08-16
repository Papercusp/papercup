import { describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { GoalHolderLike } from './goal-liveness-watchdog';
import {
  GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
  classifyGoalDrainFleet,
  fleetKey,
  runGoalDrainFleetSweepOnce,
  scanGoalDrainFleets,
  type DrainFleetLiveness,
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

describe('classifyGoalDrainFleet', () => {
  it('alerts no-drain-fleet-declared on a live-held goal past the kickoff grace', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({}),
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
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent on an UNHELD goal — the liveness sibling owns that alarm', () => {
    const alert = classifyGoalDrainFleet(makeGoal(), [], verdicts(), fleets({}), NOW);
    expect(alert).toBeNull();
  });

  it('stays silent when every holder is dead — abandoned is the sibling territory', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder({ ownerId: 'su-dead' })],
      verdicts(makeVerdict('su-dead', 'ended')),
      fleets({}),
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
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('declared + fleet alive is healthy', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
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
        NOW,
      );
      expect(alert).toBeNull();
    }
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
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 0, skipped: false });
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.emitDrainDead).not.toHaveBeenCalled();
  });
});
