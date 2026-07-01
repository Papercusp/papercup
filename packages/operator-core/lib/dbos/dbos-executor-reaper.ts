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
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';

/** A DBOS executor with no `workflow_status` activity in this window is considered dead. */
const DEFAULT_LIVENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
/** A routinesTick should finish quickly; if it is still non-terminal after this,
 *  it is wedging the scheduler itself. Keep this below bghost-watchdog's 100s
 *  freeze threshold so the reaper can fix the row before the host restart loop. */
const DEFAULT_STALE_SCHEDULER_MS = 90 * 1000;
/** A routineFire may be inside its first DBOS step; operation_outputs is written
 *  when that step checkpoints, not when it starts. The longest legit no-output
 *  first step is the GREEN-CHECKPOINT suite: its action (release-actions.ts) does a
 *  single ~55-min `await runScript(...)` over the test suite with NO intermediate
 *  DBOS checkpoint, so it records nothing in operation_outputs until it completes.
 *  This window MUST stay ABOVE that suite's full runtime, else the reaper cancels a
 *  HEALTHY long checkpoint at the window and the green gate (→ every fleet deploy)
 *  wedges — the 2026-06-29 incident this constant caused at 25m (green-checkpoint-
 *  reaper-window-vs-suite). Earlier this was 25m, tuned only for Scout's 20-min
 *  cycle, before green-checkpoint's runtime grew to 55m.
 *
 *  INVARIANT (cross-file, same convention as the result MARKERs / lock-stale in
 *  release-actions.ts + green-checkpoint.ts): keep
 *    GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (55m, release-actions.ts)  <  THIS (60m)
 *      <  CHECKPOINT_LOCK_STALE_MS (65m, green-checkpoint.ts)
 *  so a checkpoint is SIGTERM-killed by its own suite timeout (recording its result
 *  → a terminal, non-reapable workflow) before this reaper window elapses, yet still
 *  before its run-lock is stale-reclaimable. Whoever retunes one must retune these. */
const DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS = 60 * 60 * 1000;
/** WI-1416: the FAST-orphan window for a routineFire in the genuinely anomalous
 *  ENQUEUED-with-no-live-queue-row state (see the corrected queue-row semantics on
 *  the stale query below). This path used to fire at `staleSchedulerMs` (90s) for ANY
 *  no-queue-row fire — a false-positive machine once we verified queue rows vanish at
 *  DEQUEUE (every healthy executing fire has none), which reaped+requeued every
 *  git-sync fire whose first step ran >90s (the WI-1415 ~1-commit/40min loop).
 *  Env-tunable: PAPERCUSP_DBOS_REAPER_FIRE_ORPHAN_MS. */
const DEFAULT_STALE_ROUTINE_FIRE_ORPHAN_MS = (() => {
  const v = Number(process.env.PAPERCUSP_DBOS_REAPER_FIRE_ORPHAN_MS);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
})();
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
  staleRoutineFireOrphanMs: number = DEFAULT_STALE_ROUTINE_FIRE_ORPHAN_MS,
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
    const staleRoutineFireOrphanAt = now - staleRoutineFireOrphanMs;
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
    //     ENQUEUED routineFire older than the fast-orphan window whose queue row is
    //     GONE (never dequeued yet un-queued — a genuine anomaly, see below), and
    //   - any non-terminal workflow past its explicit DBOS deadline.
    //
    // operation_outputs is a checkpoint/output table, not a live "step entered"
    // table. function_id=0 is only routine-fire-start; it proves claim context was
    // recorded, not that the target action is running. A legitimate long first
    // step (green-checkpoint's ~55m suite is the proven case) may have only that
    // start row until it completes or records its own timeout/error, so routineFire
    // uses the LONGER first-action-output window than the scheduler tick.
    //
    // QUEUE-ROW SEMANTICS — CORRECTED (WI-1416, verified live 2026-07-01): our DBOS
    // version DELETES the workflow_queue row at DEQUEUE time, so every actively-
    // EXECUTING PENDING workflow has NO live queue row. "No queue row" therefore
    // means "executing OR orphaned", NOT "orphaned" — the old fast path built on the
    // opposite reading cancelled ANY healthy fire whose first step outlived the 90s
    // scheduler window (git-sync on the big tree: reaped + requeued every 2-min pass
    // → restart-from-scratch loop → ~1 commit/40min, WI-1415). The fast path now
    // only reaps the state that IS anomalous under the corrected semantics: an
    // ENQUEUED row (never dequeued) with no live queue row — e.g. a crash between
    // the queue delete and the status flip, or a prior partial reap — after its own
    // longer, env-tunable orphan window. A PENDING no-output fire is left to the 60m
    // no-output window, its explicit deadline, or the dead-executor branch.
    //
    // Use created_at, not started_at_epoch_ms or updated_at: DBOS recovery can
    // refresh BOTH timestamps on a row it still has not checkpointed, and that
    // heartbeat must not keep a wedged dedup pin alive indefinitely.
    const stale = await sql<{ workflow_uuid: string; requeue_routine_id: string | null }[]>`
      SELECT workflow_uuid,
             CASE
               WHEN name = 'routineFire'
                AND deduplication_id LIKE 'routine:%'
                AND (
                  created_at < ${staleRoutineFireNoOutputAt}
                  OR (
                    status = 'ENQUEUED'
                    AND created_at < ${staleRoutineFireOrphanAt}
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
                 status = 'ENQUEUED'
                 AND created_at < ${staleRoutineFireOrphanAt}
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
        // WI-1416: `reaped_count` counts CONSECUTIVE reaps — a completed fire resets
        // it (git-sync's recordOutcome, and the clear below drops it) — so persistent
        // reaping is a durable, queryable signal the git-sync-stall-watchdog alarms on
        // (paired with the fire_started_at breadcrumb the fire stamps at its top).
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
                        'dbos-executor-reaper',
                        'reaped_count',
                        COALESCE((metadata->>'reaped_count')::int, 0) + 1
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

/**
 * The `last_error_source` this reaper stamps onto `harness_shared.routines.metadata`
 * when it cancels+REQUEUES a stuck fire (see the requeue UPDATE above, ~line 250).
 * The marker is a SELF-HEAL note ("I recovered this routine"), NOT a wedge — but the
 * improvement-watchdog's `routine-failure` collector (watchdog.ts) alarms on ANY
 * non-empty `last_error`, so the marker MUST be cleared once the routine actually
 * fires successfully again, else it re-files phantom "routine is failing" bugs forever.
 */
export const REAPER_LAST_ERROR_SOURCE = 'dbos-executor-reaper';

/**
 * Clear a STALE reaper-sourced `last_error` off a routine after it fires successfully.
 *
 * WHY: `reapDeadExecutorWorkflows` stamps `metadata.last_error` (source
 * `${REAPER_LAST_ERROR_SOURCE}`) with "produced no DBOS operation output; …requeued
 * the routine" as its self-heal marker. A routineFire that later COMPLETES a dispatch
 * step DID produce DBOS operation output — which directly DISPROVES that verdict — so
 * the marker is now stale and must be removed. Otherwise `collectRoutineFailureSignals`
 * keeps minting `routine-failure` bugs (EI-5938 and 25+ others: loop-su-* + system
 * routines that don't manage their own last_error leaked the marker permanently,
 * because the loop-wake branch returns before any metadata clear and the system
 * success-clear was scoped to `last_error_source='runner'`).
 *
 * SOURCE-SCOPED ON PURPOSE — this is the safety property that lets it run on every
 * successful fire without masking a real problem:
 *   - `runner`-sourced errors (a system action that THREW) are LEFT for the action's
 *     own success-path clear, so a genuinely-throwing action stays visible.
 *   - git-sync records `last_error` with NO source key (recordOutcome) and is UNTOUCHED.
 *   - A GENUINELY wedged routine whose fire keeps getting reaped never completes a
 *     dispatch step, so it never reaches this clear — the reaper re-stamps the marker
 *     each reap and the alarm still fires.
 *
 * Fail-soft: a clear failure must never fail the fire it rides.
 */
export async function clearStaleReaperLastError(sql: Sql, routineId: string): Promise<void> {
  // WI-1416: `reaped_count` is the reaper's consecutive-reap counter — a completed
  // dispatch disproves the reap verdict exactly like the marker keys, so drop it too.
  await sql`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source' - 'reaped_count',
           updated_at = now()
     WHERE id = ${routineId}
       AND metadata->>'last_error_source' = ${REAPER_LAST_ERROR_SOURCE}`.catch(() => {});
}

let reaperTimer: ManagedHandle | null = null;

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
    staleRoutineFireOrphanMs?: number;
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
      opts.staleRoutineFireOrphanMs,
    ).then((r) => {
      if (r.cancelled > 0 || r.queuePurged > 0) {
        console.warn(
          `[dbos-executor-reaper] reaped ${r.cancelled} workflow(s) + ${r.queuePurged} queue row(s); dead executor(s): ${r.deadExecutorIds.join(', ') || 'none'}; stale workflow(s): ${r.staleWorkflowIds.join(', ') || 'none'}; requeued routine(s): ${r.requeuedRoutineIds.join(', ') || 'none'}`,
        );
      }
    });
  };

  run(); // boot reap
  if (reaperTimer) reaperTimer.stop();
  reaperTimer = managedSetInterval('dbos-executor-reaper', intervalMs, run, { category: 'watchdog' });
}
