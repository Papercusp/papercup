/**
 * Property-based tests for the RFC 8785 JCS canonicalizer.
 *
 * Per testing-spec §1.12: JCS is one of the named property-test sites
 * (cross-runtime hash agreement is load-bearing — Worker and Node must
 * produce byte-identical canonical output for the manifest sha256 to
 * match across the publish-auth boundary).
 *
 * Example tests in jcs.test.ts cover documented edge cases. These
 * properties cover the *space* of inputs we never enumerate by hand.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, JcsError } from './jcs';

// JSON-shaped arbitrary: never produces values JCS rejects (bigint,
// non-finite numbers, undefined-as-value). Recursive depth is bounded
// to keep individual runs fast.
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    // No NaN/Infinity (JCS rejects), no -0 (handled separately below).
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => Number.isFinite(n)),
    fc.integer(),
    fc.string(),
    tie('array'),
    tie('object'),
  ),
  array: fc.array(tie('value'), { maxLength: 8 }),
  object: fc.dictionary(fc.string(), tie('value'), { maxKeys: 8 }),
})).value;

describe('canonicalize — properties', () => {
  it('is idempotent over a JSON round-trip', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const c1 = canonicalize(v);
        // Round-tripping through parse → canonicalize must converge.
        const c2 = canonicalize(JSON.parse(c1));
        expect(c2).toBe(c1);
      }),
      { numRuns: 200 },
    );
  });

  it('output is parseable JSON that re-canonicalizes to itself', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const out = canonicalize(v);
        // Must not throw.
        const parsed = JSON.parse(out);
        expect(canonicalize(parsed)).toBe(out);
      }),
      { numRuns: 200 },
    );
  });

  it('object key order is irrelevant — permuted keys yield identical output', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), jsonValue, { minKeys: 2, maxKeys: 8 }),
        (obj) => {
          const a = canonicalize(obj);
          // Build a second object by re-inserting keys in reverse order.
          // Use defineProperty (not bracket-assign) so keys like "__proto__"
          // become own-properties instead of triggering the prototype setter.
          // Object.create(null) keeps the prototype chain irrelevant.
          const reversed: Record<string, unknown> = Object.create(null);
          for (const k of Object.keys(obj).reverse()) {
            Object.defineProperty(reversed, k, {
              value: obj[k],
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
          const b = canonicalize(reversed);
          expect(b).toBe(a);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('emits no whitespace outside string literals', () => {
    // RFC 8785: no insignificant whitespace. The only spaces, tabs,
    // newlines, etc. that may appear in the output are inside JSON
    // string literals. Strip those, then assert the rest is whitespace-free.
    fc.assert(
      fc.property(jsonValue, (v) => {
        const out = canonicalize(v);
        // Remove every "..." span. JCS escapes embedded quotes (\") so
        // a non-greedy match between unescaped quotes is sufficient.
        const stripped = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        expect(stripped).toMatch(/^[^\s]*$/);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects bigint at any depth', () => {
    fc.assert(
      fc.property(fc.bigInt(), (n) => {
        // Top-level bigint
        expect(() => canonicalize(n)).toThrow(JcsError);
        // Nested in an object
        expect(() => canonicalize({ x: n })).toThrow(JcsError);
        // Nested in an array
        expect(() => canonicalize([0, n, 'tail'])).toThrow(JcsError);
      }),
      { numRuns: 50 },
    );
  });

  it('rejects non-finite numbers at any depth', () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(() => canonicalize(n)).toThrow(JcsError);
      expect(() => canonicalize({ a: n })).toThrow(JcsError);
      expect(() => canonicalize([n])).toThrow(JcsError);
    }
  });
});
