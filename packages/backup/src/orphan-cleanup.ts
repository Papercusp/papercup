/**
 * Backup-snapshot orphan sweep.
 *
 * Marks `backup_snapshots` rows that have been stuck in status='running'
 * past a threshold as 'failed' with a clear error_text tag, so the UI
 * stops showing them as "in progress" indefinitely. This handles the
 * crash-of-snapshot-worker pattern (the scheduler's in-process state
 * resets on restart but PG rows linger).
 *
 * Step D (Tier-1 follow-up arc) — round-13 collateral. The scheduler
 * itself is unchanged; this is a sibling cleanup with its own boot
 * hook and admin route.
 *
 * Verified status set against migration 013:
 *   'running' | 'ok' | 'failed' | 'aborted'
 *
 * Only 'running' is swept. 'ok'/'failed'/'aborted' are terminal —
 * 'aborted' is user-initiated (Ctrl-C-on-backup or kopia process
 * killed), NOT an orphan.
 */

import { backupHost } from './config';

/**
 * Default orphan threshold. A snapshot stuck in `running` for longer
 * than this is almost certainly orphaned (real snapshots usually run
 * seconds-to-minutes; kopia operations rarely exceed 30 min).
 */
const DEFAULT_ORPHAN_THRESHOLD_MS = 60 * 60_000; // 1 hour

export interface SweepResult {
  swept: number;
  sweptIds: string[];
}

/**
 * Find and mark stale, inactive `running` snapshots as `failed`.
 *
 * Atomic via a single `UPDATE ... RETURNING id`. Idempotent: calling
 * twice in parallel yields the same total but each call returns the
 * rows IT marked (Postgres row-level locking handles the interleave).
 * A recent event is liveness evidence: long pg_dump/kopia operations emit
 * periodic progress heartbeats, so age alone must never declare them dead.
 */
export async function sweepOrphanSnapshots(opts?: {
  olderThanMs?: number;
}): Promise<SweepResult> {
  const olderThanMs = opts?.olderThanMs ?? DEFAULT_ORPHAN_THRESHOLD_MS;
  const minutes = Math.round(olderThanMs / 60_000);
  const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
  const errorTag = `orphan-sweep: status='running' for >${minutes}min`;

  const sql = backupHost().getSql();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.backup_snapshots AS snapshot
       SET status      = 'failed',
           finished_at = now(),
           error_text  = ${errorTag}
     WHERE snapshot.status = 'running'
       AND snapshot.started_at < ${cutoffIso}::timestamptz
       AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.backup_events AS event
          WHERE event.workspace_id = snapshot.workspace_id
            AND event.snapshot_id = snapshot.id
            AND event.at >= ${cutoffIso}::timestamptz
       )
     RETURNING snapshot.id::text AS id
  `;
  const sweptIds = rows.map((r) => r.id);
  return { swept: sweptIds.length, sweptIds };
}

/* Internal scheduler-side state — prevents overlapping sweeps. */
let _orphanSweepRunning = false;
let _intervalHandle: NodeJS.Timeout | null = null;

/**
 * Idempotent boot hook. First sweep fires 10s after start (to let the
 * stack settle); subsequent sweeps every 5 minutes. Guarded against
 * overlap so a slow query doesn't stack timers.
 *
 * Wire from `instrumentation-node.ts` alongside `startBackupScheduler()`.
 */
// Legacy startOrphanSweepWorker removed (dbos-scheduler-consolidation P-005): DBOS
// owns the schedule (periodic-workflows.ts `backupOrphanCleanup`).
// `sweepOrphanSnapshots` above is the single-run tick that workflow calls.

/** Test seam. */
export function stopOrphanSweepWorker(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
