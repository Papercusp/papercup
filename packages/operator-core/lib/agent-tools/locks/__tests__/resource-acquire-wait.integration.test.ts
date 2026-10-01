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
import { spawn } from 'node:child_process';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { _resetListenersForTests } from '../workspace-listener';
import {
  acquireResourceExclusiveQueued,
  acquireResourceExclusiveWithWait,
  workspaceTxnOptionsForExclusiveWait,
  type StaleHolderReclaimedInfo,
} from '../resource-acquire-wait';

/** Spawn + reap a throwaway child process so we have a REAL pid guaranteed to
 *  be dead by the time it resolves — not a made-up large number that might
 *  coincidentally collide with a live process on the test host. */
function definitelyDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid;
    if (!pid) {
      reject(new Error('spawn returned no pid'));
      return;
    }
    child.on('exit', () => resolve(pid));
    child.on('error', reject);
  });
}

/** Mirrors deploy-deps.ts's parseDeployOwnerPid convention (`<label>:<pid>`)
 *  for these tests, without depending on that app-layer module. */
const hostLocalOwnerPidFromLabel = (owner: string): number | null => {
  const m = /^stale-owner:(\d+)$/.exec(owner);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

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

describe('workspace transaction budget for an exclusive drain (WI-2140648)', () => {
  it('keeps a waiting acquire in the PG advisory FIFO for its declared budget', () => {
    expect(workspaceTxnOptionsForExclusiveWait(120)).toEqual({
      minLockTimeoutMs: 120_000,
      minStatementTimeoutMs: 120_000,
    });
  });

  it('does not widen the no-wait path', () => {
    expect(workspaceTxnOptionsForExclusiveWait(0)).toEqual({});
  });
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

describe('acquireResourceExclusiveWithWait — hostLocalOwnerPid reclaim (EI-18674647773291145 Defect 1)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('reclaims + retries once when the exclusive holder is a definitively-dead pid', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const deadPid = await definitelyDeadPid();
    const staleOwner = `stale-owner:${deadPid}`;

    // Simulate a crashed holder: acquire exclusive as `staleOwner`, never release —
    // exactly the shape a deploy-cli process that died mid-flight leaves behind.
    const first = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: staleOwner,
      ownerLabel: 'stale',
      resource: 'dev-server',
      reason: 'test',
      ttlSec: 60,
      maxWaitSec: 0,
    });
    expect(first.ok).toBe(true);

    let reclaimed: StaleHolderReclaimedInfo | null = null;
    const second = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'fresh-owner',
      ownerLabel: 'fresh',
      resource: 'dev-server',
      reason: 'deploy',
      ttlSec: 60,
      maxWaitSec: 0,
      hostLocalOwnerPid: hostLocalOwnerPidFromLabel,
      onStaleHolderReclaimed: (info) => {
        reclaimed = info;
      },
    });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.status).toBe('held');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.pid).toBe(deadPid);
    expect(reclaimed!.holder.owner).toBe(staleOwner);

    await _resetListenersForTests();
    await _resetForTests();
  });

  it.skipIf(!live)('does NOT reclaim a LIVE holder — coalesce against a live pid stays blocked', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const liveOwner = `stale-owner:${process.pid}`; // this test process is definitely alive

    const first = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: liveOwner,
      ownerLabel: 'live',
      resource: 'dev-server',
      reason: 'test',
      ttlSec: 60,
      maxWaitSec: 0,
    });
    expect(first.ok).toBe(true);

    let reclaimCalled = false;
    const second = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'fresh-owner',
      ownerLabel: 'fresh',
      resource: 'dev-server',
      reason: 'deploy',
      ttlSec: 60,
      maxWaitSec: 0,
      hostLocalOwnerPid: hostLocalOwnerPidFromLabel,
      onStaleHolderReclaimed: () => {
        reclaimCalled = true;
      },
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('held_exclusive');
    expect(reclaimCalled).toBe(false);

    await _resetListenersForTests();
    await _resetForTests();
  });

  it.skipIf(!live)('an owner shape hostLocalOwnerPid does not recognize is left alone (no-op, normal conflict)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const unrelatedOwner = 'plain-owner-no-pid-shape';

    const first = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: unrelatedOwner,
      ownerLabel: 'unrelated',
      resource: 'dev-server',
      reason: 'test',
      ttlSec: 60,
      maxWaitSec: 0,
    });
    expect(first.ok).toBe(true);

    const second = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'fresh-owner',
      ownerLabel: 'fresh',
      resource: 'dev-server',
      reason: 'deploy',
      ttlSec: 60,
      maxWaitSec: 0,
      hostLocalOwnerPid: hostLocalOwnerPidFromLabel, // returns null for this owner shape
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('held_exclusive');

    await _resetListenersForTests();
    await _resetForTests();
  });
});

/**
 * EI-18833814302562374 — the reclaim must cover the WAITING path too.
 *
 * The reclaim above originally ran only when `maxWaitSec <= 0`, on the reasoning
 * that a waiting caller "already has its own TTL/drain recovery". It does not:
 * `maxWaitSec` drains SHARED holders, while an EXCLUSIVE conflict returns
 * `held_exclusive` immediately. So a waiting caller had strictly LESS recovery
 * than a no-wait one — which is why a killed deploy's `release-deploy` lock
 * (maxDrainSec 0) self-healed while its `dev-server` lock (maxDrainSec 120)
 * blocked every deploy on the box for the holder's full 20-minute TTL.
 */
describe('acquireResourceExclusiveWithWait — dead-holder reclaim on the WAITING path (EI-18833814302562374)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('reclaims a definitively-dead exclusive holder when maxWaitSec > 0', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const deadPid = await definitelyDeadPid();
    const staleOwner = `stale-owner:${deadPid}`;

    // A deploy killed mid-flight leaves this behind on `dev-server`.
    const first = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: staleOwner,
      ownerLabel: 'stale',
      resource: 'dev-server',
      reason: 'test',
      ttlSec: 60,
      maxWaitSec: 0,
    });
    expect(first.ok).toBe(true);

    let reclaimed: StaleHolderReclaimedInfo | null = null;
    const startedAt = Date.now();
    // The deploy's own withDrain shape: a DRAIN budget, not a no-wait coalesce.
    const second = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'fresh-owner',
      ownerLabel: 'fresh',
      resource: 'dev-server',
      reason: 'release deploy (drain before swap)',
      ttlSec: 60,
      maxWaitSec: 120,
      hostLocalOwnerPid: hostLocalOwnerPidFromLabel,
      onStaleHolderReclaimed: (info) => {
        reclaimed = info;
      },
    });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.status).toBe('held');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.pid).toBe(deadPid);
    expect(reclaimed!.holder.owner).toBe(staleOwner);
    // Self-heal is immediate — never "wait out the holder's TTL".
    expect(Date.now() - startedAt).toBeLessThan(30_000);

    await _resetListenersForTests();
    await _resetForTests();
  });

  it.skipIf(!live)('does NOT reclaim a LIVE exclusive holder on the waiting path', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const liveOwner = `stale-owner:${process.pid}`; // this test process is definitely alive

    const first = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: liveOwner,
      ownerLabel: 'live',
      resource: 'dev-server',
      reason: 'test',
      ttlSec: 60,
      maxWaitSec: 0,
    });
    expect(first.ok).toBe(true);

    let reclaimed = false;
    const second = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'fresh-owner',
      ownerLabel: 'fresh',
      resource: 'dev-server',
      reason: 'release deploy (drain before swap)',
      ttlSec: 60,
      maxWaitSec: 5,
      hostLocalOwnerPid: hostLocalOwnerPidFromLabel,
      onStaleHolderReclaimed: () => {
        reclaimed = true;
      },
    });

    // A live holder is never stolen — single-flighting still holds.
    expect(reclaimed).toBe(false);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('held_exclusive');

    await _resetListenersForTests();
    await _resetForTests();
  });
});

// The P-008 staging bridge vs. git-sync: a one-shot exclusive acquirer that fires on a short
// period must not be able to starve a queued one, and a queued waiter that gives up must not
// leave a ticket the cascade later turns into a lease nobody releases.
describe('acquireResourceExclusiveQueued (exclusive FIFO wait)', async () => {
  const live = await dbLive();

  const oneShot = (ws: string, owner: string) =>
    inWorkspaceTxn(ws, owner, (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: ws,
        resource: 'dev-server',
        mode: 'exclusive',
        owner,
        ownerLabel: `res:${owner}`,
        reason: 'periodic one-shot',
        ttlSec: 60,
      }),
    );
  const queued = (ws: string, owner: string, maxQueueSec: number) =>
    acquireResourceExclusiveQueued({
      coordinationDomain: ws,
      owner,
      ownerLabel: `res:${owner}`,
      resource: 'dev-server',
      reason: 'absorb lineage',
      ttlSec: 60,
      maxQueueSec,
      pollMs: 100,
    });
  const ownerRows = async (ws: string, owner: string) => {
    const pool = getTxPool();
    const [locks, tickets] = await Promise.all([
      pool`SELECT 1 FROM agent_resource_locks WHERE coordination_domain = ${ws} AND owner = ${owner}`,
      pool`SELECT 1 FROM agent_resource_exclusive_queue WHERE coordination_domain = ${ws} AND owner = ${owner}`,
    ]);
    return { locks: locks.length, tickets: tickets.length };
  };

  it.skipIf(!live)('is granted on the holder release and a later one-shot cannot jump its ticket', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const fire = await oneShot(ws, 'git-sync-fire-1');
    expect(fire.ok).toBe(true);
    if (!fire.ok) return;

    const pending = queued(ws, 'bridge', 10);
    await sleep(400);
    expect(await ownerRows(ws, 'bridge')).toEqual({ locks: 0, tickets: 1 });

    await rel(ws, 'git-sync-fire-1', fire.lock_id);
    const nextFire = await oneShot(ws, 'git-sync-fire-2');
    expect(nextFire.ok).toBe(false);
    if (!nextFire.ok) expect(nextFire.reason).toBe('held_exclusive');

    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: 'held' });
    expect(await ownerRows(ws, 'bridge')).toEqual({ locks: 1, tickets: 0 });
    if (r.ok) await rel(ws, 'bridge', r.lock_id);

    await _resetListenersForTests();
    await _resetForTests();
  });

  it.skipIf(!live)('leaves neither a ticket nor a late lease behind when it gives up', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const fire = await oneShot(ws, 'git-sync-fire-1');
    expect(fire.ok).toBe(true);
    if (!fire.ok) return;

    const r = await queued(ws, 'bridge', 1);
    expect(r).toMatchObject({ ok: false, reason: 'queue_timeout', queue_position: 1 });
    expect(await ownerRows(ws, 'bridge')).toEqual({ locks: 0, tickets: 0 });

    // Without the cleanup the cascade would grant the abandoned ticket right here.
    await rel(ws, 'git-sync-fire-1', fire.lock_id);
    expect(await ownerRows(ws, 'bridge')).toEqual({ locks: 0, tickets: 0 });
    const nextFire = await oneShot(ws, 'git-sync-fire-2');
    expect(nextFire.ok).toBe(true);
    if (nextFire.ok) await rel(ws, 'git-sync-fire-2', nextFire.lock_id);

    await _resetListenersForTests();
    await _resetForTests();
  });
});
