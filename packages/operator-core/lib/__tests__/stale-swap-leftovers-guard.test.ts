/**
 * WI-6558 — repo-wide detection for abandoned `<live>.old.<pid>` directories.
 *
 * The fixtures exercise the mechanism, not this machine's current debris. The
 * regression that matters is safety: the detector must show whether the live
 * sibling is populated and must never remove either tree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — the executable .mjs guard intentionally has no declaration file.
import * as staleSwapLeftovers from '../../../../scripts/lib/stale-swap-leftovers.mjs';

const { findStaleSwapLeftovers, formatBytes, formatStaleSwapProblems } = staleSwapLeftovers;

interface StaleSwapProblem {
  path: string;
  liveSibling: {
    path: string;
    state: string;
    looksPopulated: boolean;
  };
}

const NOW_MS = Date.UTC(2026, 6, 28, 12, 0, 0);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wi6558-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeTree(
  relative: string,
  { ageMinutes = 60, files = { 'payload.bin': 2048 } }: { ageMinutes?: number; files?: Record<string, number> } = {},
) {
  const dir = join(root, relative);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes));
  }
  const modified = new Date(NOW_MS - ageMinutes * 60_000);
  utimesSync(dir, modified, modified);
  return dir;
}

const find = (maxAgeMinutes = 30): StaleSwapProblem[] =>
  findStaleSwapLeftovers({ repoRoot: root, maxAgeMinutes, nowMs: NOW_MS }) as StaleSwapProblem[];

describe('findStaleSwapLeftovers', () => {
  it('flags only backups older than the configured threshold', () => {
    makeTree('apps/operator/public/docs.old.1234', { ageMinutes: 31 });
    makeTree('apps/operator/public/assets.old.5678', { ageMinutes: 29 });

    expect(find().map((problem) => problem.path)).toEqual(['apps/operator/public/docs.old.1234']);
  });

  it('matches directories with an exact numeric PID suffix, not ordinary old names or files', () => {
    makeTree('valid.old.42');
    makeTree('migration.old.backup');
    makeTree('almost.old.42.extra');
    writeFileSync(join(root, 'source.old.99'), 'ordinary file');

    expect(find().map((problem) => problem.path)).toEqual(['valid.old.42']);
  });

  it('reports backup size and a populated live sibling without changing either tree', () => {
    makeTree('papercusp-desktop/src-tauri/sidecar.old.4037978', {
      files: { 'bin/node': 1536, 'apps/operator.js': 512 },
    });
    makeTree('papercusp-desktop/src-tauri/sidecar', {
      ageMinutes: 0,
      files: { 'PLACEHOLDER-README.txt': 64 },
    });

    const [problem] = find();
    expect(problem).toMatchObject({
      path: 'papercusp-desktop/src-tauri/sidecar.old.4037978',
      pid: 4037978,
      bytes: 2048,
      files: 2,
      liveSibling: {
        path: 'papercusp-desktop/src-tauri/sidecar',
        state: 'populated',
        looksPopulated: true,
        bytes: 64,
        files: 1,
      },
    });
    expect(readFileSync(join(root, problem.path, 'bin/node'))).toHaveLength(1536);
    expect(readFileSync(join(root, problem.liveSibling.path, 'PLACEHOLDER-README.txt'))).toHaveLength(64);
  });

  it('distinguishes missing and empty live siblings', () => {
    makeTree('one.old.11');
    makeTree('two.old.22');
    mkdirSync(join(root, 'two'));

    const problems = find();
    expect(problems[0].liveSibling).toMatchObject({ path: 'one', state: 'missing', looksPopulated: false });
    expect(problems[1].liveSibling).toMatchObject({ path: 'two', state: 'empty', looksPopulated: false });
  });

  it('prunes dependency, VCS, and compiler-output trees but scans normal source/submodule paths', () => {
    makeTree('node_modules/pkg/cache.old.1');
    makeTree('.git/objects/pack.old.2');
    makeTree('papercusp-desktop/src-tauri/target/cache.old.3');
    makeTree('papercusp-desktop/src-tauri/sidecar.old.4');

    expect(find().map((problem) => problem.path)).toEqual(['papercusp-desktop/src-tauri/sidecar.old.4']);
  });

  it('rejects an invalid threshold instead of silently disabling the guard', () => {
    expect(() => findStaleSwapLeftovers({ repoRoot: root, maxAgeMinutes: Number.NaN })).toThrow(
      /maxAgeMinutes must be a non-negative finite number/,
    );
  });
});

describe('formatStaleSwapProblems', () => {
  it('shows age, sizes, live state, and the no-blind-delete warning', () => {
    makeTree('docs.old.123', { ageMinutes: 90, files: { page: 1536 } });
    makeTree('docs', { ageMinutes: 0, files: { page: 256 } });

    const output = formatStaleSwapProblems(find());
    expect(output).toContain('docs.old.123: 90.0m old, 1.5 KiB, 1 file');
    expect(output).toContain('live sibling docs is populated, 256 B, 1 file');
    expect(output).toMatch(/only complete copy/);
    expect(output).toMatch(/never deletes/);
    expect(formatBytes(1024 ** 3)).toBe('1.0 GiB');
  });
});

describe('the live doctor wiring', () => {
  it('runs the class-level detector from npm run doctor', () => {
    const repoRoot = join(__dirname, '../../../..');
    const doctor = readFileSync(join(repoRoot, 'scripts/test-doctor.mjs'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

    expect(doctor).toMatch(/findStaleSwapLeftovers/);
    expect(doctor).toMatch(/no stale atomic-publish swap directories/);
    expect(pkg.scripts.doctor).toMatch(/test-doctor\.mjs/);
  });
});
