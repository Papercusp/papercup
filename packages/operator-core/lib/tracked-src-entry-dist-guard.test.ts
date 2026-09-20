/**
 * Falsifiability tests for scripts/check-tracked-src-entry-dist.mjs (WI-10002064).
 *
 * The guard exists because `packages/agent-mcp/dist/` tracked 144 files whose
 * package.json routed every entrypoint to `./src/*` — so nothing could load them.
 * The copy went stale and began CONTRADICTING src: dist/_bulk.js:148 still returned
 * the hard-coded `{ ok: true, ... }` envelope thirteen days after src/_bulk.ts:200
 * replaced it with `ok: failed === 0`, re-teaching a contract that was deliberately
 * removed because a top-level `ok:true` beside a failed item is a false success.
 * 66 of the tracked files were `.d.ts` emitted by a config that now sets
 * `declaration: false` — they could not be reproduced by the current build at all.
 *
 * A guard that has only ever been run against a clean tree is not a verified guard,
 * and this one is especially exposed: after the cleanup the real-tree population is
 * EMPTY, so the script passes without exercising a single offender. These tests are
 * therefore the only thing standing between "the guard works" and "the guard cannot
 * fail". The calibration case below is a permanent deliberately-wrong input — it
 * never mutates the tree, so there is no sweep race and no restore to forget.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALLOWLIST,
  declaresDist,
  findOffenders,
} from '../../../scripts/check-tracked-src-entry-dist.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A src-as-entry manifest: every entrypoint resolves into ./src. */
const SRC_ENTRY = {
  name: '@papercusp/example',
  main: './src/index.ts',
  types: './src/index.ts',
  exports: { '.': { types: './src/index.ts', default: './src/index.ts' } },
};

describe('check-tracked-src-entry-dist findOffenders', () => {
  it('CALIBRATION: flags a src-entry package that tracks dist/', () => {
    const offenders = findOffenders({
      packages: [
        {
          repo: '.',
          dir: 'packages/agent-mcp',
          pkgJson: SRC_ENTRY,
          trackedDist: ['packages/agent-mcp/dist/_bulk.js'],
        },
      ],
      allowlist: new Set(),
    });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].dir).toBe('packages/agent-mcp');
  });

  it('passes a package that genuinely CONSUMES its dist/', () => {
    const offenders = findOffenders({
      packages: [
        {
          repo: '.',
          dir: 'packages/built',
          pkgJson: { main: './dist/index.js', types: './dist/index.d.ts' },
          trackedDist: ['packages/built/dist/index.js'],
        },
      ],
      allowlist: new Set(),
    });
    expect(offenders).toEqual([]);
  });

  it('passes a src-entry package that tracks nothing under dist/', () => {
    const offenders = findOffenders({
      packages: [{ repo: '.', dir: 'packages/clean', pkgJson: SRC_ENTRY, trackedDist: [] }],
      allowlist: new Set(),
    });
    expect(offenders).toEqual([]);
  });

  it('reports EVERY offending package, not just the first', () => {
    const offenders = findOffenders({
      packages: [
        { repo: '.', dir: 'packages/a', pkgJson: SRC_ENTRY, trackedDist: ['packages/a/dist/x.js'] },
        { repo: '.', dir: 'packages/b', pkgJson: SRC_ENTRY, trackedDist: ['packages/b/dist/y.js'] },
      ],
      allowlist: new Set(),
    });
    expect(offenders.map((o) => o.dir)).toEqual(['packages/a', 'packages/b']);
  });

  it('spans submodules — the real second instance was invisible to a superproject-only scan', () => {
    // libs/generic/tooldef-http kept 6 tracked dist files that `git ls-files` in the
    // superproject cannot see, because a submodule carries its own index. A guard that
    // scanned only the superproject would have certified the tree as clean.
    const offenders = findOffenders({
      packages: [
        {
          repo: 'libs/generic/tooldef-http',
          dir: '.',
          pkgJson: SRC_ENTRY,
          trackedDist: ['dist/src/index.js'],
        },
      ],
      allowlist: new Set(),
    });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].repo).toBe('libs/generic/tooldef-http');
  });

  it('counts every tracked path so the report cannot understate the blast radius', () => {
    const paths = Array.from({ length: 144 }, (_, i) => `packages/agent-mcp/dist/f${i}.js`);
    const offenders = findOffenders({
      packages: [{ repo: '.', dir: 'packages/agent-mcp', pkgJson: SRC_ENTRY, trackedDist: paths }],
      allowlist: new Set(),
    });
    expect(offenders[0].paths).toHaveLength(144);
  });

  it('honors the allowlist', () => {
    const packages = [
      { repo: '.', dir: 'packages/x', pkgJson: SRC_ENTRY, trackedDist: ['packages/x/dist/a.js'] },
    ];
    expect(findOffenders({ packages, allowlist: new Set(['packages/x']) })).toEqual([]);
    expect(findOffenders({ packages, allowlist: new Set() })).toHaveLength(1);
  });

  it('ships with an EMPTY allowlist — an entry re-arms a self-contradicting artifact', () => {
    expect([...ALLOWLIST]).toEqual([]);
  });
});

describe('check-tracked-src-entry-dist declaresDist', () => {
  it.each([
    ['exports subpath', { exports: { '.': './dist/index.js' } }],
    ['main', { main: './dist/index.js' }],
    ['module', { module: './dist/index.mjs' }],
    ['types', { types: './dist/index.d.ts' }],
    ['bin', { bin: { cli: './dist/cli.js' } }],
    ['files', { files: ['dist'] }],
    ['publishConfig', { publishConfig: { directory: 'dist' } }],
  ])('treats a dist reference in %s as CONSUMED', (_label, pkgJson) => {
    expect(declaresDist(pkgJson)).toBe(true);
  });

  it('does not fire on a substring — `redistribute` is not `dist`', () => {
    // The whole guard hangs on this predicate, and a naive `includes('dist')` would
    // silently exempt any package whose entrypoint merely contains those letters,
    // turning a real offender into a pass.
    expect(declaresDist({ main: './lib/redistribute.js' })).toBe(false);
    expect(declaresDist({ main: './src/distance.ts' })).toBe(false);
  });

  it('reports src-as-entry manifests as NOT consuming dist', () => {
    expect(declaresDist(SRC_ENTRY)).toBe(false);
    expect(declaresDist({})).toBe(false);
  });
});

describe('check-tracked-src-entry-dist against the real tree', () => {
  it('the live repo has zero src-entry packages tracking dist/', () => {
    // Re-runs the invariant in-suite, so a regression is caught by `test:affected`
    // and not only by the standalone lint leg.
    const out = execFileSync('node', ['scripts/check-tracked-src-entry-dist.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('✓ check-tracked-src-entry-dist');
  });
});
