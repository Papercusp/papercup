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
 * Replay-safety (the durable-step contract): the run token is stable per fire and the
 * complete instance-plan + run-ledger + frontier-work mint is ONE transaction. A crash
 * therefore exposes either every artifact or none; a deterministic replay can never
 * mistake a partial instance-plan insert for a completed run.
 */
import type { Sql, TransactionSql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { planScheduleRoutineName } from './materialize-plan-schedule';
import { FEATURE_FAMILY_KINDS } from '../../work-items';
import { evaluatePlanStartReadiness } from '../../agent-tools/plans/plan-input-validation';
import { routineStorageSlug } from '../../pot-membership';
import { setFrontmatterScalar } from '../../agent-tools/plans/transfer-owner';
import { planRunInstanceSlug } from '../../agent-tools/plans/run-instance-slug';
import { hashPlanContent } from '@papercusp/plan-parser';

/** launched_by label for a scheduled run's plan_runs row. */
const PLAN_RUN_LAUNCHER = 'system:plan-run';

/**
 * A MANUAL run (plans:run-now) takes a fresh token each call (EI-1369). A module-monotonic
 * counter guarantees a strictly-increasing, unique token even for two run-nows within the same
 * millisecond on one host — so the instance slug never collides and the run never replay-no-ops.
 */
let lastManualToken = 0;
function nextManualToken(): number {
  const t = Math.max(Date.now(), lastManualToken + 1);
  lastManualToken = t;
  return t;
}

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
  /** true when this fire was skipped because a prior run of the same template was
   *  still 'running' and the schedule's concurrency policy is 'skip' (EI-1386). */
  skippedForConcurrency?: boolean;
}

export interface ScheduledPlanFireOptions {
  installSlug: string;
  workspaceId: string;
  templateSlug: string;
  /** What kind of fire this is (plan_runs.trigger). Default 'scheduled'; run-now passes 'manual'. */
  trigger?: 'scheduled' | 'manual' | 'event';
  /** Stable decimal token for a durable non-manual fire. */
  runToken?: number | string;
  /** The resolved, start-gate-validated inputs this run executes with. */
  inputs?: unknown;
}

/**
 * Mint one run of a scheduled plan. `sql` is an explicit seam (admin pool in prod,
 * the testcontainers client in tests). Returns null when the template is missing or
 * has no templateSlug; never throws (the durable-step contract is enforced by the
 * handler wrapper).
 */
async function runScheduledPlanFireTx(
  sql: Sql | TransactionSql,
  opts: ScheduledPlanFireOptions,
): Promise<ScheduledPlanFireResult | null> {
  const { installSlug, workspaceId, templateSlug, trigger = 'scheduled' } = opts;

  // WI-6978 — `harness_plans` IS re-homed, `plan_runs` is NOT. Two relations, two
  // slugs, in one function; the difference is load-bearing.
  //
  // The plans:* WRITE path resolves a member harness to its Hive home
  // (resolvePlanScope → potHomeSlugForHarness, agent-tools/plans/source.ts:429 —
  // plans are Hive-scoped). A read filtering this routine's RAW `installSlug`
  // therefore matches ZERO ROWS whenever the routine is installed under a member
  // harness or a workspace-global label — and the failure is silent: step 1 below
  // logs "template not found — skip" and the schedule simply never fires again.
  // `routineStorageSlug` reproduces the same resolution (pot-membership.ts:199,
  // pgPotLookup.resolveRealPot collapses member → Pot home) and fails open to the
  // literal slug, so the reads here, this function's OWN instance-plan INSERT, and
  // the plans:* tool path all address the same rows by construction.
  //
  // ⚠ The `plan_runs` sites below deliberately keep the raw `installSlug`: that
  // relation is per-install/workspace-scoped and NOT re-homed (audited WI-6978 —
  // every writer, including this file's own ledger INSERT, stores the raw slug).
  // Resolving it here would move the ledger reads off the rows the ledger writes.
  const planStorageSlug = await routineStorageSlug(installSlug, workspaceId);

  // 1. The template plan.
  const tpl = await sql<
    Array<{
      content: string;
      content_hash: string;
      title: string | null;
      items: unknown;
      schedule: { executorKind?: string } | null;
      template: string | null;
      template_data: unknown;
      input_schema: unknown;
    }>
  >`
    SELECT content, content_hash, title, items, schedule, template, template_data, input_schema
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${planStorageSlug}
       AND plan_slug = ${templateSlug}
  `;
  if (!tpl[0]) {
    console.warn(`[plan-run] template '${templateSlug}' not found in ${installSlug} — skip`);
    return null;
  }
  const template = tpl[0];

  // P-006 start gate on the SCHEDULED fire path. P-008 already refused to arm a plan
  // whose required inputs were unset, but that verdict can go stale: the schema or the
  // values can change while the schedule stays armed. Re-checking here costs nothing
  // and is the difference between a refused fire and a run that executes with no
  // arguments. Refusing returns null — the same "did not mint" contract the missing-
  // template case above uses, so the routine wrapper needs no new failure mode.
  const runInputs = opts.inputs !== undefined ? opts.inputs : (template.template_data ?? null);
  const readiness = evaluatePlanStartReadiness(
    { template: template.template, inputSchema: template.input_schema },
    runInputs,
  );
  if (!readiness.ready) {
    console.warn(
      `[plan-run] template '${templateSlug}' in ${installSlug} is not startable ` +
        `(${readiness.code}${readiness.missing.length > 0 ? `: missing ${readiness.missing.join(', ')}` : ''}) — skip. ${readiness.hint}`,
    );
    return null;
  }
  // Executor kind (D-006/P-009): authored on schedule.executorKind; validated against
  // the feature-family kinds (feature|chunk). An invalid or removed kind (e.g. the
  // retired research-task) falls back to the coding-spine 'feature' default.
  const rawKind = template.schedule?.executorKind;
  const itemKind = rawKind && (FEATURE_FAMILY_KINDS as readonly string[]).includes(rawKind) ? rawKind : 'feature';

  // 2. Run token → instance slug. A SCHEDULED/event fire uses the routine's last_fired_at
  //    (stamped at claim, stable across a DBOS step replay) so a re-executed step is a no-op,
  //    not a double-mint. A MANUAL run (plans:run-now) is independent of the cadence and has no
  //    DBOS replay, so it ALWAYS takes a FRESH token — otherwise, once the routine has fired even
  //    once, every run-now would recompute the SAME slug and replay-no-op instead of minting a new
  //    run (EI-1369).
  const rt = await sql<Array<{ last_fired_at: Date | null; concurrency: string | null }>>`
    SELECT last_fired_at, concurrency FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${planScheduleRoutineName(templateSlug)}
  `;
  const suppliedToken = opts.runToken === undefined ? null : String(opts.runToken).trim();
  if (suppliedToken !== null && !/^\d+$/.test(suppliedToken)) {
    throw new Error('plan_run_token_must_be_decimal');
  }
  const token =
    trigger === 'manual'
      ? nextManualToken()
      : suppliedToken !== null
        ? suppliedToken
      : rt[0]?.last_fired_at
        ? new Date(rt[0].last_fired_at).getTime()
        : Date.now();
  const instanceSlug = planRunInstanceSlug(templateSlug, token);

  // Serialize callers racing on the same deterministic fire before the replay
  // check. Combined with the transaction wrapper, this makes the mint both atomic
  // and exactly-once visible even when two workers receive the same event.
  const fireLockKey = `${workspaceId}:${installSlug}:${instanceSlug}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${fireLockKey}, 0))`;

  // 3. Idempotency: the instance already existing ⇒ this is a replay ⇒ no-op.
  const existing = await sql<Array<{ run_seq: number | null }>>`
    SELECT run_seq FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${planStorageSlug}
       AND plan_slug = ${instanceSlug}
  `;
  if (existing[0]) {
    console.log(`[plan-run] ${instanceSlug} already minted (replay) — skip`);
    return { instanceSlug, runId: -1, runSeq: existing[0].run_seq ?? -1, minted: 0, replayed: true };
  }

  // 3b. EI-1386 — overlap policy (D-014). The schedule's `concurrency` was authored
  // (set-schedule → materializePlanSchedule → routines.concurrency) but nothing at
  // fire time ever read it, so an overrunning template accumulated overlapping runs
  // regardless of policy. 'queue' (default at the DB column, though the app layer
  // defaults new schedules to 'skip') mints unconditionally — unchanged, no check
  // needed. 'skip' now actually skips when a prior run of the SAME template is still
  // 'running'. 'cancel-prev' is intentionally NOT handled here — settling a prior
  // run's still-open work_items needs its own careful design (what happens to
  // in-flight worker output) and is tracked separately; a 'cancel-prev'-authored
  // schedule currently behaves like 'queue' (mints anyway) rather than silently
  // dropping fires, which is the safer of the two unimplemented behaviors.
  const concurrency = rt[0]?.concurrency ?? 'queue';
  if (concurrency === 'skip') {
    const inFlight = await sql<Array<{ id: number }>>`
      SELECT id FROM harness_shared.plan_runs
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug}
         AND plan_slug = ${templateSlug} AND status = 'running'
       LIMIT 1
    `;
    if (inFlight[0]) {
      console.log(
        `[plan-run] ${installSlug}: skipping fire of '${templateSlug}' — prior run ` +
          `${inFlight[0].id} still 'running' (concurrency='skip')`,
      );
      return { instanceSlug, runId: -1, runSeq: -1, minted: 0, replayed: false, skippedForConcurrency: true };
    }
  }

  // 4. run_seq = count of prior runs of this template (display ordinal, D-003).
  const seqRow = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.plan_runs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${installSlug} AND plan_slug = ${templateSlug}
  `;
  const runSeq = seqRow[0]?.n ?? 0;
  const now = Date.now();

  // 5. The instance plan — a copy of the template, pinned to it via template_slug.
  //    P-010: the copy now carries the run's ARGUMENTS too (template/template_data/
  //    input_schema). Without them the instance was a plan whose text said "audit each
  //    path in `paths`" while the row itself held no `paths` — the executor could read
  //    the instructions and not the inputs, which is exactly the inertness this plan
  //    exists to fix. `template_data` holds the RESOLVED inputs (overrides merged), so
  //    the instance records what this run actually ran with, not the template default.
  //
  //    EI-19389216343173748: the template's markdown is cloned VERBATIM, frontmatter
  //    included — so left alone, `content`'s self-declared `slug:` stays the PARENT's,
  //    disagreeing with this row's own `plan_slug` (a hard `slug_mismatch` per
  //    plans/lint.ts, and the value ~10 read sites fall back to whenever frontmatter.slug
  //    is present). Rewrite just that one line so the clone's self-declared identity
  //    agrees with its canonical row at the source, and rehash accordingly — the content
  //    hash must reflect what is actually stored, not the template's.
  const runInputsJson = runInputs === null || runInputs === undefined ? null : JSON.stringify(runInputs);
  const inputSchemaJson =
    template.input_schema == null ? null : JSON.stringify(template.input_schema);
  const instanceContent = setFrontmatterScalar(template.content, 'slug', instanceSlug);
  const instanceContentHash = hashPlanContent(instanceContent);
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash,
       template_slug, run_seq, origin, template, template_data, input_schema)
    VALUES (${workspaceId}, ${planStorageSlug}, ${instanceSlug}, ${template.title}, 'active',
            ${instanceContent}, ${instanceContentHash}, ${templateSlug}, ${runSeq}, 'local',
            ${template.template}, ${runInputsJson}::text::jsonb, ${inputSchemaJson}::text::jsonb)
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING
  `;

  // 6. The plan_runs ledger row (run_type='scheduled'). plan_slug = the TEMPLATE so
  //    "all runs of X" = WHERE plan_slug=X (D-003); instance_plan_slug names the copy.
  const runRows = await sql<Array<{ id: number }>>`
    INSERT INTO harness_shared.plan_runs
      (workspace_id, harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, instance_plan_slug, run_seq, inputs)
    VALUES (${workspaceId}, ${installSlug}, ${templateSlug}, ${template.content_hash}, ${'sched:' + instanceSlug},
            ${PLAN_RUN_LAUNCHER}, ${now}, 'running', ${template.title}, ${now},
            'scheduled', ${trigger}, ${instanceSlug}, ${runSeq}, ${runInputsJson}::text::jsonb)
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
    // P-010: the run's inputs ride the work-item payload. The worker that eventually
    // claims this item via scheduler:get_next is a DIFFERENT agent in a different
    // process from whatever fired the run — without the arguments on the payload it
    // inherits the plan text and nothing to run it against.
    const payload = JSON.stringify({
      plan_run: {
        runId,
        runSeq,
        instancePlanSlug: instanceSlug,
        templateSlug,
        ...(runInputs === null || runInputs === undefined ? {} : { inputs: runInputs }),
      },
      plan_item: { plan_slug: instanceSlug, item_id: it.id, harness_slug: installSlug },
    });
    await sql.unsafe(
      `INSERT INTO harness_shared.work_items
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

/** Mint one complete run atomically; callers never observe partial replay state. */
export async function runScheduledPlanFire(
  sql: Sql,
  opts: ScheduledPlanFireOptions,
): Promise<ScheduledPlanFireResult | null> {
  return sql.begin((tx) => runScheduledPlanFireTx(tx, opts));
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

// `scheduling: 'on-demand'` (EI-18752496371939475): one row per scheduled PLAN, created by
// plans:arm-schedule — not a standing workspace-wide row to seed.
registerSystemAction('plan-run', handlePlanRun, { scheduling: 'on-demand' });
