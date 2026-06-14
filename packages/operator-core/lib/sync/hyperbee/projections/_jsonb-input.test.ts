import { describe, it, expect } from 'vitest';
import { normalizeJsonbInput } from './_jsonb-input';

describe('normalizeJsonbInput', () => {
  it('passes non-string values through unchanged (already-decoded jsonb)', () => {
    const obj = { a: 1, nested: { b: [1, 2] } };
    expect(normalizeJsonbInput(obj)).toBe(obj); // same reference, no copy
    const arr = [1, 2, 3];
    expect(normalizeJsonbInput(arr)).toBe(arr);
    expect(normalizeJsonbInput(42)).toBe(42);
    expect(normalizeJsonbInput(true)).toBe(true);
    expect(normalizeJsonbInput(null)).toBe(null);
    expect(normalizeJsonbInput(undefined)).toBe(undefined);
  });

  it('unwraps a double-encoded JSON object string back to its value', () => {
    expect(normalizeJsonbInput('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('unwraps a JSON array string', () => {
    expect(normalizeJsonbInput('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('unwraps a double-encoded JSON string scalar (the convergence case)', () => {
    // A peer that double-encoded `"hello"` federates the literal string `"hello"`;
    // parsing it back yields the canonical value so the round-trip is fixed-point.
    expect(normalizeJsonbInput('"hello"')).toBe('hello');
  });

  it('leaves a plain (non-JSON) string untouched', () => {
    expect(normalizeJsonbInput('hello world')).toBe('hello world');
  });

  it('leaves a malformed-JSON string untouched (parse throws → original)', () => {
    expect(normalizeJsonbInput('{a:1')).toBe('{a:1');
    expect(normalizeJsonbInput('not json {]')).toBe('not json {]');
  });
});
