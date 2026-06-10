/**
 * Unit tests for harness-status-sweep — focused on the parts that don't
 * require PG: the PID-aliveness predicate and the function exports/shape.
 *
 * Full integration (sweeper actually clears stale rows) needs a PG
 * fixture which the existing test infra doesn't provide; flagged in
 * the plan as a follow-on. This file pins the regression-relevant
 * pieces so the sweeper's signature can't drift silently.
 */
import { describe, it, expect } from 'vitest';
import { _internals } from './harness-status-sweep';

describe('harness-status-sweep: pidIsAlive', () => {
  const { pidIsAlive } = _internals;

  it('returns true for the current process', () => {
    expect(pidIsAlive(process.pid)).toBe(true);
  });

  it('returns false for an obviously-dead PID', () => {
    // PID 1 always exists on Linux, but PID 2^31 (max int32) is reliably
    // absent. Check both ends of the spectrum.
    expect(pidIsAlive(2147483646)).toBe(false);
  });

  it('returns false for invalid PIDs', () => {
    expect(pidIsAlive(0)).toBe(false);
    expect(pidIsAlive(-1)).toBe(false);
    expect(pidIsAlive(Number.NaN)).toBe(false);
    expect(pidIsAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('harness-status-sweep: module shape', () => {
  it('exposes the sweep functions for testability', () => {
    expect(typeof _internals.sweepAgentRunsRunning).toBe('function');
    expect(typeof _internals.sweepHarnessLanes).toBe('function');
    expect(typeof _internals.tick).toBe('function');
  });
});

describe('harness-status-sweep: schemaIdentForSlug (audit P-029)', () => {
  const { schemaIdentForSlug } = _internals;

  it('maps the canonical slug grammar like migration 044', () => {
    expect(schemaIdentForSlug('my-cool-harness')).toBe('harness_my_cool_harness');
  });

  it('never lets a non-[a-zA-Z0-9_] char into the identifier', () => {
    for (const hostile of ['a.b', 'a"b', 'a;DROP TABLE x;--', 'a b', 'a/b', 'a$b']) {
      expect(schemaIdentForSlug(hostile)).toMatch(/^harness_[a-zA-Z0-9_]+$/);
    }
  });
});
