/**
 * EI-455 bug #2 — green-stall-watchdog verdict logic. The DB wiring (checkGreenStall)
 * is integration-covered by the live self-test; here we pin the pure decision +
 * escalation body that decide WHEN the silent-stall alarm fires.
 */
import { describe, it, expect } from 'vitest';
import { evaluateGreenStall, greenStallEscalationBody } from './green-stall-watchdog';

const H = 60 * 60 * 1000;
const NOW = 1_750_000_000_000; // fixed epoch ms

describe('evaluateGreenStall', () => {
  it('a fresh install (never fired, never green) does not alarm', () => {
    const v = evaluateGreenStall({ lastFiredMs: null, lastGreenAt: null, watchdogAlerted: false }, NOW);
    expect(v.stalled).toBe(false);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('a healthy routine (fired + greened within the hour) does not alarm', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 20 * 60 * 1000, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('FIRE-STALE: an active routine that stopped firing (>3h) alarms — the EI-455 wedge signature', () => {
    // The in-routine detector is blind to this (it only runs when the routine fires).
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 4 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
  });

  it('VERDICT-STALE: firing fine but no green in >12h alarms (deep backstop)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 13 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(true);
    expect(v.fireStale).toBe(false);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('does NOT double-fire with the in-routine 6h alarm: a 7h-stale green while still firing is not yet watchdog-stalled', () => {
    // The in-routine STALL_AGE_MS=6h owns this window; the watchdog's 12h backstop
    // only trips if that path also failed. So 7h-stale-while-firing stays quiet here.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 20 * 60 * 1000, lastGreenAt: NOW - 7 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });

  it('BOTH stale: the wedge that also aged past the green backstop reports both clauses', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 5 * H, lastGreenAt: NOW - 24 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(true);
    expect(v.verdictStale).toBe(true);
    expect(v.reason).toContain('has not FIRED');
    expect(v.reason).toContain('no GREEN verdict');
  });

  it('honors custom thresholds', () => {
    const tight = { fireStaleMs: 30 * 60 * 1000, noGreenMs: H };
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 45 * 60 * 1000, lastGreenAt: NOW - 45 * 60 * 1000, watchdogAlerted: false },
      NOW,
      tight,
    );
    expect(v.fireStale).toBe(true);
  });

  it('boundary: exactly at the fire-stale threshold does not alarm (strict >)', () => {
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 3 * H, lastGreenAt: NOW - 3 * H, watchdogAlerted: false },
      NOW,
    );
    expect(v.fireStale).toBe(false);
    expect(v.stalled).toBe(false);
  });

  it('a routine that fired recently but has NEVER greened does not verdict-alarm (no lastGreenAt to age)', () => {
    // Fire-recency is healthy here; lastGreenAt null can't be aged. Caught only once
    // firing also goes stale (the wedge) — avoids false alarms on a never-green fresh start.
    const v = evaluateGreenStall(
      { lastFiredMs: NOW - 10 * 60 * 1000, lastGreenAt: null, watchdogAlerted: false },
      NOW,
    );
    expect(v.stalled).toBe(false);
  });
});

describe('greenStallEscalationBody', () => {
  it('serializes the watchdog escalation with the stall axes + iso timestamps', () => {
    const verdict = evaluateGreenStall(
      { lastFiredMs: NOW - 4 * H, lastGreenAt: NOW - 26 * H, watchdogAlerted: false },
      NOW,
    );
    const body = JSON.parse(
      greenStallEscalationBody({
        installSlug: 'papercusp',
        verdict,
        lastFiredMs: NOW - 4 * H,
        lastGreenAt: NOW - 26 * H,
        nowMs: NOW,
      }),
    );
    expect(body.kind).toBe('green-checkpoint-watchdog');
    expect(body.harness_slug).toBe('papercusp');
    expect(body.fireStale).toBe(true);
    expect(body.verdictStale).toBe(true);
    expect(body.lastFiredAt).toBe(new Date(NOW - 4 * H).toISOString());
    expect(body.detail).toContain('silent stall');
  });
});
