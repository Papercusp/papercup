/**
 * read-loop.ts — replay each harness's merged Autobase view into Postgres
 * (Phase 5a P-031, read side).
 *
 * The substrate was write-only: ops were appended to the per-harness Autobase
 * (locally via enqueueFeature/write-* helpers, and from peers once the swarm
 * replicates) but NOTHING replayed the merged view back into PG via
 * `applyHyperbeeOpToPg`. So peer writes — and even local substrate appends —
 * never reached PG / the UI. This loop closes that gap for every booted
 * harness (private or swarmed); it's what finally makes harness state actually
 * round-trip PG↔Hyperbee.
 *
 * The view is an append-only op LOG (a Hypercore), NOT a KV — so this is an
 * op-REPLAY loop: cursor over [0, view.length), `view.get(i)` returns the bare
 * `OpEnvelope`, passed straight to `applyHyperbeeOpToPg(op)`. Every projection
 * writer is an upsert / delete (idempotent), so replaying from 0 on each boot
 * is a safe, free backfill — no watermark persistence needed for v1.
 *
 * Driven by the Autobase `'update'` event (fired after each linearizer drain)
 * with a slow polled fallback, mirroring `bootstrap-progress-poller.ts`'s
 * lifecycle + its defensive view access: a `get()` against a closing store
 * throws → bail without advancing the cursor; the next tick retries cleanly.
 *
 * The loop needs no PG handle — each projection writer resolves PG itself
 * (`getOrgPg()` inside `writeToPg`/`deleteFromPg`).
 */

import type { AutobaseHarnessHandle, OpEnvelope } from './autobase-setup';
import { applyHyperbeeOpToPg } from './projection';

/**
 * Minimal shape we touch on the raw Autobase. Autobase's own TS types don't
 * surface `.view`, so we narrow through a structural interface rather than
 * fight the library types.
 */
interface RawAutobaseView {
  length?: number;
  get(seq: number): Promise<unknown>;
}
interface RawAutobase {
  view?: RawAutobaseView;
  on?: (event: string, fn: () => void) => void;
  off?: (event: string, fn: () => void) => void;
}

export interface ReadLoopOpts {
  workspaceId: string;
  harnessSlug: string;
  /** The AutobaseHarnessHandle from createAutobaseHarness (same handle the bootstrap poller takes). */
  base: AutobaseHarnessHandle;
  /** Polled-fallback interval in ms. Default 1000 (mirrors the bootstrap poller). 0 disables the timer (tests). */
  intervalMs?: number;
  /** Test seam — defaults to applyHyperbeeOpToPg. */
  applyImpl?: (op: unknown) => Promise<boolean>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  onError?: (e: unknown) => void;
}

export interface ReadLoopHandle {
  stop(): void;
  /** Replay [cursor, view.length) once; resolves with the number of ops applied. */
  drainOnce(): Promise<number>;
}

export function startHyperbeeReadLoop(opts: ReadLoopOpts): ReadLoopHandle {
  // View entries are bare OpEnvelopes (the apply fn appends node.value); the
  // default writer wants OpEnvelope, so narrow at the boundary.
  const apply = opts.applyImpl ?? ((op: unknown) => applyHyperbeeOpToPg(op as OpEnvelope));
  const raw = (opts.base as unknown as { base?: RawAutobase }).base;
  const intervalMs = Number.isFinite(opts.intervalMs as number)
    ? (opts.intervalMs as number)
    : 1000;

  let cursor = 0;
  let draining = false;
  let stopped = false;

  async function drainOnce(): Promise<number> {
    if (draining || stopped) return 0;
    draining = true;
    let applied = 0;
    try {
      const view = raw?.view;
      const len = typeof view?.length === 'number' ? view.length : 0;
      while (cursor < len && !stopped) {
        let op: unknown;
        try {
          op = await view!.get(cursor);
        } catch (e) {
          // View closing / unavailable — bail WITHOUT advancing the cursor so
          // the next tick retries this index cleanly.
          opts.onError?.(e);
          return applied;
        }
        cursor += 1;
        if (op == null) continue;
        try {
          await apply(op);
          applied += 1;
        } catch (e) {
          // Writers are idempotent; a failed apply is recovered by the next
          // full replay (on reboot). Don't wedge the loop on one bad op.
          opts.onError?.(e);
        }
      }
    } finally {
      draining = false;
    }
    return applied;
  }

  const onUpdate = (): void => {
    void drainOnce();
  };
  try {
    raw?.on?.('update', onUpdate);
  } catch {
    /* base may not be an event emitter (tests) */
  }

  const setI = opts.setIntervalImpl ?? setInterval;
  const timer = intervalMs > 0 ? setI(() => void drainOnce(), intervalMs) : null;
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  void drainOnce(); // initial backfill replay

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        raw?.off?.('update', onUpdate);
      } catch {
        /* no-op */
      }
      if (timer) {
        const clearI = opts.clearIntervalImpl ?? clearInterval;
        try {
          clearI(timer as Parameters<typeof clearInterval>[0]);
        } catch {
          /* no-op */
        }
      }
    },
    drainOnce,
  };
}
