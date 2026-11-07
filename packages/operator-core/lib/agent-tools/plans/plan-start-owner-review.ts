/** Owner-selected pre-implementation reviews use the existing immutable revision spine.
 * They never create consult answers or change the ordinary critique threshold. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { getOwnerDirective, type OwnerDirectiveRow } from '../../owner-directives';
import { getReport, type ReportRecord } from '../../report-library';
import { lineagePartyKeys } from '../../acceptance-author-identity';
import type { AgentIdentity } from '../coordination/identity';
import { recordPlanRevision } from './revisions';
import { computeSpecSetHash } from './spec-clause-compiler';
import { listSpecClauses, type SpecClauseRevision } from './spec-clauses-store';
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
  schema: 'plan-owner-selected-review-v1';
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
  if (directive.recordedBy !== reviewerId && !selection.includes(report.reportId) && !selection.includes(reviewerId))
    return refuse('owner_selection_report_mismatch');
  const live = input.reviewedClauses.filter(isLiveBarCritiqueClause);
  if (!live.length || barSetHashOf(live) !== request.barSetHash || computeSpecSetHash(live) !== request.specSetHash
    || !report.bodyMd.includes(request.barSetHash) || !report.bodyMd.includes(request.specSetHash))
    return refuse('review_contract_not_pinned');
  const contract = ownerReviewContract(input.reviewedClauses);
  if (barSetHashOf(input.currentClauses) !== request.barSetHash
    || JSON.stringify(contract) !== JSON.stringify(ownerReviewContract(input.currentClauses)))
    return refuse('review_contract_stale');
  return { ok: true, receipt: { schema: 'plan-owner-selected-review-v1', scope, requestedBy: input.requestedBy,
    request, reviewerId, reviewedAt: report.publishedAt, contract } };
}

/** Every use re-resolves immutable sources and current lineage/contract. */
export async function resolveOwnerSelectedReview(scope: OwnerReviewScope, request: OwnerSelectedReviewRequest,
  requestedBy: string, authorIds: readonly string[], sql: Sql = getOrgPg().sql): Promise<OwnerSelectedReviewResult> {
  const [directive, report, currentClauses] = await Promise.all([
    getOwnerDirective(request.directiveId, sql),
    getReport(sql, scope.workspaceId, request.reportId, { ownerId: requestedBy, potSlug: scope.harnessSlug },
      undefined, { currentEditionOnly: true }),
    listSpecClauses(scope),
  ]);
  if (!report) return { ok: false, reason: 'review_source_unavailable' };
  const [history, keys] = await Promise.all([
    listSpecClauses({ ...scope, asOf: report.publishedAt }),
    lineagePartyKeys([...authorIds, requestedBy, report.origin.authorOwnerId ?? ''], { sql, workspaceId: scope.workspaceId }),
  ]);
  return verifyOwnerSelectedReview({ scope, requestedBy, request, directive, report,
    latestReportId: report.reportId,
    authorPartyKeys: new Set([...authorIds, requestedBy].map(id => keys.get(id) ?? id)),
    reviewerPartyKey: report.origin.authorOwnerId ? keys.get(report.origin.authorOwnerId) ?? report.origin.authorOwnerId : null,
    reviewedClauses: history, currentClauses });
}

/** A registration is evidence, not activation. Failure of a later gate grants nothing. */
export async function registerOwnerSelectedReview(scope: OwnerReviewScope, request: OwnerSelectedReviewRequest,
  identity: AgentIdentity): Promise<OwnerSelectedReviewResult> {
  const resolved = await resolveOwnerSelectedReview(scope, request, identity.ownerId, []);
  if (!resolved.ok) return resolved;
  const revision = await recordPlanRevision({ ...scope, identity, rationale: REVISION_REASON,
    content: JSON.stringify(resolved.receipt) });
  return revision ? resolved : { ok: false, reason: 'review_receipt_not_recorded' };
}

/** Newest registration wins, even if revoked/stale; never resurrect an older selection. */
export async function loadOwnerSelectedReview(scope: OwnerReviewScope, authorIds: readonly string[], sql: Sql) {
  const [row] = await sql<{ content_snapshot: string }[]>`
    SELECT content_snapshot FROM harness_shared.plan_revisions
     WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
       AND rationale=${REVISION_REASON} ORDER BY seq DESC LIMIT 1`;
  if (!row) return null;
  try {
    const saved = JSON.parse(row.content_snapshot) as OwnerSelectedReviewReceipt;
    if (saved.schema !== 'plan-owner-selected-review-v1' || !isDeepStrictEqual(saved.scope, scope)
      || !saved.requestedBy) return { ok: false as const, reason: 'review_receipt_invalid' };
    const request = ownerSelectedReviewSchema.parse(saved.request);
    const resolved = await resolveOwnerSelectedReview(scope, request, saved.requestedBy, authorIds, sql);
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
