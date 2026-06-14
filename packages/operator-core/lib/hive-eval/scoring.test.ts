import { describe, it, expect } from 'vitest';
import {
  computeHiveScore,
  hiveScoreRubricHash,
  hiveScoreToRow,
  DEFAULT_HIVE_SCORE_RUBRIC_V1,
  type HiveScoreRubric,
} from './scoring';
import type { OutcomeMetrics } from './outcome-metrics';
import type { EfficiencyMetrics } from './efficiency-metrics';
import type { SpeedMetrics } from './speed-metrics';
import { createInMemoryHiveEvalStore } from './store';

// ── fixture builders (coherent: outcomeGatePassed mirrors the real D-002 conjunction) ──

function outcome(over: Partial<OutcomeMetrics> = {}): OutcomeMetrics {
  const acceptancePass = over.acceptancePass ?? true;
  const plantedBugCaught = over.plantedBugCaught ?? true;
  const fabrication = over.fabrication ?? { detected: false, fabricatedItems: [] };
  return {
    acceptancePass,
    plantedBugCaught,
    regressions: over.regressions ?? false,
    fabrication,
    outcomeGatePassed: acceptancePass && plantedBugCaught && !fabrication.detected,
    judge: over.judge,
  };
}

function eff(over: Partial<EfficiencyMetrics> = {}): EfficiencyMetrics {
  // Base has NO queen-wake data (queenWakes 0, avgQueenTurns null) so the two queen sub-scores are
  // SKIPPED and the axis is the original four components — existing assertions are unchanged. The
  // queen-scoring tests below opt in via eff({ queenWakes, cacheHitRatio, avgQueenTurns }).
  const base: EfficiencyMetrics = {
    parallelismUtilization: 0.9,
    idleWhileReadyMs: 0,
    communicationOverhead: 2,
    collisionRate: 0,
    uselessBeeRate: 0,
    reworkRate: 0,
    lockContentionMs: 0,
    costPerItemUsd: 1,
    tokensPerItem: 10_000,
    cacheHitRatio: 0,
    tokensPerWake: 0,
    avgQueenTurns: null,
    queenWakes: 0,
    pairings: {
      lowCommunication: { metric: 2, pairedFailure: 0, pairName: 'collisionRate' },
      highParallelism: { metric: 0.9, pairedFailure: 0, pairName: 'uselessBeeRate' },
      cacheEfficiency: { metric: 0, pairedFailure: 0, pairName: 'reworkRate' },
      roundTrip: { metric: 0, pairedFailure: 0, pairName: 'reworkRate' },
    },
  };
  return { ...base, ...over };
}

function speed(over: Partial<SpeedMetrics> = {}): SpeedMetrics {
  const base: SpeedMetrics = {
    wallClockMs: 44,
    idealWallClockMs: 40,
    criticalPathRatio: 1.1,
    criticalPath: ['w0', 'w1', 'w5'],
    mttcMs: 20,
    timeToFirstPlacementMs: 5_000,
    maxStuckMs: 0,
  };
  return { ...base, ...over };
}

const comp = (s: { components: { name: string; score: number }[] }, name: string) =>
  s.components.find((c) => c.name === name)!;

describe('computeHiveScore — the outcome GATE (D-002)', () => {
  it('a good run scores high above the gate', () => {
    const s = computeHiveScore(outcome(), eff(), speed());
    expect(s.outcomeGatePassed).toBe(true);
    expect(s.composite).toBeGreaterThan(8);
    expect(s.efficiency.score).toBeGreaterThan(8);
    expect(s.speed.score).toBeGreaterThan(8);
  });

  it('fast-but-garbage scores ZERO: perfect efficiency/speed cannot beat a failed acceptance', () => {
    const s = computeHiveScore(outcome({ acceptancePass: false }), eff(), speed());
    expect(s.outcomeGatePassed).toBe(false);
    expect(s.composite).toBe(0); // the D-002 headline
    expect(s.gateReason).toContain('acceptance failed');
    // the axes are still computed (for observability) — only CREDIT is zeroed.
    expect(s.efficiency.score).toBeGreaterThan(8);
    expect(s.speed.score).toBeGreaterThan(8);
  });

  it('a missed planted bug zeroes the score', () => {
    const s = computeHiveScore(outcome({ plantedBugCaught: false }), eff(), speed());
    expect(s.composite).toBe(0);
    expect(s.gateReason).toContain('planted bug missed');
  });

  it('a fabricated DONE zeroes the score and names the items', () => {
    const s = computeHiveScore(
      outcome({ fabrication: { detected: true, fabricatedItems: ['w3'] } }),
      eff(),
      speed(),
    );
    expect(s.composite).toBe(0);
    expect(s.gateReason).toContain('fabricated DONE');
    expect(s.gateReason).toContain('w3');
    expect(s.floor.fabricationDetected).toBe(true);
  });
});

describe('computeHiveScore — D-003 pairings (a win is discounted by its paired failure)', () => {
  it('high parallelism with useless bees earns little parallelism credit', () => {
    const clean = computeHiveScore(outcome(), eff({ uselessBeeRate: 0 }), speed());
    const gamed = computeHiveScore(outcome(), eff({ uselessBeeRate: 0.5 }), speed());
    expect(comp(clean.efficiency, 'parallelism').score).toBeGreaterThan(8);
    expect(comp(gamed.efficiency, 'parallelism').score).toBe(0); // at the ceiling → no credit
    expect(gamed.efficiency.score).toBeLessThan(clean.efficiency.score);
  });

  it('low communication achieved by NOT coordinating (high collisions) earns no comms credit', () => {
    const clean = computeHiveScore(outcome(), eff({ communicationOverhead: 1, collisionRate: 0 }), speed());
    const gamed = computeHiveScore(outcome(), eff({ communicationOverhead: 1, collisionRate: 0.5 }), speed());
    expect(comp(clean.efficiency, 'communication').score).toBeGreaterThan(8);
    expect(comp(gamed.efficiency, 'communication').score).toBe(0);
  });
});

describe('computeHiveScore — Queen per-wake efficiency is a scored metric (B-06 / P-011)', () => {
  it('SKIPS the queen sub-scores when the run has no Queen-wake data (queenWakes 0)', () => {
    const s = computeHiveScore(outcome(), eff(), speed()); // base = no queen data
    expect(s.efficiency.components.map((c) => c.name)).toEqual(['parallelism', 'communication', 'rework', 'cost']);
  });

  it('adds queenCache + queenRoundTrip components when the run carried Queen wakes', () => {
    const s = computeHiveScore(outcome(), eff({ queenWakes: 6, cacheHitRatio: 0.9, avgQueenTurns: 2 }), speed());
    expect(s.efficiency.components.map((c) => c.name)).toContain('queenCache');
    expect(s.efficiency.components.map((c) => c.name)).toContain('queenRoundTrip');
    expect(comp(s.efficiency, 'queenCache').score).toBeGreaterThan(8); // 0.9 → ~9, rework 0 → full credit
    expect(comp(s.efficiency, 'queenRoundTrip').score).toBeGreaterThan(8); // 2 turns/wake, ceiling 12
  });

  it('a low cache ratio scores low on queenCache (higher = better)', () => {
    const s = computeHiveScore(outcome(), eff({ queenWakes: 6, cacheHitRatio: 0.1, avgQueenTurns: 2 }), speed());
    expect(comp(s.efficiency, 'queenCache').score).toBeLessThan(2); // 0.1 → 1
  });

  it('many turns/wake scores low on queenRoundTrip (lower = better) — the no-brief baseline', () => {
    const briefed = computeHiveScore(outcome(), eff({ queenWakes: 6, cacheHitRatio: 0.9, avgQueenTurns: 2 }), speed());
    const unbriefed = computeHiveScore(outcome(), eff({ queenWakes: 6, cacheHitRatio: 0.9, avgQueenTurns: 12 }), speed());
    expect(comp(unbriefed.efficiency, 'queenRoundTrip').score).toBe(0); // at the ceiling → no credit
    expect(comp(briefed.efficiency, 'queenRoundTrip').score).toBeGreaterThan(
      comp(unbriefed.efficiency, 'queenRoundTrip').score,
    );
  });

  it('D-003: a high cache ratio earned by reusing STALE state (high rework) earns no queen-cache credit', () => {
    const clean = computeHiveScore(outcome(), eff({ queenWakes: 6, cacheHitRatio: 0.95, avgQueenTurns: 2, reworkRate: 0 }), speed());
    const stale = computeHiveScore(outcome(), eff({ queenWakes: 6, cacheHitRatio: 0.95, avgQueenTurns: 2, reworkRate: 2 }), speed());
    expect(comp(clean.efficiency, 'queenCache').score).toBeGreaterThan(8);
    expect(comp(stale.efficiency, 'queenCache').score).toBe(0); // rework at ceiling → credit ×0
    expect(comp(stale.efficiency, 'queenRoundTrip').score).toBe(0); // the round-trip win is also zeroed
  });

  it('scores queenCache but SKIPS queenRoundTrip when turns were never reported (avgQueenTurns null)', () => {
    const s = computeHiveScore(outcome(), eff({ queenWakes: 6, cacheHitRatio: 0.9, avgQueenTurns: null }), speed());
    const names = s.efficiency.components.map((c) => c.name);
    expect(names).toContain('queenCache');
    expect(names).not.toContain('queenRoundTrip');
  });

  it('the outcome gate still governs: queen efficiency earns nothing if the run failed acceptance', () => {
    const s = computeHiveScore(outcome({ acceptancePass: false }), eff({ queenWakes: 6, cacheHitRatio: 0.95, avgQueenTurns: 1 }), speed());
    expect(s.composite).toBe(0);
  });
});

describe('computeHiveScore — the critical-path ratio is the speed discriminator (D-004)', () => {
  it('a well-parallelized run (ratio ≈ 1) scores near 10 on criticalPath', () => {
    const s = computeHiveScore(outcome(), eff(), speed({ criticalPathRatio: 1 }));
    expect(comp(s.speed, 'criticalPathRatio').score).toBe(10);
  });

  it('a serialized run (high ratio) scores near 0 on criticalPath — even though outcome is fine', () => {
    const s = computeHiveScore(outcome(), eff(), speed({ criticalPathRatio: 3 }));
    expect(comp(s.speed, 'criticalPathRatio').score).toBe(0);
    // speed axis is pulled down hard (criticalPath is weighted 3×)
    expect(s.speed.score).toBeLessThan(4);
  });
});

describe('computeHiveScore — the deterministic floor (P-041)', () => {
  it('a regression caps the whole composite regardless of speed/efficiency', () => {
    const s = computeHiveScore(outcome({ regressions: true }), eff(), speed());
    expect(s.outcomeGatePassed).toBe(true); // regressions is NOT in the D-002 gate
    expect(s.floor.regressions).toBe(true);
    expect(s.floor.ceiling).toBe(DEFAULT_HIVE_SCORE_RUBRIC_V1.thresholds.regressionCompositeCeiling);
    expect(s.composite).toBe(3); // min(raw≈9.2, ceiling 3)
  });

  it('the LLM-judge composite is ADVISORY — it can never RAISE the score', () => {
    // a mediocre run the judge loves
    const mediocre = eff({ parallelismUtilization: 0.4, communicationOverhead: 8, costPerItemUsd: 4 });
    const withJudge = computeHiveScore(
      outcome({ judge: { composite: 10 } as OutcomeMetrics['judge'] }),
      mediocre,
      speed({ criticalPathRatio: 2 }),
    );
    expect(withJudge.judgeComposite).toBe(10); // recorded
    expect(withJudge.composite).toBeLessThan(8); // ...but the metrics-driven composite is unmoved
    // identical inputs minus the judge → identical composite (the judge contributes nothing).
    const noJudge = computeHiveScore(outcome(), mediocre, speed({ criticalPathRatio: 2 }));
    expect(withJudge.composite).toBeCloseTo(noJudge.composite, 6);
  });

  it('carries the computed critical-path ratio (never self-reported) onto the floor', () => {
    const s = computeHiveScore(outcome(), eff(), speed({ criticalPathRatio: 1.7 }));
    expect(s.floor.criticalPathRatio).toBe(1.7);
  });
});

describe('computeHiveScore — per-axis `why` (which metric drove it)', () => {
  it('names the lowest-scoring component as the axis driver', () => {
    const s = computeHiveScore(outcome(), eff({ costPerItemUsd: 5 }), speed());
    expect(s.efficiency.why).toContain('cost'); // cost at its ceiling → the driver
  });
});

describe('hiveScoreRubricHash — idempotent rubric-hash (cache key)', () => {
  it('is stable for the same rubric and order-independent', () => {
    expect(hiveScoreRubricHash(DEFAULT_HIVE_SCORE_RUBRIC_V1)).toBe(hiveScoreRubricHash(DEFAULT_HIVE_SCORE_RUBRIC_V1));
  });

  it('changes when any scoring-affecting threshold changes', () => {
    const tweaked: HiveScoreRubric = {
      ...DEFAULT_HIVE_SCORE_RUBRIC_V1,
      thresholds: { ...DEFAULT_HIVE_SCORE_RUBRIC_V1.thresholds, criticalPathRatioCeiling: 4 },
    };
    expect(hiveScoreRubricHash(tweaked)).not.toBe(hiveScoreRubricHash(DEFAULT_HIVE_SCORE_RUBRIC_V1));
  });

  it('the score carries the rubric hash + version (the score-store PK component)', () => {
    const s = computeHiveScore(outcome(), eff(), speed());
    expect(s.rubricHash).toBe(hiveScoreRubricHash(DEFAULT_HIVE_SCORE_RUBRIC_V1));
    expect(s.rubricVersion).toBe('hive-score-v2');
  });
});

describe('in-memory score store round-trip (upsertScore/getScore)', () => {
  it('records a score keyed (runId, rubricHash) and reads it back; re-score overwrites', async () => {
    const store = createInMemoryHiveEvalStore();
    const s = computeHiveScore(outcome(), eff(), speed());
    await store.upsertScore(hiveScoreToRow('run-7', s));
    const got = await store.getScore('run-7', s.rubricHash);
    expect(got?.composite).toBe(s.composite);
    // unknown (run, rubric) → null
    expect(await store.getScore('run-7', 'other-hash')).toBeNull();
    // re-score same key → single entry, overwritten
    const worse = computeHiveScore(outcome({ regressions: true }), eff(), speed());
    await store.upsertScore(hiveScoreToRow('run-7', worse));
    expect(store.scores.size).toBe(1);
    expect((await store.getScore('run-7', s.rubricHash))?.composite).toBe(3);
  });
});

describe('hiveScoreToRow — flatten for persistence', () => {
  it('promotes the headline + floor signals to columns and keeps the whole score in detail', () => {
    const s = computeHiveScore(outcome({ regressions: true }), eff(), speed());
    const row = hiveScoreToRow('run-1', s);
    expect(row.runId).toBe('run-1');
    expect(row.rubricHash).toBe(s.rubricHash);
    expect(row.composite).toBe(s.composite);
    expect(row.efficiencyScore).toBe(s.efficiency.score);
    expect(row.speedScore).toBe(s.speed.score);
    expect(row.regressions).toBe(true);
    expect(row.criticalPathRatio).toBe(s.floor.criticalPathRatio);
    expect(row.floorCeiling).toBe(s.floor.ceiling);
    expect(row.detail).toBe(s);
  });
});
