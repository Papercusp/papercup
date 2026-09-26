/**
 * acceptance-bar-amendment-review.ts — the routed outside-lineage review of a
 * started acceptance-BAR amendment (P-005,
 * review-routing-through-relevance-router-2026-09-26).
 *
 * D-001 [owner 2026-09-26]: every review is recruited by the relevance
 * router and answered by a fork/convert of the routed expert's transcript, never
 * by hand-picking a reviewer and messaging them. This is that route for the
 * amendment approval:
 *
 *  - the menu is bounded by ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY;
 *  - every candidate is screened with the SAME screen rubrics:check-approver
 *    exposes (`resolveAcceptanceBarApproverScreen`), applied to the routed
 *    EXPERT. The answering session forks that expert's transcript, and
 *    acceptance-author-identity gives a routed fork its source's lineage, so
 *    screening the source is screening the reviewer the apply guard will judge;
 *  - the screen runs BEFORE selection (as `filterRoute`), so minimum-fill and
 *    every later cascade rank inherit the same fence, and a screen fault throws
 *    (fail closed) instead of letting an unscreened candidate through.
 *
 * P-006 connects rubrics:amend to `routeAcceptanceBarAmendmentReview`.
 */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { AcceptanceBarApproverEligibilityCheck } from '../rubrics';
import type { RouteResult } from './relevance-router';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY } from './selection-policies';

/** One candidate's verdict from the check-approver screen. */
export type AmendmentReviewerScreen = (
  ownerId: string,
) => Promise<Pick<AcceptanceBarApproverEligibilityCheck, 'eligible' | 'reason'>>;

export interface AmendmentReviewScreenedOut {
  ownerId: string;
  reason: AcceptanceBarApproverEligibilityCheck['reason'];
}

/**
 * Keep only candidates the screen calls eligible, in both the qualified list and
 * the snapshot the minimum-fill draws from. Each distinct owner is screened
 * once; a screen error propagates.
 */
export async function filterAmendmentReviewRoute(
  route: RouteResult,
  screen: AmendmentReviewerScreen,
  onScreenedOut?: (entry: AmendmentReviewScreenedOut) => void,
): Promise<RouteResult> {
  const ownerIds = [...new Set([...route.qualified, ...route.snapshot.candidates].map((c) => c.ownerId))];
  const eligible = new Set<string>();
  for (const ownerId of ownerIds) {
    const verdict = await screen(ownerId);
    if (verdict.eligible === true) eligible.add(ownerId);
    else onScreenedOut?.({ ownerId, reason: verdict.reason });
  }
  const allowed = (candidate: { ownerId: string }) => eligible.has(candidate.ownerId);
  return {
    ...route,
    qualified: route.qualified.filter(allowed),
    snapshot: { ...route.snapshot, candidates: route.snapshot.candidates.filter(allowed) },
  };
}

export interface AmendmentReviewRouteInput {
  /** The started acceptance rubric being amended. */
  rubricRef: string;
  /** What the reviewer must inspect: the exact candidate criteria and dry-run diff. */
  brief: string;
  /** The identity that will APPLY the amendment (the requester). */
  identity: AgentIdentity;
  workspaceId: string;
  harness?: string;
}

export type AmendmentReviewRouteResult =
  | { state: 'routed'; conversationId: string; responderId: string | null; screenedOut: AmendmentReviewScreenedOut[] }
  | { state: 'no-eligible-reviewer'; conversationId: string | null; reason: string; screenedOut: AmendmentReviewScreenedOut[] };

export async function routeAcceptanceBarAmendmentReview(
  input: AmendmentReviewRouteInput,
  deps: {
    resolveScreen?: (args: { rubricId: string; applierId: string }) => Promise<{ check: AmendmentReviewerScreen }>;
    feedback?: typeof import('./get-feedback-prod').getFeedbackProd;
  } = {},
): Promise<AmendmentReviewRouteResult> {
  const rubricId = input.rubricRef.trim().replace(/^plan:/i, '').trim();
  const applierId = input.identity.ownerId;
  const resolveScreen =
    deps.resolveScreen ?? (async (args) => (await import('../rubrics')).resolveAcceptanceBarApproverScreen(args));
  // Resolve the population before routing: an unreadable rubric or implementer
  // history refuses the review rather than routing it unscreened.
  const screen = await resolveScreen({ rubricId, applierId });
  const feedback = deps.feedback ?? (await import('./get-feedback-prod')).getFeedbackProd;
  const screenedOut: AmendmentReviewScreenedOut[] = [];
  const result = await feedback(
    {
      workspaceId: input.workspaceId,
      requesterId: applierId,
      question: input.brief,
      originTaskRef: rubricId,
      // The applier is also screened; excluding it up front keeps it out of
      // the router's own candidate accounting.
      excludeOwners: [applierId],
      // An archived answer is not an approval of THIS diff: always route fresh.
      archiveFloor: 2,
      policy: ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY,
      latencyContract: 'hard-blocked',
      ...(input.harness ? { harnessSlug: input.harness } : {}),
    },
    input.identity,
    { filterRoute: (route) => filterAmendmentReviewRoute(route, screen.check, (entry) => screenedOut.push(entry)) },
  );
  if ('error' in result) throw new Error(`acceptance_bar_amendment_review_refused: ${result.error}`);
  if (result.verdict === 'routed') {
    return {
      state: 'routed',
      conversationId: result.conversation_id,
      responderId: result.responder?.ownerId ?? null,
      screenedOut,
    };
  }
  return {
    state: 'no-eligible-reviewer',
    conversationId: result.conversation_id ?? null,
    reason: `${result.verdict}${result.reason ? ` (${result.reason})` : ''}`,
    screenedOut,
  };
}
