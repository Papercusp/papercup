import { describe, it, expect } from 'vitest';
import { computeSpeedMetrics, type RunTimings } from './speed-metrics';
import { computeEfficiencyMetrics, type RunBehavior } from './efficiency-metrics';
import { getScenario } from './scenarios';

const wide = getScenario('wide-fanout')!; // w0 → {w1,w2,w3,w4} → w5

// Measured per-item durations: base 10, each feat 20, aggregate 10. The critical path is
// w0 → (any one feat) → w5 = 10 + 20 + 10 = 40ms. Sum of all = 100ms.
const durations: Record<string, number> = { w0: 10, w1: 20, w2: 20, w3: 20, w4: 20, w5: 10 };

const timings = (wallClockMs: number): RunTimings => ({
  wallClockMs,
  perItemDurationMs: durations,
  timeToFirstPlacementMs: 5,
  maxStuckMs: 0,
});

describe('computeSpeedMetrics — the critical-path ratio (D-004)', () => {
  it('computes the ideal wall-clock as the measured critical path, not the total', () => {
    const m = computeSpeedMetrics(wide, timings(40));
    expect(m.idealWallClockMs).toBe(40); // w0→feat→w5, NOT the 100ms total
    expect(m.criticalPath).toEqual(['w0', 'w1', 'w5']);
    expect(m.mttcMs).toBeCloseTo(100 / 6, 5);
  });

  it('a well-parallelized run scores ratio ≈ 1 (slow only as deep as the critical path)', () => {
    const m = computeSpeedMetrics(wide, timings(44));
    expect(m.criticalPathRatio).toBeCloseTo(1.1, 5); // 44 / 40
  });

  it('a SERIALIZED run on the SAME scenario scores a high ratio (the discriminator)', () => {
    const m = computeSpeedMetrics(wide, timings(100)); // ran the 4 feats one-after-another
    expect(m.criticalPathRatio).toBeCloseTo(2.5, 5); // 100 / 40 — bad: failed to parallelize
    // same scenario, same per-item durations — only the orchestration differs.
    expect(m.idealWallClockMs).toBe(40);
  });

  it('a deep-dependency scenario that is genuinely deep keeps ratio ≈ 1 even when slow', () => {
    const deep = getScenario('deep-chain')!; // w1→w2→w3→w4→w5 (+ branch w6 off w2)
    const deepDur: Record<string, number> = { w1: 30, w2: 30, w3: 30, w4: 30, w5: 30, w6: 5 };
    const ideal = 150; // the 5-deep chain
    const m = computeSpeedMetrics(deep, { wallClockMs: 155, perItemDurationMs: deepDur, timeToFirstPlacementMs: 2, maxStuckMs: 0 });
    expect(m.idealWallClockMs).toBe(ideal);
    expect(m.criticalPathRatio).toBeCloseTo(155 / 150, 5); // ≈1.03 — slow because DEEP, not serialized
  });
});

describe('computeEfficiencyMetrics — each metric paired with its failure-mode (D-003)', () => {
  const base: RunBehavior = {
    beesBusySamples: [4, 4, 4, 2],
    beeCap: 4,
    idleWhileReadyMs: 1200,
    coordMessages: 12,
    completedItems: 6,
    beesSpawned: 4,
    uselessBees: 1,
    collisions: 0,
    rework: 1,
    lockContentionMs: 300,
    totalTokens: 60_000,
    costUsd: 3,
  };

  it('computes parallelism utilization as mean-busy ÷ cap', () => {
    const m = computeEfficiencyMetrics(base);
    expect(m.parallelismUtilization).toBeCloseTo(3.5 / 4, 5); // (4+4+4+2)/4 / 4
  });

  it('pairs low-communication with collision rate (low comms only good if collisions low)', () => {
    const m = computeEfficiencyMetrics(base);
    expect(m.communicationOverhead).toBeCloseTo(2, 5); // 12 / 6
    expect(m.collisionRate).toBe(0);
    expect(m.pairings.lowCommunication).toEqual({ metric: 2, pairedFailure: 0, pairName: 'collisionRate' });
  });

  it('pairs high-parallelism with useless-bee rate (parallelism only good if bees do work)', () => {
    const m = computeEfficiencyMetrics(base);
    expect(m.uselessBeeRate).toBeCloseTo(0.25, 5); // 1 / 4
    expect(m.pairings.highParallelism).toEqual({ metric: m.parallelismUtilization, pairedFailure: 0.25, pairName: 'uselessBeeRate' });
  });

  it('catches the gaming move: silent non-coordination shows low comms BUT high collisions', () => {
    const gamed = { ...base, coordMessages: 1, collisions: 5 };
    const m = computeEfficiencyMetrics(gamed);
    expect(m.communicationOverhead).toBeLessThan(0.2); // looks "efficient"
    expect(m.collisionRate).toBeGreaterThan(0.8); // ...but the pair exposes the collisions
  });

  it('computes per-item cost + tokens', () => {
    const m = computeEfficiencyMetrics(base);
    expect(m.costPerItemUsd).toBeCloseTo(0.5, 5); // 3 / 6
    expect(m.tokensPerItem).toBeCloseTo(10_000, 5); // 60000 / 6
  });

  it('guards divide-by-zero for a run that completed nothing (no NaN/Infinity)', () => {
    const m = computeEfficiencyMetrics({ ...base, completedItems: 0 });
    expect(Number.isFinite(m.communicationOverhead)).toBe(true);
    expect(Number.isFinite(m.costPerItemUsd)).toBe(true);
  });
});
