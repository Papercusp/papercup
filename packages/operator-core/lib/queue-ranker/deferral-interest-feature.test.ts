/**
 * deferral-interest-feature.test.ts — P-042's feature on the one ranker
 * (FB-14): inert while dark/untrained (order-preserving registration), priced
 * contributions once armed + trained, and the fail-dark flag guard.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScoredItem } from '../harness/improvements/digest';
import { fitDeferralPricingModel } from '../deferral-interest/model';
import type { DeferralOutcome } from '../deferral-interest/outcomes';
import type { HumanQueueRankContext } from './blocking-impact-feature';
import { makeDeferralInterestFeature } from './deferral-interest-feature';

const item = (id: string, over: Partial<ScoredItem> = {}): ScoredItem => ({
  id,
  kind: 'change',
  title: `item ${id}`,
  scope: 'operator',
  severity: 'major',
  tier: 'human',
  score: 10,
  ageDays: 3,
  tierReason: 'kind change is human-gated',
  ...over,
});

const ctx = (over: Partial<HumanQueueRankContext> = {}): HumanQueueRankContext => ({
  digest: { recurringSignatures: [], likelyDuplicates: [] },
  deps: { readLinkCounts: async () => new Map() },
  ...over,
});

function trainedModel() {
  const base: Omit<DeferralOutcome, 'id' | 'features' | 'weeksDeferred' | 'realizedCost'> = {
    deferredAtMs: 0,
    decidedAtMs: null,
    daysDeferred: 210,
    blocksOut: 0,
    inboundRefs: 0,
    recaptures: 0,
    dupPeers: 0,
  };
  // watchdog-tagged deferrals realized 4/wk; untagged 1/wk — so the watchdog
  // buckets genuinely separate (a single-outcome corpus has every factor at 1).
  const outcomes: DeferralOutcome[] = [
    {
      ...base,
      id: 'EI-1',
      features: { severity: 'major', kind: 'change', watchdog: true, source: 'human', scopeKind: 'operator' },
      weeksDeferred: 30,
      realizedCost: 120,
    },
    {
      ...base,
      id: 'EI-2',
      features: { severity: 'major', kind: 'change', watchdog: false, source: 'human', scopeKind: 'operator' },
      weeksDeferred: 30,
      realizedCost: 30,
    },
  ];
  return fitDeferralPricingModel(outcomes, { trainedAt: '2026-06-12T00:00:00.000Z' });
}

describe('deferral-interest feature (P-042 on the P-040 registry)', () => {
  it('flag OFF → contributes nothing (the D-001 inert registration)', async () => {
    const feature = makeDeferralInterestFeature({
      isEnabled: async () => false,
      loadModel: async () => trainedModel(),
    });
    const out = await feature.score([item('EI-1')], ctx());
    expect(out.size).toBe(0);
  });

  it('flag ON but no trained model → still inert (refit has not run)', async () => {
    const feature = makeDeferralInterestFeature({
      isEnabled: async () => true,
      loadModel: async () => null,
    });
    const out = await feature.score([item('EI-1')], ctx());
    expect(out.size).toBe(0);
  });

  it('armed + trained → per-item weekly rates with reasons and the namespaced attach', async () => {
    const feature = makeDeferralInterestFeature({
      isEnabled: async () => true,
      loadModel: async () => trainedModel(),
    });
    const out = await feature.score([item('EI-1'), item('EI-2', { severity: 'nit' })], ctx());
    const hot = out.get('EI-1')!;
    expect(hot.value).toBeGreaterThan(0);
    expect(hot.reasons?.[0]).toContain('per week deferred');
    expect(hot.attach).toHaveProperty('deferral');
    expect(out.get('EI-2')!.value).toBeGreaterThanOrEqual(0);
  });

  it('reads watchdogKey off the raw candidate (the payload field ScoredItem lacks)', async () => {
    const feature = makeDeferralInterestFeature({
      isEnabled: async () => true,
      loadModel: async () => trainedModel(),
    });
    const withWatchdog = await feature.score(
      [item('EI-1')],
      ctx({
        candidates: [
          { id: 'EI-1', kind: 'change', scope: 'operator', title: 'item EI-1', watchdogKey: 'tool-error:x' },
        ],
      }),
    );
    const without = await feature.score([item('EI-1')], ctx());
    // The trained corpus is watchdog:yes-heavy, so the watchdog bucket prices higher.
    expect(withWatchdog.get('EI-1')!.value).toBeGreaterThan(without.get('EI-1')!.value);
  });

  it('a model-load failure contributes 0, never throws into the ranker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const feature = makeDeferralInterestFeature({
        isEnabled: async () => true,
        loadModel: async () => {
          throw new Error('pg down');
        },
      });
      await expect(feature.score([item('EI-1')], ctx())).resolves.toEqual(new Map());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('model read failed'), 'pg down');
    } finally {
      warn.mockRestore();
    }
  });
});
