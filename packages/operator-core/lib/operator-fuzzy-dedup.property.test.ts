/**
 * Property-based invariants for the Levenshtein fuzzy-dedup module
 * (`operator-fuzzy-dedup.ts`). Examples in the sibling unit test cover
 * specific titles; these properties assert the algebraic laws the
 * `similarity` / `levenshtein` functions must hold over arbitrary input:
 *
 *   - symmetry:  similarity(a, b) === similarity(b, a)
 *   - identity:  similarity(a, a) === 1
 *   - bounds:    a similarity is always a real number in [0, 1]
 *   - levenshtein non-negativity + upper bound (≤ max length)
 *
 * `levenshtein` is module-private, so the distance bound is exercised
 * through the public `similarity` (sim = 1 - lev/maxLen) which is an
 * order-preserving transform — `sim ∈ [0,1]` ⇔ `lev ∈ [0, maxLen]`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { similarity } from './operator-fuzzy-dedup';

describe('operator-fuzzy-dedup (property-based)', () => {
  it('similarity is symmetric: similarity(a, b) === similarity(b, a)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(similarity(a, b)).toBe(similarity(b, a));
      }),
    );
  });

  it('similarity is reflexive (identity): similarity(a, a) === 1', () => {
    fc.assert(
      fc.property(fc.string(), (a) => {
        expect(similarity(a, a)).toBe(1);
      }),
    );
  });

  it('similarity is always a finite number within [0, 1]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = similarity(a, b);
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('levenshtein distance is non-negative and ≤ max length (via similarity ∈ [0,1])', () => {
    // similarity = 1 - lev/maxLen. The implied distance lev = (1 - sim) * maxLen
    // must be ≥ 0 (sim ≤ 1) and ≤ maxLen (sim ≥ 0). Reconstruct the bound from
    // the public surface so the law is asserted on the same maxLen the module
    // uses (normalized lengths) without reaching into the private fn.
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = similarity(a, b);
        // Empty-vs-empty short-circuits to 1; no distance to bound there.
        const reconstructedRatio = 1 - s; // lev / maxLen ∈ [0, 1]
        expect(reconstructedRatio).toBeGreaterThanOrEqual(0);
        expect(reconstructedRatio).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('an empty string is maximally dissimilar to a non-empty one (similarity 0)', () => {
    // For any non-empty b, normalize('') = '' and lev('', nb) = nb.length = maxLen,
    // so similarity is exactly 0 — but only when b survives normalization with
    // at least one alphanumeric char. Restrict the generator to such strings.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => /[a-z0-9]/i.test(s)),
        (b) => {
          expect(similarity('', b)).toBe(0);
          expect(similarity(b, '')).toBe(0);
        },
      ),
    );
  });
});
