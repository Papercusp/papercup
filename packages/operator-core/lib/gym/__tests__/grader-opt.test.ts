import { describe, it, expect } from 'vitest';
import { graderRecall, evaluateGraderCandidate } from '../grader-opt';

/**
 * Grader-optimization (P-030, importance low / Phase 6): a SEPARATE run with an
 * INVERTED objective — optimize the graders (validator/crosscheck/tester) for RECALL
 * on held-out planted defects, and NEVER fewer (a candidate must catch a superset of
 * the baseline's caught set). Pure objective; the external judge is the arbiter.
 */
describe('graderRecall', () => {
  it('is |caught ∩ planted| / |planted|', () => {
    expect(graderRecall(['a', 'b'], ['a', 'b', 'c'])).toBeCloseTo(2 / 3, 6);
    expect(graderRecall(['a', 'b', 'c'], ['a', 'b', 'c'])).toBeCloseTo(1, 6);
    expect(graderRecall([], ['a', 'b'])).toBeCloseTo(0, 6);
  });
  it('ignores caught items that were not planted', () => {
    expect(graderRecall(['a', 'z'], ['a', 'b'])).toBeCloseTo(0.5, 6);
  });
});

describe('evaluateGraderCandidate', () => {
  const planted = ['d1', 'd2', 'd3'];

  it('accepts a candidate that catches a superset of baseline AND improves recall', () => {
    const r = evaluateGraderCandidate(['d1', 'd2'], ['d1'], planted);
    expect(r.monotonic).toBe(true);
    expect(r.recall).toBeCloseTo(2 / 3, 6);
    expect(r.accept).toBe(true);
  });

  it('REJECTS a candidate that drops a defect the baseline caught (never fewer)', () => {
    const r = evaluateGraderCandidate(['d2', 'd3'], ['d1', 'd2'], planted); // misses d1
    expect(r.monotonic).toBe(false);
    expect(r.accept).toBe(false);
  });

  it('accepts an equal candidate (no regression)', () => {
    const r = evaluateGraderCandidate(['d1'], ['d1'], planted);
    expect(r.monotonic).toBe(true);
    expect(r.accept).toBe(true);
  });
});
