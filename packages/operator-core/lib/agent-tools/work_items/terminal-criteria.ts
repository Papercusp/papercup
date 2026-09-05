/**
 * Item-scoped terminal criteria — the `requireDurableChange` half of the completion floor.
 *
 * Plan: `machine-enforced-terminal-criteria-2026-09-05` (source item EI-20191442676357637).
 * Read D-011 before extending this file. The short version of why this module is SMALL:
 *
 * - The rootCause half of the floor is ALREADY LIVE and stronger than this plan first
 *   specified. `complete.ts` requires `completion.rootCauseVerification` for successful
 *   bug/capability-gap closes and REJECTS without it, behind a strict contrastive schema
 *   (`RootCauseVerificationSchema`, coord-lifecycle/records.ts). Do not reimplement it
 *   here — a softer duplicate would be a loosening shipped as a tightening (D-002, D-011).
 * - `requiredProofFloor(clause, classRef)` in ../plans/spec-test-adequacy is CLAUSE-scoped
 *   and cannot be invoked for a close with no spec clause, which is the overwhelming
 *   majority. This module therefore COMPOSES with that evaluator rather than widening its
 *   signature, and deliberately reuses its `AdequacyRatingEntry` / `wouldBlock` / verdict
 *   vocabulary so there is exactly one evidence dialect (D-001, D-009).
 *
 * What remains, and what this module is: the one conjunct with teeth. D-006 measured the
 * four stored closes of EI-20185455308799001 and found that the discriminating case is a
 * close which NAMES a genuine mechanism and changes nothing — attributing remediation to
 * commits that already landed. A contrastive causal record does not catch that, because it
 * can be entirely truthful about a cause the closer did not fix. Narrating a cause is a
 * report, not a fix.
 */
import type { AdequacyRatingEntry } from '../plans/spec-test-adequacy';

export const TERMINAL_CRITERION_KEYS = ['durable-change'] as const;
export type TerminalCriterionKey = (typeof TERMINAL_CRITERION_KEYS)[number];

/**
 * Kinds whose SUCCESSFUL close implies a durable change should have landed.
 *
 * Deliberately conservative. Measured 2026-09-05 over successful closes since 2026-08-17
 * (n=29,019): task 49.67%, bug 40.49%, change 6.11%, feature 3.68%. `task` is the single
 * largest population and a great many task closes are legitimately zero-code (an audit, a
 * triage sweep, a research answer), so admitting it here by assumption would manufacture
 * failures rather than catch them. Widening this set is a separate decision that owes its
 * own measurement — it is a parameter, not a hardcode, for exactly that reason.
 */
export const DEFAULT_REMEDIATING_KINDS: readonly string[] = ['bug', 'change'];

/**
 * Dispositions that explicitly disclaim remediation. A close carrying one of these is
 * rated `not-applicable`, never `fail`: a wontfix legitimately changes no files, and a
 * floor that refused them would recreate the unsatisfiability class this plan exists to
 * avoid (D-008, D-010, and the live advisory defect EI-22410970761779199).
 */
export const NON_REMEDIATING_TERMINAL_REASONS: readonly string[] = [
  'wontfix',
  'will-not-fix',
  'duplicate',
  'superseded',
  'obsolete',
  'not-reproducible',
  'no-repro',
  'by-design',
  'works-as-intended',
  'invalid',
];

const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['done', 'resolved', 'passed']);

/** Case/underscore-folded comparison key. Mirrors the folding `complete.ts` uses for its own markers. */
function normalizeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replaceAll('_', '-') : '';
}

/**
 * Comparison key for a DISPOSITION label, folding away every separator.
 *
 * Deliberately stricter than {@link normalizeToken}. D-007 measured that `verifiedHow` is
 * not a closed enum in practice — real closes carry `unit+integration`, `unit and
 * integration`, and whole paragraphs — so an exact-match set silently no-ops on honest
 * callers, not just evasive ones. `terminal_reason` is free text for the same reason, and
 * this module's own test caught the same bug here: `WONT_FIX` folds to `wont-fix`, which a
 * hyphen-preserving set does not contain. Stripping all non-alphanumerics collapses
 * `wontfix`, `wont-fix`, `WONT_FIX` and `won't fix` onto one key.
 */
function dispositionKey(value: unknown): string {
  return normalizeToken(value).replace(/[^a-z0-9]/g, '');
}

const NON_REMEDIATING_DISPOSITION_KEYS: ReadonlySet<string> = new Set(
  NON_REMEDIATING_TERMINAL_REASONS.map(dispositionKey),
);

/** One server-observed path identity from `treeStamp.contentIdentity`. */
export interface TerminalCriteriaContentIdentity {
  path: string;
  workingTreeBlobSha?: string | null;
  headBlobSha?: string | null;
  /** Server-stamped marker for a caller-declared intentional deletion. */
  deletion?: true;
  /** Why the HEAD side could not be READ. Present ONLY for the unresolvable case. */
  headBlobUnresolvable?: string;
  /** Path owned by no checkout (an evidence artifact, not a code change). */
  outOfRepoArtifact?: true;
}

export interface TerminalCriteriaTreeStamp {
  contentIdentity?: readonly TerminalCriteriaContentIdentity[];
}

export interface TerminalCriteriaInput {
  /** The mapped work-item kind (`item_kind`), as `getWorkItem` returns it. */
  itemKind?: string | null;
  /** The terminal status this close is requesting. */
  status: string;
  /** The recorded disposition, when the close declares one. */
  terminalReason?: string | null;
  filesChanged?: readonly string[] | null;
  filesDeleted?: readonly string[] | null;
  /**
   * Server-observed tree stamp. ABSENCE MEANS "NOT OBSERVED" — never "clean", and never
   * "no change landed". The schema is explicit about this and so is this module.
   */
  treeStamp?: TerminalCriteriaTreeStamp | null;
  /** Override for {@link DEFAULT_REMEDIATING_KINDS}; an item-level tightening may widen it. */
  remediatingKinds?: readonly string[];
}

export interface TerminalCriteriaResult {
  /** Whether the floor applies to this close at all. */
  claimsRemediation: boolean;
  ratings: Record<TerminalCriterionKey, AdequacyRatingEntry>;
  /** Criteria rated `fail` or `unknown`, matching spec-test-adequacy's own contract. */
  wouldBlock: TerminalCriterionKey[];
  verdict: 'pass' | 'fail' | 'unknown';
}

/**
 * Does this close CLAIM to have remediated something?
 *
 * Derived from the close's disposition, never from its evidence. Deriving it from the
 * evidence would be circular in exactly the case that matters: the discriminating close in
 * D-006 declared no files, so "declares files ⇒ claims remediation" would have excused it
 * from the only check capable of catching it.
 */
export function claimsRemediation(input: TerminalCriteriaInput): boolean {
  if (!SUCCESS_STATUSES.has(normalizeToken(input.status))) return false;
  const reason = dispositionKey(input.terminalReason);
  if (reason && NON_REMEDIATING_DISPOSITION_KEYS.has(reason)) return false;
  const kinds = input.remediatingKinds ?? DEFAULT_REMEDIATING_KINDS;
  return kinds.map(normalizeToken).includes(normalizeToken(input.itemKind));
}

/** A path identity that proves a durable change actually landed for that path. */
function identityProvesDurableChange(entry: TerminalCriteriaContentIdentity): boolean {
  if (entry.outOfRepoArtifact === true) return false;
  // A deletion is proven only when BOTH sides are null AND the server stamped the marker;
  // absence alone is never read as intent.
  if (entry.deletion === true) return !entry.workingTreeBlobSha && !entry.headBlobSha;
  return Boolean(entry.workingTreeBlobSha) || Boolean(entry.headBlobSha);
}

/**
 * A path whose HEAD side could not be READ. This is a measurement failure, not a closer
 * failure, and the two demand opposite remedies — so it yields `unknown`, never `fail`.
 * Blaming the closer for a resolution bug is the specific defect `headBlobUnresolvable`
 * was added to prevent.
 */
function identityIsUnresolvable(entry: TerminalCriteriaContentIdentity): boolean {
  return Boolean(entry.headBlobUnresolvable) && !entry.workingTreeBlobSha;
}

function durableChangeRating(input: TerminalCriteriaInput, applies: boolean): AdequacyRatingEntry {
  if (!applies) {
    return {
      rating: 'not-applicable',
      evidence:
        `Close does not claim remediation (status=${normalizeToken(input.status) || '<none>'}, ` +
        `kind=${normalizeToken(input.itemKind) || '<none>'}` +
        `${normalizeToken(input.terminalReason) ? `, reason=${normalizeToken(input.terminalReason)}` : ''}). ` +
        'A close that asserts no fix is not required to have landed one.',
    };
  }

  const declaredPaths = (input.filesChanged?.length ?? 0) + (input.filesDeleted?.length ?? 0);
  if (declaredPaths === 0) {
    return {
      rating: 'fail',
      evidence:
        'Close claims remediation but declares no changed or deleted path. Naming a cause is a ' +
        'report, not a fix — a remediating close must point at something that landed.',
      suggestion:
        'Declare the paths this close actually changed in completion.filesChanged (bare ' +
        'repo-relative paths), or close with a non-remediating disposition if nothing landed.',
    };
  }

  const identities = input.treeStamp?.contentIdentity ?? [];
  if (identities.length === 0) {
    return {
      rating: 'unknown',
      evidence:
        `${declaredPaths} path(s) declared, but no server tree stamp was observed. Absence of a ` +
        'stamp means NOT OBSERVED — it is not evidence that the change did or did not land.',
      suggestion: 'Re-run the close where a repository root is resolvable so content identity can be observed.',
    };
  }

  const landed = identities.filter(identityProvesDurableChange);
  if (landed.length > 0) {
    return {
      rating: 'pass',
      evidence:
        `${landed.length} of ${identities.length} declared path(s) resolved to a real Git blob identity ` +
        `(e.g. ${landed[0]?.path}). A durable change landed.`,
    };
  }

  const unresolvable = identities.filter(identityIsUnresolvable);
  if (unresolvable.length > 0) {
    return {
      rating: 'unknown',
      evidence:
        `No declared path resolved, but ${unresolvable.length} could not be READ ` +
        `(e.g. ${unresolvable[0]?.path}: ${unresolvable[0]?.headBlobUnresolvable}). ` +
        'That is a resolution failure, not an absent change.',
      suggestion: 'Resolve the checkout/ref that could not be read, then re-evaluate; do not re-declare the paths.',
    };
  }

  return {
    rating: 'fail',
    evidence:
      `None of ${identities.length} declared path(s) resolved to a Git blob identity, and none was ` +
      'reported unresolvable — the declared content is genuinely absent from the tree.',
    suggestion:
      'Check the declared paths are bare repo-relative paths in the right repository; a repo-qualified ' +
      'prefix fails content identity and is the most common cause.',
  };
}

/**
 * Evaluate the item-scoped terminal criteria for one close.
 *
 * Pure and side-effect free by design: it is the FILTER, and D-003 requires that an unmet
 * criterion downgrade a close to `proposed` while still RECORDING it. This function
 * therefore returns a verdict and never throws or refuses on its own.
 */
export function evaluateTerminalCriteria(input: TerminalCriteriaInput): TerminalCriteriaResult {
  const applies = claimsRemediation(input);
  const ratings: Record<TerminalCriterionKey, AdequacyRatingEntry> = {
    'durable-change': durableChangeRating(input, applies),
  };
  const wouldBlock = TERMINAL_CRITERION_KEYS.filter((key) =>
    ['fail', 'unknown'].includes(ratings[key].rating),
  );
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length > 0
      ? 'unknown'
      : 'pass';
  return { claimsRemediation: applies, ratings, wouldBlock: [...wouldBlock], verdict };
}
