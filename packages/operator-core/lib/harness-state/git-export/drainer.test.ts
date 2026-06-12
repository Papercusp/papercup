/**
 * drainer.test.ts — EI-339 failure backoff.
 *
 * A permanently-failing drain target (registry entry with a bogus harnessRoot —
 * mkdir EACCES forever) used to retry at full poll cadence and log every 5s,
 * flooding the dev-api journal. These pin the fix: consecutive failures back
 * off exponentially (doubling from the poll cadence, capped), the journal gets
 * a line only on the first failure / each doubling / recovery, and a success
 * resets the backoff entirely.
 *
 * The loop test drives startGitExportDrain with fake timers and a stub sql
 * whose tagged-template call throws until told otherwise — no PG, no fs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  DRAIN_BACKOFF_MAX_MS,
  drainBackoffMs,
  shouldLogDrainFailure,
  startGitExportDrain,
} from './drainer';

describe('drainBackoffMs (pure)', () => {
  it('doubles from the base and caps at the max', () => {
    expect(drainBackoffMs(0, 5_000)).toBe(0);
    expect(drainBackoffMs(1, 5_000)).toBe(5_000);
    expect(drainBackoffMs(2, 5_000)).toBe(10_000);
    expect(drainBackoffMs(3, 5_000)).toBe(20_000);
    expect(drainBackoffMs(8, 5_000)).toBe(DRAIN_BACKOFF_MAX_MS); // 5s·2^7 = 640s > cap
    expect(drainBackoffMs(100, 5_000)).toBe(DRAIN_BACKOFF_MAX_MS);
  });
});

describe('shouldLogDrainFailure (pure)', () => {
  it('logs on the 1st failure and each doubling only', () => {
    const logged = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(shouldLogDrainFailure);
    expect(logged).toEqual([1, 2, 4, 8]);
    expect(shouldLogDrainFailure(0)).toBe(false);
  });
});

describe('startGitExportDrain failure backoff (EI-339)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Stub sql: tagged-template call throws while `failing` is true, else no rows. */
  function makeStubSql(state: { failing: boolean; calls: number }): postgres.Sql {
    const fn = (() => {
      state.calls += 1;
      if (state.failing) throw new Error("EACCES: permission denied, mkdir '/fake'");
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    (fn as unknown as { listen: () => Promise<never> }).listen = () => new Promise<never>(() => {});
    return fn;
  }

  it('repeated failures back off exponentially and log only on doublings; success recovers', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = { failing: true, calls: 0 };

    const handle = startGitExportDrain({
      sql: makeStubSql(state),
      workspaceId: 'w',
      harnessSlug: 'broken',
      harnessRoot: '/fake',
      pollMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0); // immediate catch-up drain → failure #1, backoff 1s
    expect(state.calls).toBe(1);

    // Without backoff, 7 more polls = 7 more attempts. With it: t=1s (#2,
    // backoff 2s), t=3s (#3, backoff 4s), t=7s (#4) — polls at 2,4,5,6s skipped.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(state.calls).toBe(4);
    // Journal lines only for failures 1, 2, 4 — not every retry.
    expect(errSpy).toHaveBeenCalledTimes(3);

    // Target heals → next allowed attempt succeeds, logs recovery, resets backoff.
    state.failing = false;
    await vi.advanceTimersByTimeAsync(8_000); // past the failure-#4 8s backoff
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('recovered for w::broken'));

    // Back to full cadence after recovery: every poll attempts again.
    const callsAfterRecovery = state.calls;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.calls).toBe(callsAfterRecovery + 3);

    await handle.stop();
  });
});
