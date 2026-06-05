/**
 * Algorithm-conformance tests for the fan-out expander (list → N outputs) +
 * the deterministic-id hash.
 */
import { describe, it, expect } from 'vitest';
import { shortHash, expandFanout, FanoutCapError } from './index';

describe('shortHash', () => {
  it('is deterministic + url-safe (7 base-36 chars)', () => {
    expect(shortHash('a:b:c')).toBe(shortHash('a:b:c'));
    expect(shortHash('a:b:c')).toMatch(/^[a-z0-9]{7}$/);
  });
  it('different inputs → different hashes', () => {
    expect(shortHash('a')).not.toBe(shortHash('b'));
  });
});

describe('expandFanout', () => {
  it('maps each item through the builder', () => {
    expect(expandFanout(['a', 'b'], (item) => ({ name: item }))).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('trims + dedupes + drops empties before building', () => {
    expect(expandFanout([' a ', 'a', 'b', ''], (item) => item)).toEqual(['a', 'b']);
  });

  it('throws FanoutCapError over the cap (never truncates)', () => {
    const many = Array.from({ length: 5 }, (_, i) => `i-${i}`);
    expect(() => expandFanout(many, (i) => i, { cap: 3 })).toThrow(FanoutCapError);
    // exactly at the cap is allowed
    expect(expandFanout(many.slice(0, 3), (i) => i, { cap: 3 })).toHaveLength(3);
  });

  it('builds deterministic ids when the builder uses shortHash', () => {
    const build = (item: string) => `ID-${shortHash(`p:w:${item}`)}`;
    expect(expandFanout(['x'], build)).toEqual(expandFanout(['x'], build));
    expect(expandFanout(['x'], build)[0]).toMatch(/^ID-[a-z0-9]{7}$/);
  });
});
