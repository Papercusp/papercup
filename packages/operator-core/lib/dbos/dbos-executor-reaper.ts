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
/** A routinesTick should finish quickly; if it is still non-terminal after this,
 *  it is wedging the scheduler itself. Keep this below bghost-watchdog's 100s
 *  freeze threshold so the reaper can fix the row before the host restart loop. */
const DEFAULT_STALE_SCHEDULER_MS = 90 * 1000;
/** A routineFire may be inside its first DBOS step; operation_outputs is written
 *  when that step checkpoints, not when it starts. Scout's blueprint step is the
 *  proven long-first-step path: its scheduler default is 20 minutes, and it owns
 *  recording its own error tick on timeout. Keep this reaper window above that
 *  timeout so a healthy long Scout cycle is not cancelled before it can report. */
const DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS = 25 * 60 * 1000;
/** How often the recurring sweep runs. */
const DEFAULT_REAP_INTERVAL_MS = 2 * 60 * 1000; // 2 min

export interface ExecutorReaperResult {
  /** Stuck PENDING/ENQUEUED workflows cancelled (dedup freed). */
  cancelled: number;
  /** Orphaned workflow_queue rows purged. */
  queuePurged: number;
  /** Routine ids pushed back to due-now after a no-first-output routineFire was reaped. */
  requeuedRoutineIds: string[];
  /** The dead executor ids reaped this pass. */
  deadExecutorIds: string[];
  /** Stale live-row workflow ids reaped even when executor_id is reused. */
  staleWorkflowIds: string[];
}

/**
 * One reap pass: find executors with no recent activity that still hold non-terminal
 * workflows, free their dedups + cancel them, and purge their orphaned queue rows.
 * Never throws — it rides boot + an interval and must not break either.
 */
export async function reapDeadExecutorWorkflows(
  sql: Sql,
  livenessThresholdMs: number = DEFAULT_LIVENESS_THRESHOLD_MS,
  staleSchedulerMs: number = DEFAULT_STALE_SCHEDULER_MS,
  staleRoutineFireNoOutputMs: number = DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
): Promise<ExecutorReaperResult> {
  const empty: ExecutorReaperResult = {
    cancelled: 0,
    queuePurged: 0,
    requeuedRoutineIds: [],
    deadExecutorIds: [],
    staleWorkflowIds: [],
  };
  try {
    const now = Date.now();
    const deadAt = now - livenessThresholdMs;
    const staleSchedulerAt = now - staleSchedulerMs;
    const staleRoutineFireNoOutputAt = now - staleRoutineFireNoOutputMs;
    let cancelled = 0;
    let queuePurged = 0;

    // Dead executors: stale (no workflow_status update in the window) AND still
    // holding at least one non-terminal workflow worth reaping.
    const dead = await sql<{ executor_id: string }[]>`
      SELECT executor_id
        FROM dbos.workflow_status
       GROUP BY executor_id
      HAVING max(updated_at) < ${deadAt}
         AND count(*) FILTER (WHERE status IN ('PENDING', 'ENQUEUED')) > 0`;
    const deadIds = dead.map((r) => r.executor_id);

    if (deadIds.length > 0) {
      // NULL the deduplication_id FIRST (the unique index keys on it regardless of
      // status) and CANCEL the stuck workflows.
      const cancelRes = await sql`
        UPDATE dbos.workflow_status
           SET deduplication_id = NULL, status = 'CANCELLED'
         WHERE executor_id = ANY(${deadIds})
           AND status IN ('PENDING', 'ENQUEUED')`;
      cancelled += cancelRes.count;

      // Purge the matching uncompleted queue rows (they can also pin a dedup). Secondary
      // to the status cancel above — never let it fail the reap.
      try {
        const qRes = await sql`
          DELETE FROM dbos.workflow_queue
           WHERE executor_id = ANY(${deadIds})
             AND completed_at_epoch_ms IS NULL`;
        queuePurged += qRes.count;
      } catch {
        /* queue purge is best-effort */
      }
    }

    // Executor ids are intentionally stable in systemd (`DBOS__VMID=bg-host-3270`),
    // so a process restart can leave old PENDING rows under the SAME executor_id.
    // The dead-executor grouping above then sees fresh activity from the new process
    // and cannot reap the old rows. Reap only bounded-safe stale rows:
    //   - a non-terminal routinesTick older than the scheduler silence window, and
    //   - a routineFire whose creation time is older than the longer first-output
    //     window and that has not checkpointed any DBOS step output, OR an
    //     orphaned routineFire older than the scheduler silence window that has
    //     neither an action-step output nor a live queue row, and
    //   - any non-terminal workflow past its explicit DBOS deadline.
    //
    // operation_outputs is a checkpoint/output table, not a live "step entered"
    // table. function_id=0 is only routine-fire-start; it proves claim context was
    // recorded, not that the target action is running. A legitimate long first
    // step (Scout's budgeted cycle is the proven case) may have only that start
    // row until it completes or records its own timeout/error, so routineFire
    // usually uses a LONGER first-action-output window than the scheduler tick.
    // The exception is no-action-output/no-queue: if no workflow_queue row exists,
    // DBOS is not actively executing that long first step, so holding the routine
    // dedup for 25 minutes only masks an orphaned fire. Use created_at, not
    // started_at_epoch_ms or updated_at: DBOS recovery can refresh BOTH timestamps
    // on a row it still has not checkpointed, and that heartbeat must not keep a
    // wedged dedup pin alive indefinitely.
    const stale = await sql<{ workflow_uuid: string; requeue_routine_id: string | null }[]>`
      SELECT workflow_uuid,
             CASE
               WHEN name = 'routineFire'
                AND deduplication_id LIKE 'routine:%'
                AND (
                  created_at < ${staleRoutineFireNoOutputAt}
                  OR (
                    created_at < ${staleSchedulerAt}
                    AND NOT EXISTS (
                      SELECT 1
                        FROM dbos.workflow_queue q
                       WHERE q.workflow_uuid = dbos.workflow_status.workflow_uuid
                         AND q.completed_at_epoch_ms IS NULL
                    )
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM dbos.operation_outputs op
                   WHERE op.workflow_uuid = dbos.workflow_status.workflow_uuid
                     AND op.function_id > 0
                )
               THEN substring(deduplication_id from 9)
               ELSE NULL
             END AS requeue_routine_id
        FROM dbos.workflow_status
       WHERE status IN ('PENDING', 'ENQUEUED')
         AND (
           (
             name = 'routinesTick'
             AND (
               updated_at < ${staleSchedulerAt}
               OR (
                 created_at < ${staleSchedulerAt}
                 AND NOT EXISTS (
                   SELECT 1
                     FROM dbos.operation_outputs op
                    WHERE op.workflow_uuid = dbos.workflow_status.workflow_uuid
                 )
               )
             )
           )
           OR (
             name = 'routineFire'
             AND (
               created_at < ${staleRoutineFireNoOutputAt}
               OR (
                 created_at < ${staleSchedulerAt}
                 AND NOT EXISTS (
                   SELECT 1
                     FROM dbos.workflow_queue q
                    WHERE q.workflow_uuid = dbos.workflow_status.workflow_uuid
                      AND q.completed_at_epoch_ms IS NULL
                 )
               )
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM dbos.operation_outputs op
                WHERE op.workflow_uuid = dbos.workflow_status.workflow_uuid
                  AND op.function_id > 0
             )
           )
           OR (workflow_deadline_epoch_ms IS NOT NULL AND workflow_deadline_epoch_ms < ${now})
         )`;
    const staleIds = stale.map((r) => r.workflow_uuid);
    const requeueRoutineIds = [...new Set(stale.map((r) => r.requeue_routine_id).filter((id): id is string => !!id))];
    if (staleIds.length > 0) {
      const staleCancel = await sql`
        UPDATE dbos.workflow_status
           SET deduplication_id = NULL, status = 'CANCELLED'
         WHERE workflow_uuid = ANY(${staleIds})
           AND status IN ('PENDING', 'ENQUEUED')`;
      cancelled += staleCancel.count;
      try {
        const qRes = await sql`
          DELETE FROM dbos.workflow_queue
           WHERE workflow_uuid = ANY(${staleIds})
             AND completed_at_epoch_ms IS NULL`;
        queuePurged += qRes.count;
      } catch {
        /* queue purge is best-effort */
      }
      if (requeueRoutineIds.length > 0) {
        await sql`
          UPDATE harness_shared.routines
             SET next_fire_at = LEAST(COALESCE(next_fire_at, now()), now()),
                 metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'last_error',
                        'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
                        'last_error_at',
                        now()::text,
                        'last_error_source',
                        'dbos-executor-reaper'
                      ),
                 updated_at = now()
           WHERE id = ANY(${requeueRoutineIds})
             AND active = true`;
      }
    }

    if (cancelled === 0 && queuePurged === 0) return empty;
    return {
      cancelled,
      queuePurged,
      requeuedRoutineIds: requeueRoutineIds,
      deadExecutorIds: deadIds,
      staleWorkflowIds: staleIds,
    };
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
  opts: {
    intervalMs?: number;
    livenessThresholdMs?: number;
    staleSchedulerMs?: number;
    staleRoutineFireNoOutputMs?: number;
  } = {},
): void {
  if (process.env.PAPERCUSP_DBOS_EXECUTOR_REAPER === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;

  const run = (): void => {
    void reapDeadExecutorWorkflows(
      sql,
      opts.livenessThresholdMs,
      opts.staleSchedulerMs,
      opts.staleRoutineFireNoOutputMs,
    ).then((r) => {
      if (r.cancelled > 0 || r.queuePurged > 0) {
        console.warn(
          `[dbos-executor-reaper] reaped ${r.cancelled} workflow(s) + ${r.queuePurged} queue row(s); dead executor(s): ${r.deadExecutorIds.join(', ') || 'none'}; stale workflow(s): ${r.staleWorkflowIds.join(', ') || 'none'}; requeued routine(s): ${r.requeuedRoutineIds.join(', ') || 'none'}`,
        );
      }
    });
  };

  run(); // boot reap
  if (reaperTimer) clearInterval(reaperTimer);
  reaperTimer = setInterval(run, intervalMs);
  if (typeof reaperTimer.unref === 'function') reaperTimer.unref();
}
