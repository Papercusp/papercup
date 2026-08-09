/**
 * check-lint-guard-reachability.test.ts — EI-19452618085391226.
 *
 * This suite is deliberately in TWO halves, because a guard-checker can fail in two
 * unrelated ways and only one of them is catchable with fixtures:
 *
 *   1. PURE LOGIC, with a permanent WRONG-IMPLEMENTATION control. The controls are the
 *      point: a classifier that credits any mention as enforcement is the exact mistake
 *      the first draft of this checker made, so it stays in the file forever as a case
 *      the real implementation must beat. A calibration case pins that the real logic
 *      still passes, so the controls cannot go green by the property itself breaking.
 *
 *   2. A REAL-TREE assertion that EXECUTES the checker over this repository. Without
 *      it, this file would be exactly what it exists to detect — a logic-only test that
 *      makes an unenforced guard look covered — and `check-lint-guard-reachability.mjs`
 *      would correctly flag ITSELF. That self-consistency is intentional.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReachabilityCensus,
  classifyGuard,
  resolveImplementationPaths,
  selectGuardScripts,
  ACKNOWLEDGED_UNREACHABLE,
  UNREACHABLE_HIGH_WATERMARK,
  ENFORCING_TEST_RE,
  stripComments,
  computeCoverage,
  deriveScanScope,
  workspaceOfPath,
  parseRepoWideRegistrations,
  parseRepoWideRegistrationPairs,
  findInertRepoWideRegistrations,
  ACKNOWLEDGED_PARTIAL_COVERAGE,
  PARTIAL_COVERAGE_HIGH_WATERMARK,
  // @ts-expect-error — untyped .mjs guard script, imported for its pure helpers.
} from '../../../../scripts/check-lint-guard-reachability.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = 'scripts/check-lint-guard-reachability.mjs';

/** No corpus mentions anything unless a test says so. */
const corpora = (over: Partial<Record<string, string>> = {}) => ({
  gate: '',
  ci: '',
  test: '',
  hook: '',
  'logic-test': '',
  ...over,
});

describe('selectGuardScripts', () => {
  it('collapses companion invocations onto their base guard', () => {
    // Enforcement is a property of the IMPLEMENTATION, not of how many npm aliases
    // point at it — counting `lint:x` and `lint:x:strict` separately double-counts.
    const picked = selectGuardScripts({
      'lint:x': 'node scripts/x.mjs',
      'lint:x:strict': 'node scripts/x.mjs --strict',
      'lint:x:fix': 'node scripts/x.mjs --fix',
      'lint:x:update': 'node scripts/x.mjs --update',
      'test:affected': 'node scripts/affected.mjs',
    });
    expect(picked).toEqual(['lint:x']);
  });
});

describe('resolveImplementationPaths', () => {
  it('resolves the implementation file across node/tsx/npx invocation forms', () => {
    expect(resolveImplementationPaths('node scripts/check-a.mjs')).toEqual(['scripts/check-a.mjs']);
    expect(resolveImplementationPaths('tsx scripts/check-b.mjs --strict')).toEqual(['scripts/check-b.mjs']);
    expect(resolveImplementationPaths('node apps/operator/scripts/check-c.mjs')).toEqual([
      'apps/operator/scripts/check-c.mjs',
    ]);
  });

  it('returns nothing for a guard with no script file, so it is matched by name alone', () => {
    // `knip --no-config-hints` has no implementation path of ours to search for.
    expect(resolveImplementationPaths('knip --no-config-hints')).toEqual([]);
  });
});

describe('classifyGuard — a mention is not enforcement', () => {
  const scripts = { 'lint:x': 'node scripts/check-x.mjs' };

  it('credits a guard the release gate runs', () => {
    const r = classifyGuard({ name: 'lint:x', command: scripts['lint:x'], corpora: corpora({ gate: "'lint:x'" }) });
    expect(r.blocking).toBe(true);
    expect(r.tier).toBe('gate');
  });

  it('finds a guard invoked by direct PATH rather than npm name', () => {
    // The under-claim this checker exists to avoid: several guards run from hooks by
    // script path and never by npm name, so searching for the name alone reports a
    // false UNREACHABLE and sends someone to wire an already-covered guard.
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({ hook: 'node scripts/check-x.mjs' }),
    });
    expect(r.tiers).toContain('hook');
  });

  it('does NOT count a logic-only unit test as enforcement (the motivating case)', () => {
    // `lint:mock-cast-escape` had a fully green unit test of its helpers throughout the
    // window its real-tree count drifted +45 past baseline. Green detector, rotting guard.
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({ 'logic-test': "import { decide } from 'scripts/check-x.mjs'" }),
    });
    expect(r.blocking).toBe(false);
    expect(r.tier).toBe('logic-test');
  });

  it('does NOT count a hook as enforcement — it nudges one agent and blocks nothing', () => {
    const r = classifyGuard({ name: 'lint:x', command: scripts['lint:x'], corpora: corpora({ hook: 'scripts/check-x.mjs' }) });
    expect(r.blocking).toBe(false);
  });
});

describe('ENFORCING_TEST_RE — the discriminator', () => {
  it('separates a real-tree execution from a fixture-driven unit test', () => {
    expect(ENFORCING_TEST_RE.test("execFileSync('node', [SCRIPT])")).toBe(true);
    expect(ENFORCING_TEST_RE.test('listTrackedFiles(REPO_ROOT)')).toBe(true);
    // A pure-helper test: imports the detector, feeds it a string, asserts. Enforces nothing.
    expect(ENFORCING_TEST_RE.test("expect(findEscapes('x as never')).toHaveLength(1)")).toBe(false);
  });
});

describe('stripComments — prose about a guard is not a runner of it', () => {
  it('drops a comment block that merely NAMES a guard', () => {
    // This fired for real: the green-checkpoint leg added for this very check carries a
    // comment naming `lint:mock-cast-escape` as its motivating example, and that one
    // sentence reclassified the rotting guard from `logic-test` to `gate` — the checker
    // declaring its own motivating case enforced.
    const src = ['// EI-123: lint:mock-cast-escape drifted +45 past baseline.', "const x = 1;"].join('\n');
    expect(stripComments(src)).not.toContain('lint:mock-cast-escape');
    expect(stripComments(src)).toContain('const x = 1;');
  });

  it('drops JSDoc continuation lines, not just `//`', () => {
    const src = ['/**', ' * lint:some-guard is the example here.', ' */', "run('lint:real-guard');"].join('\n');
    expect(stripComments(src)).not.toContain('lint:some-guard');
    expect(stripComments(src)).toContain('lint:real-guard');
  });

  it('PRESERVES a real invocation on a code line (the regression that ate a wired guard)', () => {
    // `lint:plane-adoption` is wired at green-checkpoint.ts:5094 as a plain array entry.
    // A block-comment regex (`/\*[\s\S]*?\*\//`) removed that line outright, reporting a
    // properly-gated guard as unenforced — an unbalanced `/*` inside any string or regex
    // earlier in a 5000-line file lets the match run for thousands of lines.
    const src = "      { script: 'lint:plane-adoption', label: 'ADOPTION PROBE' },";
    expect(stripComments(src)).toContain('lint:plane-adoption');
  });

  it('keeps string literals, since a real invocation lives inside one', () => {
    expect(stripComments("exec('npm', ['run', 'lint:x'])")).toContain('lint:x');
  });

  it('strips YAML comments without touching a workflow run: line', () => {
    const src = ['# lint:documented-only is discussed here', '  - run: npm run lint:actually-run'].join('\n');
    const out = stripComments(src, { yaml: true });
    expect(out).not.toContain('lint:documented-only');
    expect(out).toContain('lint:actually-run');
  });
});

describe('buildReachabilityCensus', () => {
  it('reports a guard that nothing runs at all', () => {
    const c = buildReachabilityCensus({ scripts: { 'lint:orphan': 'node scripts/check-orphan.mjs' }, corpora: corpora() });
    expect(c.unreachable.map((r: { name: string }) => r.name)).toEqual(['lint:orphan']);
    expect(c.notEnforced).toHaveLength(1);
  });

  it('surfaces a NEW guard as debt without anyone listing it', () => {
    // The anti-drift property: the population comes from the scan, so a guard added
    // today cannot avoid the census by not being mentioned here.
    const c = buildReachabilityCensus({
      scripts: { 'lint:brand-new': 'node scripts/check-brand-new.mjs' },
      corpora: corpora(),
      acknowledged: new Map(),
    });
    expect(c.unacknowledged.map((r: { name: string }) => r.name)).toEqual(['lint:brand-new']);
  });

  it('does not fail a guard whose unenforcement is acknowledged', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:known': 'node scripts/check-known.mjs' },
      corpora: corpora(),
      acknowledged: new Map([['lint:known', 'pending decision']]),
    });
    expect(c.unacknowledged).toHaveLength(0);
    expect(c.notEnforced).toHaveLength(1); // acknowledged is not enforced
  });

  it('catches an allowlist entry for a guard that no longer exists', () => {
    // A stale entry keeps asserting a pending decision about nothing — and silently
    // consumes watermark budget that a real guard would otherwise have to justify.
    const c = buildReachabilityCensus({
      scripts: { 'lint:live': 'node scripts/check-live.mjs' },
      corpora: corpora({ gate: "'lint:live'" }),
      acknowledged: new Map([['lint:deleted-last-month', 'pending decision']]),
    });
    expect(c.staleAcknowledgements).toEqual(['lint:deleted-last-month']);
  });

  it('propagates reachability through an npm-run chain', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:agg': 'npm run lint:leaf', 'lint:leaf': 'node scripts/check-leaf.mjs' },
      corpora: corpora({ gate: "'lint:agg'" }),
    });
    expect(c.notEnforced).toHaveLength(0);
  });

  /* ── permanent WRONG-IMPLEMENTATION controls ───────────────────────────────
   * These stay in the file forever. Each encodes a classifier that looks right and
   * is wrong in a way that already happened; the assertions state what that mistake
   * costs. Without them, every test above also passes on a checker that credits any
   * mention at all as enforcement. */

  it('CONTROL: a classifier that credits ANY mention misses the rotting guard', () => {
    const creditsAnyMention = (corp: Record<string, string>, impl: string) =>
      Object.values(corp).some((t) => t.includes(impl));

    const logicOnly = corpora({ 'logic-test': "import { decide } from 'scripts/check-x.mjs'" });

    // The wrong implementation calls this guard covered …
    expect(creditsAnyMention(logicOnly, 'scripts/check-x.mjs')).toBe(true);
    // … while the real one correctly reports it as not enforced. That gap is the bug.
    const real = classifyGuard({ name: 'lint:x', command: 'node scripts/check-x.mjs', corpora: logicOnly });
    expect(real.blocking).toBe(false);
  });

  it('CALIBRATION: the real classifier still credits genuine enforcement', () => {
    // Guards the controls above: if the real implementation ever stopped crediting
    // ANYTHING, every control would pass for the wrong reason.
    const gated = classifyGuard({ name: 'lint:x', command: 'node scripts/check-x.mjs', corpora: corpora({ gate: "'lint:x'" }) });
    expect(gated.blocking).toBe(true);
  });
});

/* ── COVERAGE: enforced ≠ enforced EVERYWHERE (EI-19461064447747454) ──────────── */

describe('workspaceOfPath', () => {
  const dirs = ['apps/operator', 'packages/operator-core', 'libs/papercusp/packages/harness'];

  it('attributes a file to its workspace', () => {
    expect(workspaceOfPath('packages/operator-core/lib/x.ts', dirs)).toBe('packages/operator-core');
  });

  it('prefers the LONGEST matching prefix, so a nested workspace wins over its parent', () => {
    // `libs/papercusp` is not itself a workspace here; the nested one must win rather
    // than the first entry that happens to match.
    expect(workspaceOfPath('libs/papercusp/packages/harness/src/a.ts', [...dirs, 'libs'])).toBe(
      'libs/papercusp/packages/harness',
    );
  });

  it('returns null for a path in no workspace, rather than guessing one', () => {
    expect(workspaceOfPath('scripts/check-x.mjs', dirs)).toBeNull();
  });

  it('does not treat a name-prefix collision as containment', () => {
    // `apps/operator-vite/...` must NOT be attributed to `apps/operator`.
    expect(workspaceOfPath('apps/operator-vite/src/a.ts', dirs)).toBeNull();
  });
});

describe('deriveScanScope', () => {
  it('reads a declared bounded root array', () => {
    const s = deriveScanScope("const SOURCE_ROOTS = ['apps/operator/lib', 'packages/agent-mcp/src'];");
    expect(s.kind).toBe('bounded');
    expect(s.roots).toEqual(['apps/operator/lib', 'packages/agent-mcp/src']);
  });

  it('detects a repo-wide enumeration via listTrackedFiles', () => {
    expect(deriveScanScope('const { files } = listTrackedFiles(ROOT);').kind).toBe('repo-wide');
  });

  it("detects the git ARGV form, where the literal is 'ls-files' and never 'git ls-files'", () => {
    // The regression this pins: matching the prose form `git ls-files` reported two
    // genuinely repo-wide guards as having no detectable scan at all.
    expect(deriveScanScope("execFileSync('git', ['ls-files', '*.test.ts'])").kind).toBe('repo-wide');
  });

  it('prefers bounded roots over a repo-wide call, because the roots FILTER it', () => {
    const s = deriveScanScope(
      "const SCAN_ROOTS = ['apps/operator/lib'];\nconst all = listTrackedFiles(ROOT);",
    );
    expect(s.kind).toBe('bounded');
  });

  it('classifies a diff-driven guard, which has no directory scope at all', () => {
    expect(deriveScanScope("const filesArg = argv.find((a) => a.startsWith('--files='));").kind).toBe('diff-driven');
  });

  it('says undetermined rather than inventing a scope', () => {
    expect(deriveScanScope('const port = 3170;').kind).toBe('undetermined');
  });
});

describe('parseRepoWideRegistrations', () => {
  const src = [
    'const REPO_WIDE_INVARIANT_GUARDS = [',
    "  { workspace: '@papercusp/operator-core', script: 'lint:chunk-safe' },",
    "  { workspace: '@papercusp/operator-core', script: 'lint:partial-index-alignment' },",
    '];',
    "const other = { script: 'lint:not-registered' };",
  ].join('\n');

  it('parses the registered guards', () => {
    expect([...parseRepoWideRegistrations(src)]).toEqual(['lint:chunk-safe', 'lint:partial-index-alignment']);
  });

  it('stops at the array literal, so an unrelated `script:` is not over-credited', () => {
    // Over-crediting here would silently mark a partially-covered guard as full — the
    // same false-green this whole axis exists to remove.
    expect(parseRepoWideRegistrations(src).has('lint:not-registered')).toBe(false);
  });

  it('returns an empty set when the block is absent, never a crash', () => {
    expect(parseRepoWideRegistrations('const x = 1;').size).toBe(0);
  });
});

describe('INERT registrations — registering a guard is a CLAIM, declaring the script is the fact (WI-37454)', () => {
  // MEASURED: `lint:drop-database-force` was registered in REPO_WIDE_INVARIANT_GUARDS but
  // never declared by @papercusp/operator-core, so affected-tests.mjs:815 skipped it
  // silently — it ran on NO path — while coverageOf credited it `full` for being present in
  // the registry. The reporting surface hid the absence it existed to report.
  const src = [
    'const REPO_WIDE_INVARIANT_GUARDS = [',
    '  {',
    '    // a prose mention of script: lint:commented-out must not be parsed',
    "    workspace: '@papercusp/operator-core',",
    "    script: 'lint:declared-one',",
    '    appliesTo: () => true,',
    '  },',
    '  {',
    "    workspace: '@papercusp/operator-core',",
    "    script: 'lint:undeclared-one',",
    '  },',
    '];',
  ].join('\n');

  it('keeps the workspace of each registration, not just the script name', () => {
    expect(parseRepoWideRegistrationPairs(src)).toEqual([
      { workspace: '@papercusp/operator-core', script: 'lint:declared-one' },
      { workspace: '@papercusp/operator-core', script: 'lint:undeclared-one' },
    ]);
  });

  it('does not parse a script named only inside a comment', () => {
    // Annotated because the SUT is an untyped .mjs import, so its return is `any` and an
    // unannotated callback parameter trips noImplicitAny (TS7006) in this workspace.
    const pairs = parseRepoWideRegistrationPairs(src) as { workspace: string; script: string }[];
    expect(pairs.some((p) => p.script === 'lint:commented-out')).toBe(false);
  });

  const scriptsByWorkspaceName = new Map([['@papercusp/operator-core', new Set(['lint:declared-one'])]]);

  it('flags ONLY the registration whose workspace does not declare the script', () => {
    const inert = findInertRepoWideRegistrations({
      pairs: parseRepoWideRegistrationPairs(src),
      scriptsByWorkspaceName,
    });
    expect(inert).toEqual([{ workspace: '@papercusp/operator-core', script: 'lint:undeclared-one' }]);
  });

  it('CONTROL — an implementation that credits mere registration reports nothing, and is wrong', () => {
    // The permanent wrong-implementation control this file's header prescribes: this is
    // exactly what the checker did before WI-37454, and it must stay red-able forever.
    const creditAnyRegistration = () => [];
    expect(creditAnyRegistration()).toHaveLength(0);
    expect(
      findInertRepoWideRegistrations({ pairs: parseRepoWideRegistrationPairs(src), scriptsByWorkspaceName }),
    ).not.toHaveLength(0);
  });

  it('FAILS OPEN for a workspace absent from the map, rather than inventing a violation', () => {
    // An unreadable/unparseable package.json must not red-pin the fleet gate on a file the
    // checker could not read — the same stance as the unreadable-registration-source branch.
    expect(
      findInertRepoWideRegistrations({
        pairs: parseRepoWideRegistrationPairs(src),
        scriptsByWorkspaceName: new Map(),
      }),
    ).toEqual([]);
  });

  it('REAL TREE — every registration in the live registry is actually declared', () => {
    // The enforcing half: a logic-only version of this axis would itself be the false green
    // this file exists to detect. Executes the checker over THIS repository.
    const out = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' });
    expect(`${out.stdout ?? ''}${out.stderr ?? ''}`).not.toMatch(/registration\(s\) are INERT/);
  });
});

describe('computeCoverage', () => {
  const dirs = ['apps/operator', 'packages/operator-core'];
  const testRow = { name: 'lint:x', tier: 'test', blocking: true, impls: ['scripts/check-x.mjs'] };

  it('credits a gate leg with full coverage — it runs unconditionally', () => {
    const c = computeCoverage({ row: { ...testRow, tier: 'gate' }, workspaceDirs: dirs });
    expect(c.verdict).toBe('full');
  });

  it('reports a repo-wide guard enforced from ONE workspace as partial (the WI-9434 shape)', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: 'listTrackedFiles(ROOT)',
    });
    expect(c.verdict).toBe('partial');
    expect(c.reason).toMatch(/packages\/operator-core/);
  });

  it('counts covered vs scanned roots for a bounded guard', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: "const SOURCE_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib'];",
    });
    expect(c.verdict).toBe('partial');
    expect(c.coveredRoots).toEqual(['packages/operator-core/lib']);
    expect(c.roots).toHaveLength(2);
  });

  it('does NOT flag a guard whose every scanned root lies inside its enforcing workspace', () => {
    // The false-positive direction. Flagging this would send someone to "fix" a guard
    // that is already fully covered.
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: "const SOURCE_ROOTS = ['packages/operator-core/lib'];",
    });
    expect(c.verdict).toBe('full');
  });

  it('treats a REPO_WIDE_INVARIANT_GUARDS registration as full coverage', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: 'listTrackedFiles(ROOT)',
      repoWideRegistered: new Set(['lint:x']),
    });
    expect(c.verdict).toBe('full');
  });

  it('reports undetermined — never full — when the scan shape is not comparable', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: 'const port = 3170;',
    });
    expect(c.verdict).toBe('undetermined');
  });

  it('does not assume a chained guard is covered by its unmeasured runner', () => {
    expect(computeCoverage({ row: { ...testRow, tier: 'chained' }, workspaceDirs: dirs }).verdict).toBe(
      'undetermined',
    );
  });

  it('says not-enforced for a guard nothing runs, rather than partial', () => {
    expect(computeCoverage({ row: { ...testRow, blocking: false }, workspaceDirs: dirs }).verdict).toBe(
      'not-enforced',
    );
  });
});

describe('buildReachabilityCensus — the coverage axis is additive', () => {
  it('computes NO coverage when the caller supplies none, rather than defaulting to full', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:x': 'node scripts/check-x.mjs' },
      corpora: corpora({ gate: "'lint:x'" }),
    });
    expect(c.rows[0].coverage).toBeUndefined();
    expect(c.partiallyCovered).toEqual([]);
  });

  it('surfaces a partially-covered guard once coverage inputs are supplied', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:x': 'node scripts/check-x.mjs' },
      corpora: corpora({ test: "execFileSync('node', ['scripts/check-x.mjs'])" }),
      coverage: {
        enforcingTests: [
          { path: 'packages/operator-core/lib/x.test.ts', text: "execFileSync('node', ['scripts/check-x.mjs'])" },
        ],
        workspaceDirs: ['packages/operator-core', 'apps/operator'],
        implSources: new Map([['scripts/check-x.mjs', 'listTrackedFiles(ROOT)']]),
        repoWideRegistered: new Set(),
      },
    });
    expect(c.partiallyCovered.map((r: { name: string }) => r.name)).toEqual(['lint:x']);
  });

  /* ── permanent WRONG-IMPLEMENTATION control ────────────────────────────────
   * The bug this axis fixes was not a crash — it was a TRUE statement read as a
   * stronger one. Without this control, every assertion above also passes on the
   * old per-guard boolean, which called the WI-9434 guard "enforced" while three of
   * its four scanned roots had no enforcement at all. */

  it('CONTROL: the per-GUARD boolean calls a partially-covered guard fully enforced', () => {
    const row = { name: 'lint:x', tier: 'test', blocking: true, impls: ['scripts/check-x.mjs'] };
    const perGuardBoolean = (r: { blocking: boolean }) => r.blocking;

    // The old model says this guard is enforced, full stop …
    expect(perGuardBoolean(row)).toBe(true);
    // … while the coverage axis names what that hides.
    const c = computeCoverage({
      row,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: ['packages/operator-core', 'apps/operator'],
      implSource: 'listTrackedFiles(ROOT)',
    });
    expect(c.verdict).toBe('partial');
  });

  it('CALIBRATION: the coverage axis still returns full for genuinely full coverage', () => {
    // Without this, the control above would also pass on an implementation that
    // reported EVERY guard as partial.
    expect(computeCoverage({ row: { name: 'lint:x', tier: 'gate', blocking: true, impls: [] } }).verdict).toBe('full');
  });
});

describe('the repository itself (real-tree assertion)', () => {
  // This block is what makes THIS guard enforced rather than merely logic-tested —
  // see the file header. It executes the real checker over the real tree.
  it('has no unenforced lint guard beyond the acknowledged, shrink-only set', () => {
    const run = () => {
      try {
        return { code: 0, out: execFileSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' }) };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    };
    const { code, out } = run();
    expect(out).not.toMatch(/STALE allowlist/);
    expect(code, `check-lint-guard-reachability failed:\n${out}`).toBe(0);
  });

  it('keeps the acknowledged set at or under its watermark', () => {
    // Shrink-only. Growing this set is how the rot would quietly return, so the
    // ceiling is asserted here as well as inside the script.
    expect(ACKNOWLEDGED_UNREACHABLE.size).toBeLessThanOrEqual(UNREACHABLE_HIGH_WATERMARK);
  });

  it('gives every acknowledged guard a non-empty reason', () => {
    for (const [name, reason] of ACKNOWLEDGED_UNREACHABLE) {
      expect(String(reason).length, `${name} needs a stated reason`).toBeGreaterThan(10);
    }
  });

  it('keeps the partial-coverage set at or under its watermark', () => {
    // Shrink-only, like its sibling. Paying one down means REGISTERING the guard in
    // REPO_WIDE_INVARIANT_GUARDS, never appending here.
    expect(ACKNOWLEDGED_PARTIAL_COVERAGE.size).toBeLessThanOrEqual(PARTIAL_COVERAGE_HIGH_WATERMARK);
  });

  it('gives every acknowledged partial-coverage guard a stated reason', () => {
    for (const [name, reason] of ACKNOWLEDGED_PARTIAL_COVERAGE) {
      expect(String(reason).length, `${name} needs a stated reason`).toBeGreaterThan(10);
    }
  });

  it('FAILS OPEN when the registration source is unreadable, instead of red-pinning the gate', () => {
    // This runs as a BLOCKING green-checkpoint leg. Coverage credits a guard as fully
    // covered when it is registered in REPO_WIDE_INVARIANT_GUARDS, so an unreadable
    // registration source would reclassify every registered guard as `partial` and fail
    // the gate for the whole fleet — on a missing file, not on a real defect.
    //
    // The subject is pointed at a COPY outside the tree: proving this by deleting the
    // real file from a shared checkout would let git-sync commit the deletion.
    const stub = path.join(os.tmpdir(), 'guard-reachability-no-registrations.mjs');
    // ⚠ The stub must not NAME the sentinel it is meant to lack. The first version of
    // this fixture was the comment "deliberately contains no REPO_WIDE_INVARIANT_GUARDS
    // block" — which CONTAINS that string, so the detector read the disclaimer as the
    // thing itself and the fail-open branch never ran. Prose about a token is
    // indistinguishable from the token to anything that greps (EI-19459777127106385).
    fs.writeFileSync(stub, '// a registration source with no guard registrations in it\n');
    // spawnSync, not execFileSync: the skip notice is a WARNING and goes to stderr, which
    // execFileSync discards on a successful run. Asserting against stdout alone would have
    // passed for the wrong reason the moment the notice moved streams.
    const r = spawnSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, LINT_GUARD_REACHABILITY_AFFECTED_TESTS: stub },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, `expected a fail-OPEN exit 0, got ${r.status}:\n${out}`).toBe(0);
    expect(out).toMatch(/coverage axis SKIPPED/);
    // …and specifically NOT a stale/partial failure, which is the fail-closed trap.
    expect(out).not.toMatch(/STALE partial-coverage/);
    expect(out).not.toMatch(/enforced over only PART/);
  });

  it('states the coverage caveat in the ordinary PASS output, not only on failure', () => {
    // The whole defect was a number quoted without its qualifier: "68/82 enforced" read
    // as "the tree is protected". The caveat has to reach the reader of the NUMBER.
    const out = execFileSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' });
    expect(out).toMatch(/enforced over only PART of what they scan/);
    expect(out).toMatch(/per-GUARD boolean, never a per-SCOPE one/);
  });
});
