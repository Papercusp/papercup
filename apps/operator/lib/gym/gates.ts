/**
 * Accept gates (P-009) — the pure predicates the loop's accept/reject engine
 * (P-018) combines. A candidate is accepted iff ALL gates hold:
 *
 *   improvement · dev-anchor-no-regress · no-new-regressions · probe-caught · cost
 *
 * The judge composite is the reward; deterministic `regressions` + `planted_bug_caught`
 * are un-gameable guardrails. Pass-count is deliberately NOT a gate — the validator
 * is mutable and pass-count is gameable, so it stays observability only (D-011).
 *
 * Thresholds (ε, δ, cost ceiling) are NOT guessed: ε/δ are derived from measured
 * judge variance at P-014; they are passed in here.
 */

export interface GateInputs {
  /** Candidate's aggregate judge composite on the train pool (the reward). */
  candidateJudgeAgg: number;
  /** Parent's aggregate judge composite on the train pool. */
  parentJudgeAgg: number;
  /** Minimum train improvement margin (variance-derived, P-014). */
  epsilon: number;
  /** Candidate's aggregate on the FROZEN dev-anchor (apples-to-apples). */
  candidateDevAnchorAgg: number;
  /** Champion's aggregate on the frozen dev-anchor. */
  championDevAnchorAgg: number;
  /** Allowed dev-anchor regression slack (variance-derived, P-014). */
  delta: number;
  /** Did any candidate run break the repo's pre-existing tests? */
  anyNewRegression: boolean;
  /** Were all planted bugs (probe runs) caught? */
  allProbesCaught: boolean;
  /** Candidate's mean cost per run. */
  candidateMeanCost: number;
  /** Baseline's mean cost per run. */
  baselineMeanCost: number;
  /** Cost guardrail multiplier (mean ≤ baseline × ceiling). */
  costCeiling: number;
}

export interface GateResult {
  gate: string;
  pass: boolean;
  detail: string;
}

export interface GatesVerdict {
  accept: boolean;
  results: GateResult[];
}

export function evaluateGates(g: GateInputs): GatesVerdict {
  const results: GateResult[] = [
    {
      gate: 'improvement',
      pass: g.candidateJudgeAgg >= g.parentJudgeAgg + g.epsilon,
      detail: `train ${g.candidateJudgeAgg.toFixed(3)} vs parent ${g.parentJudgeAgg.toFixed(3)} + ε ${g.epsilon}`,
    },
    {
      gate: 'dev-anchor-no-regress',
      pass: g.candidateDevAnchorAgg >= g.championDevAnchorAgg - g.delta,
      detail: `dev-anchor ${g.candidateDevAnchorAgg.toFixed(3)} vs champion ${g.championDevAnchorAgg.toFixed(3)} − δ ${g.delta}`,
    },
    {
      gate: 'no-new-regressions',
      pass: !g.anyNewRegression,
      detail: g.anyNewRegression ? 'a candidate run broke pre-existing tests' : 'no new regressions',
    },
    {
      gate: 'probe-caught',
      pass: g.allProbesCaught,
      detail: g.allProbesCaught ? 'all planted bugs caught' : 'a planted bug was missed',
    },
    {
      gate: 'cost',
      pass: g.candidateMeanCost <= g.baselineMeanCost * g.costCeiling,
      detail: `mean ${g.candidateMeanCost.toFixed(3)} vs baseline ${g.baselineMeanCost.toFixed(3)} × ${g.costCeiling}`,
    },
  ];
  return { accept: results.every((r) => r.pass), results };
}
