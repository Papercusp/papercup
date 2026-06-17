/**
 * Unit coverage for makeThrottle (activity-claim-renewal.ts) — the per-key
 * leading-edge throttle that collapses an owner's burst of per-tool-call
 * activity into ≤1 plan-item claim renewal per window.
 *
 * Why this matters: the window is measured from the last SUCCESSFUL fire, not
 * the last attempt — so a sustained burst still renews exactly once per
 * interval. If it were measured from the last attempt, a steady stream of
 * activity would defer every renewal forever and the claim would LAPSE
 * (→ the item returns to the pool and gets double-placed). The boundary is
 * inclusive (fires AT exactly intervalMs) so it never under-renews.
 */
import { describe, expect, it } from 'vitest';
import { makeThrottle, ACTIVITY_RENEW_THROTTLE_MS } from './activity-claim-renewal';

describe('makeThrottle', () => {
  it('fires on the leading edge (first call for a key)', () => {
    const passes = makeThrottle(60_000);
    expect(passes('owner-a', 0)).toBe(true);
  });

  it('blocks a second call within the interval', () => {
    const passes = makeThrottle(60_000);
    expect(passes('a', 0)).toBe(true);
    expect(passes('a', 1)).toBe(false);
    expect(passes('a', 59_999)).toBe(false);
  });

  it('fires AT exactly intervalMs (inclusive boundary — never under-renews)', () => {
    const passes = makeThrottle(60_000);
    expect(passes('a', 1_000)).toBe(true);
    expect(passes('a', 60_999)).toBe(false); // 59_999 since last fire
    expect(passes('a', 61_000)).toBe(true); // exactly 60_000 since last fire → fires
  });

  it('measures the window from the last SUCCESSFUL fire, not the last attempt', () => {
    const passes = makeThrottle(60_000);
    expect(passes('a', 0)).toBe(true); // fire → window anchor = 0
    expect(passes('a', 30_000)).toBe(false); // blocked, must NOT re-anchor to 30_000
    expect(passes('a', 50_000)).toBe(false); // blocked
    // If a blocked attempt had re-anchored, this would be <60s from 50_000 → blocked.
    // Anchored at 0, 60_000 is exactly one interval → fires.
    expect(passes('a', 60_000)).toBe(true);
  });

  it('throttles each key independently', () => {
    const passes = makeThrottle(60_000);
    expect(passes('a', 0)).toBe(true);
    expect(passes('b', 0)).toBe(true); // different owner — its own leading edge
    expect(passes('a', 100)).toBe(false);
    expect(passes('b', 100)).toBe(false);
    expect(passes('c', 100)).toBe(true);
  });

  it('re-anchors the window on each successful fire (steady cadence under sustained load)', () => {
    const passes = makeThrottle(10_000);
    const fires: number[] = [];
    for (let t = 0; t <= 35_000; t += 1_000) {
      if (passes('a', t)) fires.push(t);
    }
    // One fire at the leading edge, then exactly one per 10s window.
    expect(fires).toEqual([0, 10_000, 20_000, 30_000]);
  });

  it('exposes a sane default throttle window (≥ several seconds, ≪ the lease TTL)', () => {
    expect(ACTIVITY_RENEW_THROTTLE_MS).toBeGreaterThanOrEqual(1_000);
    expect(ACTIVITY_RENEW_THROTTLE_MS).toBeLessThan(20 * 60_000); // well under the ≥20m lease
  });
});
