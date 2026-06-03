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

describe('runGitSync (real git, with a submodule) — P-007 submodule-push-first', () => {
  let root: string;
  let superOrigin: string; // bare superproject origin
  let subOrigin: string; // bare submodule origin
  let repo: string; // the "harness" working clone (with submodule checked out)

  // file:// submodule add/update is blocked by default (CVE) — allow it in setup.
  const allowFile = ['-c', 'protocol.file.allow=always'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-sub-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    // seed the submodule's origin/main
    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    // seed the superproject with the submodule at libs/sub
    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    // the harness working clone, with the submodule checked out
    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pushes the submodule branch to origin FIRST, then bumps+pushes the superproject pointer', () => {
    // dirty the submodule AND the superproject
    writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      expect(out.status).toBe('synced');
      if (out.status === 'synced') expect(out.pushed).toBe(true);

      // submodule origin received the sub commit (pushed to main from detached HEAD)
      expect(git(subOrigin, 'log', '--format=%s', 'main')).toMatch(/auto-commit test/);
      // superproject origin received the super commit
      expect(git(superOrigin, 'log', '--format=%s', 'main')).toMatch(/auto-commit test/);

      // the committed superproject pointer == the submodule's pushed HEAD (fresh clone resolves the pin)
      const subHead = git(join(repo, 'libs/sub'), 'rev-parse', 'HEAD');
      const pointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
      expect(pointer).toBe(subHead);
      // and that submodule commit exists on the submodule's origin (pin is reachable remotely)
      expect(() => git(subOrigin, 'cat-file', '-e', `${subHead}^{commit}`)).not.toThrow();
    });
  });

  it('reconciles a DIVERGED submodule (behind its origin) via fetch+merge+push instead of erroring', () => {
      // a peer advances the submodule's origin → the harness submodule is now behind
      const subOther = join(root, 'subother');
      git(root, 'clone', subOrigin, subOther);
      configUser(subOther);
      writeFileSync(join(subOther, 'peer.txt'), 'peer-sub-change\n');
      git(subOther, 'add', '-A');
      git(subOther, 'commit', '--no-verify', '-m', 'peer sub change');
      git(subOther, 'push', 'origin', 'main');

      // local change in the submodule → diverged (local commit on a now-behind base)
      writeFileSync(join(repo, 'libs/sub', 'local-sub.txt'), 'local-sub-change\n');

      return runGitSync('test', { repoPath: repo }).then((out) => {
        // the OLD pipeline returned {status:'error'} (non-fast-forward); now it merges
        expect(out.status).not.toBe('error');
        // both the peer's and the local submodule commit are now on the submodule origin
        const subOriginFiles = git(subOrigin, 'ls-tree', '-r', '--name-only', 'main');
        expect(subOriginFiles).toContain('peer.txt');
        expect(subOriginFiles).toContain('local-sub.txt');
      });
    });
});
