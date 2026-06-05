import { describe, it, expect } from 'vitest';
import { decideAccept, selectParent, type VariantEval } from '../gate-engine';

/**
 * Accept/reject gate engine (P-018): assemble a candidate's eval results + the
 * parent/champion baselines into GateInputs and run the gates; plus parent
 * selection from the frontier (biased toward the under-served / most-headroom member).
 */
const champion: VariantEval = {
  variantId: 'champ', trainAgg: 7.0, trainVector: [7, 7], devAnchorAgg: 7.3,
  meanCost: 1.0, anyNewRegression: false, allProbesCaught: true,
};
const parent: VariantEval = { ...champion, variantId: 'parent', trainAgg: 7.0 };
const thresholds = { epsilon: 0.3, delta: 0.2, costCeiling: 1.5 };

describe('decideAccept', () => {
  it('accepts a candidate that clears every gate', () => {
    const cand: VariantEval = {
      variantId: 'cand', trainAgg: 7.5, trainVector: [8, 7], devAnchorAgg: 7.2,
      meanCost: 1.1, anyNewRegression: false, allProbesCaught: true,
    };
    const v = decideAccept(cand, parent, champion, 1.0, thresholds);
    expect(v.accept).toBe(true);
  });

  it('rejects a candidate that regresses the dev-anchor beyond delta', () => {
    const cand: VariantEval = {
      variantId: 'cand', trainAgg: 8.0, trainVector: [8, 8], devAnchorAgg: 7.0, // < 7.3 - 0.2
      meanCost: 1.0, anyNewRegression: false, allProbesCaught: true,
    };
    const v = decideAccept(cand, parent, champion, 1.0, thresholds);
    expect(v.accept).toBe(false);
    expect(v.results.find((r) => r.gate === 'dev-anchor-no-regress')?.pass).toBe(false);
  });

  it('rejects a candidate with no train improvement over parent', () => {
    const cand: VariantEval = { ...champion, variantId: 'cand', trainAgg: 7.1 }; // < 7.0 + 0.3
    expect(decideAccept(cand, parent, champion, 1.0, thresholds).accept).toBe(false);
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
