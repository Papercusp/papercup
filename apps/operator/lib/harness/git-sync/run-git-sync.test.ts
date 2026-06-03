import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitSync } from './run-git-sync';

/** Run git synchronously for test setup; throws on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function configUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@papercusp.local');
  git(repo, 'config', 'user.name', 'git-sync test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

describe('runGitSync (real git, no submodule)', () => {
  let root: string;
  let originDir: string; // bare origin
  let repo: string; // the "harness" working clone

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    // seed an initial commit onto origin/main
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'file.txt'), 'line1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    // the harness working clone
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cfg = { pushSubmodules: false } as const;
  const originLog = () => git(originDir, 'log', '--format=%s', 'main');

  it('commits a dirty tree and pushes it to origin (happy path)', async () => {
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toBe(true);
    // origin received the auto-commit
    expect(originLog()).toMatch(/auto-commit test/);
    // working tree is clean after sync
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('returns "nothing" on a clean, up-to-date tree', async () => {
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('nothing');
  });

  it('commits locally but does not push when push:false', async () => {
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    const before = originLog();
    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });
    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toBe(false);
    expect(originLog()).toBe(before); // origin untouched
    expect(git(repo, 'log', '--format=%s', '-1')).toMatch(/auto-commit test/); // committed locally
  });

  it('on a divergent conflict: aborts to a CLEAN tree and reports conflicted files', async () => {
    // a second clone pushes a conflicting change to origin/main
    const other = join(root, 'other');
    git(root, 'clone', originDir, other);
    configUser(other);
    writeFileSync(join(other, 'file.txt'), 'OTHER-EDIT\n');
    git(other, 'add', '-A');
    git(other, 'commit', '--no-verify', '-m', 'other change');
    git(other, 'push', 'origin', 'main');

    // the harness repo edits the SAME line, then syncs → merge conflict
    writeFileSync(join(repo, 'file.txt'), 'LOCAL-EDIT\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('conflict');
    if (out.status === 'conflict') expect(out.conflictedFiles).toContain('file.txt');
    // tree must be clean (not mid-merge) — agents must never see a conflicted tree
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // no merge in progress
    let inMerge = false;
    try { git(repo, 'rev-parse', '--verify', 'MERGE_HEAD'); inMerge = true; } catch { inMerge = false; }
    expect(inMerge).toBe(false);
    // local commit is preserved
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('LOCAL-EDIT\n');
  });
});
