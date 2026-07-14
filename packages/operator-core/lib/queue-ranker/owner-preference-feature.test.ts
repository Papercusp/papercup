/**
 * owner-preference-feature.test.ts — P-043's feature on the one ranker
 * (FB-15): inert while the kill-switch is OFF (injected deps — never live
 * IO), graduated default-ON in FLAG_DEFAULTS, bounded re-ranking values
 * with reasons once armed, and the fail-dark guards.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScoredItem } from '../harness/improvements/digest';
import type { OwnerSignal } from '../owner-preference/affinity';
import type { HumanQueueRankContext } from './blocking-impact-feature';
import { makeOwnerPreferenceFeature } from './owner-preference-feature';

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

  it('the feature is GRADUATED: papercusp-owner-preference-ranking defaults ON (not in DARK_FLAGS)', async () => {
    // The old pin here asserted the dark-ship contract (default instance inert
    // under FLAG_DEFAULTS = false) by CALLING score() on the default registry
    // instance. That was a live-state time-bomb: with the flag graduated to
    // default-ON (derived FLAG_DEFAULTS — every non-dark flag is true), the
    // default instance's readSignal really queries the operator DB, so the
    // assertion flipped red the moment the dev box's accumulated owner
    // interaction history crossed the model's evidence floor (2026-07-13).
    // A unit test must never depend on live-DB state, so pin the graduation
    // itself (pure) instead; the flag-OFF inert path stays pinned above via
    // injected deps, and fail-dark guards below.
    const { FLAGS, FLAG_DEFAULTS, DARK_FLAGS } = await import('@papercusp/flags');
    expect(DARK_FLAGS.has(FLAGS.OWNER_PREFERENCE_RANKING)).toBe(false);
    expect(FLAG_DEFAULTS[FLAGS.OWNER_PREFERENCE_RANKING]).toBe(true);
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
