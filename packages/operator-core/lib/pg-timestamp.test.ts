import { describe, expect, it } from 'vitest';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from './pg-timestamp';

describe('pgTimestampToIso', () => {
  it('passes a Date through toISOString()', () => {
    const d = new Date('2026-07-26T07:34:43.647Z');
    expect(pgTimestampToIso(d)).toBe('2026-07-26T07:34:43.647Z');
  });

  it('treats a number as epoch millis', () => {
    expect(pgTimestampToIso(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('normalises a raw Postgres text-formatted timestamptz (EDT offset) to UTC Z', () => {
    // EI-18691099450966094: exactly the string an agent saw for taken_at.
    expect(pgTimestampToIso('2026-07-26 03:34:43.647148-04')).toBe('2026-07-26T07:34:43.647Z');
    expect(pgTimestampToIso('2026-07-26 03:19:45.516974-04')).toBe('2026-07-26T07:19:45.516Z');
  });

  it('leaves an already-UTC ISO string materially unchanged', () => {
    expect(pgTimestampToIso('2026-07-26T07:34:43.647Z')).toBe('2026-07-26T07:34:43.647Z');
  });

  it('falls back to the original string for an unparseable value rather than throwing', () => {
    expect(pgTimestampToIso('not-a-timestamp')).toBe('not-a-timestamp');
  });

  it('returns "" for null/undefined (non-nullable variant)', () => {
    expect(pgTimestampToIso(null)).toBe('');
    expect(pgTimestampToIso(undefined)).toBe('');
  });
});

describe('pgTimestampToIsoOrNull', () => {
  it('preserves null/undefined as null instead of coercing to ""', () => {
    expect(pgTimestampToIsoOrNull(null)).toBeNull();
    expect(pgTimestampToIsoOrNull(undefined)).toBeNull();
  });

  it('normalises a raw offset string like the non-null variant', () => {
    expect(pgTimestampToIsoOrNull('2026-07-26 03:34:43.647148-04')).toBe('2026-07-26T07:34:43.647Z');
  });
});
