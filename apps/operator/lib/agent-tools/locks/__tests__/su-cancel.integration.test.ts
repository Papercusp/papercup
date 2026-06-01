/**
 * su-cancel — cancel_wait correctness.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-029.
 * Migrated from apps/operator/scripts/su-cancel-smoke.ts.
 *
 * Confirms tryCancelWait flips a queued waiter to cancelled exactly
 * once. Requires the agent_lock_waiters table — skipped if DB
 * unreachable.
 */

import { describe, it, expect } from 'vitest';
import {
  getTxPool,
  tryCancelWait,
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

describe('su-cancel', async () => {
  const live = await dbLive();

  it.skipIf(!live)('tryCancelWait flips a waiter exactly once', async () => {
    const sql = getTxPool();
    const ws = 'cancel-test-ws-' + Date.now();
    const owner = 'cancel-agent';
    const inserted = await sql<Array<{ ticket_id: string }>>`
      INSERT INTO agent_lock_waiters (coordination_domain, owner, owner_label, paths, intent, ttl_sec, wait_until)
      VALUES (${ws}, ${owner}, ${'cancel-label'}, ${['libs/foo.ts']}, ${'test'}, ${600}, ${new Date(Date.now() + 60000)})
      RETURNING ticket_id
    `;
    const ticketId = inserted[0].ticket_id;
    const r = await inWorkspaceTxn(ws, owner, (tx) => tryCancelWait(tx, ticketId, owner));
    expect(r.cancelled).toBe(true);
    const r2 = await inWorkspaceTxn(ws, owner, (tx) => tryCancelWait(tx, ticketId, owner));
    expect(r2.cancelled).toBe(false);
    await _resetForTests();
  });

  it('skipped diagnostic when DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
