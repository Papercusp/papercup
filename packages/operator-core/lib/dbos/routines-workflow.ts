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
import { getOrgPg, listDueCronRoutines } from '@papercusp/db-org';
import { runWithWorkspace } from '../workspace-als';
import { loopbackFetch } from '../loopback-fetch';
import { claimDueRoutine } from '../harness/routines/claim';
import { checkFireGate, recordFire } from '../autoloop';
import { fireLoopWake } from '../harness/routines/loop-fire';
import { getSystemAction, SYSTEM_TARGET_PREFIX, type SystemActionResult } from '../harness/routines/system-actions';
// Side-effect import: registers every `system:<action>` handler before the first tick.
import '../harness/routines/register-system-actions';
// Side-effect import (F-E1 phase 1): wire papercusp-routines-per-workspace into the routines lib.
import '../harness/routines/configure-per-workspace';
import { operatorApiBase } from '../operator-api-base';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB || '*/30 * * * * *';
const operatorBase = operatorApiBase;

const routinesQueue = new WorkflowQueue('routines', { concurrency: 4 });

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
      return;
    }
    if (targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
      const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
      const actionResult = await DBOS.runStep(
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
  });
}

export const routineFireWorkflow = DBOS.registerWorkflow(routineFireImpl, {
  name: 'routineFire',
  maxRecoveryAttempts: 5,
});

/** The scheduled tick: list due routines, claim + enqueue a deduped fire for each. */
async function routinesTickImpl(): Promise<void> {
  const { sql } = getOrgPg();
  const due = await DBOS.runStep(() => listDueCronRoutines(sql), { name: 'list-due-routines' });
  for (const r of due) {
    const claimed = await DBOS.runStep(() => claimDueRoutine(sql, r), { name: 'claim-routine' });
    if (!claimed) continue;
    try {
      await DBOS.startWorkflow(routineFireWorkflow, {
        queueName: routinesQueue.name,
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
      const [{ listStartedHives }, { recordHiveThroughputTick }] = await Promise.all([
        import('../hive/started'),
        import('../hive/throughput'),
      ]);
      for (const { workspaceId, installSlug } of await listStartedHives()) {
        await recordHiveThroughputTick({ workspaceId, hiveSlug: installSlug }).catch(() => {});
      }
    },
    { name: 'hive-throughput-tick' },
  );
}

const routinesTickWorkflow = DBOS.registerWorkflow(routinesTickImpl, { name: 'routinesTick' });

// Scheduled fn must also be a registered workflow. Default skip-missed mode.
DBOS.registerScheduled(routinesTickWorkflow, { name: 'routinesTick', crontab: TICK_CRONTAB });
