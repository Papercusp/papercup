/**
 * su-locks-wait — LISTEN/NOTIFY end-to-end + waiter cap + timeout.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-029.
 * Migrated from apps/operator/scripts/su-locks-wait-smoke.ts.
 *
 *   1. Agent A acquires lib/foo.ts (TTL 60s)
 *   2. Agent B inserts waiter w/ subscribe
 *   3. A releases; B wakes via NOTIFY
 *   4. Waiter cap rejects the (MAX+1)th wait
 *   5. Wait timeout marks the row expired
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap, expireWaiter, getTxPool, normalizePaths,
  tryAcquire, tryInsertWaiter, tryRelease, readWaiterStatus,
  releaseAllResourcesForOwner,
  _resetForTests, MAX_WAITERS_PER_OWNER,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import {
  subscribeWorkspace, _resetListenersForTests,
} from '../workspace-listener';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function dbLive(): Promise<boolean> {
  try {
    const sql = getTxPool();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('su-locks wait subsystem', async () => {
  const live = await dbLive();

  it.skipIf(!live)('LISTEN/NOTIFY round-trip wakes a waiter on release', async () => {
    await ensureBootstrap();
    const sql = getTxPool();
    const ws = 'wait-smoke-' + Date.now();

    const a = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
      paths: normalizePaths(['lib/foo.ts']),
      intent: 'hold the file', ttlSec: 60,
    }));
    expect(a.ok).toBe(true);

    let wakeResolve: (() => void) | null = null;
    let ticketId: string | null = null;
    const unsub = await subscribeWorkspace(ws, (tid) => {
      if (ticketId && tid === ticketId && wakeResolve) {
        const r = wakeResolve;
        wakeResolve = null;
        r();
      }
    });

    const inserted = await inWorkspaceTxn(ws, 'agent-b', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'agent-b', ownerLabel: 'B',
      paths: ['lib/foo.ts'], intent: 'want it', ttlSec: 60, maxWaitSec: 30,
    }));
    expect(inserted.ok).toBe(true);
    ticketId = (inserted as { ticket_id: string }).ticket_id;

    await sleep(2000);

    const wakeP = new Promise<void>((resolve) => {
      wakeResolve = resolve;
      setTimeout(() => { if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); } }, 30_000);
    });

    await inWorkspaceTxn(ws, 'agent-a', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-a', lockId: (a as { lock_id: string }).lock_id,
    }));
    await wakeP;

    const status = await readWaiterStatus(sql, ticketId);
    expect(status.status).toBe('granted');
    expect(status.granted_lock_id).toBeTruthy();

    await inWorkspaceTxn(ws, 'agent-b', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-b', lockId: status.granted_lock_id!,
    }));
    await unsub();
    await _resetListenersForTests();
    await _resetForTests();
  }, 60_000);

  it.skipIf(!live)('long coordination domain (>54 chars): release succeeds and the waiter push-wakes', async () => {
    // Regression for the 2026-06-09 "channel name too long" incident: PG caps
    // channel names at 63 bytes — LISTEN (identifier) silently TRUNCATES a
    // longer name while pg_notify() (text arg) RAISES. With the raw
    // `ch_coord_<domain>` naming, any domain over 54 chars (e.g. the live
    // release checkout's realpath, 56) made the grant cascade's pg_notify
    // abort the WHOLE release transaction: the lock could not be released
    // while a waiter was queued, and the waiter never woke. The fix bounds
    // the channel as ch_coord_<md5(domain)> on both the SQL and LISTEN sides
    // (sql/013-bounded-notify-channel.sql / coordNotifyChannel).
    await ensureBootstrap();
    const sql = getTxPool();
    const ws = `wait-long-domain-${Date.now()}-${'x'.repeat(64)}`;
    expect(`ch_coord_${ws}`.length).toBeGreaterThan(63); // the failing precondition

    const a = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
      paths: normalizePaths(['lib/long.ts']),
      intent: 'hold the file', ttlSec: 60,
    }));
    expect(a.ok).toBe(true);

    let wakeResolve: ((via: 'notify' | 'backstop') => void) | null = null;
    let ticketId: string | null = null;
    const unsub = await subscribeWorkspace(ws, (tid) => {
      if (ticketId && tid === ticketId && wakeResolve) {
        const r = wakeResolve;
        wakeResolve = null;
        r('notify');
      }
    });

    const inserted = await inWorkspaceTxn(ws, 'agent-b', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'agent-b', ownerLabel: 'B',
      paths: ['lib/long.ts'], intent: 'want it', ttlSec: 60, maxWaitSec: 30,
    }));
    expect(inserted.ok).toBe(true);
    ticketId = (inserted as { ticket_id: string }).ticket_id;

    const wakeP = new Promise<'notify' | 'backstop'>((resolve) => {
      wakeResolve = resolve;
      // 10s discriminator: the push wake is nominally sub-second; only the
      // (broken) no-NOTIFY world would drift to a poll backstop.
      setTimeout(() => { if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r('backstop'); } }, 10_000);
    });

    // Pre-fix this release THREW ("channel name too long") and rolled back.
    await inWorkspaceTxn(ws, 'agent-a', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-a', lockId: (a as { lock_id: string }).lock_id,
    }));

    expect(await wakeP).toBe('notify');

    const status = await readWaiterStatus(sql, ticketId);
    expect(status.status).toBe('granted');
    expect(status.granted_lock_id).toBeTruthy();

    await inWorkspaceTxn(ws, 'agent-b', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-b', lockId: status.granted_lock_id!,
    }));
    await unsub();
    await _resetListenersForTests();
    await _resetForTests();
  }, 60_000);

  it.skipIf(!live)('long domain: all_mine release (file + resource cascade) succeeds and push-wakes a waiter (EI-39)', async () => {
    // EI-39: `locks:release { all_mine: true }` raised "channel name too long"
    // and released NOTHING — wedging the per-edit PreToolUse lock to its 20-min
    // TTL while peers waited on the same file. The scoped-release regression
    // above pins grant_cascade's NOTIFY; this pins the all_mine path, which the
    // locks:release tool fans out to BOTH cascades (release.ts): tryRelease
    // {allMine} (grant_cascade) AND releaseAllResourcesForOwner
    // (resource_grant_cascade). Pre-013 either NOTIFY on a >54-char domain
    // aborted the whole transaction; both now derive ch_coord_<md5(domain)>.
    await ensureBootstrap();
    const sql = getTxPool();
    const ws = `wait-allmine-${Date.now()}-${'x'.repeat(64)}`;
    expect(`ch_coord_${ws}`.length).toBeGreaterThan(63); // the failing precondition

    const a = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
      paths: normalizePaths(['lib/allmine.ts']),
      intent: 'hold the file', ttlSec: 60,
    }));
    expect(a.ok).toBe(true);

    let wakeResolve: ((via: 'notify' | 'backstop') => void) | null = null;
    let ticketId: string | null = null;
    const unsub = await subscribeWorkspace(ws, (tid) => {
      if (ticketId && tid === ticketId && wakeResolve) {
        const r = wakeResolve;
        wakeResolve = null;
        r('notify');
      }
    });

    const inserted = await inWorkspaceTxn(ws, 'agent-b', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'agent-b', ownerLabel: 'B',
      paths: ['lib/allmine.ts'], intent: 'want it', ttlSec: 60, maxWaitSec: 30,
    }));
    expect(inserted.ok).toBe(true);
    ticketId = (inserted as { ticket_id: string }).ticket_id;

    const wakeP = new Promise<'notify' | 'backstop'>((resolve) => {
      wakeResolve = resolve;
      setTimeout(() => { if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r('backstop'); } }, 10_000);
    });

    // The full all_mine fan-out, exactly as locks:release runs it. Pre-fix the
    // FIRST of these threw "channel name too long"; the lock survived and the
    // waiter never woke. releaseAllResourcesForOwner runs resource_grant_cascade
    // unconditionally (even with zero resource locks held), so it exercises the
    // resource-cascade NOTIFY the issue's repro also crossed.
    const released = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-a', allMine: true,
    }));
    expect(released.released).toContain('lib/allmine.ts');
    await inWorkspaceTxn(ws, 'agent-a', (tx) =>
      releaseAllResourcesForOwner(tx, ws, 'agent-a'));

    expect(await wakeP).toBe('notify');

    const status = await readWaiterStatus(sql, ticketId);
    expect(status.status).toBe('granted');
    expect(status.granted_lock_id).toBeTruthy();

    await inWorkspaceTxn(ws, 'agent-b', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'agent-b', lockId: status.granted_lock_id!,
    }));
    await unsub();
    await _resetListenersForTests();
    await _resetForTests();
  }, 60_000);

  it.skipIf(!live)('waiter cap rejects the (MAX+1)th wait', async () => {
    await ensureBootstrap();
    const sql = getTxPool();
    const ws2 = 'cap-smoke-' + Date.now();
    const blocker = await inWorkspaceTxn(ws2, 'blocker', (tx) => tryAcquire(tx, {
      coordinationDomain: ws2, owner: 'blocker', ownerLabel: 'blocker',
      paths: ['cap.ts'], intent: 'block', ttlSec: 120,
    }));
    expect(blocker.ok).toBe(true);

    let lastResult: unknown = null;
    for (let i = 0; i < MAX_WAITERS_PER_OWNER + 1; i++) {
      lastResult = await inWorkspaceTxn(ws2, 'capped-owner', (tx) => tryInsertWaiter(tx, {
        coordinationDomain: ws2, owner: 'capped-owner', ownerLabel: 'capped',
        paths: ['cap.ts'], intent: `wait #${i}`, ttlSec: 60, maxWaitSec: 60,
      }));
      if (i < MAX_WAITERS_PER_OWNER) {
        expect((lastResult as { ok: boolean }).ok, `wait #${i}`).toBe(true);
      }
    }
    expect((lastResult as { ok: boolean }).ok).toBe(false);
    expect((lastResult as { reason?: string }).reason).toBe('waiter_cap_exceeded');

    await inWorkspaceTxn(ws2, 'blocker', (tx) => tryRelease(tx, {
      coordinationDomain: ws2, owner: 'blocker', lockId: (blocker as { lock_id: string }).lock_id,
    }));
    await sql`UPDATE agent_lock_waiters SET status = 'expired' WHERE coordination_domain = ${ws2} AND status = 'waiting'`;
    await sql`DELETE FROM agent_file_locks WHERE coordination_domain = ${ws2}`;
    await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${ws2}`;
  }, 30_000);

  it.skipIf(!live)('wait timeout marks the row expired', async () => {
    await ensureBootstrap();
    const sql = getTxPool();
    const ws3 = 'timeout-smoke-' + Date.now();
    const holder = await inWorkspaceTxn(ws3, 'holder', (tx) => tryAcquire(tx, {
      coordinationDomain: ws3, owner: 'holder', ownerLabel: 'H',
      paths: ['timeout.ts'], intent: 'hold', ttlSec: 60,
    }));
    expect(holder.ok).toBe(true);

    const tInsert = await inWorkspaceTxn(ws3, 'waiter', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws3, owner: 'waiter', ownerLabel: 'W',
      paths: ['timeout.ts'], intent: 'wait', ttlSec: 60, maxWaitSec: 1,
    }));
    expect(tInsert.ok).toBe(true);
    await sleep(1500);
    await inWorkspaceTxn(ws3, 'waiter', (tx) =>
      expireWaiter(tx, (tInsert as { ticket_id: string }).ticket_id),
    );
    const expired = await readWaiterStatus(sql, (tInsert as { ticket_id: string }).ticket_id);
    expect(expired.status).toBe('expired');

    await inWorkspaceTxn(ws3, 'holder', (tx) => tryRelease(tx, {
      coordinationDomain: ws3, owner: 'holder', lockId: (holder as { lock_id: string }).lock_id,
    }));
  }, 10_000);

  it('skipped diagnostic when DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
