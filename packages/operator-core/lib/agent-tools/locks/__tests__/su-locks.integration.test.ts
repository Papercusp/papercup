/**
 * su-locks — acquire / read / heartbeat / release / validation smoke.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-029.
 * Migrated from apps/operator/scripts/su-locks-smoke.ts.
 *
 * Single end-to-end probe: bootstrap → acquire 3 paths → read queue
 * → conflicting acquire → heartbeat → release → empty queue → path
 * validation. .skipIf(!live) when DB unreachable.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap, getTxPool, normalizePaths,
  tryAcquire, tryRelease, tryHeartbeat,
  readQueue, _resetForTests,
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

describe('su-locks smoke', async () => {
  const live = await dbLive();

  it.skipIf(!live)('end-to-end: bootstrap → acquire → conflict → heartbeat → release', async () => {
    await ensureBootstrap();

    const ws = 'smoke-test-ws-' + Date.now();
    const owner = 'smoke-agent-a';

    const r1 = await inWorkspaceTxn(ws, owner, (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner, ownerLabel: 'smoke:a',
      paths: normalizePaths(['libs/foo.ts', 'libs/bar.ts', 'apps/baz.ts']),
      intent: 'smoke test acquire', ttlSec: 60,
    }));
    expect(r1.ok).toBe(true);

    const sql = getTxPool();
    const q1 = await readQueue(sql, { coordinationDomain: ws });
    expect(q1.active_locks.length).toBe(3);

    // Conflicting acquire by different owner should be busy.
    const r2 = await inWorkspaceTxn(ws, 'smoke-agent-b', (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner: 'smoke-agent-b', ownerLabel: 'smoke:b',
      paths: normalizePaths(['libs/foo.ts', 'libs/qux.ts']),
      intent: 'smoke test conflict', ttlSec: 60,
    }));
    expect(r2.ok).toBe(false);

    const h = await inWorkspaceTxn(ws, owner, (tx) =>
      tryHeartbeat(tx, ws, owner, (r1 as { lock_id: string }).lock_id, 120),
    );
    expect(h.extended).toBe(true);

    const rel = await inWorkspaceTxn(ws, owner, (tx) => tryRelease(tx, {
      coordinationDomain: ws, owner, lockId: (r1 as { lock_id: string }).lock_id,
    }));
    expect(rel.released.length).toBe(3);

    const q2 = await readQueue(sql, { coordinationDomain: ws });
    expect(q2.active_locks.length).toBe(0);

    await _resetForTests();
  });

  it('path validation rejects absolute and parent paths', () => {
    expect(() => normalizePaths(['/abs/path'])).toThrow();
    expect(() => normalizePaths(['../etc/passwd'])).toThrow();
  });
});
