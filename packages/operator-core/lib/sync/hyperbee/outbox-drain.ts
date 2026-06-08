/**
 * outbox-drain — Stage 3 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * Reads undrained `harness_shared.substrate_outbox` rows for one booted harness
 * and appends the mapped `LocalWriteOp`s to that device's own Hypercore log via
 * `BootedHarnessHandle.append`, so feature content + issues federate to peers
 * (the read-side `harness-features` / `issues` projections apply them).
 *
 * Delivery: AT-LEAST-ONCE (D-4). A row is marked `drained_at` ONLY after its
 * `append` resolves. If `append` throws on a row, the drain STOPS (leaving that
 * row + all later rows undrained) so the next pass re-attempts them. The LWW
 * merge + idempotent `INSERT … ON CONFLICT` projections tolerate a duplicate /
 * reordered op, so re-appending a row that was actually delivered is harmless.
 *
 * Liveness: `startOutboxDrain` wires a `LISTEN substrate_outbox` (event-driven,
 * the Stage-1 trigger fires `pg_notify` with payload `${ws}::${slug}`) PLUS a
 * bounded poll-fallback timer (in case a NOTIFY is missed while the process was
 * briefly down). This is CDC within one process — NOT polling-as-transport
 * (D-3). It also runs an immediate catch-up drain on start.
 *
 * Inline 24h GC: each drain also deletes rows drained > 24h ago, keeping the
 * outbox table small without a separate sweeper (user-approved default — open
 * question 1 in the plan).
 *
 * NOT wired into boot here — Stage 5 calls `startOutboxDrain` from boot-all.ts.
 */

import type postgres from 'postgres';
import type { BootedHarnessHandle } from './boot';
import { outboxRowToLocalWriteOp, type OutboxRow } from './feature-issue-op-keys';

/** Drain batch size per `drainOutboxOnce` pass. Bounds memory + append latency;
 *  the LISTEN/poll loop re-drains until the table is empty. */
export const DEFAULT_DRAIN_BATCH = 200;

/** Drained rows older than this are GC'd inline on the next drain (24h). */
export const OUTBOX_GC_AGE_MS = 24 * 60 * 60 * 1000;

/** Inline-GC batch size. Bounded so a large backlog can't become one unbounded
 *  DELETE that never commits before the host recycles (the memory-watchdog
 *  recycles the operator ~every 12 min). Each batch is its own committed
 *  statement, so progress survives a restart. */
export const OUTBOX_GC_BATCH = 5000;

/** Max GC batches per drain pass — bounds GC time per pass (≤100k rows); the
 *  drain loop re-runs until the backlog clears. */
export const OUTBOX_GC_MAX_BATCHES = 20;

/** Default poll-fallback cadence for `startOutboxDrain` (ms). */
export const DEFAULT_POLL_MS = 5000;

/** The NOTIFY channel the Stage-1 capture trigger fires on. */
const NOTIFY_CHANNEL = 'substrate_outbox';

/** A captured outbox row, as the local fan-out consumer reads it. */
export interface OutboxFanoutRow {
  id: string | number;
  table_name: string;
  op: 'put' | 'del';
  key: string;
  row: Record<string, unknown> | null;
}

/** The local subscribe→inject fan-out consumer (coordination-substrate Phase 2).
 *  Runs per row on the SAME drain as federation (not a second consumer). */
export type OutboxFanoutFn = (row: OutboxFanoutRow) => Promise<unknown>;

export interface DrainOptions {
  /** Max rows to drain this pass. Default `DEFAULT_DRAIN_BATCH`. */
  batch?: number;
  /** Clock override (epoch ms) — for the drained_at stamp + GC cutoff. Tests
   *  inject a fixed value; production omits it (Date.now). */
  now?: number;
  /** Local subscribe→inject fan-out, run per row AFTER the federation append and
   *  BEFORE drained_at (at-least-once: a failure re-runs; the insert is
   *  idempotent). Omitted → no fan-out (federation-only, the pre-Phase-2 behavior). */
  fanout?: OutboxFanoutFn;
}

interface OutboxDbRow {
  id: string | number;
  table_name: string;
  op: 'put' | 'del';
  key: string;
  row: Record<string, unknown> | null;
  ts: string | number;
}

/**
 * Drain one batch of undrained outbox rows for this handle's (workspace,
 * harness). Returns the number of rows drained.
 *
 * AT-LEAST-ONCE: marks `drained_at` ONLY after `append` resolves; if `append`
 * throws, the error propagates (the row + later rows stay undrained) so the
 * caller's retry re-attempts. Also performs the inline 24h GC of long-drained
 * rows before reading the batch.
 */
export async function drainOutboxOnce(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: DrainOptions = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const batch = opts.batch ?? DEFAULT_DRAIN_BATCH;

  // Inline 24h GC — keep the table small. BOUNDED + BATCHED: a backlog of
  // millions of drained rows must NOT become one unbounded DELETE — that single
  // statement never commits before the memory-watchdog recycles the host
  // (~every 12 min), so the backlog grows without bound (this produced a 102 GB
  // substrate_outbox, 2026-06-08). Instead delete in capped batches, each its
  // own committed statement so progress survives a restart, up to a bounded
  // number per pass; the drain loop re-runs until the backlog clears.
  // Best-effort: a GC failure must not block the drain, so swallow it.
  try {
    for (let i = 0; i < OUTBOX_GC_MAX_BATCHES; i++) {
      const gc = await pg`
        WITH del AS (
          SELECT id
            FROM harness_shared.substrate_outbox
           WHERE drained_at IS NOT NULL
             AND drained_at < ${now - OUTBOX_GC_AGE_MS}
           LIMIT ${OUTBOX_GC_BATCH}
        )
        DELETE FROM harness_shared.substrate_outbox o
         USING del
         WHERE o.id = del.id`;
      // Fewer than a full batch removed → backlog cleared for now.
      if ((gc.count ?? 0) < OUTBOX_GC_BATCH) break;
    }
  } catch {
    // GC is non-fatal observability; continue to the actual drain.
  }

  const rows = await pg<OutboxDbRow[]>`
    SELECT id, table_name, op, key, row, ts
      FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${handle.workspaceId}
       AND harness_slug = ${handle.harnessSlug}
       AND drained_at IS NULL
     ORDER BY id
     LIMIT ${batch}`;

  let drained = 0;
  for (const r of rows) {
    const op = outboxRowToLocalWriteOp({
      table_name: r.table_name,
      op: r.op,
      key: r.key,
      ts: typeof r.ts === 'number' ? r.ts : Number(r.ts),
      row: r.row,
    } satisfies OutboxRow);

    // AT-LEAST-ONCE: append FIRST. If this throws we stop here, leaving this
    // row + all later rows undrained for the next pass to re-attempt.
    await handle.append(op);

    // Local subscribe→inject fan-out on the SAME row (Phase 2). BEST-EFFORT and
    // federation-safe: a fan-out failure is logged but must NOT stall federation
    // (the critical at-least-once path) or block this row's drained_at — so it is
    // caught here. The genuine double-process case (fan-out succeeds, then the
    // drained_at write fails → row reprocessed) is deduped by the idempotent
    // insert (deterministic msg_id + ON CONFLICT, mig 126). Non-subscribable
    // tables are a no-op inside the fan-out.
    if (opts.fanout) {
      try {
        await opts.fanout({ id: r.id, table_name: r.table_name, op: r.op, key: r.key, row: r.row });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[outbox-drain] fan-out failed for ${r.table_name} key=${r.key} (federation unaffected):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // Mark drained only after the append + fan-out resolved.
    await pg`
      UPDATE harness_shared.substrate_outbox
         SET drained_at = ${now}
       WHERE id = ${r.id}`;
    drained += 1;
  }

  return drained;
}

export interface StartDrainOptions {
  /** Poll-fallback cadence (ms). Default `DEFAULT_POLL_MS`. Set 0 to disable
   *  the timer (tests that only want the LISTEN/initial paths). */
  pollMs?: number;
  /** Drain batch size per pass. Default `DEFAULT_DRAIN_BATCH`. */
  batch?: number;
  /** Local subscribe→inject fan-out consumer, run per row (Phase 2). */
  fanout?: OutboxFanoutFn;
}

export interface OutboxDrainHandle {
  /** Stop the loop: clear the poll timer + close the LISTEN connection.
   *  Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start the per-harness drain loop:
 *   - an immediate catch-up drain (in case the process was down with a backlog);
 *   - a `LISTEN substrate_outbox` that drains when a NOTIFY's payload matches
 *     this harness's `${workspaceId}::${harnessSlug}`;
 *   - a bounded poll-fallback timer (liveness if a NOTIFY is missed).
 *
 * Resilient: a drain error is logged, not fatal — the next NOTIFY/poll retries
 * (the undrained rows are still in the outbox).
 *
 * Returns a handle whose `stop()` clears the timer + closes the LISTEN
 * connection.
 */
export function startOutboxDrain(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: StartDrainOptions = {},
): OutboxDrainHandle {
  const pollMs = Number.isFinite(opts.pollMs as number) ? (opts.pollMs as number) : DEFAULT_POLL_MS;
  const batch = opts.batch;
  const fanout = opts.fanout;
  const wantPayload = `${handle.workspaceId}::${handle.harnessSlug}`;

  let stopped = false;
  // Serialize drains so a NOTIFY + poll + initial pass can't overlap (a half-
  // applied batch racing another). A pending drain is coalesced (run-again flag).
  let draining = false;
  let runAgain = false;

  async function drainSafely(): Promise<void> {
    if (stopped) return;
    if (draining) {
      runAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        runAgain = false;
        const drainOpts: DrainOptions = {};
        if (batch !== undefined) drainOpts.batch = batch;
        if (fanout !== undefined) drainOpts.fanout = fanout;
        await drainOutboxOnce(handle, pg, drainOpts);
      } while (runAgain && !stopped);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[outbox-drain] drain failed for ${wantPayload}:`,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      draining = false;
    }
  }

  // Immediate catch-up drain.
  void drainSafely();

  // LISTEN — drain on a matching NOTIFY. `pg.listen` reserves its own dedicated
  // connection internally; the returned request's `unlisten()` releases it.
  const listenReq = pg.listen(NOTIFY_CHANNEL, (payload) => {
    if (stopped) return;
    if (payload === wantPayload) void drainSafely();
  });
  // Surface a listen-setup failure without crashing the boot path.
  void Promise.resolve(listenReq).catch((e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      `[outbox-drain] LISTEN setup failed for ${wantPayload}:`,
      e instanceof Error ? e.message : String(e),
    );
  });

  // Poll-fallback timer (liveness if a NOTIFY is missed). `.unref()` so it never
  // keeps the process alive on its own.
  const pollTimer =
    pollMs > 0
      ? setInterval(() => {
          void drainSafely();
        }, pollMs)
      : null;
  if (pollTimer && typeof (pollTimer as { unref?: () => void }).unref === 'function') {
    (pollTimer as { unref: () => void }).unref();
  }

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pollTimer) {
        try {
          clearInterval(pollTimer);
        } catch {
          // no-op
        }
      }
      try {
        const req = await listenReq;
        await req.unlisten();
      } catch {
        // best-effort: the connection may already be closing
      }
    },
  };
}
