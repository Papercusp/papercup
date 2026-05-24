/**
 * pr-host/index — PrHost abstraction barrel + factory helpers.
 *
 * Phase 7 P-040: `PrHost` interface (types.ts) + GitHub impl (github.ts).
 *
 * Usage:
 *   const host = createGitHubPrHost();          // uses getOctokit()
 *   const host = createGitHubPrHost(myOctokit); // inject in tests
 */

export type {
  Pr,
  PrRef,
  PrState,
  PrMergeMethod,
  PrReviewDecision,
  PrReviewEvent,
  PrHostKind,
  PrHostResult,
  PrHostError,
  PrHostErrorKind,
  OpenPrArgs,
  PostReviewArgs,
  MergePrArgs,
  ListOpenPrsArgs,
  PrHost,
} from './types';

export {
  ok,
  err,
  isRetryableError,
  isAuthError,
  isGoneError,
  composePrKey,
  parsePrKey,
  statusToErrorKind,
  PR_STATES,
  PR_HOST_ERROR_KINDS,
  PR_HOST_KINDS,
  PR_REVIEW_EVENTS,
} from './types';

export { GitHubPrHost, createGitHubPrHost } from './github';
