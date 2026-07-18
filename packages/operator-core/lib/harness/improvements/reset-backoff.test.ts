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
