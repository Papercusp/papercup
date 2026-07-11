import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gaugeNeedsVerification,
  markContextEstimateFresh,
  refreshContextEstimateAtBoundary,
  resetContextVerifyForTests,
  verifyContextTokensForAlarm,
  VERIFY_FRESH_MS,
  type ContextVerifyDeps,
} from './context-estimate-verify';
import {
  getContextUsage,
  resetContextUsageCacheForTests,
} from './context-usage-cache';

const LIMIT = 400_000;

/** Deps whose estimate resolves `fresh` and whose PG write is a resolved spy. */
function deps(fresh: number | null, now = 1_000_000): ContextVerifyDeps & {
  estimate: ReturnType<typeof vi.fn>;
  writePgEstimate: ReturnType<typeof vi.fn>;
} {
  return {
    estimate: vi.fn(async () => fresh),
    writePgEstimate: vi.fn(async () => {}),
    now: () => now,
  };
}

afterEach(() => {
  resetContextVerifyForTests();
  resetContextUsageCacheForTests();
});

describe('verifyContextTokensForAlarm (WI-4154 verify-before-alarm)', () => {
  it('passes a below-band cached value through WITHOUT re-deriving', async () => {
    const d = deps(50_000);
    const out = await verifyContextTokensForAlarm('su-a', 200_000, LIMIT, d); // 50%
    expect(out).toBe(200_000);
    expect(d.estimate).not.toHaveBeenCalled();
    expect(d.writePgEstimate).not.toHaveBeenCalled();
  });

  it('re-derives an alarm-band reading and returns + writes through the fresh value', async () => {
    // The WI-4154 signature: cached 348283 (87%) is the pre-compaction number; the
    // transcript re-derive reads the true post-boundary 60298 (15%).
    const d = deps(60_298);
    const out = await verifyContextTokensForAlarm('su-b', 348_283, LIMIT, d);
    expect(out).toBe(60_298);
    expect(d.estimate).toHaveBeenCalledWith('su-b');
    expect(d.writePgEstimate).toHaveBeenCalledWith('su-b', 60_298);
    // In-process mirror corrected too (the annotator's read path).
    expect(getContextUsage('su-b', 1_000_000)).toEqual({ tokens: 60_298, limit: LIMIT });
  });

  it('confirms a genuinely-high reading (fresh ≥ band) — the alarm still fires, verified', async () => {
    const d = deps(352_000);
    const out = await verifyContextTokensForAlarm('su-c', 348_283, LIMIT, d);
    expect(out).toBe(352_000);
  });

  it('falls back to the cached reading when the estimator is blind (null)', async () => {
    const d = deps(null);
    const out = await verifyContextTokensForAlarm('su-d', 348_283, LIMIT, d);
    expect(out).toBe(348_283); // a blind estimator must not silence a possibly-real alarm
    expect(d.writePgEstimate).not.toHaveBeenCalled();
  });

  it('falls back to the cached reading when the estimator throws', async () => {
    const d = deps(null);
    d.estimate = vi.fn(async () => {
      throw new Error('boom');
    });
    const out = await verifyContextTokensForAlarm('su-e', 348_283, LIMIT, d);
    expect(out).toBe(348_283);
  });

  it('still returns the fresh value when the PG write-through fails', async () => {
    const d = deps(60_298);
    d.writePgEstimate = vi.fn(async () => {
      throw new Error('pg down');
    });
    const out = await verifyContextTokensForAlarm('su-f', 348_283, LIMIT, d);
    expect(out).toBe(60_298);
  });

  it('trusts a recently-verified reading (no second re-derive inside the TTL)', async () => {
    const d = deps(390_000);
    await verifyContextTokensForAlarm('su-g', 348_283, LIMIT, d);
    expect(d.estimate).toHaveBeenCalledTimes(1);
    // Second call inside VERIFY_FRESH_MS: cached passes through, estimator untouched.
    const d2 = { ...d, now: () => 1_000_000 + VERIFY_FRESH_MS - 1 };
    const out = await verifyContextTokensForAlarm('su-g', 390_000, LIMIT, d2);
    expect(out).toBe(390_000);
    expect(d.estimate).toHaveBeenCalledTimes(1);
    // Past the TTL it re-derives again.
    const d3 = { ...d, now: () => 1_000_000 + VERIFY_FRESH_MS + 1 };
    await verifyContextTokensForAlarm('su-g', 390_000, LIMIT, d3);
    expect(d.estimate).toHaveBeenCalledTimes(2);
  });

  it('passes null/undefined cached values straight through', async () => {
    const d = deps(60_298);
    expect(await verifyContextTokensForAlarm('su-h', null, LIMIT, d)).toBeNull();
    expect(await verifyContextTokensForAlarm('su-h', undefined, LIMIT, d)).toBeNull();
    expect(await verifyContextTokensForAlarm('su-h', 348_283, null, d)).toBe(348_283);
    expect(d.estimate).not.toHaveBeenCalled();
  });
});

describe('gaugeNeedsVerification (sync annotator gate)', () => {
  it('never suppresses below the alarm band', () => {
    const d = deps(1);
    expect(gaugeNeedsVerification('su-i', 200_000, LIMIT, d)).toBe(false); // 50%
    expect(gaugeNeedsVerification('su-i', 280_000, LIMIT, d)).toBe(false); // 70% quiet
    expect(d.estimate).not.toHaveBeenCalled();
  });

  it('suppresses an unverified alarm-band reading and kicks ONE background re-derive', async () => {
    let release: (v: number) => void = () => {};
    const gate = new Promise<number>((r) => {
      release = r;
    });
    const d = deps(0);
    d.estimate = vi.fn(() => gate);
    expect(gaugeNeedsVerification('su-j', 348_283, LIMIT, d)).toBe(true);
    expect(gaugeNeedsVerification('su-j', 348_283, LIMIT, d)).toBe(true); // still pending
    expect(d.estimate).toHaveBeenCalledTimes(1); // in-flight dedup
    release(60_298);
    await gate;
    await new Promise((r) => setImmediate(r)); // let the write-through settle
    // Verified now — the (corrected) reading renders from here on.
    expect(gaugeNeedsVerification('su-j', 60_298, LIMIT, d)).toBe(false);
  });

  it('does not suppress a recently-verified alarm-band reading', () => {
    markContextEstimateFresh('su-k', 1_000_000);
    const d = deps(1);
    expect(gaugeNeedsVerification('su-k', 348_283, LIMIT, d)).toBe(false);
    expect(d.estimate).not.toHaveBeenCalled();
  });
});

describe('refreshContextEstimateAtBoundary (compaction fast path)', () => {
  it('re-derives + writes through, and marks the owner verified', async () => {
    const d = deps(60_298);
    const out = await refreshContextEstimateAtBoundary('su-l', d);
    expect(out).toBe(60_298);
    expect(d.writePgEstimate).toHaveBeenCalledWith('su-l', 60_298);
    // The refresh counts as a verification: an alarm-band read right after it renders.
    expect(gaugeNeedsVerification('su-l', 340_000, LIMIT, d)).toBe(false);
  });

  it('returns null (no write) when the estimator is blind, and never throws', async () => {
    const d = deps(null);
    expect(await refreshContextEstimateAtBoundary('su-m', d)).toBeNull();
    expect(d.writePgEstimate).not.toHaveBeenCalled();
    d.estimate = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await refreshContextEstimateAtBoundary('su-m', d)).toBeNull();
  });
});
