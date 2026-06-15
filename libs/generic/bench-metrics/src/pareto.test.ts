import { describe, it, expect } from 'vitest';
import { dominates, paretoFrontier, costAccuracyFrontier, type Direction } from './pareto';

describe('dominates', () => {
  const maxmax: Direction[] = ['max', 'max'];

  it('requires ≥ on all dims and > on at least one', () => {
    expect(dominates([2, 3], [1, 3], maxmax)).toBe(true);
    expect(dominates([2, 3], [2, 3], maxmax)).toBe(false); // equal, not strictly better
    expect(dominates([2, 2], [1, 3], maxmax)).toBe(false); // worse on dim 1
  });

  it('honors per-dimension direction (accuracy max, cost min)', () => {
    const dir: Direction[] = ['max', 'min'];
    expect(dominates([0.8, 10], [0.7, 20], dir)).toBe(true); // more accurate AND cheaper
    expect(dominates([0.8, 30], [0.7, 20], dir)).toBe(false); // more accurate but dearer
    expect(dominates([0.7, 10], [0.7, 20], dir)).toBe(true); // same accuracy, cheaper
  });

  it('throws on mismatched lengths', () => {
    expect(() => dominates([1, 2], [1], maxmax)).toThrow();
  });
});

describe('paretoFrontier', () => {
  it('keeps only the non-dominated subset, order-preserving', () => {
    const items = [
      { id: 'a', vector: [2, 2] },
      { id: 'b', vector: [1, 1] }, // dominated by a
      { id: 'c', vector: [3, 1] }, // non-dominated (better on dim0)
    ];
    const f = paretoFrontier(items, ['max', 'max']).map((x) => x.id);
    expect(f).toEqual(['a', 'c']);
  });
});

describe('costAccuracyFrontier', () => {
  it('drops points dominated on (accuracy↑, cost↓)', () => {
    const points = [
      { arm: 'a', accuracy: 0.8, cost: 10 },
      { arm: 'b', accuracy: 0.7, cost: 5 }, // cheaper but less accurate — non-dominated
      { arm: 'c', accuracy: 0.6, cost: 20 }, // dominated by both a and b
    ];
    const f = costAccuracyFrontier(points).map((p) => p.arm).sort();
    expect(f).toEqual(['a', 'b']);
  });
});
