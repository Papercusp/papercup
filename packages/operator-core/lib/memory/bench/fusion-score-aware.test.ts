/**
 * P-031 — pins the structural facts the score-aware-fusion verdict rests on.
 *
 * These are PROPERTY tests, not regression snapshots: they encode WHY the
 * evaluation was scoped the way it was, so a future "let's just weight RRF by
 * the score" proposal is met with an executable answer rather than a re-run of
 * the same 25-minute bench.
 */
import { describe, it, expect } from 'vitest';

import { rrfCombine, RRF_K_DEFAULT, type RankedItem } from '@papercusp/rrf';

import { buildArms, ramp, weightedRrf, pairedBootstrap, type Leg } from './fusion-score-aware';

/** A score-sorted list, as every `SearchSource` is required to emit. */
function leg(name: string, scores: number[], prefix = name): Leg {
  const sorted = [...scores].sort((a, b) => b - a);
  return {
    name,
    list: sorted.map((score, i): RankedItem<string> => {
      const key = `${prefix}-${i}`;
      return { key, score, row: key };
    }),
  };
}

describe('ramp', () => {
  it('clamps to [0,1] and is monotone non-decreasing', () => {
    expect(ramp(0.3, 0.45, 0.75)).toBe(0);
    expect(ramp(0.45, 0.45, 0.75)).toBe(0);
    expect(ramp(0.6, 0.45, 0.75)).toBeCloseTo(0.5, 10);
    expect(ramp(0.75, 0.45, 0.75)).toBe(1);
    expect(ramp(0.9, 0.45, 0.75)).toBe(1);
    // degenerate band never divides by zero
    expect(ramp(0.5, 0.5, 0.5)).toBe(1);
  });
});

describe('weightedRrf', () => {
  it('with a constant weight of 1, reproduces plain rrfCombine exactly', () => {
    const legs = [leg('bm25', [0.9, 0.4, 0.1]), leg('embeddings', [0.71, 0.66, 0.52])];
    const viaWeighted = weightedRrf(legs, () => 1);
    const viaProduction = rrfCombine(legs.map((l) => ({ name: l.name, list: l.list }))).map((f) => f.row);
    expect(viaWeighted).toEqual(viaProduction);
  });
});

/**
 * THE LOAD-BEARING PROPERTY.
 *
 * A monotone non-decreasing weight applied per-candidate cannot reorder a
 * ranker's candidates RELATIVE TO EACH OTHER, because the list is already
 * sorted by the score the weight consults. Verified against a single leg,
 * where "relative to each other" is the entire ordering.
 */
describe('score-awareness cannot reorder WITHIN a ranker (the P-031 premise)', () => {
  const scores = [0.755, 0.702, 0.688, 0.61, 0.55, 0.462];
  const single = [leg('embeddings', scores)];
  const rankOnly = weightedRrf(single, () => 1);

  const monotoneWeights: Array<[string, (s: number) => number]> = [
    ['identity', (s) => s],
    ['ramp .45→.75', (s) => ramp(s, 0.45, 0.75)],
    ['square', (s) => s * s],
    ['exp', (s) => Math.exp(s)],
    ['steep sigmoid', (s) => 1 / (1 + Math.exp(-40 * (s - 0.6)))],
  ];

  for (const [label, w] of monotoneWeights) {
    it(`is a no-op within one leg: ${label}`, () => {
      expect(weightedRrf(single, (_n, s) => w(s))).toEqual(rankOnly);
    });
  }

  it('holds even when a weight saturates several candidates to the same value', () => {
    // ramp .45→.50 pins everything at/above .50 to exactly 1 — ties in weight,
    // but the rank term still separates them, preserving order.
    expect(weightedRrf(single, (_n, s) => ramp(s, 0.45, 0.5))).toEqual(rankOnly);
  });

  it('CAN reorder ACROSS rankers — the one mechanism that remains', () => {
    // Same two legs, disjoint keys. Under plain RRF the two rank-1s tie and
    // insertion order decides. Weighting the embeddings leg down by its weak
    // absolute scores must let bm25's rank-1 win outright.
    const legs = [leg('bm25', [0.9, 0.5]), leg('embeddings', [0.46, 0.455])];
    const plain = weightedRrf(legs, () => 1);
    const scoreAware = weightedRrf(legs, (name, s) =>
      name === 'embeddings' ? ramp(s, 0.45, 0.75) : 1,
    );
    expect(plain).not.toEqual(scoreAware);
    expect(scoreAware[0]).toBe('bm25-0');
    // and the within-leg order of each ranker is STILL untouched
    expect(scoreAware.filter((k) => k.startsWith('bm25'))).toEqual(['bm25-0', 'bm25-1']);
    expect(scoreAware.filter((k) => k.startsWith('embeddings'))).toEqual([
      'embeddings-0',
      'embeddings-1',
    ]);
  });
});

describe('buildArms', () => {
  const legs = [leg('bm25', [0.8, 0.3, 0.05]), leg('embeddings', [0.72, 0.6, 0.47])];

  it('every arm returns a permutation of the union of the input keys', () => {
    const expected = new Set(legs.flatMap((l) => l.list.map((e) => e.key)));
    for (const arm of buildArms(0.45, 0.75)) {
      const out = arm.fuse(legs);
      if (arm.label.startsWith('R ')) continue; // single-leg references
      expect(new Set(out)).toEqual(expected);
      expect(out.length).toBe(expected.size);
    }
  });

  it('arm A is exactly the production rrfCombine', () => {
    const armA = buildArms(0.45, 0.75)[0]!;
    expect(armA.fuse(legs)).toEqual(
      rrfCombine(legs.map((l) => ({ name: l.name, list: l.list }))).map((f) => f.row),
    );
  });

  it('preserves each leg\'s internal order in every fusion arm', () => {
    for (const arm of buildArms(0.45, 0.75)) {
      if (arm.label.startsWith('R ')) continue;
      const out = arm.fuse(legs);
      for (const l of legs) {
        const want = l.list.map((e) => e.key);
        expect(out.filter((k) => want.includes(k))).toEqual(want);
      }
    }
  });

  it('uses the band it is given, not a baked-in gemma constant', () => {
    // A qwen3-shaped band (floor .36) must treat .47 as mid-range, where the
    // gemma band (floor .45) treats it as nearly worthless.
    expect(ramp(0.47, 0.45, 0.75)).toBeLessThan(0.1);
    expect(ramp(0.47, 0.36, 0.78)).toBeGreaterThan(0.2);
  });
});

describe('pairedBootstrap', () => {
  it('is deterministic across runs', () => {
    const d = [0.1, -0.2, 0.3, 0, 0.05, -0.1, 0.2];
    expect(pairedBootstrap(d, 500)).toEqual(pairedBootstrap(d, 500));
  });

  it('brackets the mean and widens with dispersion', () => {
    const tight = pairedBootstrap([0.1, 0.1, 0.1, 0.1, 0.1], 2000);
    expect(tight.mean).toBeCloseTo(0.1, 10);
    expect(tight.hi - tight.lo).toBeCloseTo(0, 6);

    const loose = pairedBootstrap([1, -1, 1, -1, 0.5, -0.5], 2000);
    expect(loose.hi - loose.lo).toBeGreaterThan(0.5);
    expect(loose.lo).toBeLessThan(loose.mean);
    expect(loose.hi).toBeGreaterThan(loose.mean);
  });

  it('an all-zero difference vector yields a zero-width interval (the IDENTICAL case)', () => {
    const z = pairedBootstrap([0, 0, 0, 0, 0, 0], 1000);
    expect(z).toEqual({ mean: 0, lo: 0, hi: 0 });
  });

  it('handles an empty input without dividing by zero', () => {
    expect(pairedBootstrap([], 100)).toEqual({ mean: 0, lo: 0, hi: 0 });
  });
});

describe('RRF_K_DEFAULT is the production constant the arms are calibrated against', () => {
  it('is 60', () => {
    expect(RRF_K_DEFAULT).toBe(60);
  });
});
