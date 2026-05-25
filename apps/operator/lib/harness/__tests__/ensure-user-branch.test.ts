import { describe, expect, it, vi } from 'vitest';
import {
  ensureUserBranchAndWorktree,
  type RunGit,
  type RunGitResult,
} from '../ensure-user-branch';

function ok(stdout = ''): RunGitResult {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(stderr: string, exitCode = 1): RunGitResult {
  return { stdout: '', stderr, exitCode };
}

interface Calls {
  log: string[][];
}

function recorder(responses: Array<(args: string[]) => RunGitResult>): {
  runGit: RunGit;
  calls: Calls;
} {
  const calls: Calls = { log: [] };
  let i = 0;
  const runGit: RunGit = async (args) => {
    calls.log.push(args);
    const r = responses[Math.min(i, responses.length - 1)](args);
    i++;
    return r;
  };
  return { runGit, calls };
}

describe('ensureUserBranchAndWorktree — validation', () => {
  it('rejects missing harnessRoot', async () => {
    await expect(
      ensureUserBranchAndWorktree({
        harnessRoot: '',
        githubUserId: 1,
        runGit: vi.fn(),
        pathExists: () => false,
      }),
    ).rejects.toThrow(/harnessRoot/);
  });

  it('rejects 0 / negative / float user id', async () => {
    for (const bad of [0, -1, 1.5]) {
      await expect(
        ensureUserBranchAndWorktree({
          harnessRoot: '/r',
          githubUserId: bad,
          runGit: vi.fn(),
          pathExists: () => false,
        }),
      ).rejects.toThrow(/githubUserId/);
    }
  });
});

describe('ensureUserBranchAndWorktree — happy paths', () => {
  it('no-op when branch + worktree both exist', async () => {
    const { runGit, calls } = recorder([
      () => ok(), // show-ref → exists
    ]);
    const r = await ensureUserBranchAndWorktree({
      harnessRoot: '/r',
      githubUserId: 7,
      runGit,
      pathExists: () => true,
    });
    expect(r.branchCreated).toBe(false);
    expect(r.worktreeCreated).toBe(false);
    expect(r.repaired).toBe(false);
    expect(r.branchRef).toBe('user/7');
    expect(r.worktreeAbsPath).toBe('/r/.papercusp/user-trees/7');
    // Only the show-ref call should have happened.
    expect(calls.log).toHaveLength(1);
    expect(calls.log[0]).toContain('show-ref');
  });

  it('branch exists but worktree missing → adds worktree only', async () => {
    const { runGit, calls } = recorder([
      () => ok(), // show-ref → exists
      () => ok(), // worktree add
    ]);
    const r = await ensureUserBranchAndWorktree({
      harnessRoot: '/r',
      githubUserId: 7,
      runGit,
      pathExists: () => false,
    });
    expect(r.branchCreated).toBe(false);
    expect(r.worktreeCreated).toBe(true);
    expect(r.repaired).toBe(false);
    expect(calls.log[1]).toContain('worktree');
    expect(calls.log[1]).toContain('add');
    expect(calls.log[1]).toContain('/r/.papercusp/user-trees/7');
    expect(calls.log[1]).toContain('user/7');
  });

  it('neither exists → creates branch + worktree from origin/main in one shot', async () => {
    const { runGit, calls } = recorder([
      () => fail('not found', 1), // show-ref → does not exist
      () => ok(), // worktree add -b
    ]);
    const r = await ensureUserBranchAndWorktree({
      harnessRoot: '/r',
      githubUserId: 99,
      runGit,
      pathExists: () => false,
    });
    expect(r.branchCreated).toBe(true);
    expect(r.worktreeCreated).toBe(true);
    expect(r.repaired).toBe(false);
    const addCall = calls.log[1];
    expect(addCall).toContain('-b');
    expect(addCall).toContain('user/99');
    expect(addCall).toContain('origin/main');
  });

  it('honors upstreamRef override', async () => {
    const { runGit, calls } = recorder([
      () => fail('not found', 1),
      () => ok(),
    ]);
    await ensureUserBranchAndWorktree({
      harnessRoot: '/r',
      githubUserId: 1,
      upstreamRef: 'origin/develop',
      runGit,
      pathExists: () => false,
    });
    expect(calls.log[1]).toContain('origin/develop');
  });
});

describe('ensureUserBranchAndWorktree — upstream-missing fallback', () => {
  it('retries against HEAD when origin/main is unknown', async () => {
    const { runGit, calls } = recorder([
      () => fail('not found', 1), // show-ref
      () => fail('unknown revision: origin/main', 128), // 1st worktree add
      () => ok(), // 2nd worktree add against HEAD
    ]);
    const r = await ensureUserBranchAndWorktree({
      harnessRoot: '/r',
      githubUserId: 1,
      runGit,
      pathExists: () => false,
    });
    expect(r.branchCreated).toBe(true);
    expect(calls.log).toHaveLength(3);
    expect(calls.log[2]).toContain('HEAD');
  });

  it('bubbles non-upstream-missing failures from worktree add', async () => {
    const { runGit } = recorder([
      () => fail('not found', 1),
      () => fail('permission denied', 1),
    ]);
    await expect(
      ensureUserBranchAndWorktree({
        harnessRoot: '/r',
        githubUserId: 1,
        runGit,
        pathExists: () => false,
      }),
    ).rejects.toThrow(/permission/);
  });

  it('bubbles failure on the HEAD retry too', async () => {
    const { runGit } = recorder([
      () => fail('not found', 1),
      () => fail('unknown revision: origin/main', 128),
      () => fail('disk full', 1),
    ]);
    await expect(
      ensureUserBranchAndWorktree({
        harnessRoot: '/r',
        githubUserId: 1,
        runGit,
        pathExists: () => false,
      }),
    ).rejects.toThrow(/disk full/);
  });
});

describe('ensureUserBranchAndWorktree — repair path', () => {
  it('removes orphaned worktree dir + recreates when branch missing but dir present', async () => {
    const rmDirSync = vi.fn();
    const { runGit, calls } = recorder([
      () => fail('not found', 1), // show-ref
      () => ok(), // worktree add -b (after rm)
    ]);
    const r = await ensureUserBranchAndWorktree({
      harnessRoot: '/r',
      githubUserId: 1,
      runGit,
      pathExists: () => true,
      rmDirSync,
    });
    expect(r.repaired).toBe(true);
    expect(r.branchCreated).toBe(true);
    expect(r.worktreeCreated).toBe(true);
    expect(rmDirSync).toHaveBeenCalledWith('/r/.papercusp/user-trees/1');
    expect(calls.log[1]).toContain('-b');
    expect(calls.log[1]).toContain('user/1');
  });

  it('refuses repair when rmDirSync was not provided', async () => {
    const { runGit } = recorder([() => fail('not found', 1)]);
    await expect(
      ensureUserBranchAndWorktree({
        harnessRoot: '/r',
        githubUserId: 1,
        runGit,
        pathExists: () => true,
      }),
    ).rejects.toThrow(/rmDirSync required/);
  });
});

describe('ensureUserBranchAndWorktree — branch-ref check uses refs/heads/', () => {
  it('passes refs/heads/<branch> to show-ref --verify --quiet', async () => {
    const { runGit, calls } = recorder([() => ok()]);
    await ensureUserBranchAndWorktree({
      harnessRoot: '/r',
      githubUserId: 42,
      runGit,
      pathExists: () => true,
    });
    expect(calls.log[0]).toEqual(['-C', '/r', 'show-ref', '--verify', '--quiet', 'refs/heads/user/42']);
  });
});
