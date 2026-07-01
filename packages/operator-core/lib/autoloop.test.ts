/**
 * Unit tests for the autoloop error-backoff gate — autoloop-pot-operator-rebuild
 * P-009 (D-009). `evaluateFireGate` is pure; the PG round-trip (recordFire
 * outcome semantics + readFireState) is covered by
 * autoloop-state.integration.test.ts against a real Postgres.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  evaluateFireGate,
  backoffBaseSec,
  backoffCapSec,
  circuitThreshold,
  recoverySec,
  isPruneDue,
  PRUNE_THROTTLE_MS,
  pruneMaxAgeDays,
} from './autoloop';

const ENV = [
  'PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC',
  'PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC',
  'PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD',
  'PAPERCUSP_AUTOLOOP_RECOVERY_SEC',
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const NOW = new Date('2026-06-05T12:00:00Z');
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);

describe('evaluateFireGate — exponential backoff + circuit-break (D-009)', () => {
  test('no fire-state row ⇒ allow', () => {
    expect(evaluateFireGate(null, NOW)).toEqual({ allow: true, consecutiveErrors: 0 });
  });

  test('zero consecutive errors ⇒ allow (full cadence)', () => {
    expect(evaluateFireGate({ lastFiredAt: ago(1), consecutiveErrors: 0 }, NOW).allow).toBe(true);
  });

  test('1 error ⇒ withheld inside base window (60s), allowed after', () => {
    const inside = evaluateFireGate({ lastFiredAt: ago(30), consecutiveErrors: 1 }, NOW);
    expect(inside.allow).toBe(false);
    expect(inside.reason).toBe('backoff');
    expect(inside.retryAfterSec).toBe(30);
    expect(evaluateFireGate({ lastFiredAt: ago(61), consecutiveErrors: 1 }, NOW).allow).toBe(true);
  });

  test('backoff doubles per error: 3 errors ⇒ 240s window', () => {
    expect(evaluateFireGate({ lastFiredAt: ago(200), consecutiveErrors: 3 }, NOW).allow).toBe(false);
    expect(evaluateFireGate({ lastFiredAt: ago(241), consecutiveErrors: 3 }, NOW).allow).toBe(true);
  });

  test('backoff is capped: 7 errors would be 3840s, capped at 3600s', () => {
    expect(evaluateFireGate({ lastFiredAt: ago(3599), consecutiveErrors: 7 }, NOW).allow).toBe(false);
    expect(evaluateFireGate({ lastFiredAt: ago(3601), consecutiveErrors: 7 }, NOW).allow).toBe(true);
  });

  test('at the threshold (8) the circuit OPENS — one probe per cap window', () => {
    const open = evaluateFireGate({ lastFiredAt: ago(600), consecutiveErrors: 8 }, NOW);
    expect(open.allow).toBe(false);
    expect(open.reason).toBe('circuit-open');
    expect(open.retryAfterSec).toBe(3000);
    // Half-open probe after the cap window.
    expect(evaluateFireGate({ lastFiredAt: ago(3601), consecutiveErrors: 8 }, NOW).allow).toBe(true);
    // Way past the threshold stays circuit-open (not unbounded growth).
    const way = evaluateFireGate({ lastFiredAt: ago(600), consecutiveErrors: 50 }, NOW);
    expect(way.reason).toBe('circuit-open');
  });

  test('a null lastFiredAt with errors counts as long-elapsed ⇒ allow (probe)', () => {
    expect(evaluateFireGate({ lastFiredAt: null, consecutiveErrors: 5 }, NOW).allow).toBe(true);
  });

  test('env knobs override base/cap/threshold (with sane fallbacks)', () => {
    process.env.PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC = '10';
    process.env.PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC = '100';
    process.env.PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD = '3';
    expect(backoffBaseSec()).toBe(10);
    expect(backoffCapSec()).toBe(100);
    expect(circuitThreshold()).toBe(3);
    // 2 errors ⇒ 20s window under the overrides.
    expect(evaluateFireGate({ lastFiredAt: ago(15), consecutiveErrors: 2 }, NOW).allow).toBe(false);
    expect(evaluateFireGate({ lastFiredAt: ago(21), consecutiveErrors: 2 }, NOW).allow).toBe(true);
    // 3 errors ⇒ circuit-open at the lowered threshold.
    expect(evaluateFireGate({ lastFiredAt: ago(50), consecutiveErrors: 3 }, NOW).reason).toBe('circuit-open');
    // Garbage env falls back.
    process.env.PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC = 'nope';
    expect(backoffBaseSec()).toBe(60);
  });
});

// B7 / autonomous-loop-hardening F3 — a scout/overwatch circuit that opened and then WEDGED
// (next_fire_at stuck in the past, no half-open probe, last_fired_at goes stale) used to stay
// gated forever until a human ran `autoloop:control reset-errors`. The recovery-debounce
// auto-closes a circuit that has been open past the recovery window with no fire, so the
// feedback half self-heals — while a circuit that is STILL probing (recent last_fired_at) is
// left open (correctly-failing circuits are not force-reset).
describe('evaluateFireGate — recovery-debounce auto-heal (B7/F3)', () => {
  test('recoverySec default is 6× the cap (~6h)', () => {
    expect(recoverySec()).toBe(backoffCapSec() * 6); // 3600 * 6 = 21600
  });

  test('open circuit still probing (recent fire) ⇒ NOT auto-reset — left open/probing', () => {
    // ago(3601): past the cap (probe allowed) but far inside the 21600s recovery window.
    const v = evaluateFireGate({ lastFiredAt: ago(3601), consecutiveErrors: 8 }, NOW);
    expect(v.allow).toBe(true);        // half-open probe
    expect(v.autoReset).toBeUndefined(); // but NOT a recovery reset
  });

  test('open circuit wedged past the recovery window ⇒ auto-reset (allow + autoReset)', () => {
    const v = evaluateFireGate({ lastFiredAt: ago(21601), consecutiveErrors: 8 }, NOW);
    expect(v.allow).toBe(true);
    expect(v.autoReset).toBe(true);
    expect(v.consecutiveErrors).toBe(8); // the pre-reset count (checkFireGate zeroes it)
  });

  test('BELOW-threshold errors never auto-reset, even long-elapsed (circuit not open)', () => {
    const v = evaluateFireGate({ lastFiredAt: ago(999999), consecutiveErrors: 5 }, NOW);
    expect(v.allow).toBe(true);
    expect(v.autoReset).toBeUndefined();
  });

  test('PAPERCUSP_AUTOLOOP_RECOVERY_SEC overrides the window', () => {
    process.env.PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC = '50';
    process.env.PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD = '3';
    process.env.PAPERCUSP_AUTOLOOP_RECOVERY_SEC = '100';
    expect(recoverySec()).toBe(100);
    // open (3 errors ≥ threshold 3), fired 40s ago (< cap 50) ⇒ still circuit-open, withheld.
    expect(evaluateFireGate({ lastFiredAt: ago(40), consecutiveErrors: 3 }, NOW).reason).toBe('circuit-open');
    // 60s ago (past cap 50, inside recovery 100) ⇒ probe, NOT auto-reset.
    const probe = evaluateFireGate({ lastFiredAt: ago(60), consecutiveErrors: 3 }, NOW);
    expect(probe.allow).toBe(true);
    expect(probe.autoReset).toBeUndefined();
    // 101s ago (past recovery 100) ⇒ auto-reset.
    expect(evaluateFireGate({ lastFiredAt: ago(101), consecutiveErrors: 3 }, NOW).autoReset).toBe(true);
    // Garbage env falls back to cap*6.
    process.env.PAPERCUSP_AUTOLOOP_RECOVERY_SEC = 'nope';
    expect(recoverySec()).toBe(50 * 6);
  });
});

describe('stale fire-state hygiene prune throttle (autonomous-loop-hardening F6)', () => {
  test('is due when never pruned (lastPruneAtMs = 0)', () => {
    expect(isPruneDue(1_000_000, 0)).toBe(true);
  });
  test('is NOT due within the throttle window', () => {
    const now = 10 * PRUNE_THROTTLE_MS;
    expect(isPruneDue(now, now - (PRUNE_THROTTLE_MS - 1))).toBe(false);
  });
  test('is due once the throttle window has elapsed', () => {
    const now = 10 * PRUNE_THROTTLE_MS;
    expect(isPruneDue(now, now - PRUNE_THROTTLE_MS)).toBe(true);
    expect(isPruneDue(now, now - (PRUNE_THROTTLE_MS + 1))).toBe(true);
  });
  test('respects a custom throttle window', () => {
    expect(isPruneDue(500, 200, 100)).toBe(true);
    expect(isPruneDue(250, 200, 100)).toBe(false);
  });
  test('pruneMaxAgeDays defaults to a safe 14d window and honours a valid override', () => {
    delete process.env.PAPERCUSP_AUTOLOOP_PRUNE_MAX_AGE_DAYS;
    expect(pruneMaxAgeDays()).toBe(14);
    process.env.PAPERCUSP_AUTOLOOP_PRUNE_MAX_AGE_DAYS = '30';
    expect(pruneMaxAgeDays()).toBe(30);
    process.env.PAPERCUSP_AUTOLOOP_PRUNE_MAX_AGE_DAYS = 'garbage';
    expect(pruneMaxAgeDays()).toBe(14);
    delete process.env.PAPERCUSP_AUTOLOOP_PRUNE_MAX_AGE_DAYS;
  });
});
