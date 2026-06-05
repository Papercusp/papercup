/**
 * Coverage for the shared relative-time formatter.
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-027/P-028.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeUpdated } from '../relative-time';

describe('formatRelativeUpdated', () => {
  const FIXED_NOW = Date.parse('2026-05-25T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for null / undefined', () => {
    expect(formatRelativeUpdated(null)).toBe('');
    expect(formatRelativeUpdated(undefined)).toBe('');
  });

  it('returns the input verbatim when not parseable (string)', () => {
    expect(formatRelativeUpdated('definitely not a date')).toBe('definitely not a date');
  });

  it('returns empty string for non-finite number input', () => {
    expect(formatRelativeUpdated(Number.NaN)).toBe('');
  });

  it('renders "today" within the last 24h', () => {
    expect(formatRelativeUpdated('2026-05-25T08:00:00Z')).toBe('today');
  });

  it('renders "yesterday" between 1d and 2d ago', () => {
    expect(formatRelativeUpdated('2026-05-24T08:00:00Z')).toBe('yesterday');
  });

  it('renders "Nd ago" between 2d and 30d', () => {
    expect(formatRelativeUpdated('2026-05-20T12:00:00Z')).toBe('5d ago');
  });

  it('falls back to YYYY-MM-DD for older dates (string input)', () => {
    expect(formatRelativeUpdated('2026-01-15T08:00:00Z')).toBe('2026-01-15');
  });

  it('falls back to YYYY-MM-DD for older dates (number input)', () => {
    const epoch = Date.parse('2026-01-15T08:00:00Z');
    expect(formatRelativeUpdated(epoch)).toBe('2026-01-15');
  });

  it('renders "in the future" for forward-dated input', () => {
    expect(formatRelativeUpdated('2027-01-01T00:00:00Z')).toBe('in the future');
  });
});
