/**
 * WI-39377 — the wholesale-deletion guard.
 *
 * The bug being pinned: git-sync committed four SideStage submodules down to
 * zero-file trees and pushed them to GitHub, because nothing in the commit path
 * looks at the MAGNITUDE of a deletion set. The most important tests here are the
 * two CONTROLS at the bottom, which prove the guard is falsifiable: without them a
 * detector that returned `[]` unconditionally would pass every positive assertion.
 */
import { describe, it, expect } from 'vitest';
import {
  judgeDeletionSet,
  detectWholesaleDeletion,
  WHOLESALE_DELETION_RATIO,
  WHOLESALE_DELETION_MIN_TRACKED,
} from './wholesale-deletion-guard';
import type { RunGit } from './run-git-sync';

/** `git status --porcelain -z -uall` payload for a set of deleted paths. */
const porcelainDeleted = (paths: string[]) => paths.map((p) => ` D ${p}`).join('\0') + (paths.length ? '\0' : '');

/** A RunGit that answers the two commands the detector issues, and nothing else. */
function fakeGit({
  deleted,
  tracked,
  statusCode = 0,
  treeCode = 0,
}: {
  deleted: string[];
  tracked: string[];
  statusCode?: number;
  treeCode?: number;
}): RunGit {
  return async (args) => {
    if (args[0] === 'status') return { code: statusCode, stdout: porcelainDeleted(deleted), stderr: '' };
    if (args[0] === 'ls-tree') return { code: treeCode, stdout: tracked.join('\n'), stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

describe('judgeDeletionSet — the pure verdict', () => {
  it('calls a 100% deletion a wipe (the exact SideStage shape: 46/46 in libs/sse)', () => {
    const files = Array.from({ length: 46 }, (_, i) => `src/f${i}.ts`);
    const v = judgeDeletionSet(files, 46);
    expect(v.wipe).toBe(true);
    expect(v.ratio).toBe(1);
    expect(v.reason).toContain('46/46');
  });

  it('calls a deletion of the root package.json a wipe REGARDLESS of ratio', () => {
    // 1 of 100 files is 1% — far below the ratio — but losing package.json is what
    // made the submodule unresolvable and let the next sweep commit dist/ as source.
    const v = judgeDeletionSet(['package.json'], 100);
    expect(v.wipe).toBe(true);
    expect(v.packageDefiningDeleted).toEqual(['package.json']);
  });

  it('calls a deletion of the root .gitignore a wipe (that is what let dist/ get committed)', () => {
    const v = judgeDeletionSet(['.gitignore'], 100);
    expect(v.wipe).toBe(true);
    expect(v.packageDefiningDeleted).toEqual(['.gitignore']);
  });

  it('does NOT fire on an ordinary large refactor below the threshold', () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/old${i}.ts`);
    const v = judgeDeletionSet(files, 100); // 50%
    expect(v.wipe).toBe(false);
    expect(v.reason).toContain('below');
  });

  it('does NOT fire on a tiny repo where the ratio is meaningless', () => {
    // 1 of 1 file is 100% and completely ordinary.
    const v = judgeDeletionSet(['only.ts'], 1);
    expect(v.wipe).toBe(false);
    expect(v.trackedCount).toBeLessThan(WHOLESALE_DELETION_MIN_TRACKED);
  });

  it('does not fire when nothing is deleted', () => {
    expect(judgeDeletionSet([], 100).wipe).toBe(false);
  });

  it('treats a nested package.json as ordinary — only the repo ROOT one is decisive', () => {
    // A wipe removes the repo's own package.json at path "package.json". Deleting
    // some fixture's nested package.json must not trip the decisive branch.
    const v = judgeDeletionSet(['test/fixtures/pkg/package.json'], 100);
    expect(v.wipe).toBe(false);
    expect(v.packageDefiningDeleted).toEqual([]);
  });

  it('fires exactly AT the threshold, not just above it', () => {
    const n = Math.ceil(100 * WHOLESALE_DELETION_RATIO);
    const files = Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
    expect(judgeDeletionSet(files, 100).wipe).toBe(true);
  });
});

describe('detectWholesaleDeletion — the detector', () => {
  it('quarantines EVERY deleted path in a wipe, so add -A excludes them all', async () => {
    const tracked = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked }),
      repoPath: '/repo',
    });
    expect(offenders).toHaveLength(21);
    expect(new Set(offenders.map((o) => o.file))).toEqual(new Set(tracked));
    expect(offenders[0].detectorKey).toBe('wholesale-deletion');
    expect(offenders[0].fixerRole).toBe('content-fixer');
    expect(offenders[0].error).toContain('refused to commit this deletion');
  });

  it('reproduces the SideStage wipe end-to-end and refuses it', async () => {
    // libs/dock-workbench: 21 tracked files, all deleted, package.json among them.
    // Before this guard git-sync committed exactly this and pushed a 0-file tree.
    const tracked = ['package.json', '.gitignore', 'src/index.ts', ...Array.from({ length: 18 }, (_, i) => `src/m${i}.ts`)];
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked }),
      repoPath: '/repo/libs/dock-workbench',
    });
    expect(offenders.map((o) => o.file)).toContain('package.json');
    expect(offenders).toHaveLength(tracked.length);
  });

  // ---- CONTROLS: these are what make the assertions above meaningful ----

  it('CONTROL: returns [] for an ordinary partial deletion (guard is not always-on)', async () => {
    const tracked = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked.slice(0, 10), tracked }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });

  it('CONTROL: returns [] when nothing is deleted at all', async () => {
    const tracked = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: [], tracked }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });

  it('FAILS OPEN when git status errors — a guard bug must never wedge the tree', async () => {
    const tracked = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked, statusCode: 128 }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });

  it('FAILS OPEN on an unborn branch (no HEAD to measure against)', async () => {
    const tracked = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked, treeCode: 128 }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });
});
