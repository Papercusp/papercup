/**
 * wire-outbox.test.ts — Stage 5 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01). Pure unit test (fakes for
 * the backfill + drain + handle — no PG, no swarm).
 *
 * `wireOutboxForHarness(handle, pg)` is the per-harness boot seam boot-all calls
 * after a harness boots. It must:
 *
 *  - call `backfillLocalState(handle, pg)` (best-effort — a throw must NOT block
 *    the drain start), THEN
 *  - call `startOutboxDrain(handle, pg)` and
 *  - register the drain's `stop()` as a `close()` hook on the handle so teardown
 *    releases the LISTEN connection + poll timer exactly once.
 */
import { describe, expect, it, vi } from 'vitest';
import { wireOutboxForHarness } from './wire-outbox';
import type { BootedHarnessHandle } from './boot';
import type { OutboxDrainHandle } from './outbox-drain';

/** A fake handle that records registered close-hooks + can run them. */
function makeHandle(): {
  handle: BootedHarnessHandle;
  runCloseHooks: () => Promise<void>;
  hookCount: () => number;
} {
  const hooks = new Set<() => void | Promise<void>>();
  const handle = {
    workspaceId: 'ws',
    harnessSlug: 'h',
    registerCloseHook(hook: () => void | Promise<void>) {
      hooks.add(hook);
      return () => hooks.delete(hook);
    },
  } as unknown as BootedHarnessHandle;
  return {
    handle,
    runCloseHooks: async () => {
      for (const h of [...hooks]) await h();
    },
    hookCount: () => hooks.size,
  };
}

const fakePg = {} as unknown as import('postgres').Sql;

describe('wireOutboxForHarness (Stage 5)', () => {
  it('backfills, then starts the drain, then registers the stopper as a close-hook', async () => {
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push('stop');
    });
    const drain: OutboxDrainHandle = { stop };
    const backfill = vi.fn(async () => {
      order.push('backfill');
      return { skipped: false, enqueued: 2, dropped: 0 };
    });
    const start = vi.fn(() => {
      order.push('start');
      return drain;
    });

    const { handle, runCloseHooks, hookCount } = makeHandle();
    await wireOutboxForHarness(handle, fakePg, {
      backfillLocalState: backfill,
      startOutboxDrain: start,
    });

    // backfill ran before start; both with (handle, pg).
    expect(order).toEqual(['backfill', 'start']);
    expect(backfill).toHaveBeenCalledWith(handle, fakePg);
    expect(start).toHaveBeenCalledWith(handle, fakePg);

    // The stopper is registered as a close-hook (not yet called).
    expect(hookCount()).toBe(1);
    expect(stop).not.toHaveBeenCalled();

    // Teardown calls stop exactly once.
    await runCloseHooks();
    expect(order).toEqual(['backfill', 'start', 'stop']);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a backfill failure does NOT block the drain start (best-effort)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stop = vi.fn(async () => {});
      const backfill = vi.fn(async () => {
        throw new Error('backfill boom');
      });
      const start = vi.fn(() => ({ stop }) as OutboxDrainHandle);

      const { handle, hookCount } = makeHandle();
      await wireOutboxForHarness(handle, fakePg, {
        backfillLocalState: backfill,
        startOutboxDrain: start,
      });

      // The drain still started + registered despite the backfill throw.
      expect(start).toHaveBeenCalledOnce();
      expect(hookCount()).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('returns the drain handle so callers can stop it directly if needed', async () => {
    const stop = vi.fn(async () => {});
    const drain: OutboxDrainHandle = { stop };
    const { handle } = makeHandle();
    const returned = await wireOutboxForHarness(handle, fakePg, {
      backfillLocalState: async () => ({ skipped: true, enqueued: 0, dropped: 0 }),
      startOutboxDrain: () => drain,
    });
    expect(returned).toBe(drain);
  });

  describe('WI-1942: bounded retry on a BAILED backfill', () => {
    // NOTE: these use REAL timers with a tiny injected `backfillRetryMs`, not
    // `vi.useFakeTimers()`. `wireOutboxForHarness` also calls
    // `buildHiveRekeyBootDeps` → `getFlag`, which bounds its own (real) network
    // fallback with a real `setTimeout`-based guard — faking global timers here
    // would fake THAT guard too and turn its bounded fallback into a genuine
    // hang. A short real wait sidesteps the interaction entirely.
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('arms a bounded retry timer on a bail, and it self-stops once a re-attempt stops bailing', async () => {
      const stop = vi.fn(async () => {});
      const drain: OutboxDrainHandle = { stop };
      const start = vi.fn(() => drain);

      // First call bails; second (retried) call succeeds.
      const backfill = vi
        .fn()
        .mockResolvedValueOnce({ skipped: false, enqueued: 0, dropped: 0, bailed: true, candidateTotal: 5000 })
        .mockResolvedValueOnce({ skipped: false, enqueued: 3, dropped: 0 });

      const { handle } = makeHandle();
      await wireOutboxForHarness(handle, fakePg, {
        backfillLocalState: backfill,
        startOutboxDrain: start,
        backfillRetryMs: 15,
      });

      // Only the initial attempt so far.
      expect(backfill).toHaveBeenCalledTimes(1);

      // Wait past one retry tick: the retry fires, succeeds (non-bailed), and the
      // timer stops itself — further waiting must NOT call backfill again.
      await wait(60);
      expect(backfill).toHaveBeenCalledTimes(2);

      const callsAfterFirstWait = backfill.mock.calls.length;
      await wait(80);
      expect(backfill).toHaveBeenCalledTimes(callsAfterFirstWait); // no further retries — timer self-stopped
    });

    it('registers the retry timer as a close-hook so teardown stops it even if it never succeeded', async () => {
      const stop = vi.fn(async () => {});
      const drain: OutboxDrainHandle = { stop };
      const start = vi.fn(() => drain);

      // Every attempt keeps bailing — the retry must never resolve on its own.
      const backfill = vi.fn(async () => ({
        skipped: false,
        enqueued: 0,
        dropped: 0,
        bailed: true,
        candidateTotal: 5000,
      }));

      const { handle, runCloseHooks, hookCount } = makeHandle();
      await wireOutboxForHarness(handle, fakePg, {
        backfillLocalState: backfill,
        startOutboxDrain: start,
        backfillRetryMs: 15,
      });

      // Both the drain-stop AND the retry-timer-stop are registered as close hooks.
      expect(hookCount()).toBe(2);

      await wait(60);
      const callsBeforeTeardown = backfill.mock.calls.length;
      expect(callsBeforeTeardown).toBeGreaterThanOrEqual(2);

      // Teardown stops the retry timer — no further retry attempts after this,
      // however much (real) time passes.
      await runCloseHooks();
      await wait(80);
      expect(backfill).toHaveBeenCalledTimes(callsBeforeTeardown);
    });

    it('does NOT arm a retry timer when the backfill does not bail (existing behavior unchanged)', async () => {
      const stop = vi.fn(async () => {});
      const drain: OutboxDrainHandle = { stop };
      const start = vi.fn(() => drain);
      const backfill = vi.fn(async () => ({ skipped: false, enqueued: 2, dropped: 0 }));

      const { handle, hookCount } = makeHandle();
      await wireOutboxForHarness(handle, fakePg, {
        backfillLocalState: backfill,
        startOutboxDrain: start,
        backfillRetryMs: 10,
      });

      // Only the drain-stop hook — no retry timer armed for a non-bailed result.
      expect(hookCount()).toBe(1);
      expect(backfill).toHaveBeenCalledTimes(1);
    });
  });
});
