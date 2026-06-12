/**
 * owner-preference-feature.test.ts — P-043's feature on the one ranker
 * (FB-15): inert while dark (order-preserving registration — the default
 * registry instance contributes nothing under FLAG_DEFAULTS), bounded
 * re-ranking values with reasons once armed, and the fail-dark guards.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScoredItem } from '../harness/improvements/digest';
import type { OwnerSignal } from '../owner-preference/affinity';
import type { HumanQueueRankContext } from './blocking-impact-feature';
import { makeOwnerPreferenceFeature, ownerPreferenceFeature } from './owner-preference-feature';

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

const ctx = (): HumanQueueRankContext => ({
  digest: { recurringSignatures: [], likelyDuplicates: [] },
  deps: { readLinkCounts: async () => new Map() },
});

/** An owner who engages critical items and was shown plenty of nit ones. */
const richSignal = (): OwnerSignal => ({
  engagements: Array.from({ length: 6 }, () => ({
    kind: 'grade' as const,
    severity: 'critical',
    scope: 'operator',
  })),
  exposureCountById: new Map(),
  exposureCountByBucket: new Map([
    ['severity:critical', 10],
    ['severity:nit', 10],
  ]),
  totalExposures: 20,
});

describe('owner-preference feature (P-043 on the P-040 registry)', () => {
  it('flag OFF → contributes nothing and never reads the signal (D-001 inert registration)', async () => {
    const readSignal = vi.fn(async () => richSignal());
    const feature = makeOwnerPreferenceFeature({ isEnabled: async () => false, readSignal });
    const out = await feature.score([item('EI-1')], ctx());
    expect(out.size).toBe(0);
    expect(readSignal).not.toHaveBeenCalled();
  });

  it('the DEFAULT registry instance is inert under FLAG_DEFAULTS (dark ship)', async () => {
    // No env override, no test override, no override store, no PostHog client
    // in the unit env → getFlag falls through to FLAG_DEFAULTS = false, with
    // zero IO. This is what makes registering the feature order-preserving.
    const out = await ownerPreferenceFeature.score([item('EI-1')], ctx());
    expect(out.size).toBe(0);
  });

  it('armed → bounded values with reason lines (promote engaged buckets, demote ignored ones)', async () => {
    const feature = makeOwnerPreferenceFeature({
      isEnabled: async () => true,
      readSignal: async () => richSignal(),
    });
    const out = await feature.score(
      [item('EI-HOT', { severity: 'critical' }), item('EI-COLD', { severity: 'nit' })],
      ctx(),
    );
    const hot = out.get('EI-HOT')!;
    const cold = out.get('EI-COLD')!;
    expect(hot.value).toBeGreaterThan(0);
    expect(cold.value).toBeLessThan(0);
    expect(hot.value).toBeLessThanOrEqual(1);
    expect(cold.value).toBeGreaterThanOrEqual(-1);
    expect(hot.reasons?.[0]).toContain('severity critical');
  });

  it('empty queue → no flag read, no signal read', async () => {
    const isEnabled = vi.fn(async () => true);
    const readSignal = vi.fn(async () => richSignal());
    const out = await makeOwnerPreferenceFeature({ isEnabled, readSignal }).score([], ctx());
    expect(out.size).toBe(0);
    expect(isEnabled).not.toHaveBeenCalled();
    expect(readSignal).not.toHaveBeenCalled();
  });

  it('a signal-read failure contributes 0, never throws into the ranker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const feature = makeOwnerPreferenceFeature({
        isEnabled: async () => true,
        readSignal: async () => {
          throw new Error('pg down');
        },
      });
      await expect(feature.score([item('EI-1')], ctx())).resolves.toEqual(new Map());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('signal read failed'), 'pg down');
    } finally {
      warn.mockRestore();
    }
  });
});
