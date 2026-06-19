/**
 * dbos-executor-reaper — the durable fix for the recurring DBOS routine-scheduler
 * dedup wedge (EI-455; see agent-insights/deploy-pipeline-silent-stall-dead-executor-dedup
 * and routines-dedup-dead-executor-wedge).
 *
 * THE WEDGE: when a DBOS executor (the operator OR a transient repro/restart host)
 * dies, it leaves its `PENDING`/`ENQUEUED` workflows stuck forever. Those rows pin
 * their `deduplication_id` — the unique index `uq_workflow_status_dedup_id` is
 * STATUS-INDEPENDENT and DBOS only frees a dedup by NULLing it on dequeue, which a
 * never-dequeued (dead-executor) workflow never does. So every future `routineFire`
 * for that routine collapses on the held dedup while `claimDueRoutine` keeps bumping
 * `last_fired_at` — the routine looks alive but never runs, and the scheduler
 * silently wedges. (It also bloats `dbos.workflow_status`, which slows queries →
 * event-loop thrashing → the executor stops draining its queue entirely.)
 *
 * THE FIX: reap dead executors' stuck non-terminal workflows — NULL the
 * `deduplication_id` (frees the index) and CANCEL them. Runs (a) once at operator
 * boot (clears wedges left by a prior crash/restart) and (b) on a process-level
 * `setInterval` — NOT a DBOS scheduled workflow, deliberately: a DBOS-scheduled
 * reaper would queue on the very executor that wedges and so couldn't fire when it's
 * most needed. The interval runs in the operator process, independent of the DBOS
 * routine engine, so it clears the wedge even when the routine scheduler is frozen.
 * Crash-safety is covered by the boot reap + PG transactionality (a crash mid-reap
 * rolls back; the next tick retries). The existing daily `dbos-workflow-gc` prunes
 * terminal rows; the reaper is what lets the GC (and every routine) keep firing.
 */
import type { Sql } from 'postgres';

/** A DBOS executor with no `workflow_status` activity in this window is considered dead. */
const DEFAULT_LIVENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
/** How often the recurring sweep runs. */
const DEFAULT_REAP_INTERVAL_MS = 2 * 60 * 1000; // 2 min

export interface ExecutorReaperResult {
  /** Stuck PENDING/ENQUEUED workflows cancelled (dedup freed). */
  cancelled: number;
  /** Orphaned workflow_queue rows purged. */
  queuePurged: number;
  /** The dead executor ids reaped this pass. */
  deadExecutorIds: string[];
}

/**
 * One reap pass: find executors with no recent activity that still hold non-terminal
 * workflows, free their dedups + cancel them, and purge their orphaned queue rows.
 * Never throws — it rides boot + an interval and must not break either.
 */
export async function reapDeadExecutorWorkflows(
  sql: Sql,
  livenessThresholdMs: number = DEFAULT_LIVENESS_THRESHOLD_MS,
): Promise<ExecutorReaperResult> {
  const empty: ExecutorReaperResult = { cancelled: 0, queuePurged: 0, deadExecutorIds: [] };
  try {
    const deadAt = Date.now() - livenessThresholdMs;

    // Dead executors: stale (no workflow_status update in the window) AND still
    // holding at least one non-terminal workflow worth reaping.
    const dead = await sql<{ executor_id: string }[]>`
      SELECT executor_id
        FROM dbos.workflow_status
       GROUP BY executor_id
      HAVING max(updated_at) < ${deadAt}
         AND count(*) FILTER (WHERE status IN ('PENDING', 'ENQUEUED')) > 0`;
    if (dead.length === 0) return empty;
    const deadIds = dead.map((r) => r.executor_id);

    // NULL the deduplication_id FIRST (the unique index keys on it regardless of
    // status) and CANCEL the stuck workflows.
    const cancelRes = await sql`
      UPDATE dbos.workflow_status
         SET deduplication_id = NULL, status = 'CANCELLED'
       WHERE executor_id = ANY(${deadIds})
         AND status IN ('PENDING', 'ENQUEUED')`;

    // Purge the matching uncompleted queue rows (they can also pin a dedup). Secondary
    // to the status cancel above — never let it fail the reap.
    let queuePurged = 0;
    try {
      const qRes = await sql`
        DELETE FROM dbos.workflow_queue
         WHERE executor_id = ANY(${deadIds})
           AND completed_at_epoch_ms IS NULL`;
      queuePurged = qRes.count;
    } catch {
      /* queue purge is best-effort */
    }

    return { cancelled: cancelRes.count, queuePurged, deadExecutorIds: deadIds };
  } catch (e) {
    console.warn(
      `[dbos-executor-reaper] reap pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
    return empty;
  }
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the reaper: an immediate boot reap + a recurring process-level sweep.
 * Idempotent (a second call replaces the timer). Kill-switch:
 * PAPERCUSP_DBOS_EXECUTOR_REAPER='0'. The timer is unref'd so it never keeps the
 * process alive on shutdown.
 */
export function startExecutorReaper(
  sql: Sql,
  opts: { intervalMs?: number; livenessThresholdMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_DBOS_EXECUTOR_REAPER === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;

  const run = (): void => {
    void reapDeadExecutorWorkflows(sql, opts.livenessThresholdMs).then((r) => {
      if (r.cancelled > 0 || r.queuePurged > 0) {
        console.warn(
          `[dbos-executor-reaper] reaped ${r.cancelled} workflow(s) + ${r.queuePurged} queue row(s) on dead executor(s): ${r.deadExecutorIds.join(', ')}`,
        );
      }
    });
  };

  run(); // boot reap
  if (reaperTimer) clearInterval(reaperTimer);
  reaperTimer = setInterval(run, intervalMs);
  if (typeof reaperTimer.unref === 'function') reaperTimer.unref();
}
