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
import { findNestedChildBudgetInversions, findWallClockBudgets, hasTightLiteralBudget, TIGHT_BUDGET_FLOOR_MS, BASELINE, SPAWN_SYNC_EXPLICIT_BASELINE, findChildIdleWindowBudgets, IDLE_WINDOW_FLOOR_MS, IDLE_WINDOW_KEY_RE, SPAWNS_CHILD_RE, IDLE_WINDOW_BASELINE } from '../../../scripts/check-test-timing-budgets.mjs';

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
    expect((SPAWN_SYNC_EXPLICIT_BASELINE as Set<string>).size).toBe(10);
  });

  it('FLAGS a child-process timeout that outlives the implicit Vitest parent', () => {
    const src = `
      it('scans the tree', () => {
        const guard = runGuardScript('node', ['scripts/check-tree.mjs'], {
          cwd: REPO_ROOT,
          timeoutMs: 180_000,
        });
        expect(guard.status).toBe(0);
      });
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([
      expect.objectContaining({ childTimeoutMs: 180_000, parentTimeoutMs: 60_000, parentSource: 'implicit-default' }),
    ]);
  });

  it('does NOT flag a child-process budget with an explicit larger Vitest parent', () => {
    const src = `
      test('scans the tree', () => {
        runGuardScript('node', ['scripts/check-tree.mjs'], {
          cwd: REPO_ROOT,
          timeoutMs: 180_000,
        });
      }, 240_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('FLAGS equal child and parent budgets because the parent has no completion headroom', () => {
    const src = `
      it.only('scans the tree', () => {
        runGuardScript('node', [], { cwd: REPO_ROOT, timeoutMs: 120_000 });
      }, 120_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([
      expect.objectContaining({ childTimeoutMs: 120_000, parentTimeoutMs: 120_000, parentSource: 'explicit' }),
    ]);
  });

  it('does NOT infer a helper-routed or symbolic budget beyond the detector boundary', () => {
    const src = `
      const run = () => runGuardScript('node', [], { cwd: REPO_ROOT, timeoutMs: CHILD_TIMEOUT_MS });
      it('uses a helper', () => run());
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('does NOT crash or invent a budget when runGuardScript uses its default timeout', () => {
    const src = `
      it('uses the helper default', () => {
        runGuardScript('node', [], { cwd: REPO_ROOT });
      });
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('FLAGS a direct spawnSync timeout that outlives its explicit Vitest parent', () => {
    const src = `
      it('runs the real CLI', () => {
        spawnSync('node', ['scripts/validate.mjs'], { timeout: 120_000 });
      }, 30_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([
      expect.objectContaining({
        childCall: 'spawnSync',
        childTimeoutMs: 120_000,
        parentTimeoutMs: 30_000,
        parentSource: 'explicit',
      }),
    ]);
  });

  it('does NOT flag spawnSync when its Vitest parent has completion headroom', () => {
    const src = `
      test('runs the real CLI', () => {
        spawnSync('node', ['scripts/validate.mjs'], { timeout: 120_000 });
      }, 150_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('documents the legacy bound: implicit-parent spawnSync sites are not inferred', () => {
    const src = `
      it('runs the real CLI', () => {
        spawnSync('node', ['scripts/validate.mjs'], { timeout: 120_000 });
      });
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });
});

describe('child idle-window guard (WI-10004030 — the WI-10004029 gate-red class)', () => {
  // The exact pre-fix shape of git-stdin-sidecar-handoff.test.ts: a 300ms idle window armed
  // at spawn, so a loaded `node` boot is charged to it and a correct test is idle-killed.
  const PRE_FIX = `
    const result = await execProcess({
      command: process.execPath,
      args: ['-e', script],
      idleTimeoutMs: 300,
      timeoutMs: 3000,
    }, deps);
  `;

  it('FLAGS the pre-fix literal shape', () => {
    expect(SPAWNS_CHILD_RE.test(PRE_FIX)).toBe(true);
    expect(findChildIdleWindowBudgets(PRE_FIX)).toEqual([
      expect.objectContaining({ key: 'idleTimeoutMs', budgetMs: 300, via: 'literal', exempt: false }),
    ]);
  });

  it('ignores report cadence data in a spawning file while retaining the actual child option', () => {
    const src = [
      'const report = { workload: { idleMs: 200 } };',
      'execProcess({ command: process.execPath, idleTimeoutMs: 300 });',
    ].join('\n');
    expect(findChildIdleWindowBudgets(src)).toEqual([
      expect.objectContaining({ key: 'idleTimeoutMs', budgetMs: 300, via: 'literal', exempt: false }),
    ]);
  });

  it('RESOLVES a same-file const, so hoisting the literal into a name does not evade the floor', () => {
    const src = `const IDLE_MS = 300;\nexecProcess({ command: process.execPath, idleTimeoutMs: IDLE_MS });`;
    expect(findChildIdleWindowBudgets(src)).toEqual([
      expect.objectContaining({ budgetMs: 300, via: 'const IDLE_MS' }),
    ]);
    const shorthand = `const idleTimeoutMs = 250;\nspawn('node', [], { idleTimeoutMs });`;
    expect(findChildIdleWindowBudgets(shorthand)).toEqual([expect.objectContaining({ budgetMs: 250 })]);
  });

  it('does NOT flag the post-fix window at or above the floor', () => {
    const src = `const IDLE_MS = 1_500;\nexecProcess({ command: process.execPath, idleTimeoutMs: IDLE_MS });`;
    const [window] = findChildIdleWindowBudgets(src);
    expect(window.budgetMs).toBe(1500);
    expect(window.budgetMs).toBeGreaterThanOrEqual(IDLE_WINDOW_FLOOR_MS);
  });

  it('honours an on-site, reason-carrying exemption on the same or the preceding line only', () => {
    const preceding = `execProcess({\n  // idle-window-ok: asserts the idle kill\n  idleTimeoutMs: 120,\n});`;
    expect(findChildIdleWindowBudgets(preceding)).toEqual([expect.objectContaining({ exempt: true })]);
    const sameLine = `execProcess({ idleTimeoutMs: 120 }); // idle-window-ok: asserts the idle kill`;
    expect(findChildIdleWindowBudgets(sameLine)).toEqual([expect.objectContaining({ exempt: true })]);
    const reasonless = `execProcess({\n  // idle-window-ok:\n  idleTimeoutMs: 120,\n});`;
    expect(findChildIdleWindowBudgets(reasonless)).toEqual([expect.objectContaining({ exempt: false })]);
    const tooFar = `// idle-window-ok: asserts the idle kill\n\nexecProcess({\n  idleTimeoutMs: 120,\n});`;
    expect(findChildIdleWindowBudgets(tooFar)).toEqual([expect.objectContaining({ exempt: false })]);
  });

  it('does NOT flag a non-idle key, a progress INTERVAL, or a non-positive invalid-policy fixture', () => {
    expect(findChildIdleWindowBudgets('execProcess({ command: process.execPath, timeoutMs: 300 });')).toEqual([]);
    expect(findChildIdleWindowBudgets('execProcess({ progressIntervalMs: 300 });')).toEqual([]);
    expect(findChildIdleWindowBudgets('check({ stallWindowMs: 0 }); check({ stallWindowMs: -1 });')).toEqual([]);
    expect(IDLE_WINDOW_KEY_RE.test('progressIntervalMs')).toBe(false);
    expect(IDLE_WINDOW_KEY_RE.test('noOutputTimeoutMs')).toBe(true);
  });

  it('does NOT resolve an ambiguous or non-const binding (a documented bound, not a guess)', () => {
    const shadowed = `const IDLE_MS = 300;\nfunction f() { const IDLE_MS = 5000; }\nexecProcess({ idleTimeoutMs: IDLE_MS });`;
    expect(findChildIdleWindowBudgets(shadowed)).toEqual([]);
    expect(findChildIdleWindowBudgets(`let IDLE_MS = 300;\nexecProcess({ idleTimeoutMs: IDLE_MS });`)).toEqual([]);
  });

  it('scopes eligibility to files that spawn a child', () => {
    expect(SPAWNS_CHILD_RE.test('const pool = createPool({ idleTimeoutMs: 300 });')).toBe(false);
    expect(SPAWNS_CHILD_RE.test("spawnSync('git', ['status']);")).toBe(true);
  });

  it('keeps the floor and an EMPTY shrink-only baseline — every measured site was fixed or exempted', () => {
    expect(IDLE_WINDOW_FLOOR_MS).toBe(1000);
    expect(IDLE_WINDOW_BASELINE as Set<string>).toBeInstanceOf(Set);
    expect((IDLE_WINDOW_BASELINE as Set<string>).size).toBe(0);
  });
});
