import { describe, it, expect } from 'vitest';
import {
  prepareEnvWorktree,
  WORKING_TREE_ENV_ID,
  type GitResult,
  type PrepareEnvTreeDeps,
} from './env-tree-prepare';
import type { EnvOperatorPlanEntry } from './env-operator-launcher';

const SRC = '/src/papercup';
const BASE = '/home/u/.papercusp/env-trees';

function entry(id: string, branch: string): EnvOperatorPlanEntry {
  const portById: Record<string, number> = { dev: 3270, prod: 3070, staging: 3170 };
  return { id, port: portById[id] ?? 9999, branch, origin: `http://127.0.0.1:${portById[id] ?? 9999}`, action: 'spawn' };
}

/** A scripted, recording git. `handler(args)` returns the GitResult for a call. */
function fakeGit(handler: (args: string[]) => Partial<GitResult>): {
  runGit: NonNullable<PrepareEnvTreeDeps['runGit']>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGit = async (args: string[]): Promise<GitResult> => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '', ...handler(args) };
  };
  return { runGit, calls };
}

const deps = (over: Partial<PrepareEnvTreeDeps> = {}): PrepareEnvTreeDeps => ({
  worktreeBaseDir: () => BASE,
  exists: () => true,
  log: () => {},
  ...over,
});

describe('prepareEnvWorktree', () => {
  it('runs the working-tree env (dev) in place — returns the source root, no git', async () => {
    const { runGit, calls } = fakeGit(() => ({}));
    const out = await prepareEnvWorktree(entry(WORKING_TREE_ENV_ID, 'staging'), SRC, deps({ runGit }));
    expect(out).toBe(SRC);
    expect(calls).toHaveLength(0);
  });

  it('returns null when the source tree is absent', async () => {
    const { runGit, calls } = fakeGit(() => ({}));
    const out = await prepareEnvWorktree(entry('staging', 'staging'), SRC, deps({ runGit, exists: () => false }));
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('fetches then adds a worktree on origin/<branch> for a non-working env', async () => {
    const { runGit, calls } = fakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: '' }; // none yet
      return { code: 0 };
    });
    const out = await prepareEnvWorktree(entry('staging', 'staging'), SRC, deps({ runGit }));
    expect(out).toBe(`${BASE}/staging`);
    // fetch happened
    expect(calls).toContainEqual(['fetch', '--depth', '1', 'origin', 'staging']);
    // worktree added on the remote tip with -B (re)pointing the local branch
    expect(calls).toContainEqual([
      'worktree', 'add', '--force', '-B', 'staging', `${BASE}/staging`, 'origin/staging',
    ]);
  });

  it('is idempotent — reuses an already-registered worktree without re-adding', async () => {
    const { runGit, calls } = fakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: `worktree ${SRC}\n\nworktree ${BASE}/prod\n` };
      }
      return {};
    });
    const out = await prepareEnvWorktree(entry('prod', 'main'), SRC, deps({ runGit }));
    expect(out).toBe(`${BASE}/prod`);
    // only the list call — no fetch, no add
    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
  });

  it('falls back to the bare local branch when origin/<branch> add fails', async () => {
    const { runGit, calls } = fakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: '' };
      if (args[0] === 'worktree' && args[1] === 'add' && args.includes('origin/staging')) {
        return { code: 128, stderr: "invalid reference: origin/staging" };
      }
      return { code: 0 };
    });
    const out = await prepareEnvWorktree(entry('staging', 'staging'), SRC, deps({ runGit }));
    expect(out).toBe(`${BASE}/staging`);
    // the local-branch fallback ran
    expect(calls).toContainEqual(['worktree', 'add', '--force', `${BASE}/staging`, 'staging']);
  });

  it('returns null when both the remote and local worktree adds fail', async () => {
    const { runGit } = fakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { code: 128, stderr: 'no such branch' };
      return { code: 0 };
    });
    const out = await prepareEnvWorktree(entry('staging', 'staging'), SRC, deps({ runGit }));
    expect(out).toBeNull();
  });

  it('treats fetch as best-effort — a failed fetch still adds the worktree', async () => {
    const { runGit, calls } = fakeGit((args) => {
      if (args[0] === 'fetch') return { code: 1, stderr: 'could not read from remote (offline)' };
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: '' };
      return { code: 0 }; // worktree add succeeds (branch already local)
    });
    const out = await prepareEnvWorktree(entry('prod', 'main'), SRC, deps({ runGit }));
    expect(out).toBe(`${BASE}/prod`);
    expect(calls.some((c) => c[0] === 'fetch')).toBe(true);
  });

  it('places each env worktree under <base>/<id>', async () => {
    const { runGit } = fakeGit((args) => (args[0] === 'worktree' && args[1] === 'list' ? { stdout: '' } : { code: 0 }));
    expect(await prepareEnvWorktree(entry('prod', 'main'), SRC, deps({ runGit }))).toBe(`${BASE}/prod`);
  });
});
