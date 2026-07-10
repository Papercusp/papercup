/**
 * worktree-coverage-watchdog.test.ts — WI-3612 (EI-8820 follow-up).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  findUncoveredDirtyWorktrees,
  parseWorktreeListPorcelain,
  listWorktreesWithDirtyState,
  checkWorktreeCoverage,
  KNOWN_UNCOVERED_WORKTREE_PATTERNS,
  type WorktreeInfo,
} from './worktree-coverage-watchdog';

const CANONICAL = '/home/marsh-office/papercupai-workspace/papercusp';

function wt(path: string, dirty: boolean, dirtyFileCount = dirty ? 1 : 0): WorktreeInfo {
  return { path, dirty, dirtyFileCount };
}

describe('findUncoveredDirtyWorktrees (pure classifier)', () => {
  it('never flags a clean worktree, regardless of path', () => {
    expect(
      findUncoveredDirtyWorktrees([wt('/some/random/stray-worktree', false)], CANONICAL),
    ).toEqual([]);
  });

  it('never flags the canonical tree itself, even if dirty (it IS git-sync\'s own target)', () => {
    expect(findUncoveredDirtyWorktrees([wt(CANONICAL, true, 5)], CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty -release / -checkpoint sibling tree (reset every run by design)', () => {
    const worktrees = [
      wt('/home/marsh-office/papercupai-workspace/papercup-release', true, 12),
      wt('/home/marsh-office/papercupai-workspace/papercup-checkpoint', true, 3),
      wt('/home/marsh-office/papercupai-workspace/papercusp-checkpoint', true, 7),
    ];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty D-006 env-tree (env-tree-prepare.ts — force-recreatable, never committed)', () => {
    const worktrees = [
      wt('/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/env-trees/staging', true, 3730),
    ];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty migration/synthesis isolation worktree', () => {
    const worktrees = [wt('/home/marsh-office/papercupai-workspace/papercusp/.papercusp/worktrees/migrate-xyz', true, 2)];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('FLAGS a dirty worktree matching none of the known patterns — the WI-3449 class', () => {
    const worktrees = [wt('/home/marsh-office/some-random-clone-of-papercusp', true, 4)];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual(worktrees);
  });

  it('only flags the uncovered entries out of a mixed set', () => {
    const covered = wt('/home/marsh-office/papercupai-workspace/papercup-release', true, 1);
    const clean = wt('/home/marsh-office/stray', false);
    const stray = wt('/home/marsh-office/stray-worktree-with-edits', true, 2);
    expect(findUncoveredDirtyWorktrees([covered, clean, stray], CANONICAL)).toEqual([stray]);
  });

  it('KNOWN_UNCOVERED_WORKTREE_PATTERNS is non-empty and every entry is a RegExp', () => {
    expect(KNOWN_UNCOVERED_WORKTREE_PATTERNS.length).toBeGreaterThan(0);
    for (const p of KNOWN_UNCOVERED_WORKTREE_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });
});

describe('parseWorktreeListPorcelain', () => {
  it('extracts every worktree path from real --porcelain output', () => {
    const out = [
      'worktree /home/marsh-office/papercupai-workspace/papercusp',
      'HEAD 1c3be69157abcdef',
      'branch refs/heads/staging',
      '',
      'worktree /home/marsh-office/papercupai-workspace/papercup-release',
      'HEAD 466b932774abcdef',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(out)).toEqual([
      '/home/marsh-office/papercupai-workspace/papercusp',
      '/home/marsh-office/papercupai-workspace/papercup-release',
    ]);
  });

  it('returns an empty array for empty/garbage input', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([]);
    expect(parseWorktreeListPorcelain('HEAD abc\nbranch refs/heads/x\n')).toEqual([]);
  });
});

describe('listWorktreesWithDirtyState (git-injected)', () => {
  it('reports dirty=true with the right count for a worktree with status lines', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') {
        return 'worktree /a\n\nworktree /b\n\n';
      }
      if (cwd === '/a') return ' M file1.ts\n?? file2.ts\n';
      return ''; // /b clean
    });
    const result = await listWorktreesWithDirtyState('/a', { runGit });
    expect(result).toEqual([
      { path: '/a', dirty: true, dirtyFileCount: 2 },
      { path: '/b', dirty: false, dirtyFileCount: 0 },
    ]);
  });

  it('skips (does not throw for) a worktree whose status check fails', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return 'worktree /a\n\nworktree /gone\n\n';
      if (cwd === '/gone') throw new Error('no such directory');
      return '';
    });
    const result = await listWorktreesWithDirtyState('/a', { runGit });
    expect(result).toEqual([{ path: '/a', dirty: false, dirtyFileCount: 0 }]);
  });
});

describe('checkWorktreeCoverage (end-to-end pass)', () => {
  it('never throws even when the underlying git call rejects', async () => {
    const runGit = vi.fn(async () => { throw new Error('git not found'); });
    const log = vi.fn();
    const result = await checkWorktreeCoverage('/a', { runGit, log });
    expect(result).toEqual({ uncovered: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pass failed'));
  });

  it('returns the uncovered set and logs a finding when a stray dirty worktree exists', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return 'worktree /a\n\nworktree /stray\n\n';
      if (cwd === '/stray') return ' M x.ts\n';
      return '';
    });
    const log = vi.fn();
    const result = await checkWorktreeCoverage('/a', { runGit, log });
    expect(result.uncovered).toEqual([{ path: '/stray', dirty: true, dirtyFileCount: 1 }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/stray'));
  });

  it('logs nothing when every dirty worktree is covered/excluded', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return 'worktree /a\n\n';
      return ' M x.ts\n'; // canonical itself, dirty — never flagged
    });
    const log = vi.fn();
    const result = await checkWorktreeCoverage('/a', { runGit, log });
    expect(result.uncovered).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
