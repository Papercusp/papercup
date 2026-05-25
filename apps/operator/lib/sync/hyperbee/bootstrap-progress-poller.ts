/**
 * bootstrap-progress-poller — Phase 5b P-066 wiring.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 *
 * The substrate's Autobase view doesn't currently emit a typed
 * merge-complete event we can subscribe to. As a pragmatic bridge,
 * this helper polls `base.base.view.length` on a setInterval and
 * records the count via `recordMergedOps`. Once the substrate grows
 * a typed event source we can swap this for an event listener with
 * the same external behavior.
 *
 * Returns a `stop()` cleanup hook. Idempotent; the BootedHarnessHandle
 * close() should call stop() to prevent leaks across reboots.
 */

import { recordMergedOps } from './bootstrap-progress';
import type { AutobaseHarnessHandle } from './autobase-setup';

export interface PollerOpts {
  workspaceId: string;
  harnessSlug: string;
  /** The substrate handle whose view length to read. */
  base: AutobaseHarnessHandle;
  /** Poll interval in ms. Default 1000. Test seam. */
  intervalMs?: number;
  /** Setter for tests; defaults to setInterval. */
  setIntervalImpl?: typeof setInterval;
  /** Clearer for tests; defaults to clearInterval. */
  clearIntervalImpl?: typeof clearInterval;
}

export interface PollerHandle {
  /** Synchronous teardown. Idempotent. */
  stop(): void;
  /** Force one tick now (test seam). */
  pollOnce(): void;
}

function readViewLength(base: AutobaseHarnessHandle): number | null {
  try {
    const v = (base as unknown as {
      base?: { view?: { length?: number } };
    }).base?.view?.length;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  } catch {
    return null;
  }
}

export function startBootstrapProgressPoller(
  opts: PollerOpts,
): PollerHandle {
  const intervalMs = opts.intervalMs ?? 1000;
  const setI = opts.setIntervalImpl ?? setInterval;
  const clearI = opts.clearIntervalImpl ?? clearInterval;

  function tick(): void {
    const len = readViewLength(opts.base);
    if (len !== null) {
      recordMergedOps(opts.workspaceId, opts.harnessSlug, len);
    }
  }

  // record initial state right away
  tick();
  const timer = setI(tick, intervalMs);
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        clearI(timer as never);
      } catch {
        // ignore
      }
    },
    pollOnce(): void {
      tick();
    },
  };
}
