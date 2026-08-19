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

/**
 * The two DURATION formatters added for `popup-agent-state-coverage-2026-08-18`
 * P-009 — the pane that says an agent is WAITING has to say how long, and
 * neither sibling above can: one collapses a 2-minute wait and a 23-hour wait
 * into the same word, the other hands the reader a wall clock to subtract from.
 *
 * `nowMs` is passed explicitly throughout rather than faking the clock: these
 * are pure functions of (instant, now), and passing `now` is what makes the
 * boundary assertions exact instead of ±1 tick.
 */
describe('formatElapsedSince', () => {
  const NOW = Date.parse('2026-08-18T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('renders seconds, minutes, hours+minutes and days+hours', () => {
    expect(formatElapsedSince(ago(42_000), NOW)).toBe('42s');
    expect(formatElapsedSince(ago(9 * 60_000), NOW)).toBe('9m');
    expect(formatElapsedSince(ago(2 * 3_600_000 + 41 * 60_000), NOW)).toBe('2h41m');
    expect(formatElapsedSince(ago(3 * 86_400_000 + 2 * 3_600_000), NOW)).toBe('3d2h');
  });

  it('accepts epoch milliseconds as well as ISO strings', () => {
    expect(formatElapsedSince(NOW - 5 * 60_000, NOW)).toBe('5m');
  });

  it('renders NOTHING — never "0s" — for an absent or unparseable instant', () => {
    // The distinction this pins: a duration we could not compute must not
    // render as a number the reader would act on. "0s" would say "this wait
    // started just now", which is a measurement we never took.
    expect(formatElapsedSince(null, NOW)).toBe('');
    expect(formatElapsedSince(undefined, NOW)).toBe('');
    expect(formatElapsedSince('definitely not a date', NOW)).toBe('');
    expect(formatElapsedSince(Number.NaN, NOW)).toBe('');
  });

  it('clamps a forward-dated instant to 0s rather than rendering a negative age', () => {
    expect(formatElapsedSince(NOW + 60_000, NOW)).toBe('0s');
  });

  it('separates two waits that formatRelativeUpdated both call "today"', () => {
    // The information loss P-009 exists to fix, asserted directly: these are a
    // 2-minute-old wait and a 23-hour-old one.
    const twoMinutes = ago(2 * 60_000);
    const nearlyADay = ago(23 * 3_600_000);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeUpdated(twoMinutes)).toBe('today');
    expect(formatRelativeUpdated(nearlyADay)).toBe('today');
    vi.useRealTimers();
    expect(formatElapsedSince(twoMinutes, NOW)).toBe('2m');
    expect(formatElapsedSince(nearlyADay, NOW)).toBe('23h');
  });
});

describe('formatTimeLeft', () => {
  const NOW = Date.parse('2026-08-18T12:00:00.000Z');
  const inMs = (ms: number) => new Date(NOW + ms).toISOString();

  it('renders minutes, hours+minutes and days+hours remaining', () => {
    expect(formatTimeLeft(inMs(19 * 60_000), NOW)).toBe('19m left');
    expect(formatTimeLeft(inMs(2 * 3_600_000), NOW)).toBe('2h left');
    expect(formatTimeLeft(inMs(2 * 3_600_000 + 41 * 60_000), NOW)).toBe('2h41m left');
    expect(formatTimeLeft(inMs(3 * 86_400_000), NOW)).toBe('3d left');
    expect(formatTimeLeft(inMs(3 * 86_400_000 + 2 * 3_600_000), NOW)).toBe('3d2h left');
  });

  it('ROUNDS to the minute so a 19m lock read a tick later is not "18m left"', () => {
    // Truncation here is a real regression: the dossier's held-lock countdown
    // is read against a fixture set exactly N minutes out, and the render
    // happens some milliseconds after the fixture is built.
    expect(formatTimeLeft(inMs(19 * 60_000 - 3), NOW)).toBe('19m left');
  });

  it('renders "<1m left" inside the last minute and "expired" once it has passed', () => {
    expect(formatTimeLeft(inMs(20_000), NOW)).toBe('<1m left');
    expect(formatTimeLeft(inMs(0), NOW)).toBe('expired');
    expect(formatTimeLeft(inMs(-60_000), NOW)).toBe('expired');
  });

  it('renders NOTHING — never "expired" — for an absent or unparseable deadline', () => {
    // "expired" is a claim about a deadline. An absent one has to say nothing
    // at all, or a lock with no recorded expiry reads as an elapsed one.
    expect(formatTimeLeft(null, NOW)).toBe('');
    expect(formatTimeLeft(undefined, NOW)).toBe('');
    expect(formatTimeLeft('definitely not a date', NOW)).toBe('');
    expect(formatTimeLeft(Number.NaN, NOW)).toBe('');
  });

  it('accepts epoch milliseconds as well as ISO strings', () => {
    expect(formatTimeLeft(NOW + 5 * 60_000, NOW)).toBe('5m left');
  });
});
