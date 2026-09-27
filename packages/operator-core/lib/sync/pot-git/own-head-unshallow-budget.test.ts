/**
 * WI-2142873 — the own-head unshallow must never outlive the git-sync
 * post-legs idle deadline, and a failed unshallow must back off.
 *
 * Measured on the Mac VM rig (2026-09-27): its `papercusp` install worktree is a
 * depth-1 clone of a very large repo. `git fetch --unshallow` was given
 * NETWORK_RUN_GIT_TIMEOUT_MS (600s), which equals the post-legs idle deadline,
 * so the liveness guard aborted the whole git-sync action inside
 * `git-sync:own-head-publish` on every tick. The ref-announce receive leg that
 * follows it never ran (routine metadata `ref_announce.at` frozen at 04:01Z,
 * 8,576 announcements queued behind the cursor), and the pot-git mirror stayed
 * NOT CONVERGED for 739+ minutes.
 */
import { describe, expect, it } from 'vitest';
import {
  boundedUnshallowTimeoutMs,
  nextUnshallowBackoff,
  UNSHALLOW_BACKOFF_BASE_MS,
  UNSHALLOW_BACKOFF_CAP_MS,
  type OwnHeadUnshallowBackoffState,
} from './own-head-publish';
import { NETWORK_RUN_GIT_TIMEOUT_MS } from './storage';

const DEFAULT_IDLE_DEADLINE_MS = 600_000;

describe('boundedUnshallowTimeoutMs', () => {
  it('leaves real headroom under the default 600s idle deadline (the measured livelock)', () => {
    const budget = boundedUnshallowTimeoutMs(DEFAULT_IDLE_DEADLINE_MS);
    expect(budget).toBe(300_000);
    expect(budget).toBeLessThan(DEFAULT_IDLE_DEADLINE_MS);
  });

  it('is strictly below the idle deadline for every deadline the guard can be configured with', () => {
    for (let idle = 2_000; idle <= 4 * 60 * 60_000; idle += 7_919) {
      expect(boundedUnshallowTimeoutMs(idle)).toBeLessThan(idle);
    }
  });

  it('never exceeds the generic network timeout, and never drops below 1s', () => {
    expect(boundedUnshallowTimeoutMs(24 * 60 * 60_000)).toBe(NETWORK_RUN_GIT_TIMEOUT_MS);
    expect(boundedUnshallowTimeoutMs(10)).toBe(1_000);
  });
});

describe('nextUnshallowBackoff', () => {
  const now = 1_800_000_000_000;

  it('a first failure defers the next attempt by the base delay', () => {
    const next = nextUnshallowBackoff(null, { state: 'failed', error: 'timed out' }, now);
    expect(next).toEqual({ failures: 1, lastAttemptAt: now, nextAttemptAt: now + UNSHALLOW_BACKOFF_BASE_MS, lastError: 'timed out' });
  });

  it('doubles per consecutive failure and caps', () => {
    let state: OwnHeadUnshallowBackoffState | null = null;
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      state = nextUnshallowBackoff(state, { state: 'failed', error: 'x' }, now);
      delays.push(state!.nextAttemptAt - now);
    }
    expect(delays.slice(0, 4)).toEqual([15, 30, 60, 120].map((m) => m * 60_000));
    expect(Math.max(...delays)).toBe(UNSHALLOW_BACKOFF_CAP_MS);
    expect(state!.failures).toBe(12);
  });

  it('a success clears the backoff', () => {
    const prior = nextUnshallowBackoff(null, { state: 'failed', error: 'x' }, now);
    expect(nextUnshallowBackoff(prior, { state: 'ok' }, now + 1)).toBeNull();
  });

  it('a store that already covers the shallow boundary clears the backoff too (no network needed)', () => {
    const prior = nextUnshallowBackoff(null, { state: 'failed', error: 'x' }, now);
    expect(nextUnshallowBackoff(prior, { state: 'not-needed' }, now + 1)).toBeNull();
  });

  it('a deferred tick, or a tick that never reached the unshallow, leaves the state untouched (same reference, so no write)', () => {
    const prior = nextUnshallowBackoff(null, { state: 'failed', error: 'x' }, now);
    expect(nextUnshallowBackoff(prior, { state: 'deferred', deferredUntil: prior!.nextAttemptAt }, now + 1)).toBe(prior);
    expect(nextUnshallowBackoff(prior, undefined, now + 1)).toBe(prior);
    expect(nextUnshallowBackoff(null, undefined, now + 1)).toBeNull();
  });
});
