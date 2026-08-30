/**
 * receipt-gc.ts — retention for resource-governor admission receipts.
 *
 * WI-924391. This is the RECURRENCE half of that work-item; the one-off backlog
 * reap was the mitigation, and a mitigation that leaves the trap armed is not a fix.
 *
 * WHAT THESE ROWS ARE
 *   `resource-governor/queue.ts` writes ONE harness_shared.work_items row per
 *   admission ("Queued {embedding|process|inference|agent} admission", item_kind
 *   'task') carrying a `payload->'resource_governor'` record, then mutates it
 *   through queued -> eligible -> leased -> running -> completed. The row is
 *   EPHEMERAL LOCAL QUEUE STATE: no peer can act on another host's admission lease,
 *   and no sync query surfaces it (zero matches for resource_governor across the
 *   sync resolvers and apps/operator).
 *
 * WHY RETENTION DID NOT EXIST, AND WHY THAT WAS INVISIBLE
 *   work_items is declared "not age-prunable by design" in
 *   `storage/storage-growth-alarm.ts`. That is correct for real work-items and
 *   catastrophic for ephemeral rows written INTO the same table: the receipts were
 *   both unbounded AND exempt from the growth alarm, so nothing complained.
 *   MEASURED 2026-08-29: 795,447 receipts = 98.4% of local task rows, the entire
 *   pile accumulated in ~2 days at ~24k/hour, and the scheduler claim-spec census
 *   (count(*) FILTER over 17 predicates) was walking a table that was ~86% dead
 *   receipts — which convoyed on LWLock:LockManager and hung work_items:claim,
 *   scheduler:get_next and coord:orient fleet-wide.
 *   (The alarm's blindness is tracked separately as WI-936229, owned by su-ac7fc651.
 *   This module deliberately does NOT touch the alarm.)
 *
 * WHY THIS DELETE IS SAFE — all four row-level DELETE triggers on work_items were
 * enumerated and each one checked, not assumed:
 *   1. capture_work_items_outbox ....... skips receipts since migration 1025.
 *   2. emit_change_notify .............. skips receipts since migration 1026.
 *        Without 1026 a large reap emits one pg_notify PER ROW at COMMIT.
 *   3. reject_work_item_delete_with_dependencies .. MEASURED zero receipts
 *        participate in any dep_type='blocks' edge; work_item_deps is indexed on
 *        BOTH blocked and blocker, so the per-row probe is a cheap index scan that
 *        cannot raise for these rows.
 *   4. wir_delete_cleanup .............. MEASURED zero receipts have a
 *        work_item_blocked row, and its lookup key is that table's primary key.
 * If a future change re-federates receipts, 1 and 2 are the guards to re-check
 * BEFORE raising the batch limit — this sweep's safety rests on them.
 *
 * TERMINAL STATES — taken from the writer, not guessed. queue.ts's `nextDecision`
 * maps completed -> 'done' and cancelled|superseded|expired -> 'dropped', while
 * queued|eligible|leased|running are the ACTIVE set (queue.ts:262-268). Only the
 * terminal set is swept: aging out a 'leased' or 'running' receipt would destroy
 * LIVE admission state, not history. The live active set is ~1,100 rows.
 *
 * RETENTION WINDOW — deliberately SHORT, and the arithmetic is the argument.
 *   At the measured ~24k receipts/hour, a conventional 24h retention would still
 *   hold ~576k rows: that is the same collapse, arriving a day later. The value of
 *   a TERMINAL receipt is post-hoc debugging of an admission decision, which is a
 *   minutes-to-hours question, and durable telemetry lives elsewhere. Two hours
 *   keeps ~48k rows against a real (non-receipt) work_items population measured at
 *   ~138k — enough to investigate a recent admission, small enough that the census
 *   never again walks a table dominated by dead rows.
 *
 * BOUNDED + OLDEST-FIRST — the same discipline as message-log-gc: a first drain on
 * a neglected table must converge over successive runs rather than emit one
 * unbounded burst. `LIMIT` caps each tick and `ORDER BY created_ts` takes the
 * oldest first, so repeated ticks always make progress on the worst rows.
 */

import { getOrgPg } from '@papercusp/db-org';

/** Hours a TERMINAL receipt is kept. See the retention-window note above. */
export const GOVERNOR_RECEIPT_RETENTION_HOURS = 2;

/** Max receipts deleted per tick, so a large first drain converges over runs. */
export const GOVERNOR_RECEIPT_GC_BATCH_LIMIT = 50_000;

/**
 * Governor states that are TERMINAL, per `nextDecision` in queue.ts.
 * The ACTIVE states (queued, eligible, leased, running) are never swept.
 */
export const GOVERNOR_RECEIPT_TERMINAL_STATES = [
  'completed',
  'cancelled',
  'superseded',
  'expired',
] as const;

export interface GovernorReceiptGcOptions {
  retentionHours?: number;
  batchLimit?: number;
  /** Injected in tests so the cutoff is deterministic. */
  nowMs?: number;
}

/**
 * Delete TERMINAL governor admission receipts older than the retention window.
 * Returns the number of rows actually deleted (0 when nothing is due).
 */
export async function gcGovernorReceipts(
  options: GovernorReceiptGcOptions = {},
): Promise<number> {
  const retentionHours = options.retentionHours ?? GOVERNOR_RECEIPT_RETENTION_HOURS;
  const batchLimit = options.batchLimit ?? GOVERNOR_RECEIPT_GC_BATCH_LIMIT;
  const nowMs = options.nowMs ?? Date.now();

  // created_ts is epoch MILLISECONDS (bigint), not a timestamptz — so the cutoff is
  // computed in ms rather than with make_interval.
  const cutoffMs = Math.floor(nowMs - retentionHours * 60 * 60 * 1000);

  const { sql } = getOrgPg();
  // jsonb_exists(...) rather than the `?` operator: `?` collides with the driver
  // placeholder, the same reason migrations 1025/1026 use the function form.
  const rows = await sql<Array<{ n: number }>>`
    WITH doomed AS (
      SELECT workspace_id, harness_slug, feature_id
        FROM harness_shared.work_items
       WHERE jsonb_exists(payload, 'resource_governor')
         AND payload->'resource_governor'->>'state' = ANY(${
           GOVERNOR_RECEIPT_TERMINAL_STATES as unknown as string[]
         })
         AND created_ts < ${cutoffMs}
       ORDER BY created_ts
       LIMIT ${batchLimit}
    ), d AS (
      DELETE FROM harness_shared.work_items w
       USING doomed
       WHERE w.workspace_id = doomed.workspace_id
         AND w.harness_slug = doomed.harness_slug
         AND w.feature_id  = doomed.feature_id
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
