/**
 * WI-39358 — the `npm run doctor` check for a submodule that installs its own dependency
 * tree but has not been installed.
 *
 * THE GAP THIS PINS. A git submodule carrying its own package-lock.json is NOT covered by
 * the monorepo root's `npm install` unless it is also a root workspace — and
 * papercusp-desktop is a submodule that is not a workspace. Nothing detected that
 * combination. Measured 2026-08-15: after the WI-39347 `rm -rf /home` incident the tree was
 * re-cloned and the root install re-run; the desktop submodule stayed empty, and the first
 * thing that noticed was the owner's `npm run dev` failing with `exec: tauri: not found`.
 *
 * WHY THESE TESTS ARE SHAPED THIS WAY. They exercise the DISCOVERY MECHANISM against
 * synthetic fixtures, never the live tree's current state. A test asserting
 * "papercusp-desktop has node_modules" would be asserting a machine's present condition —
 * it would fail on any clean checkout and pass on a box where the guard is broken but the
 * install happens to be intact. The mechanism is the invariant; the population is not.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  binShimNames,
  findIncompleteSubmoduleInstalls,
  isRootWorkspace,
  repairCommand,
  submodulePathsFromGitmodules,
} from '../../../../scripts/lib/submodule-installs.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wi39358-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build a submodule fixture; omit `installed` to simulate a never-installed tree. */
function makeSubmodule(
  name: string,
  opts: {
    lockfile?: boolean;
    deps?: Record<string, string>;
    installed?: string[];
    /** package name -> its `bin` field, for the packages that are installed. */
    bins?: Record<string, string | Record<string, string>>;
    /** shim names to actually link into node_modules/.bin */
    shims?: string[];
  } = {},
): string {
  const { lockfile = true, deps = { '@tauri-apps/cli': '^2.1.0' }, installed, bins = {}, shims } = opts;
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, devDependencies: deps }));
  if (lockfile) writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name }));

  if (installed) {
    const nm = join(dir, 'node_modules');
    mkdirSync(join(nm, '.bin'), { recursive: true });
    for (const pkg of installed) {
      mkdirSync(join(nm, pkg), { recursive: true });
      writeFileSync(
        join(nm, pkg, 'package.json'),
        JSON.stringify({ name: pkg, ...(bins[pkg] ? { bin: bins[pkg] } : {}) }),
      );
    }
    for (const shim of shims ?? []) writeFileSync(join(nm, '.bin', shim), '#!/bin/sh\n');
  }
  return dir;
}

/** Default: no submodule is a root workspace — the papercusp-desktop situation. */
const find = (paths: string[], rootWorkspaces: string[] = []) =>
  findIncompleteSubmoduleInstalls({ repoRoot: root, submodulePaths: paths, rootWorkspaces });

/** Put a package (and optionally its bin shim) in the ROOT node_modules, as npm hoisting does. */
function hoistToRoot(pkg: string, bin?: Record<string, string>) {
  const nm = join(root, 'node_modules');
  mkdirSync(join(nm, pkg), { recursive: true });
  writeFileSync(join(nm, pkg, 'package.json'), JSON.stringify({ name: pkg, ...(bin ? { bin } : {}) }));
  if (bin) {
    mkdirSync(join(nm, '.bin'), { recursive: true });
    for (const shim of Object.keys(bin)) writeFileSync(join(nm, '.bin', shim), '#!/bin/sh\n');
  }
}

describe('findIncompleteSubmoduleInstalls', () => {
  it('flags a lockfile-bearing submodule whose node_modules is absent', () => {
    makeSubmodule('desktop');
    const problems = find(['desktop']);

    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe('desktop');
    expect(problems[0].reason).toMatch(/node_modules is absent/);
    // The fix must be the command itself, not a description of one.
    expect(problems[0].fix).toBe('npm run install:safe -- --repo-root desktop');
  });

  it('explains that a root install does not cover it — the part that was non-obvious', () => {
    makeSubmodule('desktop');
    expect(find(['desktop'])[0].reason).toMatch(/not an npm workspace/i);
  });

  it('passes a fully installed submodule', () => {
    makeSubmodule('desktop', {
      installed: ['@tauri-apps/cli'],
      bins: { '@tauri-apps/cli': { tauri: 'tauri.js' } },
      shims: ['tauri'],
    });
    expect(find(['desktop'])).toEqual([]);
  });

  it('flags a PARTIAL install — node_modules present but a declared package missing', () => {
    // The shared-tree corruption mode (EI-18662389554660036): the directory exists, so an
    // existence check on node_modules alone reports healthy.
    makeSubmodule('desktop', { deps: { a: '1', b: '2' }, installed: ['a'] });
    const problems = find(['desktop']);

    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toMatch(/unresolvable from this submodule: b/);
  });

  // ── Hoisting. These pin the false positive the first version of this guard produced when
  // it was run against the live tree (2026-08-15): libs/generic/resumable-download is a
  // submodule with its own lockfile that is ALSO a root workspace, so npm hoisted its
  // `typescript` devDependency to the root node_modules. The naive "the dep must sit in MY
  // node_modules" rule called that a broken install. It is ordinary npm behaviour.

  it('does NOT flag a submodule that is also a root workspace (npm hoists its deps)', () => {
    makeSubmodule('libs/generic/resumable-download', { deps: { typescript: '^6' } });
    expect(find(['libs/generic/resumable-download'], ['libs/generic/resumable-download'])).toEqual([]);
  });

  it('honours a glob workspace pattern, not just an exact entry', () => {
    makeSubmodule('packages/thing', { deps: { typescript: '^6' } });
    expect(find(['packages/thing'], ['packages/*'])).toEqual([]);
  });

  it('resolves a dependency HOISTED to the root, as node would', () => {
    // Not a workspace, so it is in scope — but the dep is genuinely resolvable from there.
    makeSubmodule('desktop', { deps: { typescript: '^6' } });
    hoistToRoot('typescript');
    expect(find(['desktop'])).toEqual([]);
  });

  it('accepts a bin shim provided by an ancestor .bin, which npm also puts on PATH', () => {
    makeSubmodule('desktop', { deps: { '@tauri-apps/cli': '^2' } });
    hoistToRoot('@tauri-apps/cli', { tauri: 'tauri.js' });
    expect(find(['desktop'])).toEqual([]);
  });

  it('flags a missing .bin shim — the symptom that actually reaches a human', () => {
    // `exec: tauri: not found` is a missing BINARY. The package directory can be present
    // while the shim that puts it on PATH is not.
    makeSubmodule('desktop', {
      installed: ['@tauri-apps/cli'],
      bins: { '@tauri-apps/cli': { tauri: 'tauri.js' } },
      shims: [],
    });
    const problems = find(['desktop']);

    expect(problems).toHaveLength(1);
    expect(problems[0].reason).toMatch(/no executable shim on PATH for: tauri/);
  });

  it('ignores a submodule with NO lockfile — it is covered by the root install', () => {
    makeSubmodule('plain-lib', { lockfile: false });
    expect(find(['plain-lib'])).toEqual([]);
  });

  it('ignores a submodule that declares no dependencies', () => {
    makeSubmodule('empty', { deps: {} });
    expect(find(['empty'])).toEqual([]);
  });

  it('ignores an absent submodule path — that is the worktree check\'s fault to report', () => {
    expect(find(['never-checked-out'])).toEqual([]);
  });

  it('does not throw on a malformed package.json', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{ not json');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(() => find(['broken'])).not.toThrow();
  });

  it('reports every offending submodule, not just the first', () => {
    makeSubmodule('one');
    makeSubmodule('two');
    expect(find(['one', 'two']).map((p) => p.path)).toEqual(['one', 'two']);
  });
});

describe('isRootWorkspace', () => {
  it('matches an exact workspace entry', () => {
    expect(isRootWorkspace('libs/generic/resumable-download', ['libs/generic/resumable-download'])).toBe(true);
  });

  it('matches a one-level glob, and only one level', () => {
    expect(isRootWorkspace('apps/operator', ['apps/*'])).toBe(true);
    // `apps/*` does not cover a grandchild — npm globs are one segment deep.
    expect(isRootWorkspace('apps/operator/nested', ['apps/*'])).toBe(false);
  });

  it('does not match a submodule outside the workspace set — the in-scope case', () => {
    expect(isRootWorkspace('papercusp-desktop', ['apps/*', 'packages/*', 'libs/flags'])).toBe(false);
  });

  it('is not fooled by a prefix collision', () => {
    expect(isRootWorkspace('papercusp-desktop-extra', ['papercusp-desktop'])).toBe(false);
  });
});

describe('binShimNames', () => {
  it('derives the shim from the unscoped name when bin is a string', () => {
    expect(binShimNames('@tauri-apps/cli', './cli.js')).toEqual(['cli']);
    expect(binShimNames('vitest', './vitest.mjs')).toEqual(['vitest']);
  });

  it('uses the keys when bin is an object', () => {
    expect(binShimNames('@tauri-apps/cli', { tauri: 'tauri.js' })).toEqual(['tauri']);
  });

  it('returns nothing for a library with no bin', () => {
    expect(binShimNames('lodash', undefined)).toEqual([]);
  });
});

describe('submodulePathsFromGitmodules', () => {
  it('parses paths without shelling out to git', () => {
    writeFileSync(
      join(root, '.gitmodules'),
      [
        '[submodule "papercusp-desktop"]',
        '\tpath = papercusp-desktop',
        '\turl = git@github.com:Papercusp/papercusp-desktop.git',
        '[submodule "libs/generic/dock-workbench"]',
        '\tpath = libs/generic/dock-workbench',
        '\turl = git@github.com:Papercusp/dock-workbench.git',
      ].join('\n'),
    );
    expect(submodulePathsFromGitmodules(root)).toEqual([
      'papercusp-desktop',
      'libs/generic/dock-workbench',
    ]);
  });

  it('returns empty when there are no submodules', () => {
    expect(submodulePathsFromGitmodules(root)).toEqual([]);
  });
});

describe('repairCommand', () => {
  it('uses install:safe with an explicit --repo-root, never a bare npm install', () => {
    // A bare `npm install` in this shared multi-agent tree rewrites node_modules/.bin under
    // every peer's in-flight test run; install:safe serializes behind an fs-mutex keyed on
    // the target's realpath, so a submodule install does not contend with a root install.
    const cmd = repairCommand('papercusp-desktop');
    expect(cmd).toBe('npm run install:safe -- --repo-root papercusp-desktop');
    expect(cmd).not.toMatch(/^npm install/);
  });
});

describe('the live tree', () => {
  it('is wired into the doctor, and the doctor is what runs it', () => {
    // Not an assertion about whether the tree is currently installed (that is a machine
    // condition, not an invariant) — only that the check is reachable from `npm run doctor`.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const repoRoot = join(__dirname, '../../../..');
    const doctor = readFileSync(join(repoRoot, 'scripts/test-doctor.mjs'), 'utf8');

    expect(doctor).toMatch(/findIncompleteSubmoduleInstalls/);
    expect(doctor).toMatch(/submodule installs complete/);

    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.doctor).toMatch(/test-doctor\.mjs/);
  });
});
