/**
 * bootstrap-progress-poller — Phase 5b P-066 wiring.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 *
 * The Model B substrate doesn't emit a typed merge-complete event we
 * can subscribe to. As a pragmatic bridge, this helper polls a length
 * getter on a setInterval and records the count via `recordMergedOps`.
 * Stage 4 repointed it from the (retired) Autobase `base.base.view.length`
 * to the per-peer own-log length (`readLength`). Once the substrate grows
 * a typed event source we can swap this for an event listener with
 * the same external behavior.
 *
 * Returns a `stop()` cleanup hook. Idempotent; the BootedHarnessHandle
 * close() should call stop() to prevent leaks across reboots.
 */

import { clearBootstrapProgress, recordJoinProgress, type BootstrapProgressSnapshot } from './bootstrap-progress';
import { createJoinProgressTracker, type JoinProgressSample } from './join-progress';

export interface PollerOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * Read the applied remote frontier, known target and head materialization.
   * An invalid or unreadable sample makes current progress unavailable.
   */
  readProgress: () => Omit<JoinProgressSample, 'nowMs'>;
  now?: () => number;
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
  snapshot(): BootstrapProgressSnapshot | null;
}

export function startBootstrapProgressPoller(
  opts: PollerOpts,
): PollerHandle {
  const intervalMs = opts.intervalMs ?? 1000;
  const setI = opts.setIntervalImpl ?? setInterval;
  const clearI = opts.clearIntervalImpl ?? clearInterval;
  const instance = createJoinProgressTracker();
  let current: BootstrapProgressSnapshot | null = null;
  let stopped = false;

  function tick(): void {
    if (stopped) return;
    try {
      current = recordJoinProgress(opts.workspaceId, opts.harnessSlug, {
        ...opts.readProgress(), nowMs: (opts.now ?? Date.now)(),
      }, instance);
    } catch {
      current = null;
      clearBootstrapProgress(opts.workspaceId, opts.harnessSlug, instance);
    }
  }

  // record initial state right away
  tick();
  const timer = setI(tick, intervalMs);
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      current = null;
      clearBootstrapProgress(opts.workspaceId, opts.harnessSlug, instance);
      try {
        clearI(timer as never);
      } catch {
        // ignore
      }
    },
    pollOnce(): void {
      tick();
    },
    snapshot: () => current ? { ...current } : null,
  };
}
