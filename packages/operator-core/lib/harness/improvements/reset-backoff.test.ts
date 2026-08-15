import { describe, it, expect } from 'vitest';
import { parseResetHoldUntil } from './reset-backoff';

describe('parseResetHoldUntil (EI-1404)', () => {
  it('parses the live shape: "resets 7am (America/New_York)" into a future instant in that zone', () => {
    // 2026-07-17 03:00 America/New_York == 07:00 UTC.
    const nowMs = Date.parse('2026-07-17T07:00:00.000Z');
    const r = parseResetHoldUntil(
      "worker exit 1 … You've hit your weekly limit · resets 7am (America/New_York)",
      nowMs,
    );
    expect(r).not.toBeNull();
    expect(r!.tzid).toBe('America/New_York');
    // 7am America/New_York in July (EDT, UTC-4) == 11:00 UTC the same day.
    expect(new Date(r!.holdUntilMs).toISOString()).toBe('2026-07-17T11:00:00.000Z');
    expect(r!.holdUntilMs).toBeGreaterThan(nowMs);
  });

  // EI-20542327908037306 — the WEEKLY wall is date-qualified. Before this, RESET_TIME_RE needed a
  // digit right after "resets", so "resets Aug 20, 7am" matched NOTHING and the dispatcher fell
  // back to its generic ~1-2h retry against a window that stays shut for DAYS — EI-1404's exact
  // symptom, which this module fixed only for the bare-clock (daily) shape.
  it('parses the DATE-QUALIFIED weekly shape "resets Aug 20, 7am" to that date, not tomorrow', () => {
    const nowMs = Date.parse('2026-08-15T17:47:00.000Z'); // Sat Aug 15, 1:47pm EDT
    const r = parseResetHoldUntil(
      "worker exit 1 … You've hit your weekly limit · resets Aug 20, 7am (America/New_York)",
      nowMs,
    );
    expect(r).not.toBeNull();
    expect(r!.tzid).toBe('America/New_York');
    // 7am ET on Aug 20 (EDT, UTC-4) == 11:00 UTC — five days out, NOT 7am tomorrow.
    expect(new Date(r!.holdUntilMs).toISOString()).toBe('2026-08-20T11:00:00.000Z');
    expect(r!.holdUntilMs - nowMs).toBeGreaterThan(4 * 86_400_000);
  });

  it('accepts date-qualified variants (no comma, ordinal day) and keeps the zone', () => {
    const nowMs = Date.parse('2026-08-15T17:47:00.000Z');
    expect(new Date(parseResetHoldUntil('resets Aug 18 7:30pm (America/New_York)', nowMs)!.holdUntilMs).toISOString())
      .toBe('2026-08-18T23:30:00.000Z');
    expect(new Date(parseResetHoldUntil('resets Aug 21st, 7am (America/New_York)', nowMs)!.holdUntilMs).toISOString())
      .toBe('2026-08-21T11:00:00.000Z');
  });

  it('refuses a hold months out rather than returning a wrong one', () => {
    const nowMs = Date.parse('2026-08-15T17:47:00.000Z');
    // A PAST month names no year, so it rolls forward ~10 months. Holding an item that long is
    // far worse than not holding it, so the parse degrades to null and the caller keeps its
    // ordinary retry cadence.
    expect(parseResetHoldUntil('resets Jun 18, 7:30pm (America/New_York)', nowMs)).toBeNull();
    // A word in the date slot that is NOT a month must not be read as one: the hold degrades to
    // the plain next-occurrence-of-7am rather than resolving to some arbitrary day.
    const bogus = parseResetHoldUntil('resets Foo 20, 7am (America/New_York)', nowMs);
    expect(bogus).not.toBeNull();
    expect(new Date(bogus!.holdUntilMs).toISOString()).toBe('2026-08-16T11:00:00.000Z');
    // (Note: "resets soon 7am" — a non-month word with no day number — matches neither the old
    // nor the new regex and is null in both. That is pre-existing behavior, not this change.)
  });

  it('rolls to the NEXT day when the wall-clock time has already passed today', () => {
    // 2026-07-17 13:00 America/New_York == 17:00 UTC — well past 7am ET.
    const nowMs = Date.parse('2026-07-17T17:00:00.000Z');
    const r = parseResetHoldUntil('resets 7am (America/New_York)', nowMs);
    expect(r).not.toBeNull();
    expect(new Date(r!.holdUntilMs).toISOString()).toBe('2026-07-18T11:00:00.000Z');
  });

  it('handles minutes: "resets 7:30pm (America/New_York)"', () => {
    const nowMs = Date.parse('2026-07-17T07:00:00.000Z'); // 03:00 ET
    const r = parseResetHoldUntil('resets 7:30pm (America/New_York)', nowMs);
    expect(r).not.toBeNull();
    // 19:30 ET (EDT, UTC-4) == 23:30 UTC same day.
    expect(new Date(r!.holdUntilMs).toISOString()).toBe('2026-07-17T23:30:00.000Z');
  });

  it('falls back to process-local wall clock when no zone is present (still resolves, no crash)', () => {
    const nowMs = Date.now();
    const r = parseResetHoldUntil('resets 7am', nowMs);
    expect(r).not.toBeNull();
    expect(r!.tzid).toBeUndefined();
    expect(r!.holdUntilMs).toBeGreaterThan(nowMs);
    // Never more than 24h out (today-or-tomorrow-at-7am).
    expect(r!.holdUntilMs - nowMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('rejects a junk parenthetical instead of mis-resolving it as a zone', () => {
    const nowMs = Date.parse('2026-07-17T07:00:00.000Z');
    const r = parseResetHoldUntil('resets 7am (ish)', nowMs);
    expect(r).not.toBeNull();
    expect(r!.tzid).toBeUndefined(); // "(ish)" is not IANA-shaped — dropped, not trusted
  });

  it('returns null for an unrecognized IANA zone name rather than guessing', () => {
    const nowMs = Date.parse('2026-07-17T07:00:00.000Z');
    const r = parseResetHoldUntil('resets 7am (Nowhere/Fake)', nowMs);
    expect(r).toBeNull();
  });

  it('returns null when there is no reset-time hint at all', () => {
    expect(parseResetHoldUntil('API Error: 502 upstream error: fetch failed', Date.now())).toBeNull();
    expect(parseResetHoldUntil('', Date.now())).toBeNull();
    expect(parseResetHoldUntil(undefined, Date.now())).toBeNull();
    expect(parseResetHoldUntil(null, Date.now())).toBeNull();
  });

  it('rejects an out-of-range hour (never matched by the regex\'s 1-12 am/pm requirement)', () => {
    // "resets 13am" isn't a valid 12-hour clock reading — the pattern still matches
    // digits, but the range guard must reject it rather than compute a bogus instant.
    const nowMs = Date.parse('2026-07-17T07:00:00.000Z');
    expect(parseResetHoldUntil('resets 13am (America/New_York)', nowMs)).toBeNull();
  });
});
