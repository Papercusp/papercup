/**
 * substrate-outbox-backstop-gc.ts — a GLOBAL backstop GC for substrate_outbox.
 *
 * The per-harness inline GC (sync/hyperbee/outbox-drain.ts) only runs for a
 * BOOTED harness and only deletes THAT scope's DRAINED rows. So rows captured
 * under a (workspace_id, harness_slug) whose substrate is NOT booted have no
 * drain AND no inline GC — they accumulate forever. The common cause is a
 * workspace MIS-ROUTE: a write path that silently defaults `workspace_id` to
 * 'default' while the harness's substrate boots under its real workspace, so
 * every capture orphans. (Observed 2026-06-15: 5.3 GB / 53k rows, dominated by
 * papercup plan-family captures under 'default'; plan
 * operator-memory-and-psu-resilience-2026-06-14, D-009/D-014/D-016.) That is
 * the EI-126 102 GB unbounded-outbox class.
 *
 * This backstop, on a DBOS schedule (dbos/periodic-workflows.ts), deletes:
 *   - any DRAINED row past the 24h retention (covers orphaned-scope drained
 *     rows the per-scope inline GC never reaches), and
 *   - any UNDRAINED row older than ORPHAN_UNDRAINED_RETENTION_MS — a healthy
 *     drain marks a row within seconds, so a row left undrained this long is, by
 *     definition, not being drained (orphaned / mis-routed / unmapped table).
 *
 * It only touches the federation-event QUEUE (substrate_outbox), never the
 * canonical tables (harness_plans / *_consolidated / …). The conservative
 * windows preserve every recent / in-flight row, so it is safe to run globally
 * regardless of which workspaces are booted. It durably bounds the table no
 * matter which tool mis-routes a workspace in the future.
 */

import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** Drained rows older than this are GC'd globally. Matches the inline 24h bar
 *  (outbox-drain.ts OUTBOX_GC_AGE_MS) so the two never disagree. */
export const DRAINED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Undrained rows older than this are treated as orphaned and GC'd. Generous
 *  margin over the ~1s merge-poll cadence — a row a booted drain owns is marked
 *  within seconds, so 48h cannot evict an in-flight row of a healthy scope. */
export const ORPHAN_UNDRAINED_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Max rows deleted per sweep — bounded so a first/large sweep holds row locks
 *  briefly; the next tick clears any remainder. */
export const BACKSTOP_GC_BATCH = 50_000;

export interface BackstopGcOptions {
  /** epoch-ms clock override (tests). Defaults to Date.now(). */
  now?: number;
  /** sql handle override (tests). Defaults to the org admin pool (RLS-bypass). */
  sql?: postgres.Sql;
}

/**
 * Run one global backstop sweep. Returns the number of outbox rows deleted.
 * Best-effort: the caller (the scheduled tick) tolerates a thrown error.
 */
export async function runSubstrateOutboxBackstopGc(
  opts: BackstopGcOptions = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? Date.now();
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ n: number }>>`
    WITH del AS (
      DELETE FROM harness_shared.substrate_outbox
       WHERE id IN (
         SELECT id
           FROM harness_shared.substrate_outbox
          WHERE (drained_at IS NOT NULL AND drained_at < ${now - DRAINED_RETENTION_MS})
             OR (drained_at IS NULL     AND ts         < ${now - ORPHAN_UNDRAINED_RETENTION_MS})
          LIMIT ${BACKSTOP_GC_BATCH}
       )
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM del
  `;
  return { deleted: rows[0]?.n ?? 0 };
}
