import { describe, it, expect } from 'vitest';
import {
  GYM_JUDGE_RUBRIC_V1,
  rubricHash,
  composite,
  parseJudgeOutput,
  type GymJudgeRubric,
} from '../judge-scoring';
import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';

/**
 * Pure scoring cores for the frozen Opus judge (P-008). The judge's composite is
 * THE reward (D-011); weights + rubric are frozen per run (D-016). rubric_hash is
 * the re-judge-from-cache key (P-010) AND must change whenever anything that would
 * change a score changes, so the circuit-breaker's absolute-aggregate comparison
 * stays valid only within one rubric.
 */
describe('rubricHash', () => {
  it('is a deterministic sha256 hex, independent of object key order', () => {
    const a = GYM_JUDGE_RUBRIC_V1;
    const b: GymJudgeRubric = {
      // same content, weights keys in a different order
      ...GYM_JUDGE_RUBRIC_V1,
      weights: { d3: a.weights.d3, d1: a.weights.d1, d2: a.weights.d2 },
    };
    expect(rubricHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(rubricHash(b)).toBe(rubricHash(a));
  });

  it('changes when the weights change', () => {
    const tweaked: GymJudgeRubric = { ...GYM_JUDGE_RUBRIC_V1, weights: { d1: 0.4, d2: 0.3, d3: 0.3 } };
    expect(rubricHash(tweaked)).not.toBe(rubricHash(GYM_JUDGE_RUBRIC_V1));
  });

  it('changes when a dimension definition changes', () => {
    const tweaked: GymJudgeRubric = {
      ...GYM_JUDGE_RUBRIC_V1,
      dimensions: { ...GYM_JUDGE_RUBRIC_V1.dimensions, d2: 'a different definition' },
    };
    expect(rubricHash(tweaked)).not.toBe(rubricHash(GYM_JUDGE_RUBRIC_V1));
  });

  it('changes when the judge model changes (model is a frozen run-param, D-016)', () => {
    const tweaked: GymJudgeRubric = { ...GYM_JUDGE_RUBRIC_V1, model: 'claude-opus-4-7' };
    expect(rubricHash(tweaked)).not.toBe(rubricHash(GYM_JUDGE_RUBRIC_V1));
  });
});

describe('GYM_JUDGE_RUBRIC_V1', () => {
  it('pins the canonical Sol xhigh judge model and a primary-weighted D1', () => {
    expect(GYM_JUDGE_RUBRIC_V1.model).toBe(LEARNING_MODEL_SPEC);
    const { d1, d2, d3 } = GYM_JUDGE_RUBRIC_V1.weights;
    expect(d1 + d2 + d3).toBeCloseTo(1, 6);
    expect(d1).toBeGreaterThan(d2); // D1 (intent & spec fidelity) is primary
    expect(d1).toBeGreaterThan(d3);
  });

  it('defines all three dimensions with non-empty text', () => {
    for (const t of Object.values(GYM_JUDGE_RUBRIC_V1.dimensions)) {
      expect(t.length).toBeGreaterThan(10);
    }
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
});
