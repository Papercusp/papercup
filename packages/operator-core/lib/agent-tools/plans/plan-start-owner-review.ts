/** Owner-selected pre-implementation reviews use the existing immutable revision spine.
 * They never create consult answers or change the ordinary critique threshold. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { getOwnerDirective, type OwnerDirectiveRow } from '../../owner-directives';
import { getReport, type ReportRecord } from '../../report-library';
import { lineagePartyKeys } from '../../acceptance-author-identity';
import type { AgentIdentity } from '../coordination/identity';
import { acquirePlanRevisionAdvisoryLock, recordPlanRevisionInTransaction, type PlanRevisionSql } from './revisions';
import { PLAN_ADVISORY_LOCK_BUDGET_MS } from './plan-lock-key';
import { computeSpecSetHash } from './spec-clause-compiler';
import { listSpecClauses, type SpecClauseRevision, type SpecClauseSql } from './spec-clauses-store';
import { barSetHashOf, clauseSemanticHash, isLiveBarCritiqueClause } from './plan-start-critique-gate';

const HASH = z.string().regex(/^[a-f0-9]{64}$/);
export const ownerSelectedReviewSchema = z.object({
  directiveId: z.number().int().positive(),
  reportId: z.string().min(1).max(200),
  bodySha256: HASH,
  barSetHash: HASH,
  specSetHash: HASH,
  selectionText: z.string().trim().min(10).max(4000),
  reviewConclusion: z.string().trim().min(10).max(2000),
  dispositions: z.string().trim().min(10).max(8000),
}).strict();
export type OwnerSelectedReviewRequest = z.infer<typeof ownerSelectedReviewSchema>;
export interface OwnerReviewScope { workspaceId: string; harnessSlug: string; planSlug: string }
export interface OwnerSelectedReviewReceipt {
  schema: 'plan-owner-selected-review-v2';
  scope: OwnerReviewScope;
  requestedBy: string;
  request: OwnerSelectedReviewRequest;
  reviewerId: string;
  reviewedAt: string;
  /** Includes removed/superseded clauses, so their dispositions cannot disappear. */
  contract: Array<{ specId: string; semanticHash: string; live: boolean }>;
}
export type OwnerSelectedReviewResult =
  | { ok: true; receipt: OwnerSelectedReviewReceipt }
  | { ok: false; reason: string };
const REVISION_REASON = 'plans:start owner-selected pre-implementation review';

export function ownerReviewContract(clauses: readonly SpecClauseRevision[]) {
  return clauses.map(c => ({ specId: c.specId, semanticHash: clauseSemanticHash(c), live: isLiveBarCritiqueClause(c) }))
    .sort((a, b) => a.specId.localeCompare(b.specId));
}

/** Origin is verified by the hook ledger, never by the quoted name in a plan/report.
 * Selection must be the complete captured statement, not an excerpt hiding a refusal. */
export function verifyOwnerSelectedReview(input: {
  scope: OwnerReviewScope; requestedBy: string; request: OwnerSelectedReviewRequest;
  directive: OwnerDirectiveRow | null; report: ReportRecord | null;
  latestReportId: string | null; authorPartyKeys: ReadonlySet<string>; reviewerPartyKey: string | null;
  reviewedClauses: readonly SpecClauseRevision[]; currentClauses: readonly SpecClauseRevision[];
}): OwnerSelectedReviewResult {
  const { scope, request, directive, report } = input;
  const refuse = (reason: string): OwnerSelectedReviewResult => ({ ok: false, reason });
  if (!directive?.capturedByHook || directive.id !== request.directiveId
    || directive.workspaceId !== scope.workspaceId || !directive.sourceTurnRef
    || directive.dispositionStatus === 'declined') return refuse('owner_selection_unverified');
  const selection = request.selectionText.trim();
  if (selection !== directive.verbatimText.trim() || !/\breview\b/i.test(selection)
    || !/\b(accept|adequate|replace)\b/i.test(selection)
    || /\b(no|not|never|refuse|reject|decline)\b|don't|do not/i.test(selection))
    return refuse('owner_selection_not_acceptance');
  if (!report || report.reportId !== request.reportId || report.workspaceId !== scope.workspaceId || report.subject.kind !== 'plan'
    || report.subject.ref !== scope.planSlug
    || (report.origin.harnessSlug !== null && report.origin.harnessSlug !== scope.harnessSlug)
    || report.kind !== 'review' || report.retiredAt || input.latestReportId !== report.reportId)
    return refuse('review_source_wrong_scope_or_superseded');
  if (report.bodySha256 !== request.bodySha256
    || createHash('sha256').update(report.bodyMd).digest('hex') !== request.bodySha256)
    return refuse('review_body_mismatch');
  if (!report.bodyMd.includes(request.reviewConclusion)) return refuse('review_conclusion_mismatch');
  const reviewerId = report.origin.authorOwnerId;
  if (!reviewerId || !input.reviewerPartyKey || input.authorPartyKeys.has(input.reviewerPartyKey))
    return refuse('review_author_lineage');
  // An implicit "your review" is scoped to the session the owner addressed.
  // Selecting a different reviewer must name that report or reviewer explicitly.
  if (!selection.includes(report.reportId) && !selection.includes(reviewerId)
    && (directive.recordedBy !== reviewerId || !directive.sessionRef
      || directive.sessionRef !== report.origin.authorSessionRef))
    return refuse('owner_selection_report_mismatch');
  const live = input.reviewedClauses.filter(isLiveBarCritiqueClause);
  if (!live.length || barSetHashOf(live) !== request.barSetHash || computeSpecSetHash(live) !== request.specSetHash
    || !report.bodyMd.includes(request.barSetHash) || !report.bodyMd.includes(request.specSetHash))
    return refuse('review_contract_not_pinned');
  const contract = ownerReviewContract(input.reviewedClauses);
  if (barSetHashOf(input.currentClauses) !== request.barSetHash
    || JSON.stringify(contract) !== JSON.stringify(ownerReviewContract(input.currentClauses)))
    return refuse('review_contract_stale');
  return { ok: true, receipt: { schema: 'plan-owner-selected-review-v2', scope, requestedBy: input.requestedBy,
    request, reviewerId, reviewedAt: report.publishedAt, contract } };
}

/** Every use re-resolves immutable sources and current lineage/contract. */
export async function resolveOwnerSelectedReview(scope: OwnerReviewScope, request: OwnerSelectedReviewRequest,
  requestedBy: string, authorIds: readonly string[], sql: Sql = getOrgPg().sql,
  inTransaction = false): Promise<OwnerSelectedReviewResult> {
  const transaction = inTransaction ? { ...scope, executor: sql as unknown as SpecClauseSql } : undefined;
  const [directive, report, currentClauses] = await Promise.all([
    getOwnerDirective(request.directiveId, sql),
    getReport(sql, scope.workspaceId, request.reportId, { ownerId: requestedBy, potSlug: scope.harnessSlug },
      undefined, { currentEditionOnly: true }),
    listSpecClauses(scope, transaction),
  ]);
  if (!report) return { ok: false, reason: 'review_source_unavailable' };
  const [history, keys] = await Promise.all([
    listSpecClauses({ ...scope, asOf: report.publishedAt }, transaction),
    lineagePartyKeys([...authorIds, requestedBy, report.origin.authorOwnerId ?? ''], { sql, workspaceId: scope.workspaceId }),
  ]);
  return verifyOwnerSelectedReview({ scope, requestedBy, request, directive, report,
    latestReportId: report.reportId,
    authorPartyKeys: new Set([...authorIds, requestedBy].map(id => keys.get(id) ?? id)),
    reviewerPartyKey: report.origin.authorOwnerId ? keys.get(report.origin.authorOwnerId) ?? report.origin.authorOwnerId : null,
    reviewedClauses: history, currentClauses });
}

/** One directive selects one immutable target across the workspace. Reuse the
 * existing revision spine; the directive lock precedes its per-plan revision lock.
 * The caller must verify the receipt inside the same transaction. */
export async function recordOwnerSelectedReviewInTransaction(sql: PlanRevisionSql,
  receipt: OwnerSelectedReviewReceipt, identity: AgentIdentity): Promise<OwnerSelectedReviewResult> {
  const { scope, request } = receipt;
  const key = JSON.stringify([scope.workspaceId, request.directiveId]);
  await sql`SELECT pg_advisory_xact_lock(hashtext('plan_owner_review'), hashtext(${key}))`;
  const rows = await sql<{ content_snapshot: string }[]>`
    SELECT content_snapshot FROM harness_shared.plan_revisions
     WHERE workspace_id=${scope.workspaceId} AND rationale=${REVISION_REASON}
       AND content_snapshot::jsonb #>> '{request,directiveId}' = ${String(request.directiveId)}`;
  if (rows.length) {
    if (rows.some(row => !isDeepStrictEqual(JSON.parse(row.content_snapshot), receipt)))
      return { ok: false, reason: 'owner_selection_already_bound' };
    return { ok: true, receipt };
  }
  await recordPlanRevisionInTransaction(sql, { ...scope, identity, rationale: REVISION_REASON,
    content: JSON.stringify(receipt) });
  return { ok: true, receipt };
}

/** A registration is evidence, not activation. Strict revision failure rolls
 * back the binding rather than silently dropping its authority record. */
export async function registerOwnerSelectedReview(scope: OwnerReviewScope, request: OwnerSelectedReviewRequest,
  identity: AgentIdentity): Promise<OwnerSelectedReviewResult> {
  return withWorkspace(scope.workspaceId, async tx => {
    const sql = tx as unknown as Sql;
    const key = JSON.stringify([scope.workspaceId, request.directiveId]);
    await sql`SELECT pg_advisory_xact_lock(hashtext('plan_owner_review'), hashtext(${key}))`;
    const resolved = await resolveOwnerSelectedReview(scope, request, identity.ownerId, [], sql, true);
    if (!resolved.ok) return resolved;
    return recordOwnerSelectedReviewInTransaction(tx, resolved.receipt, identity);
  });
}

/** Newest registration wins, even if revoked/stale; never resurrect an older selection. */
export async function loadOwnerSelectedReview(scope: OwnerReviewScope, authorIds: readonly string[], sql: Sql,
  inTransaction = false) {
  const [row] = await sql<{ content_snapshot: string }[]>`
    SELECT content_snapshot FROM harness_shared.plan_revisions
     WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
       AND rationale=${REVISION_REASON} ORDER BY seq DESC LIMIT 1`;
  if (!row) return null;
  try {
    const saved = JSON.parse(row.content_snapshot) as OwnerSelectedReviewReceipt;
    if (saved.schema !== 'plan-owner-selected-review-v2' || !isDeepStrictEqual(saved.scope, scope)
      || !saved.requestedBy) return { ok: false as const, reason: 'review_receipt_invalid' };
    const request = ownerSelectedReviewSchema.parse(saved.request);
    const resolved = await resolveOwnerSelectedReview(scope, request, saved.requestedBy, authorIds, sql, inTransaction);
    if (resolved.ok && !isDeepStrictEqual(resolved.receipt, saved))
      return { ok: false as const, reason: 'review_receipt_changed' };
    return resolved;
  } catch (error) {
    // Malformed evidence refuses; operational failures must propagate as UNKNOWN.
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return { ok: false as const, reason: 'review_receipt_invalid' };
    throw error;
  }
}

/** Final issuance fence, called with the plan lock and row already held.
 * The revision lock prevents a concurrent selection from replacing the receipt.
 * SHARE table locks also cover successor reports and newly inserted clauses:
 * locking only the existing rows would leave those predicate reads unfenced.
 * These are short database-only reads, after the slow policy checks. Ordinary
 * starts with no selected review acquire no evidence-table locks. */
export async function revalidateOwnerSelectedReviewForStart(sql: PlanRevisionSql, scope: OwnerReviewScope,
  planAuthorIds: readonly string[]): Promise<void> {
  const [settings] = await sql<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  await sql`SELECT set_config('lock_timeout', ${String(PLAN_ADVISORY_LOCK_BUDGET_MS)}, true)`;
  await acquirePlanRevisionAdvisoryLock(sql, scope.workspaceId, scope.harnessSlug, scope.planSlug);
  const saved = await sql`
    SELECT 1 FROM harness_shared.plan_revisions
     WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
       AND rationale=${REVISION_REASON} LIMIT 1`;
  if (saved.length) {
    await sql`LOCK TABLE harness_shared.report_library, harness_shared.owner_directives,
      harness_shared.plan_spec_clauses, harness_shared.plan_spec_clause_revisions IN SHARE MODE`;
    const audits = await sql<{ created_by: string | null }[]>`
      SELECT created_by FROM harness_shared.plan_audits
       WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
         AND audit_kind='activation'`;
    const authorIds = [...planAuthorIds, ...audits.map(row => row.created_by)]
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
    const review = await loadOwnerSelectedReview(scope, authorIds, sql as Sql, true);
    if (!review?.ok) throw new Error(`plan_start_proof_refused:${review?.reason ?? 'review_receipt_missing'}`);
  }
  await sql`SELECT set_config('lock_timeout', ${settings!.lock_timeout}, true)`;
}
