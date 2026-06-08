import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { selectParentQD, type QdFrontierMember } from './qd-selection';
import { selectParent } from './gate-engine';

/** Arbitrary frontier of members with UNIQUE variantIds, finite trainAgg, any novelty. */
const frontierArb = fc
  .uniqueArray(
    fc.record({
      variantId: fc.string({ minLength: 1, maxLength: 6 }),
      trainAgg: fc.double({ min: -1000, max: 1000, noNaN: true }),
      novelty: fc.double({ min: -2, max: 2, noNaN: true }),
    }),
    { selector: (x) => x.variantId, minLength: 1, maxLength: 12 },
  )
  .map((arr) => arr as QdFrontierMember[]);

describe('selectParentQD — properties', () => {
  it('INVARIANT: at noveltyWeight=0 it picks identically to selectParent, for ANY novelty values', () => {
    fc.assert(
      fc.property(frontierArb, (frontier) => {
        const qd = selectParentQD(frontier, { noveltyWeight: 0 })?.variantId ?? null;
        const base = selectParent(frontier)?.variantId ?? null;
        expect(qd).toBe(base);
      }),
    );
  });

  it('always returns a member of the frontier (for any weight)', () => {
    fc.assert(
      fc.property(frontierArb, fc.double({ min: 0, max: 1, noNaN: true }), (frontier, w) => {
        const pick = selectParentQD(frontier, { noveltyWeight: w });
        expect(pick).not.toBeNull();
        expect(frontier.some((mem) => mem.variantId === pick!.variantId)).toBe(true);
      }),
    );
  });

  it('is order-independent: shuffling the frontier yields the same winner', () => {
    fc.assert(
      fc.property(frontierArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.array(fc.nat()), (frontier, w, perm) => {
        // Derive a deterministic shuffle from the `perm` seed array.
        const shuffled = [...frontier]
          .map((value, i) => ({ value, key: perm[i % Math.max(perm.length, 1)] ?? i }))
          .sort((a, b) => a.key - b.key)
          .map((x) => x.value);
        const a = selectParentQD(frontier, { noveltyWeight: w })?.variantId;
        const b = selectParentQD(shuffled, { noveltyWeight: w })?.variantId;
        expect(a).toBe(b);
      }),
    );
  });
});
