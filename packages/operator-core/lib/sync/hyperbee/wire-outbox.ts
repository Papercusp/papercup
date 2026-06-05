/**
 * wire-outbox — Stage 5 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * The per-harness boot seam: after a harness boots (boot-all.ts), bring its
 * feature/issue federation send-side fully online:
 *
 *   1. `backfillLocalState(handle, pg)` — one-time enqueue of existing local
 *      `*_consolidated` rows into the outbox (idempotent; the marker makes the
 *      second boot a no-op). BEST-EFFORT: a backfill failure must NOT block the
 *      drain (which federates ongoing writes); it's logged + swallowed.
 *   2. `startOutboxDrain(handle, pg)` — the LISTEN + poll drain loop that appends
 *      undrained outbox rows to the own log.
 *   3. register the drain's `stop()` as a `close()` hook on the handle, so the
 *      LISTEN connection + poll timer release exactly once on teardown without
 *      boot-all tracking a parallel stopper Map.
 *
 * Extracted as a standalone, dependency-injected helper purely for testability:
 * the production deps default to the real backfill + drain, and the unit test
 * passes fakes (no PG, no swarm). `boot-all.ts` calls
 * `wireOutboxForHarness(handle, pg)` with the defaults.
 */

import type postgres from 'postgres';
import type { BootedHarnessHandle } from './boot';
import {
  backfillLocalState as realBackfillLocalState,
  type BackfillResult,
} from './backfill-local-state';
import {
  startOutboxDrain as realStartOutboxDrain,
  type OutboxDrainHandle,
} from './outbox-drain';
import { fanoutOutboxRow } from './fanout-projection';

export interface WireOutboxDeps {
  backfillLocalState?: (
    handle: BootedHarnessHandle,
    pg: postgres.Sql,
  ) => Promise<BackfillResult>;
  startOutboxDrain?: (handle: BootedHarnessHandle, pg: postgres.Sql) => OutboxDrainHandle;
}

/**
 * Wire feature/issue federation send-side for one booted harness. Returns the
 * drain handle (also registered as a `close()` hook so teardown stops it).
 */
export async function wireOutboxForHarness(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  deps: WireOutboxDeps = {},
): Promise<OutboxDrainHandle> {
  const backfill = deps.backfillLocalState ?? realBackfillLocalState;
  // Default drain wires the local subscribe→inject fan-out as a per-row consumer
  // on the SAME drain (coordination-substrate Phase 2). Tests override
  // startOutboxDrain to opt out of the fan-out.
  const start =
    deps.startOutboxDrain ?? ((h: BootedHarnessHandle, p: postgres.Sql) => realStartOutboxDrain(h, p, { fanout: fanoutOutboxRow }));

  // (1) Best-effort one-time backfill. A failure here must not stop the drain —
  // the backfill catches up rows that PRE-DATE federation; the drain handles
  // every ONGOING write, which is the more important guarantee. The marker is
  // only written on a successful run, so a transient failure re-runs next boot.
  try {
    await backfill(handle, pg);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[wire-outbox] backfillLocalState failed for ${handle.workspaceId}::${handle.harnessSlug} ` +
        `(continuing — drain still starts):`,
      e instanceof Error ? e.message : String(e),
    );
  }

  // (2) Start the drain loop.
  const drain = start(handle, pg);

  // (3) Register the stopper as a close-hook so shutdown releases the LISTEN
  // connection + poll timer exactly once (the handle drains its hook set once).
  handle.registerCloseHook(() => drain.stop());

  return drain;
}
