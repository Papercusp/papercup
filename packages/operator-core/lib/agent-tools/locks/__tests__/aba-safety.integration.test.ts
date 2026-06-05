/**
 * aba-safety — ABA-safe heartbeat/release across all three lock systems (D-009,
 * locks-correctness-hardening-2026-06-04).
 *
 * The hazard: a sleeping agent A holds a lock, its TTL lapses, the lock is
 * swept and RE-GRANTED to B (A→B→A on the (owner, path)/(domain, resource)
 * key). A wakes and heartbeats/releases using its STALE handle. If those paths
 * matched on (owner, path) alone, A would extend or free B's lock — corrupting
 * the grant. `lock_id` (a fresh UUID per grant) is the ABA tag: every
 * heartbeat/release/*_resource path matches on `lock_id`, so A's stale handle
 * matches NOTHING and is a safe no-op. This suite is the executable AUDIT of
 * that invariant for file locks, named-resource locks, and granular locks.
 *
 * Live papercusp_su; force-expiry simulates the sleeping holder.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquire,
  tryRelease,
  tryHeartbeat,
  tryAcquireResource,
  tryReleaseResource,
  tryHeartbeatResource,
  readResourceQueue,
  tryAcquireGranular,
  releaseGranular,
  readGranularHolders,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let wsSeq = 0;
const uniqueWs = () => `aba-test-ws-${Date.now()}-${wsSeq++}`;

const expireFileLock = (ws: string, lockId: string) =>
  getTxPool()`
    UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 hour'
     WHERE coordination_domain = ${ws} AND lock_id = ${lockId}::uuid
  `;
const expireResourceLock = (ws: string, lockId: string) =>
  getTxPool()`
    UPDATE agent_resource_locks SET expires_ts = clock_timestamp() - interval '1 hour'
     WHERE coordination_domain = ${ws} AND lock_id = ${lockId}::uuid
  `;
const expireGranular = (ws: string, lockId: string) =>
  getTxPool()`
    UPDATE agent_granular_locks SET expires_ts = clock_timestamp() - interval '1 hour'
     WHERE coordination_domain = ${ws} AND lock_id = ${lockId}::uuid
  `;

describe('ABA-safety audit (D-009)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('file lock: A→B→A — A\'s stale heartbeat + release are no-ops, B is untouched', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const path = 'aba/file.ts';

    // A acquires, then "sleeps": its lease lapses.
    const a = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryAcquire(tx, { coordinationDomain: ws, owner: 'A', ownerLabel: 'A', paths: [path], intent: 'a', ttlSec: 60 }),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await expireFileLock(ws, a.lock_id);

    // B acquires the same path (sweeps A's expired row, gets a fresh lock_id).
    const b = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryAcquire(tx, { coordinationDomain: ws, owner: 'B', ownerLabel: 'B', paths: [path], intent: 'b', ttlSec: 60 }),
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.lock_id).not.toBe(a.lock_id);

    // A wakes: stale heartbeat → not extended; stale release → frees nothing.
    const hb = await inWorkspaceTxn(ws, 'A', (tx) => tryHeartbeat(tx, ws, 'A', a.lock_id, 600));
    expect(hb.extended).toBe(false);
    const relA = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'A', lockId: a.lock_id }),
    );
    expect(relA.released).toEqual([]);

    // B still holds the path.
    const stillB = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryAcquire(tx, { coordinationDomain: ws, owner: 'B', ownerLabel: 'B', paths: [path], intent: 'b2', ttlSec: 60 }),
    );
    expect(stillB.ok).toBe(true); // B can refresh its own lock (it was never freed)
  });

  it.skipIf(!live)('resource lock: A\'s stale heartbeat + release do not touch B\'s exclusive', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryAcquireResource(tx, { coordinationDomain: ws, resource: 'dev-server', mode: 'exclusive', owner: 'A', ownerLabel: 'A', reason: 'a', ttlSec: 60 }),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await expireResourceLock(ws, a.lock_id);

    const b = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryAcquireResource(tx, { coordinationDomain: ws, resource: 'dev-server', mode: 'exclusive', owner: 'B', ownerLabel: 'B', reason: 'b', ttlSec: 60 }),
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    // A's stale heartbeat → not extended.
    const hb = await inWorkspaceTxn(ws, 'A', (tx) => tryHeartbeatResource(tx, ws, 'A', a.lock_id, 600));
    expect(hb.extended).toBe(false);
    // A's stale release-by-lock_id → frees nothing.
    const relA = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryReleaseResource(tx, { coordinationDomain: ws, owner: 'A', lockId: a.lock_id }),
    );
    expect(relA.released).toBe(0);

    // B's exclusive is intact + effective.
    const q = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(q.holders.some((h) => h.owner === 'B' && h.mode === 'exclusive')).toBe(true);
    expect(q.holders.some((h) => h.owner === 'A')).toBe(false);
  });

  it.skipIf(!live)('granular lock: A\'s stale release frees nothing of B\'s', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const path = 'aba/dir/leaf.ts';

    const a = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryAcquireGranular(tx, { coordinationDomain: ws, path, mode: 'X', owner: 'A', ownerLabel: 'A', intent: 'a', ttlSec: 60 }),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await expireGranular(ws, a.lock_id);

    const b = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryAcquireGranular(tx, { coordinationDomain: ws, path, mode: 'X', owner: 'B', ownerLabel: 'B', intent: 'b', ttlSec: 60 }),
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    // A's stale release → 0 rows; B's lock-set intact.
    const relA = await inWorkspaceTxn(ws, 'A', (tx) => releaseGranular(tx, ws, 'A', a.lock_id));
    expect(relA.released).toBe(0);
    const holders = await readGranularHolders(getTxPool(), ws, path);
    expect(holders.some((h) => h.owner === 'B' && h.mode === 'X')).toBe(true);
    expect(holders.some((h) => h.owner === 'A')).toBe(false);

    await _resetForTests();
  });
});
