/**
 * partial-install-guard.test.ts — the recurrence guard for EI-20863794002653922
 * (the deferred detector half of WI-39899).
 *
 * The incident: the 03:35Z git-sync node_modules untracking deleted 135 files from
 * libs/generic/sse/node_modules — the whole `typescript` package and 3 of vitest's,
 * including vitest's package.json. `@papercusp/sse :: test` then died with
 * ERR_MODULE_NOT_FOUND on vitest's own CLI before a single test ran and red-lined the
 * green-checkpoint gate. The directories were still present; they were empty shells,
 * and nothing in the repo asserted the difference.
 *
 * EVERY FIXTURE HERE IS SYNTHETIC, under mkdtemp. That is deliberate and load-bearing:
 * a test that mutated a real node_modules to prove the guard fires would be creating the
 * exact corruption the guard exists to detect, on a tree ~100 agents share, and
 * git-sync would happily commit the intermediate.
 *
 * The false-positive cases matter as much as the true positives. This guard is wired
 * into REPO_WIDE_INVARIANT_GUARDS, so a single wrong finding red-pins the fleet gate —
 * scope directories, .bin, and plain files must stay silent.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findHollowPackages,
  expandWorkspaceDirs,
} from '../../../../scripts/check-partial-install.mjs';

let root: string;
const roots: string[] = [];

function makeRoot(workspaces: string[] = []): string {
  root = mkdtempSync(join(tmpdir(), 'partial-install-guard-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', workspaces }),
  );
  return root;
}

/** A healthy installed package: directory + parseable manifest. */
function installPackage(nodeModulesDir: string, name: string, version = '1.0.0'): void {
  const dir = join(nodeModulesDir, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
}

/** The damage signature: the directory survives, the manifest does not. */
function installHollowPackage(nodeModulesDir: string, name: string): void {
  const dir = join(nodeModulesDir, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  // Leave real files behind, as the sse deletion did — it removed 132 of typescript's
  // files but the directory entry itself remained.
  writeFileSync(join(dir, 'README.md'), 'orphaned');
}

function nodeModulesOf(workspaceDir: string): string {
  const dir = join(workspaceDir, 'node_modules');
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('findHollowPackages — the true positives', () => {
  it('flags a package whose directory survived but whose package.json did not', () => {
    const r = makeRoot();
    const nm = nodeModulesOf(r);
    installPackage(nm, 'vitest');
    installHollowPackage(nm, 'typescript');

    const { findings } = findHollowPackages(r);

    expect(findings).toEqual([
      { workspace: '<root>', pkg: 'typescript', kind: 'hollow' },
    ]);
  });

  it('flags an UNPARSEABLE manifest, not just a missing one — a half-written package.json resolves no better than an absent one', () => {
    const r = makeRoot();
    const nm = nodeModulesOf(r);
    mkdirSync(join(nm, 'vitest'), { recursive: true });
    writeFileSync(join(nm, 'vitest', 'package.json'), '{"name":"vitest","vers');

    const { findings } = findHollowPackages(r);

    expect(findings).toEqual([{ workspace: '<root>', pkg: 'vitest', kind: 'hollow' }]);
  });

  it('flags a hollow SCOPED package under its full @scope/name', () => {
    const r = makeRoot();
    const nm = nodeModulesOf(r);
    installPackage(nm, '@types/node');
    installHollowPackage(nm, '@types/react');

    const { findings } = findHollowPackages(r);

    expect(findings).toEqual([
      { workspace: '<root>', pkg: '@types/react', kind: 'hollow' },
    ]);
  });

  it('flags a DANGLING symlink — present but pointing nowhere is the same class as hollow', () => {
    const r = makeRoot();
    const nm = nodeModulesOf(r);
    symlinkSync(join(r, 'no-such-package'), join(nm, 'ghost'));

    const { findings } = findHollowPackages(r);

    expect(findings).toEqual([
      { workspace: '<root>', pkg: 'ghost', kind: 'dangling-symlink' },
    ]);
  });

  it('scans PACKAGE-LOCAL node_modules, not only the root — that is where the sse damage was', () => {
    const r = makeRoot(['libs/*']);
    const ws = join(r, 'libs', 'sse');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({ name: '@papercusp/sse' }),
    );
    installHollowPackage(nodeModulesOf(ws), 'vitest');

    const { findings } = findHollowPackages(r);

    expect(findings).toEqual([
      { workspace: join('libs', 'sse'), pkg: 'vitest', kind: 'hollow' },
    ]);
  });

  it('reproduces the ACTUAL incident shape: sse keeping vitest and typescript as shells', () => {
    const r = makeRoot(['libs/*']);
    const ws = join(r, 'libs', 'sse');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: '@papercusp/sse' }));
    const nm = nodeModulesOf(ws);
    installHollowPackage(nm, 'typescript');
    installHollowPackage(nm, 'vitest');

    const { findings } = findHollowPackages(r);

    expect(findings.map((f) => f.pkg)).toEqual(['typescript', 'vitest']);
    expect(findings.every((f) => f.kind === 'hollow')).toBe(true);
  });
});

describe('findHollowPackages — the false positives that would red-pin the gate', () => {
  it('does NOT flag an @scope directory for lacking a package.json of its own', () => {
    const r = makeRoot();
    installPackage(nodeModulesOf(r), '@types/node');

    expect(findHollowPackages(r).findings).toEqual([]);
  });

  it('does NOT flag .bin or other dot-entries', () => {
    const r = makeRoot();
    const nm = nodeModulesOf(r);
    mkdirSync(join(nm, '.bin'), { recursive: true });
    writeFileSync(join(nm, '.package-lock.json'), '{}');
    mkdirSync(join(nm, '.vite'), { recursive: true });

    expect(findHollowPackages(r).findings).toEqual([]);
  });

  it('does NOT flag a plain FILE sitting in node_modules', () => {
    const r = makeRoot();
    writeFileSync(join(nodeModulesOf(r), 'stray-note.txt'), 'not a package');

    expect(findHollowPackages(r).findings).toEqual([]);
  });

  it('does NOT flag a healthy workspace SYMLINK whose target has a manifest', () => {
    const r = makeRoot();
    const real = join(r, 'packages', 'thing');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'thing' }));
    symlinkSync(real, join(nodeModulesOf(r), 'thing'));

    expect(findHollowPackages(r).findings).toEqual([]);
  });

  it('is silent on a fully healthy tree and still reports what it measured', () => {
    const r = makeRoot();
    const nm = nodeModulesOf(r);
    installPackage(nm, 'vitest');
    installPackage(nm, '@types/node');

    const result = findHollowPackages(r);

    expect(result.findings).toEqual([]);
    expect(result.packagesScanned).toBe(2);
    expect(result.nodeModulesScanned).toBe(1);
  });
});

describe('findHollowPackages — degenerate inputs must not throw or invent findings', () => {
  it('skips a workspace that has no node_modules at all', () => {
    const r = makeRoot(['libs/*']);
    const ws = join(r, 'libs', 'quiet');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'quiet' }));

    const result = findHollowPackages(r);

    expect(result.findings).toEqual([]);
    expect(result.nodeModulesScanned).toBe(0);
  });

  it('reports NOTHING rather than guessing when the root manifest is unreadable', () => {
    const r = mkdtempSync(join(tmpdir(), 'partial-install-guard-'));
    roots.push(r);
    // no package.json at all
    expect(() => findHollowPackages(r)).not.toThrow();
    expect(findHollowPackages(r)).toEqual({
      findings: [],
      workspacesScanned: 0,
      nodeModulesScanned: 0,
      packagesScanned: 0,
    });
  });

  it('tolerates a workspace glob whose base directory does not exist', () => {
    const r = makeRoot(['nonexistent/*']);
    expect(() => findHollowPackages(r)).not.toThrow();
    expect(findHollowPackages(r).findings).toEqual([]);
  });
});

describe('expandWorkspaceDirs', () => {
  it('expands a dir/* glob to only those children that carry a package.json', () => {
    const r = makeRoot();
    for (const name of ['alpha', 'beta']) {
      const d = join(r, 'libs', name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name }));
    }
    // a child with no manifest is not a workspace
    mkdirSync(join(r, 'libs', 'not-a-package'), { recursive: true });

    expect(expandWorkspaceDirs(['libs/*'], r)).toEqual([
      join('libs', 'alpha'),
      join('libs', 'beta'),
    ]);
  });

  it('accepts a literal (non-glob) workspace path', () => {
    const r = makeRoot();
    const d = join(r, 'apps', 'operator');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'operator' }));

    expect(expandWorkspaceDirs(['apps/operator'], r)).toEqual(['apps/operator']);
  });

  it('returns an empty list for undefined patterns rather than throwing', () => {
    const r = makeRoot();
    expect(expandWorkspaceDirs(undefined, r)).toEqual([]);
  });
});
