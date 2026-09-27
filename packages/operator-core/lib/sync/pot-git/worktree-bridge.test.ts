import { describe, expect, it, vi } from 'vitest';
import type { RunGit } from './storage';
import { WORKTREE_OBJECT_BRIDGE_FETCH_TIMEOUT_MS, WORKTREE_STAGING_REF, bridgeStagingShaToWorktree } from './worktree-bridge';
import { gitSyncActionIdleTimeoutMs } from '../../harness/git-sync/git-sync-action';

// WI-2142873: the object-bridge fetch (mirror → shallow worktree) ran under
// defaultRunGit's 60s RPC default and was killed on EVERY attempt on the P-203
// VM (a first bridge needed a 2.98 GB pack, 3m39s), leaking a 300–700 MB
// tmp_pack per kill until the disk hit 99%.

const PUBKEY = Buffer.alloc(32, 7).toString('base64');
const SHA = 'a'.repeat(40);

function failingFetch(stderr = 'error: git timed out after 480000ms'): { runGit: RunGit; calls: Parameters<RunGit>[] } {
  const calls: Parameters<RunGit>[] = [];
  const runGit: RunGit = async (...args) => {
    calls.push(args);
    return { code: 1, stdout: '', stderr };
  };
  return { runGit, calls };
}

describe('bridgeStagingShaToWorktree object-bridge fetch (WI-2142873)', () => {
  it('runs the fetch under the object-bridge ceiling, not the 60s RPC default', async () => {
    const { runGit, calls } = failingFetch();
    await bridgeStagingShaToWorktree('/mirror.git', '/wt', PUBKEY, SHA, {
      runGit,
      reclaimTempPacks: async () => ({ removed: [], bytesReclaimed: 0 }),
    });
    expect(calls).toHaveLength(1);
    const [args, cwd, opts] = calls[0];
    expect(args.slice(0, 3)).toEqual(['fetch', '-q', '/mirror.git']);
    expect(args[3]).toMatch(new RegExp(`:${WORKTREE_STAGING_REF}$`));
    expect(cwd).toBe('/wt');
    expect(opts?.timeoutMs).toBe(WORKTREE_OBJECT_BRIDGE_FETCH_TIMEOUT_MS);
    expect(WORKTREE_OBJECT_BRIDGE_FETCH_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it('keeps the ceiling strictly below the git-sync action idle guard, so a slow fetch fails this leg and not the whole action', () => {
    expect(WORKTREE_OBJECT_BRIDGE_FETCH_TIMEOUT_MS).toBeLessThan(gitSyncActionIdleTimeoutMs());
  });

  it('honours an explicit fetchTimeoutMs', async () => {
    const { runGit, calls } = failingFetch();
    await bridgeStagingShaToWorktree('/mirror.git', '/wt', PUBKEY, SHA, {
      runGit,
      fetchTimeoutMs: 1234,
      reclaimTempPacks: async () => ({ removed: [], bytesReclaimed: 0 }),
    });
    expect(calls[0][2]?.timeoutMs).toBe(1234);
  });

  it('reclaims the killed fetch’s partial temp packs in the WORKTREE and reports it on the error', async () => {
    const { runGit } = failingFetch();
    const reclaimTempPacks = vi.fn(async () => ({ removed: ['tmp_pack_x', 'tmp_pack_y'], bytesReclaimed: 700_000_000 }));
    const r = await bridgeStagingShaToWorktree('/mirror.git', '/wt', PUBKEY, SHA, { runGit, reclaimTempPacks });
    expect(reclaimTempPacks).toHaveBeenCalledTimes(1);
    expect(reclaimTempPacks).toHaveBeenCalledWith('/wt');
    expect(r.outcome).toBe('error');
    expect(r.to).toBe(SHA);
    expect(r.outcome === 'error' && r.detail).toContain('object-bridge fetch from the mirror failed');
    expect(r.outcome === 'error' && r.detail).toContain('reclaimed 2 partial temp pack(s), 700000000 bytes');
  });

  it('a reclaim failure never masks the fetch error', async () => {
    const { runGit } = failingFetch('fatal: boom');
    const r = await bridgeStagingShaToWorktree('/mirror.git', '/wt', PUBKEY, SHA, {
      runGit,
      reclaimTempPacks: async () => {
        throw new Error('lsof unavailable');
      },
    });
    expect(r.outcome).toBe('error');
    expect(r.outcome === 'error' && r.detail).toBe('object-bridge fetch from the mirror failed: fatal: boom');
  });

  it('does not reclaim when the fetch succeeds', async () => {
    const reclaimTempPacks = vi.fn(async () => ({ removed: [], bytesReclaimed: 0 }));
    let n = 0;
    const runGit: RunGit = async () => {
      n++;
      // fetch ok; every later git call (the ff-advance) fails fast — only the
      // reclaim decision is under test here.
      return n === 1 ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'stub' };
    };
    await bridgeStagingShaToWorktree('/mirror.git', '/wt', PUBKEY, SHA, { runGit, reclaimTempPacks });
    expect(reclaimTempPacks).not.toHaveBeenCalled();
  });
});
