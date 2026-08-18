/**
 * lint:tsc:papercusp-libs — the fan-out that gates the eight libs/papercusp typecheck
 * projects (WI-6841).
 *
 * Those gates existed one at a time (libs/db, packages/{file-claim, blueprint-distribution,
 * harness, harness/docs-viewer, locks}, plugins/gitnexus-bridge at a strict zero, plus
 * packages/orchestrator on a per-file baseline) and NOTHING EXECUTED ANY OF THEM: `lint:tsc`
 * resolves to packages/operator-core alone and `test:affected` is type-blind by design. The
 * wiring that gives this teeth — the post-suite leg in green-checkpoint.ts — is asserted in
 * apps/operator/lib/release/green-checkpoint-real-deps.test.ts. THIS file asserts the
 * fan-out's own decisions, which are all about refusing to look green when it is not:
 *   - discovery, so a NEW package with a typecheck script is gated the moment it lands
 *     (a hardcoded roster would reproduce the very defect, one level down);
 *   - a present-but-gating-nothing tree fails LOUDLY rather than reporting a vacuous pass;
 *   - a corrupt package.json is a failure, never a silent opt-out (WI-6056's discipline);
 *   - a non-zero run with no parseable diagnostics is INFRASTRUCTURE, never "0 errors" (WI-4721);
 *   - an OOM-killed tsc is retried then SKIPPED, never a red (EI-18667028218882894).
 *
 * The spawn seam is injected, so none of this runs a real tsc.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import {
  discover,
  GATE_COVERAGE,
  looksOom,
  main,
  selectGatedPackages,
} from '../../../scripts/lint-tsc-papercusp-libs.mjs';

const trees: string[] = [];
afterEach(() => {
  while (trees.length) rmSync(trees.pop()!, { recursive: true, force: true });
});

/** Build a fake libs/papercusp tree: { 'packages/locks': { typecheck: true }, … }. */
function makeLibsRoot(pkgs: Record<string, { typecheck?: boolean; corrupt?: boolean }>): string {
  const root = mkdtempSync(join(tmpdir(), 'libs-papercusp-fixture-'));
  trees.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'libs-papercusp-fixture' }));
  for (const [rel, spec] of Object.entries(pkgs)) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    if (spec.corrupt) {
      writeFileSync(join(dir, 'package.json'), '{ "name": "truncated-mid-wri');
      continue;
    }
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: rel.replace(/\//g, '-'), scripts: spec.typecheck ? { typecheck: 'tsc --noEmit' } : {} }),
    );
  }
  return root;
}

/** Collects everything the script printed, so assertions read against real operator output. */
function makeSink() {
  const out: string[] = [];
  const err: string[] = [];
  const warns: string[] = [];
  return {
    out,
    err,
    warns,
    io: {
      log: (m: string) => out.push(String(m)),
      error: (m: string) => err.push(String(m)),
      warn: (m: string) => warns.push(String(m)),
    },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

const PASS = { status: 0, stdout: '', stderr: '', signal: null };

describe('discovery — a new gated package must not have to be remembered', () => {
  it('finds every package declaring a typecheck script, at any nesting depth', () => {
    const root = makeLibsRoot({
      'libs/db': { typecheck: true },
      'packages/locks': { typecheck: true },
      // The real tree nests one level deeper here — a fixed relative path to a sibling
      // script is exactly what made this package silently fail to run once.
      'packages/harness/docs-viewer': { typecheck: true },
    });
    const found = discover(root, 0, root).map((p: { rel: string }) => p.rel).sort();
    expect(found).toEqual(['libs/db', 'packages/harness/docs-viewer', 'packages/locks']);
  });

  it('ignores packages with no typecheck script, and never descends into node_modules/_retired', () => {
    const root = makeLibsRoot({
      'packages/locks': { typecheck: true },
      'packages/cli': { typecheck: false }, // deliberately has a tsconfig but no script
      'node_modules/some-dep': { typecheck: true },
      '_retired/old-thing': { typecheck: true },
    });
    const found = discover(root, 0, root).map((p: { rel: string }) => p.rel);
    expect(found).toEqual(['packages/locks']);
  });
});

describe('refusing to look green when nothing was checked', () => {
  it('a tree with NO libs/papercusp is a legitimate opt-out, not a failure', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-libs-'));
    trees.push(empty);
    const sink = makeSink();
    // No package.json at the root at all → the submodule is simply not in this tree.
    expect(main({ libsRoot: join(empty, 'libs', 'papercusp'), spawn: () => PASS, ...sink.io })).toBe(0);
    expect(sink.stdout()).toContain('not present in this tree');
  });

  it('libs/papercusp PRESENT but gating NOTHING warns loudly — and does NOT red the release gate', () => {
    // Two failure modes to keep apart, and the balance here is deliberate:
    //  · reporting a silent green over an empty set (the silent-un-gating class) — forbidden;
    //  · reddening `main` for the whole fleet because the SUBMODULE PIN predates the scripts
    //    ("a condition no commit caused") — also forbidden, and strictly worse.
    // The live papercup-checkpoint tree (pinned Jul 2) really does declare zero of them, so
    // this is not hypothetical. Warn, never claim a pass, never hold the release.
    const root = makeLibsRoot({ 'packages/locks': { typecheck: false } });
    const sink = makeSink();
    expect(main({ libsRoot: root, relativeTo: root, spawn: () => PASS, ...sink.io })).toBe(0);
    expect(sink.warns.join('\n')).toContain('gated NOTHING');
    expect(sink.warns.join('\n')).toContain('NOT evidence that libs/papercusp typechecks');
    // Must NOT be reported as packages passing — that is the vacuous green.
    expect(sink.stdout()).not.toContain('passed,');
  });

  // THE anti-silent-un-gating guard, deliberately sited HERE rather than in the script: a
  // removal reds this TEST at development time, where it costs the author a fix — instead of
  // reddening the release gate, where it would hold `main` for the whole fleet. This is what
  // makes the script's zero-package WARN safe rather than a loophole.
  it('the REAL libs/papercusp still declares the typecheck scripts this gate exists to run', () => {
    const realLibsRoot = join(__dirname, '..', '..', '..', 'libs', 'papercusp');
    if (!existsSync(join(realLibsRoot, 'package.json'))) return; // subject hive / uninit submodule

    const found = discover(realLibsRoot, 0, realLibsRoot).map((p: { rel: string }) => p.rel);
    // The eight that earned a gate one at a time (EI-19302566985147894 /
    // EI-19305781578043773 / WI-6826). Named individually so a removal says WHICH.
    for (const expected of [
      'libs/db',
      'packages/blueprint-distribution',
      'packages/file-claim',
      'packages/harness',
      'packages/harness/docs-viewer',
      'packages/locks',
      'packages/orchestrator',
      'plugins/gitnexus-bridge',
    ]) {
      expect(found, `${expected} lost its typecheck script — this gate stopped covering it`).toContain(expected);
    }
  });

  it('a corrupt package.json is a failure, never a silent opt-out (WI-6056)', () => {
    const root = makeLibsRoot({ 'packages/locks': { typecheck: true }, 'packages/broken': { corrupt: true } });
    const sink = makeSink();
    expect(main({ libsRoot: root, relativeTo: root, spawn: () => PASS, ...sink.io })).toBe(1);
    expect(sink.stderr()).toContain('packages/broken');
    expect(sink.stderr()).toContain('could not be parsed');
  });
});

describe('aggregation across the fan-out', () => {
  it('every package passing → exit 0, with each package accounted for', () => {
    const root = makeLibsRoot({ 'libs/db': { typecheck: true }, 'packages/locks': { typecheck: true } });
    const sink = makeSink();
    expect(main({ libsRoot: root, relativeTo: root, spawn: () => PASS, ...sink.io })).toBe(0);
    expect(sink.stdout()).toContain('2 passed, 0 failed');
  });

  it('ONE package regressing reds the whole fan-out and NAMES it', () => {
    const root = makeLibsRoot({ 'libs/db': { typecheck: true }, 'packages/locks': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      libsRoot: root,
      relativeTo: root,
      spawn: (pkg: { rel: string }) =>
        pkg.rel === 'packages/locks'
          ? { status: 1, stdout: 'src/claim.ts(12,3): error TS2322: Type mismatch', stderr: '', signal: null }
          : PASS,
      ...sink.io,
    });
    expect(code).toBe(1);
    // Naming the package is the point: "typecheck failed" across 8 projects costs the
    // reader the diagnosis the gate exists to hand them.
    expect(sink.stderr()).toContain('packages/locks');
    expect(sink.stderr()).toContain('error TS2322');
    expect(sink.stdout()).toContain('1 passed, 1 failed');
  });

  it('a non-zero run with ZERO parseable diagnostics is labelled INFRASTRUCTURE, not "0 errors" (WI-4721)', () => {
    // Reading a crashed tsc as a clean zero is what once ratcheted a watermark 170→0.
    const root = makeLibsRoot({ 'packages/locks': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      libsRoot: root,
      relativeTo: root,
      spawn: () => ({ status: 2, stdout: '', stderr: 'error TS5057: Cannot find a tsconfig.json', signal: null }),
      ...sink.io,
    });
    expect(code).toBe(1);
    // TS5057 IS an `error TS` line, so this one is correctly NOT infrastructure-flagged.
    expect(sink.stderr()).not.toContain('INFRASTRUCTURE');

    const sink2 = makeSink();
    expect(
      main({
        libsRoot: root,
        relativeTo: root,
        spawn: () => ({ status: 1, stdout: '', stderr: 'Segmentation fault', signal: null }),
        ...sink2.io,
      }),
    ).toBe(1);
    expect(sink2.stderr()).toContain('INFRASTRUCTURE');
  });
});

describe('OOM under fleet load is an infrastructure condition, not a verdict', () => {
  it('detects the shapes an OOM-killed tsc actually takes', () => {
    expect(looksOom({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' })).toBe(true);
    expect(looksOom({ status: 134, signal: null, stdout: '', stderr: '' })).toBe(true);
    expect(looksOom({ status: 1, signal: null, stdout: '', stderr: 'FATAL ERROR: JavaScript heap out of memory' })).toBe(true);
    // A genuine type error must never be mistaken for an OOM — that would skip a real red.
    expect(looksOom({ status: 1, signal: null, stdout: 'src/a.ts(1,1): error TS2322: x', stderr: '' })).toBe(false);
  });

  it('retries once, and a retry that SUCCEEDS counts as a pass', () => {
    const root = makeLibsRoot({ 'packages/locks': { typecheck: true } });
    const sink = makeSink();
    let calls = 0;
    const code = main({
      libsRoot: root,
      relativeTo: root,
      spawn: () => (++calls === 1 ? { status: 137, signal: 'SIGKILL', stdout: '', stderr: '' } : PASS),
      ...sink.io,
    });
    expect(calls).toBe(2);
    expect(code).toBe(0);
    expect(sink.warns.join('\n')).toContain('retrying once');
  });

  it('a SECOND OOM skips the package loudly rather than reddening the release gate', () => {
    // A red here would hold `main` for the whole fleet over a load condition no commit
    // caused — but the skip must be loud, because that package is NOT verified this run.
    const root = makeLibsRoot({ 'packages/locks': { typecheck: true } });
    const sink = makeSink();
    let calls = 0;
    const code = main({
      libsRoot: root,
      relativeTo: root,
      spawn: () => {
        calls++;
        return { status: 137, signal: 'SIGKILL', stdout: '', stderr: '' };
      },
      ...sink.io,
    });
    expect(calls).toBe(2); // retried exactly once, not indefinitely
    expect(code).toBe(0);
    expect(sink.warns.join('\n')).toContain('NOT verified this run');
    expect(sink.stdout()).toContain('1 skipped (OOM)');
  });
});

/** The `  · <rel>` lines main() prints for the GATED set. */
function gatedRelsFromReport(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((l) => /^ {2}· /.test(l))
    .map((l) => l.replace(/^ {2}· /, '').trim());
}

// EI-19462776655300160. GATE_COVERAGE is what the sibling-gate resolver in
// scripts/lib/tsc-baseline-gate.mjs reads to route an agent to this leg. A second derivation of
// the gated set would drift, and it would drift in the DANGEROUS direction: an over-claimed prefix
// routes someone to a gate that does not in fact check their file. One shared
// selectGatedPackages() is what makes the declaration and the run one fact.
describe('GATE_COVERAGE cannot drift from what the leg runs (EI-19462776655300160)', () => {
  it('main() reports EXACTLY the set selectGatedPackages() returns — no second derivation', () => {
    const root = makeLibsRoot({
      'packages/locks': { typecheck: true },
      'packages/no-typecheck': {},
      'libs/db': { typecheck: true },
    });
    const sink = makeSink();

    main({ libsRoot: root, relativeTo: root, listOnly: true, spawn: () => PASS, ...sink.io });
    const selected = selectGatedPackages({ libsRoot: root, relativeTo: root });

    expect(gatedRelsFromReport(sink.stdout())).toEqual(selected.packages.map((p) => p.rel));
    expect(selected.packages.map((p) => p.rel)).toEqual(['libs/db', 'packages/locks']);
    // A package that declares no typecheck script is in NEITHER — never routed here.
    expect(gatedRelsFromReport(sink.stdout())).not.toContain('packages/no-typecheck');
  });

  it('an ABSENT submodule declares NO coverage rather than claiming a set it cannot check', () => {
    // The legitimate opt-out (a subject hive, an uninitialised checkout). Claiming coverage here
    // would route an agent to a leg that runs nothing at all.
    const empty = mkdtempSync(join(tmpdir(), 'libs-papercusp-absent-'));
    trees.push(empty);
    const selected = selectGatedPackages({ libsRoot: join(empty, 'nope'), relativeTo: empty });
    expect(selected.present).toBe(false);
    expect(selected.packages).toEqual([]);
  });

  it('GATE_COVERAGE() on the REAL tree equals the gated set --list reports', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    if (!existsSync(join(repoRoot, 'libs', 'papercusp', 'package.json'))) return;

    const sink = makeSink();
    main({ listOnly: true, spawn: () => PASS, ...sink.io });

    const reported = gatedRelsFromReport(sink.stdout());
    expect(reported.length).toBeGreaterThan(1);
    expect(GATE_COVERAGE()).toEqual(reported.map((rel) => `${rel}/`));
    for (const p of GATE_COVERAGE()) expect(p.endsWith('/')).toBe(true);
  });
});

/**
 * WI-39727 — `--files=` was accepted and COMPLETELY IGNORED, and the run emitted no completion
 * marker at all. Both defects pointed the same way: a caller who scoped to their own edit got a
 * whole-project pass, and neither of the two signals available to them could say otherwise.
 * The filed repro — `--files=packages/not-a-real-workspace/src/synthetic.ts` — typechecked all
 * eight packages, printed "8 passed, 0 failed" and exited 0.
 *
 * `argv` is passed explicitly in every test here rather than left to `process.argv`, so these
 * assertions describe the flag and not whatever the test runner was invoked with.
 */
describe('--files= is a verdict scope, and the run says what it measured (WI-39727)', () => {
  /** Records which packages were actually compiled, so "it ran only mine" is measurable. */
  function makeSpawnSpy() {
    const ran: string[] = [];
    return { ran, spawn: (pkg: { rel: string }) => (ran.push(pkg.rel), PASS) };
  }

  const twoPackages = () => makeLibsRoot({
    'packages/locks': { typecheck: true },
    'libs/db': { typecheck: true },
  });

  it('runs ONLY the package owning the named file — not the whole fan-out', () => {
    const root = twoPackages();
    const sink = makeSink();
    const spy = makeSpawnSpy();

    const code = main({
      libsRoot: root,
      relativeTo: root,
      argv: ['node', 'lint-tsc-papercusp-libs.mjs', '--files=packages/locks/src/path-normalize.ts'],
      spawn: spy.spawn,
      ...sink.io,
    });

    expect(code).toBe(0);
    expect(spy.ran, 'the scope was dropped and the whole fan-out ran').toEqual(['packages/locks']);
    expect(sink.stdout()).toContain('LINT_TSC_RESULT label=papercusp-libs scope=files exit=0 status=clean');
  });

  it('REFUSES to pass when every named file is outside its coverage — the filed repro', () => {
    // The defect: this returned 0 after typechecking all eight packages, so a whole-project
    // green stood in for files this gate never looked at. It has no verdict to give here.
    const root = twoPackages();
    const sink = makeSink();
    const spy = makeSpawnSpy();

    const code = main({
      libsRoot: root,
      relativeTo: root,
      argv: ['node', 'x.mjs', '--files=packages/not-a-real-workspace/src/synthetic.ts'],
      spawn: spy.spawn,
      ...sink.io,
    });

    expect(code, 'an out-of-scope scoped run must not report success').toBe(1);
    expect(spy.ran, 'it compiled something despite every named file being out of scope').toEqual([]);
    expect(sink.stderr()).toContain('checked NOTHING');
    expect(sink.stdout()).toContain('status=out-of-scope');
    expect(sink.stdout()).toContain('filesUnchecked=1');
  });

  it('reports PARTIAL when only some named files are covered', () => {
    const root = twoPackages();
    const sink = makeSink();
    const spy = makeSpawnSpy();

    const code = main({
      libsRoot: root,
      relativeTo: root,
      argv: ['node', 'x.mjs', '--files=packages/locks/src/a.ts,packages/elsewhere/b.ts'],
      spawn: spy.spawn,
      ...sink.io,
    });

    // Exit stays 0 on purpose: the covered file really was judged, and making the mixed case
    // fatal would red the legitimate "check my edit" run. The TOKEN is what changes.
    expect(code).toBe(0);
    expect(spy.ran).toEqual(['packages/locks']);
    expect(sink.stdout()).toContain('status=partial');
    expect(sink.stdout()).toContain('filesUnchecked=1');
    expect(sink.warns.join('\n')).toContain('NOT typechecked');
  });

  it('never lets a `grep status=clean` match a run that left files unchecked', () => {
    // EARNED CONTROL: the first draft of this fix printed the literal token inside the warning
    // prose that EXPLAINS the partial result ("...so a `grep status=clean` cannot match..."),
    // which made a substring grep over the gate's output hit on exactly the run the token is
    // designed to exclude. The marker was correct and the run was still misreadable. The
    // established consumer idiom greps the whole output, so that is what this asserts.
    const root = twoPackages();

    for (const argv of [
      ['node', 'x.mjs', '--files=packages/locks/src/a.ts,packages/elsewhere/b.ts'], // partial
      ['node', 'x.mjs', '--files=packages/elsewhere/b.ts'], // out-of-scope
    ]) {
      const sink = makeSink();
      main({ libsRoot: root, relativeTo: root, argv, spawn: () => PASS, ...sink.io });
      const whole = [sink.stdout(), sink.stderr(), sink.warns.join('\n')].join('\n');
      expect(whole, `a partial/out-of-scope run matched status=clean for argv ${argv[2]}`).not.toContain(
        'status=clean',
      );
    }
  });

  it('with NO --files it still fans out over everything and marks the run scope=all', () => {
    // The release gate calls this leg with no flags (runPostSuiteLegs in green-checkpoint.ts).
    // That path must be untouched by the scoping work — only the marker is added.
    const root = twoPackages();
    const sink = makeSink();
    const spy = makeSpawnSpy();

    const code = main({
      libsRoot: root,
      relativeTo: root,
      argv: ['node', 'lint-tsc-papercusp-libs.mjs'],
      spawn: spy.spawn,
      ...sink.io,
    });

    expect(code).toBe(0);
    expect(spy.ran.sort()).toEqual(['libs/db', 'packages/locks']);
    expect(sink.stdout()).toContain('LINT_TSC_RESULT label=papercusp-libs scope=all exit=0 status=clean');
  });

  it('emits NO marker on the branches that measure nothing — absent means UNMEASURED', () => {
    // The marker's contract is "absent => the run did not finish; the output is UNMEASURED,
    // not clean". `--list` runs nothing, and a present-but-gating-nothing tree compiles
    // nothing, so stamping either would claim a coverage that did not happen — the same false
    // green this item is about, arriving through the fix for it.
    const listSink = makeSink();
    main({
      libsRoot: twoPackages(),
      relativeTo: '/',
      argv: ['node', 'x.mjs', '--list'],
      listOnly: true,
      spawn: () => PASS,
      ...listSink.io,
    });
    expect(listSink.stdout()).not.toContain('LINT_TSC_RESULT');

    const bareRoot = makeLibsRoot({ 'packages/locks': { typecheck: false } });
    const bareSink = makeSink();
    main({ libsRoot: bareRoot, relativeTo: bareRoot, argv: ['node', 'x.mjs'], spawn: () => PASS, ...bareSink.io });
    expect(bareSink.stdout()).not.toContain('LINT_TSC_RESULT');
    expect(bareSink.warns.join('\n')).toContain('gated NOTHING');
  });
});
