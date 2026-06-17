import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitSync, type RunGit } from './run-git-sync';
import type { ContentDetector } from '../../content-lint/registry';

/** A test content detector that quarantines any matched file whose text contains BROKEN. */
const brokenDetector: ContentDetector = {
  key: 'fake-broken',
  glob: '**/*.md',
  matches: (f) => f.endsWith('.md'),
  detect: (_f, text) => (text.includes('BROKEN') ? 'contains BROKEN' : null),
  fixerRole: 'content-fixer',
};

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
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    // origin received the auto-commit
    expect(originLog()).toMatch(/auto-commit test/);
    // working tree is clean after sync
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('returns "nothing" on a clean, up-to-date tree', async () => {
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('nothing');
  });

  // EI-438 content guard (P-001/P-002/P-008): the broken file is EXCLUDED from the
  // commit + left dirty (quarantine, don't stall) while every clean file still syncs.
  it('content guard: commits the clean files, EXCLUDES + reports a broken one (quarantine, dont stall)', async () => {
    writeFileSync(join(repo, 'good.txt'), 'fine\n');
    writeFileSync(join(repo, 'bad.md'), 'this is BROKEN\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out.status).toBe('synced'); // the clean file synced despite the broken sibling
    expect(out.contentErrors).toEqual([
      { scope: 'superproject', file: 'bad.md', detectorKey: 'fake-broken', error: 'contains BROKEN', fixerRole: 'content-fixer' },
    ]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('good.txt'); // the clean file reached origin…
    expect(originFiles).not.toContain('bad.md'); // …but the broken one did NOT (excluded)
    // the broken file is left dirty/uncommitted in the working tree for the content-fixer
    expect(git(repo, 'status', '--porcelain')).toContain('bad.md');
  });

  it('content guard: the NEXT tick commits the file once it passes the detector (self-heal)', async () => {
    writeFileSync(join(repo, 'bad.md'), 'this is BROKEN\n');
    await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('bad.md');

    // the content-fixer repairs the file (no longer BROKEN) → the next tick commits it
    writeFileSync(join(repo, 'bad.md'), 'this is fine now\n');
    const out2 = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });

    expect(out2.status).toBe('synced');
    expect(out2.contentErrors).toEqual([]);
    expect(git(originDir, 'ls-tree', '-r', '--name-only', 'main')).toContain('bad.md'); // now it reaches origin
    expect(git(repo, 'status', '--porcelain')).toBe(''); // tree clean
  });

  it('content guard is a no-op when no detector matches the dirty files (clean tree commits as today)', async () => {
    writeFileSync(join(repo, 'plain.txt'), 'no detector targets .txt\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg, contentDetectors: [brokenDetector] });
    expect(out.status).toBe('synced');
    expect(out.contentErrors).toEqual([]);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  // G20: the joiner-side push:false runtime invariant — a dirty tree COMMITS
  // locally but origin/main must be byte-for-byte UNCHANGED. Asserts via the
  // origin tip SHA (not just the commit-subject log) and proves the fresh local
  // commit is genuinely absent from origin.
  it('commits locally but does not push when push:false (origin/main SHA unchanged)', async () => {
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    const originTipBefore = git(originDir, 'rev-parse', 'main');
    const localTipBefore = git(repo, 'rev-parse', 'HEAD');

    const out = await runGitSync('test', { repoPath: repo, config: { push: false, pushSubmodules: false } });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toEqual([]);

    // a NEW local commit exists (HEAD advanced) and carries the auto-commit subject
    const localTipAfter = git(repo, 'rev-parse', 'HEAD');
    expect(localTipAfter).not.toBe(localTipBefore);
    expect(git(repo, 'log', '--format=%s', '-1')).toMatch(/auto-commit test/);

    // origin/main is UNCHANGED — same tip SHA, and the commit-subject log is identical
    expect(git(originDir, 'rev-parse', 'main')).toBe(originTipBefore);
    expect(originLog()).not.toMatch(/auto-commit test/);
    // and the bare origin does NOT have the fresh local commit object reachable on main
    expect(() => git(originDir, 'merge-base', '--is-ancestor', localTipAfter, 'main')).toThrow();
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
    if (out.status === 'conflict') {
      expect(out.conflicts.map((c) => c.scope)).toContain('superproject');
      expect(out.conflicts.find((c) => c.scope === 'superproject')?.conflictedFiles).toContain('file.txt');
    }
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
      if (out.status === 'synced') {
        expect(out.pushed).toContain('superproject');
        expect(out.pushed).toContain('libs/sub');
      }

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
        expect(out.status).toBe('synced');
        if (out.status === 'synced') expect(out.pushed).toContain('libs/sub');
        // both the peer's and the local submodule commit are now on the submodule origin
        const subOriginFiles = git(subOrigin, 'ls-tree', '-r', '--name-only', 'main');
        expect(subOriginFiles).toContain('peer.txt');
        expect(subOriginFiles).toContain('local-sub.txt');
      });
    });

    it('GAP-4: a submodule unreachable while ahead → errors + DEFERS the superproject (no broken gitlink)', () => {
      // dirty the submodule (→ ahead after its local commit) and the superproject
      writeFileSync(join(repo, 'libs/sub', 'sub-new.txt'), 'sub-v2\n');
      writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');
      // break the submodule's origin so its fetch/push fails mid-pass
      git(join(repo, 'libs/sub'), 'remote', 'set-url', 'origin', join(root, 'gone.git'));

      return runGitSync('test', { repoPath: repo }).then((out) => {
        expect(out.status).toBe('error');
        if (out.status === 'error') {
          expect(out.errors.map((e) => e.scope)).toContain('libs/sub');
          // the superproject must NOT be pushed — its gitlink would point at an unpushed
          // submodule commit a fresh clone can't resolve.
          expect(out.pushed).not.toContain('superproject');
        }
        expect(git(superOrigin, 'log', '--format=%s', 'main')).not.toMatch(/auto-commit test/);
      });
    });
});

describe('runGitSync (real git, two submodules) — GAP-1 continue-past-conflict', () => {
  let root: string;
  let superOrigin: string;
  let subAOrigin: string; // will be made to conflict
  let subBOrigin: string; // clean, ahead → must still push despite A's conflict
  let repo: string;
  const allowFile = ['-c', 'protocol.file.allow=always'];

  const seedSub = (origin: string, name: string): void => {
    const seed = join(root, `${name}seed`);
    git(root, 'clone', origin, seed);
    configUser(seed);
    writeFileSync(join(seed, `${name}.txt`), `${name}-v1\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', `${name} init`);
    git(seed, 'push', '-u', 'origin', 'main');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-2sub-'));
    superOrigin = join(root, 'super-origin.git');
    subAOrigin = join(root, 'subA-origin.git');
    subBOrigin = join(root, 'subB-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subAOrigin);
    git(root, 'init', '--bare', '-b', 'main', subBOrigin);
    seedSub(subAOrigin, 'subA');
    seedSub(subBOrigin, 'subB');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subAOrigin, 'libs/subA');
    git(superseed, ...allowFile, 'submodule', 'add', subBOrigin, 'libs/subB');
    configUser(join(superseed, 'libs/subA'));
    configUser(join(superseed, 'libs/subB'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + 2 submodules');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/subA'));
    configUser(join(repo, 'libs/subB'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a conflict in one submodule does NOT block the sibling push, and defers the superproject', () => {
    // subA: a peer pushes a conflicting line to origin; local edits the SAME line → conflict
    const aOther = join(root, 'subAother');
    git(root, 'clone', subAOrigin, aOther);
    configUser(aOther);
    writeFileSync(join(aOther, 'subA.txt'), 'PEER-EDIT\n');
    git(aOther, 'add', '-A');
    git(aOther, 'commit', '--no-verify', '-m', 'peer conflicting change');
    git(aOther, 'push', 'origin', 'main');
    writeFileSync(join(repo, 'libs/subA', 'subA.txt'), 'LOCAL-EDIT\n'); // same line → will conflict

    // subB: a clean local change → must be pushed despite subA conflicting
    writeFileSync(join(repo, 'libs/subB', 'subB-new.txt'), 'subB-v2\n');
    // dirty the superproject too → must NOT be pushed while subA is unreconciled
    writeFileSync(join(repo, 'super-new.txt'), 'super-v2\n');

    return runGitSync('test', { repoPath: repo }).then((out) => {
      // overall: conflict, but the sibling + nothing-after is reported precisely
      expect(out.status).toBe('conflict');
      if (out.status === 'conflict') {
        expect(out.conflicts.map((c) => c.scope)).toContain('libs/subA');
        expect(out.conflicts.find((c) => c.scope === 'libs/subA')?.conflictedFiles).toContain('subA.txt');
        // GAP-1: the clean sibling pushed despite subA's conflict
        expect(out.pushed).toContain('libs/subB');
        // GAP-1: the superproject was DEFERRED (a submodule is unreconciled)
        expect(out.pushed).not.toContain('superproject');
      }
      // subB origin actually received the push
      expect(git(subBOrigin, 'log', '--format=%s', 'main')).toMatch(/auto-commit test/);
      // superproject origin was NOT advanced (would publish an unresolvable subA pointer)
      expect(git(superOrigin, 'log', '--format=%s', 'main')).not.toMatch(/auto-commit test/);
      // subA tree is clean (merge aborted) — local edit preserved
      expect(git(join(repo, 'libs/subA'), 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(readFileSync(join(repo, 'libs/subA', 'subA.txt'), 'utf8')).toBe('LOCAL-EDIT\n');
    });
  });
});

describe('runGitSync — EI-18 oversized-blob guard', () => {
  let root: string;
  let originDir: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-oversized-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'file.txt'), 'line1\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A tiny limit so tests don't write real 95MB files.
  const cfg = { pushSubmodules: false, maxBlobBytes: 1024 } as const;

  it('EXCLUDES an oversized file from the auto-commit, still syncs the rest, and reports it', async () => {
    writeFileSync(join(repo, 'small.txt'), 'ok\n');
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(2048, 1));

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') expect(out.pushed).toContain('superproject');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big.bin', sizeBytes: 2048 }]);

    // origin received small.txt but NOT the unpushable blob
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('big.bin');

    // the file is untouched on disk, just left uncommitted (untracked)
    expect(readFileSync(join(repo, 'big.bin')).length).toBe(2048);
    expect(git(repo, 'status', '--porcelain')).toContain('?? big.bin');
  });

  it('an oversized-ONLY dirty tree commits nothing ("nothing") but still reports the file', async () => {
    writeFileSync(join(repo, 'big.bin'), Buffer.alloc(4096, 1));
    const before = git(originDir, 'log', '--format=%s', 'main');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('nothing');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big.bin', sizeBytes: 4096 }]);
    expect(git(originDir, 'log', '--format=%s', 'main')).toBe(before); // origin untouched
  });

  it('a clean tree under the limit reports no oversized files', async () => {
    writeFileSync(join(repo, 'fits.txt'), 'small enough\n');
    const out = await runGitSync('test', { repoPath: repo, config: cfg });
    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([]);
  });

  it('P-001: EXCLUDES an oversized file inside an UNTRACKED directory (-uall; the EI-18 bypass)', async () => {
    // A brand-new directory: without `-uall`, `git status --porcelain` collapses it to a
    // single `?? newdir/` entry whose lstat is a directory and is skipped — so the
    // oversized file inside is invisible, gets committed by `add -A`, and wedges the push
    // forever (the original EI-18 incident class). With `-uall` each file is listed.
    mkdirSync(join(repo, 'newdir'));
    writeFileSync(join(repo, 'newdir', 'big.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'small.txt'), 'ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'newdir/big.bin', sizeBytes: 2048 }]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('newdir/big.bin'); // the oversized blob never reached origin
  });

  it('oversized paths with spaces are excluded correctly (-z parsing + literal pathspec)', async () => {
    writeFileSync(join(repo, 'big file with spaces.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'small.txt'), 'ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: cfg });

    expect(out.status).toBe('synced');
    expect(out.oversized).toEqual([{ scope: 'superproject', path: 'big file with spaces.bin', sizeBytes: 2048 }]);
    const originFiles = git(originDir, 'ls-tree', '-r', '--name-only', 'main');
    expect(originFiles).toContain('small.txt');
    expect(originFiles).not.toContain('big file with spaces.bin');
  });
});

describe('runGitSync — EI-18 oversized in a SUBMODULE does not defer the superproject', () => {
  const allowFile = ['-c', 'protocol.file.allow=always'];
  let root: string;
  let superOrigin: string;
  let subOrigin: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-oversized-sub-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('submodule syncs WITHOUT the big file; superproject pointer still bumps + pushes', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-small.txt'), 'sub ok\n');
    writeFileSync(join(repo, 'libs/sub', 'sub-big.bin'), Buffer.alloc(2048, 1));
    writeFileSync(join(repo, 'super-new.txt'), 'super ok\n');

    const out = await runGitSync('test', { repoPath: repo, config: { maxBlobBytes: 1024 } });

    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toContain('libs/sub');
      expect(out.pushed).toContain('superproject'); // NOT deferred by the exclusion
    }
    expect(out.oversized).toEqual([{ scope: 'libs/sub', path: 'sub-big.bin', sizeBytes: 2048 }]);

    // the submodule's origin got the small file, never the big one
    const subFiles = git(subOrigin, 'ls-tree', '-r', '--name-only', 'main');
    expect(subFiles).toContain('sub-small.txt');
    expect(subFiles).not.toContain('sub-big.bin');

    // the pushed superproject pointer resolves on the submodule origin (no broken gitlink)
    const pointer = git(repo, 'rev-parse', 'HEAD:libs/sub');
    expect(() => git(subOrigin, 'cat-file', '-e', `${pointer}^{commit}`)).not.toThrow();
  });
});

describe('runGitSync — P-002 failure classification (injected git)', () => {
  /** A stub RunGit driven by a per-call decision fn — deterministic, no real git. */
  const fakeGit = (handle: (args: string[]) => { code: number; stdout?: string; stderr?: string }): RunGit =>
    async (args) => {
      const r = handle(args);
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

  it('P-002a: a commit failure is reported as error, NOT a phantom conflict', async () => {
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' }; // no oversized
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' }; // dirty
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('commit')) return { code: 1, stderr: "fatal: Unable to create '.git/index.lock': File exists" };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', { repoPath: '/fake', runGit: run, submodulePaths: [], config: { pushSubmodules: false } });
    expect(out.status).toBe('error'); // NOT 'conflict' — no merge-resolver dispatched at a phantom
    if (out.status === 'error') {
      expect(out.errors.map((e) => e.scope)).toContain('superproject');
      expect(out.errors[0].message).toMatch(/commit failed/i);
    }
  });

  it('P-002a: a commit that simply had nothing to commit (all-oversized) is NOT an error', async () => {
    // every dirty file was excluded as oversized → `git commit` exits non-zero with
    // "nothing to commit" — benign, must fall through to fetch/merge, not error.
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain -z -uall')) return { code: 0, stdout: '' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: ' M file.txt\n' };
      if (j.startsWith('add')) return { code: 0 };
      if (j.startsWith('commit')) return { code: 1, stdout: 'nothing to commit, working tree clean' };
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', { repoPath: '/fake', runGit: run, submodulePaths: [], config: { push: false, pushSubmodules: false } });
    expect(out.status).toBe('nothing'); // benign — not an error
  });

  it('P-002b: a failed merge with NO conflicted paths is classified error, not conflict', async () => {
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 0, stdout: 'main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' }; // clean tree
      if (j.startsWith('fetch')) return { code: 0 };
      if (j.startsWith('merge --no-edit')) return { code: 1, stderr: 'error: Your local changes to the following files would be overwritten by merge:\n  file.txt' };
      if (j.startsWith('diff --name-only --diff-filter=U')) return { code: 0, stdout: '' }; // NO unmerged paths
      if (j.startsWith('merge --abort')) return { code: 0 };
      return { code: 0, stdout: '' };
    });
    const out = await runGitSync('test', { repoPath: '/fake', runGit: run, submodulePaths: [], config: { pushSubmodules: false } });
    expect(out.status).toBe('error'); // NOT 'conflict' — nothing for a merge-resolver to merge
    if (out.status === 'error') expect(out.errors[0].message).toMatch(/merge failed \(no conflicted paths\)/);
  });

  it('P-004: a detached HEAD syncs to its OWN remote default (origin/HEAD → main), not cfg.branch', async () => {
    const fetched: string[] = [];
    const run = fakeGit((args) => {
      const j = args.join(' ');
      if (j.startsWith('symbolic-ref')) return { code: 1, stderr: 'fatal: ref HEAD is not a symbolic ref' }; // detached
      if (j.startsWith('rev-parse --abbrev-ref origin/HEAD')) return { code: 0, stdout: 'origin/main' };
      if (j.startsWith('status --porcelain')) return { code: 0, stdout: '' }; // clean
      if (j.startsWith('fetch')) { fetched.push(args.join(' ')); return { code: 0 }; }
      if (j.startsWith('merge')) return { code: 0, stdout: 'Already up to date.' };
      return { code: 0, stdout: '' };
    });
    // cfg.branch='staging' (the superproject's branch) must NOT be used for this detached repo.
    const out = await runGitSync('test', {
      repoPath: '/fake', runGit: run, submodulePaths: [],
      config: { push: false, pushSubmodules: false, branch: 'staging' },
    });
    expect(out.status).toBe('nothing'); // clean + up-to-date on main
    // it fetched origin MAIN (the remote default), never origin staging (cfg.branch)
    expect(fetched.join('|')).toContain('fetch origin main');
    expect(fetched.join('|')).not.toContain('staging');
  });
});
