import { describe, it, expect } from 'vitest';
import { selectParentQD, type QdFrontierMember } from '../qd-selection';
import { selectParent } from '../gate-engine';

/** Build a frontier member with explicit fields. */
function m(variantId: string, trainAgg: number, novelty: number): QdFrontierMember {
  return { variantId, trainAgg, novelty };
}

describe('selectParentQD', () => {
  it('returns null for an empty frontier', () => {
    expect(selectParentQD([], { noveltyWeight: 0 })).toBeNull();
    expect(selectParentQD([], { noveltyWeight: 1 })).toBeNull();
  });

  it('returns the only member regardless of weight or novelty', () => {
    const only = m('a', 7, 0.3);
    expect(selectParentQD([only], { noveltyWeight: 0 })).toBe(only);
    expect(selectParentQD([only], { noveltyWeight: 1 })).toBe(only);
  });

  describe('w = 0 (pure fitness-headroom — must match selectParent)', () => {
    it('picks the lowest trainAgg even when other members are far more novel', () => {
      const frontier = [m('a', 5, 0.9), m('b', 2, 0.1), m('c', 8, 0.5)];
      // b has the lowest trainAgg (most headroom) → selected, despite a/c being more novel.
      expect(selectParentQD(frontier, { noveltyWeight: 0 })?.variantId).toBe('b');
      expect(selectParentQD(frontier, { noveltyWeight: 0 })?.variantId).toBe(selectParent(frontier)?.variantId);
    });

    it('breaks ties on equal trainAgg by variantId ascending (like selectParent)', () => {
      const frontier = [m('b', 2, 0.9), m('a', 2, 0.0), m('c', 2, 0.5)];
      expect(selectParentQD(frontier, { noveltyWeight: 0 })?.variantId).toBe('a');
      expect(selectParentQD(frontier, { noveltyWeight: 0 })?.variantId).toBe(selectParent(frontier)?.variantId);
    });
  });

  describe('w = 1 (pure novelty search)', () => {
    it('picks the most novel member, ignoring trainAgg', () => {
      const frontier = [m('a', 1, 0.9), m('b', 99, 0.1), m('c', 2, 0.5)];
      expect(selectParentQD(frontier, { noveltyWeight: 1 })?.variantId).toBe('a');
    });

    it('breaks ties on equal novelty by variantId ascending', () => {
      const frontier = [m('b', 1, 0.4), m('a', 9, 0.4), m('c', 3, 0.4)];
      expect(selectParentQD(frontier, { noveltyWeight: 1 })?.variantId).toBe('a');
    });
  });

  describe('blend (0 < w < 1)', () => {
    it('shifts the pick from the under-served member to a novel low-fitness member as w rises', () => {
      // headroom: range = [0,10] → headroom(p)=1, headroom(r)=0.7, headroom(q)=0.
      const p = m('p', 0, 0.1);
      const q = m('q', 10, 1.0);
      const r = m('r', 3, 0.0);
      const frontier = [p, q, r];
      // w=0 → p (most headroom).
      expect(selectParentQD(frontier, { noveltyWeight: 0 })?.variantId).toBe('p');
      // w=0.7 → q: 0.3*0 + 0.7*1.0 = 0.70 beats p (0.3*1 + 0.7*0.1 = 0.37) and r (0.3*0.7 = 0.21).
      expect(selectParentQD(frontier, { noveltyWeight: 0.7 })?.variantId).toBe('q');
    });

    it('lets novelty break the choice when fitness is tied (degenerate headroom)', () => {
      // All trainAgg equal → headroom is a constant 1; the novelty term decides.
      const frontier = [m('a', 5, 0.2), m('b', 5, 0.9)];
      expect(selectParentQD(frontier, { noveltyWeight: 0 })?.variantId).toBe('a'); // tie → variantId
      expect(selectParentQD(frontier, { noveltyWeight: 0.5 })?.variantId).toBe('b'); // novelty breaks it
    });
  });

  describe('clamping', () => {
    it('clamps noveltyWeight into [0,1]', () => {
      const frontier = [m('a', 1, 0.9), m('b', 0, 0.1)];
      // w=2 clamps to 1 → pure novelty → a.
      expect(selectParentQD(frontier, { noveltyWeight: 2 })?.variantId).toBe('a');
      // w=-1 clamps to 0 → pure headroom → b (lowest trainAgg).
      expect(selectParentQD(frontier, { noveltyWeight: -1 })?.variantId).toBe('b');
    });

    it('clamps per-member novelty into [0,1] and treats NaN as 0', () => {
      const frontier = [m('a', 5, 5), m('b', 5, Number.NaN)];
      // equal trainAgg; a novelty clamps to 1, b NaN→0 → a wins at any w>0.
      expect(selectParentQD(frontier, { noveltyWeight: 1 })?.variantId).toBe('a');
    });
  });
});
