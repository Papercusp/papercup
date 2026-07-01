/**
 * Regression test for the non-repo temp-dir helper (EI-5826 / the EI-5541 class).
 *
 * The capability file-tool tests need an "uncoordinated" path (no `.git`
 * ancestor) so guardFileLock runs the body without identity/PG. A bare
 * `mkdtempSync(os.tmpdir())` silently breaks when the suite runner's TMPDIR
 * resolves INSIDE this monorepo — the temp dir then inherits the monorepo `.git`
 * and the path is treated as coordinated. This test arms exactly that trap and
 * proves mkNonRepoTmpDir stays repo-free regardless.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasGitAncestor, mkNonRepoTmpDir } from './non-repo-tmpdir';

describe('hasGitAncestor', () => {
  it('detects a `.git` ancestor', () => {
    const root = mkdtempSync(join('/tmp', 'nrt-root-'));
    try {
      mkdirSync(join(root, '.git'));
      const child = join(root, 'a', 'b');
      mkdirSync(child, { recursive: true });
      expect(hasGitAncestor(child)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when no `.git` ancestor exists', () => {
    const root = mkdtempSync(join('/tmp', 'nrt-clean-'));
    try {
      expect(hasGitAncestor(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mkNonRepoTmpDir', () => {
  const savedTmpdir = process.env.TMPDIR;
  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
  });

  it('returns a dir with no `.git` ancestor even when TMPDIR points inside a repo', () => {
    // Arm the EI-5826 trap: TMPDIR set to an in-repo path (a `.git` ancestor).
    const fakeRepo = mkdtempSync(join('/tmp', 'nrt-fakerepo-'));
    const inRepoTmp = join(fakeRepo, 'tmp');
    try {
      mkdirSync(join(fakeRepo, '.git'));
      mkdirSync(inRepoTmp);
      process.env.TMPDIR = inRepoTmp; // os.tmpdir() now resolves inside fakeRepo
      expect(hasGitAncestor(tmpdir())).toBe(true); // precondition: trap is armed

      const dir = mkNonRepoTmpDir('nrt-');
      try {
        expect(existsSync(dir)).toBe(true);
        expect(hasGitAncestor(dir)).toBe(false); // the fix: still repo-free
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});
