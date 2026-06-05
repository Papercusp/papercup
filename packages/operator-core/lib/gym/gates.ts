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
 *
 * The gate POLICY is a declarative `@papercusp/rules` table
 * (adopt-event-rules-engines D-003): each gate is a `DataCondition` over a
 * normalized `GateFacts`. The engine's operators test a value against a constant,
 * and these thresholds are *relative* (parent+ε, champion−δ, baseline×ceiling), so
 * the consumer folds each relative threshold into a pre-computed **margin**
 * (actual − threshold) the rule tests with `{ gte: 0 }`; boolean gates test the
 * flag directly. The pass/fail structure is now inspectable data; only the
 * human-readable `detail` stays imperative.
 */

import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';

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

/** Normalized facts the declarative gate conditions test (relative thresholds folded into margins). */
interface GateFacts {
  /** candidateJudgeAgg − (parentJudgeAgg + ε); ≥ 0 ⇔ the improvement gate holds. */
  improvementMargin: number;
  /** candidateDevAnchorAgg − (championDevAnchorAgg − δ); ≥ 0 ⇔ no dev-anchor regression. */
  devAnchorMargin: number;
  anyNewRegression: boolean;
  allProbesCaught: boolean;
  /** baselineMeanCost × ceiling − candidateMeanCost; ≥ 0 ⇔ within the cost ceiling. */
  costMargin: number;
}

/** The accept-gate policy: each gate's `cond` is a serializable `DataCondition`; `detail` is the human trail. */
const GATE_RULES: { gate: string; cond: DataCondition; detail: (g: GateInputs) => string }[] = [
  {
    gate: 'improvement',
    cond: { improvementMargin: { gte: 0 } },
    detail: (g) => `train ${g.candidateJudgeAgg.toFixed(3)} vs parent ${g.parentJudgeAgg.toFixed(3)} + ε ${g.epsilon}`,
  },
  {
    gate: 'dev-anchor-no-regress',
    cond: { devAnchorMargin: { gte: 0 } },
    detail: (g) => `dev-anchor ${g.candidateDevAnchorAgg.toFixed(3)} vs champion ${g.championDevAnchorAgg.toFixed(3)} − δ ${g.delta}`,
  },
  {
    gate: 'no-new-regressions',
    cond: { anyNewRegression: { equals: false } },
    detail: (g) => (g.anyNewRegression ? 'a candidate run broke pre-existing tests' : 'no new regressions'),
  },
  {
    gate: 'probe-caught',
    cond: { allProbesCaught: { equals: true } },
    detail: (g) => (g.allProbesCaught ? 'all planted bugs caught' : 'a planted bug was missed'),
  },
  {
    gate: 'cost',
    cond: { costMargin: { gte: 0 } },
    detail: (g) => `mean ${g.candidateMeanCost.toFixed(3)} vs baseline ${g.baselineMeanCost.toFixed(3)} × ${g.costCeiling}`,
  },
];

function gateFacts(g: GateInputs): GateFacts {
  return {
    improvementMargin: g.candidateJudgeAgg - (g.parentJudgeAgg + g.epsilon),
    devAnchorMargin: g.candidateDevAnchorAgg - (g.championDevAnchorAgg - g.delta),
    anyNewRegression: g.anyNewRegression,
    allProbesCaught: g.allProbesCaught,
    costMargin: g.baselineMeanCost * g.costCeiling - g.candidateMeanCost,
  };
}

export function evaluateGates(g: GateInputs): GatesVerdict {
  const facts = gateFacts(g);
  const results: GateResult[] = GATE_RULES.map((r) => ({
    gate: r.gate,
    pass: evaluateDataCondition(r.cond, facts),
    detail: r.detail(g),
  }));
  return { accept: results.every((r) => r.pass), results };
}
