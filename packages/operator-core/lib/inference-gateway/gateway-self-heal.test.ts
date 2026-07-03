import { describe, test, expect } from 'vitest';
import {
  isSaturated,
  evaluateSelfHeal,
  pickReclaimTarget,
  classifySlotReconcile,
  type SelfHealMetrics,
  type ReclaimCandidate,
} from './gateway-self-heal';

const FREEZE_MS = 75_000;

/** A saturated-but-just-stalled snapshot; tune msSinceLastDrain per test. */
function sat(overrides: Partial<SelfHealMetrics> = {}): SelfHealMetrics {
  return { inFlight: 4, queueDepth: 3, maxConcurrent: 4, msSinceLastDrain: 0, ...overrides };
}

describe('isSaturated', () => {
  test('true when every slot is taken AND work is queued', () => {
    expect(isSaturated({ inFlight: 4, queueDepth: 1, maxConcurrent: 4, msSinceLastDrain: 0 })).toBe(true);
    expect(isSaturated({ inFlight: 24, queueDepth: 70, maxConcurrent: 24, msSinceLastDrain: 0 })).toBe(true);
  });

  test('false when a slot is free (a waiter would be admitted — not wedged)', () => {
    expect(isSaturated({ inFlight: 3, queueDepth: 5, maxConcurrent: 4, msSinceLastDrain: 0 })).toBe(false);
  });

  test('false when no work is queued (busy but not backed up)', () => {
    expect(isSaturated({ inFlight: 4, queueDepth: 0, maxConcurrent: 4, msSinceLastDrain: 0 })).toBe(false);
  });

  test('false when maxConcurrent is 0 (queue closed / not yet sized)', () => {
    expect(isSaturated({ inFlight: 0, queueDepth: 0, maxConcurrent: 0, msSinceLastDrain: 0 })).toBe(false);
  });
});

describe('evaluateSelfHeal', () => {
  test('reclaims when saturated AND nothing drained for >= freezeMs', () => {
    const d = evaluateSelfHeal(sat({ msSinceLastDrain: FREEZE_MS }), FREEZE_MS);
    expect(d.reclaim).toBe(true);
    expect(d.reason).toMatch(/reclaiming oldest stuck slot/);
  });

  test('reclaims well past the threshold too (sustained wedge)', () => {
    expect(evaluateSelfHeal(sat({ msSinceLastDrain: 5 * 60_000 }), FREEZE_MS).reclaim).toBe(true);
  });

  test('does NOT reclaim before the drain clock crosses freezeMs (persistence guard)', () => {
    expect(evaluateSelfHeal(sat({ msSinceLastDrain: FREEZE_MS - 1 }), FREEZE_MS).reclaim).toBe(false);
    expect(evaluateSelfHeal(sat({ msSinceLastDrain: 10_000 }), FREEZE_MS).reclaim).toBe(false);
  });

  test('does NOT reclaim when draining, even if very saturated (busy is not wedged)', () => {
    // 24/24 with a deep queue but a request completed 2s ago → healthy throughput, no reclaim.
    const d = evaluateSelfHeal(
      { inFlight: 24, queueDepth: 200, maxConcurrent: 24, msSinceLastDrain: 2_000 },
      FREEZE_MS,
    );
    expect(d.reclaim).toBe(false);
    expect(d.reason).toBeNull();
  });

  test('does NOT reclaim when a slot is free, regardless of how long since a drain', () => {
    const d = evaluateSelfHeal(
      { inFlight: 3, queueDepth: 9, maxConcurrent: 4, msSinceLastDrain: 10 * 60_000 },
      FREEZE_MS,
    );
    expect(d.reclaim).toBe(false);
  });

  test('does NOT reclaim when the queue is empty (no waiter is starved)', () => {
    const d = evaluateSelfHeal(
      { inFlight: 4, queueDepth: 0, maxConcurrent: 4, msSinceLastDrain: 10 * 60_000 },
      FREEZE_MS,
    );
    expect(d.reclaim).toBe(false);
  });

  test('fires comfortably before the watchdog: 75s default < the watchdog 120s freeze', () => {
    // At the moment the watchdog would START its 120s freeze count, self-heal has already reclaimed.
    expect(evaluateSelfHeal(sat({ msSinceLastDrain: 75_000 }), 75_000).reclaim).toBe(true);
    expect(75_000).toBeLessThan(120_000);
  });

  test('is stateless — identical inputs give identical output', () => {
    const m = sat({ msSinceLastDrain: FREEZE_MS });
    expect(evaluateSelfHeal(m, FREEZE_MS)).toEqual(evaluateSelfHeal(m, FREEZE_MS));
  });
});

describe('pickReclaimTarget', () => {
  const e = (id: number, startedAt: number, isStream = false): ReclaimCandidate => ({ id, startedAt, isStream });

  test('returns null when there are no in-flight entries', () => {
    expect(pickReclaimTarget([])).toBeNull();
  });

  test('picks the OLDEST non-streaming request (the wedge culprit), sparing streams', () => {
    const target = pickReclaimTarget([
      e(1, 5_000, true), // oldest overall, but a stream → spared
      e(2, 8_000, false),
      e(3, 6_000, false), // oldest NON-stream → picked
      e(4, 9_000, false),
    ]);
    expect(target?.id).toBe(3);
  });

  test('falls back to the oldest stream only when EVERY in-flight request is a stream', () => {
    const target = pickReclaimTarget([
      e(1, 9_000, true),
      e(2, 4_000, true), // oldest → picked
      e(3, 7_000, true),
    ]);
    expect(target?.id).toBe(2);
  });

  test('a single non-streaming entry is selected', () => {
    expect(pickReclaimTarget([e(42, 1_000, false)])?.id).toBe(42);
  });

  test('does not mutate the input array', () => {
    const entries = [e(1, 3_000), e(2, 1_000), e(3, 2_000)];
    const copy = entries.map((x) => ({ ...x }));
    pickReclaimTarget(entries);
    expect(entries).toEqual(copy);
  });
});

describe('classifySlotReconcile (P-005/W3 slot-leak recurrence guard, D-001)', () => {
  test('consistent accountings → no violation (running === tracked, quiescent)', () => {
    expect(classifySlotReconcile({ running: 4, tracked: 4, wantsReclaim: false, hasReclaimTarget: true })).toBeNull();
    expect(classifySlotReconcile({ running: 0, tracked: 0, wantsReclaim: false, hasReclaimTarget: false })).toBeNull();
  });

  test('running > tracked is a NORMAL transient (a request mid body-read, before it registers) → no violation', () => {
    // The registry is a strict subset of held slots — a healthy in-flight request that has not yet
    // reached inFlightReg.set legitimately makes running exceed tracked. Not flagged on its own.
    expect(classifySlotReconcile({ running: 6, tracked: 4, wantsReclaim: false, hasReclaimTarget: true })).toBeNull();
    // Even under a healthy wedge where the valve CAN reclaim (a registered target exists), running>tracked alone is fine.
    expect(classifySlotReconcile({ running: 6, tracked: 4, wantsReclaim: true, hasReclaimTarget: true })).toBeNull();
  });

  test('tracked > running → registry>slots (structurally impossible: an entry outlived its slot)', () => {
    expect(classifySlotReconcile({ running: 3, tracked: 4, wantsReclaim: false, hasReclaimTarget: true })).toBe('registry>slots');
    // Takes precedence even when the decider also wants to reclaim.
    expect(classifySlotReconcile({ running: 3, tracked: 5, wantsReclaim: true, hasReclaimTarget: true })).toBe('registry>slots');
  });

  test('wedged with slots held but NOTHING registered to reclaim → wedged-unreclaimable (the blind-spot leak)', () => {
    // Saturated + nothing drained (wantsReclaim) + running>0 + the registry is empty → an un-registered
    // leak (e.g. a stall before the request registered) the valve is blind to; today it rides to the restart.
    expect(classifySlotReconcile({ running: 4, tracked: 0, wantsReclaim: true, hasReclaimTarget: false })).toBe('wedged-unreclaimable');
  });

  test('wedged but a reclaim target EXISTS → not a violation (the valve will reclaim normally)', () => {
    expect(classifySlotReconcile({ running: 4, tracked: 4, wantsReclaim: true, hasReclaimTarget: true })).toBeNull();
  });

  test('NOT wedged (decider idle) with an empty registry and free slots → not a violation', () => {
    // A quiet gateway (no reclaim wanted) with running>0 but nothing registered is only the normal
    // pre-registration transient — never flagged unless the wedge signal is also present.
    expect(classifySlotReconcile({ running: 2, tracked: 0, wantsReclaim: false, hasReclaimTarget: false })).toBeNull();
  });
});
