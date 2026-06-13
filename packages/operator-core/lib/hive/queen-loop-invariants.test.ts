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
 *  2. **The BEHAVIORAL contract — `it.todo`, lights up with its brief.** The
 *     Queen's placement loop is 100% PROMPT-DRIVEN today (blueprints/hive/
 *     prompts/queen.md) — there is no deterministic placement function to drive,
 *     and the behaviors P-051 asserts (batch placement, dead-bee re-placement,
 *     cursed-item breaker, drive-to-empty, question-unblock) are exactly what
 *     B-07 / B-09 / B-10 / B-17 BUILD. Each behavioral clause starts as a precise
 *     `it.todo` naming the brief that lands it, and CONVERTS to a live assertion
 *     over the real seam the moment that brief ships its deterministic decider —
 *     so the contract is a living, registered spec, not vapor. B-09's
 *     completion-guarantee seam (placement-watchdog.ts) has landed, so its three
 *     clauses (terminal tracking, dead-bee re-placement, cursed-item breaker)
 *     are now LIVE below; B-07 (batch placement) and B-10/B-17 (question ladder)
 *     remain `it.todo` until their seams land.
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

describe('P-051 Queen-loop contract — BEHAVIORAL (pending predecessor briefs)', () => {
  it.todo('B-07: a started Hive with N ready units + M free slots places min(N,M) bees in ONE wake');
  it.todo('B-09: the Queen drives the frontier to empty, every unit verified terminal, then idles (P-030)');
  it.todo('B-10/B-17: a reversible bee question is unblocked without the owner (intercepted card, not a freeze)');
});
