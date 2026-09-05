/**
 * test-timing-budget-guard.test.ts — the wall-clock timing-budget guard's detection
 * predicate (EI-20290625014691548).
 *
 * The guard (`scripts/check-test-timing-budgets.mjs`) runs green on the clean tree: its
 * BASELINE grandfathers the 8 files measured as carrying a sub-floor budget. What that
 * green run CANNOT tell anyone is whether the predicate discriminates at all — a guard
 * that flagged nothing would look identical. These cases lock the direction the item
 * actually asks for, from both sides:
 *
 *   FLAGS      a tight numeric literal bound on elapsed wall-clock (the gate-red class)
 *   DOES NOT   a budget at or above the floor, a NAMED-constant budget (the sanctioned
 *              remediation), or a numeric bound on something that is not elapsed time.
 *
 * That last one is not padding. Reaching for this class with a naive grep over
 * `toBeLessThan(<small number>)` drowns in `expect(rows.length).toBeLessThan(9)` and
 * `expect(compareClaims(a, b)).toBeLessThan(0)` — measured while filing this, the first
 * pass was mostly `.length` assertions. A guard that inherited that over-match would
 * cry wolf on every array-size assertion in the tree and be baselined into silence
 * within a week, which is a worse outcome than the gap it was built to close.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only. Kept on ONE line: tsc reports TS7016 at the module-SPECIFIER line, so on a multi-line import the @ts-ignore lands on `import {` and suppresses nothing.
import { findWallClockBudgets, hasTightLiteralBudget, TIGHT_BUDGET_FLOOR_MS, BASELINE } from '../../../scripts/check-test-timing-budgets.mjs';

describe('wall-clock timing-budget guard predicate (EI-20290625014691548)', () => {
  it('FLAGS a tight literal budget on a direct elapsed assertion', () => {
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(80);')).toBe(true);
  });

  it('FLAGS the two-step form (elapsed hoisted into a local first)', () => {
    const src = ['const elapsed = Date.now() - startedAt;', 'expect(elapsed).toBeLessThan(120);'].join('\n');
    expect(hasTightLiteralBudget(src)).toBe(true);
  });

  it('FLAGS performance.now() the same as Date.now()', () => {
    expect(hasTightLiteralBudget('expect(performance.now() - t0).toBeLessThanOrEqual(50);')).toBe(true);
  });

  it('does NOT flag a budget at or above the floor', () => {
    // 500 is the floor itself — deliberately NOT tight, which is why the two measured
    // 500ms sites are absent from BASELINE rather than grandfathered into it.
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(500);')).toBe(false);
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(15_000);')).toBe(false);
  });

  it('does NOT flag a NAMED-constant budget — the sanctioned remediation', () => {
    // The WI-38338 fix pattern: hoist the budget into named constants and assert their
    // ordering, so a too-tight budget fails deterministically on the author's machine
    // instead of silently under load. Naming it is a way OUT of this guard by design.
    const src = [
      'const IDLE_DEADLINE_MS = 1_500;',
      'const HARD_CEILING_MS = 15_000;',
      'expect(IDLE_DEADLINE_MS).toBeLessThan(HARD_CEILING_MS);',
      'expect(Date.now() - started).toBeLessThan(IDLE_DEADLINE_MS);',
    ].join('\n');
    expect(hasTightLiteralBudget(src)).toBe(false);
  });

  it('does NOT flag a small numeric bound on something that is not elapsed time', () => {
    // The over-match control — see the file header.
    expect(hasTightLiteralBudget('expect(rows.length).toBeLessThan(9);')).toBe(false);
    expect(hasTightLiteralBudget('expect(compareClaims(early, late)).toBeLessThan(0);')).toBe(false);
    expect(hasTightLiteralBudget('expect(res.latencyMs).toBeLessThan(400);')).toBe(false);
  });

  it('does NOT treat an unrelated local as elapsed just because the file has a delta somewhere', () => {
    const src = [
      'const elapsed = Date.now() - startedAt;',
      'expect(elapsed).toBeLessThan(15_000);',
      'expect(pageCount).toBeLessThan(3);',
    ].join('\n');
    expect(hasTightLiteralBudget(src)).toBe(false);
  });

  it('does NOT flag an assertion QUOTED inside a string literal (this very file)', () => {
    // Found by running the guard against this test: the fixtures above ARE tight budgets,
    // written as strings, and a textual scanner cannot tell a fixture from live code. The
    // guard would have flagged its own test file — and the tempting fix, a BASELINE entry,
    // would have exempted this file permanently and hidden every real budget later added
    // to it. Skipping quoted matches is the honest fix; this pins it.
    const src = "const fixture = 'expect(Date.now() - started).toBeLessThan(80);';";
    expect(hasTightLiteralBudget(src)).toBe(false);
    // …while the same assertion UNQUOTED on a line is still caught.
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(80);')).toBe(true);
  });

  it('reports the parsed budget and distinguishes literal from named', () => {
    const found = findWallClockBudgets(
      ['expect(Date.now() - a).toBeLessThan(80);', 'expect(Date.now() - b).toBeLessThan(DEADLINE_MS);'].join('\n'),
    ) as Array<{ budgetMs: number | null; named: boolean }>;
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ budgetMs: 80, named: false });
    expect(found[1]).toMatchObject({ budgetMs: null, named: true });
  });

  it('keeps the floor and a seeded, non-empty shrink-only baseline', () => {
    expect(TIGHT_BUDGET_FLOOR_MS).toBe(500);
    // Non-empty because the tree genuinely carried pre-existing sub-floor budgets when
    // this landed; it is SHRINK-ONLY, so this number going DOWN is the intended
    // direction and a rise means someone grandfathered instead of fixing.
    expect((BASELINE as Set<string>).size).toBe(8);
    expect((BASELINE as Set<string>).has('packages/operator-core/lib/release-checkpoint-launch.test.ts')).toBe(true);
  });
});
