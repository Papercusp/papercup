/**
 * lint:tsc:workspaces — the typecheck fan-out over the SUPERPROJECT roots (apps/*, packages/*,
 * libs/generic/*), WI-7155 / EI-19376779013716004.
 *
 * `lint:tsc` resolves to packages/operator-core alone and `test:affected` is type-blind by
 * design, so a type-only regression anywhere else in the superproject surfaced NOWHERE — the
 * WI-6841 defect, one root over. WI-6841 fixed it for the libs/papercusp submodule; this leg is
 * the same fix for what it did not cover, sharing its machinery via scripts/lib/typecheck-fanout.mjs
 * rather than reimplementing (and drifting from) it.
 *
 * The wiring that gives this teeth — the post-suite leg in green-checkpoint.ts — is asserted in
 * apps/operator/lib/release/green-checkpoint-real-deps.test.ts. THIS file asserts the fan-out's
 * own decisions, which are all about refusing to look green when it is not:
 *   - discovery, so a NEW package declaring a typecheck script is gated the moment it lands;
 *   - the INVISIBLE population (tsconfig, no typecheck script) is REPORTED, never silently
 *     counted as passing — it is unreachable by construction, which is the actual finding;
 *   - a zero-package discovery FAILS here (unlike the submodule fan-out, which warns) — these
 *     roots always contain packages, so discovering none means discovery itself broke;
 *   - every exemption carries a reason + a filed id and is printed on every run, so a temporary
 *     exclusion cannot quietly become permanent;
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
import { discover, discoverInvisible } from '../../../scripts/lib/typecheck-fanout.mjs';
// eslint-disable-next-line import/no-relative-packages
import { DEFAULT_ROOTS, EXEMPT, main } from '../../../scripts/lint-tsc-workspaces.mjs';

const trees: string[] = [];
afterEach(() => {
  while (trees.length) rmSync(trees.pop()!, { recursive: true, force: true });
});

type Spec = { typecheck?: boolean; tsconfig?: boolean; corrupt?: boolean };

/** Build a fake superproject: { 'apps/thing': { typecheck: true, tsconfig: true }, … }. */
function makeTree(pkgs: Record<string, Spec>): string {
  const root = mkdtempSync(join(tmpdir(), 'workspaces-fixture-'));
  trees.push(root);
  for (const [rel, spec] of Object.entries(pkgs)) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    if (spec.tsconfig) writeFileSync(join(dir, 'tsconfig.json'), '{}');
    if (spec.corrupt) {
      writeFileSync(join(dir, 'package.json'), '{ "name": "truncated-mid-wri');
      continue;
    }
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: rel.replace(/\//g, '-'),
        scripts: spec.typecheck ? { typecheck: 'tsc --noEmit' } : {},
      }),
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
const NO_EXEMPT = {};

describe('discovery — a new gated package must not have to be remembered', () => {
  it('finds every package declaring a typecheck script, at any nesting depth', () => {
    const root = makeTree({
      'apps/operator-public': { typecheck: true },
      'packages/omp-plugin': { typecheck: true },
      'libs/generic/papergrid/grid-core': { typecheck: true },
    });
    const found = discover(root, 0, root)
      .map((p: { rel: string }) => p.rel)
      .sort();
    expect(found).toEqual(['apps/operator-public', 'libs/generic/papergrid/grid-core', 'packages/omp-plugin']);
  });

  it('never descends into node_modules/_retired/dist', () => {
    const root = makeTree({
      'packages/real': { typecheck: true },
      'node_modules/some-dep': { typecheck: true },
      '_retired/old-thing': { typecheck: true },
      'dist/emitted': { typecheck: true },
    });
    expect(discover(root, 0, root).map((p: { rel: string }) => p.rel)).toEqual(['packages/real']);
  });
});

describe('the INVISIBLE population — absence of a gate is the finding', () => {
  // The point of the whole item. WI-6841's discovery is by OPT-IN (a package declares a
  // typecheck script), so a package that never opts in is not "passing" — it is unreachable,
  // and before this nothing anywhere said so.
  it('reports dirs that have a tsconfig but declare NO typecheck script', () => {
    const root = makeTree({
      'packages/gated': { typecheck: true, tsconfig: true },
      'packages/invisible': { typecheck: false, tsconfig: true },
      'libs/generic/also-invisible': { typecheck: false, tsconfig: true },
    });
    const found = discoverInvisible(root, 0, root)
      .map((p: { rel: string }) => p.rel)
      .sort();
    expect(found).toEqual(['libs/generic/also-invisible', 'packages/invisible']);
  });

  it('a dir with NO tsconfig is not invisible — it is simply not a tsc project', () => {
    const root = makeTree({ 'packages/plain': { typecheck: false } });
    expect(discoverInvisible(root, 0, root)).toEqual([]);
  });

  it('is REPORT-ONLY: invisible packages never fail the run, and say why they are not blocking', () => {
    // 61 packages reddening at once would red-pin the shared gate for the whole fleet — the
    // exact failure this work exists to prevent, inflicted by its own fix. Report first.
    const root = makeTree({
      'packages/gated': { typecheck: true, tsconfig: true },
      'packages/invisible-a': { typecheck: false, tsconfig: true },
      'packages/invisible-b': { typecheck: false, tsconfig: true },
    });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => PASS,
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.stdout()).toContain('2 director');
    expect(sink.stdout()).toContain('REPORT-ONLY');
    expect(sink.stdout()).toContain('NO routine gate can reach them');
  });
});

describe('refusing to look green when nothing was checked', () => {
  // The deliberate ASYMMETRY with lint-tsc-papercusp-libs.mjs, which WARNS in this situation.
  // That fan-out points at a git SUBMODULE whose pin can legitimately predate its typecheck
  // scripts, so reddening would hold `main` for the fleet on a condition no commit caused.
  // These roots are in the superproject and always contain packages — discovering none here
  // means discovery itself broke, and a broken discovery walk must never report a pass.
  it('discovering ZERO gated packages FAILS rather than reporting a vacuous green', () => {
    const root = makeTree({ 'packages/nothing': { typecheck: false } });
    const sink = makeSink();
    const code = main({ repoRoot: root, roots: ['packages'], exempt: NO_EXEMPT, spawn: () => PASS, ...sink.io });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('broken discovery walk');
    expect(sink.stdout()).not.toContain('passed,');
  });

  it('a corrupt package.json is a hard failure, never a silent opt-out', () => {
    // WI-6056's discipline: letting a partial/corrupt file shrink the gated set is how a
    // package silently stops being checked while the run still reports success.
    const root = makeTree({ 'packages/ok': { typecheck: true }, 'packages/broken': { corrupt: true } });
    const sink = makeSink();
    const code = main({ repoRoot: root, roots: ['packages'], exempt: NO_EXEMPT, spawn: () => PASS, ...sink.io });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('could not be parsed');
  });

  it('an absent root is skipped with a warning, not silently dropped', () => {
    const root = makeTree({ 'packages/ok': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages', 'libs/generic'],
      exempt: NO_EXEMPT,
      spawn: () => PASS,
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.warns.join('\n')).toContain('libs/generic does not exist');
  });
});

describe('exemptions cannot go quiet', () => {
  it('an exempt package is excluded from the gated set AND printed with its reason and filed id', () => {
    const root = makeTree({ 'packages/gated': { typecheck: true }, 'packages/skipped': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: { 'packages/skipped': { reason: 'committed-errors', detail: 'has 14 errors', filedAs: 'WI-7166' } },
      spawn: () => PASS,
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.stdout()).toContain('1 package(s) gated, 1 exempt');
    expect(sink.stdout()).toContain('⊘ packages/skipped [committed-errors]');
    expect(sink.stdout()).toContain('WI-7166');
  });

  // An exemption without a stated reason and an exit path is indistinguishable from the
  // hardcoded roster this whole design exists to avoid.
  it('every real EXEMPT entry carries a reason, a detail and a filed id', () => {
    expect(Object.keys(EXEMPT).length).toBeGreaterThan(0);
    for (const [rel, entry] of Object.entries(EXEMPT)) {
      expect(entry.reason, `${rel} reason`).toBeTruthy();
      expect(entry.detail, `${rel} detail`).toBeTruthy();
      expect(String(entry.detail).length, `${rel} detail is a real explanation`).toBeGreaterThan(40);
      expect(entry.filedAs, `${rel} filedAs`).toBeTruthy();
    }
  });

  // A stale exemption is worse than none: it reads as a live decision while excluding nothing,
  // and it hides that the package it names no longer exists or no longer declares a typecheck.
  it('every EXEMPT entry still names a real package that declares a typecheck script', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    for (const rel of Object.keys(EXEMPT)) {
      if (!existsSync(join(repoRoot, rel, 'package.json'))) continue; // not in this checkout
      const found = discover(join(repoRoot, rel), 0, repoRoot).map((p: { rel: string }) => p.rel);
      expect(found, `${rel} is exempted but no longer declares a typecheck script`).toContain(rel);
    }
  });
});

describe('a failing package', () => {
  it('reds the run and prints the compiler output', () => {
    const root = makeTree({ 'packages/bad': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => ({ status: 2, stdout: 'src/a.ts(1,1): error TS2322: nope', stderr: '', signal: null }),
      ...sink.io,
    });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('error TS2322');
    expect(sink.stderr()).not.toContain('INFRASTRUCTURE');
  });

  it('a non-zero exit with NO parseable diagnostics is INFRASTRUCTURE, never "0 errors"', () => {
    // Reading a crashed run as clean is what once lowered a watermark 170→0 and red-pinned
    // the gate (WI-4721).
    const root = makeTree({ 'packages/bad': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => ({ status: 1, stdout: '', stderr: 'tsc: command not found', signal: null }),
      ...sink.io,
    });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('INFRASTRUCTURE');
  });

  it('an OOM-killed tsc is retried, then SKIPPED — never a red for a load condition', () => {
    // EI-18667028218882894: OOM under fleet load is an infrastructure outcome, not a verdict
    // about the code. Reddening the release for it blocks everyone over nothing.
    const root = makeTree({ 'packages/heavy': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.warns.join('\n')).toContain('OOM-killed again');
    expect(sink.warns.join('\n')).toContain('NOT verified this run');
    expect(sink.stdout()).toContain('1 skipped (OOM)');
  });
});

describe('the REAL tree', () => {
  // THE anti-silent-un-gating guard for WI-7155 specifically. Its whole complaint was that
  // libs/generic/* was typechecked by no routine gate; the fix works only while these packages
  // keep declaring a typecheck script. Removing one silently un-gates it again — that reds HERE,
  // at development time, instead of quietly restoring the original bug.
  it('the six libs/generic workspaces WI-7155 named still declare a typecheck script', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const genericRoot = join(repoRoot, 'libs', 'generic');
    if (!existsSync(genericRoot)) return;

    const found = discover(genericRoot, 0, repoRoot).map((p: { rel: string }) => p.rel);
    for (const expected of [
      'libs/generic/artifact-registry',
      'libs/generic/chat-protocol',
      'libs/generic/gui-readiness',
      'libs/generic/rerank',
      'libs/generic/search-core',
      'libs/generic/tauri-verify',
    ]) {
      expect(found, `${expected} no longer declares a typecheck script — WI-7155 regressed`).toContain(expected);
    }
  });

  it('the superproject roots this leg covers are disjoint from the libs/papercusp fan-out', () => {
    // Covering a package twice doubles its compile and reports one regression as two.
    expect(DEFAULT_ROOTS).not.toContain('libs/papercusp');
    expect(DEFAULT_ROOTS.some((r: string) => r.startsWith('libs/papercusp'))).toBe(false);
  });
});
