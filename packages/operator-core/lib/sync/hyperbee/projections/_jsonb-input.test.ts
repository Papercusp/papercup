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

  it('unwraps JSON-encoded FALSY scalars to their real values (the un-converged-truthy-string bug-guard)', () => {
    // The bug these guard: a `try { return JSON.parse(v) || v }` that fell back to
    // the original string on ANY falsy parse would leave `false`→`"false"`,
    // `0`→`"0"`, `null`→`"null"` — every fallback truthy, every round-trip
    // un-converged. The unconditional `return JSON.parse(v)` (no `|| v`) preserves
    // the falsy value so the fixed-point holds for falsy scalars too.
    //
    // NOTE on quoting: the ARGUMENT is the JS source — `'false'` is the 5-char
    // JSON token `false` (→ boolean), whereas `'"false"'` is a quoted JSON STRING
    // literal `"false"` (→ the string "false"). The genuine falsy scalars are the
    // bare tokens; the quoted forms are strings and stay strings (asserted too so
    // the distinction is pinned).
    const falseTok = normalizeJsonbInput('false');
    expect(falseTok).toBe(false);
    expect(typeof falseTok).toBe('boolean');

    const zeroTok = normalizeJsonbInput('0');
    expect(zeroTok).toBe(0);
    expect(typeof zeroTok).toBe('number');

    const nullTok = normalizeJsonbInput('null');
    expect(nullTok).toBe(null);
    expect(typeof nullTok).toBe('object'); // typeof null === 'object'

    // Quoted falsy-looking forms are JSON strings — they round-trip to strings,
    // NOT to the boolean/number/null they resemble.
    expect(normalizeJsonbInput('"false"')).toBe('false');
    expect(typeof normalizeJsonbInput('"false"')).toBe('string');
    expect(normalizeJsonbInput('"0"')).toBe('0');
    expect(normalizeJsonbInput('"null"')).toBe('null');
  });

  it('leaves a plain (non-JSON) string untouched', () => {
    expect(normalizeJsonbInput('hello world')).toBe('hello world');
  });

  it('leaves a malformed-JSON string untouched (parse throws → original)', () => {
    expect(normalizeJsonbInput('{a:1')).toBe('{a:1');
    expect(normalizeJsonbInput('not json {]')).toBe('not json {]');
  });
});
