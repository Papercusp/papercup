import { describe, it, expect } from 'vitest';
import { decideAccept, selectParent, type VariantEval } from '../gate-engine';
import { unmeasuredEvidence, type DeterministicEvidence, type GateStatus } from '../gates';

/** P-003: deterministic evidence that WAS collected, and came out `status`. */
const measured = (status: GateStatus): DeterministicEvidence => ({
  status,
  coverage: { measured: 1, required: 1, unmeasuredTaskIds: [] },
  artifacts: ['trace://t1'],
});

/**
 * Accept/reject gate engine (P-018): assemble a candidate's eval results + the
 * parent/champion baselines into GateInputs and run the gates; plus parent
 * selection from the frontier (biased toward the under-served / most-headroom member).
 */
const champion: VariantEval = {
  variantId: 'champ', trainAgg: 7.0, trainVector: [7, 7], devAnchorAgg: 7.3,
  realAnchorAgg: 7.0, realAnchorEvidence: measured('pass'),
  meanCost: 1.0, regressionEvidence: measured('pass'), probeEvidence: measured('pass'),
};
const parent: VariantEval = { ...champion, variantId: 'parent', trainAgg: 7.0 };
const thresholds = { epsilon: 0.3, delta: 0.2, costCeiling: 1.5 };

describe('decideAccept', () => {
  it('accepts a candidate that clears every gate', () => {
    const cand: VariantEval = {
      variantId: 'cand', trainAgg: 7.5, trainVector: [8, 7], devAnchorAgg: 7.2,
      realAnchorAgg: 7.0, realAnchorEvidence: measured('pass'),
      meanCost: 1.1, regressionEvidence: measured('pass'), probeEvidence: measured('pass'),
    };
    const v = decideAccept(cand, parent, champion, 1.0, thresholds);
    expect(v.accept).toBe(true);
  });

  it('P-003: a candidate whose guardrail was never measured is INCONCLUSIVE, not accepted', () => {
    const cand: VariantEval = {
      variantId: 'cand', trainAgg: 7.5, trainVector: [8, 7], devAnchorAgg: 7.2,
      realAnchorAgg: 7.0, realAnchorEvidence: measured('pass'),
      meanCost: 1.1, regressionEvidence: measured('pass'), probeEvidence: unmeasuredEvidence([]),
    };
    const v = decideAccept(cand, parent, champion, 1.0, thresholds);
    expect(v.outcome).toBe('inconclusive');
    expect(v.accept).toBe(false);
  });

  it('rejects a candidate that regresses the dev-anchor beyond delta', () => {
    const cand: VariantEval = {
      variantId: 'cand', trainAgg: 8.0, trainVector: [8, 8], devAnchorAgg: 7.0, // < 7.3 - 0.2
      realAnchorAgg: 7.0, realAnchorEvidence: measured('pass'),
      meanCost: 1.0, regressionEvidence: measured('pass'), probeEvidence: measured('pass'),
    };
    const v = decideAccept(cand, parent, champion, 1.0, thresholds);
    expect(v.accept).toBe(false);
    expect(v.results.find((r) => r.gate === 'dev-anchor-no-regress')?.pass).toBe(false);
  });

  it('rejects a candidate with no train improvement over parent', () => {
    const cand: VariantEval = { ...champion, variantId: 'cand', trainAgg: 7.1 }; // < 7.0 + 0.3
    expect(decideAccept(cand, parent, champion, 1.0, thresholds).accept).toBe(false);
  });

  /**
   * P-002 / D-004(3) — the real-anchor pool now gates promotion, and the comparison is
   * assembled HERE from two VariantEvals, so the champion's own coverage is part of the
   * verdict. A candidate-only check would silently pass whenever the incumbent had never
   * been scored on real work — which is exactly the state every pre-P-001 champion is in.
   */
  it('rejects a candidate that regresses the real-anchor even though every other gate holds', () => {
    const cand: VariantEval = {
      variantId: 'cand', trainAgg: 7.5, trainVector: [8, 7], devAnchorAgg: 7.2,
      realAnchorAgg: 6.5, realAnchorEvidence: measured('pass'), // < 7.0 − 0.2
      meanCost: 1.0, regressionEvidence: measured('pass'), probeEvidence: measured('pass'),
    };
    const v = decideAccept(cand, parent, champion, 1.0, thresholds);
    expect(v.accept).toBe(false);
    expect(v.outcome).toBe('reject');
    expect(v.results.find((r) => r.gate === 'real-anchor-no-regress')?.status).toBe('fail');
  });

  it('is INCONCLUSIVE when the CHAMPION was never scored on the real-anchor — nothing to be no-worse-than', () => {
    const unscoredChampion: VariantEval = { ...champion, realAnchorAgg: 0, realAnchorEvidence: unmeasuredEvidence([]) };
    const cand: VariantEval = {
      variantId: 'cand', trainAgg: 7.5, trainVector: [8, 7], devAnchorAgg: 7.2,
      realAnchorAgg: 9.9, realAnchorEvidence: measured('pass'), // a great real-anchor score…
      meanCost: 1.0, regressionEvidence: measured('pass'), probeEvidence: measured('pass'),
    };
    const v = decideAccept(cand, parent, unscoredChampion, 1.0, thresholds);
    // …against an unmeasured incumbent is not evidence of no regression.
    expect(v.outcome).toBe('inconclusive');
    expect(v.accept).toBe(false);
    expect(v.results.find((r) => r.gate === 'real-anchor-no-regress')?.status).toBe('not-measured');
  });

  it('is INCONCLUSIVE when neither side ran a real-anchor task — a shadow cycle promotes nothing', () => {
    const noReal = (v: VariantEval): VariantEval => ({ ...v, realAnchorAgg: 0, realAnchorEvidence: unmeasuredEvidence([]) });
    const cand: VariantEval = noReal({
      variantId: 'cand', trainAgg: 7.5, trainVector: [8, 7], devAnchorAgg: 7.2,
      realAnchorAgg: 0, realAnchorEvidence: measured('pass'),
      meanCost: 1.0, regressionEvidence: measured('pass'), probeEvidence: measured('pass'),
    });
    const v = decideAccept(cand, noReal(parent), noReal(champion), 1.0, thresholds);
    expect(v.outcome).toBe('inconclusive');
    expect(v.accept).toBe(false);
  });
});

describe('selectParent', () => {
  it('picks the frontier member with the most headroom (lowest trainAgg)', () => {
    const front = [
      { variantId: 'a', trainAgg: 8.0 },
      { variantId: 'b', trainAgg: 6.5 },
      { variantId: 'c', trainAgg: 7.0 },
    ];
    expect(selectParent(front)?.variantId).toBe('b');
  });
  it('breaks ties by id', () => {
    expect(selectParent([{ variantId: 'z', trainAgg: 7 }, { variantId: 'a', trainAgg: 7 }])?.variantId).toBe('a');
  });
  it('returns null for an empty frontier', () => {
    expect(selectParent([])).toBeNull();
  });
});
