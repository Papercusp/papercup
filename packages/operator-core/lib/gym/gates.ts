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
 * (actual − threshold) the rule tests with `{ gte: 0 }`; the deterministic gates
 * test their evidence's STATUS directly. The pass/fail structure is now
 * inspectable data; only the human-readable `detail` stays imperative.
 *
 * P-003 — the deterministic guardrails are THREE-STATE, not boolean. A boolean
 * cannot distinguish "the run reported no regressions" from "the run never
 * reported the signal at all", so an un-collected guardrail read as a PASS and
 * a candidate could be promoted on evidence nobody gathered. Every deterministic
 * gate therefore consumes a `DeterministicEvidence` carrying its own status plus
 * the task coverage and trace artifacts that back it, and missing required
 * evidence resolves to `not-measured` → an INCONCLUSIVE verdict (never accept,
 * and never a reject either — nothing was measured, so nothing was disproved).
 */

import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';

/**
 * A deterministic gate's outcome. `not-measured` is a first-class result, NOT a
 * flavour of failure: it means the evidence required to judge this gate was never
 * collected, so neither accept nor reject is warranted.
 */
export type GateStatus = 'pass' | 'fail' | 'not-measured';

/**
 * One deterministic guardrail's evidence, with the provenance needed to audit it.
 *
 * `coverage` is what makes `not-measured` checkable rather than asserted: a signal
 * is only measured when every task that owes it actually reported it, and the tasks
 * that did not are named so a reader can go look. `artifacts` are the trace refs of
 * the runs that produced the evidence — the audit trail from verdict back to run.
 */
export interface DeterministicEvidence {
  status: GateStatus;
  /** Which tasks owed this signal, and how many actually reported it. */
  coverage: {
    /** Tasks that reported the signal on every repeat. */
    measured: number;
    /** Tasks that owed the signal. `0` required ⇒ nothing was measured, never a vacuous pass. */
    required: number;
    /** Tasks that owed the signal and did not report it on at least one repeat. */
    unmeasuredTaskIds: readonly string[];
  };
  /** Trace refs for the runs backing this evidence. */
  artifacts: readonly string[];
}

/**
 * Roll per-task statuses into one signal-level status.
 *
 * Precedence is deliberate: an observed FAIL outranks a gap, because a proven
 * regression is decisive evidence and must not be softened to "inconclusive" just
 * because a sibling task went unreported. Absent any fail, ANY gap (including the
 * zero-task case) is `not-measured` — the vacuous-pass hole P-003 closes.
 */
export function rollUpEvidenceStatus(perTask: readonly GateStatus[]): GateStatus {
  if (perTask.some((s) => s === 'fail')) return 'fail';
  if (perTask.length === 0 || perTask.some((s) => s === 'not-measured')) return 'not-measured';
  return 'pass';
}

/** Evidence for a signal nothing reported — the honest default when collection did not happen. */
export function unmeasuredEvidence(unmeasuredTaskIds: readonly string[] = []): DeterministicEvidence {
  return {
    status: 'not-measured',
    coverage: { measured: 0, required: unmeasuredTaskIds.length, unmeasuredTaskIds },
    artifacts: [],
  };
}

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
  /** Did any candidate run break the repo's pre-existing tests? Three-state (P-003). */
  regressionEvidence: DeterministicEvidence;
  /** Were all planted bugs (probe runs) caught? Three-state (P-003). */
  probeEvidence: DeterministicEvidence;
  /** Candidate's mean cost per run. */
  candidateMeanCost: number;
  /** Baseline's mean cost per run. */
  baselineMeanCost: number;
  /** Cost guardrail multiplier (mean ≤ baseline × ceiling). */
  costCeiling: number;
}

export interface GateResult {
  gate: string;
  /**
   * DERIVED — `status === 'pass'`, never assigned independently. Kept because every
   * consumer that only asks "did this gate hold?" stays correct through the
   * three-state change: a `not-measured` gate is not a pass, so an accept path
   * reading this field alone remains fail-closed.
   */
  pass: boolean;
  /** The three-state outcome. Read THIS to tell a gap apart from a failure. */
  status: GateStatus;
  detail: string;
  /** Coverage + artifacts, present on gates backed by deterministic evidence. */
  evidence?: DeterministicEvidence;
}

export interface GatesVerdict {
  /** DERIVED — `outcome === 'accept'`. An inconclusive verdict is not an accept. */
  accept: boolean;
  /**
   * Three-state: `inconclusive` when any gate is `not-measured`, so a candidate is
   * never promoted on evidence nobody collected — and never recorded as REJECTED
   * on it either, which would libel a candidate that was simply not measured.
   */
  outcome: 'accept' | 'reject' | 'inconclusive';
  results: GateResult[];
}

/** Normalized facts the declarative gate conditions test (relative thresholds folded into margins). */
interface GateFacts {
  /** candidateJudgeAgg − (parentJudgeAgg + ε); ≥ 0 ⇔ the improvement gate holds. */
  improvementMargin: number;
  /** candidateDevAnchorAgg − (championDevAnchorAgg − δ); ≥ 0 ⇔ no dev-anchor regression. */
  devAnchorMargin: number;
  regressionStatus: GateStatus;
  probeStatus: GateStatus;
  /** baselineMeanCost × ceiling − candidateMeanCost; ≥ 0 ⇔ within the cost ceiling. */
  costMargin: number;
}

/** How a task-coverage summary reads in a gate's human-readable detail. */
function coverageDetail(e: DeterministicEvidence): string {
  const unmeasured = e.coverage.unmeasuredTaskIds.length
    ? `; unmeasured: ${e.coverage.unmeasuredTaskIds.join(', ')}`
    : '';
  return `${e.coverage.measured}/${e.coverage.required} tasks measured, ${e.artifacts.length} artifact(s)${unmeasured}`;
}

/**
 * The accept-gate policy: each gate's `cond` is a serializable `DataCondition`; `detail`
 * is the human trail. `evidence` marks the deterministic gates — those carry a three-state
 * status straight from their evidence rather than collapsing to the condition's boolean,
 * which is what lets `not-measured` survive all the way to the verdict.
 */
const GATE_RULES: {
  gate: string;
  cond: DataCondition;
  detail: (g: GateInputs) => string;
  evidence?: (g: GateInputs) => DeterministicEvidence;
}[] = [
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
    cond: { regressionStatus: { equals: 'pass' } },
    evidence: (g) => g.regressionEvidence,
    detail: (g) => {
      const head =
        g.regressionEvidence.status === 'fail'
          ? 'a candidate run broke pre-existing tests'
          : g.regressionEvidence.status === 'pass'
            ? 'no new regressions'
            : 'regression signal NOT MEASURED — no candidate run reported it';
      return `${head} (${coverageDetail(g.regressionEvidence)})`;
    },
  },
  {
    gate: 'probe-caught',
    cond: { probeStatus: { equals: 'pass' } },
    evidence: (g) => g.probeEvidence,
    detail: (g) => {
      const head =
        g.probeEvidence.status === 'fail'
          ? 'a planted bug was missed'
          : g.probeEvidence.status === 'pass'
            ? 'all planted bugs caught'
            : g.probeEvidence.coverage.required === 0
              ? 'probe signal NOT MEASURED — the candidate ran against no probe tasks'
              : 'probe signal NOT MEASURED — a probe run did not report planted_bug_caught';
      return `${head} (${coverageDetail(g.probeEvidence)})`;
    },
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
