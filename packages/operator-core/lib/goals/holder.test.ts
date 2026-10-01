/**
 * holder.test.ts — the canonical goal-holder resolver
 * (goal-live-holder-guarantee-2026-08-18 P-001, D-005).
 *
 * WHAT THIS LOCKS, and why each case is here rather than implied:
 *
 * The bug being fixed is that ROW PRESENCE IS NOT LIVENESS — an `agent_modes`
 * goal-mode row outlives the session that wrote it, so counting rows reports a
 * goal nobody has touched in days as staffed. The fix computes the answer fresh
 * from the presence oracle on every read. That makes the classifier the whole
 * correctness surface, so every one of its four verdicts gets a test, and so
 * does each of the six session states D-005 had to rule on.
 *
 * The case most likely to be "simplified" later — and the one that would do the
 * most damage — is `unknown`. An unresolvable holder must NOT read as dead: the
 * oracle returns an in-band unknown when its wakeability fetch degrades, so folding unknown
 * into lost converts one transient DB hiccup into simultaneous false-abandonment
 * verdicts across every goal in the workspace. Tests below pin that in both
 * directions (unknown alone; unknown alongside a dead holder).
 */
import { describe, it, expect } from 'vitest';

import {
  goalHolderKey,
  holderCountsAsAlive,
  holderIsRekickable,
  resolveGoalHoldersBatchFromRows,
  resolveGoalHoldersFromRows,
  type GoalHolderRow,
} from './holder';
import { unknownVerdict, type LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';

const WS = 'ws-1';
const G = 'goal-abc';
const NOW = Date.parse('2026-08-30T07:30:00.000Z');

function row(ownerId: string, over: Partial<GoalHolderRow> = {}): GoalHolderRow {
  return { goalId: G, workspaceId: WS, ownerId, setAtMs: 1_000, ...over };
}

function verdict(over: Partial<LivenessVerdict> & { ownerId: string }): LivenessVerdict {
  return {
    sessionState: 'live',
    wakeable: true,
    liveTurn: false,
    confirmLiveness: null,
    heartbeatFresh: true,
    ...over,
  } as LivenessVerdict;
}

function verdicts(...vs: LivenessVerdict[]): Map<string, LivenessVerdict> {
  return new Map(vs.map((v) => [v.ownerId, v]));
}

// WI-1074216/P-006: permanent wrong subjects for the holder contract. An explicit
// control run selects one specimen; ordinary CI checks the real resolver AND
// that its independent oracle rejects every specimen. Production stays intact.
type HolderResolution = ReturnType<typeof resolveGoalHoldersFromRows>;
type HolderContractObservation = {
  liveness: HolderResolution['liveness'];
  elected: string | null;
  live: string[];
  overlap: HolderResolution['overlap']['status'];
};
const observeHolderContract = (result: HolderResolution): HolderContractObservation => ({
  liveness: result.liveness,
  elected: result.elected?.ownerId ?? null,
  live: result.live.map((holder) => holder.ownerId),
  overlap: result.overlap.status,
});
const predecessor = row('predecessor', { goalLeaseEpoch: 1 });
const successor = row('successor', {
  setAtMs: 2_000,
  goalLeaseEpoch: 2,
  goalHandoffFromOwnerId: 'predecessor',
  goalHandoffExpiresAtMs: NOW + 60_000,
});
const liveHandoffVerdicts = verdicts(
  verdict({ ownerId: 'predecessor' }), verdict({ ownerId: 'successor' }), verdict({ ownerId: 'third' }),
);
const holderContractCases: Array<{
  scenario: string;
  rows: GoalHolderRow[];
  oracle: Map<string, LivenessVerdict>;
  expected: Partial<HolderContractObservation>;
  wrong: (result: HolderResolution) => Partial<HolderContractObservation>;
}> = [
  {
    scenario: 'one-elected-holder', rows: [row('first'), row('second')],
    oracle: verdicts(verdict({ ownerId: 'first' }), verdict({ ownerId: 'second' })),
    expected: { elected: 'first', live: ['first'], overlap: 'violation' },
    wrong: (result) => ({ live: result.allLive.map((holder) => holder.ownerId) }),
  },
  {
    scenario: 'elected-lost-historical-live',
    rows: [row('historical', { goalLeaseEpoch: 1 }), row('elected', { goalLeaseEpoch: 2 })],
    oracle: verdicts(verdict({ ownerId: 'historical' }), verdict({ ownerId: 'elected', sessionState: 'ended' })),
    expected: { elected: 'elected', liveness: 'lost', live: [] },
    wrong: (result) => ({ liveness: 'held', live: result.allLive.map((holder) => holder.ownerId) }),
  },
  {
    scenario: 'named-bounded-handoff', rows: [predecessor, successor], oracle: liveHandoffVerdicts,
    expected: { elected: 'successor', live: ['successor'], overlap: 'handoff' },
    wrong: () => ({ overlap: 'violation' }),
  },
  {
    scenario: 'expired-handoff',
    rows: [predecessor, { ...successor, goalHandoffExpiresAtMs: NOW - 1 }], oracle: liveHandoffVerdicts,
    expected: { elected: 'successor', overlap: 'violation' },
    wrong: () => ({ overlap: 'handoff' }),
  },
  {
    scenario: 'third-holder', rows: [predecessor, successor, row('third')], oracle: liveHandoffVerdicts,
    expected: { elected: 'successor', overlap: 'violation' },
    wrong: () => ({ overlap: 'handoff' }),
  },
  {
    scenario: 'unresolved-elected-holder', rows: [row('unresolved')], oracle: verdicts(),
    expected: { elected: 'unresolved', liveness: 'unknown', live: [] },
    wrong: () => ({ liveness: 'lost' }),
  },
  {
    scenario: 'confirmed-loss-control', rows: [row('dead')],
    oracle: verdicts(verdict({ ownerId: 'dead', sessionState: 'ended' })),
    expected: { elected: 'dead', liveness: 'lost', live: [] },
    wrong: () => ({ liveness: 'unknown' }),
  },
];

describe('holder contract causal controls', () => {
  const selectedControl = process.env.PAPERCUSP_GOAL_HOLDER_CONTROL;
  if (selectedControl && !holderContractCases.some(({ scenario }) => scenario === selectedControl)) {
    throw new Error(`Unknown permanent holder control: ${selectedControl}`);
  }
  const assertContract = (actual: HolderContractObservation, expected: Partial<HolderContractObservation>, id: string) =>
    expect(actual, `holder-contract:${id}`).toMatchObject(expected);

  it('calibration: a real lone live holder remains effective', () => {
    const result = resolveGoalHoldersFromRows(G, WS, [row('lone')], verdicts(verdict({ ownerId: 'lone' })), NOW);
    expect(result.liveness).toBe('held');
    expect(result.elected?.ownerId).toBe('lone');
    expect(result.live.map((holder) => holder.ownerId)).toEqual(['lone']);
  });

  it.each(holderContractCases)('repaired holder contract: $scenario', ({ scenario, rows, oracle, expected, wrong }) => {
    const result = resolveGoalHoldersFromRows(G, WS, rows, oracle, NOW);
    const actual = observeHolderContract(result);
    assertContract(selectedControl === scenario ? { ...actual, ...wrong(result) } : actual, expected, scenario);
  });

  it.each(holderContractCases)('detects permanent wrong holder: $scenario', ({ scenario, rows, oracle, expected, wrong }) => {
    const result = resolveGoalHoldersFromRows(G, WS, rows, oracle, NOW);
    assertContract(observeHolderContract(result), expected, scenario);
    expect(() => assertContract({ ...observeHolderContract(result), ...wrong(result) }, expected, scenario))
      .toThrow(`holder-contract:${scenario}`);
  });
});

/**
 * WI-2140573 (measured 2026-09-01): the fold must carry the RAW heartbeat so
 * a supervisor can tell a dead PROCESS from a live process whose SESSION is
 * idle — the seven codex holders whose kickoff died at the model layer were
 * exactly `parked` + `selfWake:'none'` + heartbeat fresh, for hours.
 */
describe('holderIsRekickable — a lost holder whose process is still up', () => {
  const fold = (v: LivenessVerdict) =>
    resolveGoalHoldersFromRows(G, WS, [row(v.ownerId)], verdicts(v), NOW).elected!;

  it('carries heartbeatFresh from the verdict (null when no verdict)', () => {
    expect(fold(verdict({ ownerId: 'a', heartbeatFresh: true })).heartbeatFresh).toBe(true);
    expect(fold(verdict({ ownerId: 'a', heartbeatFresh: false })).heartbeatFresh).toBe(false);
    expect(resolveGoalHoldersFromRows(G, WS, [row('a')], verdicts(), NOW).elected!.heartbeatFresh).toBeNull();
  });

  it('is true ONLY for lost + parked + selfWake none + fresh heartbeat', () => {
    const idle = fold(verdict({ ownerId: 'a', sessionState: 'parked', selfWake: 'none', heartbeatFresh: true }));
    expect(idle.live).toBe(false);
    expect(holderIsRekickable(idle)).toBe(true);
  });

  it('is false for every shape a wake cannot fix', () => {
    // Process gone: a cold heartbeat, or an ended session.
    expect(
      holderIsRekickable(fold(verdict({ ownerId: 'a', sessionState: 'parked', selfWake: 'none', heartbeatFresh: false }))),
    ).toBe(false);
    expect(holderIsRekickable(fold(verdict({ ownerId: 'a', sessionState: 'ended', heartbeatFresh: true })))).toBe(false);
    // Not lost at all: parked with a loop armed is a healthy steward between wakes.
    expect(
      holderIsRekickable(fold(verdict({ ownerId: 'a', sessionState: 'parked', selfWake: 'loop', heartbeatFresh: true }))),
    ).toBe(false);
    // Self-wake UNKNOWN (leg not fetched) is not 'none': never re-kick on a guess.
    expect(holderIsRekickable(fold(verdict({ ownerId: 'a', sessionState: 'parked', heartbeatFresh: true })))).toBe(false);
    // No verdict at all: unresolvable, not re-kickable.
    expect(
      holderIsRekickable(resolveGoalHoldersFromRows(G, WS, [row('a')], verdicts(), NOW).elected!),
    ).toBe(false);
  });
});

describe('holderCountsAsAlive — D-005 pins every session state', () => {
  it('live counts as holding', () => {
    expect(holderCountsAsAlive(verdict({ ownerId: 'a', sessionState: 'live' }))).toBe(true);
  });

  it('recorded counts as holding', () => {
    expect(holderCountsAsAlive(verdict({ ownerId: 'a', sessionState: 'recorded' }))).toBe(true);
  });

  /**
   * THE LOAD-BEARING CASE. `parked` is the normal resting state of a healthy
   * steward between wakes. Treating it as not-holding would deactivate every
   * well-behaved goal the moment it idled — which is worse than the bug being
   * fixed, because it would fire constantly and on the goals that are working.
   */
  it('parked counts as holding — a steward between wakes is not gone', () => {
    expect(holderCountsAsAlive(verdict({ ownerId: 'a', sessionState: 'parked' }))).toBe(true);
  });

  it('parked WITH selfWake:none does NOT count — nothing will ever wake it', () => {
    expect(
      holderCountsAsAlive(verdict({ ownerId: 'a', sessionState: 'parked', selfWake: 'none' })),
    ).toBe(false);
  });

  /**
   * An ABSENT self-wake leg is UNKNOWN, not 'none'. The distinction is the
   * difference between "we measured that nothing will wake it" and "we did not
   * measure", and only the first is evidence of death.
   */
  it('parked with an ABSENT selfWake leg still counts — unmeasured is not none', () => {
    const v = verdict({ ownerId: 'a', sessionState: 'parked' });
    delete (v as { selfWake?: unknown }).selfWake;
    expect(holderCountsAsAlive(v)).toBe(true);
  });

  it('draining and suspect count as holding — mid-verdict, decide next read', () => {
    expect(holderCountsAsAlive(verdict({ ownerId: 'a', sessionState: 'draining' }))).toBe(true);
    expect(holderCountsAsAlive(verdict({ ownerId: 'a', sessionState: 'suspect' }))).toBe(true);
  });

  it('ended is the ONLY state that positively means gone', () => {
    expect(holderCountsAsAlive(verdict({ ownerId: 'a', sessionState: 'ended' }))).toBe(false);
  });
});

describe('resolveGoalHoldersFromRows — the four verdicts', () => {
  it('unheld: no goal-mode row at all', () => {
    const r = resolveGoalHoldersFromRows(G, WS, [], new Map());
    expect(r.liveness).toBe('unheld');
    expect(r.holders).toEqual([]);
    expect(r.live).toEqual([]);
  });

  it('held: at least one holder resolves positively alive', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('a')],
      verdicts(verdict({ ownerId: 'a', sessionState: 'live' })),
    );
    expect(r.liveness).toBe('held');
    expect(r.live.map((h) => h.ownerId)).toEqual(['a']);
  });

  it('elects one effective legacy holder and marks unannounced live overlap as a violation', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('first-claimant'), row('second-claimant')],
      verdicts(
        verdict({ ownerId: 'first-claimant', sessionState: 'live' }),
        verdict({ ownerId: 'second-claimant', sessionState: 'live' }),
      ),
      NOW,
    );

    expect(r.liveness).toBe('held');
    expect(r.holders.map((h) => h.ownerId)).toEqual(['first-claimant', 'second-claimant']);
    expect(r.elected?.ownerId).toBe('first-claimant');
    expect(r.live.map((h) => h.ownerId)).toEqual(['first-claimant']);
    expect(r.allLive.map((h) => h.ownerId)).toEqual(['first-claimant', 'second-claimant']);
    expect(r.overlap.status).toBe('violation');
  });

  /**
   * THE BUG, stated as a test. A row exists — every count-based surface would
   * call this goal staffed — and the session behind it is gone.
   */
  it('lost: rows exist, all resolved, none alive — the six-day-dark Blender shape', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('dead-steward')],
      verdicts(verdict({ ownerId: 'dead-steward', sessionState: 'ended' })),
    );
    expect(r.liveness).toBe('lost');
    expect(r.live).toEqual([]);
    // The dead holder is still LISTED, not vanished: "this goal HAD an agent and
    // it died" is the fact a reader needs, and dropping the row would hide it.
    expect(r.holders.map((h) => h.ownerId)).toEqual(['dead-steward']);
    expect(r.holders[0].live).toBe(false);
    expect(r.holders[0].sessionState).toBe('ended');
  });

  /**
   * The regression this pair exists to prevent: a degraded oracle read must not
   * be reported as death. `resolveSessionStates` OMITS an entry when its
   * wakeability fetch degrades, so an empty verdict map is the shape a transient
   * DB hiccup takes — and it arrives for EVERY goal at once.
   */
  it('unknown: a holder the oracle could not resolve is NOT dead', () => {
    const r = resolveGoalHoldersFromRows(G, WS, [row('a')], new Map());
    expect(r.liveness).toBe('unknown');
    expect(r.holders[0].live).toBeNull();
    expect(r.holders[0].sessionState).toBeNull();
  });

  it.each([
    unknownVerdict({ ownerId: 'unresolved' }, NOW),
    verdict({ ownerId: 'unresolved', sessionState: null }),
    verdict({ ownerId: 'unresolved', signalMissing: true }),
  ])('preserves an in-band unresolved oracle verdict as unknown ($sessionState, $signalMissing)', (unresolved) => {
    const result = resolveGoalHoldersFromRows(G, WS, [row('unresolved')], verdicts(unresolved), NOW);
    expect(result.liveness).toBe('unknown');
    expect(result.elected?.live).toBeNull();
    expect(result.live).toEqual([]);
    expect(result.allLive).toEqual([]);
  });

  it('the elected unresolvable holder yields unknown even when a historical holder is dead', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('dead'), row('unresolvable', { setAtMs: 2_000 })],
      verdicts(verdict({ ownerId: 'dead', sessionState: 'ended' })),
    );
    expect(r.liveness).toBe('unknown');
    expect(r.elected?.ownerId).toBe('unresolvable');
  });

  it('an elected live holder wins; an unelected unresolvable row is only history', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('alive', { setAtMs: 2_000 }), row('unresolvable')],
      verdicts(verdict({ ownerId: 'alive', sessionState: 'live' })),
    );
    expect(r.liveness).toBe('held');
    expect(r.live.map((holder) => holder.ownerId)).toEqual(['alive']);
  });

  it('permits exactly the named predecessor during the bounded handoff window', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [
        row('predecessor', { goalLeaseEpoch: 1 }),
        row('successor', {
          setAtMs: 2_000,
          goalLeaseEpoch: 2,
          goalHandoffFromOwnerId: 'predecessor',
          goalHandoffExpiresAtMs: NOW + 60_000,
        }),
      ],
      verdicts(
        verdict({ ownerId: 'predecessor', sessionState: 'live' }),
        verdict({ ownerId: 'successor', sessionState: 'live' }),
      ),
      NOW,
    );
    expect(r.elected?.ownerId).toBe('successor');
    expect(r.live.map((holder) => holder.ownerId)).toEqual(['successor']);
    expect(r.overlap).toMatchObject({
      status: 'handoff',
      predecessorOwnerId: 'predecessor',
      successorOwnerId: 'successor',
      expiresAtMs: NOW + 60_000,
    });
  });

  it('fails overlap after the handoff deadline, or immediately when a third holder is live', () => {
    const successor = row('successor', {
      setAtMs: 2_000,
      goalLeaseEpoch: 2,
      goalHandoffFromOwnerId: 'predecessor',
      goalHandoffExpiresAtMs: NOW - 1,
    });
    const baseVerdicts = verdicts(
      verdict({ ownerId: 'predecessor', sessionState: 'live' }),
      verdict({ ownerId: 'successor', sessionState: 'live' }),
      verdict({ ownerId: 'third', sessionState: 'live' }),
    );
    expect(
      resolveGoalHoldersFromRows(
        G,
        WS,
        [row('predecessor', { goalLeaseEpoch: 1 }), successor],
        baseVerdicts,
        NOW,
      ).overlap.status,
    ).toBe('violation');
    expect(
      resolveGoalHoldersFromRows(
        G,
        WS,
        [
          row('predecessor', { goalLeaseEpoch: 1 }),
          { ...successor, goalHandoffExpiresAtMs: NOW + 60_000 },
          row('third', { goalLeaseEpoch: 0 }),
        ],
        baseVerdicts,
        NOW,
      ).overlap.status,
    ).toBe('violation');
  });

  it('binds loss to the elected lease even while an older historical holder is live', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [
        row('historical-live', { goalLeaseEpoch: 1 }),
        row('elected-dead', { goalLeaseEpoch: 2, setAtMs: 2_000 }),
      ],
      verdicts(
        verdict({ ownerId: 'historical-live', sessionState: 'live' }),
        verdict({ ownerId: 'elected-dead', sessionState: 'ended' }),
      ),
      NOW,
    );
    expect(r.elected?.ownerId).toBe('elected-dead');
    expect(r.liveness).toBe('lost');
    expect(r.live).toEqual([]);
    expect(r.allLive.map((holder) => holder.ownerId)).toEqual(['historical-live']);
  });

  it('scopes by BOTH goal id and workspace — a goal id is not globally unique', () => {
    const rows = [
      row('mine'),
      row('other-goal', { goalId: 'goal-xyz' }),
      row('other-ws', { workspaceId: 'ws-2' }),
    ];
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      rows,
      verdicts(
        verdict({ ownerId: 'mine', sessionState: 'live' }),
        verdict({ ownerId: 'other-goal', sessionState: 'live' }),
        verdict({ ownerId: 'other-ws', sessionState: 'live' }),
      ),
    );
    expect(r.holders.map((h) => h.ownerId)).toEqual(['mine']);
  });
});

describe('resolveGoalHoldersBatchFromRows', () => {
  /**
   * A goal with ZERO holder rows must still get an entry. An inner join or a
   * group-by over the rows would drop it silently — and `unheld` (never picked
   * up) is one of the two conditions the sweeps exist to report, so losing it
   * would make the batch path quietly weaker than the single path.
   */
  it('emits an entry for a goal with NO holder rows', () => {
    const out = resolveGoalHoldersBatchFromRows(
      [
        { goalId: 'held-goal', workspaceId: WS },
        { goalId: 'never-picked-up', workspaceId: WS },
      ],
      [row('a', { goalId: 'held-goal' })],
      verdicts(verdict({ ownerId: 'a', sessionState: 'live' })),
    );
    expect(out.get(goalHolderKey(WS, 'held-goal'))?.liveness).toBe('held');
    expect(out.get(goalHolderKey(WS, 'never-picked-up'))?.liveness).toBe('unheld');
  });

  it('keys by workspace AND goal, so same-id goals in different workspaces do not merge', () => {
    const out = resolveGoalHoldersBatchFromRows(
      [
        { goalId: G, workspaceId: 'ws-1' },
        { goalId: G, workspaceId: 'ws-2' },
      ],
      [row('a', { workspaceId: 'ws-1' })],
      verdicts(verdict({ ownerId: 'a', sessionState: 'live' })),
    );
    expect(out.get(goalHolderKey('ws-1', G))?.liveness).toBe('held');
    expect(out.get(goalHolderKey('ws-2', G))?.liveness).toBe('unheld');
  });

  it('agrees with the single-goal path on every verdict', () => {
    const rows = [row('alive'), row('dead', { goalId: 'g2' })];
    const vs = verdicts(
      verdict({ ownerId: 'alive', sessionState: 'live' }),
      verdict({ ownerId: 'dead', sessionState: 'ended' }),
    );
    const goals = [
      { goalId: G, workspaceId: WS },
      { goalId: 'g2', workspaceId: WS },
      { goalId: 'g3', workspaceId: WS },
    ];
    const batch = resolveGoalHoldersBatchFromRows(goals, rows, vs);
    for (const g of goals) {
      expect(batch.get(goalHolderKey(g.workspaceId, g.goalId))).toEqual(
        resolveGoalHoldersFromRows(g.goalId, g.workspaceId, rows, vs),
      );
    }
  });
});
