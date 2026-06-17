/**
 * Pure scoring cores for the frozen LLM judge. Ported from the gym (source moved into
 * the shared eval-battery engine, reconciliation D-001). `rubricHash` is the
 * re-judge-from-cache key AND must change whenever anything that would change a score
 * changes, so an absolute-aggregate comparison stays valid only within one rubric.
 */
import { describe, it, expect } from 'vitest';
import { rubricHash, composite, parseJudgeOutput, type BatteryRubric } from './scoring';

const TEST_RUBRIC: BatteryRubric = {
  version: 'v1',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 32_000,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: {
    d1: 'Intent & spec fidelity (PRIMARY): did the work achieve the high-level intent.',
    d2: 'Code quality (subjective): clarity, minimality, convention-fit.',
    d3: 'Process correctness: did each role behave well.',
  },
};

describe('rubricHash', () => {
  it('is a deterministic sha256 hex, independent of object key order', () => {
    const a = TEST_RUBRIC;
    const b: BatteryRubric = {
      ...TEST_RUBRIC,
      weights: { d3: a.weights.d3, d1: a.weights.d1, d2: a.weights.d2 },
    };
    expect(rubricHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(rubricHash(b)).toBe(rubricHash(a));
  });

  it('changes when the weights change', () => {
    const tweaked: BatteryRubric = { ...TEST_RUBRIC, weights: { d1: 0.4, d2: 0.3, d3: 0.3 } };
    expect(rubricHash(tweaked)).not.toBe(rubricHash(TEST_RUBRIC));
  });

  it('changes when a dimension definition changes', () => {
    const tweaked: BatteryRubric = {
      ...TEST_RUBRIC,
      dimensions: { ...TEST_RUBRIC.dimensions, d2: 'a different definition' },
    };
    expect(rubricHash(tweaked)).not.toBe(rubricHash(TEST_RUBRIC));
  });

  it('changes when the judge model changes (model is a frozen run-param)', () => {
    const tweaked: BatteryRubric = { ...TEST_RUBRIC, model: 'claude-opus-4-7' };
    expect(rubricHash(tweaked)).not.toBe(rubricHash(TEST_RUBRIC));
  });
});

describe('composite (the reward)', () => {
  it('is the weight-normalized aggregate of the three dimensions', () => {
    expect(composite({ d1: 8, d2: 6, d3: 4 }, { d1: 0.5, d2: 0.25, d3: 0.25 })).toBeCloseTo(6.5, 6);
  });

  it('normalizes by the weight sum (un-normalized weights give the same result)', () => {
    expect(composite({ d1: 8, d2: 6, d3: 4 }, { d1: 2, d2: 1, d3: 1 })).toBeCloseTo(6.5, 6);
  });

  it('returns the common value when all dimensions are equal, regardless of weights', () => {
    expect(composite({ d1: 7, d2: 7, d3: 7 }, { d1: 0.1, d2: 0.8, d3: 0.1 })).toBeCloseTo(7, 6);
  });

  it('throws when weights do not sum to a positive number', () => {
    expect(() => composite({ d1: 1, d2: 1, d3: 1 }, { d1: 0, d2: 0, d3: 0 })).toThrow();
  });

  // --- Gap 11 (FIXED): negative weights break the convex-combination invariant ---
  // A reward weight is never negative. Before the fix, mixed-sign weights whose
  // sum is positive slipped past the `sum <= 0` guard and produced an
  // out-of-[0,10] reward, silently corrupting the optimization signal.
  it('throws when any weight is negative (the would-be-16.67 out-of-range case)', () => {
    // {5,-1,-1} sums to 3 (> 0, so the old guard passed) but yields 50/3 ≈ 16.67.
    expect(() => composite({ d1: 10, d2: 0, d3: 0 }, { d1: 5, d2: -1, d3: -1 })).toThrow(
      /weights must be non-negative/,
    );
  });

  it('throws on a single negative weight even when the others dominate', () => {
    expect(() => composite({ d1: 5, d2: 5, d3: 5 }, { d1: 1, d2: 1, d3: -0.5 })).toThrow(
      /non-negative/,
    );
  });

  it('still accepts a zero weight as long as another is positive (boundary)', () => {
    // 0 is a valid weight (drops a dimension); only < 0 is rejected.
    expect(composite({ d1: 8, d2: 2, d3: 99 }, { d1: 1, d2: 1, d3: 0 })).toBeCloseTo(5, 6);
  });

  it('keeps every non-negative-weight result inside [0, 10] (convexity holds)', () => {
    // Extremes: all-min and all-max stay at the dimension bounds.
    expect(composite({ d1: 0, d2: 0, d3: 0 }, { d1: 0.5, d2: 0.25, d3: 0.25 })).toBe(0);
    expect(composite({ d1: 10, d2: 10, d3: 10 }, { d1: 3, d2: 1, d3: 6 })).toBeCloseTo(10, 6);
  });
});

describe('parseJudgeOutput', () => {
  it('parses a valid {d1,d2,d3,rationale} object', () => {
    expect(parseJudgeOutput({ d1: 8, d2: 7.5, d3: 9, rationale: 'good' })).toEqual({
      d1: 8,
      d2: 7.5,
      d3: 9,
      rationale: 'good',
    });
  });

  it('clamps scores into [0,10]', () => {
    const p = parseJudgeOutput({ d1: 12, d2: -3, d3: 5, rationale: 'x' });
    expect(p.d1).toBe(10);
    expect(p.d2).toBe(0);
  });

  it('throws when a dimension is missing or non-numeric', () => {
    expect(() => parseJudgeOutput({ d1: 8, d2: 7, rationale: 'x' })).toThrow();
    expect(() => parseJudgeOutput({ d1: 8, d2: 'high', d3: 5, rationale: 'x' })).toThrow();
  });

  it('throws when the rationale is missing (the proposer reflects on it)', () => {
    expect(() => parseJudgeOutput({ d1: 8, d2: 7, d3: 5 })).toThrow();
  });

  it('throws on non-object input', () => {
    expect(() => parseJudgeOutput(null)).toThrow();
    expect(() => parseJudgeOutput('not json')).toThrow();
  });

  // --- Gap 12 (FIXED): reject non-finite scores, not just NaN ---
  // Before the fix only NaN was caught; ±Infinity slipped through and
  // clampScore turned it into a silent perfect (10) / zero (0) score.
  it('throws on a +Infinity dimension (would silently clamp to a perfect 10)', () => {
    expect(() => parseJudgeOutput({ d1: Infinity, d2: 5, d3: 5, rationale: 'x' })).toThrow(
      /must be a finite number/,
    );
  });

  it('throws on a -Infinity dimension (would silently clamp to a zero 0)', () => {
    expect(() => parseJudgeOutput({ d1: 5, d2: -Infinity, d3: 5, rationale: 'x' })).toThrow(
      /must be a finite number/,
    );
  });

  it('still throws on NaN (the original guard) and reports the offending field', () => {
    expect(() => parseJudgeOutput({ d1: NaN, d2: 5, d3: 5, rationale: 'x' })).toThrow(/"d1"/);
  });

  it('still accepts ordinary finite scores after the finiteness tightening', () => {
    expect(parseJudgeOutput({ d1: 0, d2: 10, d3: 5.5, rationale: 'ok' })).toEqual({
      d1: 0,
      d2: 10,
      d3: 5.5,
      rationale: 'ok',
    });
  });
});
