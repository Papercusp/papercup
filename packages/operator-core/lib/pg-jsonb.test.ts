import { describe, expect, it } from 'vitest';
import { coerceJson } from './pg-jsonb';

describe('coerceJson', () => {
  it('returns an already-parsed object/array as-is (prod getOrgPg auto-parses jsonb on read)', () => {
    expect(coerceJson({ a: 1 })).toEqual({ a: 1 });
    expect(coerceJson([1, 2])).toEqual([1, 2]);
  });

  it('parses a raw JSON string (the test-pool jsonb read shape — EI-607)', () => {
    expect(coerceJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
    expect(coerceJson<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns null for null/undefined', () => {
    expect(coerceJson(null)).toBeNull();
    expect(coerceJson(undefined)).toBeNull();
  });

  it('returns null for an unparseable string rather than throwing', () => {
    expect(coerceJson('not json')).toBeNull();
  });
});
