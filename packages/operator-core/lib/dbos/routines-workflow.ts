/**
 * The generic scheduled-routines engine on DBOS — git-sync-auto-commit Phase 1
 * (D-001). REVIVES the dormant in-process `routine-ticker` `setTimeout` loop
 * (`libs/papercusp/libs/db/src/routine-ticker.ts`, never started in the operator)
 * as a **durable DBOS scheduled workflow**.
 *
 * Each tick (default every 30s, skip-missed so a long-closed desktop doesn't
 * backfill a storm):
 *   1. `listDueCronRoutines()` — every workspace's due cron routines (the admin
 *      `getOrgPg()` connection bypasses RLS, so one query spans workspaces).
 *   2. For each, **claim** it with a conditional `next_fire_at` advance (so two
 *      concurrent ticks can't both fire it), then enqueue a per-routine durable
 *      fire workflow with a dedup ID (`routine:<id>`) for belt-and-suspenders
 *      single-fire + natural back-pressure (a long fire collapses the next
 *      enqueue while it runs — same shape as the autoloop fire queue).
 *
 * The fire dispatches by target (D-006):
 *   - `system:<action>` → run the registered handler INLINE as one durable step
 *     (the git-sync path; see `system-actions.ts`).
 *   - an agent role → spawn the role (wired in git-sync-auto-commit P-012; until
 *     then this branch logs and no-ops, and no role routines are configured).
 *
 * Flag-gated by `dbosRoutinesActive()` — **opt-in** (PAPERCUSP_DBOS_ROUTINES=1)
 * while the engine is new, so a host restart never auto-fires stale/unknown
 * routines unsupervised. Registered only when `bootstrap.ts` imports this module.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { queueConcurrency } from './queue-concurrency';
import { ROUTINES_QUEUE, ROUTINES_CRITICAL_QUEUE, queueForRoutine } from './routines-queue-classification';
import { getOrgPg, listDueCronRoutines } from '@papercusp/db-org';
import { runWithWorkspace } from '../workspace-als';
import { loopbackFetch } from '../loopback-fetch';
import { claimDueRoutine } from '../harness/routines/claim';
import { checkFireGate, recordFire } from '../autoloop';
import { fireLoopWake } from '../harness/routines/loop-fire';
import { getSystemAction, getSystemActionEntry, SYSTEM_TARGET_PREFIX, type SystemActionResult } from '../harness/routines/system-actions';
import { clearStaleReaperLastError } from './dbos-executor-reaper';
import { loopPressure } from '../event-loop-lag-monitor';
import { poolPressure, recordPoolShed, lastPoolProbeMs } from './pool-pressure';
// Side-effect import: registers every `system:<action>` handler before the first tick.
import '../harness/routines/register-system-actions';
// Side-effect import (F-E1 phase 1): wire papercusp-routines-per-workspace into the routines lib.
import '../harness/routines/configure-per-workspace';
import { operatorApiBase } from '../operator-api-base';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB || '*/30 * * * * *';
const operatorBase = operatorApiBase;

const routinesQueue = new WorkflowQueue(ROUTINES_QUEUE, { concurrency: queueConcurrency(4) });
// Protected lane for critical QUICK routines (git-sync) — a saturated shared `routines` queue (long
// routines holding every slot) must never starve fleet-wide persistence (the 2026-06-23 7h commit-freeze).
// Low concurrency: git-sync fires are quick AND serializing them avoids git-index contention across the
// per-hive git-sync routines. Instantiated at module load so DBOS listens on it; fires route here via
// queueForRoutine(). Both names exported so a boot/deploy check can assert DBOS is listening on each.
const routinesCriticalQueue = new WorkflowQueue(ROUTINES_CRITICAL_QUEUE, { concurrency: queueConcurrency(2) });
export const ROUTINE_FIRE_QUEUES = [routinesQueue.name, routinesCriticalQueue.name] as const;

/** Hard ceiling on one routine fire — the dedup-ID release valve (exported for tests). */
export const ROUTINE_FIRE_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * One durable fire of a routine: dispatch by target inside the routine's
 * workspace scope. A workflow (not just a step) so a crash mid-fire resumes; the
 * dedup ID on enqueue guards single-fire.
 */
async function routineFireImpl(
  routineId: string,
  workspaceId: string,
  installSlug: string,
  targetRole: string,
  triggerConfig: Record<string, unknown>,
  payloadTemplate: Record<string, unknown> | null,
  // loop-routines-interval-recurrence-2026-06-20 (B-LOOP-3): a LOOP routine carries an
  // interval + a bound owner (su-d5a84's B-LOOP-1 schema). These are appended (optional on
  // older enqueued fires recovered after deploy → undefined → the non-loop dispatch, which
  // is correct: a non-loop routine has no interval anyway).
  routineName?: string,
  rescheduleIntervalSec?: number | null,
  targetOwnerId?: string | null,
): Promise<void> {
  await runWithWorkspace(workspaceId, async () => {
    // Checkpoint immediately so the executor reaper can distinguish "workflow
    // never entered user code" from a legitimate long-running first action.
    await DBOS.runStep(
      async () => ({
        routineId,
        workspaceId,
        installSlug,
        targetRole,
        routineName: routineName ?? routineId,
      }),
      { name: 'routine-fire-start' },
    );

    // LOOP fire (B-LOOP-3 / P-004, D-005/D-006): a loop wakes its pinned session WARM instead
    // of spawning a role / running a system action. Identified by an interval + a bound owner;
    // the fire delivers a `coord` wake (rides the existing wake-executor liveness ladder — NO
    // new resume code) gated by the failure-streak fire-gate AND the cost-cap. Tracking rides
    // recordFire + the work-queue + plan progress (no per-fire plan_run, D-006). Takes
    // precedence over the system/role dispatch below.
    if (rescheduleIntervalSec != null && targetOwnerId) {
      await DBOS.runStep(
        async () => {
          const res = await fireLoopWake({
            routineId,
            routineName: routineName ?? routineId,
            workspaceId,
            installSlug,
            targetOwnerId,
            payloadTemplate,
          });
          if (!res.fired) {
            console.warn(`[routines] loop ${routineId} fire WITHHELD (${res.reason}: ${res.detail ?? ''})`);
          }
        },
        { name: 'loop:wake' },
      );
    } else if (targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
      const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
      const entry = getSystemActionEntry(action);
      let actionResult: SystemActionResult | undefined;
      if (entry?.ownSteps) {
        // WI-1416 (bg-host-freeze-eventloop-stall P-006): a multi-step action (git-sync)
        // runs at the WORKFLOW layer so its internal DBOS.runStep sub-steps each record
        // an operation_output — the executor reaper sees genuine progress (function_id
        // > 0) instead of one opaque long step, and a crashed/reaped fire resumes from
        // its last checkpoint instead of redoing the whole action. (Wrapped in the
        // single step below, DBOS.runStep silently degrades to a plain call — isInStep()
        // → direct execution, no checkpoint — which was exactly the WI-1415 stall.)
        // Same last_error bookkeeping as the single-step path, each half its own step
        // so a replay never re-runs the SQL.
        const { sql } = getOrgPg();
        try {
          actionResult = (await entry.fn({ installSlug, workspaceId, triggerConfig, payloadTemplate })) ?? undefined;
          await DBOS.runStep(
            async () => {
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source',
                       updated_at = now()
                 WHERE id = ${routineId} AND metadata->>'last_error_source' = 'runner'`.catch(() => {});
            },
            { name: `system:${action}:settle` },
          );
        } catch (e) {
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 600);
          await DBOS.runStep(
            async () => {
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('last_error', ${msg}::text, 'last_error_at', now()::text, 'last_error_source', 'runner'),
                       updated_at = now()
                 WHERE id = ${routineId}`.catch(() => {});
            },
            { name: `system:${action}:settle` },
          );
          throw e;
        }
      } else {
        actionResult = await DBOS.runStep(
          async (): Promise<SystemActionResult | undefined> => {
            const fn = getSystemAction(action);
            if (!fn) {
              console.warn(`[routines] no handler registered for system:${action} (routine ${routineId}) — skipping`);
              return undefined;
            }
            // Record a throw in `routines.metadata.last_error` so a silently-wedged
            // system action is visible (the improvement-watchdog's `routine-failure`
            // collector reads exactly this key — before, only git-sync wrote it).
            // Tagged `last_error_source:'runner'` so the success-path clear never
            // wipes an error an action manages ITSELF (git-sync records its own).
            const { sql } = getOrgPg();
            try {
              const result = await fn({ installSlug, workspaceId, triggerConfig, payloadTemplate });
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source',
                       updated_at = now()
                 WHERE id = ${routineId} AND metadata->>'last_error_source' = 'runner'`.catch(() => {});
              // Carry the action's durable-spawn requests out of the step so the
              // workflow layer can start them (EI-403-A) — a child workflow cannot
              // start from inside this step. Checkpointed return ⇒ replay-safe.
              return result ?? undefined;
            } catch (e) {
              const msg = (e instanceof Error ? e.message : String(e)).slice(0, 600);
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('last_error', ${msg}::text, 'last_error_at', now()::text, 'last_error_source', 'runner'),
                       updated_at = now()
                 WHERE id = ${routineId}`.catch(() => {});
              throw e;
            }
          },
          { name: `system:${action}`, retriesAllowed: true, maxAttempts: 2, intervalSeconds: 15 },
        );
      }

      // EI-403-A: start any durable child fires the action requested, AT THE
      // WORKFLOW LAYER (we are back in routineFireImpl's body, NOT inside a step —
      // `startWorkflow` is legal here). Dynamic import mirrors launch-blueprint.ts,
      // keeping durable-spawn's workflow registration off the import path when DBOS
      // is inactive. Recovery-safe: `actionResult` is the step's checkpointed
      // return, so a replay re-drains the same requests and the stable per-request
      // idempotency keys dedup the re-fire.
      if (actionResult?.durableSpawns?.length) {
        const { startDurableSpawns } = await import('./durable-spawn');
        const { enqueued, total } = await startDurableSpawns(actionResult.durableSpawns);
        console.log(
          `[routines] system:${action} (routine ${routineId}) → ${enqueued}/${total} durable spawn(s) enqueued at the workflow layer`,
        );
      }
    } else {
      // Agent-role routine: kick off the role for this harness via the invoke route
      // (the same autonomous launch path the git-sync merge-resolver spawn uses).
      // Fire-and-forget — the agent runs detached and the next due tick re-fires;
      // this matches the routine cadence model.
      await DBOS.runStep(async () => {
        // P-009 (D-009): the error-backoff fire gate + outcome recording — a
        // repeatedly-failing role fire backs off exponentially instead of
        // re-firing at full cadence (circuit-open ⇒ ~one probe per cap window).
        const gate = await checkFireGate(installSlug, targetRole);
        if (!gate.allow) {
          console.warn(
            `[routines] ${installSlug}/${targetRole} fire WITHHELD (${gate.reason}, ` +
              `consecutive_errors=${gate.consecutiveErrors}, retry in ~${gate.retryAfterSec}s)`,
          );
          return;
        }
        const kickoff =
          typeof payloadTemplate?.kickoff === 'string'
            ? payloadTemplate.kickoff
            : `Scheduled routine '${routineId}' (role ${targetRole}).`;
        const ws = encodeURIComponent(workspaceId);
        const url = `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(targetRole)}&ws=${ws}`;
        void recordFire(installSlug, targetRole, 'firing', 'attempt').catch(() => {});
        void loopbackFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kickoff }),
        })
          .then(
            (r) =>
              recordFire(installSlug, targetRole, r.ok ? 'ok' : `error: HTTP ${r.status}`, r.ok ? 'ok' : 'error'),
            (e) => {
              const detail = String(e instanceof Error ? e.message : e).slice(0, 180);
              console.warn(`[routines] role spawn failed (${installSlug}/${targetRole}): ${detail}`);
              return recordFire(installSlug, targetRole, `error: ${detail}`, 'error');
            },
          )
          .catch(() => {});
      }, { name: `spawn:${targetRole}` });
    }

    // A completed dispatch (loop:wake / system:<action> / spawn:<role>) produced DBOS
    // operation output, which DISPROVES any prior reaper verdict of "produced no DBOS
    // operation output" for THIS routine. Clear a stale reaper-sourced last_error so the
    // improvement-watchdog's routine-failure collector stops re-filing "routine is
    // failing" bugs for a routine that has already self-healed (EI-5938 + 25+ phantom
    // routines: loop-su-* + system routines leaked the reaper marker forever — the loop
    // branch returned before any metadata clear, and the system success-clear was scoped
    // to last_error_source='runner'). Source-scoped in the helper, so a runner-sourced
    // action error and git-sync's own no-source error are preserved, and a genuinely
    // wedged routine (fire keeps getting reaped, never completing this step) still
    // surfaces. Rides its own durable step so a mid-fire crash replays it; fail-soft.
    await DBOS.runStep(
      async () => {
        const { sql } = getOrgPg();
        await clearStaleReaperLastError(sql, routineId);
      },
      { name: 'clear-reaper-last-error' },
    );
  });
}

export const routineFireWorkflow = DBOS.registerWorkflow(routineFireImpl, {
  name: 'routineFire',
  maxRecoveryAttempts: 5,
});

/** The scheduled tick: list due routines, claim + enqueue a deduped fire for each. */
async function routinesTickImpl(): Promise<void> {
  // P-001 complement (bg-host-freeze-eventloop-stall-2026-06-30): the per-workflow
  // shedding in tick-load-shed.ts already sheds OTHER heavy periodic tasks at
  // ELEVATED (≥120ms p95). Apply the same gate HERE so that, under sustained loop
  // pressure, the scheduler itself doesn't pile PG work (listDueCronRoutines +
  // per-routine claimDueRoutine + DBOS.startWorkflow per routine) onto an already-
  // saturated event loop. DBOS skip-missed semantics mean we never back-fill a
  // skipped tick — each 30s window is independent. git-sync is on the CRITICAL
  // queue so a few skipped ticks at most delay a commit by one cadence; the
  // executor reaper will also clear any PENDING dead-executor wedge during this
  // window. Only shed when ELEVATED (not just CRITICAL) to match P-001.
  const pressure = loopPressure();
  if (pressure !== 'ok') {
    console.warn(`[routines-tick] SKIPPED — event loop ${pressure}, shedding scheduler tick (P-001)`);
    return;
  }
  // P-006/W4 (D-002/D-003): symmetric PG-CONNECTION-POOL shed. The loopPressure() gate
  // above covers the event-loop freeze mode; POOL STARVATION is the OTHER (the real
  // ~8× Jul 1-2 root cause) and had no guard. If a trivial acquire+`SELECT 1` against
  // the org pool is critically slow, every PG sweep below would block the same way and
  // pile MORE work onto an already-exhausted pool — freezing git-sync (enqueued at the
  // tick top) with it, then a silent bghost-watchdog restart. Shed + COUNT instead, so
  // the starvation becomes a loud counted signal (the bghost-watchdog stays the backstop;
  // the dead-routine detector still catches a sustained freeze — this adds attribution).
  // Fail-soft: poolPressure() returns 'ok' on any probe error (never shed on no signal).
  const pool = await poolPressure();
  if (pool === 'critical') {
    const shedCount = recordPoolShed();
    console.warn(
      `[routines-tick] SKIPPED — PG pool starvation (acquire+SELECT1 probe ${lastPoolProbeMs()}ms ≥ critical), shedding scheduler tick (P-006/W4); pool-shed #${shedCount}`,
    );
    return;
  }
  const { sql } = getOrgPg();
  const due = await DBOS.runStep(() => listDueCronRoutines(sql), { name: 'list-due-routines' });
  for (const r of due) {
    const claimed = await DBOS.runStep(() => claimDueRoutine(sql, r), { name: 'claim-routine' });
    if (!claimed) continue;
    try {
      await DBOS.startWorkflow(routineFireWorkflow, {
        // routines-queue-starvation fix (2026-06-23): git-sync → the protected `routines-critical` lane so a
        // saturated shared queue can't starve commits; every other routine → the shared `routines` queue.
        queueName: queueForRoutine(r.targetRole),
        enqueueOptions: { deduplicationID: `routine:${r.id}` },
        // A fire PENDING on a DEAD executor holds this dedup ID forever (DBOS
        // recovery is per-executor), silently collapsing every later fire while
        // claimDueRoutine keeps bumping last_fired_at — the routine looks alive
        // but never runs (gym-cycle wedged 7.5h on a dead repro host,
        // 2026-06-12). The timeout is the release valve: DBOS cancels the
        // workflow at the deadline, freeing the dedup. Ceiling sized above the
        // longest legitimate in-process action (a real gym cycle, ≲90 min).
        timeoutMS: ROUTINE_FIRE_TIMEOUT_MS,
      })(
        r.id,
        r.workspaceId,
        r.installSlug,
        r.targetRole,
        r.triggerConfig,
        r.payloadTemplate ?? null,
        // B-LOOP-3: the loop fields (su-d5a84's B-LOOP-1 RoutineRow seam) route the fire to
        // the warm-wake branch when present.
        r.name,
        r.rescheduleIntervalSec ?? null,
        r.targetOwnerId ?? null,
      );
    } catch (e) {
      // Already enqueued/active for this routine — collapse (back-pressure).
      if (!/Duplicat/i.test(String(e))) throw e;
    }
  }

  // Loop completion-rebase (B-LOOP-2) — its OWN step, FIRST after the fire loop
  // (Task-#8 / su-cold-auto 2026-07-03): a loop fire parks at next_fire_at='infinity'
  // and stays parked until this rebase re-arms it, so the rebase is as
  // liveness-critical as the fires themselves. It used to ride at the TAIL of
  // reconcileAndGovern (position #10 of 11 serial sweeps below) — under pool
  // starvation the earlier sweeps starved it and armed loops sat parked ~17 min
  // between 60s wakes while fires for other routines kept flowing. Placing it
  // here bounds its delay to the fire loop only. Fail-soft: a rebase failure
  // must never block the watchdog sweeps below.
  await DBOS.runStep(
    async () => {
      try {
        const { reconcileLoopRoutines } = await import('../harness/routines/reconcile-loop-routines');
        const loop = await reconcileLoopRoutines({ sql });
        // WI-1399: loops auto-paused because their owner is permanently unreachable.
        // Loud, not silent — a terminated loop is a real dead-owner finding.
        if (loop.terminated.length > 0) {
          console.warn(
            `[loop-reconcile] terminated ${loop.terminated.length} dead-owner loop(s) this pass: ${loop.terminated
              .map((t) => `${t.id} (owner ${t.targetOwnerId})`)
              .join(', ')}`,
          );
        }
      } catch (e) {
        console.warn(`[loop-reconcile] rebase pass failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'loop-rebase-sweep' },
  );

  // start-hive-wake-orchestration P-011 / D-003: the hive liveness sweep — a
  // deterministic, zero-token dead-man's-switch check riding this existing 30s
  // tick (NOT a cadence: the wake it may arm is the exception path). Started +
  // demand + no wake armed + not mid-turn + stale → arm the fallback sleep.
  // Fail-soft inside the module; one durable step so a crash mid-sweep resumes.
  await DBOS.runStep(
    async () => {
      const { hiveWatchdogSweep } = await import('../hive/watchdog');
      const results = await hiveWatchdogSweep();
      for (const res of results) {
        if (res.outcome === 'armed' || res.outcome === 'staged') {
          console.warn(`[hive-watchdog] tick ${res.outcome} a fallback wake: ${res.reason}`);
        }
      }
    },
    { name: 'hive-watchdog-sweep' },
  );

  // autonomous-loop-canary-reliability-2026-06-29 P-003: the PAUSED-hive recovery
  // sweep. The started-only seam above skips a paused hive, so a hive PAUSED while
  // work is queued was a SILENT outage (the daily canary went unfulfilled for days
  // with no alert and no recovery). This sweep alerts the owner and (unless
  // disabled via PAPERCUSP_HIVE_PAUSED_AUTO_RESUME=off) auto-resumes a hive paused
  // past the stale threshold WITH demand. Kill switch: PAPERCUSP_HIVE_PAUSED_
  // RECOVERY_SEC<=0. Debounced + fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { pausedHiveRecoverySweep } = await import('../hive/watchdog');
      const results = await pausedHiveRecoverySweep();
      for (const res of results) {
        if (res.outcome === 'resumed' || res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[hive-watchdog] paused-recovery ${res.outcome}: ${res.installSlug} — ${res.reason}`);
        }
      }
    },
    { name: 'hive-paused-recovery-sweep' },
  );

  // overwatch-role-2026-06-15 B-09 / D-004: the OVERWATCH liveness sweep — the
  // who-watches-the-watcher backstop, the same deterministic dead-man's switch as
  // the hive sweep above but for the overwatch supervisor's own wake channel. It
  // self-gates on the `papercusp-overwatch` flag + B-07's started bit
  // (`listGuardedOverwatches` is empty when off ⇒ inert), so this is a near-free
  // no-op until the role is activated. Fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { overwatchWatchdogSweep } = await import('../overwatch/watchdog');
      const results = await overwatchWatchdogSweep();
      for (const res of results) {
        if (res.outcome === 'armed') {
          console.warn(`[overwatch-watchdog] tick armed a fallback wake: ${res.reason}`);
        }
      }
    },
    { name: 'overwatch-watchdog-sweep' },
  );

  // queen-autonomous-execution-2026-06-13 B-09 (P-020/P-021/P-022): the placement
  // COMPLETION watchdog — the liveness watchdog above keeps the QUEEN awake; this
  // guarantees every unit she PLACED reaches terminal. Same deterministic dead-
  // man's-switch shape (a recovery wake / cursed-item or stranded-blocker
  // escalation is the exception path, not a cadence). Runs before the throughput
  // tick so its placement-state is fresh for the metrics. Fail-soft inside the
  // module; one durable step so a crash mid-sweep resumes.
  await DBOS.runStep(
    async () => {
      const { reconcileHivePlacements } = await import('../hive/placement-watchdog');
      const results = await reconcileHivePlacements();
      for (const res of results) {
        if (res.decision === 'recover' || res.decision === 'breaker' || res.decision === 'stranded') {
          console.warn(
            `[hive-placement-watchdog] tick ${res.decision} ${res.workItemId}` +
              `${res.detail ? ` (${res.detail})` : ''}`,
          );
        }
      }
    },
    { name: 'hive-placement-watchdog-sweep' },
  );

  // queen-scout-feedback-loop-2026-06-20 D-003 #2 (hardening): the scout-draft REVIEW
  // backstop. The Scout produces drafts on a friction-OR-idle cadence but pings the
  // Queen with a NO-WAKE durable message, so review only happens on an IDLE wake — and
  // a saturated hive (Queen never idle) starves scout-routed drafts (neither ratified
  // nor deprecated). This sweep finds drafts unreviewed past a deadline and fires ONE
  // debounced WAKE to the live Queen, moving review onto the FRICTION path. It NEVER
  // ratifies/deprecates (the Queen still disposes). Same deterministic dead-man's-switch
  // shape (the wake is the exception path). Default-safe; kill switch:
  // PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC<=0. Debounced + fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { scoutDraftReviewSweep } = await import('../scout/draft-review-watchdog');
      const results = await scoutDraftReviewSweep();
      for (const res of results) {
        if (res.outcome === 'nudged' || res.outcome === 'error') {
          console.warn(`[scout-draft-review] ${res.outcome}: ${res.installSlug} — ${res.reason}`);
        }
      }
    },
    { name: 'scout-draft-review-sweep' },
  );

  // WI-1574 (2026-07-02): the ready-plan AUTOSTART sweep — the missing CONSUMER of
  // the review loop's `ready` terminal. The Queen ratified scout drafts to 'ready'
  // and the chain stopped: nothing ran plans:start, so promotePlanItems never ran,
  // so ZERO work_items ever sourced from a scout plan (the plan rail was a dead
  // end — all 6 routes pending since 06-11). This sweep auto-starts ratified
  // (ready, never-started) scout plans in the hive's OWN workspace (plans:start's
  // UPDATE is pinned to the default workspace and misses scout rows) and promotes
  // their items into the Queen's surveyable frontier; a ratified-but-ITEMLESS plan
  // gets a debounced decompose-wake instead. Fail-soft; kill switch:
  // PAPERCUSP_SCOUT_READY_AUTOSTART=0.
  await DBOS.runStep(
    async () => {
      const { scoutReadyAutostartSweep } = await import('../scout/ready-plan-autostart');
      const results = await scoutReadyAutostartSweep();
      for (const res of results) {
        if (res.outcome !== 'skipped') {
          console.warn(
            `[scout-ready-autostart] ${res.outcome}: ${res.installSlug}${res.planSlug ? ` ${res.planSlug}` : ''} — ${res.reason}`,
          );
        }
      }
    },
    { name: 'scout-ready-autostart-sweep' },
  );

  // WI-1623: the release-deploy STALENESS recurrence guard. The green pin can sit
  // deployable-but-not-live far past the documented ≤15-min auto-deploy cadence with
  // NOTHING catching it (confirmed live: a stuck `deployedAt` display field went
  // unnoticed for ~a month even though the gate/pin were otherwise healthy — see the
  // work-item + release-deploy-staleness-watchdog.ts's header for the full root
  // cause). This sweep alerts (debounced, via the shared hive_watchdog_fires ledger)
  // whenever the green pin has been deployable-but-not-live longer than the
  // threshold. Never ships/restarts anything itself — alert only. Fail-soft;
  // kill switch: PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC<=0.
  await DBOS.runStep(
    async () => {
      const { releaseDeployStalenessSweep } = await import('../release-deploy-staleness-watchdog');
      const result = await releaseDeployStalenessSweep({});
      if (result.outcome === 'alerted' || result.outcome === 'error') {
        console.warn(`[release-deploy-staleness] ${result.outcome}: ${result.reason}`);
      }
    },
    { name: 'release-deploy-staleness-sweep' },
  );

  // queen-memory-hybrid-2026-07-02 L1b — agent_facts hygiene: hard-delete facts
  // expired/retracted >30d (bounded audit trail). Fail-soft like every sweep here.
  await DBOS.runStep(
    async () => {
      try {
        const { sweepExpiredFacts } = await import('../agent-facts/store');
        await sweepExpiredFacts();
      } catch (e) {
        console.warn(`[agent-facts] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'agent-facts-expiry-sweep' },
  );

  // GYM-2 (gym-unwedge-scout-novelty-2026-07-02): the chronic-autoloop-failure
  // escalator — a cycle red >= threshold consecutive fires files ONE observation
  // per 24h per (harness, role). The fire-gate backoff slows a failing cycle;
  // this SURFACES it (the gym sat 12 days dead with 72 errors and no witness).
  await DBOS.runStep(
    async () => {
      const { autoloopChronicFailureSweep } = await import('../harness/routines/autoloop-chronic-failure');
      const results = await autoloopChronicFailureSweep();
      for (const r of results) {
        if (r.outcome !== 'debounced') {
          console.warn(`[autoloop-chronic] ${r.outcome}: ${r.role}@${r.harnessSlug} — ${r.reason.slice(0, 160)}`);
        }
      }
    },
    { name: 'autoloop-chronic-failure-sweep' },
  );

  // scheduled-recurring-plans-2026-06-16 (Phase 5) — the scheduled-plan RUN completion +
  // governance sweep. A `system:plan-run` fire mints a plan_runs row at status='running' +
  // work_items; nothing settled the run when those finished, and the cost-cap / failure-streak
  // auto-pause only act on a SETTLED run. reconcile-plan-runs.ts was implemented + tested but
  // never wired (EI: its doc claimed "called before the plans:runs read + by the tick" — it
  // wasn't), so scheduled runs stayed `running` forever and the governance never fired. Ride the
  // 30s tick like the watchdog sweeps above: settle every running scheduled run whose work_items
  // are terminal, then auto-pause a template that breached its costCapCents or failure streak.
  // Best-effort (a sweep failure must never fail the loop it watches) + one durable step.
  await DBOS.runStep(
    async () => {
      try {
        const { reconcileAndGovern } = await import('../harness/routines/reconcile-plan-runs');
        const { reconciled, paused } = await reconcileAndGovern();
        if (reconciled > 0 || paused.length > 0) {
          console.warn(
            `[plan-run-reconcile] tick settled ${reconciled} scheduled run(s)` +
              (paused.length ? `, auto-paused ${paused.length} schedule(s): ${paused.join(', ')}` : ''),
          );
        }
      } catch (e) {
        console.warn(`[plan-run-reconcile] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'plan-run-reconcile-sweep' },
  );

  // queen-autonomous-execution B-11 / P-050: hive THROUGHPUT instrumentation —
  // one snapshot tick per started hive, riding the same 30s sweep. Records the
  // six metrics (frontier depth, placements/wake, busy-vs-cap, stuck, MTTC,
  // question-rung split) to hive_throughput_ticks (mig 261) and files an FB-21
  // breach signal on saturation/stuck. Best-effort + one durable step so a crash
  // resumes; observability must never fail the loop it watches.
  await DBOS.runStep(
    async () => {
      // K1 (workspace-scoped-coordination P-003): one throughput tick per
      // workspace loop when WORKSPACE_COORDINATION is ON; the raw per-hive set
      // (byte-identical) when OFF.
      const [{ listStartedWorkspaceLoops }, { recordHiveThroughputTick }] = await Promise.all([
        import('../hive/started'),
        import('../hive/throughput'),
      ]);
      for (const { workspaceId, installSlug } of await listStartedWorkspaceLoops()) {
        await recordHiveThroughputTick({ workspaceId, hiveSlug: installSlug }).catch(() => {});
      }
    },
    { name: 'hive-throughput-tick' },
  );
}

const routinesTickWorkflow = DBOS.registerWorkflow(routinesTickImpl, { name: 'routinesTick' });

// Scheduled fn must also be a registered workflow. Default skip-missed mode.
DBOS.registerScheduled(routinesTickWorkflow, { name: 'routinesTick', crontab: TICK_CRONTAB });
