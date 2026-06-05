import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realGitCommit } from '../commit-reproject-real';

/**
 * P-016 — the git wiring of commit → reproject, exercised against a REAL temp git
 * repo (no PG): a repo path commits + returns a SHA; a no-op edit skips the commit;
 * a non-repo (requiresRepo:false target) returns null without throwing.
 */

let dir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-real-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('realGitCommit', () => {
  it('commits a .papercusp prompt edit in a git repo and returns the new SHA', async () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    // a base commit so HEAD exists
    writeFileSync(join(dir, 'README'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    const head0 = git(dir, 'rev-parse', 'HEAD');

    mkdirSync(join(dir, '.papercusp', 'prompts'), { recursive: true });
    writeFileSync(join(dir, '.papercusp', 'prompts', 'worker.md'), 'new prompt');
    const sha = await realGitCommit(dir, ['.papercusp/prompts/worker.md'], 'gym: accept worker prompt');

    expect(sha).toBeTruthy();
    expect(sha).not.toBe(head0); // a new commit was made
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(dir, 'log', '-1', '--pretty=%s')).toBe('gym: accept worker prompt');
  });

  it('a no-op edit (content unchanged) makes NO new commit but returns current HEAD', async () => {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    mkdirSync(join(dir, '.papercusp', 'prompts'), { recursive: true });
    writeFileSync(join(dir, '.papercusp', 'prompts', 'worker.md'), 'same');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base with prompt');
    const head0 = git(dir, 'rev-parse', 'HEAD');

    // rewrite the SAME content → nothing staged → no new commit
    writeFileSync(join(dir, '.papercusp', 'prompts', 'worker.md'), 'same');
    const sha = await realGitCommit(dir, ['.papercusp/prompts/worker.md'], 'no-op');

    expect(sha).toBe(head0); // unchanged HEAD, not a new commit
  });

  it('returns null for a non-git dir (a requiresRepo:false / repo-less target)', async () => {
    // dir is a plain temp dir, never `git init`ed
    writeFileSync(join(dir, 'x.md'), 'y');
    const sha = await realGitCommit(dir, ['x.md'], 'should not commit');
    expect(sha).toBeNull();
  });
});
