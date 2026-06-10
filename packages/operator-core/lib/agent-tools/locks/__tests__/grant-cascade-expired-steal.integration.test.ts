/**
 * grant_cascade expired-row steal — regression for full-app-audit-2026-06-09
 * P-009 (EI-129/EI-130 root cause), fixed by sql/014-grant-cascade-expired-steal.sql.
 *
 * Pre-014 the cascade's path-row INSERT was `ON CONFLICT DO NOTHING`: a row
 * left behind by an EXPIRED lock is invisible to the live held-paths probe
 * (it filters `expires_ts > now`) but still occupies the
 * (coordination_domain, path) unique key — so the insert silently skipped it
 * while the waiter was flipped to 'granted' anyway. The waiter "held" a path
 * whose row still carried the old owner + old lock_id: the path was never
 * protected and release(granted_lock_id) couldn't free it.
 *
 * Cases:
 *   1. Expired-unswept row: the waiter is granted AND actually owns the row.
 *   2. Live foreign row: the waiter stays 'waiting'; the holder's row is
 *      untouched (the owner-aware probe must not over-grant).
 *   3. Same-owner requeue ([p, q] queued behind own live p + foreign q):
 *      granted as ONE lock_id covering both rows once q frees (pre-014 the
 *      overlap probe starved this waiter until its own p expired).
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  ensureBootstrap, getTxPool, normalizePaths,
  tryAcquire, tryInsertWaiter, tryRelease, readWaiterStatus,
  _resetForTests,
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

describe('grant_cascade expired-row steal (audit P-009 / EI-129 / EI-130)', async () => {
  const live = await dbLive();

  afterAll(async () => {
    if (!live) return;
    const sql = getTxPool();
    await sql`DELETE FROM agent_file_locks WHERE coordination_domain LIKE 'gc-steal-%'`;
    await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain LIKE 'gc-steal-%'`;
    await _resetForTests();
  });

  it.skipIf(!live)('grants a waiter THROUGH an expired-unswept row — and the row is really stolen', async () => {
    await ensureBootstrap();
    const sql = getTxPool();
    const ws = 'gc-steal-expired-' + Date.now();
    const path = 'lib/steal.ts';

    // A holds the path live; B queues behind it.
    const a = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
      paths: normalizePaths([path]), intent: 'hold', ttlSec: 60,
    }));
    expect(a.ok).toBe(true);

    const w = await inWorkspaceTxn(ws, 'agent-b', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'agent-b', ownerLabel: 'B',
      paths: [path], intent: 'want it', ttlSec: 60, maxWaitSec: 30,
    }));
    expect(w.ok).toBe(true);
    expect('ticket_id' in w).toBe(true); // queued, not self-granted
    const ticketId = (w as { ticket_id: string }).ticket_id;

    // A's lock expires WITHOUT release and WITHOUT the janitor sweeping the
    // row — the exact state the held-paths probe can't see but the unique
    // key still conflicts on.
    await sql`
      UPDATE agent_file_locks
         SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE coordination_domain = ${ws} AND owner = 'agent-a'
    `;

    // A background-style cascade tick (release/janitor both end up here).
    await sql`SELECT grant_cascade(${ws}, clock_timestamp())`;

    const status = await readWaiterStatus(sql, ticketId);
    expect(status.status).toBe('granted');
    expect(status.granted_lock_id).toBeTruthy();

    // The decisive post-fix assertion: the path row must REALLY be B's.
    // Pre-014 the waiter read 'granted' while this row still said agent-a.
    const rows = await sql<Array<{ owner: string; lock_id: string; live: boolean }>>`
      SELECT owner, lock_id::text AS lock_id,
             (expires_ts > clock_timestamp()) AS live
        FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND path = ${path}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('agent-b');
    expect(rows[0].lock_id).toBe(status.granted_lock_id);
    expect(rows[0].live).toBe(true);

    await inWorkspaceTxn(ws, 'agent-b', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-b', lockId: status.granted_lock_id!,
    }));
  }, 30_000);

  it.skipIf(!live)('never grants past a LIVE foreign row — waiter stays waiting, holder untouched', async () => {
    await ensureBootstrap();
    const sql = getTxPool();
    const ws = 'gc-steal-live-' + Date.now();
    const path = 'lib/live.ts';

    const a = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
      paths: normalizePaths([path]), intent: 'hold', ttlSec: 60,
    }));
    expect(a.ok).toBe(true);
    const aLockId = (a as { lock_id: string }).lock_id;

    const w = await inWorkspaceTxn(ws, 'agent-b', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'agent-b', ownerLabel: 'B',
      paths: [path], intent: 'want it', ttlSec: 60, maxWaitSec: 30,
    }));
    expect(w.ok).toBe(true);
    const ticketId = (w as { ticket_id: string }).ticket_id;

    await sql`SELECT grant_cascade(${ws}, clock_timestamp())`;

    const status = await readWaiterStatus(sql, ticketId);
    expect(status.status).toBe('waiting');

    const rows = await sql<Array<{ owner: string; lock_id: string }>>`
      SELECT owner, lock_id::text AS lock_id
        FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND path = ${path}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('agent-a');
    expect(rows[0].lock_id).toBe(aLockId);

    await inWorkspaceTxn(ws, 'agent-a', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-a', lockId: aLockId,
    }));
  }, 30_000);

  it.skipIf(!live)('same-owner requeue: [p, q] behind own live p + foreign q grants as ONE lock once q frees', async () => {
    await ensureBootstrap();
    const sql = getTxPool();
    const ws = 'gc-steal-requeue-' + Date.now();
    const p = 'lib/p.ts';
    const q = 'lib/q.ts';

    const aP = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
      paths: normalizePaths([p]), intent: 'hold p', ttlSec: 60,
    }));
    expect(aP.ok).toBe(true);

    const bQ = await inWorkspaceTxn(ws, 'agent-b', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'agent-b', ownerLabel: 'B',
      paths: normalizePaths([q]), intent: 'hold q', ttlSec: 60,
    }));
    expect(bQ.ok).toBe(true);

    // A wants the pair; q is foreign-held, so this queues.
    const w = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
      paths: [p, q], intent: 'want the pair', ttlSec: 60, maxWaitSec: 30,
    }));
    expect(w.ok).toBe(true);
    expect('ticket_id' in w).toBe(true);
    const ticketId = (w as { ticket_id: string }).ticket_id;

    // B releases q → release runs the cascade. Pre-014 the in-memory
    // overlap probe saw A's own live p row and starved the waiter.
    await inWorkspaceTxn(ws, 'agent-b', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-b', lockId: (bQ as { lock_id: string }).lock_id,
    }));

    const status = await readWaiterStatus(sql, ticketId);
    expect(status.status).toBe('granted');
    expect(status.granted_lock_id).toBeTruthy();

    const rows = await sql<Array<{ path: string; owner: string; lock_id: string }>>`
      SELECT path, owner, lock_id::text AS lock_id
        FROM agent_file_locks
       WHERE coordination_domain = ${ws}
       ORDER BY path
    `;
    expect(rows.map((r) => r.path)).toEqual([p, q]);
    for (const r of rows) {
      expect(r.owner).toBe('agent-a');
      expect(r.lock_id).toBe(status.granted_lock_id);
    }

    // ONE release frees the whole pair — the grant is a single unit.
    await inWorkspaceTxn(ws, 'agent-a', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-a', lockId: status.granted_lock_id!,
    }));
    const after = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM agent_file_locks WHERE coordination_domain = ${ws}
    `;
    expect(Number(after[0].n)).toBe(0);
  }, 30_000);

  it('skipped diagnostic when DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
