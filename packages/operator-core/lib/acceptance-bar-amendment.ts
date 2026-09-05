/**
 * Cross-plan transaction primitive for post-start acceptance BAR amendments.
 *
 * A BAR is stored on an acceptance-rubric plan, while its lifecycle pins and
 * discharge map live on the subject plan.  Updating only one of those rows is
 * therefore not an amendment: readers can observe a rubric revision that the
 * subject still claims it has not adopted (or vice versa).  This helper keeps
 * the two advisory locks in one deterministic order and runs the caller's
 * mutation in the same database transaction.
 */
import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { rubricTemplateDataAuthoringSchema } from './agent-tools/plans/rubric-template';
import { setSpecClause, type SpecClauseSql, type SpecClauseWrite } from './agent-tools/plans/spec-clauses-store';

export type AcceptanceBarAmendmentSql = Sql | TransactionSql;

/** Refresh execution projections from the canonical rubric, never from its old
 * Requirements seed. Called inside the transaction that writes that rubric. */
export async function synchronizeAcceptanceBarRevision(
  sql: SpecClauseSql,
  args: {
    workspaceId: string;
    harnessSlug: string;
    rubricSlug: string;
    rubricRevision: number;
    templateData: unknown;
    actorId: string;
  },
): Promise<Map<string, number>> {
  const parsed = rubricTemplateDataAuthoringSchema.safeParse(args.templateData);
  if (!parsed.success || parsed.data.kind !== 'acceptance' || !parsed.data.barContract || !parsed.data.subjectPlan) {
    return new Map();
  }
  const data = parsed.data;
  const subjectPlan = data.subjectPlan!;
  // Generic METHOD writers already hold the rubric lock. Never wait while
  // acquiring their second lock: refusal rolls back instead of deadlocking a
  // concurrent amendment which acquired the pair in the opposite order.
  const [lock] = await sql<Array<{ ok: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext('harness_plan_write'),
      hashtext(${planAdvisoryLockKey(args.workspaceId, args.harnessSlug, subjectPlan)})) AS ok`;
  if (!lock?.ok) throw new Error('acceptance_bar_revision_subject_busy');
  const subjects = await sql<Array<{ plan_slug: string }>>`
    SELECT plan_slug FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${subjectPlan} FOR UPDATE`;
  if (!subjects.length) throw new Error('acceptance_bar_revision_subject_missing');
  const clauses = await sql<Array<{
    spec_id: string; source_val_id: string | null; current_revision: number | string;
    source_bar_key: string; plan_item_id: string;
    behavior_class: SpecClauseWrite['behaviorClass']; required_evidence: string[];
    required_test_layers: string[]; mutation_required: boolean;
    lifecycle_status: SpecClauseWrite['lifecycleStatus'];
    supersedes_spec_id: string | null; supersedes_revision: number | null;
    exemption: Record<string, unknown> | null;
  }>>`
    SELECT c.spec_id, c.source_val_id, c.current_revision, r.source_bar_key,
           r.plan_item_id, r.behavior_class, r.required_evidence, r.required_test_layers,
           r.mutation_required, r.lifecycle_status, r.supersedes_spec_id,
           r.supersedes_revision, r.exemption
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id AND r.revision = c.current_revision
     WHERE c.workspace_id = ${args.workspaceId} AND c.harness_slug = ${args.harnessSlug}
       AND c.plan_slug = ${subjectPlan} AND r.source_bar_key IS NOT NULL
     ORDER BY c.spec_id LIMIT 1001`;
  if (clauses.length > 1000) throw new Error('acceptance_bar_revision_projection_truncated');
  const byKey = new Map(data.criteria.map((criterion) => [criterion.barKey ?? criterion.key, criterion]));
  if (data.criteria.some((criterion) => !clauses.some((clause) => clause.source_bar_key === (criterion.barKey ?? criterion.key)))) {
    throw new Error('acceptance_bar_revision_mapping_missing');
  }
  const revisions = new Map<string, number>();
  for (const clause of clauses) {
    const criterion = byKey.get(clause.source_bar_key);
    if (!criterion?.barHash || !criterion.evidencePlane || !data.barSetHash) {
      throw new Error(`acceptance_bar_revision_projection_unmapped:${clause.spec_id}`);
    }
    const result = await setSpecClause({
      planSlug: subjectPlan, specId: clause.spec_id, sourceValId: clause.source_val_id,
      expectedRevision: Number(clause.current_revision), planItemId: clause.plan_item_id,
      behavior: criterion.model!, behaviorClass: clause.behavior_class,
      requiredEvidence: clause.required_evidence.map((value) => ['tree', 'deployed', 'live'].includes(value) ? criterion.evidencePlane! : value),
      requiredTestLayers: clause.required_test_layers, mutationRequired: clause.mutation_required,
      lifecycleStatus: clause.lifecycle_status, exemption: clause.exemption,
      supersedes: clause.supersedes_spec_id && clause.supersedes_revision
        ? { specId: clause.supersedes_spec_id, revision: clause.supersedes_revision } : null,
      falsifier: { observation: criterion.driftMarkers! },
      acceptanceRef: `${args.rubricSlug}@${args.rubricRevision}:${clause.source_bar_key}`,
      sourceBar: { barKey: clause.source_bar_key, barHash: criterion.barHash,
        barSetHash: data.barSetHash, rubricSlug: args.rubricSlug,
        rubricRevision: args.rubricRevision, evidencePlane: criterion.evidencePlane },
      actorId: args.actorId,
    }, { executor: sql, workspaceId: args.workspaceId, harnessSlug: args.harnessSlug });
    if (result.status !== 'created' && result.status !== 'revised' && result.status !== 'unchanged') {
      throw new Error(`acceptance_bar_revision_projection_conflict:${clause.spec_id}:${result.status}`);
    }
    revisions.set(clause.spec_id, result.revision);
  }
  await sql`
    UPDATE harness_shared.harness_plans
       SET acceptance_bar_rubric_slug = ${args.rubricSlug},
           acceptance_bar_rubric_revision = ${args.rubricRevision},
           acceptance_bar_set_hash = ${data.barSetHash!}
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${subjectPlan}`;
  return revisions;
}

export interface AcceptanceBarAmendmentPlan {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export interface AcceptanceBarAmendmentTransactionArgs {
  /** Both the subject plan and acceptance-rubric plan. */
  plans: readonly AcceptanceBarAmendmentPlan[];
  /** Bounded lock wait, matching the ordinary withPlanLock write seam. */
  ttlSec?: number;
}

/**
 * Acquire all plan locks in a stable `(workspace, harness, slug)` order, then
 * invoke `work` inside one transaction.  Duplicate plans are collapsed before
 * locking, so a caller cannot deadlock itself by naming the same plan twice.
 */
export async function withAcceptanceBarAmendmentTransaction<T>(
  args: AcceptanceBarAmendmentTransactionArgs,
  work: (tx: AcceptanceBarAmendmentSql) => Promise<T>,
): Promise<T> {
  if (!args.plans.length) throw new Error('acceptance_bar_amendment: at least one plan is required');
  const plans = [...new Map(args.plans.map((plan) => [
    `${plan.workspaceId}\0${plan.harnessSlug}\0${plan.planSlug}`,
    plan,
  ])).values()].sort((a, b) =>
    `${a.workspaceId}\0${a.harnessSlug}\0${a.planSlug}`.localeCompare(
      `${b.workspaceId}\0${b.harnessSlug}\0${b.planSlug}`,
    ),
  );
  const workspaceId = plans[0]!.workspaceId;
  if (plans.some((plan) => plan.workspaceId !== workspaceId)) {
    throw new Error('acceptance_bar_amendment: plans must share one workspace');
  }
  const budgetMs = (args.ttlSec ?? 5) * 1000;
  return withWorkspace(workspaceId, async (tx) => {
    for (const plan of plans) {
      await acquirePlanAdvisoryLock(
        tx,
        planAdvisoryLockKey(plan.workspaceId, plan.harnessSlug, plan.planSlug),
        budgetMs,
      );
    }
    return work(tx);
  });
}

/** The deterministic key used when a caller omits an explicit replay token. */
export function acceptanceBarAmendmentKey(parts: {
  rubricId: string;
  subjectPlan: string;
  actorId: string;
  reason: string;
  priorRubricRevision: number;
  nextBarHashes: readonly string[];
}): string {
  // Keep this helper dependency-free.  The caller supplies the hash material
  // already produced by the canonical rubric writer; a NUL-delimited tuple is
  // stable across JSON key ordering and cannot collide at field boundaries.
  const material = [
    parts.rubricId.trim(),
    parts.subjectPlan.trim(),
    parts.actorId.trim(),
    parts.reason.trim(),
    String(parts.priorRubricRevision),
    ...[...parts.nextBarHashes].sort(),
  ].join('\0');
  return createHash('sha256').update(material).digest('hex');
}
