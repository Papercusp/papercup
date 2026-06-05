/**
 * Accept/reject gate engine (P-018) — turns a candidate's full eval results + the
 * parent/champion baselines into the gate decision (via the pure predicates in
 * gates.ts), and selects the next parent from the frontier.
 *
 * The frontier prune + champion update live in the loop driver (P-022) using
 * frontier.ts; this module is the per-candidate decision + parent pick.
 */
import { evaluateGates, type GatesVerdict } from './gates';

export interface VariantEval {
  variantId: string;
  /** Mean judge composite on the train pool (the reward). */
  trainAgg: number;
  /** Per-task-category train composites (for the Pareto frontier). */
  trainVector: number[];
  /** Aggregate on the frozen dev-anchor. */
  devAnchorAgg: number;
  /** Mean cost per run. */
  meanCost: number;
  /** Did any run break the repo's pre-existing tests? */
  anyNewRegression: boolean;
  /** Were all planted bugs caught? */
  allProbesCaught: boolean;
}

export interface AcceptThresholds {
  /** Train improvement margin (variance-derived, P-014). */
  epsilon: number;
  /** Dev-anchor regression slack (variance-derived, P-014). */
  delta: number;
  /** Cost guardrail multiplier. */
  costCeiling: number;
}

export function decideAccept(
  candidate: VariantEval,
  parent: VariantEval,
  champion: VariantEval,
  baselineMeanCost: number,
  t: AcceptThresholds,
): GatesVerdict {
  return evaluateGates({
    candidateJudgeAgg: candidate.trainAgg,
    parentJudgeAgg: parent.trainAgg,
    epsilon: t.epsilon,
    candidateDevAnchorAgg: candidate.devAnchorAgg,
    championDevAnchorAgg: champion.devAnchorAgg,
    delta: t.delta,
    anyNewRegression: candidate.anyNewRegression,
    allProbesCaught: candidate.allProbesCaught,
    candidateMeanCost: candidate.meanCost,
    baselineMeanCost,
    costCeiling: t.costCeiling,
  });
}

/**
 * Select the next parent from the frontier, biased toward the under-served member —
 * v1 proxy: the lowest train aggregate (most headroom). Deterministic (tie-break id).
 */
export function selectParent<T extends { variantId: string; trainAgg: number }>(frontier: readonly T[]): T | null {
  let best: T | null = null;
  for (const v of frontier) {
    if (best === null || v.trainAgg < best.trainAgg || (v.trainAgg === best.trainAgg && v.variantId < best.variantId)) {
      best = v;
    }
  }
  return best;
}
