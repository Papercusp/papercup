import { describe, expect, it } from 'vitest';
import { canonicalize, JcsError } from './jcs';

describe('canonicalize (RFC 8785 JCS)', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('agrees regardless of insertion order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined object values, not null', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it('escapes control chars and quotes', () => {
    expect(canonicalize('a"b\nc')).toBe('"a\\"b\\nc"');
  });

  it('rejects bigint', () => {
    expect(() => canonicalize(1n)).toThrow(JcsError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize(NaN)).toThrow(JcsError);
    expect(() => canonicalize(Infinity)).toThrow(JcsError);
  });

  it('normalizes -0 to 0', () => {
    expect(canonicalize(-0)).toBe('0');
  });

  it('handles deeply nested structures deterministically', () => {
    const a = canonicalize({ z: { b: 2, a: 1 }, a: [{ q: 1, p: 2 }] });
    const b = canonicalize({ a: [{ p: 2, q: 1 }], z: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });
});
