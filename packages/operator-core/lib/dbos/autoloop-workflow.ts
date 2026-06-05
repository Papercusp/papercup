/**
 * Phase 1 of `dbos-durable-jobs-2026-05-31` — the AutoLoop ticker as a DBOS
 * scheduled workflow + a per-(harness, role) dedup-keyed fire queue.
 *
 * Replaces the in-process `setInterval` ticker (`autoloop.ts`) with durable
 * execution:
 *  - The tick is a **scheduled workflow** using the default **skip-missed**
 *    mode (NOT `ExactlyOncePerInterval`), so a desktop that was closed for
 *    hours does not backfill a storm of ticks at launch (D-009).
 *  - Each due (harness, role) fire is enqueued with a **deduplication ID**
 *    `autoloop:<slug>:<role>`, so it fires once even under concurrent ticks
 *    or processes (D-010 — single-fire comes from the dedup ID, not
 *    `concurrency=1`). A long fire naturally back-pressures: the next tick's
 *    enqueue is collapsed while the prior one is still active.
 *  - The fire itself is a workflow (record→fire→record as steps), so a crash
 *    mid-fire resumes rather than being lost.
 *
 * Flag-gated (D-011): registered only when `startDbos()` runs
 * (`PAPERCUSP_DBOS_ENABLE=1`) AND `PAPERCUSP_DBOS_AUTOLOOP=1`. The legacy
 * ticker (`startAutoLoopOnce`) stands down when `PAPERCUSP_DBOS_AUTOLOOP=1`,
 * so exactly one of the two fires — the A/B + instant-revert path.
 *
 * Spike-verified (gate2.mjs): the dedup ID collapses duplicate enqueues to a
 * single fire, and a scheduled fn fires on cadence once it is also registered
 * as a workflow.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  listHarnesses,
  readDirectorConfig,
  readHarnessConfig,
  shouldFire,
  recordFire,
  fireDirector,
} from '../autoloop';
import { runWithWorkspace } from '../workspace-als';
import { orchestratorWorkspaceIds } from './orchestrator-loop';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_AUTOLOOP_CRONTAB || '*/30 * * * * *';
const operatorBase = (): string => process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

const autoLoopQueue = new WorkflowQueue('autoloop', { concurrency: 4 });

// One durable fire of (workspace, slug, role): record→fire→record. A workflow
// so a crash mid-fire resumes; the dedup ID on enqueue guards single-fire.
//
// Phase E (P-020): `workspaceId` is an explicit arg, NOT read from the ALS —
// this workflow is DEQUEUED later, OUTSIDE the tick's runWithWorkspace scope, so
// `activeWorkspaceId()` would otherwise resolve the global. We re-establish the
// workspace scope here so the inner shouldFire/recordFire/fireDirector
// (which read `activeWorkspaceId()`) scope + the director fires in the right
// workspace's harness. The arg is serialized, so recovery restores it too.
async function fireRoleImpl(slug: string, role: string, workspaceId: string): Promise<void> {
  await runWithWorkspace(workspaceId, async () => {
    await DBOS.runStep(() => recordFire(slug, role, 'firing', false), { name: 'record-firing' });
    try {
      // P-006: throw on a failed fire so DBOS retries the step with exponential
      // backoff (3 attempts, 2s → 4s). fireDirector swallows its own errors into
      // { ok: false }, so we re-raise to engage the retry contract.
      await DBOS.runStep(async () => {
        const res = await fireDirector(operatorBase(), slug, role);
        if (!res.ok) throw new Error(res.detail || 'fire failed');
      }, { name: 'fire', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2, backoffRate: 2 });
      await DBOS.runStep(() => recordFire(slug, role, 'ok', false), { name: 'record-ok' });
    } catch (e) {
      // Retries exhausted: record the error (bumps consecutive_errors for triage)
      // and let the next scheduled tick re-fire per shouldFire(). We do NOT
      // rethrow — a transient downstream fire failure shouldn't drive the
      // workflow into recovery; maxRecoveryAttempts (below) is the cap for the
      // genuine crash-loop case.
      const detail = String(e instanceof Error ? e.message : e).slice(0, 180);
      await DBOS.runStep(() => recordFire(slug, role, `error: ${detail}`, true), { name: 'record-error' });
    }
  });
}
// maxRecoveryAttempts is the dead-letter cap (P-006 / D-006): a fire workflow
// that keeps crashing *during execution* lands in MAX_RECOVERY_ATTEMPTS_EXCEEDED
// for triage rather than looping forever.
export const fireRoleWorkflow = DBOS.registerWorkflow(fireRoleImpl, {
  name: 'autoLoopFireRole',
  maxRecoveryAttempts: 5,
});

// The scheduled tick: enumerate harnesses, enqueue a deduped fire per due role.
// Mirrors autoloop.ts tickOnce(), but enqueues durable workflows instead of
// firing inline.
async function autoLoopTickImpl(): Promise<void> {
  // Phase E (P-020): the one shared operator sweeps every workspace (gated by
  // PAPERCUSP_SHARED_OPERATOR — else just the active/pinned one). Each workspace
  // runs in its own scope so listHarnesses sees that workspace's harnesses and
  // shouldFire (reads activeWorkspaceId) checks per-workspace fire-state.
  for (const ws of orchestratorWorkspaceIds()) {
    await runWithWorkspace(ws, async () => {
      const harnesses = await listHarnesses(operatorBase(), ws);
      for (const h of harnesses) {
        const dirCfg = await readDirectorConfig(h.path);
        if (!dirCfg?.autoLoop) continue;
        const baseInterval = Math.max(30, Number(dirCfg.autoIntervalSeconds ?? 60)); // hard floor 30s
        const harnessCfg = await readHarnessConfig(h.path);
        const roles: { role: string; intervalSeconds: number }[] = [
          { role: 'director', intervalSeconds: baseInterval },
        ];
        const allRoles = harnessCfg?.roles ?? {};
        for (const r of ['coordinator', 'auditor']) {
          const cad = Number(allRoles[r]?.cadence ?? 0);
          if (cad >= 30) roles.push({ role: r, intervalSeconds: cad });
        }
        for (const { role, intervalSeconds } of roles) {
          if (!(await shouldFire(h.slug, role, intervalSeconds))) continue;
          try {
            await DBOS.startWorkflow(fireRoleWorkflow, {
              queueName: autoLoopQueue.name,
              // Workspace-keyed so the same slug in two workspaces fires
              // independently (P-020).
              enqueueOptions: { deduplicationID: `autoloop:${ws}:${h.slug}:${role}` },
            })(h.slug, role, ws);
          } catch (e) {
            // Already enqueued/active for this (workspace, slug, role) — skip.
            if (!/Duplicat/i.test(String(e))) throw e;
          }
        }
      }
    });
  }
}
const autoLoopTickWorkflow = DBOS.registerWorkflow(autoLoopTickImpl, { name: 'autoLoopTick' });

// Scheduled fn must also be a registered workflow (spike finding). Default
// skip-missed mode — no `ExactlyOncePerInterval`, so no backfill storm (D-009).
DBOS.registerScheduled(autoLoopTickWorkflow, { name: 'autoLoopTick', crontab: TICK_CRONTAB });
