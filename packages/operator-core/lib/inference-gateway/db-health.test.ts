import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAILURE_STREAK,
  SUSTAIN_MS,
  _resetDbHealth,
  dbHealthSnapshot,
  isConnectionLevelError,
  recordDbOutcome,
  reevaluateDbHealth,
  setDbHealthTransitionHandler,
} from './db-health';

const T0 = 1_700_000_000_000;

/** Drive one op into a streak that is BOTH long enough and old enough to be unhealthy. */
function driveUnhealthy(op: Parameters<typeof recordDbOutcome>[0] = 'pool-reload', err = new Error('ECONNREFUSED 127.0.0.1:20216')) {
  for (let i = 0; i < FAILURE_STREAK; i++) recordDbOutcome(op, false, err, T0 + i * 1000);
  // One more past the sustain floor — the verdict is only re-evaluated when an outcome lands.
  recordDbOutcome(op, false, err, T0 + SUSTAIN_MS + 1000);
}

beforeEach(() => {
  _resetDbHealth();
});

describe('db-health — the verdict', () => {
  it('a fresh tracker is ok but NOT observed (absence of evidence is not a fault)', () => {
    const s = dbHealthSnapshot(T0);
    expect(s.ok).toBe(true);
    expect(s.observed).toBe(false);
    expect(s.failingOps).toEqual([]);
    expect(s.unhealthyForMs).toBeNull();
  });

  it('a single failure does NOT flip ok — this must not 503 a gateway serving fine', () => {
    recordDbOutcome('pool-reload', false, new Error('ECONNREFUSED'), T0);
    const s = dbHealthSnapshot(T0 + 1000);
    expect(s.ok).toBe(true);
    expect(s.observed).toBe(true);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.failingOps).toEqual(['pool-reload']);
  });

  it('a long streak that is NOT yet sustained does not flip ok', () => {
    for (let i = 0; i < FAILURE_STREAK + 5; i++) {
      recordDbOutcome('pool-reload', false, new Error('ECONNREFUSED'), T0 + i * 100);
    }
    // Streak is long, but only ~ (FAILURE_STREAK+5)*100ms old — well under SUSTAIN_MS.
    expect(dbHealthSnapshot(T0 + 1000).ok).toBe(true);
  });

  it('a streak that is long AND sustained flips ok false, with the diagnosis attached', () => {
    driveUnhealthy();
    const s = dbHealthSnapshot(T0 + SUSTAIN_MS + 2000);
    expect(s.ok).toBe(false);
    expect(s.connectionLevel).toBe(true);
    expect(s.failingOps).toEqual(['pool-reload']);
    expect(s.lastError).toContain('ECONNREFUSED');
    expect(s.unhealthyForMs).toBeGreaterThanOrEqual(SUSTAIN_MS);
  });

  it('a success CLEARS the streak — an op that only reported failures would latch forever', () => {
    driveUnhealthy();
    expect(dbHealthSnapshot(T0 + SUSTAIN_MS + 2000).ok).toBe(false);
    recordDbOutcome('pool-reload', true, undefined, T0 + SUSTAIN_MS + 3000);
    const s = dbHealthSnapshot(T0 + SUSTAIN_MS + 3000);
    expect(s.ok).toBe(true);
    expect(s.failingOps).toEqual([]);
    expect(s.connectionLevel).toBe(false);
    expect(s.lastOkAt).toBe(T0 + SUSTAIN_MS + 3000);
  });

  it('ops are independent — a healthy poll does not mask a wedged projection write', () => {
    driveUnhealthy('window-projection');
    recordDbOutcome('pool-reload', true, undefined, T0 + SUSTAIN_MS + 1500);
    const s = dbHealthSnapshot(T0 + SUSTAIN_MS + 2000);
    expect(s.ok).toBe(false);
    expect(s.failingOps).toEqual(['window-projection']);
  });

  it('failingOps is oldest-streak-first so the FIRST symptom leads', () => {
    recordDbOutcome('window-projection', false, new Error('boom'), T0);
    recordDbOutcome('pool-reload', false, new Error('boom'), T0 + 5000);
    expect(dbHealthSnapshot(T0 + 6000).failingOps).toEqual(['window-projection', 'pool-reload']);
  });

  it('a non-connection failure still counts toward ok, but is not labelled connection-level', () => {
    driveUnhealthy('rate-hints', new Error('duplicate key value violates unique constraint'));
    const s = dbHealthSnapshot(T0 + SUSTAIN_MS + 2000);
    expect(s.ok).toBe(false);
    expect(s.connectionLevel).toBe(false);
  });

  it('recording never throws, whatever the caller passes as the error', () => {
    expect(() => recordDbOutcome('scale-observer', false, undefined, T0)).not.toThrow();
    expect(() => recordDbOutcome('scale-observer', false, null, T0)).not.toThrow();
    expect(() => recordDbOutcome('scale-observer', false, { message: { nested: true } }, T0)).not.toThrow();
    expect(() => recordDbOutcome('scale-observer', false, 'plain string', T0)).not.toThrow();
    expect(dbHealthSnapshot(T0).observed).toBe(true);
  });
});

describe('db-health — connection-level classification', () => {
  it.each([
    'connect ECONNREFUSED 127.0.0.1:20216',
    'Connection terminated unexpectedly',
    'getaddrinfo ENOTFOUND db.internal',
    'read ECONNRESET',
    'sorry, too many clients already',
    'the database system is starting up',
  ])('classifies %s as connection-level', (msg) => {
    expect(isConnectionLevelError(new Error(msg))).toBe(true);
  });

  it.each([
    'duplicate key value violates unique constraint "pk"',
    'permission denied for table operator_account_pool',
    'could not serialize access due to concurrent update',
  ])('does NOT classify %s as connection-level', (msg) => {
    expect(isConnectionLevelError(new Error(msg))).toBe(false);
  });

  it('tolerates a non-Error', () => {
    expect(isConnectionLevelError(undefined)).toBe(false);
    expect(isConnectionLevelError('ECONNREFUSED')).toBe(true);
  });
});

describe('db-health — transitions', () => {
  it('fires ONCE on healthy → unhealthy, not per failure', () => {
    const seen: boolean[] = [];
    setDbHealthTransitionHandler((e) => seen.push(e.healthy));
    driveUnhealthy();
    // Keep failing well past the flip.
    for (let i = 1; i <= 5; i++) {
      recordDbOutcome('pool-reload', false, new Error('ECONNREFUSED'), T0 + SUSTAIN_MS + 1000 + i * 60_000);
    }
    expect(seen).toEqual([false]);
  });

  it('fires again on recovery, and can re-fire on a genuine second episode', () => {
    const seen: boolean[] = [];
    setDbHealthTransitionHandler((e) => seen.push(e.healthy));
    driveUnhealthy();
    recordDbOutcome('pool-reload', true, undefined, T0 + SUSTAIN_MS + 5_000);
    // Second episode.
    const base = T0 + SUSTAIN_MS + 10_000;
    for (let i = 0; i < FAILURE_STREAK; i++) recordDbOutcome('pool-reload', false, new Error('ECONNREFUSED'), base + i * 1000);
    recordDbOutcome('pool-reload', false, new Error('ECONNREFUSED'), base + SUSTAIN_MS + 1000);
    expect(seen).toEqual([false, true, false]);
  });

  it('carries the snapshot so the handler needs no second call', () => {
    const handler = vi.fn();
    setDbHealthTransitionHandler(handler);
    driveUnhealthy('window-projection');
    expect(handler).toHaveBeenCalledTimes(1);
    const arg = handler.mock.calls[0][0] as { healthy: boolean; snapshot: { failingOps: string[]; lastError: string | null } };
    expect(arg.healthy).toBe(false);
    expect(arg.snapshot.failingOps).toEqual(['window-projection']);
    expect(arg.snapshot.lastError).toContain('ECONNREFUSED');
  });

  it('a throwing handler does not break recording', () => {
    setDbHealthTransitionHandler(() => {
      throw new Error('handler exploded');
    });
    expect(() => driveUnhealthy()).not.toThrow();
    expect(dbHealthSnapshot(T0 + SUSTAIN_MS + 2000).ok).toBe(false);
  });

  it('reevaluateDbHealth emits the flip without a new outcome (the idle-op case)', () => {
    const seen: boolean[] = [];
    setDbHealthTransitionHandler((e) => seen.push(e.healthy));
    // A streak that is long but not yet sustained: no flip on the last record.
    for (let i = 0; i < FAILURE_STREAK; i++) recordDbOutcome('scale-observer', false, new Error('ECONNREFUSED'), T0 + i * 100);
    expect(seen).toEqual([]);
    // Time passes with no further outcomes — a timer re-evaluates.
    const s = reevaluateDbHealth(T0 + SUSTAIN_MS + 1000);
    expect(s.ok).toBe(false);
    expect(seen).toEqual([false]);
  });
});
