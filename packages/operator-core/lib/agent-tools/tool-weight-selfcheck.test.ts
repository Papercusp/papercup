/**
 * tool-weight-selfcheck.test — EI-10966. Two things must hold:
 *  1. the shared budget math (weight, two-tier violations, self-serve delta) is
 *     correct — this is what the live operator warns on AND the gate reds on, so
 *     they can never disagree;
 *  2. the live self-check is SILENT under vitest — a warn here would let
 *     vitest-fail-on-console red every unrelated suite that imports the catalog,
 *     re-creating the fleet-wide blast radius the fix exists to shrink.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BUDGET,
  HARD_CAP,
  promptWeight,
  budgetViolations,
  formatViolations,
  type NamedToolWeight,
} from './tool-guidance-budget';
import { runToolWeightSelfCheck } from './tool-weight-selfcheck';

describe('promptWeight (EI-10966 — matches the assembled-prompt string weight)', () => {
  it('sums description + every guidance field, including per-role', () => {
    const w = promptWeight({
      description: 'x'.repeat(100),
      guidance: {
        when: 'y'.repeat(10),
        notWhen: 'z'.repeat(5),
        chaining: 'c'.repeat(7),
        byRole: {
          worker: { when: 'w'.repeat(3), chaining: 'h'.repeat(2) },
          queen: { notWhen: 'n'.repeat(4) },
        },
      },
    });
    expect(w).toBe(100 + 10 + 5 + 7 + 3 + 2 + 4);
  });

  it('is 0 for an empty tool and ignores unknown fields', () => {
    expect(promptWeight({})).toBe(0);
    expect(promptWeight({ description: 'abc' })).toBe(3);
  });
});

describe('budgetViolations (the two-tier gate, mirrored)', () => {
  const weights: NamedToolWeight[] = [
    { name: 'fits', weight: BUDGET }, // exactly at budget → OK (strictly-greater breaches)
    { name: 'over-budget', weight: BUDGET + 44 }, // 1544
    { name: 'over-cap', weight: HARD_CAP + 106 }, // 1706
    { name: 'tiny', weight: 200 },
  ];

  it('flags a non-grandfathered over-budget tool with the exact cut-to-budget', () => {
    const v = budgetViolations(weights).find((x) => x.name === 'over-budget')!;
    expect(v).toMatchObject({ hardCap: false, grandfathered: false, cutAtLeast: 44 });
  });

  it('flags an over-hard-cap tool with the cut measured to the HARD CAP, not the budget', () => {
    const v = budgetViolations(weights).find((x) => x.name === 'over-cap')!;
    expect(v).toMatchObject({ hardCap: true, cutAtLeast: 106 });
  });

  it('a tool exactly at budget and a tiny tool are not violations', () => {
    const names = budgetViolations(weights).map((v) => v.name);
    expect(names).not.toContain('fits');
    expect(names).not.toContain('tiny');
  });

  it('sorts heaviest-first', () => {
    expect(budgetViolations(weights).map((v) => v.name)).toEqual(['over-cap', 'over-budget']);
  });
});

describe('formatViolations (self-serve — names the delta to trim, EI-10966 #2)', () => {
  it('prints the tool, its weight, and the chars to cut', () => {
    const msg = formatViolations(budgetViolations([{ name: 'loop:checkpoint', weight: 1706 }]));
    expect(msg).toContain('loop:checkpoint');
    expect(msg).toContain('1706');
    expect(msg).toContain('cut ≥106');
    expect(msg).toContain(`${HARD_CAP}-char HARD CAP`);
  });

  it('is empty for no violations', () => {
    expect(formatViolations([])).toBe('');
  });
});

describe('runToolWeightSelfCheck — SILENT under vitest (the anti-blast-radius guarantee)', () => {
  it('never calls console.warn while process.env.VITEST is set', () => {
    // vitest sets process.env.VITEST in the worker; assert the gate we rely on.
    expect(process.env.VITEST).toBeTruthy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runToolWeightSelfCheck();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
