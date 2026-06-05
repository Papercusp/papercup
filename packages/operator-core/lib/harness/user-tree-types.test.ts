import { describe, expect, it } from 'vitest';
import {
  USER_TREES_GITIGNORE_LINE,
  USER_TREES_ROOT_REL_PATH,
  gitWorktreeAddArgs,
  isUserTreePath,
  isWorktreeInvariantBroken,
  parseUserTreeRelPath,
  resolveWriteTarget,
  userBranchRef,
  userTreeAbsPath,
  userTreeRelPath,
} from './user-tree-types';

describe('constants', () => {
  it('USER_TREES_ROOT_REL_PATH is .papercusp/user-trees', () => {
    expect(USER_TREES_ROOT_REL_PATH).toBe('.papercusp/user-trees');
  });

  it('USER_TREES_GITIGNORE_LINE matches the rel path with leading + trailing /', () => {
    expect(USER_TREES_GITIGNORE_LINE).toBe('/.papercusp/user-trees/');
  });
});

describe('userTreeAbsPath', () => {
  it('builds <harnessRoot>/.papercusp/user-trees/<id>', () => {
    expect(userTreeAbsPath({ harnessRoot: '/repo', githubUserId: 12345 })).toBe(
      '/repo/.papercusp/user-trees/12345',
    );
  });

  it('strips trailing slash on harnessRoot', () => {
    expect(userTreeAbsPath({ harnessRoot: '/repo/', githubUserId: 12345 })).toBe(
      '/repo/.papercusp/user-trees/12345',
    );
  });

  it('rejects empty harnessRoot + non-positive id', () => {
    expect(() => userTreeAbsPath({ harnessRoot: '', githubUserId: 1 })).toThrow(TypeError);
    expect(() => userTreeAbsPath({ harnessRoot: '/repo', githubUserId: 0 })).toThrow(TypeError);
    expect(() => userTreeAbsPath({ harnessRoot: '/repo', githubUserId: 1.5 })).toThrow(TypeError);
  });
});

describe('userTreeRelPath', () => {
  it('builds .papercusp/user-trees/<id>', () => {
    expect(userTreeRelPath(12345)).toBe('.papercusp/user-trees/12345');
  });

  it('rejects bad id', () => {
    expect(() => userTreeRelPath(0)).toThrow(TypeError);
  });
});

describe('userBranchRef re-export', () => {
  it('matches contributor-file-types.contributorBranchRef', () => {
    expect(userBranchRef(12345)).toBe('user/12345');
  });
});

describe('parseUserTreeRelPath', () => {
  it('parses canonical rel path', () => {
    expect(parseUserTreeRelPath('.papercusp/user-trees/12345')).toBe(12345);
  });

  it('returns null for non-matching prefix', () => {
    expect(parseUserTreeRelPath('something/else/12345')).toBeNull();
  });

  it('returns null for nested paths', () => {
    expect(parseUserTreeRelPath('.papercusp/user-trees/12345/sub')).toBeNull();
  });

  it('returns null for non-numeric id', () => {
    expect(parseUserTreeRelPath('.papercusp/user-trees/abc')).toBeNull();
  });

  it('returns null for empty id segment', () => {
    expect(parseUserTreeRelPath('.papercusp/user-trees/')).toBeNull();
  });

  it('round-trips with userTreeRelPath', () => {
    expect(parseUserTreeRelPath(userTreeRelPath(99999))).toBe(99999);
  });

  it('rejects non-string', () => {
    // @ts-expect-error
    expect(parseUserTreeRelPath(null)).toBeNull();
  });
});

describe('isUserTreePath', () => {
  it('true for canonical paths', () => {
    expect(isUserTreePath('.papercusp/user-trees/12345')).toBe(true);
  });

  it('false for non-tree paths', () => {
    expect(isUserTreePath('.papercusp/other/12345')).toBe(false);
    expect(isUserTreePath('not a path')).toBe(false);
  });
});

describe('resolveWriteTarget', () => {
  it('returns user_tree kind when path exists', () => {
    const res = resolveWriteTarget({
      harnessRoot: '/repo',
      githubUserId: 1,
      pathExists: () => true,
    });
    expect(res.kind).toBe('user_tree');
    if (res.kind === 'user_tree') {
      expect(res.abs_path).toBe('/repo/.papercusp/user-trees/1');
    }
  });

  it('returns not_provisioned when path missing', () => {
    const res = resolveWriteTarget({
      harnessRoot: '/repo',
      githubUserId: 1,
      pathExists: () => false,
    });
    expect(res.kind).toBe('not_provisioned');
    if (res.kind === 'not_provisioned') {
      expect(res.would_be_abs_path).toBe('/repo/.papercusp/user-trees/1');
    }
  });
});

describe('isWorktreeInvariantBroken', () => {
  it('true when more than 1 worktree found for user', () => {
    expect(isWorktreeInvariantBroken(['/a', '/b'])).toBe(true);
    expect(isWorktreeInvariantBroken(['/a', '/b', '/c'])).toBe(true);
  });

  it('false for 0 or 1 worktrees', () => {
    expect(isWorktreeInvariantBroken([])).toBe(false);
    expect(isWorktreeInvariantBroken(['/a'])).toBe(false);
  });
});

describe('gitWorktreeAddArgs', () => {
  it('builds: worktree add -B user/<id> <abs_path> origin/main', () => {
    const args = gitWorktreeAddArgs({ harnessRoot: '/repo', githubUserId: 12345 });
    expect(args).toEqual([
      'worktree',
      'add',
      '-B',
      'user/12345',
      '/repo/.papercusp/user-trees/12345',
      'origin/main',
    ]);
  });

  it('uses canonical user/<id> branch name', () => {
    const args = gitWorktreeAddArgs({ harnessRoot: '/r', githubUserId: 7 });
    expect(args).toContain('user/7');
  });

  it('rejects bad inputs (propagates from path/branch builders)', () => {
    expect(() => gitWorktreeAddArgs({ harnessRoot: '', githubUserId: 1 })).toThrow(TypeError);
    expect(() => gitWorktreeAddArgs({ harnessRoot: '/r', githubUserId: 0 })).toThrow(TypeError);
  });
});
