/**
 * resource-acquire-wait — the exclusive drain wait loop (Phase 4, P-006).
 *
 * acquireResourceExclusiveWithWait subscribes to ch_coord_<domain>, takes
 * the exclusive (draining while shared holders remain), and blocks until
 * resource_grant_cascade flips it to held (woken by NOTIFY, with a ceiling
 * + poke fallback for TTL-expiry) or max_drain_sec elapses. Live PG +
 * real NOTIFY; concurrent release drives the drain.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { _resetListenersForTests } from '../workspace-listener';
import { acquireResourceExclusiveWithWait } from '../resource-acquire-wait';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let wsSeq = 0;
const uniqueWs = () => `res-wait-ws-${Date.now()}-${wsSeq++}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const acqShared = (ws: string, owner: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireResource(tx, {
      coordinationDomain: ws,
      resource: 'dev-server',
      mode: 'shared',
      owner,
      ownerLabel: `res:${owner}`,
      reason: 'test',
      ttlSec: 60,
    }),
  );

const rel = (ws: string, owner: string, lockId: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryReleaseResource(tx, { coordinationDomain: ws, owner, lockId }),
  );

const exclusiveWait = (ws: string, owner: string, maxWaitSec: number) =>
  acquireResourceExclusiveWithWait({
    coordinationDomain: ws,
    owner,
    ownerLabel: `res:${owner}`,
    resource: 'dev-server',
    reason: 'restart',
    ttlSec: 60,
    maxWaitSec,
  });

describe('acquireResourceExclusiveWithWait (drain wait loop)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('grants immediately when no shared holders exist', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const r = await exclusiveWait(ws, 'X', 10);
    expect(r.ok).toBe(true);
    if (r.ok && r.status === 'held') {
      expect(r.waited_sec).toBe(0);
    }
  });

  it.skipIf(!live)('blocks while shared holders exist, then is granted when they drain', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acqShared(ws, 'A');
    const b = await acqShared(ws, 'B');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Start the exclusive wait; let it acquire (draining) + subscribe.
    const pending = exclusiveWait(ws, 'X', 15);
    await sleep(400);

    // Drain both shared holders → the release cascade flips X to held + NOTIFY.
    await rel(ws, 'A', a.lock_id);
    await rel(ws, 'B', b.lock_id);

    const r = await pending;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('held');
  });

  it.skipIf(!live)('fires onDrainStart with the shared holders when it begins draining', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const a = await acqShared(ws, 'A');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    let drainHolders: { owner: string; mode: string }[] | null = null;
    const pending = acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'X',
      ownerLabel: 'res:X',
      resource: 'dev-server',
      reason: 'restart',
      ttlSec: 60,
      maxWaitSec: 5,
      onDrainStart: (holders) => {
        drainHolders = holders;
      },
    });
    await sleep(300);
    await rel(ws, 'A', a.lock_id);
    await pending;

    expect(drainHolders).not.toBeNull();
    expect(drainHolders!.some((h) => h.owner === 'A' && h.mode === 'shared')).toBe(true);
  });

  it.skipIf(!live)('times out with drain_timeout while a shared holder remains', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const a = await acqShared(ws, 'A');
    expect(a.ok).toBe(true);

    const r = await exclusiveWait(ws, 'X', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('drain_timeout');
      if (r.reason === 'drain_timeout') {
        expect(r.holders.some((h) => h.mode === 'shared')).toBe(true);
      }
    }

    await _resetListenersForTests();
    await _resetForTests();
  });
});
