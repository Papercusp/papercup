import { describe, it, expect } from 'vitest';
import { buildSubstrateCloneCommands, isPinnedCommit } from '../clone';

/**
 * The substrate is a THROWAWAY clone at a PINNED commit (D-009): a real git
 * clone (not an export) so the worker can commit on top and we can later
 * `git diff <pinned-commit> HEAD` to recover the produced work (P-002/P-003).
 * These are the pure command plans; execution is separate glue.
 */
describe('isPinnedCommit', () => {
  it('accepts full and abbreviated hex SHAs', () => {
    expect(isPinnedCommit('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(isPinnedCommit('a1b2c3d')).toBe(true);
  });
  it('rejects refs/branches/tags — a pin must be an immutable SHA', () => {
    expect(isPinnedCommit('main')).toBe(false);
    expect(isPinnedCommit('v1.2.0')).toBe(false);
    expect(isPinnedCommit('HEAD')).toBe(false);
    expect(isPinnedCommit('')).toBe(false);
    expect(isPinnedCommit('z'.repeat(40))).toBe(false);
  });
});

describe('buildSubstrateCloneCommands', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const destDir = '/scratch/gym/clones/gym-abc123';

  it('clones then detaches at the pinned commit, in that order', () => {
    const { commands } = buildSubstrateCloneCommands({
      source: '/repos/substrate',
      commit,
      destDir,
    });
    expect(commands).toHaveLength(2);
    expect(commands[0].argv[0]).toBe('git');
    expect(commands[0].argv).toContain('clone');
    expect(commands[0].argv).toContain(destDir);
    // checkout uses -C destDir + --detach + the exact commit
    expect(commands[1].argv).toEqual(['git', '-C', destDir, 'checkout', '--detach', commit]);
  });

  it('uses --local for a local-path source (cheap hardlinked clone)', () => {
    const { commands } = buildSubstrateCloneCommands({ source: '/repos/substrate', commit, destDir });
    expect(commands[0].argv).toContain('--local');
  });

  it('does NOT use --local for an https remote', () => {
    const { commands } = buildSubstrateCloneCommands({
      source: 'https://github.com/org/repo.git',
      commit,
      destDir,
    });
    expect(commands[0].argv).not.toContain('--local');
    expect(commands[0].argv).toContain('https://github.com/org/repo.git');
  });

  it('does NOT use --local for an scp-style git remote', () => {
    const { commands } = buildSubstrateCloneCommands({
      source: 'git@github.com:org/repo.git',
      commit,
      destDir,
    });
    expect(commands[0].argv).not.toContain('--local');
  });

  it('throws when the commit is not a pinned SHA', () => {
    expect(() => buildSubstrateCloneCommands({ source: '/repos/x', commit: 'main', destDir })).toThrow();
  });
});
