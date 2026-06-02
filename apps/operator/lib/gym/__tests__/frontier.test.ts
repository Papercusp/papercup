import { describe, it, expect } from 'vitest';
import { dominates, paretoFrontier, selectChampion } from '../frontier';

/**
 * Three-tier state (P-019, D-005). The Pareto frontier over per-task-category train
 * vectors drives parent selection (so diversity isn't collapsed to one scalar); the
 * champion is the single best on the FROZEN dev-anchor. Pure selection logic.
 */
describe('dominates', () => {
  it('A dominates B when ≥ on all and > on at least one', () => {
    expect(dominates([3, 3], [2, 2])).toBe(true);
    expect(dominates([3, 2], [2, 2])).toBe(true);
  });
  it('equal vectors do not dominate (no strict improvement)', () => {
    expect(dominates([2, 2], [2, 2])).toBe(false);
  });
  it('incomparable vectors do not dominate either way', () => {
    expect(dominates([3, 1], [1, 3])).toBe(false);
    expect(dominates([1, 3], [3, 1])).toBe(false);
  });
});

describe('paretoFrontier', () => {
  it('keeps only non-dominated variants', () => {
    const items = [
      { id: 'a', vector: [3, 1] },
      { id: 'b', vector: [1, 3] },
      { id: 'c', vector: [2, 2] },
      { id: 'd', vector: [1, 1] }, // dominated by all
    ];
    const front = paretoFrontier(items).map((i) => i.id).sort();
    expect(front).toEqual(['a', 'b', 'c']); // d is dominated, a/b/c mutually incomparable
  });

  it('a strictly-better variant evicts the dominated one', () => {
    const items = [
      { id: 'old', vector: [2, 2] },
      { id: 'new', vector: [3, 3] },
    ];
    expect(paretoFrontier(items).map((i) => i.id)).toEqual(['new']);
  });
});

describe('selectChampion', () => {
  it('picks the highest dev-anchor aggregate', () => {
    expect(
      selectChampion([
        { id: 'a', devAnchorAgg: 6.0 },
        { id: 'b', devAnchorAgg: 7.5 },
        { id: 'c', devAnchorAgg: 7.0 },
      ]),
    ).toBe('b');
  });
  it('breaks ties deterministically by id', () => {
    expect(
      selectChampion([
        { id: 'z', devAnchorAgg: 7.0 },
        { id: 'a', devAnchorAgg: 7.0 },
      ]),
    ).toBe('a');
  });
  it('returns null for an empty set', () => {
    expect(selectChampion([])).toBeNull();
  });
});
