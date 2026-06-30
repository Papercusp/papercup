/**
 * Unit tests for computeEfficiencyMetrics (HE-05 / P-031). Pure arithmetic — the high-value
 * assertions are the GUARDS: divide-by-zero never yields NaN/Infinity, skip-gates return 0 instead
 * of penalizing a metric never earned, and null-vs-0 semantics (avgQueenTurns / beeAvgCarriedPerWarmInject)
 * are kept exact. Plus the D-003 metric↔failure pairings wiring.
 */
import { describe, it, expect } from 'vitest';
import { computeEfficiencyMetrics, type RunBehavior } from './efficiency-metrics';

/** A fully-zeroed valid RunBehavior; override only the fields a test exercises. */
function base(overrides: Partial<RunBehavior> = {}): RunBehavior {
  return {
    beesBusySamples: [],
    beeCap: 0,
    idleWhileReadyMs: 0,
    coordMessages: 0,
    completedItems: 0,
    beesSpawned: 0,
    uselessBees: 0,
    collisions: 0,
    rework: 0,
    lockContentionMs: 0,
    totalTokens: 0,
    costUsd: 0,
    queenCacheReadTokens: 0,
    queenCacheCreationTokens: 0,
    queenInputTokens: 0,
    queenWakes: 0,
    queenTurns: 0,
    queenWakesWithTurns: 0,
    beeCarriedReadTokens: 0,
    beeCacheReadTokens: 0,
    beeCacheCreationTokens: 0,
    beeInputTokens: 0,
    beeWarmInjects: 0,
    ...overrides,
  };
}

describe('computeEfficiencyMetrics — per-item divide guards (completedItems === 0)', () => {
  it('a run that completed NOTHING yields FINITE per-item ratios (no NaN / Infinity), using denom=1', () => {
    const m = computeEfficiencyMetrics(
      base({ completedItems: 0, coordMessages: 8, collisions: 3, rework: 5, costUsd: 4, totalTokens: 400 }),
    );
    // denom collapses to 1, so each per-item metric equals its numerator — and crucially is finite.
    for (const v of [m.communicationOverhead, m.collisionRate, m.reworkRate, m.costPerItemUsd, m.tokensPerItem]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isNaN(v)).toBe(false);
    }
    expect(m.communicationOverhead).toBe(8);
    expect(m.collisionRate).toBe(3);
    expect(m.reworkRate).toBe(5);
    expect(m.costPerItemUsd).toBe(4);
    expect(m.tokensPerItem).toBe(400);
  });

  it('completedItems > 0 divides normally (denom is NOT forced to 1)', () => {
    const m = computeEfficiencyMetrics(base({ completedItems: 4, coordMessages: 8, collisions: 2, rework: 1, costUsd: 10, totalTokens: 400 }));
    expect(m.communicationOverhead).toBe(2); // 8 / 4
    expect(m.collisionRate).toBe(0.5); // 2 / 4
    expect(m.reworkRate).toBe(0.25); // 1 / 4
    expect(m.costPerItemUsd).toBe(2.5); // 10 / 4
    expect(m.tokensPerItem).toBe(100); // 400 / 4
  });
});

describe('computeEfficiencyMetrics — parallelismUtilization guards', () => {
  it('beeCap === 0 → 0 (no divide by zero) even with busy samples present', () => {
    const m = computeEfficiencyMetrics(base({ beeCap: 0, beesBusySamples: [4, 4, 4] }));
    expect(m.parallelismUtilization).toBe(0);
  });

  it('empty beesBusySamples → 0 even with a positive cap', () => {
    const m = computeEfficiencyMetrics(base({ beeCap: 5, beesBusySamples: [] }));
    expect(m.parallelismUtilization).toBe(0);
  });

  it('normal: mean(samples) / cap', () => {
    const m = computeEfficiencyMetrics(base({ beeCap: 6, beesBusySamples: [2, 4, 3] }));
    expect(m.parallelismUtilization).toBeCloseTo(0.5, 10); // mean 3 / 6
  });
});

describe('computeEfficiencyMetrics — uselessBeeRate guard (beesSpawned === 0)', () => {
  it('beesSpawned === 0 → 0 (NOT NaN), even with uselessBees recorded', () => {
    const m = computeEfficiencyMetrics(base({ beesSpawned: 0, uselessBees: 2 }));
    expect(m.uselessBeeRate).toBe(0);
    expect(Number.isNaN(m.uselessBeeRate)).toBe(false);
  });

  it('normal: uselessBees / beesSpawned', () => {
    const m = computeEfficiencyMetrics(base({ beesSpawned: 8, uselessBees: 2 }));
    expect(m.uselessBeeRate).toBe(0.25);
  });
});

describe('computeEfficiencyMetrics — Queen cache guards (queenPromptTokens === 0)', () => {
  it('no Queen prompt tokens → cacheHitRatio 0 (NOT NaN)', () => {
    const m = computeEfficiencyMetrics(base({ queenCacheReadTokens: 0, queenCacheCreationTokens: 0, queenInputTokens: 0 }));
    expect(m.cacheHitRatio).toBe(0);
    expect(Number.isNaN(m.cacheHitRatio)).toBe(false);
  });

  it('queenWakes === 0 → tokensPerWake 0 (SKIP — not penalized), even with prompt tokens present', () => {
    const m = computeEfficiencyMetrics(base({ queenCacheReadTokens: 100, queenWakes: 0 }));
    expect(m.tokensPerWake).toBe(0);
    expect(m.queenWakes).toBe(0);
  });

  it('normal: cacheRead / (cacheRead + cacheCreation + input) and promptTokens / wakes', () => {
    const m = computeEfficiencyMetrics(
      base({ queenCacheReadTokens: 80, queenCacheCreationTokens: 10, queenInputTokens: 10, queenWakes: 5 }),
    );
    expect(m.cacheHitRatio).toBeCloseTo(0.8, 10); // 80 / 100
    expect(m.tokensPerWake).toBe(20); // 100 / 5
  });
});

describe('computeEfficiencyMetrics — avgQueenTurns null-vs-0 semantics (the load-bearing distinction)', () => {
  it('no wake reported a turn count → avgQueenTurns is null (NOT 0)', () => {
    const m = computeEfficiencyMetrics(base({ queenTurns: 0, queenWakesWithTurns: 0, queenWakes: 3 }));
    expect(m.avgQueenTurns).toBeNull();
  });

  it('the roundTrip pairing coerces a null avgQueenTurns to 0 via ?? (metric is 0, NOT null)', () => {
    const m = computeEfficiencyMetrics(base({ queenWakesWithTurns: 0 }));
    expect(m.avgQueenTurns).toBeNull();
    expect(m.pairings.roundTrip.metric).toBe(0);
  });

  it('normal: queenTurns / queenWakesWithTurns', () => {
    const m = computeEfficiencyMetrics(base({ queenTurns: 12, queenWakesWithTurns: 4 }));
    expect(m.avgQueenTurns).toBe(3);
    expect(m.pairings.roundTrip.metric).toBe(3); // non-null flows through unchanged
  });
});

describe('computeEfficiencyMetrics — bee warm-inject carry guards', () => {
  it('no bee prompt tokens → beeCarryShare 0 (NOT NaN)', () => {
    const m = computeEfficiencyMetrics(base({ beeCarriedReadTokens: 0, beeCacheReadTokens: 0, beeCacheCreationTokens: 0, beeInputTokens: 0 }));
    expect(m.beeCarryShare).toBe(0);
    expect(Number.isNaN(m.beeCarryShare)).toBe(false);
  });

  it('beeWarmInjects === 0 → beeAvgCarriedPerWarmInject is null (NOT 0)', () => {
    const m = computeEfficiencyMetrics(base({ beeWarmInjects: 0, beeCarriedReadTokens: 500 }));
    expect(m.beeAvgCarriedPerWarmInject).toBeNull();
  });

  it('normal: carriedRead / (cacheRead + cacheCreation + input) and carriedRead / warmInjects', () => {
    const m = computeEfficiencyMetrics(
      base({ beeCarriedReadTokens: 700, beeCacheReadTokens: 800, beeCacheCreationTokens: 100, beeInputTokens: 100, beeWarmInjects: 5 }),
    );
    expect(m.beeCarryShare).toBeCloseTo(0.7, 10); // 700 / 1000
    expect(m.beeAvgCarriedPerWarmInject).toBe(140); // 700 / 5
  });
});

describe('computeEfficiencyMetrics — passthrough fields', () => {
  it('idleWhileReadyMs / lockContentionMs / queenWakes / beeWarmInjects pass through verbatim', () => {
    const m = computeEfficiencyMetrics(base({ idleWhileReadyMs: 1234, lockContentionMs: 5678, queenWakes: 7, beeWarmInjects: 9 }));
    expect(m.idleWhileReadyMs).toBe(1234);
    expect(m.lockContentionMs).toBe(5678);
    expect(m.queenWakes).toBe(7);
    expect(m.beeWarmInjects).toBe(9);
  });
});

describe('computeEfficiencyMetrics — D-003 metric↔failure pairings wiring', () => {
  it('each pairing references the right metric, its paired failure, and the correct pairName', () => {
    const m = computeEfficiencyMetrics(
      base({
        beeCap: 6,
        beesBusySamples: [3, 3, 3],
        completedItems: 4,
        coordMessages: 8,
        collisions: 2,
        beesSpawned: 8,
        uselessBees: 2,
        rework: 1,
        queenCacheReadTokens: 80,
        queenCacheCreationTokens: 10,
        queenInputTokens: 10,
        queenTurns: 12,
        queenWakesWithTurns: 4,
        beeCarriedReadTokens: 700,
        beeCacheReadTokens: 800,
        beeCacheCreationTokens: 100,
        beeInputTokens: 100,
      }),
    );
    const p = m.pairings;

    expect(p.lowCommunication).toEqual({ metric: m.communicationOverhead, pairedFailure: m.collisionRate, pairName: 'collisionRate' });
    expect(p.highParallelism).toEqual({ metric: m.parallelismUtilization, pairedFailure: m.uselessBeeRate, pairName: 'uselessBeeRate' });
    expect(p.cacheEfficiency).toEqual({ metric: m.cacheHitRatio, pairedFailure: m.reworkRate, pairName: 'reworkRate' });
    expect(p.roundTrip).toEqual({ metric: m.avgQueenTurns ?? 0, pairedFailure: m.reworkRate, pairName: 'reworkRate' });
    expect(p.beeCarry).toEqual({ metric: m.beeCarryShare, pairedFailure: m.reworkRate, pairName: 'reworkRate' });

    // The three staleness-coupled wins all point at reworkRate as their guard.
    expect(p.cacheEfficiency.pairedFailure).toBe(m.reworkRate);
    expect(p.roundTrip.pairedFailure).toBe(m.reworkRate);
    expect(p.beeCarry.pairedFailure).toBe(m.reworkRate);
  });
});

describe('computeEfficiencyMetrics — one full non-degenerate run with exact derived numbers', () => {
  it('computes every metric from the source formulas', () => {
    const m = computeEfficiencyMetrics(
      base({
        beesBusySamples: [3, 3, 3],
        beeCap: 6,
        idleWhileReadyMs: 1500,
        coordMessages: 8,
        completedItems: 4,
        beesSpawned: 8,
        uselessBees: 2,
        collisions: 2,
        rework: 1,
        lockContentionMs: 4200,
        totalTokens: 400,
        costUsd: 10,
        queenCacheReadTokens: 80,
        queenCacheCreationTokens: 10,
        queenInputTokens: 10,
        queenWakes: 5,
        queenTurns: 12,
        queenWakesWithTurns: 4,
        beeCarriedReadTokens: 700,
        beeCacheReadTokens: 800,
        beeCacheCreationTokens: 100,
        beeInputTokens: 100,
        beeWarmInjects: 5,
      }),
    );
    expect(m.parallelismUtilization).toBeCloseTo(0.5, 10);
    expect(m.idleWhileReadyMs).toBe(1500);
    expect(m.communicationOverhead).toBe(2);
    expect(m.collisionRate).toBe(0.5);
    expect(m.uselessBeeRate).toBe(0.25);
    expect(m.reworkRate).toBe(0.25);
    expect(m.lockContentionMs).toBe(4200);
    expect(m.costPerItemUsd).toBe(2.5);
    expect(m.tokensPerItem).toBe(100);
    expect(m.cacheHitRatio).toBeCloseTo(0.8, 10);
    expect(m.tokensPerWake).toBe(20);
    expect(m.avgQueenTurns).toBe(3);
    expect(m.queenWakes).toBe(5);
    expect(m.beeCarryShare).toBeCloseTo(0.7, 10);
    expect(m.beeAvgCarriedPerWarmInject).toBe(140);
    expect(m.beeWarmInjects).toBe(5);
  });
});
