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
import { getSystemAction, SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';
// Side-effect import: registers every `system:<action>` handler before the first tick.
import '../harness/routines/register-system-actions';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB || '*/30 * * * * *';
const operatorBase = (): string => process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

const routinesQueue = new WorkflowQueue('routines', { concurrency: 4 });

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
): Promise<void> {
  await runWithWorkspace(workspaceId, async () => {
    if (targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
      const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
      await DBOS.runStep(
        async () => {
          const fn = getSystemAction(action);
          if (!fn) {
            console.warn(`[routines] no handler registered for system:${action} (routine ${routineId}) — skipping`);
            return;
          }
          await fn({ installSlug, workspaceId, triggerConfig, payloadTemplate });
        },
        { name: `system:${action}`, retriesAllowed: true, maxAttempts: 2, intervalSeconds: 15 },
      );
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
      })(r.id, r.workspaceId, r.installSlug, r.targetRole, r.triggerConfig, r.payloadTemplate ?? null);
    } catch (e) {
      // Already enqueued/active for this routine — collapse (back-pressure).
      if (!/Duplicat/i.test(String(e))) throw e;
    }
  }
}

const routinesTickWorkflow = DBOS.registerWorkflow(routinesTickImpl, { name: 'routinesTick' });

// Scheduled fn must also be a registered workflow. Default skip-missed mode.
DBOS.registerScheduled(routinesTickWorkflow, { name: 'routinesTick', crontab: TICK_CRONTAB });
