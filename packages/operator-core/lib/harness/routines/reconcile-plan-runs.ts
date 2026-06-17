/**
 * Run completion tracking for scheduled plan runs.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (Phase 5 data; unblocks P-012/P-013).
 *
 * A `system:plan-run` fire mints a `plan_runs` row at status='running' + work_items the
 * harness dispatcher executes. Nothing settles the run when those work_items finish —
 * this reconcile does: for each running SCHEDULED run, once ALL its work_items
 * (payload.plan_run.runId = the run) are terminal, it sets the run's `outcome`
 * (success | partial | failed), `status` (done | failed), and `finished_at` (→ duration).
 * A run with no work_items (a prose plan) settles immediately as success.
 *
 * Idempotent + cheap (indexed by hfc_source_plan_run_idx, mig 300). Called before the
 * plans:runs read (the v1 poll, mirroring sweepPlanRuns) and by the routine tick.
 * `sql` is a seam (admin pool in prod, testcontainers client in tests).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** Work-item states that count as a finished execution. */
const TERMINAL = ['passed', 'done', 'resolved', 'closed', 'deprecated', 'dropped', 'failed'];
const PASSED = ['passed', 'done', 'resolved', 'closed'];
const FAILED = ['failed', 'dropped', 'deprecated'];

export type RunOutcome = 'success' | 'partial' | 'failed';

export interface ReconcileResult {
  /** Runs settled this pass. */
  reconciled: number;
  /** Per-settled-run outcomes (for the caller / P-012 auto-pause). */
  settled: Array<{ runId: number; harnessSlug: string; planSlug: string; outcome: RunOutcome }>;
}

/**
 * Settle every running scheduled run whose work_items have all terminated.
 * `harnessSlug` optionally scopes the pass to one harness.
 */
export async function reconcileScheduledPlanRuns(
  opts: { sql?: Sql; harnessSlug?: string } = {},
): Promise<ReconcileResult> {
  const db = opts.sql ?? getOrgPg().sql;
  const harnessFilter = opts.harnessSlug ? db`AND harness_slug = ${opts.harnessSlug}` : db``;
  const running = await db<Array<{ id: number; harness_slug: string; plan_slug: string }>>`
    SELECT id, harness_slug, plan_slug
      FROM harness_shared.plan_runs
     WHERE run_type = 'scheduled' AND status = 'running' ${harnessFilter}
  `;

  const settled: ReconcileResult['settled'] = [];
  for (const run of running) {
    const wis = await db<Array<{ status: string }>>`
      SELECT status FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${run.harness_slug}
         AND payload -> 'plan_run' ->> 'runId' = ${String(run.id)}
    `;
    // Still in flight — leave it running.
    if (wis.length > 0 && !wis.every((w) => TERMINAL.includes(w.status))) continue;

    const passed = wis.filter((w) => PASSED.includes(w.status)).length;
    const failed = wis.filter((w) => FAILED.includes(w.status)).length;
    const outcome: RunOutcome =
      wis.length === 0 || failed === 0 ? 'success' : passed === 0 ? 'failed' : 'partial';
    const status = outcome === 'failed' ? 'failed' : 'done';
    const now = Date.now();
    await db`
      UPDATE harness_shared.plan_runs
         SET status = ${status}, outcome = ${outcome}, finished_at = ${now}, updated_at = ${now}
       WHERE id = ${run.id}
    `;
    settled.push({ runId: run.id, harnessSlug: run.harness_slug, planSlug: run.plan_slug, outcome });
  }
  return { reconciled: settled.length, settled };
}
