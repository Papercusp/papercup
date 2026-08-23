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
 * oracle omits an entry when its wakeability fetch degrades, so folding unknown
 * into lost converts one transient DB hiccup into simultaneous false-abandonment
 * verdicts across every goal in the workspace. Tests below pin that in both
 * directions (unknown alone; unknown alongside a dead holder).
 */
import { describe, it, expect } from 'vitest';

import {
  goalHolderKey,
  holderCountsAsAlive,
  resolveGoalHoldersBatchFromRows,
  resolveGoalHoldersFromRows,
  type GoalHolderRow,
} from './holder';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';

const WS = 'ws-1';
const G = 'goal-abc';

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

  it('supports concurrent holders: keeps every row and stays held when any holder is alive', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('first-claimant'), row('second-claimant')],
      verdicts(
        verdict({ ownerId: 'first-claimant', sessionState: 'live' }),
        verdict({ ownerId: 'second-claimant', sessionState: 'live' }),
      ),
    );

    expect(r.liveness).toBe('held');
    expect(r.holders.map((h) => h.ownerId)).toEqual(['first-claimant', 'second-claimant']);
    expect(r.live.map((h) => h.ownerId)).toEqual(['first-claimant', 'second-claimant']);
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

  it('unknown WINS over lost — one unresolvable holder suppresses the verdict', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('dead'), row('unresolvable')],
      verdicts(verdict({ ownerId: 'dead', sessionState: 'ended' })),
    );
    expect(r.liveness).toBe('unknown');
  });

  it('held WINS over unknown — one live holder is enough', () => {
    const r = resolveGoalHoldersFromRows(
      G,
      WS,
      [row('alive'), row('unresolvable')],
      verdicts(verdict({ ownerId: 'alive', sessionState: 'live' })),
    );
    expect(r.liveness).toBe('held');
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
