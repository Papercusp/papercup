import { describe, it, expect } from 'vitest';
import { computeElSpend } from './voice_spend_summary';

// Gap-7 (test-coverage-gap): readElSpend was welded to PG + prefs with no seam,
// so the EL (Conv AI) budget math — overCap (>= boundary), the [0,1] pctUsed
// clamp, and the "uncapped" coercion for a non-positive/non-number cap — had no
// unit coverage (stt/tts slices did). computeElSpend is the extracted pure seam;
// these pin the budget-enforcement-driving arithmetic.

describe('computeElSpend', () => {
  it('computes minutes from seconds and passes ym through', () => {
    const r = computeElSpend(90, 10, '2026-06');
    expect(r.minutesUsed).toBeCloseTo(1.5);
    expect(r.minutesCap).toBe(10);
    expect(r.ym).toBe('2026-06');
    expect(r.overCap).toBe(false);
    expect(r.pctUsed).toBeCloseTo(0.15);
  });

  it('overCap flips true exactly AT the cap (>=, not >)', () => {
    const r = computeElSpend(60, 1, '2026-06'); // 1.0 minute used, cap 1
    expect(r.minutesUsed).toBeCloseTo(1);
    expect(r.overCap).toBe(true); // 1 >= 1
    expect(r.pctUsed).toBeCloseTo(1);
  });

  it('just under the cap is not overCap', () => {
    const r = computeElSpend(59, 1, '2026-06'); // 0.983 min
    expect(r.overCap).toBe(false);
    expect(r.pctUsed).toBeLessThan(1);
  });

  it('clamps pctUsed to 1 when over the cap (no >100%)', () => {
    const r = computeElSpend(180, 1, '2026-06'); // 3 min used, cap 1
    expect(r.overCap).toBe(true);
    expect(r.pctUsed).toBe(1); // Math.min(1, 3) — clamped, not 3
  });

  it('cap of 0 means uncapped → null cap/pct, never overCap', () => {
    const r = computeElSpend(600, 0, '2026-06');
    expect(r.minutesCap).toBeNull();
    expect(r.pctUsed).toBeNull();
    expect(r.overCap).toBe(false);
    expect(r.minutesUsed).toBeCloseTo(10); // usage still reported
  });

  it('a negative or non-number cap is treated as uncapped', () => {
    for (const cap of [-5, null, undefined, 'x', NaN, {}] as unknown[]) {
      const r = computeElSpend(120, cap, '2026-06');
      expect(r.minutesCap).toBeNull();
      expect(r.pctUsed).toBeNull();
      expect(r.overCap).toBe(false);
    }
  });

  it('zero usage with a real cap → 0% and not over', () => {
    const r = computeElSpend(0, 5, '2026-06');
    expect(r.minutesUsed).toBe(0);
    expect(r.pctUsed).toBe(0);
    expect(r.overCap).toBe(false);
  });
});
