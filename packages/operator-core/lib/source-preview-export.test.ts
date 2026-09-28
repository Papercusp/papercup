/**
 * scripts/source-preview.mjs export — plan dhh-source-preview-2026-09-28 R-1/R-3/R-4
 * (P-001, P-002).
 *
 * The preview must be the SAME public-safe cut the desktop installer ships
 * (sidecar/source.tar.zst), minus node_modules — not a second, hand-kept list.
 * The parity case proves that by running the shared selection library in its
 * INSTALLER mode over the same clean tree and comparing file sets, so a future
 * edit that forks the two selections fails here.
 *
 * Every case drives a synthetic superproject under tmpdir; nothing touches the
 * shared checkout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADDED_FILES,
  SELECTION_LIB,
  allowlistTops,
  exportSnapshot,
  materializeCommit,
  sourceYear,
} from '../../../scripts/source-preview.mjs';
import { DROPPED, SHIPPED, childEnv, git, makeSuperproject, write, type Superproject } from './source-preview.fixture';

let tmp: string;
let fx: Superproject;
let out: string;
let manifest: Awaited<ReturnType<typeof exportSnapshot>>['manifest'];

function listFiles(dir: string): string[] {
  const acc: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else acc.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return acc.sort();
}

/** What the INSTALLER selection would put in source.tar.zst for the same clean tree. */
function installerListing(mono: string): string[] {
  const r = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    '. "$1"',
    'source_tree_selection "$(dirname "$1")/.." "$2" installer',
    'tar "${SELECTION_EXCLUDES[@]}" -C "$2" -cf - "${SELECTION_INCLUDES[@]}" | tar -tf -',
  ].join('\n'), '_', SELECTION_LIB, mono], { encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '')).sort();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-export-test-'));
  fx = makeSuperproject(tmp);
  out = join(tmp, 'export');
  ({ manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, env: childEnv() }));
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('source-preview export — R-1 selection parity with the installer cut', () => {
  it('ships every selected tracked file, including the submodule contents', () => {
    const files = listFiles(out);
    for (const p of SHIPPED) expect(files, p).toContain(p);
  });

  it('drops every excluded class, node_modules at any depth, and all git metadata', () => {
    const files = listFiles(out);
    for (const p of DROPPED) expect(files, p).not.toContain(p);
    expect(files.filter((f) => f.split('/').includes('node_modules'))).toEqual([]);
    expect(files.filter((f) => f.split('/').includes('.git'))).toEqual([]);
  });

  it('equals the installer selection over the same clean commit, minus node_modules', () => {
    const mono = join(tmp, 'parity-mono');
    rmSync(mono, { recursive: true, force: true });
    spawnSync('mkdir', ['-p', mono]);
    materializeCommit({ repo: fx.repo, sha: fx.commit, dest: mono, allow: allowlistTops() });
    const installer = installerListing(mono).filter((f) => !f.split('/').includes('node_modules'));
    const preview = listFiles(out).filter((f) => !ADDED_FILES.includes(f));
    expect(preview).toEqual(installer);
    // The comparison is only meaningful if the installer side really shipped node_modules.
    expect(installerListing(mono)).toContain('node_modules/leftpad/index.js');
  });
});

describe('source-preview export — R-3 pinned, history-free snapshot', () => {
  it('records the superproject commit and every exported submodule gitlink in MANIFEST.json', () => {
    const onDisk = JSON.parse(readFileSync(join(out, 'MANIFEST.json'), 'utf8'));
    expect(onDisk).toEqual(manifest);
    expect(manifest.source.commit).toBe(fx.commit);
    expect(manifest.submodules).toEqual([{ path: 'libs/papercusp', sha: fx.subCommit }]);
    expect(manifest.fileCount).toBe(listFiles(out).length - ADDED_FILES.length);
  });

  it('refuses an unresolvable gitlink and leaves no export behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-ghost-'));
    try {
      const ghost = makeSuperproject(root);
      git(ghost.repo, ['update-index', '--cacheinfo', `160000,${'1'.repeat(40)},libs/papercusp`]);
      git(ghost.repo, ['commit', '-q', '-m', 'point the gitlink at a commit that does not exist']);
      const target = join(root, 'export');
      await expect(exportSnapshot({ repoRoot: ghost.repo, ref: 'main', out: target, env: childEnv() }))
        .rejects.toThrow(/unresolvable gitlink libs\/papercusp/);
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(root).filter((n) => n.startsWith('export.partial'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('is deterministic: exporting the same commit twice yields identical bytes', async () => {
    const again = join(tmp, 'export-again');
    await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: again, env: childEnv() });
    const a = listFiles(out);
    expect(listFiles(again)).toEqual(a);
    for (const f of a) expect(readFileSync(join(again, f)), f).toEqual(readFileSync(join(out, f)));
  }, 120_000);

  it('exports only committed content, never uncommitted working-tree edits', async () => {
    write(fx.repo, 'apps/operator/src/index.ts', 'export const x = "uncommitted";\n');
    try {
      const snap = join(tmp, 'export-dirty');
      await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: snap, env: childEnv() });
      expect(readFileSync(join(snap, 'apps/operator/src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      git(fx.repo, ['checkout', '--', 'apps/operator/src/index.ts']);
    }
  }, 120_000);
});

describe('source-preview export — R-4 evaluation notice', () => {
  it('writes a NOTICE restricting use to evaluation and forbidding redistribution', () => {
    const notice = readFileSync(join(out, 'NOTICE'), 'utf8');
    expect(notice).toMatch(/EVALUATION ONLY/);
    expect(notice).toMatch(/may not redistribute/);
    expect(notice).toContain(fx.commit);
  });

  it('dates the copyright from real history, not a fixed-date repair-queue admission commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-year-'));
    try {
      const repo = makeSuperproject(root).repo;
      const real = Number(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD']));
      const fixed = '2000-01-01T00:00:00Z';
      const r = spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'admit 1 path(s) onto frozen lineage'], {
        encoding: 'utf8',
        env: childEnv({
          GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_AUTHOR_DATE: fixed,
          GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@example.invalid', GIT_COMMITTER_DATE: fixed,
        }),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD'])).toBe('2000');
      expect(sourceYear(repo, git(repo, ['rev-parse', 'HEAD']))).toBe(real);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes START-HERE.md naming the snapshot and the workspaces it contains', () => {
    const start = readFileSync(join(out, 'START-HERE.md'), 'utf8');
    expect(start).toContain(fx.commit);
    expect(start).toContain('`apps/operator`');
    expect(start).toContain('the operator host');
  });
});
