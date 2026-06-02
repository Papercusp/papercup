import { describe, it, expect } from 'vitest';
import { meanStdDev, deriveThresholds, aggregateRepeats } from '../variance';

/**
 * Variance + threshold derivation (P-025/D-013). The system is doubly-stochastic
 * (pipeline + judge), so the accept thresholds ε/δ and a minimum repeat count are
 * DERIVED from measured judge-composite variance (at P-014), not guessed. Pure stats.
 */
describe('meanStdDev', () => {
  it('computes the sample mean + population SD', () => {
    const { mean, sd, n } = meanStdDev([2, 4, 6]);
    expect(mean).toBeCloseTo(4, 6);
    expect(sd).toBeCloseTo(Math.sqrt(((4 + 0 + 4) / 3)), 6); // popn SD = sqrt(8/3)
    expect(n).toBe(3);
  });
  it('is 0 SD for identical values and handles a single value', () => {
    expect(meanStdDev([5, 5, 5]).sd).toBeCloseTo(0, 6);
    expect(meanStdDev([7]).sd).toBe(0);
  });
  it('handles empty input', () => {
    expect(meanStdDev([])).toEqual({ mean: 0, sd: 0, n: 0 });
  });
});

describe('deriveThresholds', () => {
  it('derives ε/δ as a multiple of SD and min-n from a target standard error', () => {
    const t = deriveThresholds(0.5, { sigmaMultiple: 2, targetStandardError: 0.25 });
    expect(t.epsilon).toBeCloseTo(1.0, 6); // 2 * 0.5
    expect(t.delta).toBeCloseTo(1.0, 6);
    // minRepeats so SE = sd/sqrt(n) ≤ targetSE → n ≥ (sd/targetSE)^2 = (0.5/0.25)^2 = 4
    expect(t.minRepeats).toBe(4);
  });
  it('requires at least 1 repeat even when variance is ~0', () => {
    expect(deriveThresholds(0, { sigmaMultiple: 2, targetStandardError: 0.25 }).minRepeats).toBe(1);
  });
});

describe('aggregateRepeats', () => {
  it('summarizes per-task repeats into mean + sd', () => {
    const agg = aggregateRepeats([6, 8, 7]);
    expect(agg.mean).toBeCloseTo(7, 6);
    expect(agg.n).toBe(3);
  });
});
