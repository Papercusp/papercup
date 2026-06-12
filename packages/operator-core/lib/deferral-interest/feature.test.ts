/**
 * feature.test.ts — the deferral-pricing evaluator seam (P-042 / FB-14):
 * model-backed pricing, the no-model degradation, and the defensive loader.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { fitDeferralPricingModel } from './model';
import type { DeferralOutcome } from './outcomes';
import { deferralFeatureEvaluator, loadDeferralFeature } from './feature';

const ITEM: ImprovementCandidate = {
  id: 'EI-9',
  kind: 'change',
  scope: 'operator',
  title: 'a deferred decision',
  severity: 'major',
};

function trainedModel() {
  const outcome: DeferralOutcome = {
    id: 'EI-1',
    features: { severity: 'major', kind: 'change', watchdog: false, source: 'human', scopeKind: 'operator' },
    deferredAtMs: 0,
    decidedAtMs: null,
    daysDeferred: 14,
    weeksDeferred: 2,
    blocksOut: 1,
    inboundRefs: 0,
    recaptures: 0,
    dupPeers: 0,
    realizedCost: 12,
  };
  return fitDeferralPricingModel([outcome], { trainedAt: '2026-06-12T00:00:00.000Z' });
}

describe('deferralFeatureEvaluator', () => {
  it('null model → zero-priced with the pre-refit reason', () => {
    const v = deferralFeatureEvaluator(null)(ITEM);
    expect(v.value).toBe(0);
    expect(v.reasons[0]).toContain('no trained deferral-pricing model');
  });

  it('trained model → a positive weekly rate with named reasons + the weak caveat', () => {
    const v = deferralFeatureEvaluator(trainedModel())(ITEM);
    expect(v.value).toBeGreaterThan(0);
    expect(v.reasons[0]).toContain('per week deferred');
    expect(v.reasons.some((r) => r.includes('weak coefficients'))).toBe(true);
  });
});

describe('loadDeferralFeature', () => {
  it('degrades to the no-model evaluator when the store read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = (() => Promise.reject(new Error('pg down'))) as never;
      const evaluate = await loadDeferralFeature(sql, 'ws-1');
      expect(evaluate(ITEM).value).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('model read failed'), 'pg down');
    } finally {
      warn.mockRestore();
    }
  });
});
