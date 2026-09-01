/**
 * Bounded retention for the dedicated resource-governor admission ledger.
 *
 * P-005 moves the existing hourly retention surface off work_items rather than
 * creating another timer. Only terminal ledger rows are eligible, ordered by the
 * terminal transition clock (`updated_at_ms`), not admission creation time. Active
 * receipts are durable execution state and are never age-pruned.
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
export const GOVERNOR_RECEIPT_TERMINAL_STATES = ['completed', 'cancelled', 'superseded', 'expired'] as const;

export interface GovernorReceiptGcOptions {
  retentionHours?: number;
  batchLimit?: number;
  /** Injected in tests so the cutoff is deterministic. */
  nowMs?: number;
}

/**
 * Delete terminal ledger receipts older than the retention window.
 * Returns the number of rows actually deleted (0 when nothing is due).
 */
export async function gcGovernorReceipts(options: GovernorReceiptGcOptions = {}): Promise<number> {
  const retentionHours = options.retentionHours ?? GOVERNOR_RECEIPT_RETENTION_HOURS;
  const batchLimit = options.batchLimit ?? GOVERNOR_RECEIPT_GC_BATCH_LIMIT;
  const nowMs = options.nowMs ?? Date.now();

  // updated_at_ms is epoch milliseconds projected from the canonical JSON record.
  // Retention starts when the receipt became terminal, not when it was admitted.
  const cutoffMs = Math.floor(nowMs - retentionHours * 60 * 60 * 1000);

  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH doomed AS (
      SELECT workspace_id, receipt_id
        FROM harness_shared.resource_governor_admissions
       WHERE state = ANY(${GOVERNOR_RECEIPT_TERMINAL_STATES as unknown as string[]})
         AND updated_at_ms < ${cutoffMs}
       ORDER BY updated_at_ms, workspace_id, receipt_id
       LIMIT ${batchLimit}
       FOR UPDATE SKIP LOCKED
    ), d AS (
      DELETE FROM harness_shared.resource_governor_admissions admission
       USING doomed
       WHERE admission.workspace_id = doomed.workspace_id
         AND admission.receipt_id = doomed.receipt_id
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
