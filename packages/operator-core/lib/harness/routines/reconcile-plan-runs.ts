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
import { disarmPlanSchedule } from './arm-plan-schedule';
import { autoPauseOnCostBreach } from './plan-run-cost';

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

/** Default consecutive-failure threshold before a schedule auto-pauses (D-011). */
export const DEFAULT_FAILURE_STREAK = 3;

/**
 * Failure auto-pause (P-012, D-011): if a template's last `k` SETTLED scheduled runs all
 * failed, disarm its schedule (stop a broken routine from firing forever). Only acts on a
 * currently-armed template. The auto-paused state IS the notification — the schedule shows
 * disarmed + the failed-run streak in the Runs tab / Calendar.
 */
export async function autoPauseOnFailureStreak(opts: {
  sql?: Sql;
  harnessSlug: string;
  planSlug: string;
  k?: number;
}): Promise<{ paused: boolean; failures: number }> {
  const db = opts.sql ?? getOrgPg().sql;
  const k = opts.k ?? DEFAULT_FAILURE_STREAK;

  const tpl = await db<Array<{ workspace_id: string; schedule_active: boolean }>>`
    SELECT workspace_id, schedule_active FROM harness_shared.harness_plans
     WHERE harness_slug = ${opts.harnessSlug} AND plan_slug = ${opts.planSlug}`;
  if (!tpl[0] || !tpl[0].schedule_active) return { paused: false, failures: 0 };

  const recent = await db<Array<{ outcome: string | null }>>`
    SELECT outcome FROM harness_shared.plan_runs
     WHERE harness_slug = ${opts.harnessSlug} AND plan_slug = ${opts.planSlug}
       AND run_type = 'scheduled' AND status IN ('done', 'failed')
     ORDER BY launched_at DESC
     LIMIT ${k}`;
  const failures = recent.filter((r) => r.outcome === 'failed').length;

  if (recent.length >= k && failures === k) {
    await disarmPlanSchedule({
      sql: db,
      workspaceId: tpl[0].workspace_id,
      harnessSlug: opts.harnessSlug,
      templateSlug: opts.planSlug,
    });
    console.warn(
      `[plan-run] auto-paused schedule '${opts.planSlug}' (${opts.harnessSlug}) — ${k} consecutive failed runs`,
    );
    return { paused: true, failures };
  }
  return { paused: false, failures };
}

/**
 * One settle+govern pass for the routine tick / plans:runs read: reconcile completions,
 * then auto-pause a template on either guardrail —
 *   - cost breach (P-013 / D-018): a freshly-settled run (any outcome) whose attributed
 *     spend exceeds the per-plan costCapCents; and
 *   - failure streak (P-012 / D-011): a freshly-failed run completing K consecutive fails.
 * Cost is checked first (a successful-but-expensive run still pauses); a template paused on
 * cost is not re-checked for the streak.
 */
export async function reconcileAndGovern(
  opts: { sql?: Sql; harnessSlug?: string; failureStreakK?: number } = {},
): Promise<{ reconciled: number; paused: string[] }> {
  const db = opts.sql ?? getOrgPg().sql;
  const { settled } = await reconcileScheduledPlanRuns({ sql: db, harnessSlug: opts.harnessSlug });
  const paused: string[] = [];
  for (const s of settled) {
    // Cost-breach pause — independent of outcome (a successful run can be too expensive).
    const c = await autoPauseOnCostBreach({
      sql: db,
      harnessSlug: s.harnessSlug,
      planSlug: s.planSlug,
      runId: s.runId,
    });
    if (c.paused) {
      paused.push(s.planSlug);
      continue; // already disarmed — don't double-process the streak
    }
    // Failure-streak pause — failed runs only.
    if (s.outcome !== 'failed') continue;
    const r = await autoPauseOnFailureStreak({
      sql: db,
      harnessSlug: s.harnessSlug,
      planSlug: s.planSlug,
      k: opts.failureStreakK,
    });
    if (r.paused) paused.push(s.planSlug);
  }
  return { reconciled: settled.length, paused };
}
