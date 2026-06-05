/**
 * Unit tests for the autoloop error-backoff gate — autoloop-pot-operator-rebuild
 * P-009 (D-009). `evaluateFireGate` is pure; the PG round-trip (recordFire
 * outcome semantics + readFireState) is covered by
 * autoloop-state.integration.test.ts against a real Postgres.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { evaluateFireGate, backoffBaseSec, backoffCapSec, circuitThreshold } from './autoloop';

const ENV = [
  'PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC',
  'PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC',
  'PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD',
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
