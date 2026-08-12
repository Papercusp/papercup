import { getWorkItemThreadWindow, isSettledWorkItemState } from '../../work-items';

/**
 * A conservative matcher for thread posts that retract an item's premise.
 *
 * This is deliberately advisory-only. A prose predicate is too form-blind to
 * become a claim exclusion; the terminal state remains the queue's authority.
 */
export const RETRACTION_LIKE_RE =
  /\b(retracting\s+this|i\s+retract\b|retraction\s+by\s+the\s+filer|(?:central|core)\s+premise\s+is\s+(?:wrong|false|invalid)|premise\s+(?:is|was)\s+(?:wrong|false|invalid|disproven)|do\s+not\s+act\s+on\s+(?:it|this)\s+as\s+written|(?:finding|analysis|diagnosis|conclusion|claim)\s+(?:is|was)\s+(?:wrong|false|incorrect|disproven|disproved)|superseding\s+this\s+(?:item|finding))/i;

/** Soft reminder shared by the filer-side and claimant-side advisory paths. */
export const RETRACTION_STATE_HINT =
  'This reads like a retraction, but the item is still non-terminal — a retraction in a comment does ' +
  'NOT retract anything the queue can see, so scheduler:get_next keeps serving this item AT ITS ORIGINAL ' +
  'SEVERITY and the next claimer sees the badge, not your correction. If this retracts the item\'s premise, ' +
  'call work_items:set_state { state:\'dropped\', completionRef:\'retracted: premise disproven\', ' +
  'assumptions:\'none\' } (terminal — removes it from work_items:claimable AND scheduler:get_next). ' +
  'Use completionRef for the caller-facing evidence and assumptions:\'none\' when no recorded fact supports ' +
  'the close.';

export interface ClaimTimeRetractionWorkItem {
  id?: string | null;
  state?: string | null;
  harness?: string | null;
}

export interface ClaimTimeRetractionAdvisory {
  retractionWarning: string;
}

/**
 * Read the bounded recent thread at claim time and return only the advisory
 * field. Every read is fail-open: the claim is already the important action,
 * and a degraded thread read must never turn a successful claim into a failure.
 */
export async function getClaimTimeRetractionAdvisory(
  workItem: ClaimTimeRetractionWorkItem | null | undefined,
  harness?: string | null,
): Promise<ClaimTimeRetractionAdvisory | null> {
  const id = workItem?.id;
  if (!id || isSettledWorkItemState(workItem?.state)) return null;

  try {
    const thread = await getWorkItemThreadWindow(id, 10, harness ?? workItem?.harness ?? undefined);
    if (!thread) return null;
    const hasRetraction = thread.posts.some((post) => RETRACTION_LIKE_RE.test(String(post.body ?? '')));
    return hasRetraction ? { retractionWarning: RETRACTION_STATE_HINT } : null;
  } catch {
    return null;
  }
}

/** String-only convenience for callers that already assemble warning fields. */
export async function getClaimTimeRetractionWarning(
  workItem: ClaimTimeRetractionWorkItem | null | undefined,
  harness?: string | null,
): Promise<string | null> {
  return (await getClaimTimeRetractionAdvisory(workItem, harness))?.retractionWarning ?? null;
}
