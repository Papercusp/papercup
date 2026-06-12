/**
 * model.test.ts — the v0 deferral-pricing model (P-042 / FB-14): pooled-rate
 * fit, exposure-weighted shrinkage, inspectable predict/explain, weak-data
 * honesty, and the jsonb round-trip guard.
 */
import { describe, expect, it } from 'vitest';
import type { DeferralFeatures, DeferralOutcome } from './outcomes';
import {
  fitDeferralPricingModel,
  isDeferralPricingModel,
  priceDeferral,
  FACTOR_CLAMP,
  WEAK_SAMPLE_ITEMS,
  WEAK_SAMPLE_WEEKS,
} from './model';

const TRAINED_AT = '2026-06-12T00:00:00.000Z';

const FEATURES: DeferralFeatures = {
  severity: 'minor',
  kind: 'change',
  watchdog: false,
  source: 'human',
  scopeKind: 'operator',
};

let n = 0;
function outcome(over: Partial<DeferralOutcome> & { weeksDeferred: number; realizedCost: number }): DeferralOutcome {
  n += 1;
  return {
    id: `EI-${n}`,
    features: FEATURES,
    deferredAtMs: 0,
    decidedAtMs: null,
    daysDeferred: over.weeksDeferred * 7,
    blocksOut: 0,
    inboundRefs: 0,
    recaptures: 0,
    dupPeers: 0,
    ...over,
  };
}

describe('fit', () => {
  it('empty training set → zero global rate, weak, prices everything 0', () => {
    const m = fitDeferralPricingModel([], { trainedAt: TRAINED_AT });
    expect(m.globalRatePerWeek).toBe(0);
    expect(m.weak).toBe(true);
    const priced = priceDeferral(m, FEATURES);
    expect(priced.ratePerWeek).toBe(0);
    expect(priced.reasons.some((r) => r.includes('weak coefficients'))).toBe(true);
  });

  it('global rate is exposure-pooled (Σcost / Σweeks), not a mean of ratios', () => {
    // 2 weeks @ 20 cost + 8 weeks @ 0 cost → 20/10 = 2/wk (a ratio-mean would say 5).
    const m = fitDeferralPricingModel(
      [outcome({ weeksDeferred: 2, realizedCost: 20 }), outcome({ weeksDeferred: 8, realizedCost: 0 })],
      { trainedAt: TRAINED_AT },
    );
    expect(m.globalRatePerWeek).toBe(2);
  });

  it('a low-exposure bucket shrinks to ~1; sustained exposure moves the factor', () => {
    const critical: DeferralFeatures = { ...FEATURES, severity: 'critical' };
    const outcomes = [
      // 1 week of critical at 10×-global rate — barely any exposure.
      outcome({ weeksDeferred: 1, realizedCost: 20, features: critical }),
      // 19 weeks of minor at ~1/wk.
      outcome({ weeksDeferred: 19, realizedCost: 19 }),
    ];
    const m = fitDeferralPricingModel(outcomes, { trainedAt: TRAINED_AT, priorWeeks: 8 });
    const crit = m.buckets['severity:critical'];
    const minor = m.buckets['severity:minor'];
    // raw critical factor ≈ 20/1.95 ≈ 10×, but with 1 week vs 8 prior-weeks it lands near 1
    // ((1×10.26 + 8×1)/9 ≈ 2.0).
    expect(crit.factor).toBeGreaterThan(1);
    expect(crit.factor).toBeLessThan(3);
    // minor has 19 weeks of exposure — its factor stays closer to its raw 0.51
    // ((19×0.51 + 8×1)/27 ≈ 0.66) than to the prior 1.0.
    expect(minor.factor).toBeLessThan(0.75);
    expect(minor.factor).toBeGreaterThan(0.5);
  });

  it('priorWeeks 0 disables shrinkage (raw factors), and factors clamp', () => {
    const hot: DeferralFeatures = { ...FEATURES, severity: 'critical' };
    const m = fitDeferralPricingModel(
      [outcome({ weeksDeferred: 1, realizedCost: 10000, features: hot }), outcome({ weeksDeferred: 99, realizedCost: 1 })],
      { trainedAt: TRAINED_AT, priorWeeks: 0 },
    );
    expect(m.buckets['severity:critical'].factor).toBe(FACTOR_CLAMP[1]);
  });

  it('is deterministic (bucket keys sorted, rounded values)', () => {
    const outcomes = [outcome({ weeksDeferred: 3, realizedCost: 7 }), outcome({ weeksDeferred: 5, realizedCost: 13 })];
    const a = fitDeferralPricingModel(outcomes, { trainedAt: TRAINED_AT });
    const b = fitDeferralPricingModel([...outcomes].reverse(), { trainedAt: TRAINED_AT });
    expect(a).toEqual(b);
    expect(Object.keys(a.buckets)).toEqual([...Object.keys(a.buckets)].sort());
  });

  it('weak flips off only past both sample thresholds', () => {
    const big = Array.from({ length: WEAK_SAMPLE_ITEMS }, () =>
      outcome({ weeksDeferred: WEAK_SAMPLE_WEEKS / WEAK_SAMPLE_ITEMS + 0.1, realizedCost: 3 }),
    );
    expect(fitDeferralPricingModel(big, { trainedAt: TRAINED_AT }).weak).toBe(false);
    expect(fitDeferralPricingModel(big.slice(0, 10), { trainedAt: TRAINED_AT }).weak).toBe(true);
  });
});

describe('predict + explain', () => {
  it('price = global × the item buckets\' factors; unseen buckets price global', () => {
    const watchdog: DeferralFeatures = { ...FEATURES, watchdog: true };
    const m = fitDeferralPricingModel(
      [
        outcome({ weeksDeferred: 30, realizedCost: 120, features: watchdog }), // 4/wk
        outcome({ weeksDeferred: 30, realizedCost: 30 }), // 1/wk
      ],
      { trainedAt: TRAINED_AT },
    );
    const hot = priceDeferral(m, watchdog);
    const cold = priceDeferral(m, FEATURES);
    expect(hot.ratePerWeek).toBeGreaterThan(cold.ratePerWeek);
    // A bucket combination never seen in training prices off the global base.
    const unseen = priceDeferral(m, { ...FEATURES, kind: 'never-trained-kind' });
    expect(unseen.ratePerWeek).toBeGreaterThan(0);
    // Every moved factor is named with its sample size (D-005 inspectability).
    expect(hot.factors.every((f) => /:.+/.test(f.bucket) && f.items > 0)).toBe(true);
    expect(hot.reasons[0]).toContain('per week deferred');
  });
});

describe('jsonb round-trip guard', () => {
  it('accepts a serialized model; rejects junk', () => {
    const m = fitDeferralPricingModel([outcome({ weeksDeferred: 2, realizedCost: 4 })], { trainedAt: TRAINED_AT });
    expect(isDeferralPricingModel(JSON.parse(JSON.stringify(m)))).toBe(true);
    expect(isDeferralPricingModel(null)).toBe(false);
    expect(isDeferralPricingModel({ version: 2 })).toBe(false);
    expect(isDeferralPricingModel({ ...m, buckets: undefined })).toBe(false);
  });
});
