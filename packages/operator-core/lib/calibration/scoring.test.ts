/**
 * Pure Brier + trust-weight transforms (P-041 / FB-13). These pin the exact
 * semantics every consumer (store aggregation, ranker feature,
 * calibration:summary) reads into a weight.
 */
import { describe, expect, it } from 'vitest';
import {
  badOutcomeExpectation,
  brierScore,
  calibrationWeight,
  NEUTRAL_WEIGHT,
  WEIGHT_PRIOR_N,
} from './scoring';
import { isFlakeKey } from './types';

describe('brierScore', () => {
  it('is NaN on no bets (callers treat as no-history)', () => {
    expect(brierScore([])).toBeNaN();
  });

  it('is 0 for a perfect predictor', () => {
    expect(
      brierScore([
        { probability: 1, outcome: true },
        { probability: 0, outcome: false },
      ]),
    ).toBe(0);
  });

  it('is 0.25 for constant-0.5 noise regardless of outcomes', () => {
    expect(
      brierScore([
        { probability: 0.5, outcome: true },
        { probability: 0.5, outcome: false },
      ]),
    ).toBeCloseTo(0.25, 10);
  });

  it('punishes confident wrongness hardest', () => {
    expect(brierScore([{ probability: 0.9, outcome: false }])).toBeCloseTo(0.81, 10);
  });
});

describe('calibrationWeight', () => {
  it('reads neutral with no history', () => {
    expect(calibrationWeight(Number.NaN, 0)).toBe(NEUTRAL_WEIGHT);
    expect(calibrationWeight(0.1, 0)).toBe(NEUTRAL_WEIGHT);
  });

  it('barely moves on tiny samples (shrinkage)', () => {
    // One perfect bet: (1·1 + 6·0.5) / 7
    expect(calibrationWeight(0, 1)).toBeCloseTo((1 + WEIGHT_PRIOR_N * 0.5) / (1 + WEIGHT_PRIOR_N), 10);
  });

  it('earns toward 1 with a long sharp record', () => {
    expect(calibrationWeight(0, 100)).toBeGreaterThan(0.95);
  });

  it('decays toward 0 with a long noisy record (worse than unknown)', () => {
    const noisy = calibrationWeight(0.25, 100);
    expect(noisy).toBeLessThan(NEUTRAL_WEIGHT);
    expect(noisy).toBeLessThan(0.05);
  });

  it('floors worse-than-coin-flip skill at 0 instead of going negative', () => {
    expect(calibrationWeight(0.81, 50)).toBeGreaterThanOrEqual(0);
    expect(calibrationWeight(0.81, 50)).toBeLessThan(calibrationWeight(0.25, 50) + 1e-9);
  });
});

describe('isFlakeKey (the flake-recurrence seam net)', () => {
  it('matches flake/flaky/quarantine-shaped watchdog keys', () => {
    expect(isFlakeKey('redtest:flaky-vitest:operator-core')).toBe(true);
    expect(isFlakeKey('quarantine:e2e/login.spec.ts')).toBe(true);
    expect(isFlakeKey('test-flake:gym/decide.test.ts')).toBe(true);
  });

  it('passes ordinary signal keys through untouched', () => {
    expect(isFlakeKey('negative-space:docs:missing-page')).toBe(false);
    expect(isFlakeKey('service-health:dev-api')).toBe(false);
  });
});

describe('badOutcomeExpectation', () => {
  it('reads p straight where the claim IS the bad outcome (flake-recurrence)', () => {
    expect(badOutcomeExpectation('flake-recurrence', 0.7)).toBeCloseTo(0.7);
  });

  it('reads 1−p where the claim is the good outcome (fix-survival, plan-ship, unknown)', () => {
    expect(badOutcomeExpectation('fix-survival', 0.8)).toBeCloseTo(0.2);
    expect(badOutcomeExpectation('plan-ship', 0.7)).toBeCloseTo(0.3);
    expect(badOutcomeExpectation('some-future-domain', 0.9)).toBeCloseTo(0.1);
  });

  it('clamps out-of-range probabilities', () => {
    expect(badOutcomeExpectation('fix-survival', 1.5)).toBe(0);
    expect(badOutcomeExpectation('flake-recurrence', -1)).toBe(0);
  });
});
