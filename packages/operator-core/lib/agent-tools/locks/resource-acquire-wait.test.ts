/**
 * resource-acquire-wait — unit coverage for the shared exclusive-acquisition
 * seam. The live integration suite covers drain/NOTIFY behavior; this suite
 * keeps the retry contract hermetic and proves a transient workspace timeout
 * cannot escape before guardResource gets its exclusive result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./su-lock-store', () => ({
  // The tx pool is an opaque handle here: every store call is itself mocked, so the
  // suite never touches it. Defaulting the stub in the factory (as
  // coordination/audience-host.test.ts does) keeps it out of a per-test
  // `.mockReturnValue(… as never)`, which check-mock-cast-escape.mjs ratchets.
  // vi.clearAllMocks() clears calls, not factory implementations, so this survives beforeEach.
  getTxPool: vi.fn(() => ({}) as never),
  pokeResource: vi.fn(),
  readResourceLockStatus: vi.fn(),
  readResourceQueue: vi.fn(),
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(),
}));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(),
}));
vi.mock('./workspace-listener', () => ({
  subscribeWorkspace: vi.fn(),
}));

import {
  readResourceLockStatus,
  tryAcquireResource,
  type ResourceAcquireResult,
} from './su-lock-store';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { inWorkspaceTxn } from './in-workspace-txn';
import { subscribeWorkspace } from './workspace-listener';
import { acquireResourceExclusiveWithWait } from './resource-acquire-wait';

const txnM = vi.mocked(inWorkspaceTxn);
const subscribeM = vi.mocked(subscribeWorkspace);
const acquireM = vi.mocked(tryAcquireResource);
const statusM = vi.mocked(readResourceLockStatus);

const held: Extract<ResourceAcquireResult, { ok: true }> = {
  ok: true,
  lock_id: 'exclusive-retry',
  mode: 'exclusive',
  status: 'held',
  expires_ts: new Date('2026-09-06T16:00:00.000Z'),
  shared_holders: [],
  fence_seq: 9,
};

const contention = () =>
  Object.assign(new Error('workspace lock timed out'), {
    name: 'WorkspaceContendedError',
    pgCode: '57014',
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  statusM.mockReset();
  acquireM.mockReset();
  mockResolvedTyped(acquireM, held);
  txnM.mockReset();
  txnM.mockImplementation(async (_domain, _owner, fn) => fn({} as never));
  subscribeM.mockReset();
  subscribeM.mockResolvedValue(vi.fn(async () => undefined));
});

afterEach(() => vi.useRealTimers());

describe('acquireResourceExclusiveWithWait contention retry', () => {
  it('retries a transient initial workspace timeout before returning the held exclusive', async () => {
    txnM.mockRejectedValueOnce(contention());

    const pending = acquireResourceExclusiveWithWait({
      coordinationDomain: 'workspace-domain',
      owner: 'fresh-owner',
      ownerLabel: 'fresh',
      resource: 'dev-server',
      reason: 'restart',
      ttlSec: 60,
      // Match dev:restart's drain-capable guard shape: the initial acquire
      // uses the caller's budget for its advisory transaction.
      maxWaitSec: 45,
    });

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      status: 'held',
      lock_id: 'exclusive-retry',
      waited_sec: 0,
      fence_seq: 9,
    });

    expect(txnM).toHaveBeenCalledTimes(2);
    expect(txnM.mock.calls[0]?.[3]).toEqual({
      minLockTimeoutMs: 45_000,
      minStatementTimeoutMs: 45_000,
    });
    expect(txnM.mock.calls[1]?.[3]).toEqual({
      minLockTimeoutMs: 45_000,
      minStatementTimeoutMs: 45_000,
    });
    expect(acquireM).toHaveBeenCalledTimes(1);
    expect(subscribeM).toHaveBeenCalledTimes(1);
  });
});
