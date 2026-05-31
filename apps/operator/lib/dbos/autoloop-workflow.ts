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
} from '@/lib/autoloop';

// 6-field crontab (seconds). Default: every 30s, matching the legacy ticker.
const TICK_CRONTAB = process.env.PAPERCUSP_DBOS_AUTOLOOP_CRONTAB || '*/30 * * * * *';
const operatorBase = (): string => process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

const autoLoopQueue = new WorkflowQueue('autoloop', { concurrency: 4 });

// One durable fire of (slug, role): record→fire→record. A workflow so a crash
// mid-fire resumes; the dedup ID on enqueue guards single-fire.
async function fireRoleImpl(slug: string, role: string): Promise<void> {
  await DBOS.runStep(() => recordFire(slug, role, 'firing', false), { name: 'record-firing' });
  const res = await DBOS.runStep(() => fireDirector(operatorBase(), slug, role), { name: 'fire' });
  await DBOS.runStep(
    () => recordFire(slug, role, res.ok ? 'ok' : `error: ${res.detail}`, !res.ok),
    { name: 'record-result' },
  );
}
export const fireRoleWorkflow = DBOS.registerWorkflow(fireRoleImpl, { name: 'autoLoopFireRole' });

// The scheduled tick: enumerate harnesses, enqueue a deduped fire per due role.
// Mirrors autoloop.ts tickOnce(), but enqueues durable workflows instead of
// firing inline.
async function autoLoopTickImpl(): Promise<void> {
  const harnesses = await listHarnesses(operatorBase());
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
          enqueueOptions: { deduplicationID: `autoloop:${h.slug}:${role}` },
        })(h.slug, role);
      } catch (e) {
        // Already enqueued/active for this (slug, role) — single-fire, skip.
        if (!/Duplicat/i.test(String(e))) throw e;
      }
    }
  }
}
const autoLoopTickWorkflow = DBOS.registerWorkflow(autoLoopTickImpl, { name: 'autoLoopTick' });

// Scheduled fn must also be a registered workflow (spike finding). Default
// skip-missed mode — no `ExactlyOncePerInterval`, so no backfill storm (D-009).
DBOS.registerScheduled(autoLoopTickWorkflow, { name: 'autoLoopTick', crontab: TICK_CRONTAB });
