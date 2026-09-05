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
import { z } from 'zod';
import { withWorkspace } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey, PLAN_ADVISORY_LOCK_NAMESPACE } from './agent-tools/plans/plan-lock-key';
import { rubricTemplateDataAuthoringSchema } from './agent-tools/plans/rubric-template';
import { setSpecClause, type SpecClauseSql, type SpecClauseWrite } from './agent-tools/plans/spec-clauses-store';

export type AcceptanceBarAmendmentSql = Sql | TransactionSql;

/** Ignore only generated completion backlinks and the frontmatter update date.
 * Everything else, including authored notes, remains an exact comparison. */
function acceptanceBookkeepingBody(body: string): string {
  return body
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, (frontmatter) =>
      frontmatter.replace(/^updated:.*$/m, 'updated: <bookkeeping>'))
    .replace(/^(-[ \t]+\*\*P-\d+\*\*[^\r\n]*?) — note: ← (?:WI|EI)-\d+ completed \((?:done|passed|resolved|closed|dropped|deprecated)\)[ \t]*$/gm, '$1');
}

/** Keep a derived subject-version pin current after a bookkeeping-only write.
 * Called while the subject lock is held. The rubric try-lock avoids reversing
 * an amendment's lock order. Criteria, rubric version and spec pins never change. */
export async function synchronizeAcceptanceBarSubjectRevision(
  sql: AcceptanceBarAmendmentSql,
  args: {
    workspaceId: string; harnessSlug: string; planSlug: string;
    previousBody: string; nextBody: string; previousVersion: number; nextVersion: number;
  },
): Promise<boolean> {
  if (args.nextVersion !== args.previousVersion + 1 ||
      acceptanceBookkeepingBody(args.previousBody) !== acceptanceBookkeepingBody(args.nextBody)) return false;
  const [subject] = await sql<Array<{
    acceptance_bar_rubric_slug: string; acceptance_bar_rubric_revision: number;
    acceptance_bar_set_hash: string;
  }>>`
    SELECT acceptance_bar_rubric_slug, acceptance_bar_rubric_revision, acceptance_bar_set_hash
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${args.planSlug} AND version = ${args.nextVersion}
       AND content = ${args.nextBody} AND acceptance_bar_rubric_slug IS NOT NULL`;
  if (!subject) return false;
  const [lock] = await sql<Array<{ ok: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
      hashtext(${planAdvisoryLockKey(args.workspaceId, args.harnessSlug, subject.acceptance_bar_rubric_slug)})) AS ok`;
  if (!lock?.ok) throw new Error('acceptance_bar_subject_revision_rubric_busy');
  const rows = await sql`
    UPDATE harness_shared.harness_plans
       SET template_data = jsonb_set(template_data, '{barContract,subjectPlanRevision}',
             to_jsonb(${args.nextVersion}::integer)), origin = 'local'
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${subject.acceptance_bar_rubric_slug}
       AND version = ${subject.acceptance_bar_rubric_revision}
       AND template = 'rubric' AND template_data->>'kind' = 'acceptance'
       AND template_data->>'subjectPlan' = ${args.planSlug}
       AND template_data->>'barSetHash' = ${subject.acceptance_bar_set_hash}
       AND template_data->'barContract'->>'subjectPlanRevision' = ${String(args.previousVersion)}
    RETURNING plan_slug`;
  return rows.length === 1;
}

/** A reviewer posts this JSON through an authenticated Threadable verb (for
 * example work_items:comment). Authorship/time come from the append-only post,
 * never from this body or the amendment caller. Per-BAR hashes permit one review
 * to approve several sequential amendments without approving unrelated changes. */
export const acceptanceBarApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('acceptance-bar-amendment-approval'),
    rubricRef: z.string().min(1),
    subjectPlan: z.string().min(1),
    bars: z
      .array(
        z
          .object({
            barKey: z.string().min(1),
            priorBarHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
            nextBarHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict()
          .refine(
            (bar) => bar.priorBarHash !== null || bar.nextBarHash !== null,
            'an approval BAR must have a prior or next hash',
          ),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .refine(
    (receipt) => new Set(receipt.bars.map((bar) => bar.barKey)).size === receipt.bars.length,
    'approval BAR keys must be unique',
  );

export type AcceptanceBarApproval = z.infer<typeof acceptanceBarApprovalSchema>;

export async function resolveAcceptanceBarApproval(
  sql: SpecClauseSql,
  args: { workspaceId: string; approvalRef?: string; approvedBy?: string; expected: AcceptanceBarApproval },
): Promise<{ approvalRef: string; approvedBy: string; approvedAt: string }> {
  const match = /^thread-post:([1-9][0-9]*)$/.exec(args.approvalRef?.trim() ?? '');
  if (!match) throw new Error('acceptance_bar_approval_required: use thread-post:<id> from an authenticated reviewer post containing the preview approval JSON');
  const [post] = await sql<Array<{ author_id: string | null; body: string; approved_at: string }>>`
    SELECT author_id, body,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS approved_at
      FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${args.workspaceId} AND id = ${match[1]}::bigint
       AND origin = 'local' AND octet_length(body) <= 262144
     FOR SHARE`;
  if (!post?.author_id?.trim()) throw new Error('acceptance_bar_approval_unreadable');
  let body: unknown;
  try { body = JSON.parse(post.body); } catch { throw new Error('acceptance_bar_approval_invalid_receipt'); }
  const parsed = acceptanceBarApprovalSchema.safeParse(body);
  if (!parsed.success) throw new Error('acceptance_bar_approval_invalid_receipt');
  const receipt = parsed.data;
  if (receipt.rubricRef !== args.expected.rubricRef || receipt.subjectPlan !== args.expected.subjectPlan ||
      args.expected.bars.some((expected) => !receipt.bars.some((bar) =>
        bar.barKey === expected.barKey && bar.priorBarHash === expected.priorBarHash && bar.nextBarHash === expected.nextBarHash))) {
    throw new Error('acceptance_bar_approval_stale_or_mismatched');
  }
  if (args.approvedBy && args.approvedBy.trim() !== post.author_id) {
    throw new Error('acceptance_bar_approval_author_mismatch');
  }
  return { approvalRef: `thread-post:${match[1]}`, approvedBy: post.author_id, approvedAt: post.approved_at };
}

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
    SELECT pg_try_advisory_xact_lock(hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
      hashtext(${planAdvisoryLockKey(args.workspaceId, args.harnessSlug, subjectPlan)})) AS ok`;
  if (!lock?.ok) throw new Error('acceptance_bar_revision_subject_busy');
  const subjects = await sql<Array<{ plan_slug: string; content: string }>>`
    SELECT plan_slug, content FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${subjectPlan} FOR UPDATE`;
  if (!subjects.length) throw new Error('acceptance_bar_revision_subject_missing');
  const subject = subjects[0]!;
  let clauses = await sql<
    Array<{
      spec_id: string;
      source_val_id: string | null;
      current_revision: number | string;
      source_bar_key: string;
      plan_item_id: string;
      behavior_class: SpecClauseWrite['behaviorClass'];
      required_evidence: string[];
      required_test_layers: string[];
      mutation_required: boolean;
      lifecycle_status: SpecClauseWrite['lifecycleStatus'];
      supersedes_spec_id: string | null;
      supersedes_revision: number | null;
      exemption: Record<string, unknown> | null;
    }>
  >`
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
  const revisions = new Map<string, number>();
  const missing = data.criteria.filter(
    (criterion) =>
      criterion.role !== 'disclosure' &&
      !clauses.some((clause) => clause.source_bar_key === (criterion.barKey ?? criterion.key)),
  );
  if (missing.length > 0) {
    // A post-start BAR addition is declared first in the subject plan's
    // Requirements + Design map. Reuse that exact deterministic source instead
    // of asking the amendment caller to duplicate a second mapping payload.
    const { parseRequirementBars, parseBarMappings } = await import('./acceptance-bar-seed');
    const requirements = parseRequirementBars(subject.content);
    if (!requirements.ok) {
      throw new Error(
        `acceptance_bar_revision_requirements_invalid:${requirements.problems.map((problem) => problem.code).join(',')}`,
      );
    }
    const mappings = parseBarMappings(subject.content, new Set(requirements.bars.map((bar) => bar.barKey)));
    if (!mappings.ok) {
      throw new Error(
        `acceptance_bar_revision_mapping_invalid:${mappings.problems.map((problem) => problem.code).join(',')}`,
      );
    }
    const mappingByKey = new Map(mappings.mappings.map((mapping) => [mapping.barKey, mapping]));
    for (const criterion of missing) {
      const barKey = criterion.barKey ?? criterion.key;
      const mapping = mappingByKey.get(barKey);
      if (!mapping || !criterion.barHash || !criterion.evidencePlane || !data.barSetHash) {
        throw new Error(`acceptance_bar_revision_mapping_missing:${barKey}`);
      }
      for (const planItemId of mapping.planItemIds) {
        const specId = `AUTO-BAR-${barKey}-${planItemId}`;
        const result = await setSpecClause(
          {
            planSlug: subjectPlan,
            specId,
            expectedRevision: 0,
            planItemId,
            behavior: criterion.model!,
            behaviorClass: 'happy-path',
            requiredEvidence: [criterion.evidencePlane],
            lifecycleStatus: 'draft',
            falsifier: { observation: criterion.driftMarkers! },
            acceptanceRef: `${args.rubricSlug}@${args.rubricRevision}:${barKey}`,
            sourceBar: {
              barKey,
              barHash: criterion.barHash,
              barSetHash: data.barSetHash,
              rubricSlug: args.rubricSlug,
              rubricRevision: args.rubricRevision,
              evidencePlane: criterion.evidencePlane,
            },
            actorId: args.actorId,
          },
          { executor: sql, workspaceId: args.workspaceId, harnessSlug: args.harnessSlug },
        );
        if (result.status === 'created' || result.status === 'revised' || result.status === 'unchanged') {
          revisions.set(specId, result.revision);
        } else {
          throw new Error(`acceptance_bar_revision_projection_conflict:${specId}:${result.status}`);
        }
      }
    }
    clauses = await sql<typeof clauses>`
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
  }
  if (data.criteria.some((criterion) => criterion.role !== 'disclosure' &&
    !clauses.some((clause) => clause.source_bar_key === (criterion.barKey ?? criterion.key)))) {
    throw new Error('acceptance_bar_revision_mapping_missing');
  }
  for (const clause of clauses) {
    if (revisions.has(clause.spec_id)) continue;
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
