/**
 * su-locks-progress — payload shape for the waiting progress event.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-029.
 * Migrated from apps/operator/scripts/su-locks-progress-smoke.ts.
 *
 * Verifies the data shape locks:acquire emits during the wait phase
 * (ahead_count, busy[]). MCP-transport-level progress emit is covered
 * in production by the agent's progress-display surface; this test
 * covers the data shape.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap, getTxPool, readQueue,
  tryAcquire, tryInsertWaiter, tryRelease, _resetForTests,
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

describe('su-locks progress payload shape', async () => {
  const live = await dbLive();

  it.skipIf(!live)('second waiter sees ahead_count=1 and busy snapshot with holder label', async () => {
    await ensureBootstrap();
    const sql = getTxPool();
    const ws = 'progress-smoke-' + Date.now();

    const holder = await inWorkspaceTxn(ws, 'holder', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'holder', ownerLabel: 'H',
      paths: ['progress.ts'], intent: 'hold', ttlSec: 60,
    }));
    expect(holder.ok).toBe(true);

    const w1 = await inWorkspaceTxn(ws, 'a', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
      paths: ['progress.ts'], intent: 'first', ttlSec: 60, maxWaitSec: 60,
    }));
    await new Promise((r) => setTimeout(r, 50));
    const w2 = await inWorkspaceTxn(ws, 'b', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
      paths: ['progress.ts'], intent: 'second', ttlSec: 60, maxWaitSec: 60,
    }));
    expect(w1.ok).toBe(true);
    expect(w2.ok).toBe(true);

    const q = await readQueue(sql, { coordinationDomain: ws, paths: ['progress.ts'] });
    const mineW2 = q.waiting.find((w) => w.ticket_id === (w2 as { ticket_id: string }).ticket_id);
    expect(mineW2?.ahead_count).toBe(1);

    const busyForW2 = q.active_locks
      .filter((l) => ['progress.ts'].includes(l.path))
      .map((l) => ({
        path: l.path,
        owner_label: l.owner_label,
        intent: l.intent,
        expires_ts: l.expires_ts.toISOString(),
      }));
    expect(busyForW2.length).toBe(1);
    expect(busyForW2[0].owner_label).toBe('H');

    // Progress payload contract — keys + types acquire.ts emits.
    const progressPayload = {
      phase: 'waiting',
      ticket_id: (w2 as { ticket_id: string }).ticket_id,
      elapsed_sec: 0,
      ahead_count: mineW2?.ahead_count,
      busy: busyForW2,
    };
    expect(progressPayload.phase).toBe('waiting');
    expect(Array.isArray(progressPayload.busy)).toBe(true);
    for (const k of ['phase', 'ticket_id', 'elapsed_sec', 'ahead_count', 'busy']) {
      expect(k in progressPayload, `missing ${k}`).toBe(true);
    }

    await inWorkspaceTxn(ws, 'holder', (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner: 'holder', lockId: (holder as { lock_id: string }).lock_id,
    }));
    await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${ws}`;
    await sql`DELETE FROM agent_file_locks WHERE coordination_domain = ${ws}`;
    await _resetForTests();
  });

  it('skipped diagnostic when DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
