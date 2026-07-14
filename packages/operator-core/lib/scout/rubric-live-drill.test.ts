import { describe, expect, it } from 'vitest';

import {
  evaluateBlenderDrillEvidence,
  type BlenderDrillEvidence,
} from './rubric-live-drill';

const green: BlenderDrillEvidence = {
  rubricSurfaced: true,
  cycleCompleted: true,
  routedRows: 1,
  groundedRows: 1,
  rubricGroundingCount: 1,
  gradedRows: 1,
  syntheticScorecard: true,
  syntheticRoutes: 1,
  organicMetricsUnchanged: true,
};

describe('evaluateBlenderDrillEvidence', () => {
  it('passes only the complete deployed-drill evidence bundle', () => {
    expect(evaluateBlenderDrillEvidence(green)).toEqual({ ok: true, failures: [] });
  });

  it.each([
    ['rubricSurfaced', false],
    ['cycleCompleted', false],
    ['routedRows', 0],
    ['groundedRows', 0],
    ['rubricGroundingCount', 0],
    ['gradedRows', 0],
    ['syntheticScorecard', false],
    ['syntheticRoutes', 0],
    ['organicMetricsUnchanged', false],
  ] as const)('fails closed when %s loses its green-path evidence', (field, value) => {
    const verdict = evaluateBlenderDrillEvidence({ ...green, [field]: value });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.length).toBeGreaterThanOrEqual(1);
  });
});
