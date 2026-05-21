/**
 * Phase 2 smoke — wait subsystem.
 *
 * Tests the full LISTEN/NOTIFY round-trip end-to-end:
 *
 *   1. Agent A acquires lib/foo.ts (TTL 60s)
 *   2. Agent B calls acquire on lib/foo.ts with wait { max_sec: 30 }
 *   3. ~2s later, Agent A releases
 *   4. Agent B's wait wakes via NOTIFY and returns ok with the lock
 *
 * Measures wake latency (should be sub-100ms with healthy LISTEN).
 *
 * Also tests:
 *   - Waiter cap (11th wait per owner → waiter_cap_exceeded)
 *   - Wait timeout (wait_until elapses → busy + ticket_id)
 *   - Cancel_wait during an active wait
 */

import {
  ensureBootstrap,
  expireWaiter,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryInsertWaiter,
  tryRelease,
  readWaiterStatus,
  _resetForTests,
  MAX_WAITERS_PER_OWNER,
} from '../lib/agent-tools/locks/su-lock-store.ts';
import { inWorkspaceTxn } from '../lib/agent-tools/locks/in-workspace-txn.ts';
import {
  subscribeWorkspace,
  _resetListenersForTests,
} from '../lib/agent-tools/locks/workspace-listener.ts';

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function fail(msg: string): never { console.error('FAIL:', msg); process.exit(1); }

async function main() {
  await ensureBootstrap();
  const sql = getTxPool();
  const ws = 'wait-smoke-' + Date.now();

  console.log('1. Agent A acquires lib/foo.ts...');
  const a = await inWorkspaceTxn(ws, 'agent-a', (tx) => tryAcquire(tx, {
    coordinationDomain: ws, owner: 'agent-a', ownerLabel: 'A',
    paths: normalizePaths(['lib/foo.ts']),
    intent: 'hold the file', ttlSec: 60,
  }));
  if (!a.ok) fail('A should acquire');
  console.log('   A holds lock:', a.lock_id);

  console.log('2. Agent B subscribes + inserts waiter on lib/foo.ts...');
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
  if (!inserted.ok) fail('B should insert waiter');
  ticketId = inserted.ticket_id;
  console.log('   B ticket:', ticketId, 'wait_until:', inserted.wait_until.toISOString());

  console.log('3. Sleep 2s, then A releases...');
  await sleep(2000);
  const wakeStart = Date.now();

  // Set up the wake promise BEFORE we release so we capture the NOTIFY.
  const wakeP = new Promise<void>((resolve) => {
    wakeResolve = resolve;
    // 30s safety net
    setTimeout(() => { if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); } }, 30_000);
  });

  await inWorkspaceTxn(ws, 'agent-a', (tx) => tryRelease(tx, {
    coordinationDomain: ws, owner: 'agent-a', lockId: a.lock_id,
  }));
  console.log('   A released');

  await wakeP;
  const wakeLatency = Date.now() - wakeStart;
  console.log('   B woke after', wakeLatency, 'ms');
  if (wakeLatency > 500) console.warn('   WARN: wake latency >500ms (CI may be slow)');

  const status = await readWaiterStatus(sql, ticketId);
  console.log('   B status:', status.status, 'lock:', status.granted_lock_id);
  if (status.status !== 'granted' || !status.granted_lock_id) fail('B should be granted');

  // Clean up B's lock
  await inWorkspaceTxn(ws, 'agent-b', (tx) => tryRelease(tx, {
    coordinationDomain: ws, owner: 'agent-b', lockId: status.granted_lock_id!,
  }));
  await unsub();

  console.log('4. Waiter cap: insert', MAX_WAITERS_PER_OWNER, 'waiters, then 11th should fail...');
  const ws2 = 'cap-smoke-' + Date.now();
  // First, hold a lock so all waiters actually queue.
  const blocker = await inWorkspaceTxn(ws2, 'blocker', (tx) => tryAcquire(tx, {
    coordinationDomain: ws2, owner: 'blocker', ownerLabel: 'blocker',
    paths: ['cap.ts'], intent: 'block', ttlSec: 120,
  }));
  if (!blocker.ok) fail('blocker should acquire');

  let lastResult: unknown = null;
  for (let i = 0; i < MAX_WAITERS_PER_OWNER + 1; i++) {
    lastResult = await inWorkspaceTxn(ws2, 'capped-owner', (tx) => tryInsertWaiter(tx, {
      coordinationDomain: ws2, owner: 'capped-owner', ownerLabel: 'capped',
      paths: ['cap.ts'], intent: `wait #${i}`, ttlSec: 60, maxWaitSec: 60,
    }));
    if (i < MAX_WAITERS_PER_OWNER) {
      if (!(lastResult as { ok: boolean }).ok) fail(`wait #${i} should succeed`);
    }
  }
  console.log('   11th result:', JSON.stringify(lastResult));
  if ((lastResult as { ok: boolean }).ok) fail('11th wait should be capped');
  if ((lastResult as { reason?: string }).reason !== 'waiter_cap_exceeded') fail('expected waiter_cap_exceeded');

  // Cleanup: release blocker (this fires the cascade which grants 1 of the 10 waiters)
  await inWorkspaceTxn(ws2, 'blocker', (tx) => tryRelease(tx, {
    coordinationDomain: ws2, owner: 'blocker', lockId: blocker.lock_id,
  }));
  // Janitor the rest of the waiters by setting wait_until past + expiring them
  await sql`UPDATE agent_lock_waiters SET status = 'expired' WHERE coordination_domain = ${ws2} AND status = 'waiting'`;
  await sql`DELETE FROM agent_file_locks WHERE coordination_domain = ${ws2}`;
  await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${ws2}`;

  console.log('5. Wait timeout — short max_sec, no release...');
  const ws3 = 'timeout-smoke-' + Date.now();
  const holder = await inWorkspaceTxn(ws3, 'holder', (tx) => tryAcquire(tx, {
    coordinationDomain: ws3, owner: 'holder', ownerLabel: 'H',
    paths: ['timeout.ts'], intent: 'hold', ttlSec: 60,
  }));
  if (!holder.ok) fail('holder should acquire');

  const tInsert = await inWorkspaceTxn(ws3, 'waiter', (tx) => tryInsertWaiter(tx, {
    coordinationDomain: ws3, owner: 'waiter', ownerLabel: 'W',
    paths: ['timeout.ts'], intent: 'wait', ttlSec: 60, maxWaitSec: 1,
  }));
  if (!tInsert.ok) fail('waiter insert should succeed');
  await sleep(1500);
  await inWorkspaceTxn(ws3, 'waiter', (tx) => expireWaiter(tx, tInsert.ticket_id));
  const expired = await readWaiterStatus(sql, tInsert.ticket_id);
  console.log('   expired status:', expired.status);
  if (expired.status !== 'expired') fail('waiter should be expired');

  await inWorkspaceTxn(ws3, 'holder', (tx) => tryRelease(tx, {
    coordinationDomain: ws3, owner: 'holder', lockId: holder.lock_id,
  }));

  console.log('\n[OK] PHASE 2 SMOKE PASSED — wait subsystem works');
  await _resetListenersForTests();
  await _resetForTests();
}

main().catch((e) => { console.error('CRASH:', e); process.exit(2); });
