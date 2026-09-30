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
  runBackgroundJanitorOnce,
  tryAcquireResource,
  tryReleaseResource,
  tryHeartbeatResource,
  readOwnedResourceLockDomain,
  readResourceLockStatus,
  readResourceQueue,
  listLiveResourceDomains,
  registerResource,
  releaseAllResourcesForOwner,
  listResources,
  getResource,
  type ResourceMode,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { acquireResourceExclusiveWithWait } from '../resource-acquire-wait';
import { _resetListenersForTests } from '../workspace-listener';

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
  queueOnConflict = false,
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
      queueOnConflict,
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

  it.skipIf(!live)('EI-23229103052811419: an incumbent shared holder can renew while an exclusive drain is pending', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acq(ws, 'A', 'dev-server', 'shared', 60);
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const x = await acq(ws, 'X', 'dev-server', 'exclusive', 60);
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(x.status).toBe('draining');

    // The git-sync action refreshes shared leases through tryAcquireResource,
    // not tryHeartbeatResource. Renewal must not be mistaken for a new entrant
    // while the restart's exclusive is still waiting for A to finish.
    const refreshed = await acq(ws, 'A', 'dev-server', 'shared', 120);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.lock_id).toBe(a.lock_id);

    await rel(ws, 'A', a.lock_id);
    expect((await status(x.lock_id)).status).toBe('held');
    await rel(ws, 'X', x.lock_id);
  });

  it.skipIf(!live)('unscoped queue identifies each simultaneous holder by named resource', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const dev = await acq(ws, 'dev-owner', 'dev-server', 'shared');
    const db = await acq(ws, 'db-owner', 'db-schema', 'shared');
    expect(dev.ok && db.ok).toBe(true);

    const q = await readResourceQueue(getTxPool(), { coordinationDomain: ws });
    expect(q.holders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: 'dev-owner', resource: 'dev-server' }),
        expect.objectContaining({ owner: 'db-owner', resource: 'db-schema' }),
      ]),
    );

    if (dev.ok) await rel(ws, 'dev-owner', dev.lock_id);
    if (db.ok) await rel(ws, 'db-owner', db.lock_id);
  });

  // B4 — drain-timeout queue fairness. A holds shared (long TTL); B requests
  // exclusive with a SHORT drain budget and a queued exclusive waiter C sits
  // behind it. B's drain times out (A never drains) → B must NOT be silently
  // granted, and C (the recorded waiter, queue order) must be the one able to
  // proceed once B's exclusive is released — B does NOT jump back ahead.
  it.skipIf(!live)('drain-timeout does not grant the timed-out exclusive; the queued waiter is next (fairness)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    // A holds shared on a long TTL — it will NOT drain within B's budget.
    const a = await acq(ws, 'A', 'dev-server', 'shared', 600);
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // C queues an exclusive waiter behind B-to-be: while A's shared is live and
    // (about to be) B's draining exclusive exists, C's exclusive is refused and
    // recorded as a waiter (queue position). Acquire C's waiter row FIRST so the
    // queue is populated before B's drain wait runs.
    // (We request C before B so the refusal reason is the clean shared-present
    //  path; either order leaves C a recorded waiter — the queue is a set keyed
    //  by owner, ordered by queued_ts.)

    // B requests exclusive with a 1s drain budget → enters 'draining' (A in),
    // waits, and times out because A holds its shared for 600s.
    const bStart = Date.now();
    const b = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'B',
      ownerLabel: 'res:B',
      resource: 'dev-server',
      reason: 'restart attempt (will time out)',
      ttlSec: 600,
      maxWaitSec: 1,
    });
    const bWaited = Date.now() - bStart;
    // Timed out, NOT granted. The exclusive row is LEFT in place (the writer
    // still wants in; it TTL-expires or is released) — but the BODY never ran.
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toBe('drain_timeout');
    expect(bWaited).toBeGreaterThanOrEqual(900); // actually waited ~1s, no instant give-up

    // C now queues an exclusive waiter behind B's still-present draining exclusive.
    const c = await acq(ws, 'C', 'dev-server', 'exclusive', 60, true);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toBe('held_exclusive'); // B's draining exclusive blocks C → C recorded as waiter

    // The queue shows A (shared, held) + B (exclusive, draining) — and NOT a
    // grant for C. B timing out granted B NOTHING destructive.
    const q = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    const bRow = q.holders.find((h) => h.owner === 'B');
    expect(bRow?.mode).toBe('exclusive');
    expect(bRow?.status).toBe('draining'); // never flipped to held — A blocks
    expect(q.holders.some((h) => h.owner === 'C')).toBe(false); // C holds nothing

    // Now B gives up its claim (release its still-parked exclusive). The waiter
    // ledger names C as the queued audience — fairness: C is next, not B again.
    const relB = await rel(ws, 'B', bRow!.lock_id);
    expect(relB.exclusiveResources).toContain('dev-server');
    expect(relB.waiters['dev-server'] ?? []).toContain('C'); // C is the queued grantee-to-be

    // A is still holding shared, so C's exclusive still has to drain A — but C
    // (not B) is the one now contending for the slot. Drain A; then C acquires.
    await rel(ws, 'A', a.lock_id);
    const cGot = await acq(ws, 'C', 'dev-server', 'exclusive');
    expect(cGot.ok).toBe(true);
    if (!cGot.ok) return;
    expect(cGot.status).toBe('held'); // no shared holders left → C is granted

    // B did NOT silently re-acquire: only C holds the exclusive now.
    const q2 = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    const excl = q2.holders.filter((h) => h.mode === 'exclusive');
    expect(excl.map((h) => h.owner)).toEqual(['C']);

    await _resetListenersForTests();
    await _resetForTests();
  });

  it.skipIf(!live)('admits queued exclusive requests in FIFO order after each prior grant releases', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acq(ws, 'A', 'dev-server', 'shared');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // B becomes the active draining exclusive. C and D are refused but retain
    // durable tickets; a retry by D must not jump ahead of C after B releases.
    const b = await acq(ws, 'B', 'dev-server', 'exclusive');
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.status).toBe('draining');

    const c = await acq(ws, 'C', 'dev-server', 'exclusive', 60, true);
    const d = await acq(ws, 'D', 'dev-server', 'exclusive', 60, true);
    expect(c.ok && d.ok).toBe(false);
    if (c.ok || d.ok) return;
    expect(c.queue_ticket).toBeDefined();
    expect(d.queue_ticket).toBeDefined();
    expect(c.queue_position).toBe(1);
    expect(d.queue_position).toBe(2);

    const queued = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(queued.queue?.map((entry) => entry.owner)).toEqual(['C', 'D']);

    // Releasing the last shared holder makes B effective, but does not admit C
    // until B itself releases. The queue remains ordered while B is held.
    await rel(ws, 'A', a.lock_id);
    expect((await status(b.lock_id)).status).toBe('held');
    expect((await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' })).queue?.map((entry) => entry.owner)).toEqual(['C', 'D']);

    // B's release promotes only C, leaving D pending behind it.
    await rel(ws, 'B', b.lock_id);
    const afterB = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    const cHolder = afterB.holders.find((holder) => holder.owner === 'C' && holder.mode === 'exclusive');
    expect(cHolder?.status).toBe('held');
    expect(afterB.queue?.map((entry) => entry.owner)).toEqual(['D']);

    // C's release then promotes D; no later retry can have leapfrogged C.
    await rel(ws, 'C', cHolder!.lock_id);
    const afterC = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    const dHolder = afterC.holders.find((holder) => holder.owner === 'D' && holder.mode === 'exclusive');
    expect(dHolder?.status).toBe('held');
    expect(afterC.queue).toEqual([]);
    await rel(ws, 'D', dHolder!.lock_id);
  });

  it.skipIf(!live)('garbage-collects expired exclusive tickets before promoting the next head', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acq(ws, 'A', 'dev-server', 'exclusive');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect((await acq(ws, 'B', 'dev-server', 'exclusive', 60, true)).ok).toBe(false);
    expect((await acq(ws, 'C', 'dev-server', 'exclusive', 60, true)).ok).toBe(false);

    // B abandoned its request. Expiry GC must remove it so C becomes the head
    // when A releases, while agent_resource_waiters remains an independent
    // notification ledger.
    await getTxPool()`
      UPDATE agent_resource_exclusive_queue
         SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE coordination_domain = ${ws}
         AND resource = 'dev-server'
         AND owner = 'B'
    `;

    const waiterRowsBeforeRelease = await getTxPool()`
      SELECT owner
        FROM agent_resource_waiters
       WHERE coordination_domain = ${ws}
         AND resource = 'dev-server'
    `;
    expect(waiterRowsBeforeRelease.map((row) => row.owner).sort()).toEqual(['B', 'C']);

    await rel(ws, 'A', a.lock_id);

    const q = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(q.queue).toEqual([]);
    expect(q.holders.find((holder) => holder.owner === 'C' && holder.mode === 'exclusive')?.status).toBe('held');
    // The existing owner-keyed waiter ledger is consumed by the release's
    // targeted back-up broadcast; queue-ticket GC must not replace that
    // ledger, and the release still clears it as before.
    const waiterRowsAfterRelease = await getTxPool()`
      SELECT owner
        FROM agent_resource_waiters
       WHERE coordination_domain = ${ws}
         AND resource = 'dev-server'
    `;
    expect(waiterRowsAfterRelease).toEqual([]);
    await rel(ws, 'C', q.holders.find((holder) => holder.owner === 'C')!.lock_id);
  });

  it.skipIf(!live)('keeps expired resource waiters off the hot path and janitor-cleans them', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const sql = getTxPool();

    // An abandoned notification waiter is not part of resource admission.
    // The acquire hot path must leave it alone; only the background janitor
    // should pay the cleanup write.
    await sql`
      INSERT INTO agent_resource_waiters
        (coordination_domain, resource, owner, owner_label, expires_ts)
      VALUES
        (${ws}, 'dev-server', 'expired-waiter', 'expired',
         clock_timestamp() - interval '1 second')
    `;

    const acquired = await acq(ws, 'fresh-owner', 'dev-server', 'shared');
    expect(acquired.ok).toBe(true);
    const afterHotPath = await sql<Array<{ owner: string }>>`
      SELECT owner
        FROM agent_resource_waiters
       WHERE coordination_domain = ${ws}
         AND owner = 'expired-waiter'
    `;
    expect(afterHotPath).toEqual([{ owner: 'expired-waiter' }]);

    await runBackgroundJanitorOnce();
    const afterJanitor = await sql<Array<{ owner: string }>>`
      SELECT owner
        FROM agent_resource_waiters
       WHERE coordination_domain = ${ws}
         AND owner = 'expired-waiter'
    `;
    expect(afterJanitor).toEqual([]);

    if (acquired.ok) await rel(ws, 'fresh-owner', acquired.lock_id);
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

  it.skipIf(!live)(
    'WI-10004326: a lease acquired in another install domain is located by lock_id + owner and extended THERE',
    async () => {
      await ensureBootstrap();
      const acquiredIn = uniqueWs(); // e.g. the staging checkout's domain
      const servedFrom = uniqueWs(); // e.g. the release checkout's domain
      const a = await acq(acquiredIn, 'A', 'dev-server', 'shared', 30);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      // The defect: the serving operator's inferred domain does not hold the row.
      const miss = await inWorkspaceTxn(servedFrom, 'A', (tx) =>
        tryHeartbeatResource(tx, servedFrom, 'A', a.lock_id, 120),
      );
      expect(miss.extended).toBe(false);
      // The fix: the row's own domain, owner-scoped (another owner cannot locate it).
      expect(await readOwnedResourceLockDomain(getTxPool(), a.lock_id, 'A')).toBe(acquiredIn);
      expect(await readOwnedResourceLockDomain(getTxPool(), a.lock_id, 'B')).toBeNull();
      const located = (await readOwnedResourceLockDomain(getTxPool(), a.lock_id, 'A'))!;
      const hit = await inWorkspaceTxn(located, 'A', (tx) =>
        tryHeartbeatResource(tx, located, 'A', a.lock_id, 120),
      );
      expect(hit.extended).toBe(true);
      await rel(acquiredIn, 'A', a.lock_id);
    },
  );

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

  it.skipIf(!live)('does not late-grant a terminal exclusive conflict by default', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const holder = await acq(ws, 'holder', 'dev-server', 'exclusive');
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;

    // A caller that returns held_exclusive has no pending/grant contract. The
    // default must therefore leave neither a durable ticket nor a waiter that
    // could be promoted after this call has exited.
    const refused = await acq(ws, 'terminal', 'dev-server', 'exclusive');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('held_exclusive');
    expect(refused.queue_ticket).toBeUndefined();
    const beforeRelease = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(beforeRelease.queue).toEqual([]);

    const released = await rel(ws, 'holder', holder.lock_id);
    expect(released.waiters['dev-server'] ?? []).not.toContain('terminal');
    const afterRelease = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(afterRelease.queue).toEqual([]);
    expect(afterRelease.holders.some((entry) => entry.owner === 'terminal')).toBe(false);
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

  it.skipIf(!live)('release reports when the selected resource hold expired before release', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;

    // Simulate a paused holder whose TTL lapsed before it resumed to release.
    await getTxPool()`
      UPDATE agent_resource_locks
         SET expires_ts = clock_timestamp() - interval '1 hour'
       WHERE coordination_domain = ${ws} AND lock_id = ${x.lock_id}::uuid
    `;

    const r = await rel(ws, 'X', x.lock_id);
    expect(r.released).toBe(0);
    expect(r.expired).toHaveLength(1);
    expect(r.expired[0]).toMatchObject({
      lockId: x.lock_id,
      resource: 'dev-server',
      mode: 'exclusive',
    });
    expect(r.expired[0]?.expiredAt).toBeDefined();
    expect((await readResourceQueue(getTxPool(), { coordinationDomain: ws })).holders).toEqual([]);
  });

  it.skipIf(!live)('records refused acquirers as waiters; the exclusive release returns + clears them (A4)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    // X holds exclusive; C (shared) + D (exclusive) are refused → recorded waiters.
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect((await acq(ws, 'C', 'dev-server', 'shared')).ok).toBe(false); // exclusive_pending
    expect((await acq(ws, 'D', 'dev-server', 'exclusive', 60, true)).ok).toBe(false); // held_exclusive

    // Releasing X's exclusive returns the waiters (the targeted back-up audience).
    const r = await rel(ws, 'X', x.lock_id);
    expect(r.exclusiveResources).toContain('dev-server');
    expect([...(r.waiters['dev-server'] ?? [])].sort()).toEqual(['C', 'D']);

    // The queued D request is promoted by X's release. Release that promoted
    // lease before checking a fresh request, so this A4 assertion does not
    // bypass the FIFO admission rule under test elsewhere.
    const afterX = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    const dHolder = afterX.holders.find((holder) => holder.owner === 'D' && holder.mode === 'exclusive');
    expect(dHolder?.status).toBe('held');
    if (!dHolder) return;
    await rel(ws, 'D', dHolder.lock_id);

    // …and clears them — a second exclusive's release re-reads no waiters.
    const x2 = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x2.ok).toBe(true);
    if (!x2.ok) return;
    const r2 = await rel(ws, 'X', x2.lock_id);
    expect(r2.waiters['dev-server'] ?? []).toEqual([]);
  });

  it.skipIf(!live)('clears a waiter row when that owner successfully acquires (no spurious re-notify) (A4)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    // X holds exclusive; C is refused → recorded as a waiter on dev-server.
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect((await acq(ws, 'C', 'dev-server', 'shared')).ok).toBe(false);

    // C's exclusive lease on a DIFFERENT resource is irrelevant; what matters is
    // that once C acquires dev-server, its dev-server waiter row is gone. X
    // releases (read-clears existing waiters), then C acquires successfully.
    await rel(ws, 'X', x.lock_id);
    const cGot = await acq(ws, 'C', 'dev-server', 'shared');
    expect(cGot.ok).toBe(true);
    if (!cGot.ok) return;
    await rel(ws, 'C', cGot.lock_id);

    // A fresh exclusive by Z finds no leftover 'C' waiter (cleared on C's acquire).
    const z = await acq(ws, 'Z', 'dev-server', 'exclusive');
    expect(z.ok).toBe(true);
    if (!z.ok) return;
    const rz = await rel(ws, 'Z', z.lock_id);
    expect(rz.waiters['dev-server'] ?? []).toEqual([]);
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

  it.skipIf(!live)('releaseAllResourcesForOwner (all_mine) on a long domain (>54 chars) does not raise "channel name too long" and still flips a draining waiter to held (EI-39)', async () => {
    // Regression for EI-39: `locks:release { all_mine: true }` sweeps named-resource
    // locks via releaseAllResourcesForOwner, which fires resource_grant_cascade →
    // pg_notify(<channel>, …). With the raw `ch_coord_<domain>` naming, any domain
    // whose realpath pushes `ch_coord_<domain>` past PG's 63-byte channel cap (the
    // live release checkout, ~56 chars) made that pg_notify RAISE "channel name too
    // long", aborting the WHOLE release txn — so all_mine released NOTHING and the
    // PreToolUse-acquired lock survived to its 20-min TTL, wedging peers editing the
    // same file. The fix bounds the channel to ch_coord_<md5(domain)> on both the SQL
    // cascade (sql/013-bounded-notify-channel.sql) and the TS LISTEN side
    // (coordNotifyChannel). The existing su-locks-wait test covers the FILE-lock
    // cascade; this asserts the exact RESOURCE path the bug reported: a draining
    // exclusive must still flip to held through the all_mine cascade on an
    // over-long domain.
    await ensureBootstrap();
    const ws = `res-test-long-${Date.now()}-${'x'.repeat(64)}`;
    expect(`ch_coord_${ws}`.length).toBeGreaterThan(63); // the failing precondition

    // A holds shared; X requests exclusive → draining (writer-priority, A still in).
    const a = await acq(ws, 'A', 'dev-server', 'shared');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(x.status).toBe('draining');

    // A's session-end all_mine sweep drains the last shared holder; the cascade's
    // pg_notify must succeed (md5 channel) and flip X draining → held. Pre-fix this
    // threw "channel name too long" and rolled back, leaving A's lock + X draining.
    const r = await inWorkspaceTxn(ws, 'A', (tx) =>
      releaseAllResourcesForOwner(tx, ws, 'A'),
    );
    expect(r.released).toBe(1);
    expect((await status(x.lock_id)).status).toBe('held');

    const q2 = await readResourceQueue(getTxPool(), { coordinationDomain: ws });
    expect(q2.holders.some((h) => h.owner === 'A')).toBe(false);
  });

  it.skipIf(!live)('all_mine resource release survives a >63-byte NOTIFY channel domain (EI-39 regression)', async () => {
    await ensureBootstrap();
    // EI-39: `locks:release {all_mine:true}` failed with "channel name too
    // long" and released NOTHING, wedging locks to their TTL. The all_mine
    // sweep runs releaseAllResourcesForOwner → resource_grant_cascade, whose
    // pg_notify built `ch_coord_<domain>` from the repo realpath. For any
    // checkout deeper than 54 chars (e.g. the GREEN release checkout) that name
    // crosses PostgreSQL's 63-byte channel cap and pg_notify RAISES, rolling
    // back the whole release. sql/013 bounds the channel to ch_coord_<md5> (41
    // bytes); this pins the RESOURCE-cascade path (the §9 HTTP-MCP test covers
    // the file-lock grant_cascade — a long domain there, but not this leg).
    const ws = `/home/dev/papercupai-workspace/papercusp-release/res-${Date.now()}-${wsSeq++}`;
    expect(`ch_coord_${ws}`.length).toBeGreaterThan(63); // the failing precondition

    // A holds shared; B's exclusive parks in `draining` behind it. The NOTIFY
    // that used to overflow fires only when the cascade flips a draining
    // exclusive to held — exactly what A's session-end sweep triggers.
    const a = await acq(ws, 'A', 'dev-server', 'shared');
    const b = await acq(ws, 'B', 'dev-server', 'exclusive');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.status).toBe('draining');

    // Session-end all_mine sweep for A → resource_grant_cascade → B flips to
    // held → pg_notify on the bounded channel. Must NOT throw, and must
    // actually release A's lock (the bug released nothing).
    const r = await inWorkspaceTxn(ws, 'A', (tx) =>
      releaseAllResourcesForOwner(tx, ws, 'A'),
    );
    expect(r.released).toBe(1);
    // The drain completed atomically with the (previously-overflowing) NOTIFY.
    expect((await status(b.lock_id)).status).toBe('held');
  });

  // EI-24434173247501787: two operators serving from different checkouts put
  // the same undeclared resource in two caller-tree domains. Only a read keyed
  // on the NAME can see both — this pins that read against real SQL.
  it.skipIf(!live)('listLiveResourceDomains finds every domain holding a live lease on a name, and drops lapsed ones', async () => {
    await ensureBootstrap();
    // A unique registered name, NOT a real one such as `dev-server`: the
    // acquire guard now scans by name across domains, so a test lease on a
    // real resource in the live DB would briefly refuse a real acquirer.
    const res = `live-domains-${Date.now()}`;
    await inWorkspaceTxn(uniqueWs(), 'admin', (tx) => registerResource(tx, { resource: res, description: 'test' }));
    const wsA = uniqueWs();
    const wsB = uniqueWs();
    const a = await acq(wsA, 'A', res, 'exclusive');
    const b = await acq(wsB, 'B', res, 'exclusive', 1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const byName = await listLiveResourceDomains(getTxPool(), res);
    expect([...byName].sort()).toEqual([wsA, wsB].sort());
    const any = await listLiveResourceDomains(getTxPool());
    expect(any).toEqual(expect.arrayContaining([wsA, wsB]));
    // A different name never reports these domains.
    expect(await listLiveResourceDomains(getTxPool(), 'db-schema')).not.toContain(wsA);

    // B's 1s lease lapses; an expired row must not read as a holder.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await listLiveResourceDomains(getTxPool(), res)).toEqual([wsA]);

    await rel(wsA, 'A', a.lock_id);
    expect(await listLiveResourceDomains(getTxPool(), res)).toEqual([]);
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
