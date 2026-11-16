import { describe, expect, it } from 'vitest';
import { ratedCriterionGrades, type RubricCriterion } from '../../rubrics';

// Independently generated with Python hashlib.sha256 over UTF-8 compact JSON.
// Expected values remain literal: the oracle must not call the production hash helpers.
const vectors = [
  {
    name: 'original bar and method',
    barHash: 'a'.repeat(64),
    method: 'Inspect stored proof rows.',
    methodHash: '3b3ab77ca06767854688aa2e87fb4d7c0cad8ab4e7b07275481cfabc435a8c3a',
    gradeKey: '23ecc9f733732a53f9973ea8e3f078fab86ce17df0364a0e14b269917519a070',
  },
  {
    name: 'bar-only amendment',
    barHash: 'b'.repeat(64),
    method: 'Inspect stored proof rows.',
    methodHash: '3b3ab77ca06767854688aa2e87fb4d7c0cad8ab4e7b07275481cfabc435a8c3a',
    gradeKey: 'cad8a0785c556a4f254037dbbe45700ccda0307fb68390d1801d7a51bf94e7f8',
  },
  {
    name: 'method-only amendment',
    barHash: 'a'.repeat(64),
    method: 'Inspect independently stored proof rows.',
    methodHash: 'bc4ceb55d2ced8c516b5a602511efecaef51c0edb9a3b623e608bc60179fd799',
    gradeKey: 'a4731eb6a184403641cdaf4d6b0755bd34b8a83b428f9fe10a8d9585e4b26b7c',
  },
] as const;

describe('per-criterion grade key independent oracle (R-1)', () => {
  it.each(vectors)('saves the fixed grade-key vector for $name', (vector) => {
    const criterion: RubricCriterion = {
      key: 'R-1', title: 'Stored grade identity', model: 'Bind the bar and its method.',
      driftMarkers: 'Either input is ignored.', method: vector.method,
      role: 'outcome', mandatory: true, passRatings: ['healthy'], barHash: vector.barHash,
    };
    const result = ratedCriterionGrades(
      { kind: 'acceptance', criteriaHash: 'fixed-criteria', criteria: [criterion] },
      'fixed-criteria',
      { 'R-1': { rating: 'healthy', evidence: 'fixed input' } },
      new Map([['R-1', { barHash: vector.barHash, proof: [] }]]),
    );

    expect(result).toEqual({
      'R-1': {
        barHash: vector.barHash,
        methodHash: vector.methodHash,
        gradeKey: vector.gradeKey,
        proof: [],
      },
    });
  });
});
