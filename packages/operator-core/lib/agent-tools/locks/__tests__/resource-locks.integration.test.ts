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
    const c = await acq(ws, 'C', 'dev-server', 'exclusive');
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

  it.skipIf(!live)('records refused acquirers as waiters; the exclusive release returns + clears them (A4)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    // X holds exclusive; C (shared) + D (exclusive) are refused → recorded waiters.
    const x = await acq(ws, 'X', 'dev-server', 'exclusive');
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect((await acq(ws, 'C', 'dev-server', 'shared')).ok).toBe(false); // exclusive_pending
    expect((await acq(ws, 'D', 'dev-server', 'exclusive')).ok).toBe(false); // held_exclusive

    // Releasing X's exclusive returns the waiters (the targeted back-up audience).
    const r = await rel(ws, 'X', x.lock_id);
    expect(r.exclusiveResources).toContain('dev-server');
    expect([...(r.waiters['dev-server'] ?? [])].sort()).toEqual(['C', 'D']);

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
    const ws = `/home/marsh-office/papercupai-workspace/papercusp-release/res-${Date.now()}-${wsSeq++}`;
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
