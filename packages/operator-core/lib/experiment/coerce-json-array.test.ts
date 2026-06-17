import { describe, it, expect } from 'vitest';
import { coerceJsonArray } from './ledger';

// G11 (test-coverage-gap): ledger.integration.test.ts exercises coerceJsonArray
// only on a real jsonb array (the pg client parses it to a JS array). But the
// helper exists precisely BECAUSE some clients return the raw JSON *string* —
// that string-parse branch, the malformed-string catch, and the non-array-JSON
// fallback are the paths a bug would hide in (the integration client never hits
// them, so the read silently returns [] on a real deployment while CI stays
// green). These pure cases pin every branch.

describe('coerceJsonArray', () => {
  it('returns an already-parsed array unchanged', () => {
    const arr = [{ id: 'a' }, { id: 'b' }];
    expect(coerceJsonArray(arr)).toBe(arr); // same reference, not a copy
  });

  it('parses a JSON-string array (the raw-jsonb-string client path)', () => {
    expect(coerceJsonArray('[{"id":"a"}]')).toEqual([{ id: 'a' }]);
  });

  it('returns [] for an empty-array string', () => {
    expect(coerceJsonArray('[]')).toEqual([]);
  });

  it('returns [] for a malformed JSON string (catch branch)', () => {
    expect(coerceJsonArray('not json')).toEqual([]);
    expect(coerceJsonArray('[unterminated')).toEqual([]);
  });

  it('returns [] for valid JSON that is NOT an array', () => {
    expect(coerceJsonArray('{"k":1}')).toEqual([]); // object, not array
    expect(coerceJsonArray('42')).toEqual([]); // number literal
    expect(coerceJsonArray('"a string"')).toEqual([]);
  });

  it('returns [] for non-string non-array inputs', () => {
    expect(coerceJsonArray(null)).toEqual([]);
    expect(coerceJsonArray(undefined)).toEqual([]);
    expect(coerceJsonArray(42)).toEqual([]);
    expect(coerceJsonArray({ projects: [] })).toEqual([]);
  });
});
