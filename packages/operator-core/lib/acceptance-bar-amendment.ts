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
import { OrgTxnTimeoutError } from './pg-bounded-txn';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey, PLAN_ADVISORY_LOCK_NAMESPACE } from './agent-tools/plans/plan-lock-key';
import { rubricTemplateDataAuthoringSchema } from './agent-tools/plans/rubric-template';
import { setSpecClause, type SpecClauseSql, type SpecClauseWrite } from './agent-tools/plans/spec-clauses-store';

export type AcceptanceBarAmendmentSql = Sql | TransactionSql;

/** Fingerprint the authored BAR source, including its map edges.
 *
 * Ordinary plan writes (Now/Decision/progress updates) should not invalidate a
 * BAR pin, but a Requirements or Bar-to-work-map edit must remain stale until
 * the canonical BAR writer re-adopts it. This is deliberately stricter than
 * `barSetHash`: the rubric hash captures BAR meaning, while this source
 * fingerprint also catches mapping changes that would otherwise leave the
 * clause projection stale.
 */
export async function acceptanceBarSourceFingerprint(body: string): Promise<string | null> {
  const { parseRequirementBars, parseBarMappings } = await import('./acceptance-bar-seed');
  const requirements = parseRequirementBars(body);
  if (!requirements.ok) return null;
  const mappings = parseBarMappings(
    body,
    new Set(requirements.bars.map((bar) => bar.barKey)),
  );
  if (!mappings.ok) return null;
  const material = {
    bars: requirements.bars.map((bar) => ({
      barKey: bar.barKey,
      model: bar.model,
      criterion: bar.criterion ?? null,
    })),
    mappings: mappings.mappings.map((mapping) => ({
      barKey: mapping.barKey,
      planItemIds: [...mapping.planItemIds].sort(),
      evidencePlane: mapping.evidencePlane,
    })),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/** Keep a derived subject-version pin current after a BAR-neutral write.
 *
 * Called while the subject lock is held. The rubric try-lock avoids reversing an
 * amendment's lock order. The current rubric BAR-set hash is checked against the
 * new subject source before updating, so a stale pin can be repaired without
 * blessing a Requirements change. The source fingerprint additionally refuses
 * map changes, because those require projection refresh even when BAR hashes
 * happen to remain equal.
 */
export async function synchronizeAcceptanceBarSubjectRevision(
  sql: AcceptanceBarAmendmentSql,
  args: {
    workspaceId: string; harnessSlug: string; planSlug: string;
    previousBody: string; nextBody: string; previousVersion: number; nextVersion: number;
  },
): Promise<boolean> {
  // Re-audit can catch up across several neutral plan writes. Source equality
  // and the locked rubric/hash checks below still govern every pin advance.
  if (!Number.isSafeInteger(args.previousVersion) || args.previousVersion < 1 ||
      !Number.isSafeInteger(args.nextVersion) || args.nextVersion <= args.previousVersion) return false;
  const [previousSource, nextSource] = await Promise.all([
    acceptanceBarSourceFingerprint(args.previousBody),
    acceptanceBarSourceFingerprint(args.nextBody),
  ]);
  if (!previousSource || !nextSource || previousSource !== nextSource) return false;
  const [subject] = await sql<Array<{
    status: string | null;
    acceptance_bar_rubric_slug: string; acceptance_bar_rubric_revision: number;
    acceptance_bar_set_hash: string;
  }>>`
    SELECT status, acceptance_bar_rubric_slug, acceptance_bar_rubric_revision, acceptance_bar_set_hash
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${args.planSlug} AND version = ${args.nextVersion}
       AND content = ${args.nextBody} AND acceptance_bar_rubric_slug IS NOT NULL`;
  if (!subject) return false;
  const [lock] = await sql<Array<{ ok: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
      hashtext(${planAdvisoryLockKey(args.workspaceId, args.harnessSlug, subject.acceptance_bar_rubric_slug)})) AS ok`;
  if (!lock?.ok) throw new Error('acceptance_bar_subject_revision_rubric_busy');
  const [rubric] = await sql<Array<{ version: number | string; template_data: unknown }>>`
    SELECT version, template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${subject.acceptance_bar_rubric_slug}
       AND template = 'rubric' AND template_data->>'kind' = 'acceptance'
     FOR UPDATE`;
  if (!rubric || Number(rubric.version) !== Number(subject.acceptance_bar_rubric_revision)) return false;
  const parsedRubric = rubricTemplateDataAuthoringSchema.safeParse(rubric.template_data);
  if (!parsedRubric.success || parsedRubric.data.subjectPlan !== args.planSlug ||
      !parsedRubric.data.barContract || parsedRubric.data.barSetHash !== subject.acceptance_bar_set_hash) {
    return false;
  }
  const existingBarCriteria = parsedRubric.data.criteria.filter((criterion) => criterion.barKey);
  if (existingBarCriteria.length === 0) return false;
  const { buildAcceptanceBarSeed } = await import('./acceptance-bar-seed');
  const rebuilt = buildAcceptanceBarSeed({
    planSlug: args.planSlug,
    planContent: args.nextBody,
    actorId: 'system:acceptance-bar-subject-revision',
    declaredAt: parsedRubric.data.barContract.seededAt,
    cohort: parsedRubric.data.barContract.cohort,
    backfilled: parsedRubric.data.barContract.cohort === 'legacy-backfilled',
    adoptionEpoch: parsedRubric.data.barContract.adoptionEpoch,
    subjectPlanRevision: args.nextVersion,
    planStatus: subject.status,
    rubricSlug: subject.acceptance_bar_rubric_slug,
    rubricRevision: Number(rubric.version),
    existingTemplateData: { ...parsedRubric.data, criteria: existingBarCriteria },
    // The source fingerprints above are already proven identical, so this write
    // changes no BAR meaning and only the subject-revision pin advances. Preserve
    // the canonical BARs verbatim; re-deriving them from the plan body would revert
    // amended criterion text to the original seed. The barSetHash equality check
    // immediately below still gates the update (WI-10000058).
    preserveExistingBars: true,
  });
  if (!rebuilt.ok || rebuilt.barSetHash !== subject.acceptance_bar_set_hash) return false;
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

/** EI-22617748468342848: reviewers routinely post the approval receipt inside a
 * ```json fence, which is the natural way to post JSON in a comment thread. The
 * fence is presentation, so strip it before parsing. Authenticity is unaffected:
 * it derives from post.author_id and the append-only post row, never from how the
 * body was framed. A body with no fence is returned unchanged. */
export function approvalReceiptJsonSource(body: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(body.trim());
  return fenced ? fenced[1] : body;
}

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
  try { body = JSON.parse(approvalReceiptJsonSource(post.body)); } catch { throw new Error('acceptance_bar_approval_unparseable: the approval post body is not JSON. Post the preview approval object as the entire comment body — a heading or a covering sentence around it breaks this (a ```json fence is tolerated).'); }
  const parsed = acceptanceBarApprovalSchema.safeParse(body);
  if (!parsed.success) throw new Error('acceptance_bar_approval_invalid_receipt');
  const receipt = parsed.data;
  if (receipt.rubricRef !== args.expected.rubricRef || receipt.subjectPlan !== args.expected.subjectPlan) {
    throw new Error('acceptance_bar_approval_stale_or_mismatched');
  }
  // R-5 (acceptance-machinery-seam-fixes-2026-09-16): NOT COVERED and STALE are
  // different failures with different repairs, so they no longer share a code. A
  // bar the amendment applies that the receipt never names was not reviewed at
  // all — re-posting the same preview cannot fix that, which is exactly what a
  // `_stale_or_mismatched` reading invites the caller to try. Name the uncovered
  // bars so the reviewer is asked about the part of the delta they never saw.
  const receiptBarKeys = new Set(receipt.bars.map((bar) => bar.barKey));
  const uncovered = args.expected.bars
    .filter((expected) => !receiptBarKeys.has(expected.barKey))
    .map((expected) => expected.barKey);
  if (uncovered.length > 0) {
    throw new Error(
      `acceptance_bar_approval_incomplete: the applied amendment changes ${uncovered.join(', ')}, ` +
        `which the approval does not cover — have the reviewer approve the full preview delta`,
    );
  }
  if (
    args.expected.bars.some((expected) => !receipt.bars.some((bar) =>
      bar.barKey === expected.barKey && bar.priorBarHash === expected.priorBarHash && bar.nextBarHash === expected.nextBarHash))
  ) {
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
    previousTemplateData?: unknown;
    actorId: string;
  },
): Promise<Map<string, number>> {
  const parsed = rubricTemplateDataAuthoringSchema.safeParse(args.templateData);
  if (!parsed.success || parsed.data.kind !== 'acceptance' || !parsed.data.barContract || !parsed.data.subjectPlan) {
    return new Map();
  }
  const data = parsed.data;
  const previous = rubricTemplateDataAuthoringSchema.safeParse(args.previousTemplateData);
  const previousByKey = new Map(previous.success && previous.data.subjectPlan === data.subjectPlan
    ? previous.data.criteria.map((criterion) => [criterion.barKey ?? criterion.key, criterion])
    : []);
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
      source_bar_hash: string;
      plan_item_id: string;
      behavior: string;
      behavior_class: SpecClauseWrite['behaviorClass'];
      falsifier: SpecClauseWrite['falsifier'];
      required_evidence: string[];
      required_test_layers: string[];
      mutation_required: boolean;
      lifecycle_status: SpecClauseWrite['lifecycleStatus'];
      supersedes_spec_id: string | null;
      supersedes_revision: number | null;
      exemption: Record<string, unknown> | null;
    }>
  >`
    SELECT c.spec_id, c.source_val_id, c.current_revision, r.source_bar_key, r.source_bar_hash,
           r.plan_item_id, r.behavior, r.behavior_class, r.falsifier, r.required_evidence, r.required_test_layers,
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
  const { acceptanceBarBehaviorClass, parseRequirementBars, parseBarMappings } = await import('./acceptance-bar-seed');
  const { computeAcceptanceBarHash } = await import('./rubrics');
  const byKey = new Map(data.criteria.map((criterion) => [criterion.barKey ?? criterion.key, criterion]));
  const revisions = new Map<string, number>();
  // The subject plan is the canonical discharge map. Diff every desired
  // (BAR, plan-item) edge, not merely whether a BAR has any clause: an existing
  // BAR may expand from one implementing item to several during an as-built
  // amendment. Treating that BAR as already present made preview report the
  // expanded mapping while apply silently left the new edges unprojected.
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
  const missingMappings = mappings.mappings.flatMap((mapping) => {
    const criterion = byKey.get(mapping.barKey);
    if (!criterion || criterion.role === 'disclosure') return [];
    return mapping.planItemIds
      .filter((planItemId) => !clauses.some(
        (clause) => clause.source_bar_key === mapping.barKey && clause.plan_item_id === planItemId,
      ))
      .map((planItemId) => ({ criterion, barKey: mapping.barKey, planItemId }));
  });
  if (missingMappings.length > 0) {
    for (const { criterion, barKey, planItemId } of missingMappings) {
      if (!criterion.barHash || !criterion.evidencePlane || !data.barSetHash) {
        throw new Error(`acceptance_bar_revision_mapping_missing:${barKey}`);
      }
      const specId = `AUTO-BAR-${barKey}-${planItemId}`;
      const result = await setSpecClause(
        {
          planSlug: subjectPlan,
          specId,
          expectedRevision: 0,
          planItemId,
          behavior: criterion.model!,
          behaviorClass: acceptanceBarBehaviorClass(criterion.evidencePlane, criterion.requiredTestLayers),
          requiredEvidence: [criterion.evidencePlane],
          ...(criterion.requiredTestLayers ? { requiredTestLayers: criterion.requiredTestLayers } : {}),
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
    clauses = await sql<typeof clauses>`
      SELECT c.spec_id, c.source_val_id, c.current_revision, r.source_bar_key, r.source_bar_hash,
             r.plan_item_id, r.behavior, r.behavior_class, r.falsifier, r.required_evidence, r.required_test_layers,
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
  if (mappings.mappings.some((mapping) => {
    const criterion = byKey.get(mapping.barKey);
    return criterion?.role !== 'disclosure' && mapping.planItemIds.some((planItemId) =>
      !clauses.some((clause) => clause.source_bar_key === mapping.barKey && clause.plan_item_id === planItemId));
  })) {
    throw new Error('acceptance_bar_revision_mapping_missing');
  }
  for (const clause of clauses) {
    if (revisions.has(clause.spec_id)) continue;
    const criterion = byKey.get(clause.source_bar_key);
    if (!criterion?.barHash || !criterion.evidencePlane || !data.barSetHash) {
      throw new Error(`acceptance_bar_revision_projection_unmapped:${clause.spec_id}`);
    }
    // METHOD and test-layer changes do not replace an author's atomic behavior.
    // Verify the old canonical BAR matches this clause, then compare with only
    // the layer field restored. All other meaning fields remain hash-checked.
    // Comparing whole hashes alone erased reviewed scenarios and causal pairs
    // whenever an approved amendment changed proof depth (EI-22755746610403259).
    const unchangedBar = clause.source_bar_hash === criterion.barHash;
    const prior = previousByKey.get(clause.source_bar_key);
    const layersOnly = !unchangedBar && prior?.barHash === clause.source_bar_hash &&
      computeAcceptanceBarHash({ ...criterion, requiredTestLayers: prior.requiredTestLayers }) === clause.source_bar_hash;
    const preserveRefinements = unchangedBar || layersOnly;
    // Replace the parent's layer requirements while retaining any extra layers
    // authored on this atomic clause. This also respects an approved removal.
    const requiredTestLayers = unchangedBar ? clause.required_test_layers : layersOnly
      ? [...new Set([
          ...clause.required_test_layers.filter((layer) => !prior!.requiredTestLayers?.includes(layer)),
          ...(criterion.requiredTestLayers ?? []),
        ])]
      : criterion.requiredTestLayers ?? clause.required_test_layers;
    const result = await setSpecClause({
      planSlug: subjectPlan, specId: clause.spec_id, sourceValId: clause.source_val_id,
      expectedRevision: Number(clause.current_revision), planItemId: clause.plan_item_id,
      behavior: preserveRefinements ? clause.behavior : criterion.model!,
      behaviorClass: preserveRefinements
        ? clause.behavior_class
        : acceptanceBarBehaviorClass(criterion.evidencePlane, criterion.requiredTestLayers),
      requiredEvidence: preserveRefinements ? clause.required_evidence
        : clause.required_evidence.map((value) => ['tree', 'deployed', 'live'].includes(value) ? criterion.evidencePlane! : value),
      requiredTestLayers, mutationRequired: clause.mutation_required,
      lifecycleStatus: clause.lifecycle_status, exemption: clause.exemption,
      supersedes: clause.supersedes_spec_id && clause.supersedes_revision
        ? { specId: clause.supersedes_spec_id, revision: clause.supersedes_revision } : null,
      falsifier: preserveRefinements ? clause.falsifier : { observation: criterion.driftMarkers! },
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

/**
 * Decide whether one re-projected clause may keep its existing proof (P-008).
 *
 * Extracted deliberately: the carry itself is inside the amendment transaction,
 * so this predicate is the only part of the rule a unit test can reach. Every
 * condition here is a refusal reason, and each one is load-bearing:
 *   - a bar in `changedBars` has different MEANING, so its proof must be re-run;
 *   - an unknown/missing bar key is NOT treated as unchanged — a clause we cannot
 *     attribute to a bar is the one case where guessing preserves a proof that
 *     should have died;
 *   - a revision that did not move needs no carry (its proof is already current).
 */
export function shouldCarryBarEvidence(args: {
  sourceBarKey: string | null | undefined;
  changedBars: Iterable<string>;
  priorRevision: number | undefined;
  nextRevision: number;
}): boolean {
  if (args.priorRevision === undefined) return false;
  if (args.priorRevision === args.nextRevision) return false;
  const key = args.sourceBarKey?.trim();
  if (!key) return false;
  for (const changed of args.changedBars) {
    if (changed === key) return false;
  }
  return true;
}

export interface CarryUnchangedBarEvidenceArgs {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  specId: string;
  priorRevision: number;
  nextRevision: number;
  /** The content hash of the clause at `nextRevision`. */
  nextSpecFingerprint: string;
}

/**
 * Carry a clause's existing evidence bindings forward onto the revision an
 * amendment just minted, for a BAR whose own meaning did NOT change
 * (acceptance-machinery-seam-fixes-2026-09-16 P-008).
 *
 * Every amendment re-projects EVERY clause so each one pins the global rubric
 * revision and BAR-set hash — deliberately, because the ship gate compares that
 * pin against the plan's current rubric revision. The cost was that an unchanged
 * BAR's clause still got a new revision, which stranded its proof at the old one:
 * amending BAR R-3 invalidated the evidence for R-1, R-2 and every other bar, and
 * the whole plan had to be re-proved. That is what made a single-criterion repair
 * cost a full re-binding pass (observed on green-gate-zero-wait-convergence, where
 * "all 11 AUTO-BAR clauses re-projected, so every prior binding is stale").
 *
 * Only the caller's UNCHANGED-bar set may be carried: a bar whose hash moved has
 * genuinely different meaning and its proof must be re-run. Two rails keep this
 * honest rather than merely cheap:
 *   - the INSERT joins `work_item_spec_revision_edges` at `nextRevision`, so a
 *     binding is carried only where the contract edge actually exists (the FK
 *     demands it, and a missing edge means that work-item is no longer bound);
 *   - `binding_fingerprint` is RECOMPUTED over the new revision + fingerprint.
 *     Copying the old hash would be cheaper and wrong: the fingerprint is defined
 *     over the revision it pins, so a copied one stops matching its own row and
 *     the next identical bind appends a duplicate instead of deduplicating.
 *
 * `observed_at` and `created_by` are preserved: the proof was observed when it was
 * observed, and the carry is not a new observation by the amending actor.
 */
export async function carryUnchangedBarEvidenceBindings(
  sql: AcceptanceBarAmendmentSql,
  args: CarryUnchangedBarEvidenceArgs,
): Promise<number> {
  if (args.nextRevision === args.priorRevision) return 0;
  const rows = await sql<
    Array<{
      work_item_id: string;
      evidence_kind: string;
      evidence_ref: string;
      source_fingerprint: string;
      test_fingerprint: string | null;
      fixture_fingerprint: string | null;
      rubric_fingerprint: string | null;
      environment_fingerprint: string | null;
      coverage_evidence_ref: string | number | null;
      test_run_id: string | number | null;
      details: Record<string, unknown>;
      observed_at: Date;
      created_by: string;
    }>
  >`
    SELECT b.work_item_id, b.evidence_kind, b.evidence_ref, b.source_fingerprint,
           b.test_fingerprint, b.fixture_fingerprint, b.rubric_fingerprint,
           b.environment_fingerprint, b.coverage_evidence_ref, b.test_run_id,
           b.details, b.observed_at, b.created_by
      FROM harness_shared.spec_evidence_bindings b
      JOIN harness_shared.work_item_spec_revision_edges e
        ON e.workspace_id = b.workspace_id AND e.harness_slug = b.harness_slug
       AND e.work_item_id = b.work_item_id AND e.plan_slug = b.plan_slug
       AND e.spec_id = b.spec_id
     WHERE b.workspace_id = ${args.workspaceId} AND b.harness_slug = ${args.harnessSlug}
       AND b.plan_slug = ${args.planSlug} AND b.spec_id = ${args.specId}
       AND b.spec_revision = ${args.priorRevision}
       -- A retracted binding must NOT be carried onto the next revision. Carry re-INSERTS
       -- the row under nextRevision, so without this filter a retraction would be undone by
       -- the next bar amendment: the withdrawn proof reappears as a fresh, un-retracted row
       -- and the clause is re-poisoned. D-011 makes recorded retraction the ONLY sanctioned
       -- repair for a malformed binding, so carry silently resurrecting one defeats the
       -- repair path outright. Retraction is one-way: what a default read must not see, a
       -- carry must not propagate.
       AND b.retracted_at IS NULL
       AND e.spec_revision = ${args.nextRevision}
       AND e.spec_fingerprint = ${args.nextSpecFingerprint}
     ORDER BY b.id LIMIT 1001`;
  if (rows.length > 1000) throw new Error('acceptance_bar_amendment_evidence_carry_truncated');
  if (!rows.length) return 0;
  const { specEvidenceBindingFingerprint } = await import('./agent-tools/plans/spec-evidence-store');
  let carried = 0;
  for (const row of rows) {
    const coverageEvidenceRef = row.coverage_evidence_ref == null ? null : Number(row.coverage_evidence_ref);
    const testRunId = row.test_run_id == null ? null : Number(row.test_run_id);
    const bindingFingerprint = specEvidenceBindingFingerprint({
      workspaceId: args.workspaceId,
      harnessSlug: args.harnessSlug,
      workItemId: row.work_item_id,
      planSlug: args.planSlug,
      specId: args.specId,
      specRevision: args.nextRevision,
      specFingerprint: args.nextSpecFingerprint,
      evidenceKind: row.evidence_kind as never,
      evidenceRef: row.evidence_ref,
      sourceFingerprint: row.source_fingerprint,
      testFingerprint: row.test_fingerprint,
      fixtureFingerprint: row.fixture_fingerprint,
      rubricFingerprint: row.rubric_fingerprint,
      environmentFingerprint: row.environment_fingerprint,
      coverageEvidenceRef,
      testRunId,
      details: row.details ?? {},
    });
    await sql`
      INSERT INTO harness_shared.spec_evidence_bindings (
        workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision,
        spec_fingerprint, evidence_kind, evidence_ref, source_fingerprint, test_fingerprint,
        fixture_fingerprint, rubric_fingerprint, environment_fingerprint, coverage_evidence_ref,
        test_run_id, details, observed_at, binding_fingerprint, created_by
      ) VALUES (
        ${args.workspaceId}, ${args.harnessSlug}, ${row.work_item_id}, ${args.planSlug},
        ${args.specId}, ${args.nextRevision}, ${args.nextSpecFingerprint}, ${row.evidence_kind},
        ${row.evidence_ref}, ${row.source_fingerprint}, ${row.test_fingerprint},
        ${row.fixture_fingerprint}, ${row.rubric_fingerprint}, ${row.environment_fingerprint},
        ${coverageEvidenceRef}, ${testRunId}, ${JSON.stringify(row.details ?? {})}::jsonb,
        ${row.observed_at}, ${bindingFingerprint}, ${row.created_by}
      ) ON CONFLICT DO NOTHING`;
    carried += 1;
  }
  return carried;
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
  try {
    return await withWorkspace(workspaceId, async (tx) => {
      for (const plan of plans) {
        await acquirePlanAdvisoryLock(
          tx,
          planAdvisoryLockKey(plan.workspaceId, plan.harnessSlug, plan.planSlug),
          budgetMs,
        );
      }
      return work(tx);
    });
  } catch (error) {
    // acquirePlanAdvisoryLock deliberately propagates PostgreSQL's 55P03 after
    // the transaction has been aborted. This boundary is the caller-facing
    // cross-plan write seam, so normalize that raw driver error to the same
    // typed contention contract used by other operator writes.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '55P03') throw new OrgTxnTimeoutError(code, error);
    throw error;
  }
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
