import { describe, it, expect } from 'vitest';
import { evaluateGates, rollUpEvidenceStatus, unmeasuredEvidence, type DeterministicEvidence, type GateInputs, type GateStatus } from '../gates';

/** Evidence that a signal WAS collected across `taskIds` and came out `status`. */
const measured = (status: GateStatus, taskIds: string[] = ['t1']): DeterministicEvidence => ({
  status,
  coverage: { measured: taskIds.length, required: taskIds.length, unmeasuredTaskIds: [] },
  artifacts: taskIds.map((t) => `trace://${t}`),
});

/**
 * Accept gates (P-009). A candidate variant is accepted iff ALL gates hold (D-011):
 *   1. improvement — train judge-composite ≥ parent + ε (ε derived from variance, P-014)
 *   2. dev-anchor no-regress — vs the champion on the FROZEN dev-anchor, ≥ champion − δ
 *   3. no new regressions — un-gameable (repo's own tests)
 *   4. probe caught — un-gameable planted-bug guardrail
 *   5. cost — mean cost ≤ baseline × ceiling
 * Pass-count is deliberately NOT a gate (the validator is mutable; D-011).
 */
const pass: GateInputs = {
  candidateJudgeAgg: 7.5,
  parentJudgeAgg: 7.0,
  epsilon: 0.3,
  candidateDevAnchorAgg: 7.2,
  championDevAnchorAgg: 7.3,
  delta: 0.2,
  regressionEvidence: measured('pass'),
  probeEvidence: measured('pass'),
  candidateMeanCost: 1.0,
  baselineMeanCost: 1.0,
  costCeiling: 1.5,
};

describe('evaluateGates', () => {
  it('accepts when every gate holds', () => {
    const v = evaluateGates(pass);
    expect(v.accept).toBe(true);
    expect(v.results.every((r) => r.pass)).toBe(true);
    expect(v.results.map((r) => r.gate).sort()).toEqual(
      ['cost', 'dev-anchor-no-regress', 'improvement', 'no-new-regressions', 'probe-caught'].sort(),
    );
  });

  it('rejects when the train improvement is below parent + epsilon', () => {
    const v = evaluateGates({ ...pass, candidateJudgeAgg: 7.1 }); // < 7.0 + 0.3
    expect(v.accept).toBe(false);
    expect(v.results.find((r) => r.gate === 'improvement')?.pass).toBe(false);
  });

  it('rejects when the candidate regresses the dev-anchor beyond delta', () => {
    const v = evaluateGates({ ...pass, candidateDevAnchorAgg: 7.0 }); // 7.0 < 7.3 - 0.2 = 7.1
    expect(v.accept).toBe(false);
    expect(v.results.find((r) => r.gate === 'dev-anchor-no-regress')?.pass).toBe(false);
  });

  it('rejects on any new regression (un-gameable)', () => {
    const v = evaluateGates({ ...pass, regressionEvidence: measured('fail') });
    expect(v.accept).toBe(false);
    expect(v.outcome).toBe('reject');
    expect(v.results.find((r) => r.gate === 'no-new-regressions')?.pass).toBe(false);
  });

  it('rejects when a planted bug was not caught (un-gameable)', () => {
    const v = evaluateGates({ ...pass, probeEvidence: measured('fail') });
    expect(v.accept).toBe(false);
    expect(v.outcome).toBe('reject');
    expect(v.results.find((r) => r.gate === 'probe-caught')?.pass).toBe(false);
  });

  it('rejects when mean cost exceeds the ceiling', () => {
    const v = evaluateGates({ ...pass, candidateMeanCost: 1.6 }); // > 1.0 * 1.5
    expect(v.accept).toBe(false);
    expect(v.results.find((r) => r.gate === 'cost')?.pass).toBe(false);
  });

  it('does not include a pass-count gate (D-011)', () => {
    expect(evaluateGates(pass).results.find((r) => r.gate.includes('pass-count'))).toBeUndefined();
  });
});

/**
 * P-003 — evidence that was never collected must be INCONCLUSIVE, not a pass.
 *
 * The regression these lock down is not hypothetical: before P-003 both deterministic
 * guardrails were plain booleans, so "no regressions reported" and "no report at all"
 * were the same value, and a probe pool with zero tasks reported an affirmative
 * `allProbesCaught: true`. Either one could promote a candidate on evidence nobody
 * gathered. Deleting the three-state handling makes these fail.
 */
describe('evaluateGates — unmeasured deterministic evidence', () => {
  it('is inconclusive (NOT accept, NOT reject) when the regression signal was never reported', () => {
    const v = evaluateGates({ ...pass, regressionEvidence: unmeasuredEvidence(['t1']) });
    expect(v.outcome).toBe('inconclusive');
    expect(v.accept).toBe(false);
    const gate = v.results.find((r) => r.gate === 'no-new-regressions');
    expect(gate?.status).toBe('not-measured');
    // The derived boolean stays fail-closed for any consumer reading only `pass`.
    expect(gate?.pass).toBe(false);
  });

  it('is inconclusive when the candidate ran against no probe tasks (the vacuous-pass hole)', () => {
    const v = evaluateGates({ ...pass, probeEvidence: unmeasuredEvidence([]) });
    expect(v.outcome).toBe('inconclusive');
    const gate = v.results.find((r) => r.gate === 'probe-caught');
    expect(gate?.status).toBe('not-measured');
    expect(gate?.detail).toContain('ran against no probe tasks');
  });

  it('still REJECTS when one gate failed and another went unmeasured — a measured failure is decisive', () => {
    const v = evaluateGates({
      ...pass,
      regressionEvidence: measured('fail'),
      probeEvidence: unmeasuredEvidence([]),
    });
    expect(v.outcome).toBe('reject');
  });

  it('carries task coverage and artifact references onto the gate result', () => {
    const v = evaluateGates({ ...pass, regressionEvidence: measured('pass', ['t1', 't2']) });
    const gate = v.results.find((r) => r.gate === 'no-new-regressions');
    expect(gate?.evidence?.coverage).toEqual({ measured: 2, required: 2, unmeasuredTaskIds: [] });
    expect(gate?.evidence?.artifacts).toEqual(['trace://t1', 'trace://t2']);
    expect(gate?.detail).toContain('2/2 tasks measured');
  });

  it('names the unmeasured tasks in the detail so a reader can go look', () => {
    const v = evaluateGates({ ...pass, regressionEvidence: unmeasuredEvidence(['t-alpha', 't-beta']) });
    expect(v.results.find((r) => r.gate === 'no-new-regressions')?.detail).toContain('t-alpha, t-beta');
  });

  it('threshold gates keep a two-state status — they are computed from values that always exist', () => {
    const v = evaluateGates({ ...pass, candidateMeanCost: 1.6 });
    expect(v.results.find((r) => r.gate === 'cost')?.status).toBe('fail');
    expect(v.results.find((r) => r.gate === 'improvement')?.status).toBe('pass');
  });
});

describe('rollUpEvidenceStatus', () => {
  it('lets a measured fail outrank a gap', () => {
    expect(rollUpEvidenceStatus(['pass', 'not-measured', 'fail'])).toBe('fail');
  });

  it('treats any gap among passes as not-measured', () => {
    expect(rollUpEvidenceStatus(['pass', 'not-measured'])).toBe('not-measured');
  });

  it('treats an EMPTY contributor set as not-measured, never a vacuous pass', () => {
    expect(rollUpEvidenceStatus([])).toBe('not-measured');
  });

  it('passes only when every contributor passed', () => {
    expect(rollUpEvidenceStatus(['pass', 'pass'])).toBe('pass');
  });
});
