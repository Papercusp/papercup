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
});
