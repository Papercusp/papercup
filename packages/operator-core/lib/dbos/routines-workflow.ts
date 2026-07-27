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
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';
import {
  ROUTINES_QUEUE,
  ROUTINES_CRITICAL_QUEUE,
  queueForRoutine,
  shouldFireUnderPoolShed,
} from './routines-queue-classification';
import { getOrgPg, listDueCronRoutines } from '@papercusp/db-org';
import { runWithWorkspace } from '../workspace-als';
import { loopbackFetch } from '../loopback-fetch';
import { claimDueRoutine } from '../harness/routines/claim';
import { checkFireGate, recordFire } from '../autoloop';
import { fireLoopWake } from '../harness/routines/loop-fire';
import {
  getSystemAction,
  getSystemActionEntry,
  SYSTEM_TARGET_PREFIX,
  type SystemActionResult,
} from '../harness/routines/system-actions';
import { clearStaleReaperLastError } from './dbos-executor-reaper';
import { poolPressure, recordPoolShed, lastPoolProbeMs, recordPoolShedEvent } from './pool-pressure';
import { activeWorkspaceId } from '../workspace-registry';
import { shouldShedSchedulerTickUnderLoopPressure } from './tick-load-shed';
import { anotherRoutinesTickInFlight } from './routine-tick-overlap-guard';
// Side-effect import: registers every `system:<action>` handler before the first tick.
import '../harness/routines/register-system-actions';
// Side-effect import (F-E1 phase 1): wire papercusp-routines-per-workspace into the routines lib.
import '../harness/routines/configure-per-workspace';
import { operatorApiBase } from '../operator-api-base';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB || '*/30 * * * * *';
const operatorBase = operatorApiBase;

// WI-4015 (critical, 2026-07-11): idempotentWorkflowQueue guards against a second
// top-level module evaluation throwing "Workflow Queue '<name>' defined multiple
// times" inside startDbos()'s import chain — a failure that host-bootstrap.ts's
// caller only logs as "[dbos] boot failed (non-fatal)" and swallows, silently
// preventing DBOS.launch() (and therefore routinesTick itself) from ever arming.
// See idempotent-register-workflow.ts's doc comment for the full incident story.
const routinesQueue = idempotentWorkflowQueue(
  ROUTINES_QUEUE,
  () => new WorkflowQueue(ROUTINES_QUEUE, { concurrency: queueConcurrency(4) }),
);
// Protected lane for critical QUICK routines (git-sync) — a saturated shared `routines` queue (long
// routines holding every slot) must never starve fleet-wide persistence (the 2026-06-23 7h commit-freeze).
// Low concurrency: git-sync fires are quick AND serializing them avoids git-index contention across the
// per-hive git-sync routines. Instantiated at module load so DBOS listens on it; fires route here via
// queueForRoutine(). Both names exported so a boot/deploy check can assert DBOS is listening on each.
const routinesCriticalQueue = idempotentWorkflowQueue(
  ROUTINES_CRITICAL_QUEUE,
  () => new WorkflowQueue(ROUTINES_CRITICAL_QUEUE, { concurrency: queueConcurrency(2) }),
);
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
            intervalSec: rescheduleIntervalSec,
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
      await DBOS.runStep(
        async () => {
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
        },
        { name: `spawn:${targetRole}` },
      );
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

export const routineFireWorkflow = idempotentRegisterWorkflow('routineFire', () =>
  DBOS.registerWorkflow(routineFireImpl, {
    name: 'routineFire',
    maxRecoveryAttempts: 5,
  }),
);

/** The scheduled tick: list due routines, claim + enqueue a deduped fire for each. */
async function routinesTickImpl(): Promise<void> {
  // WI-3351: routinesTick is the LIGHTWEIGHT scheduler. Heavy periodic jobs
  // shed in tick-load-shed.ts, and routine bodies can self-gate; shedding this
  // root tick on loop pressure strands every due routine until the loop monitor
  // returns to ok. Keep the hook explicit so future policy changes are tested,
  // but the current policy never sheds on event-loop pressure.
  if (shouldShedSchedulerTickUnderLoopPressure()) {
    console.warn(`[routines-tick] SKIPPED — event loop pressure, shedding scheduler tick`);
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
  //
  // EI-11171 CRITICAL-ROUTINE FLOOR: a critical shed no longer goes fully dark. The original
  // bare `return` here skipped the ENTIRE fire loop below — including git-sync, which is fired
  // into the protected ROUTINES_CRITICAL_QUEUE precisely so it can NEVER be starved (its
  // starvation froze every commit + deploy for 7h on 2026-06-23). Shedding it too silently
  // re-armed that exact incident class. Instead we set `poolCritical` and fall through to a
  // MINIMAL pass: fire ONLY critical-queue routines (shouldFireUnderPoolShed), then return
  // before the heavy sweeps. Strictly additive — every non-critical fire + loop-rebase + the
  // heavy sweeps stay shed exactly as before, so the shed's protective behaviour is unchanged;
  // this only guarantees the must-never-starve lane survives (bounded to ~a few quick queries).
  const pool = await poolPressure();
  const poolCritical = pool === 'critical';
  if (poolCritical) {
    const shedCount = recordPoolShed();
    console.warn(
      `[routines-tick] PG pool starvation (acquire+SELECT1 probe ${lastPoolProbeMs()}ms ≥ critical) — shedding heavy sweeps; still firing CRITICAL-queue routines only (git-sync floor, EI-11171/P-006/W4); pool-shed #${shedCount}`,
    );
    // EI-13108 ask (2): durably record the shed (fire-and-forget — never await on an
    // already-starved pool) so instrument-staleness consumers can distinguish
    // "shed by this guardrail" from "dead" (migration 627).
    recordPoolShedEvent(activeWorkspaceId(), shedCount);
  }
  const { sql } = getOrgPg();

  // EI-9935: overlap guard. Confirmed live (2026-07-12 00:15-00:30 EDT): under
  // host/PG contention individual ticks ballooned from ~15-20s to 58-93s, and
  // — because nothing stopped a new tick from starting mid-flight — multiple
  // ticks ran CONCURRENTLY, each independently walking this same serial
  // PG-touching sweep chain and compounding the contention that slowed the
  // first one. That pile-up starved due routines (armed su loop wakes) past
  // the infra-liveness dead-routines >10m threshold. The loopPressure()/
  // poolPressure() sheds above gate a tick's OWN start against pressure at
  // that instant; they don't stop a SECOND tick starting once a first is
  // already past that gate and simply running long — this closes that gap
  // directly. Fail-soft + stale-safe (see routine-tick-overlap-guard.ts).
  if (
    await anotherRoutinesTickInFlight(DBOS.workflowID ?? '', {
      queryInFlight: (selfId, cutoffEpochMs) =>
        sql<{ workflow_uuid: string }[]>`
          SELECT workflow_uuid FROM dbos.workflow_status
           WHERE name = 'routinesTick'
             AND status = 'PENDING'
             AND workflow_uuid <> ${selfId}
             AND started_at_epoch_ms IS NOT NULL
             AND started_at_epoch_ms > ${cutoffEpochMs}
           LIMIT 1`,
    })
  ) {
    console.warn(`[routines-tick] SKIPPED — another routinesTick invocation already in flight (EI-9935 overlap guard)`);
    return;
  }

  const due = await DBOS.runStep(() => listDueCronRoutines(sql), { name: 'list-due-routines' });
  for (const r of due) {
    // EI-11171 critical-routine floor: under a pool-starvation shed, fire ONLY the protected
    // critical-queue routines (git-sync); everything else sheds with the heavy sweeps below.
    if (poolCritical && !shouldFireUnderPoolShed(r.targetRole)) continue;
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

  // EI-11171 critical-routine floor (cont.): under a pool-starvation shed the critical-queue
  // routines have now fired; skip the loop-rebase + heavy sweeps below (they stay shed exactly
  // as before this floor existed — the shed's protective behaviour is unchanged).
  if (poolCritical) return;

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
      const { potWatchdogSweep } = await import('../pot/watchdog');
      const results = await potWatchdogSweep();
      for (const res of results) {
        if (res.outcome === 'armed' || res.outcome === 'staged') {
          console.warn(`[hive-watchdog] tick ${res.outcome} a fallback wake: ${res.reason}`);
        }
      }
    },
    { name: 'pot-watchdog-sweep' },
  );

  // autonomous-loop-canary-reliability-2026-06-29 P-003: the PAUSED-hive recovery
  // sweep. The started-only seam above skips a paused hive, so a hive PAUSED while
  // work is queued was a SILENT outage (the daily canary went unfulfilled for days
  // with no alert and no recovery). This sweep alerts the owner and (unless
  // disabled via PAPERCUSP_POT_PAUSED_AUTO_RESUME=off) auto-resumes a hive paused
  // past the stale threshold WITH demand. Kill switch: PAPERCUSP_POT_PAUSED_
  // RECOVERY_SEC<=0. Debounced + fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { pausedPotRecoverySweep } = await import('../pot/watchdog');
      const results = await pausedPotRecoverySweep();
      for (const res of results) {
        if (res.outcome === 'resumed' || res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[hive-watchdog] paused-recovery ${res.outcome}: ${res.installSlug} — ${res.reason}`);
        }
      }
    },
    { name: 'pot-paused-recovery-sweep' },
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
        } else if (res.outcome === 'error') {
          // WI-3777: a per-item sweep failure used to be swallowed silently
          // (only the OUTER catch's generic "sweep failed" warned, with no
          // per-hive detail) — surface it at error level so a starved guarded
          // overwatch is visible in logs instead of just going quiet forever.
          console.error(`[overwatch-watchdog] tick sweep item errored: ${res.reason}`);
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
      const { reconcilePotPlacements } = await import('../pot/placement-watchdog');
      const results = await reconcilePotPlacements();
      for (const res of results) {
        if (res.decision === 'recover' || res.decision === 'breaker' || res.decision === 'stranded') {
          console.warn(
            `[hive-placement-watchdog] tick ${res.decision} ${res.workItemId}` +
              `${res.detail ? ` (${res.detail})` : ''}`,
          );
        }
      }
    },
    { name: 'pot-placement-watchdog-sweep' },
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

  // su-ideate-learning-substrate-2026-07-10 P-006: the ungraded su-filings GRADING
  // backstop — the scout-draft-review sweep's sibling, aimed at the routed-idea
  // ledger instead of draft plans. su-originated filings (origin='su-ideate') only
  // teach the learning substrate once GRADED (blender:grade-idea), but nothing made
  // grading happen; this sweep finds filings ungraded past a deadline (default 7d)
  // and fires ONE debounced nudge to the live Mug (event-key wake + durable
  // @role:mug park). It never grades anything itself. D-013: epoch floor + batch
  // cap keep the backfilled corpus out of triage. Default-safe; kill switch:
  // PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC<=0. Debounced + fail-soft inside the module.
  await DBOS.runStep(
    async () => {
      const { suIdeateUngradedConfig, suIdeateUngradedSweep } = await import('../scout/ungraded-filings-watchdog');
      const config = suIdeateUngradedConfig();
      const results = await suIdeateUngradedSweep();
      for (const res of results) {
        if (res.outcome === 'nudged' || res.outcome === 'error') {
          console.warn(`[su-ideate-ungraded] ${res.outcome}: ${res.installSlug} — ${res.reason}`);
        }
      }
      // DBOS persists runStep return values in operation_outputs. Returning a
      // compact semantic summary gives watchdog:status one authoritative record
      // of internal fail-soft errors; `void` previously made a swallowed sweep
      // failure look identical to a healthy empty run.
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        errorCount: results.filter((res) => res.outcome === 'error').length,
        nudgedCount: results.filter((res) => res.outcome === 'nudged').length,
        config,
        results: results.slice(0, 25),
      };
    },
    { name: 'su-ideate-ungraded-sweep' },
  );

  // blender-self-learning-2026-07-12 P-001 (WI-4317): the Scout SIGNAL-ACCUMULATOR
  // recount — the deterministic, zero-token substrate behind volume-based Scout
  // firing. Recounts per-lane "new signal since the last successful Scout cycle"
  // (rating changes / observations / captures / reverts / deferrals / completions)
  // from the source tables against a scout_ticks-derived watermark and caches the
  // counts in scout_signal_accumulator (migration 582); the cadence gate (P-002)
  // consumes them as a weighted score — score 0 never fires. Self-healing recount
  // (never incremented), in-process throttled (default 120s), fail-soft. Kill
  // switch: PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC<=0.
  await DBOS.runStep(
    async () => {
      const { scoutSignalAccumulatorSweep } = await import('../scout/signal-accumulator');
      const results = await scoutSignalAccumulatorSweep();
      for (const res of results) {
        if (res.outcome === 'error') {
          console.warn(`[signal-accumulator] error: ${res.installSlug} — ${res.reason}`);
        }
      }
    },
    { name: 'scout-signal-accumulator-sweep' },
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

  // autonomous-loop-prod-audit-2026-07-02 P-006 (SPOF 5a/5b, deferred from
  // WI-4626/AUDIT B): the Scout OUTCOME-REFRESH sweep — refreshScoutOutcomes
  // previously ran ONLY inside a Scout cycle (scout/scheduler.ts
  // refreshOutcomes()), so an idle/backed-off/dead Scout froze every routed
  // idea's cached outcome and silently stalled the per-lens weight learning.
  // This sweep decouples the refresh from Scout's own cadence (its own
  // in-process throttle, default 15min) and separately alerts (debounced via
  // the shared hive_watchdog_fires ledger) when routed ideas sit
  // outcome NULL/'pending' past a staleness threshold even after a refresh —
  // the "stuck forever, nobody noticed" failure class. Fail-soft; kill
  // switches: PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC<=0 (whole sweep),
  // PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC<=0 (alert only).
  await DBOS.runStep(
    async () => {
      const { scoutOutcomeRefreshSweep } = await import('../scout/outcome-refresh-sweep');
      const results = await scoutOutcomeRefreshSweep();
      for (const res of results) {
        if (res.outcome === 'error' || res.alerted) {
          console.warn(`[scout-outcome-refresh] ${res.outcome}: ${res.workspaceId} — ${res.reason}`);
        }
      }
    },
    { name: 'scout-outcome-refresh-sweep' },
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
  // EI-16537: it also PAGES now — urgent owner notifyAttention + a fleet severe-event
  // broadcast + a durable harness_escalations row, one-shot until recovery. The warn
  // below is only a local trace; it was for months the alert's ONLY destination, which
  // is how 96h of unshipped owner-facing code went unnoticed with the sweep firing
  // correctly the whole time.
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

  // rubric-system-hardening-2026-07-14 P-004 (EI-12149): the RUBRIC-STALENESS
  // watchdog — an ACTIVE releaseGating rubric with no COMPLETE scorecard within
  // the threshold window (default 6h) fires one debounced pot_watchdog_fires row
  // + a coord escalation. The blender-release-readiness rubric went ~14h ungraded
  // when its grader loop died silently and nothing paged; a release bar nobody is
  // grading is a silent gate, not a green one. Fail-soft; kill switch:
  // PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC<=0. Returns the per-rubric outcomes
  // so watchdog:status has one authoritative record.
  await DBOS.runStep(
    async () => {
      const { rubricStalenessSweep } = await import('../rubric-staleness-watchdog');
      const results = await rubricStalenessSweep();
      for (const res of results) {
        if (res.outcome === 'alerted' || res.outcome === 'error') {
          console.warn(`[rubric-staleness] ${res.outcome}: ${res.rubricRef} — ${res.reason}`);
        }
      }
      return {
        ranAtMs: Date.now(),
        resultCount: results.length,
        alertedCount: results.filter((r) => r.outcome === 'alerted').length,
        errorCount: results.filter((r) => r.outcome === 'error').length,
        results: results.slice(0, 10),
      };
    },
    { name: 'rubric-staleness-sweep' },
  );

  // hive-seed-bundle P-008 (D-007): the COLD-JOIN CANARY. Now that seeded installs
  // only carry the join DELTA (P-006/P-007), the full cold join (no seed, whole-
  // history transfer) stops being exercised on every install and can silently
  // bit-rot. This sweep forces a periodic REAL cold join (seed disabled) so the
  // cold path stays proven, and records/alerts pass-or-fail (debounced via the
  // shared hive_watchdog_fires ledger). DEFAULT DISABLED (a cold join is heavy) —
  // a canary/release env opts in via PAPERCUSP_COLD_JOIN_CANARY_INTERVAL_SEC. The
  // heavy executor (P-010 live-wire 3) is wired here: it resolves the registered
  // rig cold-join spawn at call time, so a non-rig host with the canary (deliberately)
  // enabled surfaces an honest 'error' alert instead of a fake pass. Fail-soft;
  // disabled ⇒ a complete no-op (the executor is never invoked below the interval gate).
  await DBOS.runStep(
    async () => {
      const { runColdJoinCanarySweep } = await import('../sync/hyperbee/cold-join-canary');
      const { defaultColdJoinExecutor } = await import('../sync/hyperbee/cold-join-executor');
      const result = await runColdJoinCanarySweep({ coldJoin: defaultColdJoinExecutor, log: (m) => console.warn(m) });
      if (result.outcome === 'failed' || result.outcome === 'error') {
        console.warn(`[cold-join-canary] ${result.outcome}: ${result.reason}`);
      }
    },
    { name: 'cold-join-canary-sweep' },
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

  // owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270): an
  // owner-gated WALL fact (facts:assert { slot:'wall' }) whose TTL expired
  // without being retracted pages LOUDLY instead of silently vanishing from
  // folds — TTL decay always fails toward "clear", the wrong direction for an
  // unremediated risk. Fail-soft like every sweep here; debounced per-fact
  // inside the sweep itself.
  await DBOS.runStep(
    async () => {
      try {
        const { wallLapseSweep } = await import('../wall-lapse-watchdog');
        const results = await wallLapseSweep();
        for (const r of results) {
          if (r.outcome === 'error') console.warn(`[wall-fact-lapse] error: ${r.key} — ${r.reason}`);
        }
      } catch (e) {
        console.warn(`[wall-fact-lapse] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'wall-fact-lapse-sweep' },
  );

  // unified-agent-state-plane-2026-07-27 P-010: the intent↔action divergence
  // detector (MAST FM-2.6). D-016 puts it in the STRUCTURAL tier and D-047 row
  // 15 records its enforcement as "they run on their own" — so it is a sweep,
  // never a tool: D-046 refuses another pull read over `tool_invocations`
  // (three exist, all three dead). Notifies the agent ITSELF first and the
  // leader only on a repeat; debounced per (owner, tool) inside the sweep.
  // The report is RETURNED (not just logged) so P-015's measurement step below can
  // consume the coverage this sweep already computed. Recomputing it there would
  // be a second read of `tool_invocations` in one tick AND a second derivation of
  // a quantity that already has one — the axis-5 violation (D-038) this plan has
  // ruled against repeatedly.
  const divergenceReport = await DBOS.runStep(
    async () => {
      try {
        const { divergenceSweep } = await import('../agent-state-divergence-sweep');
        const { outcomes, report } = await divergenceSweep();
        for (const o of outcomes) {
          if (o.outcome === 'error') console.warn(`[intent-action-divergence] error: ${o.key} — ${o.reason}`);
          else if (o.outcome === 'escalated') console.warn(`[intent-action-divergence] ${o.reason}`);
        }
        // The stamp fill rate is P-015's measurement and the one number that
        // says whether the stamped leg is alive yet — log it where a sweep is
        // already writing, so nobody has to run a query to find out.
        if (report && report.coverage.callsExamined > 0) {
          console.info(
            `[intent-action-divergence] examined ${report.coverage.callsExamined} calls, ` +
              `stampFillRate=${report.coverage.stampFillRate}, ` +
              `thrashRuns=${report.coverage.thrashRuns}/${report.coverage.failuresSeen} failures`,
          );
        }
        return report;
      } catch (e) {
        console.warn(`[intent-action-divergence] sweep failed: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    },
    { name: 'intent-action-divergence-sweep' },
  );

  // unified-agent-state-plane-2026-07-27 P-015: the plane's baseline + standing
  // measurement. A sweep for the same reason P-010 is one (D-046 refuses another
  // pull read over `tool_invocations`; D-091 §1 records the verdict as computed
  // and DELIVERED, with no browse surface).
  //
  // It records at most ONE reading per window — D-030 §3 requires at least two
  // batches before any trend is reported, because within-arm variance there
  // equalled between-arm variance, so a series of overlapping windows would be a
  // trend line made of duplicates.
  await DBOS.runStep(
    async () => {
      try {
        const { planeMeasurementSweep, formatMeasurementLog } = await import(
          '../agent-plane-measurement-sweep'
        );
        const out = await planeMeasurementSweep({ divergence: divergenceReport ?? null });
        if (out.outcome === 'error') console.warn(`[plane-measurement] ${out.reason}`);
        // Logged in full: the line leads with how much is MEASURABLE and names the
        // missing producer behind each structural zero, because "0 divergences, 0
        // conflicts" is the exact misread D-087/D-089 were written to prevent.
        else if (out.outcome === 'recorded') console.info(formatMeasurementLog(out.measurement));
      } catch (e) {
        console.warn(`[plane-measurement] sweep failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'agent-plane-measurement-sweep' },
  );

  // GYM-2 (gym-unwedge-scout-novelty-2026-07-02, generalized across roles by WI-4632):
  // the chronic-autoloop-failure escalator — a cycle red >= threshold consecutive fires
  // files ONE observation + requests an immediate overwatch wake, per 24h per (harness,
  // role). The fire-gate backoff slows a failing cycle; this SURFACES it (the gym sat
  // 12 days dead with 72 errors and no witness).
  await DBOS.runStep(
    async () => {
      const { autoloopChronicFailureSweep, shouldLogChronicOutcome } = await import(
        '../harness/routines/autoloop-chronic-failure'
      );
      const results = await autoloopChronicFailureSweep();
      for (const r of results) {
        if (r.outcome === 'debounced') continue;
        // EI-12968: a `skipped-*` outcome is rate-limited to once/hour per
        // (outcome, harness, role) — the sweep's decision stays correct + un-
        // throttled every tick; only this journal line was flooding (a frozen
        // watermark re-logged identically every ~30s, forever).
        if (!(await shouldLogChronicOutcome(r))) continue;
        console.warn(`[autoloop-chronic] ${r.outcome}: ${r.role}@${r.harnessSlug} — ${r.reason.slice(0, 160)}`);
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
      const [{ listStartedWorkspaceLoops }, { recordPotThroughputTick }] = await Promise.all([
        import('../pot/started'),
        import('../pot/throughput'),
      ]);
      for (const { workspaceId, installSlug } of await listStartedWorkspaceLoops()) {
        await recordPotThroughputTick({ workspaceId, potSlug: installSlug }).catch(() => {});
      }
    },
    { name: 'pot-throughput-tick' },
  );
}

const routinesTickWorkflow = idempotentRegisterWorkflow('routinesTick', () =>
  DBOS.registerWorkflow(routinesTickImpl, { name: 'routinesTick' }),
);

// Scheduled fn must also be a registered workflow. Default skip-missed mode.
DBOS.registerScheduled(routinesTickWorkflow, { name: 'routinesTick', crontab: TICK_CRONTAB });
