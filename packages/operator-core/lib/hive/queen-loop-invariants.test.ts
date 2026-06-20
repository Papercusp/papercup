/**
 * queen-loop-invariants.test.ts — the B-11 / P-051 Queen-loop CONTRACT.
 *
 * P-051 names the behavioral contract: "given N ready units + M free slots + a
 * started Hive, the Queen places min(N,M) in one wake, tracks each to terminal,
 * re-places a dead bee, trips the breaker on a cursed item, drives the frontier
 * to empty, and unblocks a reversible bee question without the owner."
 *
 * Two honest halves, modeled on scout-loop-invariants.test.ts:
 *
 *  1. **The OBSERVABILITY contract — GREEN TODAY.** The deterministic yardstick
 *     the loop is measured against (idealPlacements = min(N,M), the
 *     operating-well predicate, the metric derivations) is fully testable now
 *     over the pure functions in `./throughput`. These ARE the durable
 *     definition of "operating well" and they have teeth (a guard test proves
 *     each catches its violation).
 *
 *  2. **The BEHAVIORAL contract — now FULLY LIVE.** P-051's behaviors (batch
 *     placement, dead-bee re-placement, cursed-item breaker, drive-to-empty,
 *     question-unblock) were `it.todo` while the Queen loop was prompt-only; as
 *     each predecessor brief shipped its deterministic seam, the matching clause
 *     converted to a live assertion over the REAL seam (the scout-loop-invariants
 *     pattern — contract altitude, not a re-test of the seam internals):
 *       - B-07 batch fan-out  → `fleet/batch-placement.ts` `planBatchPlacement`
 *       - B-08 ranking        → `placement-ranker.ts` `rankPlacements`
 *       - B-09 completion     → `placement-watchdog.ts` `evaluatePlacement`/`deriveBeeLiveness`
 *       - B-09/P-030 drive    → `wake-frontier-guard.ts` `evaluateWakeFrontierGuard`
 *       - B-10/B-12 question  → `autonomy/decider.ts` `decideAutonomy`
 *     0 `it.todo` remain — the full behavioral contract is pinned over real code.
 *
 * See queen-autonomous-execution-2026-06-13 (B-11; D-007 behavior-neutral-now).
 */
import { describe, it, expect } from 'vitest';
import {
  computeHiveThroughput,
  detectThroughputBreaches,
  idealPlacements,
  isOperatingWell,
  type HiveThroughputInput,
} from './throughput';
import {
  deriveBeeLiveness,
  evaluatePlacement,
  isUnitTerminal,
  placementConfig,
  type PlacementObservation,
} from './placement-watchdog';
import { rankPlacements, type PlacementCandidate } from './placement-ranker';
import { planBatchPlacement } from '../fleet/batch-placement';
import type { PlacementTask, PlacementBee } from '../fleet/placement-affinity';
import { evaluateWakeFrontierGuard } from './wake-frontier-guard';
import { decideAutonomy } from '../autonomy/decider';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function input(over: Partial<HiveThroughputInput> = {}): HiveThroughputInput {
  return {
    nowMs: NOW,
    frontierDepth: 0,
    ceiling: 16,
    running: 0,
    spawns: [],
    lastTickAtMs: null,
    stuckThresholdMs: 10 * MIN,
    ...over,
  };
}

describe('P-051 Queen-loop contract — OBSERVABILITY yardstick (green today)', () => {
  describe('places min(N,M): the placement capacity yardstick', () => {
    it('ideal placements is min(ready frontier N, free slots M)', () => {
      expect(idealPlacements(5, 3)).toBe(3); // slot-bound
      expect(idealPlacements(2, 8)).toBe(2); // frontier-bound
      expect(idealPlacements(4, 4)).toBe(4); // exact
    });
    it('never negative, never fractional (clamps the messy inputs)', () => {
      expect(idealPlacements(-3, 5)).toBe(0);
      expect(idealPlacements(5, -1)).toBe(0);
      expect(idealPlacements(2.9, 9.9)).toBe(2);
    });
    it('an empty frontier or zero headroom plans zero placements', () => {
      expect(idealPlacements(0, 16)).toBe(0);
      expect(idealPlacements(9, 0)).toBe(0);
    });
  });

  describe('the operating-well predicate (the health yardstick)', () => {
    it('slack fleet + no stuck = operating well', () => {
      expect(isOperatingWell(computeHiveThroughput(input({ ceiling: 16, running: 4, frontierDepth: 9 })))).toBe(true);
    });
    it('saturated WITH queued work is NOT operating well (starvation)', () => {
      expect(isOperatingWell(computeHiveThroughput(input({ ceiling: 8, running: 8, frontierDepth: 3 })))).toBe(false);
    });
    it('saturated with an empty frontier IS fine (nothing waiting)', () => {
      expect(isOperatingWell(computeHiveThroughput(input({ ceiling: 8, running: 8, frontierDepth: 0 })))).toBe(true);
    });
    it('a stuck placement is NOT operating well, even with slack', () => {
      const m = computeHiveThroughput(
        input({
          ceiling: 16,
          running: 1,
          spawns: [{ status: 'running', startedAtMs: NOW - 30 * MIN, finishedAtMs: null, durationMs: null, heartbeatAtMs: NOW - 30 * MIN }],
        }),
      );
      expect(isOperatingWell(m)).toBe(false);
    });
  });

  describe('the yardstick has teeth — a regressed loop is caught, not waved through', () => {
    it('starvation surfaces as a breach AND fails operating-well (both signals agree)', () => {
      const m = computeHiveThroughput(input({ ceiling: 4, running: 4, frontierDepth: 7 }));
      expect(isOperatingWell(m)).toBe(false);
      expect(detectThroughputBreaches(m, 'h').some((b) => b.kind === 'starvation')).toBe(true);
    });
    it('a stuck bee surfaces as a breach AND fails operating-well', () => {
      const m = computeHiveThroughput(
        input({ running: 1, spawns: [{ status: 'running', startedAtMs: NOW - 40 * MIN, finishedAtMs: null, durationMs: null, heartbeatAtMs: NOW - 40 * MIN }] }),
      );
      expect(isOperatingWell(m)).toBe(false);
      expect(detectThroughputBreaches(m, 'h').some((b) => b.kind === 'stuck')).toBe(true);
    });
  });
});

/**
 * The BEHAVIORAL contract. Each clause is GREEN-by-`it.todo` until its mechanism
 * ships — the Queen loop is prompt-driven (queen.md), so these assert a real
 * wake's effect, which only exists once the named brief lands. Keeping them here
 * (registered, named) makes P-051 a living contract: the day B-07/B-09/B-10 land
 * a deterministic placement seam, these convert from todo to real assertions.
 */
describe('P-051 Queen-loop contract — BEHAVIORAL completion guarantee (B-09 seam LIVE)', () => {
  // B-09's completion-guarantee seam landed (placement-watchdog.ts, su-17e08): the
  // pure deciders `evaluatePlacement` / `deriveBeeLiveness` / `isUnitTerminal`. The
  // P-051 contract now asserts the loop's completion guarantee over those REAL
  // functions (the scout-loop-invariants pattern: contract-altitude, not a re-test
  // of the watchdog internals). Converts D-012's first three behavioral it.todos.
  const cfg = placementConfig();
  const obs = (over: Partial<PlacementObservation> = {}): PlacementObservation => ({
    workItemId: 'W-1',
    unitExists: true,
    unitTerminal: false,
    hasLiveHolder: false,
    failCount: 0,
    infraLossCount: 0,
    placementStatus: null,
    lastRecoveryAtMs: null,
    now: NOW,
    ...over,
  });

  it('tracks every placed unit to terminal — a terminal unit reads as completed, not re-placed', () => {
    expect(isUnitTerminal('passed')).toBe(true);
    expect(isUnitTerminal('todo')).toBe(false);
    expect(evaluatePlacement(obs({ unitTerminal: true }), cfg).kind).toBe('completed');
    // a unit that vanished is abandoned, never silently re-placed forever
    expect(evaluatePlacement(obs({ unitExists: false }), cfg).kind).toBe('abandon');
  });

  it('re-places a dead bee — a killed/stale bee reads dead and its orphaned non-terminal unit recovers', () => {
    expect(deriveBeeLiveness({ status: 'failed', heartbeatAtMs: NOW, lastOutputAtMs: NOW, now: NOW })).toBe('dead');
    expect(
      deriveBeeLiveness({ status: 'running', heartbeatAtMs: NOW - 24 * 60 * 60_000, lastOutputAtMs: null, now: NOW }),
    ).toBe('dead');
    // a LIVE holder is healthy (no spurious re-place); a dead one recovers (re-place)
    expect(evaluatePlacement(obs({ hasLiveHolder: true }), cfg).kind).toBe('healthy');
    expect(evaluatePlacement(obs({ hasLiveHolder: false }), cfg).kind).toBe('recover');
  });

  it('trips the cursed-item breaker at the threshold — escalates instead of re-placing again', () => {
    // below threshold → keep recovering; the failure that REACHES the threshold → breaker
    expect(evaluatePlacement(obs({ failCount: cfg.breakerThreshold - 2 }), cfg).kind).toBe('recover');
    expect(evaluatePlacement(obs({ failCount: cfg.breakerThreshold - 1 }), cfg).kind).toBe('breaker');
  });
});

describe('P-051 Queen-loop contract — BEHAVIORAL prioritization (B-08 ranker LIVE)', () => {
  // B-08's "one ranker" seam landed (placement-ranker.ts, su-37d9d): the pure
  // `rankPlacements` over the FB-12 engine, plan-importance-first. The P-051
  // contract asserts the loop ranks its placement frontier correctly over the
  // REAL ranker (contract-altitude, not a re-test of the ranker's internals).
  const cand = (over: Partial<PlacementCandidate>): PlacementCandidate => ({
    id: 'x',
    view: 'work-item',
    harness: 'mem-a',
    title: 't',
    ...over,
  });

  it('ranks the frontier plan-importance-first across 2+ member harnesses', async () => {
    const ranked = await rankPlacements([
      cand({ id: 'mem-a:low', harness: 'mem-a', importance: 'low' }),
      cand({ id: 'mem-b:urgent', harness: 'mem-b', view: 'plan', importance: 'urgent' }),
      cand({ id: 'mem-a:normal', harness: 'mem-a', importance: 'normal' }),
    ]);
    // importance is the primary signal (weight 4): urgent (mem-b) > normal > low (mem-a),
    // and the order spans both member harnesses — the Queen pours into the hot plan first.
    expect(ranked.map((r) => r.id)).toEqual(['mem-b:urgent', 'mem-a:normal', 'mem-a:low']);
  });

  it('escalation pressure + blocking impact lift an item above a higher-importance idle one', async () => {
    // A 'normal' item gating downstream work + carrying an open escalation should
    // outrank a bare 'high' item — the ranker is multi-signal, not importance-only.
    const ranked = await rankPlacements([
      cand({ id: 'bare-high', importance: 'high' }),
      cand({ id: 'blocking-normal', importance: 'normal', blocksOut: 4, escalations: 2 }),
    ]);
    expect(ranked[0]!.id).toBe('blocking-normal');
  });
});

describe('P-051 Queen-loop contract — BEHAVIORAL batch fan-out (B-07 seam LIVE)', () => {
  // B-07's batch-placement seam landed (fleet/batch-placement.ts, su-a8aa4): the
  // pure `planBatchPlacement` (warm-inject → fresh-spawn → unplaced ladder, cap-
  // aware). The P-051 contract asserts "places min(N,M) in ONE wake" over it.
  const task = (id: string): PlacementTask => ({ id, harness: null, title: id });

  it('places min(N,M) in one wake — slot-bound: 5 ready, 3 free slots, no warm bees → 3 spawns + 2 queued back', () => {
    const plan = planBatchPlacement({ tasks: [task('A'), task('B'), task('C'), task('D'), task('E')], bees: [], headroom: 3 });
    expect(plan.spawnCount).toBe(3); // min(5, 3)
    expect(plan.injectCount).toBe(0);
    expect(plan.unplacedCount).toBe(2); // the rest stay on the frontier for the next wake
    expect(idealPlacements(5, 3)).toBe(plan.spawnCount + plan.injectCount); // matches the yardstick
  });

  it('frontier-bound: 2 ready, 8 free slots → places all 2, none unplaced', () => {
    const plan = planBatchPlacement({ tasks: [task('A'), task('B')], bees: [], headroom: 8 });
    expect(plan.spawnCount).toBe(2);
    expect(plan.unplacedCount).toBe(0);
  });

  it('fans across the fleet in ONE wake — a same-plan task warm-injects, the rest spawn (not serial)', () => {
    const bee: PlacementBee = { ownerId: 's-1', harness: 'mem-a', currentPlanSlug: 'p1', load: 0, alive: true };
    const plan = planBatchPlacement({
      tasks: [{ id: 'X', harness: 'mem-a', title: 'x', planSlug: 'p1' }, task('Y')],
      bees: [bee],
      headroom: 1,
    });
    expect(plan.injectCount).toBe(1); // X → warm-inject onto the same-plan bee (explicit-intent)
    expect(plan.spawnCount).toBe(1); // Y → fresh spawn
    expect(plan.unplacedCount).toBe(0); // both placed in the single batch
  });
});

describe('P-051 Queen-loop contract — BEHAVIORAL drive-to-empty (B-09/P-030 seam LIVE)', () => {
  // P-030's drive-to-empty seam landed (wake-frontier-guard.ts): the pure
  // `evaluateWakeFrontierGuard` refuses an idle (no-time) wake while the frontier
  // is non-empty OR placements are still in flight, and allows idle only when both
  // are clear — i.e. the Queen drives to empty, then idles.
  it('refuses idle while ready work waits (frontier not empty)', () => {
    expect(evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds: ['WI-1'], openPlacementIds: [] })).not.toBeNull();
  });

  it('refuses idle while a placement is still non-terminal (drive every unit to completion)', () => {
    expect(evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds: [], openPlacementIds: ['WI-2'] })).not.toBeNull();
  });

  it('allows idle ONLY when the frontier is empty AND every placement is terminal', () => {
    expect(evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds: [], openPlacementIds: [] })).toBeNull();
  });

  it('a time-wake always passes — the Queen re-wakes to place/monitor', () => {
    expect(evaluateWakeFrontierGuard({ hasTimeWake: true, frontierIds: ['WI-1'], openPlacementIds: ['WI-2'] })).toBeNull();
  });
});

describe('P-051 Queen-loop contract — BEHAVIORAL question-unblock (B-10/B-12 gate seam LIVE)', () => {
  // The autonomy gate landed (autonomy/decider.ts, B-12): the pure `decideAutonomy`.
  // The P-051 contract asserts a reversible, in-envelope, non-owner bee question
  // self-resolves (not the owner) once armed; owner-reserved / irreversible ones
  // still gate to the owner; and it's behavior-neutral (gated) until armed.
  const escalations = 'escalations' as const; // the agent-question category (not protected)

  it('a reversible, below-ceiling, non-owner question self-resolves when armed (no owner)', () => {
    const d = decideAutonomy({
      category: escalations,
      authority: 'system',
      reversibility: 'reversible',
      riskTier: 'low',
      effectiveCeiling: 'moderate',
      armed: true,
    });
    expect(d.posture).toBe('auto'); // unblocked without the owner
    expect(d.wouldAutoIfArmed).toBe(true);
  });

  it('an owner-authority question ALWAYS gates to the owner, even reversible + armed', () => {
    const d = decideAutonomy({
      category: escalations,
      authority: 'owner',
      reversibility: 'reversible',
      riskTier: 'low',
      effectiveCeiling: 'moderate',
      armed: true,
    });
    expect(d.posture).toBe('gated');
    expect(d.reasons).toContain('owner-authority');
  });

  it('an irreversible question gates (blast-radius hard floor)', () => {
    const d = decideAutonomy({
      category: escalations,
      authority: 'system',
      reversibility: 'irreversible',
      riskTier: 'low',
      effectiveCeiling: 'moderate',
      armed: true,
    });
    expect(d.posture).toBe('gated');
    expect(d.reasons).toContain('irreversible-action');
  });

  it('behavior-neutral until armed: the same in-envelope question is gated dark, but would self-resolve once armed', () => {
    const dark = decideAutonomy({
      category: escalations,
      authority: 'system',
      reversibility: 'reversible',
      riskTier: 'low',
      effectiveCeiling: 'moderate',
      armed: false,
    });
    expect(dark.posture).toBe('gated'); // nothing auto-decides until the owner arms (D-007)
    expect(dark.wouldAutoIfArmed).toBe(true); // …but the gate proves it WOULD, without the owner
  });
});
