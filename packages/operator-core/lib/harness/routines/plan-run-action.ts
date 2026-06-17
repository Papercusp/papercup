/**
 * The `system:plan-run` routine action — one fire of a scheduled plan.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-007 sub-step 7c). The plan-level
 * mirror of `system:blueprint-run`.
 *
 * A scheduled plan's materialized routine (materialize-plan-schedule.ts) fires this
 * with `payload_template = { templateSlug, harnessSlug }`. The routinesTick dispatches
 * it INLINE as one durable DBOS step (system-actions.ts), so it must be replay-safe.
 *
 * Per fire it mints a RUN (Option C, D-002): an ephemeral INSTANCE plan
 * (`<template>@run-<token>`, a copy of the template) + a `plan_runs` ledger row
 * (run_type='scheduled') + the instance's items as frontier work_items, run-scoped via
 * `payload.plan_run` + `source_plan_slug`=template (D-016) so the Queen frontier filter
 * + the Runs-tab rollup work unchanged. The harness's existing dispatcher executes
 * those work_items — no second execution engine.
 *
 * Replay-safety (the durable-step contract): the run token is the routine's
 * `last_fired_at` (stamped once at claim, stable across a recovery replay), so the
 * instance plan slug is deterministic per fire; an existence check + ON CONFLICT DO
 * NOTHING make a replay a no-op rather than a double-mint.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { planScheduleRoutineName } from './materialize-plan-schedule';
import { FEATURE_FAMILY_KINDS } from '../../work-items';

/** launched_by label for a scheduled run's plan_runs row. */
const PLAN_RUN_LAUNCHER = 'system:plan-run';

interface TemplateItem {
  id: string;
  text?: string | null;
  status?: string | null;
}

export interface ScheduledPlanFireResult {
  instanceSlug: string;
  runId: number;
  runSeq: number;
  minted: number;
  /** true when this fire was a replay no-op (instance already existed). */
  replayed: boolean;
}

/**
 * Mint one run of a scheduled plan. `sql` is an explicit seam (admin pool in prod,
 * the testcontainers client in tests). Returns null when the template is missing or
 * has no templateSlug; never throws (the durable-step contract is enforced by the
 * handler wrapper).
 */
export async function runScheduledPlanFire(
  sql: Sql,
  opts: {
    installSlug: string;
    workspaceId: string;
    templateSlug: string;
    /** What kind of fire this is (plan_runs.trigger). Default 'scheduled'; run-now passes 'manual'. */
    trigger?: 'scheduled' | 'manual' | 'event';
  },
): Promise<ScheduledPlanFireResult | null> {
  const { installSlug, workspaceId, templateSlug, trigger = 'scheduled' } = opts;

  // 1. The template plan.
  const tpl = await sql<
    Array<{ content: string; content_hash: string; title: string | null; items: unknown; schedule: { executorKind?: string } | null }>
  >`
    SELECT content, content_hash, title, items, schedule
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug}
       AND plan_slug = ${templateSlug}
  `;
  if (!tpl[0]) {
    console.warn(`[plan-run] template '${templateSlug}' not found in ${installSlug} — skip`);
    return null;
  }
  const template = tpl[0];
  // Executor kind (D-006/P-009): a non-coding plan mints a lighter frontier kind
  // ('research-task' → research spine) instead of the coding-spine 'feature' default.
  // Authored on schedule.executorKind; validated against the feature-family kinds.
  const rawKind = template.schedule?.executorKind;
  const itemKind = rawKind && (FEATURE_FAMILY_KINDS as readonly string[]).includes(rawKind) ? rawKind : 'feature';

  // 2. Replay-stable run token = the routine's last_fired_at (set at claim, stable on replay).
  const rt = await sql<Array<{ last_fired_at: Date | null }>>`
    SELECT last_fired_at FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${planScheduleRoutineName(templateSlug)}
  `;
  const token = rt[0]?.last_fired_at ? new Date(rt[0].last_fired_at).getTime() : Date.now();
  const instanceSlug = `${templateSlug}@run-${token}`;

  // 3. Idempotency: the instance already existing ⇒ this is a replay ⇒ no-op.
  const existing = await sql<Array<{ run_seq: number | null }>>`
    SELECT run_seq FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug}
       AND plan_slug = ${instanceSlug}
  `;
  if (existing[0]) {
    console.log(`[plan-run] ${instanceSlug} already minted (replay) — skip`);
    return { instanceSlug, runId: -1, runSeq: existing[0].run_seq ?? -1, minted: 0, replayed: true };
  }

  // 4. run_seq = count of prior runs of this template (display ordinal, D-003).
  const seqRow = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.plan_runs
     WHERE harness_slug = ${installSlug} AND plan_slug = ${templateSlug}
  `;
  const runSeq = seqRow[0]?.n ?? 0;
  const now = Date.now();

  // 5. The instance plan — a copy of the template, pinned to it via template_slug.
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash,
       template_slug, run_seq, origin)
    VALUES (${workspaceId}, ${installSlug}, ${instanceSlug}, ${template.title}, 'active',
            ${template.content}, ${template.content_hash}, ${templateSlug}, ${runSeq}, 'local')
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING
  `;

  // 6. The plan_runs ledger row (run_type='scheduled'). plan_slug = the TEMPLATE so
  //    "all runs of X" = WHERE plan_slug=X (D-003); instance_plan_slug names the copy.
  const runRows = await sql<Array<{ id: number }>>`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, instance_plan_slug, run_seq)
    VALUES (${installSlug}, ${templateSlug}, ${template.content_hash}, ${'sched:' + instanceSlug},
            ${PLAN_RUN_LAUNCHER}, ${now}, 'running', ${template.title}, ${now},
            'scheduled', ${trigger}, ${instanceSlug}, ${runSeq})
    RETURNING id
  `;
  const runId = Number(runRows[0].id);

  // 7. Mint the template's open items as frontier work_items, run-scoped (D-016):
  //    source_plan_slug = TEMPLATE (Queen frontier filter), payload.plan_run = the run.
  //    Unclaimed/todo — the harness dispatcher executes them. ON CONFLICT keeps replay safe.
  const items: TemplateItem[] = Array.isArray(template.items) ? (template.items as TemplateItem[]) : [];
  let minted = 0;
  for (const it of items) {
    if (!it?.id || it.status === 'done' || it.status === 'dropped') continue;
    const featureId = `PR-${runId}-${it.id}`;
    const title = (it.text ?? it.id).replace(/\s+/g, ' ').trim().slice(0, 140);
    const payload = JSON.stringify({
      plan_run: { runId, runSeq, instancePlanSlug: instanceSlug, templateSlug },
      plan_item: { plan_slug: instanceSlug, item_id: it.id, harness_slug: installSlug },
    });
    await sql.unsafe(
      `INSERT INTO harness_shared.harness_features_consolidated
         (harness_slug, feature_id, title, summary, status, attempts, item_kind, payload,
          needs_human_review, workspace_id, ts, created_ts, updated_ts, source_plan_slug)
       VALUES ($1,$2,$3,$4,'todo',0,$9,$5::text::jsonb,FALSE,$6,$7,$7,$7,$8)
       ON CONFLICT (harness_slug, feature_id) DO NOTHING`,
      [installSlug, featureId, title, it.text ?? null, payload, workspaceId, now, templateSlug, itemKind],
    );
    minted += 1;
  }

  console.log(
    `[plan-run] ${installSlug}: minted run #${runSeq} of '${templateSlug}' → ${instanceSlug} ` +
      `(plan_run ${runId}, ${minted} work-item(s))`,
  );
  return { instanceSlug, runId, runSeq, minted, replayed: false };
}

/** The registered `system:plan-run` handler. Never throws (durable-step contract). */
export async function handlePlanRun(ctx: SystemActionCtx): Promise<void> {
  const templateSlug =
    typeof ctx.payloadTemplate?.templateSlug === 'string' ? ctx.payloadTemplate.templateSlug.trim() : '';
  if (!templateSlug) {
    console.warn('[plan-run] no templateSlug in payload — skip');
    return;
  }
  try {
    // P-028 master switch: the scheduled-plan execution path ships dark.
    if (!(await getFlag(FLAGS.SCHEDULED_PLANS, 'system'))) {
      console.log('[plan-run] papercusp-scheduled-plans flag off — skip');
      return;
    }
    const { sql } = getOrgPg();
    await runScheduledPlanFire(sql, {
      installSlug: ctx.installSlug,
      workspaceId: ctx.workspaceId,
      templateSlug,
    });
  } catch (e) {
    // Durable-step contract: log + return, never throw (the next cadence fire retries).
    console.warn(
      `[plan-run] ${ctx.installSlug}: run of '${templateSlug}' FAILED: ${e instanceof Error ? e.message : e}`,
    );
  }
}

registerSystemAction('plan-run', handlePlanRun);
