/**
 * live-lock-paths.test.ts — the lock-plane read that replaces the (empty) declared
 * `current_files` signal for automatic collision avoidance (EI-18776963284535761).
 *
 * The load-bearing contracts, each of which was a real failure mode in the bug this came
 * from: it must read across EVERY coordination domain (a domain-scoped read silently
 * misses a genuinely-held lock), it must be HOLDERS-only (a waiter is not editing yet, and
 * a false positive here defers real work), and it must FAIL SOFT (the caller degrades to
 * its previous behaviour rather than breaking when the lock plane is unavailable).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureBootstrap = vi.fn(async () => {});
const getTxPool = vi.fn(() => ({}) as never);
const readQueue = vi.fn(async (_sql: unknown, _params: unknown) => ({
  active_locks: [] as Array<{ path: string; owner: string; intent: string }>,
  waiting: [] as Array<{ path: string; owner: string }>,
}));

vi.mock('./su-lock-store', () => ({
  ensureBootstrap: (...a: unknown[]) => ensureBootstrap(...(a as [])),
  getTxPool: (...a: unknown[]) => getTxPool(...(a as [])),
  readQueue: (...a: unknown[]) => readQueue(...(a as [never, never])),
}));

import { liveLockHoldings, liveLockedPaths } from './live-lock-paths';

const holding = (path: string, owner: string, intent = `edit ${path}`) => ({ path, owner, intent });

beforeEach(() => {
  vi.clearAllMocks();
  readQueue.mockResolvedValue({ active_locks: [], waiting: [] });
});

describe('liveLockHoldings', () => {
  it('returns each live holder with its path and intent', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('a.ts', 'su-1'), holding('b.ts', 'su-2')],
      waiting: [],
    });
    expect(await liveLockHoldings()).toEqual([
      { path: 'a.ts', owner: 'su-1', intent: 'edit a.ts' },
      { path: 'b.ts', owner: 'su-2', intent: 'edit b.ts' },
    ]);
  });

  // A domain-scoped read reports a genuinely-held lock as ABSENT when the holder's
  // checkout differs from the operator's — observed live, and precisely the
  // false-negative this read exists to remove.
  it('reads across EVERY coordination domain (null), with no path/owner filter', async () => {
    await liveLockHoldings();
    expect(readQueue).toHaveBeenCalledWith(expect.anything(), { coordinationDomain: null });
    const params = readQueue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.paths).toBeUndefined();
    expect(params.owner).toBeUndefined();
  });

  // Unlike the `@file:` AUDIENCE (where an extra recipient is harmless), a false positive
  // here DEFERS real work — so an agent merely queued on a path must not count.
  it('ignores waiters — holders only', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('held.ts', 'su-1')],
      waiting: [holding('queued.ts', 'su-2')],
    });
    expect(await liveLockedPaths()).toEqual(['held.ts']);
  });

  it('fails soft to [] when the lock plane throws', async () => {
    readQueue.mockRejectedValue(new Error('side-DB unreachable'));
    expect(await liveLockHoldings()).toEqual([]);
    expect(await liveLockedPaths()).toEqual([]);
  });

  it('fails soft to [] when bootstrap throws', async () => {
    ensureBootstrap.mockRejectedValueOnce(new Error('locks unconfigured'));
    expect(await liveLockHoldings()).toEqual([]);
  });
});

describe('liveLockedPaths', () => {
  it('de-duplicates a path held under several rows and trims blanks', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('a.ts', 'su-1'), holding('  a.ts  ', 'su-2'), holding('   ', 'su-3')],
      waiting: [],
    });
    expect(await liveLockedPaths()).toEqual(['a.ts']);
  });

  it('excludeOwner drops that agent’s own holdings but keeps its peers’', async () => {
    readQueue.mockResolvedValue({
      active_locks: [holding('mine.ts', 'su-me'), holding('theirs.ts', 'su-peer')],
      waiting: [],
    });
    expect(await liveLockedPaths({ excludeOwner: 'su-me' })).toEqual(['theirs.ts']);
    expect(await liveLockedPaths()).toEqual(['mine.ts', 'theirs.ts']);
  });

  it('returns [] when nothing is held', async () => {
    expect(await liveLockedPaths()).toEqual([]);
  });
});
