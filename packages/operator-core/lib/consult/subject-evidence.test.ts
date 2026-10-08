import { describe, expect, it } from 'vitest';
import { evaluateSubjectCases, HELD_OUT_SUBJECT_CASES } from './subject-evidence.fixtures';

const perfect = (): { id: string; scores: (number | null)[] }[] => HELD_OUT_SUBJECT_CASES.map(c => ({ id: c.id,
  scores: c.passages.map(p => (c.relevant as readonly string[]).includes(p.id) ? 0.9 : 0.1) as (number | null)[] }));

describe('held-out subject measurement integrity', () => {
  it('keeps no-expert cases separate from the positive recall denominator', () => {
    const results = perfect();
    results[0].scores = [0.6, 0.9];
    results[1].scores = [0.8, 0.1];
    const { summary } = evaluateSubjectCases(results, 0.5);
    expect(summary).toEqual({ population: 5, positiveCases: 3, noExpertCases: 2,
      topChoicePrecision: 2 / 3, recallAt1: 2 / 3, falseExpertCases: 1, unavailable: 0 });
  });

  it('refuses omitted, duplicate and undeclared cases instead of shrinking the population', () => {
    expect(() => evaluateSubjectCases(perfect().slice(0, -1), 0.5)).toThrow('population-mismatch');
    const duplicate = perfect();
    duplicate[4] = duplicate[0];
    expect(() => evaluateSubjectCases(duplicate, 0.5)).toThrow('population-mismatch');
    const unknown = perfect();
    unknown[4] = { ...unknown[4], id: 'undeclared' };
    expect(() => evaluateSubjectCases(unknown, 0.5)).toThrow('population-mismatch');
  });

  it('preserves unavailable and invalid measurements as null metrics', () => {
    const results = perfect();
    results[0].scores = [null, NaN];
    const { summary } = evaluateSubjectCases(results, 0.5);
    expect(summary.unavailable).toBe(2);
    expect(summary.topChoicePrecision).toBeNull();
    expect(summary.recallAt1).toBeNull();
    results[0].scores = [2, -0.1];
    expect(evaluateSubjectCases(results, 0.5).summary.unavailable).toBe(2);
    results[0].scores = [];
    expect(() => evaluateSubjectCases(results, 0.5)).toThrow('score-shape');
  });
});
