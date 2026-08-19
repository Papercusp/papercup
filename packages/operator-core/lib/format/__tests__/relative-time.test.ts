/**
 * Coverage for the shared relative-time formatter.
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-027/P-028.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatAbsoluteUpdated,
  formatElapsedSince,
  formatRelativeUpdated,
  formatTimeLeft,
} from '../relative-time';

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

/**
 * `formatAbsoluteUpdated` — the precise sibling added for
 * `hud-session-launcher-and-board-tabs-2026-07-26` P-007.
 *
 * Pinned to UTC: the formatter renders in LOCAL time on purpose (that is what
 * a human wants to read), so without pinning, these assertions would pass or
 * fail depending on the machine's timezone. Node re-reads process.env.TZ, so
 * setting it here is enough.
 */
describe('formatAbsoluteUpdated', () => {
  const REAL_TZ = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'UTC';
  });
  afterEach(() => {
    process.env.TZ = REAL_TZ;
  });

  it('renders a full date and to-the-minute time', () => {
    expect(formatAbsoluteUpdated('2026-07-26T14:03:09Z')).toBe('26 Jul 2026, 14:03');
  });

  it('zero-pads hours and minutes but not the day', () => {
    expect(formatAbsoluteUpdated('2026-01-05T09:07:00Z')).toBe('5 Jan 2026, 09:07');
  });

  it('accepts epoch milliseconds as well as ISO strings', () => {
    expect(formatAbsoluteUpdated(Date.parse('2026-12-31T23:59:00Z'))).toBe('31 Dec 2026, 23:59');
  });

  it('distinguishes two timestamps that formatRelativeUpdated both call "today"', () => {
    // This IS the information loss P-007 fixes: the relative form collapses
    // everything inside 24h, so a plan touched minutes ago and one touched 23
    // hours ago read identically in the dropdown.
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-07-26T23:00:00Z'));
    const justNow = '2026-07-26T22:55:00Z';
    const nearlyADayAgo = '2026-07-26T00:30:00Z';
    expect(formatRelativeUpdated(justNow)).toBe('today');
    expect(formatRelativeUpdated(nearlyADayAgo)).toBe('today');
    expect(formatAbsoluteUpdated(justNow)).not.toBe(formatAbsoluteUpdated(nearlyADayAgo));
    vi.useRealTimers();
  });

  it('returns empty / verbatim for the same edge cases as its sibling', () => {
    expect(formatAbsoluteUpdated(null)).toBe('');
    expect(formatAbsoluteUpdated(undefined)).toBe('');
    expect(formatAbsoluteUpdated('definitely not a date')).toBe('definitely not a date');
  });
});
