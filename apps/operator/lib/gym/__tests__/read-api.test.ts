import { describe, it, expect } from 'vitest';
import { buildVariantVectors, frontierFromVectors, variantLineage, type ScoredTrainRow } from '../read-api';

/**
 * Comparison read API (P-013) pure cores: turn scored train runs into per-variant
 * vectors (aligned across the train task set) and compute the Pareto frontier over
 * them. The SQL readers (gym PG) + the cycle/real-anchor/monitor surfacing are thin
 * glue on top. (Reads the GYM PG controller-side, not the live operator.)
 */
describe('buildVariantVectors', () => {
  const rows: ScoredTrainRow[] = [
    { variantId: 'A', taskId: 't1', composite: 6 },
    { variantId: 'A', taskId: 't2', composite: 8 },
    { variantId: 'B', taskId: 't1', composite: 7 },
    { variantId: 'B', taskId: 't2', composite: 7 },
  ];

  it('builds vectors aligned on the sorted task set, with the train aggregate', () => {
    const v = buildVariantVectors(rows);
    const byId = Object.fromEntries(v.map((x) => [x.variantId, x]));
    expect(byId.A.vector).toEqual([6, 8]); // [t1, t2]
    expect(byId.A.trainAgg).toBeCloseTo(7, 6);
    expect(byId.B.vector).toEqual([7, 7]);
    expect(byId.B.trainAgg).toBeCloseTo(7, 6);
  });

  it('fills a missing (variant, task) score with 0 to keep vectors aligned', () => {
    const v = buildVariantVectors([
      { variantId: 'A', taskId: 't1', composite: 5 },
      { variantId: 'B', taskId: 't1', composite: 5 },
      { variantId: 'B', taskId: 't2', composite: 9 },
    ]);
    const a = v.find((x) => x.variantId === 'A')!;
    expect(a.vector).toEqual([5, 0]); // A has no t2 → 0
    // trainAgg averages only present scores (A: just t1=5)
    expect(a.trainAgg).toBeCloseTo(5, 6);
  });
});

describe('frontierFromVectors', () => {
  it('returns the non-dominated variant ids', () => {
    const front = frontierFromVectors([
      { variantId: 'A', vector: [3, 1], trainAgg: 2 },
      { variantId: 'B', vector: [1, 3], trainAgg: 2 },
      { variantId: 'C', vector: [2, 2], trainAgg: 2 },
      { variantId: 'D', vector: [1, 1], trainAgg: 1 }, // dominated
    ]).sort();
    expect(front).toEqual(['A', 'B', 'C']);
  });

  it('keeps a strictly-better variant alone', () => {
    expect(
      frontierFromVectors([
        { variantId: 'old', vector: [2, 2], trainAgg: 2 },
        { variantId: 'new', vector: [3, 3], trainAgg: 3 },
      ]),
    ).toEqual(['new']);
  });
});

describe('variantLineage (P-016)', () => {
  const variants = [
    { variantId: 'base', parentId: null },
    { variantId: 'c1', parentId: 'base' },
    { variantId: 'c2', parentId: 'c1' },
  ];
  it('walks the ancestor chain self→root', () => {
    expect(variantLineage(variants, 'c2')).toEqual(['c2', 'c1', 'base']);
    expect(variantLineage(variants, 'base')).toEqual(['base']);
  });
  it('is cycle-safe', () => {
    const cyclic = [{ variantId: 'a', parentId: 'b' }, { variantId: 'b', parentId: 'a' }];
    expect(variantLineage(cyclic, 'a')).toEqual(['a', 'b']);
  });
});
