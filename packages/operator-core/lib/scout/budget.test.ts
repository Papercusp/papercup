/**
 * budget.test.ts — Scout P-008 per-cycle budget bound (D-010).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveScoutBudget,
  checkScoutBudget,
  boundIdeatorCount,
  boundCriticsPerIdea,
  projectedCycleCostUsd,
  fitsCycleBudget,
  DEFAULT_SCOUT_BUDGET,
} from './budget';

describe('Scout budget (P-008)', () => {
  describe('resolveScoutBudget', () => {
    it('fills defaults', () => {
      expect(resolveScoutBudget()).toEqual(DEFAULT_SCOUT_BUDGET);
    });
    it('overrides + clamps invalid/negative to defaults', () => {
      expect(resolveScoutBudget({ maxCostUsd: 2.5, maxIdeators: 3 })).toEqual({
        maxCostUsd: 2.5,
        maxIdeators: 3,
        maxCriticsPerIdea: 2,
      });
      expect(resolveScoutBudget({ maxCostUsd: -1, maxIdeators: 0 })).toEqual(DEFAULT_SCOUT_BUDGET);
    });
    it('floors fractional counts', () => {
      expect(resolveScoutBudget({ maxIdeators: 5.9 }).maxIdeators).toBe(5);
    });
  });

  describe('checkScoutBudget', () => {
    it('proceeds while under the cap', () => {
      const v = checkScoutBudget(0.3, { maxCostUsd: 1 });
      expect(v.proceed).toBe(true);
      expect(v.remainingUsd).toBeCloseTo(0.7, 9);
      expect(v.fractionUsed).toBeCloseTo(0.3, 9);
      expect(v.reason).toBeUndefined();
    });
    it('exhausts at/over the cap', () => {
      expect(checkScoutBudget(1.0, { maxCostUsd: 1 })).toMatchObject({ proceed: false, reason: 'cost-exhausted', remainingUsd: 0 });
      expect(checkScoutBudget(1.5, { maxCostUsd: 1 })).toMatchObject({ proceed: false, fractionUsed: 1 });
    });
    it('treats negative spend as 0', () => {
      expect(checkScoutBudget(-5).spentUsd).toBe(0);
    });
  });

  describe('bound* clamps', () => {
    it('boundIdeatorCount clamps to [0, maxIdeators]', () => {
      expect(boundIdeatorCount(100, { maxIdeators: 6 })).toBe(6);
      expect(boundIdeatorCount(3, { maxIdeators: 6 })).toBe(3);
      expect(boundIdeatorCount(-2)).toBe(0);
    });
    it('boundCriticsPerIdea clamps', () => {
      expect(boundCriticsPerIdea(9, { maxCriticsPerIdea: 2 })).toBe(2);
    });
  });

  describe('cost projection', () => {
    it('projectedCycleCostUsd = (ideators + ideators*critics + 1 recombine) * perCall', () => {
      // 4 ideators, 2 critics each, $0.01/call → (4 + 8 + 1) * 0.01 = 0.13
      expect(projectedCycleCostUsd(4, 2, 0.01)).toBeCloseTo(0.13, 9);
    });
    it('fitsCycleBudget compares the projection to the cap', () => {
      expect(fitsCycleBudget(4, 2, 0.01, { maxCostUsd: 1 })).toBe(true);
      expect(fitsCycleBudget(40, 2, 0.05, { maxCostUsd: 1 })).toBe(false); // (40+80+1)*0.05 = 6.05 > 1
    });
  });

  describe('boundary + config edges (scout-loop-test-plan P-005)', () => {
    it('a zero/negative maxCostUsd is NOT honored — it resolves to the default cap', () => {
      // "Zero budget" cannot be configured: the only zero-remaining state is
      // spent ≥ cap. A 0 (or negative) cap silently becomes the default.
      expect(resolveScoutBudget({ maxCostUsd: 0 }).maxCostUsd).toBe(DEFAULT_SCOUT_BUDGET.maxCostUsd);
      expect(checkScoutBudget(0, { maxCostUsd: 0 }).proceed).toBe(true); // default cap applies
    });

    it('zero remaining EXACTLY at the cap: proceed false, remaining 0, fraction 1', () => {
      const v = checkScoutBudget(1, { maxCostUsd: 1 });
      expect(v).toEqual({
        proceed: false,
        reason: 'cost-exhausted',
        spentUsd: 1,
        remainingUsd: 0,
        fractionUsed: 1,
      });
    });

    it('proceeds a hair under the cap (strictly-below semantics)', () => {
      const v = checkScoutBudget(0.999999, { maxCostUsd: 1 });
      expect(v.proceed).toBe(true);
      expect(v.reason).toBeUndefined();
      expect(v.remainingUsd).toBeCloseTo(0.000001, 9);
    });

    it('boundIdeatorCount floors a fractional request before clamping', () => {
      expect(boundIdeatorCount(4.9, { maxIdeators: 6 })).toBe(4);
    });

    it('projectedCycleCostUsd still counts the recombine pass with zero ideators', () => {
      expect(projectedCycleCostUsd(0, 2, 0.05)).toBeCloseTo(0.05, 9); // (0 + 0 + 1) calls
    });

    it('a negative per-call cost projects to 0 (never a budget credit)', () => {
      expect(projectedCycleCostUsd(4, 2, -0.01)).toBe(0);
    });

    it('fitsCycleBudget includes the exact-equality boundary (projection === cap fits)', () => {
      // 4 ideators × 2 critics → 13 calls × $0.25 = $3.25 (binary-exact, no FP fuzz)
      expect(fitsCycleBudget(4, 2, 0.25, { maxCostUsd: 3.25 })).toBe(true);
      expect(fitsCycleBudget(4, 2, 0.25, { maxCostUsd: 3.2 })).toBe(false);
    });
  });
});
