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
import { getOrgPg, listDueCronRoutines, type RoutineRow } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { runWithWorkspace } from '../workspace-als';
import { loopbackFetch } from '../loopback-fetch';
import { computeNextFireAt } from '../harness/routines/cron';
import { getSystemAction, SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';
// Side-effect import: registers every `system:<action>` handler before the first tick.
import '../harness/routines/register-system-actions';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB || '*/30 * * * * *';
const operatorBase = (): string => process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

const routinesQueue = new WorkflowQueue('routines', { concurrency: 4 });

/**
 * Atomically claim a due routine: advance `next_fire_at` to its next cron time
 * ONLY if it is still active + due. The `WHERE active AND (next_fire_at IS NULL
 * OR next_fire_at <= now())` guard means exactly one racing tick wins the claim;
 * a loser sees zero rows updated and skips. Returns whether this tick claimed it.
 *
 * A cron-kind routine WITHOUT a cron expression is a ONE-SHOT (a self-declared
 * wake at an explicit `next_fire_at` — the pot's `pot-wake` routine,
 * autoloop-pot-operator-rebuild D-002): claiming it DEACTIVATES it. Setting
 * `next_fire_at = NULL` while leaving it active would make it due again on the
 * very next tick — an infinite refire loop.
 */
async function claimDueRoutine(sql: Sql, routine: RoutineRow): Promise<boolean> {
  const cron = routine.triggerConfig?.cron;
  if (!cron) {
    const rows = await sql<{ id: string }[]>`
      UPDATE harness_shared.routines
         SET last_fired_at = now(),
             next_fire_at = NULL,
             active = FALSE,
             updated_at = now()
       WHERE id = ${routine.id}
         AND active = TRUE
         AND (next_fire_at IS NULL OR next_fire_at <= now())
      RETURNING id
    `;
    return rows.length > 0;
  }
  const next = computeNextFireAt(cron, new Date());
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET last_fired_at = now(),
           next_fire_at = ${next ? next.toISOString() : null}::timestamptz,
           updated_at = now()
     WHERE id = ${routine.id}
       AND active = TRUE
       AND (next_fire_at IS NULL OR next_fire_at <= now())
    RETURNING id
  `;
  return rows.length > 0;
}

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
      // (the same autonomous launch path the autoloop's fireDirector + the git-sync
      // merge-resolver spawn use). Fire-and-forget — the agent runs detached and the
      // next due tick re-fires; this matches the routine cadence model.
      await DBOS.runStep(async () => {
        const kickoff =
          typeof payloadTemplate?.kickoff === 'string'
            ? payloadTemplate.kickoff
            : `Scheduled routine '${routineId}' (role ${targetRole}).`;
        const ws = encodeURIComponent(workspaceId);
        const url = `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(targetRole)}&ws=${ws}`;
        void loopbackFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kickoff }),
        }).catch((e) =>
          console.warn(`[routines] role spawn failed (${installSlug}/${targetRole}): ${e instanceof Error ? e.message : e}`),
        );
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
