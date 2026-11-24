/**
 * The release itself, against the store's own selector rule.
 *
 * release-hook-locks.test.ts pins which locks are chosen and that the carry-respawn calls the
 * release. Neither says the release WORKS, and it did not: the store's `tryRelease` takes a
 * `lock_id` (optionally narrowed to paths) or `all_mine`, and refuses anything else with
 * "locks:release requires lock_id or all_mine". The release passed paths alone, so it threw on
 * every call that had a lock to release, and its one caller swallows the error. A denied or
 * failed edit's lock then outlived its edit for the full lease, git-sync skipped the file, and
 * the work-item that declared it stayed unproven.
 *
 * The store double below enforces that same rule, so a release that names no lock id fails
 * here the way it fails live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveLockRow } from './su-lock-store';

const readQueue = vi.hoisted(() => vi.fn());
const tryRelease = vi.hoisted(() => vi.fn());
const noteShaTokenRelease = vi.hoisted(() => vi.fn());
const notifyPlanLockChange = vi.hoisted(() => vi.fn());

vi.mock('./su-lock-store', () => ({
  ensureBootstrap: async () => {},
  getTxPool: () => ({}),
  readQueue: (...a: unknown[]) => readQueue(...a),
  tryRelease: (...a: unknown[]) => tryRelease(...a),
}));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: async (_domain: string, _owner: string, run: (tx: unknown) => unknown) => run({}),
}));
vi.mock('./contention-retry', () => ({ acquireWithContentionRetry: async (run: () => unknown) => run() }));
vi.mock('./notify-lock-change', () => ({ notifyPlanLockChange: (...a: unknown[]) => notifyPlanLockChange(...a) }));
vi.mock('../../authority/sha-token-registry', () => ({ noteShaTokenRelease: (...a: unknown[]) => noteShaTokenRelease(...a) }));

const { releaseOwnerHookFileLocks, HOOK_LOCK_INTENT_PREFIX } = await import('./release-hook-locks');

const OWNER = 'su-29b0c067-05db-406c-bb1b-5638692e5824';
const TREE = '/work/batch-1';

function row(over: Partial<ActiveLockRow>): ActiveLockRow {
  return {
    lock_id: 'lock-a',
    path: 'src/inv_money.py',
    owner: OWNER,
    owner_label: null,
    intent: `${HOOK_LOCK_INTENT_PREFIX}Write`,
    goal_ref: 'WI-15',
    acquired_ts: new Date('2026-11-24T21:32:27Z'),
    expires_ts: new Date('2026-11-24T21:52:27Z'),
    coordination_domain: TREE,
    ...over,
  };
}

/** The store's rule, as `tryRelease` enforces it: a lock id or everything, never paths alone. */
function storeRelease(held: ActiveLockRow[]) {
  return async (_tx: unknown, params: { coordinationDomain: string; owner: string; lockId?: string; paths?: string[]; allMine?: boolean }) => {
    if (!params.allMine && !params.lockId) throw new Error('locks:release requires lock_id or all_mine');
    const mine = held.filter((each) => each.owner === params.owner && each.coordination_domain === params.coordinationDomain);
    const gone = mine.filter(
      (each) => params.allMine || (each.lock_id === params.lockId && (!params.paths || params.paths.includes(each.path))),
    );
    for (const each of gone) held.splice(held.indexOf(each), 1);
    return { released: gone.map((each) => each.path), heldBefore: mine.length };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('releaseOwnerHookFileLocks releases through the store', () => {
  it('frees a hook lock left by an edit that never ran, which a paths-only release could not', async () => {
    const held = [row({})];
    readQueue.mockResolvedValue({ active_locks: [...held] });
    tryRelease.mockImplementation(storeRelease(held));

    const result = await releaseOwnerHookFileLocks({ ownerId: OWNER });

    expect(result).toEqual({ released: ['src/inv_money.py'], heldBefore: 1, preservedDeliberate: 0 });
    expect(held).toEqual([]);
    expect(tryRelease).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { coordinationDomain: TREE, owner: OWNER, lockId: 'lock-a', paths: ['src/inv_money.py'] },
    );
    expect(notifyPlanLockChange).toHaveBeenCalledExactlyOnceWith(['src/inv_money.py']);
  });

  it('releases a batch\'s lock set in one call and each other set in its own', async () => {
    const held = [
      row({ lock_id: 'batch', path: 'src/inv_money.py' }),
      row({ lock_id: 'batch', path: 'tests/test_inv_money.py' }),
      row({ lock_id: 'single', path: 'src/inv_stock.py', intent: `${HOOK_LOCK_INTENT_PREFIX}Edit` }),
      row({ lock_id: 'other-tree', path: 'README.md', coordination_domain: '/work/other' }),
    ];
    readQueue.mockResolvedValue({ active_locks: [...held] });
    tryRelease.mockImplementation(storeRelease(held));

    const result = await releaseOwnerHookFileLocks({ ownerId: OWNER });

    expect(result.heldBefore).toBe(4);
    expect([...result.released].sort()).toEqual(['README.md', 'src/inv_money.py', 'src/inv_stock.py', 'tests/test_inv_money.py']);
    expect(tryRelease.mock.calls.map((call) => call[1])).toEqual([
      { coordinationDomain: TREE, owner: OWNER, lockId: 'batch', paths: ['src/inv_money.py', 'tests/test_inv_money.py'] },
      { coordinationDomain: TREE, owner: OWNER, lockId: 'single', paths: ['src/inv_stock.py'] },
      { coordinationDomain: '/work/other', owner: OWNER, lockId: 'other-tree', paths: ['README.md'] },
    ]);
  });

  it('keeps a deliberate hold, even one that shares its lock id with a hook\'s', async () => {
    const held = [
      row({ lock_id: 'shared', path: 'src/a.py' }),
      row({ lock_id: 'shared', path: 'src/b.py', intent: 'holding both files across the commit' }),
      row({ lock_id: 'peer', path: 'src/c.py', owner: 'su-someone-else' }),
    ];
    readQueue.mockResolvedValue({ active_locks: [...held] });
    tryRelease.mockImplementation(storeRelease(held));

    const result = await releaseOwnerHookFileLocks({ ownerId: OWNER });

    expect(result).toEqual({ released: ['src/a.py'], heldBefore: 1, preservedDeliberate: 1 });
    expect(held.map((each) => each.path)).toEqual(['src/b.py', 'src/c.py']);
  });

  it('given paths, releases the hook locks on those files only: relative or absolute', async () => {
    const held = [
      row({ lock_id: 'a', path: 'src/inv_money.py' }),
      row({ lock_id: 'b', path: 'tests/test_inv_money.py' }),
      row({ lock_id: 'c', path: 'src/still_editing.py' }),
    ];
    readQueue.mockResolvedValue({ active_locks: [...held] });
    tryRelease.mockImplementation(storeRelease(held));

    const result = await releaseOwnerHookFileLocks({ ownerId: OWNER, paths: ['./src/inv_money.py', `${TREE}/tests/test_inv_money.py`, 'src/never_locked.py'] });

    expect([...result.released].sort()).toEqual(['src/inv_money.py', 'tests/test_inv_money.py']);
    expect(result.heldBefore).toBe(2);
    expect(held.map((each) => each.path)).toEqual(['src/still_editing.py']);
  });

  it('given no paths to release, asks the store nothing', async () => {
    expect(await releaseOwnerHookFileLocks({ ownerId: OWNER, paths: [] })).toEqual({ released: [], heldBefore: 0, preservedDeliberate: 0 });
    expect(readQueue).not.toHaveBeenCalled();
  });

  it('holds nothing: no store call, a correct no-op', async () => {
    readQueue.mockResolvedValue({ active_locks: [row({ owner: 'su-someone-else' })] });
    expect(await releaseOwnerHookFileLocks({ ownerId: OWNER })).toEqual({ released: [], heldBefore: 0, preservedDeliberate: 0 });
    expect(tryRelease).not.toHaveBeenCalled();
  });
});
