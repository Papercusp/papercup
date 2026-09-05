/**
 * Guard test for scripts/check-lockfile-census.mjs — the P-007 SBOM/inventory gate
 * (plan security-boundary-remediation-and-usability-2026-09-04, WI-2144851).
 *
 * WHY THESE CONTROLS EXIST
 *
 * This guard's whole job is to make an UNMEASURED dependency graph loud. That means its
 * own failure mode is the one it exists to prevent: a census that reads nothing, or a
 * classifier that waves everything through, reports a clean tree in exactly the same
 * words as a genuinely clean one. So the controls below are weighted toward proving the
 * instrument can FAIL — an empty walk, an unreadable root lockfile, a workspace set that
 * came back empty — rather than toward re-asserting the happy path.
 *
 * THE CENTRAL CASE IS `treats subsumption as DERIVED, not asserted`.
 * Three nested package-lock.json files in this tree are genuinely covered by the root
 * `npm audit` because their package is a root workspace member and npm hoists the graph.
 * The tempting implementation writes those three paths into a list. That list is a second
 * copy of a truth the root lockfile already owns, and it keeps saying "covered" for years
 * after a package stops being a workspace member. The test pins the derivation instead:
 * the same lockfile flips to UNCLASSIFIED the moment its directory leaves the workspace
 * set, with no list to update.
 *
 * The classifier is pure over plain data, so every case runs on inline fixtures — no
 * network, no npm/cargo/syft invocation, no shared-tree mutation (the fixture tier from
 * CLAUDE.md's falsifiability table). The three real-tree assertions read the repo but
 * never write to it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Enrolled in tsconfig.declarations.json, so this import is TYPED (generated sibling
// scripts/check-lockfile-census.d.mts) rather than an implicit `any` module.
import {
  classifyCensus,
  censusOrThrow,
  walkLockfiles,
  rootWorkspaceDirs,
  sbomSubjects,
  emitSbom,
  COVERED_LOCKFILES,
  NOT_SHIPPED_LOCKFILES,
  UNCOVERED_BASELINE,
  LOCKFILE_ECOSYSTEMS,
  ROOT,
} from '../../../scripts/check-lockfile-census.mjs';
import { SHIPPED_LOCKFILES } from '../../../scripts/check-rust-advisories.mjs';

/** A workspace set shaped like the real one — several dirs, one of them our fixture's. */
const WORKSPACE_DIRS = new Set(['packages/alpha', 'libs/generic/beta', 'apps/gamma']);

function classify(lockfiles: string[], overrides: Record<string, unknown> = {}) {
  return classifyCensus({
    lockfiles,
    workspaceDirs: WORKSPACE_DIRS,
    covered: new Map([['package-lock.json', 'root npm audit']]),
    notShipped: new Map([['apps/toy/Cargo.lock', 'a toy; never bundled']]),
    uncovered: new Map([['shipped-thing/package-lock.json', { deps: 12, reason: 'shipped, unscanned' }]]),
    ...overrides,
  });
}

describe('classifyCensus', () => {
  it('POSITIVE CONTROL — an unknown lockfile is UNCLASSIFIED, not silently allowed', () => {
    const r = classify(['package-lock.json', 'some/new/thing/Cargo.lock']);
    expect(r.offenders.map((o) => o.path)).toEqual(['some/new/thing/Cargo.lock']);
  });

  it('NEGATIVE CONTROL — a fully classified census produces no offenders', () => {
    const r = classify([
      'package-lock.json',
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
      'packages/alpha/package-lock.json',
    ]);
    expect(r.offenders).toEqual([]);
    expect(r.byBucket).toEqual({
      covered: 1,
      'not-shipped': 1,
      'uncovered-baselined': 1,
      subsumed: 1,
    });
  });

  // THE CENTRAL CASE. Subsumption must come from the root lockfile, never from a list.
  it('treats subsumption as DERIVED, not asserted', () => {
    const path = 'packages/alpha/package-lock.json';
    const covered = classify(['package-lock.json', path]);
    expect(covered.rows.find((r) => r.path === path)?.bucket).toBe('subsumed');

    // Same lockfile, same lists — only the workspace membership is gone.
    const orphaned = classifyCensus({
      lockfiles: ['package-lock.json', path],
      workspaceDirs: new Set(['libs/generic/beta']),
      covered: new Map([['package-lock.json', 'root npm audit']]),
      notShipped: new Map(),
      uncovered: new Map(),
    });
    expect(orphaned.rows.find((r) => r.path === path)?.bucket).toBe('UNCLASSIFIED');
  });

  it('never subsumes a NON-npm lockfile on workspace membership', () => {
    // A Cargo.lock inside a workspace directory is not hoisted by npm — cargo has no such
    // mechanism, so inheriting the npm rule here would launder a real blind spot.
    const r = classify(['package-lock.json', 'packages/alpha/Cargo.lock']);
    expect(r.rows.find((r2) => r2.path === 'packages/alpha/Cargo.lock')?.bucket).toBe('UNCLASSIFIED');
  });

  it('reports a curated entry whose path left the tree as stale, without failing', () => {
    const r = classify(['package-lock.json']);
    expect(r.stale.map((s) => s.path).sort()).toEqual([
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
    ]);
    expect(r.offenders).toEqual([]);
  });

  it('carries the measured dep count on a baselined uncovered row', () => {
    const r = classify(['package-lock.json', 'shipped-thing/package-lock.json']);
    expect(r.rows.find((x) => x.bucket === 'uncovered-baselined')?.deps).toBe(12);
  });

  it('classifies each row into exactly one bucket', () => {
    const r = classify([
      'package-lock.json',
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
      'packages/alpha/package-lock.json',
      'mystery/Cargo.lock',
    ]);
    expect(r.rows).toHaveLength(5);
    expect(Object.values(r.byBucket).reduce((a, b) => a + (b as number), 0)).toBe(5);
  });
});

describe('census and workspace derivation fail CLOSED', () => {
  it('refuses a census that found ZERO lockfiles', () => {
    const empty = mkdtempSync(join(tmpdir(), 'census-empty-'));
    try {
      expect(() => censusOrThrow(empty)).toThrow(/ZERO lockfiles/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses a census missing its own positive control', () => {
    // Lockfiles found, but not the repo-root one — a mis-rooted or over-pruned walk.
    const dir = mkdtempSync(join(tmpdir(), 'census-noctl-'));
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'Cargo.lock'), '[[package]]\n');
      expect(() => censusOrThrow(dir)).toThrow(/positive control/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a root lockfile with no packages map rather than reporting a tree of blind spots', () => {
    expect(() => rootWorkspaceDirs({})).toThrow(/no `packages` map/);
    expect(() => rootWorkspaceDirs({ packages: 'nope' })).toThrow(/no `packages` map/);
  });

  it('refuses a root lockfile that yields zero workspace directories', () => {
    // Shape is right, content is empty — every nested lock would look unsubsumed.
    expect(() => rootWorkspaceDirs({ packages: { '': {}, 'node_modules/x': {} } })).toThrow(
      /no workspace directories/,
    );
  });

  it('derives workspace dirs while excluding the root and node_modules keys', () => {
    const dirs = rootWorkspaceDirs({
      packages: { '': {}, 'packages/alpha': {}, 'node_modules/lodash': {}, 'apps/gamma': {} },
    });
    expect([...dirs].sort()).toEqual(['apps/gamma', 'packages/alpha']);
  });
});

describe('walkLockfiles', () => {
  it('finds lockfiles by ecosystem name and prunes dependency trees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-walk-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'dep', 'package-lock.json'), '{}');
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, 'app', 'Cargo.lock'), '');
      writeFileSync(join(dir, 'app', 'README.md'), '');

      expect(walkLockfiles(dir)).toEqual(['app/Cargo.lock', 'package-lock.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recognises ecosystems beyond npm and cargo, so a new one cannot enter unseen', () => {
    // The two blind spots this guard was built from were both "an ecosystem nobody was
    // scanning". A go/python graph landing here must surface as UNCLASSIFIED, which it
    // can only do if the walker recognises the lockfile at all.
    for (const name of ['go.sum', 'poetry.lock', 'Gemfile.lock', 'uv.lock']) {
      expect(LOCKFILE_ECOSYSTEMS.has(name)).toBe(true);
    }
  });
});

describe('SBOM emission', () => {
  it('inventories what ships, and skips vestigial and unshipped lockfiles', () => {
    const r = classify([
      'package-lock.json',
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
      'packages/alpha/package-lock.json',
    ]);
    expect(sbomSubjects(r.rows).sort()).toEqual(['package-lock.json', 'shipped-thing/package-lock.json']);
  });

  it('REFUSES when syft is absent instead of writing no SBOM and exiting 0', () => {
    // The trap this pins: a supply-chain step that silently no-ops when its tool is
    // missing produces a green run and no artifact — the exact "measured nothing" reading
    // the whole guard exists to prevent.
    expect(() => emitSbom(['package-lock.json'], '/tmp/never-written.json', { syft: '/nonexistent/syft' })).toThrow(
      /syft not found/,
    );
  });
});

describe('the repository itself (real-tree assertion)', () => {
  const lockfiles = censusOrThrow(ROOT);
  const rootLock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as unknown;
  const result = classifyCensus({ lockfiles, workspaceDirs: rootWorkspaceDirs(rootLock) });

  it('has every lockfile in the tree explicitly classified', () => {
    expect(result.offenders.map((o) => o.path)).toEqual([]);
  });

  it('has no stale curated entry', () => {
    expect(result.stale.map((s) => `${s.source}:${s.path}`)).toEqual([]);
  });

  // Pins the finding this guard was built from, so a later "cleanup" that quietly drops
  // these rows has to argue with a test instead of a comment.
  it('still records the two measured advisory blind spots', () => {
    const uncovered = result.rows.filter((r) => r.bucket === 'uncovered-baselined');
    expect(uncovered.map((r) => r.path).sort()).toEqual([
      'libs/papercusp/packages/harness/docs-viewer/package-lock.json',
      'papercusp-desktop/package-lock.json',
    ]);
    // The shipped desktop app's own npm graph is the one that matters most here.
    expect(uncovered.some((r) => r.path === 'papercusp-desktop/package-lock.json')).toBe(true);
  });

  // CROSS-GUARD INVARIANT. "covered" is a claim about what ANOTHER script scans; if that
  // script narrows its scope, this census keeps calling the lockfile covered and the blind
  // spot reopens silently. Read the sibling's own exported scope instead of trusting a
  // duplicated path string.
  it('only calls a Cargo.lock covered if the Rust gate actually scans it', () => {
    const claimed = [...COVERED_LOCKFILES.keys()].filter((p) => p.endsWith('Cargo.lock')).sort();
    expect(claimed).toEqual([...SHIPPED_LOCKFILES].sort());
  });

  it('keeps the uncovered baseline shrink-only and reason-carrying', () => {
    expect(UNCOVERED_BASELINE.size).toBeLessThanOrEqual(2);
    for (const [path, entry] of UNCOVERED_BASELINE) {
      expect(entry.reason.length, `${path} needs a real reason`).toBeGreaterThan(40);
      expect(entry.deps, `${path} needs its measured graph size`).toBeGreaterThan(0);
    }
  });

  it('gives every not-shipped entry a stated reason', () => {
    for (const [path, reason] of NOT_SHIPPED_LOCKFILES) {
      expect(reason.length, `${path} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
