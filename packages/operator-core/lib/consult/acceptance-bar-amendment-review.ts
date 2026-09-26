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
 * P-006 connects rubrics:amend to it: `openAcceptanceBarAmendmentReview` checks
 * the requester's preview post with the apply guard's own resolver, then routes
 * a brief that carries everything the reviewer signs (no tool reads a thread
 * post by id, so the brief cannot just point at it).
 */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { AcceptanceBarAmendmentPreview, AcceptanceBarApproverEligibilityCheck } from '../rubrics';
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

const PREVIEW_POST_REF = /^thread-post:[1-9][0-9]*$/;
const BRIEF_REASON_MAX = 800;
const BRIEF_PATCH_MAX = 2500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars clipped]`;
}

export interface AmendmentReviewBriefInput {
  rubricRef: string;
  /** `thread-post:<id>` — the requester's post carrying the exact preview approval JSON. */
  previewPostRef: string;
  preview: Pick<AcceptanceBarAmendmentPreview, 'approval' | 'changes'>;
  reason?: string;
  /** The amendment fields as requested, so the reviewer can reproduce the preview. */
  patch: Record<string, unknown>;
}

/**
 * What the routed reviewer reads. It carries the approval JSON and the patch
 * itself because no tool reads a thread post by id, and it names the one-line
 * answer the apply guard accepts (`approve thread-post:<id>`).
 */
export function buildAmendmentReviewBrief(input: AmendmentReviewBriefInput): string {
  const bars = input.preview.changes
    .map((change) => `${change.barKey} (${[...change.kinds].join('+')}${change.fields?.length ? `: ${change.fields.join(', ')}` : ''})`)
    .join('; ');
  return [
    `Outside-lineage review of a started acceptance-BAR amendment to ${input.rubricRef}. The relevance router picked you and screened you with rubrics:check-approver: you are outside the implementer's lineage.`,
    `Changed BARs: ${bars || '(none listed)'}.`,
    input.reason?.trim() ? `Reason given: ${clip(input.reason.trim(), BRIEF_REASON_MAX)}` : 'No reason was given.',
    'Requested patch. Reproduce the preview with rubrics:amend { rubricRef, dryRun:true, ...patch } and read the criteria with rubrics:get before judging:',
    '```json',
    clip(JSON.stringify(input.patch), BRIEF_PATCH_MAX),
    '```',
    `Approval JSON the requester posted as ${input.previewPostRef}:`,
    '```json',
    JSON.stringify(input.preview.approval),
    '```',
    `To approve, answer this consult with exactly one line: approve ${input.previewPostRef}`,
    'That line is the signature: the apply guard takes its author and time from your post. If the change weakens a requirement or you cannot verify it, decline or answer with the objection; any other answer is not an approval.',
  ].join('\n');
}

/**
 * The preview post must carry the approval the CURRENT delta produces. This is
 * the apply guard's own resolver, so a post it would later refuse (unparseable,
 * other rubric, uncovered or stale BAR hashes) refuses the review up front
 * instead of spending a routed reviewer on it.
 */
async function verifyPreviewPostWithApplyResolver(args: {
  workspaceId: string;
  previewPostRef: string;
  approval: AcceptanceBarAmendmentPreview['approval'];
}): Promise<void> {
  const [{ getOrgPg }, { resolveAcceptanceBarApproval }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../acceptance-bar-amendment'),
  ]);
  await resolveAcceptanceBarApproval(getOrgPg().sql as never, {
    workspaceId: args.workspaceId,
    approvalRef: args.previewPostRef,
    expected: args.approval,
  });
}

export interface OpenAmendmentReviewInput extends AmendmentReviewBriefInput {
  preview: Pick<AcceptanceBarAmendmentPreview, 'approval' | 'changes' | 'approvalRequired'>;
  identity: AgentIdentity;
  workspaceId: string;
  harness?: string;
}

export type AmendmentReviewRequestResult =
  | { state: 'not-required'; next: string }
  | (AmendmentReviewRouteResult & { previewPostRef: string; next: string });

/**
 * rubrics:amend's review opener (P-006). A preview that needs no approval
 * routes nothing; otherwise the preview post is checked, then the routed,
 * lineage-screened review is opened for it.
 */
export async function openAcceptanceBarAmendmentReview(
  input: OpenAmendmentReviewInput,
  deps: {
    verifyPreviewPost?: typeof verifyPreviewPostWithApplyResolver;
    route?: typeof routeAcceptanceBarAmendmentReview;
  } = {},
): Promise<AmendmentReviewRequestResult> {
  if (!input.preview.approvalRequired) {
    return { state: 'not-required', next: 'No BAR meaning changes: apply without approvalRef.' };
  }
  const previewPostRef = input.previewPostRef.trim();
  if (!PREVIEW_POST_REF.test(previewPostRef)) {
    throw new Error(`invalid_args: reviewPreviewPost must be thread-post:<id>, got '${input.previewPostRef}'`);
  }
  try {
    await (deps.verifyPreviewPost ?? verifyPreviewPostWithApplyResolver)({
      workspaceId: input.workspaceId,
      previewPostRef,
      approval: input.preview.approval,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `acceptance_bar_amendment_review_preview_invalid: ${previewPostRef} does not carry this preview's approval (${message}). ` +
        'Post the current preview.approval JSON once with work_items:comment and pass that post.',
    );
  }
  const routed = await (deps.route ?? routeAcceptanceBarAmendmentReview)({
    rubricRef: input.rubricRef,
    brief: buildAmendmentReviewBrief({ ...input, previewPostRef }),
    identity: input.identity,
    workspaceId: input.workspaceId,
    ...(input.harness ? { harness: input.harness } : {}),
  });
  const next =
    routed.state === 'routed'
      ? `events:await { event:'consult:reply:${routed.conversationId}' }. When the routed reviewer answers \`approve ${previewPostRef}\`, ` +
        `apply with the same patch plus approvalRef:'thread-post:<that answer post id>' (conversations:get { id:'${routed.conversationId}' } lists post ids).`
      : 'No eligible outside-lineage reviewer could be routed; the reason and screenedOut say why. Re-request later, or change the amendment so it is additive-only.';
  return { ...routed, previewPostRef, next };
}
