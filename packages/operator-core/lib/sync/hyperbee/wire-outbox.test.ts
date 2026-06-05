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
});
