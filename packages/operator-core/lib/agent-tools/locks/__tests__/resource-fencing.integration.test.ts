/**
 * resource-fencing — fencing tokens on correctness-class resource locks (D-001).
 *
 * Plan: locks-correctness-hardening-2026-06-04. File locks stay fail-open; the
 * correctness-class named resources (db-schema, dev-server) carry a monotonic
 * `fence_seq` minted on every EXCLUSIVE grant so a paused/zombie holder whose
 * lease lapsed and was re-granted can be detected + rejected before it corrupts
 * shared state. Also covers the resource-side idempotency ledger.
 *
 * Live papercusp_su, .skipIf(!live), unique coordination domain per test.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
  assertResourceFenceCurrent,
  checkResourceAction,
  recordResourceAction,
  readResourceLockStatus,
  type ResourceMode,
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
const uniqueWs = () => `fence-test-ws-${Date.now()}-${wsSeq++}`;

const acq = (ws: string, owner: string, resource: string, mode: ResourceMode, ttlSec = 60) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireResource(tx, {
      coordinationDomain: ws,
      resource,
      mode,
      owner,
      ownerLabel: `res:${owner}`,
      reason: 'fence test',
      ttlSec,
    }),
  );

const rel = (ws: string, owner: string, lockId: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryReleaseResource(tx, { coordinationDomain: ws, owner, lockId }),
  );

const assertFence = (ws: string, resource: string, lockId: string, fenceSeq: number) =>
  assertResourceFenceCurrent(getTxPool(), { coordinationDomain: ws, resource, lockId, fenceSeq });

describe('resource-fencing (D-001)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('an immediately-held exclusive mints a non-zero fence; shared mints 0', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(x.status).toBe('held');
    expect(x.fence_seq).toBeGreaterThan(0);

    await rel(ws, 'X', x.lock_id);

    const s = await acq(ws, 'S', 'dev-server', 'shared');
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.fence_seq).toBe(0);
  });

  it.skipIf(!live)('fences are monotonic per resource across successive exclusive grants', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acq(ws, 'A', 'db-schema', 'exclusive');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await rel(ws, 'A', a.lock_id);

    const b = await acq(ws, 'B', 'db-schema', 'exclusive');
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    await rel(ws, 'B', b.lock_id);

    const c = await acq(ws, 'C', 'db-schema', 'exclusive');
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    // Strictly increasing: each grant bumps the per-resource counter.
    expect(b.fence_seq).toBeGreaterThan(a.fence_seq);
    expect(c.fence_seq).toBeGreaterThan(b.fence_seq);
  });

  it.skipIf(!live)('assertResourceFenceCurrent: the live holder is current', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;

    const fc = await assertFence(ws, 'dev-server', x.lock_id, x.fence_seq);
    expect(fc.current).toBe(true);
    if (fc.current) expect(fc.live_fence_seq).toBe(x.fence_seq);
  });

  it.skipIf(!live)('a superseded (paused/zombie) holder is rejected: lease lapsed + re-granted → superseded', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    // X acquires the exclusive, then its lease lapses (simulate a paused/zombie
    // holder: force its row expired). It still believes it holds fence f1.
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    await getTxPool()`
      UPDATE agent_resource_locks
         SET expires_ts = clock_timestamp() - interval '1 hour'
       WHERE coordination_domain = ${ws} AND lock_id = ${x.lock_id}::uuid
    `;

    // Y now acquires the exclusive (sweeps X's expired row, gets a higher fence).
    const y = await acq(ws, 'Y', 'dev-server', 'exclusive');
    expect(y.ok).toBe(true);
    if (!y.ok) return;
    expect(y.status).toBe('held');
    expect(y.fence_seq).toBeGreaterThan(x.fence_seq);

    // X's stale fence is rejected — this is the corruption the action avoids.
    const stale = await assertFence(ws, 'dev-server', x.lock_id, x.fence_seq);
    expect(stale.current).toBe(false);
    if (!stale.current) {
      expect(stale.reason).toBe('superseded');
      expect(stale.live_fence_seq).toBe(y.fence_seq);
    }

    // Y, the live holder, is current.
    expect((await assertFence(ws, 'dev-server', y.lock_id, y.fence_seq)).current).toBe(true);
  });

  it.skipIf(!live)('a released exclusive: the old fence reports expired_or_released', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    await rel(ws, 'X', x.lock_id);

    const fc = await assertFence(ws, 'dev-server', x.lock_id, x.fence_seq);
    expect(fc.current).toBe(false);
    if (!fc.current) expect(fc.reason).toBe('expired_or_released');
  });

  it.skipIf(!live)('the drain→held flip mints a fence (draining carries 0 until effective)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acq(ws, 'A', 'dev-server', 'shared');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    // While draining the exclusive is NOT yet effective → fence still 0.
    expect(x.status).toBe('draining');
    expect(x.fence_seq).toBe(0);
    expect((await readResourceLockStatus(getTxPool(), x.lock_id)).fence_seq).toBe(0);

    // Drain the shared holder — the release cascade flips X to held + mints its fence.
    await rel(ws, 'A', a.lock_id);
    const st = await readResourceLockStatus(getTxPool(), x.lock_id);
    expect(st.status).toBe('held');
    expect(st.fence_seq).toBeGreaterThan(0);
    expect((await assertFence(ws, 'dev-server', x.lock_id, st.fence_seq ?? 0)).current).toBe(true);
  });

  it.skipIf(!live)('the resource-side action ledger is first-writer-wins (idempotent)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const actionKey = `migrate:fence-test-${Date.now()}.sql`;

    // Not yet applied.
    expect((await checkResourceAction(getTxPool(), ws, actionKey)).applied).toBe(false);

    // First record wins.
    const first = await inWorkspaceTxn(ws, 'A', (tx) => recordResourceAction(tx, ws, actionKey, 7));
    expect(first).toBe(true);

    const rec = await checkResourceAction(getTxPool(), ws, actionKey);
    expect(rec.applied).toBe(true);
    expect(rec.fence_seq).toBe(7);

    // Second record is a no-op (already applied) — the checked re-apply guard.
    const second = await inWorkspaceTxn(ws, 'A', (tx) => recordResourceAction(tx, ws, actionKey, 9));
    expect(second).toBe(false);
    // Fence unchanged — first writer's value is retained.
    expect((await checkResourceAction(getTxPool(), ws, actionKey)).fence_seq).toBe(7);

    await _resetForTests();
  });
});
