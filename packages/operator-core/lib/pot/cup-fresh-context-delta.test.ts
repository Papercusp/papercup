/**
 * cup-fresh-context-delta (P-006) — the three-regime per-task delta projection.
 */
import { describe, it, expect } from 'vitest';
import { freshContextRegimeDelta } from './cup-fresh-context-delta';

describe('freshContextRegimeDelta (P-006)', () => {
  it('the fresh-context saving equals the dropped carry; legacy = baseline + carry', () => {
    // D-011/D-016 ballpark: ~138K carry/warm-inject on a ~80K baseline.
    const d = freshContextRegimeDelta({ avgCarriedPerWarmInject: 138_000, freshSpawnBaselineTokens: 80_000 });
    expect(d.savedPerTaskTokens).toBe(138_000);
    expect(d.legacyCarryPerTaskTokens).toBe(138_000);
    expect(d.freshSpawnBaselineTokens).toBe(80_000);
    // carry share of the legacy prompt: 138K / (80K + 138K) ≈ 0.633.
    expect(d.carryShareOfLegacy).toBeCloseTo(138_000 / 218_000, 5);
  });

  it('always concludes collapse-to-fresh-spawn (warm-process benefit is zero a-priori, D-021)', () => {
    const d = freshContextRegimeDelta({ avgCarriedPerWarmInject: 1, freshSpawnBaselineTokens: 1 });
    expect(d.warmProcessBenefit).toBe(false);
    expect(d.recommendation).toBe('collapse-to-fresh-spawn');
  });

  it('handles the no-warm-inject case (null carry ⇒ zero saving, zero carry share)', () => {
    const d = freshContextRegimeDelta({ avgCarriedPerWarmInject: null, freshSpawnBaselineTokens: 80_000 });
    expect(d.savedPerTaskTokens).toBe(0);
    expect(d.carryShareOfLegacy).toBe(0);
  });

  it('clamps negative inputs to zero (defensive)', () => {
    const d = freshContextRegimeDelta({ avgCarriedPerWarmInject: -5, freshSpawnBaselineTokens: -5 });
    expect(d.savedPerTaskTokens).toBe(0);
    expect(d.freshSpawnBaselineTokens).toBe(0);
    expect(d.carryShareOfLegacy).toBe(0);
  });
});
