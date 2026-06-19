import { describe, it, expect, vi } from 'vitest';
import { verifyDogfoodRoundTrip } from './dogfood-roundtrip';

const BASE = {
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp-platform',
  prUrl: 'https://github.com/Papercusp/papercup/pull/42',
};

describe('verifyDogfoodRoundTrip', () => {
  it('TEETH: a fully round-tripped loop (tracked→merged→shipped→linked) is ok', async () => {
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => ({ featureId: 'F-001', prState: 'merged' }),
      readFeatureStatus: async () => ({ status: 'shipped', hasCompletionRef: true }),
      readReviewReport: async () => ({ recommendation: 'approve' }),
    });
    expect(v.ok).toBe(true);
    expect(v.featureId).toBe('F-001');
    expect(v.stages).toEqual({
      prTracked: 'pass',
      reviewed: 'pass',
      merged: 'pass',
      shipped: 'pass',
      linked: 'pass',
    });
  });

  it('TEETH: no producer row (PR-4 not firing) ⇒ NOT ok (the WI↔PR link is the spine)', async () => {
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => null,
      readFeatureStatus: async () => ({ status: 'shipped', hasCompletionRef: true }),
    });
    expect(v.ok).toBe(false);
    expect(v.stages.prTracked).toBe('fail');
    expect(v.stages.linked).toBe('fail');
    expect(v.gaps.join(' ')).toContain('WI↔PR producer');
  });

  it('merged but feature not shipped (merge stamp did not fire) ⇒ NOT ok', async () => {
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => ({ featureId: 'F-001', prState: 'merged' }),
      readFeatureStatus: async () => ({ status: 'wip', hasCompletionRef: false }),
    });
    expect(v.ok).toBe(false);
    expect(v.stages.merged).toBe('pass');
    expect(v.stages.shipped).toBe('fail');
  });

  it('shipped status but NO completion_ref ⇒ shipped leg fails (must stamp via the real row)', async () => {
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => ({ featureId: 'F-001', prState: 'merged' }),
      readFeatureStatus: async () => ({ status: 'shipped', hasCompletionRef: false }),
    });
    expect(v.ok).toBe(false);
    expect(v.stages.shipped).toBe('fail');
  });

  it('PR still open (not merged) ⇒ NOT ok', async () => {
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => ({ featureId: 'F-001', prState: 'open' }),
      readFeatureStatus: async () => ({ status: 'wip', hasCompletionRef: false }),
    });
    expect(v.ok).toBe(false);
    expect(v.stages.merged).toBe('fail');
    expect(v.gaps.join(' ')).toContain('state=open');
  });

  it('the agent-review leg is GATED (not failed) when no PR-2 reader is wired', async () => {
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => ({ featureId: 'F-001', prState: 'merged' }),
      readFeatureStatus: async () => ({ status: 'shipped', hasCompletionRef: true }),
      // no readReviewReport
    });
    expect(v.stages.reviewed).toBe('gated');
    // gated review never blocks ok — the required legs all pass.
    expect(v.ok).toBe(true);
  });

  it('a reader that throws degrades to a failing leg, never throws', async () => {
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => {
        throw new Error('pg down');
      },
    });
    expect(v.ok).toBe(false);
    expect(v.stages.prTracked).toBe('fail');
  });

  it('a wired review reader that finds a report passes the reviewed leg', async () => {
    const readReviewReport = vi.fn(async () => ({ recommendation: 'request_changes' }));
    const v = await verifyDogfoodRoundTrip({
      ...BASE,
      readFeaturePrRow: async () => ({ featureId: 'F-001', prState: 'merged' }),
      readFeatureStatus: async () => ({ status: 'shipped', hasCompletionRef: true }),
      readReviewReport,
    });
    expect(v.stages.reviewed).toBe('pass');
    expect(readReviewReport).toHaveBeenCalledOnce();
  });
});
