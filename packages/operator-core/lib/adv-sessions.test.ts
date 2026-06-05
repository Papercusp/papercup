import { describe, expect, it } from 'vitest';
import { toIsoTimestamp } from './adv-sessions';

describe('toIsoTimestamp', () => {
  it('passes Date objects through to ISO', () => {
    const value = new Date('2026-05-24T20:38:01.608Z');
    expect(toIsoTimestamp(value)).toBe('2026-05-24T20:38:01.608Z');
  });

  it('normalizes postgres text timestamps to ISO', () => {
    expect(toIsoTimestamp('2026-05-24 16:38:01.608162-04')).toBe('2026-05-24T20:38:01.608Z');
  });

  it('returns null for nullish values', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
  });

  it('throws on invalid timestamps', () => {
    expect(() => toIsoTimestamp('not-a-timestamp')).toThrow(/invalid timestamp/i);
  });
});
