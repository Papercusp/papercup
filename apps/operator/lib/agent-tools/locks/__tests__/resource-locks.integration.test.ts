/**
 * resource-locks — named-resource locks with drain semantics.
 *
 * Plan: named-resource-locks-drain-2026-06-02 (Phase 1 + the Phase 2
 * drain state machine, which lives in the store).
 *
 * Exercises the behaviour the file-lock tables can't express: a named
 * resource with MANY shared holders + ONE exclusive holder, gated by a
 * writer-priority drain. Mirrors su-locks.integration.test.ts: live
 * papercusp_su, .skipIf(!live), a unique coordination domain per test so
 * lock state is isolated (the registry rows are global + read-only here).
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
  tryHeartbeatResource,
  readResourceLockStatus,
  readResourceQueue,
  releaseAllResourcesForOwner,
  listResources,
  getResource,
  type ResourceMode,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';

async function dbLive(): Promise<boolean> {
  try {
    const sql = getTxPool();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let wsSeq = 0;
const uniqueWs = () => `res-test-ws-${Date.now()}-${wsSeq++}`;

const acq = (
  ws: string,
  owner: string,
  resource: string,
  mode: ResourceMode,
  ttlSec = 60,
) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireResource(tx, {
      coordinationDomain: ws,
      resource,
      mode,
      owner,
      ownerLabel: `res:${owner}`,
      reason: 'integration test',
      ttlSec,
    }),
  );

const rel = (ws: string, owner: string, lockId: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryReleaseResource(tx, { coordinationDomain: ws, owner, lockId }),
  );

const status = (lockId: string) => readResourceLockStatus(getTxPool(), lockId);

describe('resource-locks (named, shared/exclusive, drain)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('rejects an unregistered resource name with unknown_resource', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const r = await acq(ws, 'A', 'no-such-resource-zzz', 'shared');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_resource');
  });

  it.skipIf(!live)('grants exclusive immediately when no shared holders exist', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (x.ok) expect(x.status).toBe('held');
  });

  it.skipIf(!live)('shared holders coexist; exclusive drains them, refusing new shared, then is granted', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acq(ws, 'A', 'dev-server', 'shared');
    const b = await acq(ws, 'B', 'dev-server', 'shared');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Two shared holders are visible in the queue.
    const q1 = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(q1.holders.filter((h) => h.mode === 'shared').length).toBe(2);

    // Exclusive requested while shared holders exist → accepted but DRAINING.
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(x.status).toBe('draining');

    // Writer-priority: a NEW shared acquire is refused while draining.
    const c = await acq(ws, 'C', 'dev-server', 'shared');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('exclusive_pending');

    // Drain one shared holder — still draining (B remains).
    await rel(ws, 'A', a.lock_id);
    expect((await status(x.lock_id)).status).toBe('draining');

    // Drain the last shared holder — the release cascade flips X to held.
    await rel(ws, 'B', b.lock_id);
    expect((await status(x.lock_id)).status).toBe('held');
  });

  it.skipIf(!live)('refuses an in-place upgrade: a shared holder requesting exclusive gets holds_shared', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const a = await acq(ws, 'A', 'dev-server', 'shared');
    expect(a.ok).toBe(true);
    const up = await acq(ws, 'A', 'dev-server', 'exclusive');
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.reason).toBe('holds_shared');
  });

  it.skipIf(!live)('heartbeat extends a held resource lease', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const a = await acq(ws, 'A', 'dev-server', 'shared', 30);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const h = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryHeartbeatResource(tx, ws, 'A', a.lock_id, 120),
    );
    expect(h.extended).toBe(true);
    expect(h.expires_ts).not.toBeNull();
  });

  it.skipIf(!live)('refuses a second exclusive requester while one is held (held_exclusive)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const y = await acq(ws, 'Y', 'dev-server', 'exclusive'); // granted (no shared holders)
    expect(y.ok).toBe(true);
    if (y.ok) expect(y.status).toBe('held');
    const z = await acq(ws, 'Z', 'dev-server', 'exclusive'); // a different owner
    expect(z.ok).toBe(false);
    if (!z.ok) expect(z.reason).toBe('held_exclusive');
  });

  it.skipIf(!live)('release reports the resources whose exclusive was released (for back-up broadcast)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    const r = await rel(ws, 'X', x.lock_id);
    expect(r.exclusiveResources).toContain('dev-server');
  });

  it.skipIf(!live)('releaseAllResourcesForOwner clears every lock the owner holds (session-end, P-019)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const a = await acq(ws, 'A', 'dev-server', 'shared');
    const b = await acq(ws, 'A', 'db-schema', 'exclusive');
    expect(a.ok && b.ok).toBe(true);

    const r = await inWorkspaceTxn(ws, 'A', (tx) =>
      releaseAllResourcesForOwner(tx, ws, 'A'),
    );
    expect(r.released).toBe(2);
    expect(r.exclusiveResources).toContain('db-schema');

    const q = await readResourceQueue(getTxPool(), { coordinationDomain: ws });
    expect(q.holders.some((h) => h.owner === 'A')).toBe(false);
  });

  it.skipIf(!live)('seeds the dev-server and db-schema resources with their enforcement levels', async () => {
    await ensureBootstrap();
    const all = await listResources(getTxPool());
    const names = all.map((r) => r.resource);
    expect(names).toContain('dev-server');
    expect(names).toContain('db-schema');
    expect((await getResource(getTxPool(), 'dev-server'))?.enforcement).toBe('enforced'); // P-016 (migration 006)
    expect((await getResource(getTxPool(), 'db-schema'))?.enforcement).toBe('checked');
    // migration 007 — resources registered from observed parallelism pain.
    expect(names).toContain('shop');
    expect(names).toContain('desktop-sidecar');
    expect(names).toContain('libs-papercusp-submodule');
    expect((await getResource(getTxPool(), 'shop'))?.enforcement).toBe('enforced');
    await _resetForTests();
  });
});
