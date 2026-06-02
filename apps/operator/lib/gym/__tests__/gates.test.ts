import { describe, it, expect } from 'vitest';
import { evaluateGates, type GateInputs } from '../gates';

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
  anyNewRegression: false,
  allProbesCaught: true,
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
    const v = evaluateGates({ ...pass, anyNewRegression: true });
    expect(v.accept).toBe(false);
    expect(v.results.find((r) => r.gate === 'no-new-regressions')?.pass).toBe(false);
  });

  it('rejects when a planted bug was not caught (un-gameable)', () => {
    const v = evaluateGates({ ...pass, allProbesCaught: false });
    expect(v.accept).toBe(false);
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
