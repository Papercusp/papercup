/**
 * join-progress — the join state is judged by applied-frontier progress, never by elapsed
 * time (p2p-v1-core-release-2026-11-13 P-004, R-9). The integration proof that a real
 * joining peer stays usable past every join timeout is in
 * p2p/v1-core/v1-core-acceptance.integration.test.ts; this file pins the pure policy.
 */
import { describe, expect, it } from 'vitest';
import {
  createJoinProgressTracker,
  DEFAULT_JOIN_STALL_AFTER_MS,
  JOIN_TIMEOUTS_MS,
  longestJoinTimeoutMs,
} from '../join-progress';

const T0 = 1_000_000;

describe('join-progress', () => {
  it('reports joining until the head snapshot is applied, then usable while backfilling', () => {
    const t = createJoinProgressTracker();
    expect(t.observe({ nowMs: T0, headApplied: false, appliedFrontier: 0, targetFrontier: 100 }).state).toBe('joining');
    expect(t.observe({ nowMs: T0 + 1, headApplied: true, appliedFrontier: 10, targetFrontier: 100 }).state).toBe('usable');
  });

  it('an advancing frontier is never failed, however far time runs past every join timeout and the stall window', () => {
    const t = createJoinProgressTracker();
    const step = Math.max(longestJoinTimeoutMs(), DEFAULT_JOIN_STALL_AFTER_MS) + 1;
    const states = [t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 1, targetFrontier: 50 }).state];
    for (let i = 2; i < 50; i++) {
      states.push(t.observe({ nowMs: T0 + i * step, headApplied: true, appliedFrontier: i, targetFrontier: 50 }).state);
    }
    expect(states.every((s) => s === 'usable')).toBe(true);
    const done = t.observe({ nowMs: T0 + 50 * step, headApplied: true, appliedFrontier: 50, targetFrontier: 50 });
    expect(done.state).toBe('complete');
    expect(done.completedAtMs).toBe(T0 + 50 * step);
  });

  it('control: a frontier with no advance for longer than the stall window is failed, and recovers on advance', () => {
    const t = createJoinProgressTracker({ stallAfterMs: 1_000 });
    t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 5, targetFrontier: 10 });
    expect(t.observe({ nowMs: T0 + 1_000, headApplied: true, appliedFrontier: 5, targetFrontier: 10 }).state).toBe('usable');
    const stalled = t.observe({ nowMs: T0 + 1_001, headApplied: true, appliedFrontier: 5, targetFrontier: 10 });
    expect(stalled.state).toBe('failed');
    expect(stalled.failedAtMs).toBe(T0 + 1_000);
    const resumed = t.observe({ nowMs: T0 + 5_000, headApplied: true, appliedFrontier: 6, targetFrontier: 10 });
    expect(resumed.state).toBe('usable');
    expect(resumed.failedAtMs).toBeNull();
  });

  it('a growing target is not progress: the stall window counts from the last applied advance', () => {
    const t = createJoinProgressTracker({ stallAfterMs: 1_000 });
    t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 5, targetFrontier: 10 });
    expect(t.observe({ nowMs: T0 + 2_000, headApplied: true, appliedFrontier: 5, targetFrontier: 20 }).state).toBe('failed');
  });

  it('a frontier that dips (cursor reopen) does not count as an advance when it returns to the old high', () => {
    const t = createJoinProgressTracker({ stallAfterMs: 1_000 });
    t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 8, targetFrontier: 10 });
    t.observe({ nowMs: T0 + 500, headApplied: true, appliedFrontier: 3, targetFrontier: 10 });
    expect(t.observe({ nowMs: T0 + 1_500, headApplied: true, appliedFrontier: 8, targetFrontier: 10 }).state).toBe('failed');
  });

  it('complete is sticky: a later target increase does not reopen the join', () => {
    const t = createJoinProgressTracker({ stallAfterMs: 1_000 });
    expect(t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 10, targetFrontier: 10 }).state).toBe('complete');
    expect(t.observe({ nowMs: T0 + 10_000, headApplied: true, appliedFrontier: 10, targetFrontier: 30 }).state).toBe('complete');
  });

  it('an empty hive completes as soon as the head is applied', () => {
    const t = createJoinProgressTracker();
    expect(t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 0, targetFrontier: 0 }).state).toBe('complete');
  });

  it('a clock stepping backwards neither manufactures nor shortens a stall', () => {
    const t = createJoinProgressTracker({ stallAfterMs: 1_000 });
    t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 1, targetFrontier: 10 });
    expect(t.observe({ nowMs: T0 - 50_000, headApplied: true, appliedFrontier: 1, targetFrontier: 10 }).state).toBe('usable');
    expect(t.observe({ nowMs: T0 + 1_001, headApplied: true, appliedFrontier: 1, targetFrontier: 10 }).state).toBe('failed');
  });

  it('rejects a non-finite or negative frontier instead of guessing', () => {
    const t = createJoinProgressTracker();
    expect(() => t.observe({ nowMs: T0, headApplied: true, appliedFrontier: Number.NaN, targetFrontier: 1 })).toThrow(TypeError);
    expect(() => t.observe({ nowMs: T0, headApplied: true, appliedFrontier: 1, targetFrontier: -1 })).toThrow(TypeError);
    expect(() => createJoinProgressTracker({ stallAfterMs: 0 })).toThrow(TypeError);
  });

  it('every configured join timeout is shorter than the stall window, so none of them can fail an advancing join', () => {
    for (const ms of Object.values(JOIN_TIMEOUTS_MS)) expect(ms).toBeLessThan(DEFAULT_JOIN_STALL_AFTER_MS);
    expect(longestJoinTimeoutMs()).toBe(Math.max(...Object.values(JOIN_TIMEOUTS_MS)));
  });
});
