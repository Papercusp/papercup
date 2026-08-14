/**
 * check-declared-deps-extracted.test.ts — the un-extracted-dependency detector
 * (EI-18666853411437489).
 *
 * The bug: under concurrent `npm install` runs on the shared tree, npm's reify
 * bookkeeping can believe a declared dependency is resolved (it IS in
 * package-lock.json, and node_modules/.package-lock.json is newer) while the tarball
 * was never extracted. npm prints "up to date", exits 0, and the first symptom is a
 * confusing "cannot find module" / Rolldown "failed to resolve" in an unrelated build
 * or gate, 10+ minutes later. `scripts/npm-install-safe.mjs` serializes installs so
 * NEW corruption is not created; it could not DETECT existing corruption — that is
 * what `scripts/check-declared-deps-extracted.mjs` adds, and what this locks.
 *
 * Running the checker over the real tree proves the no-FALSE-POSITIVE direction on a
 * healthy corpus. This locks what a healthy-tree run cannot prove:
 *   1. it FLAGS a declared dependency that is absent from every node_modules on the
 *      resolution path — the exact shape observed (8 mem0ai peers declared + locked
 *      but missing on disk);
 *   2. it does NOT false-positive on the ways a dep legitimately resolves — hoisted
 *      to the repo root, or via an ANCESTOR node_modules for a nested workspace;
 *   3. devDependencies / peerDependencies are deliberately OUT of scope (`npm ls`'s
 *      unmet-peer noise under --legacy-peer-deps is the false-positive that once
 *      blocked a build for a dependency it never needed);
 *   4. the retry absorbs a filesystem-sync race (a miss that CLEARS on a later
 *      attempt is not reported) but still reports a PERSISTENT miss;
 *   5. install:safe's post-install verification repairs once, then fails loudly —
 *      it never returns success while deps are still missing, and never masks a
 *      failing npm run with a dep verdict.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { findUnextractedDeps, findUnextractedDepsWithRetry, resolveWorkspaceDirs, resolvesOnDisk } from '../../../../scripts/check-declared-deps-extracted.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — same, for the post-install verification wired into install:safe.
import { normalizeNpmArgs, parseCliArgs, repoLockName, verifyDepsExtracted } from '../../../../scripts/npm-install-safe.mjs';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The verification prints its (deliberate) diagnosis to the console; this suite fails on console output. */
function silenceConsole() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

/** A miniature npm-workspaces tree: workspaces + declared deps + which packages actually landed. */
function fixture(opts: {
  workspaces?: string[];
  packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  /** node_modules dirs that exist, relative to the repo root ('' = root node_modules). */
  extracted: Record<string, string[]>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'declared-deps-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: opts.workspaces ?? Object.keys(opts.packages) }));
  for (const [rel, pkg] of Object.entries(opts.packages)) {
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(join(root, rel, 'package.json'), JSON.stringify(pkg));
  }
  for (const [at, names] of Object.entries(opts.extracted)) {
    for (const name of names) mkdirSync(join(root, at, 'node_modules', name), { recursive: true });
  }
  return root;
}

describe('check-declared-deps-extracted detector (EI-18666853411437489)', () => {
  it('FLAGS a declared dependency that never got extracted to disk', () => {
    // The observed shape: declared (and in package-lock.json) but absent from node_modules.
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'groq-sdk': '^1', cloudflare: '^4', mem0ai: '^3' } } },
      extracted: { '': ['mem0ai'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([
      { dep: 'groq-sdk', workspace: 'apps/operator' },
      { dep: 'cloudflare', workspace: 'apps/operator' },
    ]);
  });

  it('does NOT flag a dependency hoisted to the ROOT node_modules', () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { hoisted: '^1' } } },
      extracted: { '': ['hoisted'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
  });

  it('does NOT flag a dependency in the workspace-LOCAL node_modules', () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { local: '^1' } } },
      extracted: { 'apps/operator': ['local'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
  });

  it('resolves through an ANCESTOR node_modules for a nested workspace (npm hoisting)', () => {
    // libs/papercusp/libs/db is a real nested workspace in this repo — its deps hoist upward.
    const root = fixture({
      workspaces: ['libs/papercusp/libs/db'],
      packages: { 'libs/papercusp/libs/db': { dependencies: { pg: '^8' } } },
      extracted: { 'libs/papercusp': ['pg'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
    expect(resolvesOnDisk(root, join(root, 'libs/papercusp/libs/db'), 'pg')).toBe(true);
    expect(resolvesOnDisk(root, join(root, 'libs/papercusp/libs/db'), 'not-installed')).toBe(false);
  });

  it('never escapes the repo root when resolving (no host-level node_modules)', () => {
    const root = fixture({ packages: { 'apps/a': { dependencies: {} } }, extracted: {} });
    expect(resolvesOnDisk(root, join(root, 'apps/a'), 'anything')).toBe(false);
  });

  it('ignores devDependencies and peerDependencies (the npm-ls false-positive class)', () => {
    const root = fixture({
      packages: {
        'apps/operator': {
          dependencies: { present: '^1' },
          devDependencies: { 'only-a-dev-dep': '^1' },
        },
      },
      extracted: { '': ['present'] },
    });
    expect(findUnextractedDeps({ repoRoot: root })).toEqual([]);
  });

  it('expands "apps/*"-style workspace globs and skips dirs without a package.json', () => {
    const root = fixture({
      workspaces: ['apps/*'],
      packages: { 'apps/operator': { dependencies: {} }, 'apps/operator-vite': { dependencies: {} } },
      extracted: {},
    });
    mkdirSync(join(root, 'apps', 'not-a-workspace'), { recursive: true });
    expect(resolveWorkspaceDirs(root)).toEqual(['apps/operator', 'apps/operator-vite']);
  });
});

describe('retry absorbs a filesystem-sync race but not a real miss (WI-5769 retry8)', () => {
  it('reports NOTHING when the miss clears on a later attempt', async () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { racy: '^1' } } },
      extracted: {},
    });
    let attempt = 0;
    const result = await findUnextractedDepsWithRetry({
      repoRoot: root,
      attempts: 3,
      delayMs: 0,
      deps: {
        sleep: async () => {
          // the "filesystem settles" moment between attempts
          mkdirSync(join(root, 'node_modules', 'racy'), { recursive: true });
        },
        existsSync: (p: string) => {
          attempt += 1;
          // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
          return require('node:fs').existsSync(p);
        },
      },
    });
    expect(result.missing).toEqual([]);
    expect(result.attempts).toBe(2);
    expect(attempt).toBeGreaterThan(0);
  });

  it('reports a PERSISTENT miss after every attempt', async () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'really-missing': '^1' } } },
      extracted: {},
    });
    const result = await findUnextractedDepsWithRetry({ repoRoot: root, attempts: 3, delayMs: 0, deps: { sleep: async () => {} } });
    expect(result.attempts).toBe(3);
    expect(result.missing).toEqual([{ dep: 'really-missing', workspace: 'apps/operator' }]);
  });
});

describe('install:safe post-install verification (the half the mutex cannot cover)', () => {
  it('returns 0 without repairing when every declared dep resolves', async () => {
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { ok: '^1' } } },
      extracted: { '': ['ok'] },
    });
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        return 0;
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([]); // no repair install on a healthy tree
  });

  it('REPAIRS once when a dep is un-extracted, then returns 0', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'was-missing': '^1' } } },
      extracted: {},
    });
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        mkdirSync(join(root, 'node_modules', 'was-missing'), { recursive: true }); // the repair install lands it
        return 0;
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([['install', '--legacy-peer-deps']]);
  });

  it('FAILS (1) — never silently succeeds — when the repair does not land the dep', async () => {
    silenceConsole();
    const root = fixture({
      packages: { 'apps/operator': { dependencies: { 'still-missing': '^1' } } },
      extracted: {},
    });
    const calls: string[][] = [];
    const status = await verifyDepsExtracted({
      repoRoot: root,
      runNpm: (args: string[]) => {
        calls.push(args);
        return 0; // npm "succeeds" but leaves it un-extracted — the exact bug
      },
      deps: { sleep: async () => {} },
    });
    expect(status).toBe(1);
    expect(calls).toHaveLength(1); // ONE bounded repair, not a loop
  });
});

describe('install:safe managed-repo targeting (EI-20412068513394843)', () => {
  it('targets an explicit managed hive root without consuming npm arguments', () => {
    expect(
      parseCliArgs(
        ['--repo-root', '../sidestage', '--', 'install', '--no-save', 'verdict-cli'],
        { cwd: '/managed/papercusp' },
      ),
    ).toEqual({
      repoRoot: '/managed/sidestage',
      npmArgs: ['install', '--no-save', 'verdict-cli'],
    });
  });

  it('keeps the documented flags-only form faithful by inserting install', () => {
    expect(normalizeNpmArgs([])).toEqual(['install']);
    expect(normalizeNpmArgs(['--legacy-peer-deps'])).toEqual(['install', '--legacy-peer-deps']);
    expect(normalizeNpmArgs(['ci', '--ignore-scripts'])).toEqual(['ci', '--ignore-scripts']);
  });

  it('keys the mutex by the selected root realpath, including symlink aliases', () => {
    const parent = mkdtempSync(join(tmpdir(), 'install-safe-root-'));
    made.push(parent);
    const target = join(parent, 'target');
    const alias = join(parent, 'alias');
    const other = join(parent, 'other');
    mkdirSync(target);
    mkdirSync(other);
    symlinkSync(target, alias);

    expect(repoLockName(alias)).toBe(repoLockName(target));
    expect(repoLockName(other)).not.toBe(repoLockName(target));
  });
});
