import { describe, expect, it } from 'vitest';
import { measurePriorAttemptContext, type PriorAttemptMeasurementSample } from './prior-attempt-measurement';

const sample = (tokens: number, rest: Partial<PriorAttemptMeasurementSample> = {}): PriorAttemptMeasurementSample => ({
  estimatedTokens: tokens,
  serializedChars: tokens * 4,
  latencyMs: 1_000,
  omittedRecords: 0,
  authorityRefs: 2,
  expectedAuthorityRefs: 2,
  residueRefs: 1,
  expectedResidueRefs: 1,
  ...rest,
});

describe('measurePriorAttemptContext', () => {
  it('keeps the 200k member cap for the measured ~3k-token P-015 shape', () => {
    const result = measurePriorAttemptContext(
      [sample(2_500), sample(2_922, { omittedRecords: 3 }), sample(3_482)],
      { fleetMemberLimit: 200_000, inputPerMtokUsd: 1.875, cacheReadPerMtokUsd: 0.1875 },
    );
    expect(result.recommendation).toMatchObject({ action: 'keep', currentLimit: 200_000, materialThresholdTokens: 10_000 });
    expect(result.averageCompactionPressure).toBeLessThan(0.02);
    expect(result.p95CompactionPressure).toBeLessThan(0.02);
    expect(result.authorityRefFidelity).toBe(1);
    expect(result.residueRefFidelity).toBe(1);
    expect(result.truncationRate).toBeCloseTo(1 / 3);
  });

  it('maps a material average +40k payload to a commensurate +40k limit', () => {
    const result = measurePriorAttemptContext(
      [sample(38_000), sample(40_000), sample(42_000)],
      { fleetMemberLimit: 200_000, inputPerMtokUsd: 1.875, cacheReadPerMtokUsd: 0.1875 },
    );
    expect(result.recommendation).toEqual(expect.objectContaining({
      action: 'increase', increaseTokens: 40_000, proposedLimit: 240_000,
    }));
  });

  it('computes P95, latency, omission fidelity, pressure, and canonical price-table cost', () => {
    const result = measurePriorAttemptContext(
      [sample(1_000, { latencyMs: 500 }), sample(2_000, { latencyMs: 700, authorityRefs: 1 }), sample(3_000, { latencyMs: 900, residueRefs: 0 })],
      { fleetMemberLimit: 200_000, inputPerMtokUsd: 2, cacheReadPerMtokUsd: 0.2 },
    );
    expect(result).toMatchObject({ averageTokens: 2_000, p95Tokens: 3_000, averageLatencyMs: 700, p95LatencyMs: 900 });
    expect(result.authorityRefFidelity).toBeCloseTo(5 / 6);
    expect(result.residueRefFidelity).toBeCloseTo(2 / 3);
    expect(result.inputCostUsdPerClaim).toBeCloseTo(0.004);
    expect(result.cacheReadCostUsdPerClaim).toBeCloseTo(0.0004);
  });
});
