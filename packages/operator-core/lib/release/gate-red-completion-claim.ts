/**
 * P-006 (frozen-candidate-compliance-enforcement-2026-08-30): a completion claim of the form
 * "fixed N gate reds" must not be assertable when the fixes are not in the sha being judged.
 *
 * THE CLAIM THIS CATCHES. While the gate is frozen, a fix committed to staging lands ABOVE
 * the candidate under judgment. The agent's work is real, their tests pass, and the gate
 * still cannot see any of it — so "I fixed the gate reds" is locally true and globally
 * false. Measured 2026-08-30: 3 of 10 reds on candidate 4184805d were already fixed at tip
 * and re-reported as outstanding. Nothing in the completion path noticed, because every
 * evidence field was individually valid.
 *
 * WHY IT BELONGS AT COMPLETION TIME. The P-004 hook fires at the EDIT, which is the cheapest
 * moment — but an agent who dismisses it, or who never edited (a peer's fix, a rebase), still
 * reaches the completion call. This is the second, independent net, and it is the one that
 * stops the false claim entering the record where a successor inherits it as fact.
 *
 * SHAPE. Deliberately a sibling of `unresolvedPathsInCompletion`: pure via an injected probe,
 * WARN-ONLY, and fail-open at every step (EI-24 record-and-warn discipline). Editing a
 * failing path is often exactly right; asserting the gate can see it is the error. Silence
 * whenever it cannot judge — no marker, no declared paths, no containment probe.
 */
import { containmentForPaths, integrationBranch, type PathContainment } from './judged-sha-containment';
import { integrationRoot } from '../release-deploy-launch';
import {
  normalizeRepoPath,
} from './frozen-candidate-repair-queue';
import { readFrozenRepairMarker, type FrozenRepairEditMarker } from './frozen-repair-edit-marker';

/**
 * Phrasings that assert gate progress. Kept narrow on purpose: a false positive here
 * nags a correct close, and a nagging check is one agents learn to ignore.
 */
const GATE_RED_CLAIM_RE =
  /\b(gate[- ]red|gate[- ]reds|red gate|green(?:ed|ing)? the gate|gate (?:is )?green|checkpoint red|green[- ]checkpoint red|fixed \d+ (?:of \d+ )?(?:gate|checkpoint) )/i;

export interface GateRedClaimEvidence {
  filesChanged?: string[];
  summary?: string;
  testsRun?: string;
  testResult?: string;
  verifiedHow?: string;
}

export interface GateRedClaimProbe {
  /** Injected for tests; omitted means "read the real marker". */
  marker?: FrozenRepairEditMarker | null;
  containment?: (paths: string[], judgedSha: string) => PathContainment[];
}

/** Does this completion assert gate progress at all? */
export function looksLikeGateRedFixClaim(evidence: GateRedClaimEvidence | undefined): boolean {
  if (!evidence) return false;
  const haystack = [
    evidence.summary,
    evidence.testsRun,
    evidence.testResult,
    evidence.verifiedHow,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  return GATE_RED_CLAIM_RE.test(haystack);
}

export interface GateRedClaimWarning {
  judgedSha: string;
  candidate: string;
  /** Declared paths that are in the failing set but NOT carried by the judged sha. */
  uncontainedPaths: string[];
  /** Declared paths that are in the failing set and ARE carried by the judged sha. */
  containedPaths: string[];
  detail: string;
}

/**
 * The warning, or `undefined` when there is nothing to say.
 *
 * Note the deliberate narrowing: only declared paths that are ALSO in the frozen candidate's
 * failing set are judged. A gate-red close that touched unrelated files is not this bug, and
 * flagging it would be the false positive that gets the whole check ignored.
 */
export function gateRedCompletionClaimWarning(
  evidence: GateRedClaimEvidence | undefined,
  probe: GateRedClaimProbe = {},
): GateRedClaimWarning | undefined {
  try {
    if (!looksLikeGateRedFixClaim(evidence)) return undefined;
    const declared = evidence?.filesChanged?.filter((f) => typeof f === 'string' && f.trim());
    if (!declared?.length) return undefined;

    const marker = 'marker' in probe ? probe.marker : readFrozenRepairMarker();
    // No frozen queue ⇒ the candidate is cut at tip ⇒ an ordinary commit IS the judged
    // lineage, so the claim is unremarkable. Silence, not a guess.
    if (!marker) return undefined;

    const failing = new Set(marker.failingPaths.map(normalizeRepoPath));
    const relevant = [
      ...new Set(declared.map(normalizeRepoPath).filter((p) => p.length > 0 && failing.has(p))),
    ].sort();
    if (!relevant.length) return undefined;

    const check =
      probe.containment ??
      ((paths: string[], judgedSha: string) =>
        containmentForPaths(paths, judgedSha, integrationRoot(), undefined, integrationBranch()));
    const rows = check(relevant, marker.repairHead);
    const uncontainedPaths = rows.filter((r) => !r.containedInJudgedSha).map((r) => r.path).sort();
    const containedPaths = rows.filter((r) => r.containedInJudgedSha).map((r) => r.path).sort();
    if (!uncontainedPaths.length) return undefined;

    return {
      judgedSha: marker.repairHead,
      candidate: marker.candidate,
      uncontainedPaths,
      containedPaths,
      detail:
        `⚠ GATE-PROGRESS CLAIM THE GATE CANNOT SEE: this completion asserts gate-red progress, but ` +
        `${uncontainedPaths.length} of the frozen candidate's failing path(s) you named are NOT carried ` +
        `by the sha under judgment (${marker.repairHead.slice(0, 12)}, frozen candidate ` +
        `${marker.candidate.slice(0, 12)}): ${uncontainedPaths.join(', ')}. ` +
        `The fix is real but it landed ABOVE the judged sha, so the gate will keep reporting these red. ` +
        `Put it on the judged lineage with release:repair-queue { op:'admit', paths:[...] }, then ` +
        `re-state the claim with the containment verdict as its evidence.`,
    };
  } catch {
    return undefined; // fail open — a detector fault must never block a close
  }
}
