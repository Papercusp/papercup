/**
 * arms.test.ts — the benchmark-arm vocabulary (impartial-benchmark-suite). armLabel +
 * armColor are the cross-brief contract the gym + Evaluation surfaces key on. The
 * load-bearing invariant (per the module doc): every KNOWN arm has an explicit human
 * label + color token/value (so the legend/scoreboard are complete), and an UNKNOWN arm
 * falls back safely — raw id for the label, the neutral muted color — so a newly-introduced arm
 * never crashes the chart. A regression that drops a known arm from either switch (it
 * would silently render with the fallback) is what this catches.
 *
 * In-tree (apps/operator, tab-visible).
 * Run: cd apps/operator && npx vitest run app/eval-viz/arms.test.ts
 */
import { describe, expect, it } from 'vitest';
import { ARM_IDS, armLabel, armColor } from './arms';

describe('benchmark arm vocabulary', () => {
  it('ARM_IDS is non-empty and de-duplicated', () => {
    expect(ARM_IDS.length).toBeGreaterThan(0);
    expect(new Set(ARM_IDS).size).toBe(ARM_IDS.length);
  });

  it('every known arm has an explicit label (not the raw-id fallback)', () => {
    for (const id of ARM_IDS) {
      const label = armLabel(id);
      expect(label, id).toBeTruthy();
      expect(label, `${id} fell through to the raw-id fallback`).not.toBe(id);
    }
  });

  it('every known arm has an explicit color (not the neutral fallback)', () => {
    for (const id of ARM_IDS) {
      const color = armColor(id);
      expect(color, `${id} should be an explicit color`).toMatch(/^(#[0-9a-f]{6}|var\(--)/i);
      expect(color, `${id} should not use the neutral fallback`).not.toMatch(/var\(--fg-mute/);
    }
  });

  it('an unknown arm falls back safely (raw label, neutral color) — never crashes the chart', () => {
    expect(armLabel('brand-new-arm-2099')).toBe('brand-new-arm-2099');
    expect(armColor('brand-new-arm-2099')).toMatch(/var\(--fg-mute/);
  });

  it('the treatment + its no-Queen control are visually distinct', () => {
    // hive-realqueen (treatment) vs fifo-noqueen (control) must not share a color.
    expect(armColor('hive-realqueen')).not.toBe(armColor('fifo-noqueen'));
  });
});
