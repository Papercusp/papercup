/**
 * scripts/source-preview.mjs --target public — plan open-source-release-2026-09-29
 * P-002 / P-003 (and the LICENSE half of P-007).
 *
 * The public target publishes the same gated public-safe cut as the private preview,
 * but (a) under the Elastic License 2.0, with LICENSE + a license NOTICE at the root,
 * (b) APPEND-ONLY: each push is one new commit whose parent is the current public
 * main, pushed without --force, so forks and pull requests keep a shared history,
 * and (c) never to the preview repository (and the preview never to the public one).
 *
 * The remote is a local bare repository under tmpdir and the gate is injected, so
 * these cases pin the contract without network or scanners.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PUBLIC_LICENSE_PATH,
  assertRemoteMatchesTarget,
  checkDrift,
  exportSnapshot,
  pushSnapshot,
  readLicense,
  resolveTarget,
} from '../../../scripts/source-preview.mjs';
import { childEnv, git, makeSuperproject, write, type Superproject } from './source-preview.fixture';

let tmp: string;
let fx: Superproject;
let bare: string;
let remote: string;

const passing = async () => ({ ok: true, exitCode: 0, results: [] });

function remoteGit(args: string[]): string {
  const r = spawnSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const opts = (extra = {}) => ({ repoRoot: fx.repo, ref: 'main', remote, target: 'public', env: childEnv(), ...extra });

function commitChange(rel: string, body: string, msg: string): string {
  write(fx.repo, rel, body);
  git(fx.repo, ['add', '-A', '-f']);
  git(fx.repo, ['commit', '-q', '-m', msg]);
  return git(fx.repo, ['rev-parse', 'HEAD']);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-public-test-'));
  fx = makeSuperproject(tmp);
  bare = join(tmp, 'public.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  remote = `file://${bare}`;
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('public target — the two repositories never cross', () => {
  it('refuses to publish the public target to the preview repository, and vice versa', () => {
    expect(() => assertRemoteMatchesTarget(resolveTarget('public'), 'https://github.com/Papercusp/papercusp-preview.git')).toThrow(/preview repository/);
    expect(() => assertRemoteMatchesTarget(resolveTarget('public'), 'git@github.com:papercusp/papercusp-preview')).toThrow(/preview repository/);
    expect(() => assertRemoteMatchesTarget(resolveTarget('preview'), 'https://github.com/Papercusp/papercusp.git')).toThrow(/public repository/);
    expect(() => assertRemoteMatchesTarget(resolveTarget('public'), 'https://github.com/Papercusp/papercusp.git')).not.toThrow();
    expect(() => resolveTarget('papercup')).toThrow(/unknown target/);
  });

  it('pushSnapshot refuses a crossed remote before exporting anything', async () => {
    await expect(pushSnapshot(opts({ remote: 'https://github.com/Papercusp/papercusp-preview.git', confirm: true, gate: passing })))
      .rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('public target — licensed export', () => {
  it('ships the Elastic License 2.0 text verbatim plus a license NOTICE, and names the target in MANIFEST.json', async () => {
    const out = join(tmp, 'public-export');
    const { manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, target: 'public', env: childEnv() });
    expect(manifest).toMatchObject({ target: 'public', source: { commit: fx.commit } });
    expect(readFileSync(join(out, 'LICENSE'), 'utf8')).toBe(readFileSync(PUBLIC_LICENSE_PATH, 'utf8'));
    const notice = readFileSync(join(out, 'NOTICE'), 'utf8');
    expect(notice).toContain('Elastic License 2.0');
    expect(notice).not.toMatch(/EVALUATION ONLY/);
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('Elastic License 2.0');
    expect(readme).not.toMatch(/replaced wholesale/);
  }, 120_000);

  it('the preview export stays evaluation-only and carries no LICENSE', async () => {
    const out = join(tmp, 'preview-export');
    const { manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, env: childEnv() });
    expect(manifest.target).toBe('preview');
    expect(readFileSync(join(out, 'NOTICE'), 'utf8')).toMatch(/EVALUATION ONLY/);
    expect(() => readFileSync(join(out, 'LICENSE'))).toThrow();
  }, 120_000);

  it('refuses a missing or wrong LICENSE for the public target', () => {
    expect(() => readLicense(join(tmp, 'nope'))).toThrow(/needs its LICENSE/);
    const mit = join(tmp, 'MIT');
    writeFileSync(mit, 'MIT License\n\nPermission is hereby granted…\n');
    expect(() => readLicense(mit)).toThrow(/not the Elastic License 2.0/);
    expect(readLicense(PUBLIC_LICENSE_PATH)).toMatch(/^Elastic License 2\.0/);
  });
});

describe('public target — append-only history', () => {
  it('the first confirmed push creates the initial commit', async () => {
    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, parent: null, commit: fx.commit });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('1');
    expect(remoteGit(['log', '-1', '--format=%an <%ae>', 'main'])).toBe('Papercusp <public-export@papercusp.invalid>');
    expect(remoteGit(['show', 'main:LICENSE'])).toMatch(/^Elastic License 2\.0/);
    expect(await checkDrift(opts())).toMatchObject({ inSync: true });
  }, 120_000);

  it('does not push when already in sync', async () => {
    const before = remoteGit(['rev-parse', 'main']);
    expect(await pushSnapshot(opts({ confirm: true, gate: passing }))).toMatchObject({ pushed: false, reason: 'in-sync' });
    expect(remoteGit(['rev-parse', 'main'])).toBe(before);
  }, 120_000);

  it('a shipped change is published as a NEW commit on top of the previous one', async () => {
    const first = remoteGit(['rev-parse', 'main']);
    const head = commitChange('apps/operator/src/index.ts', 'export const x = 3;\n', 'ship a change');
    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, parent: first, commit: head });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('2');
    expect(remoteGit(['rev-parse', 'main^'])).toBe(first);
    expect(remoteGit(['show', 'main:apps/operator/src/index.ts'])).toBe('export const x = 3;');
  }, 180_000);

  it('builds on a commit someone else pushed instead of erasing it', async () => {
    const clone = join(tmp, 'contributor');
    spawnSync('git', ['clone', '-q', remote, clone]);
    write(clone, 'CONTRIBUTED.md', 'from a pull request\n');
    git(clone, ['add', 'CONTRIBUTED.md']);
    git(clone, ['-c', 'user.name=c', '-c', 'user.email=c@example.invalid', 'commit', '-q', '-m', 'merged PR']);
    git(clone, ['push', '-q', 'origin', 'HEAD:main']);
    const contributed = remoteGit(['rev-parse', 'main']);

    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, parent: contributed });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('4');
    // The history keeps the contributed commit; the tree is the export again (the PR's
    // change reaches the public tree only once it is ported into the source repo).
    expect(remoteGit(['merge-base', '--is-ancestor', contributed, 'main']) ).toBe('');
    expect(spawnSync('git', ['--git-dir', bare, 'cat-file', '-e', 'main:CONTRIBUTED.md']).status).not.toBe(0);
  }, 180_000);
});
