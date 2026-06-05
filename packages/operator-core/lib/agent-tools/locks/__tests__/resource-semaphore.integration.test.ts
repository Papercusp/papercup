/**
 * resource-semaphore — counting-semaphore capacity on named resources (D-008,
 * locks-correctness-hardening-2026-06-04).
 *
 * Fills the gap between binary exclusive (N=1) and unbounded shared (N=∞): a
 * resource with max_holders=N admits at most N concurrent shared holders.
 * Live papercusp_su; a UNIQUE resource name per run keeps the global registry
 * isolated, a unique coordination domain isolates the lock state.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
  upsertResource,
  getResource,
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
const uniqueWs = () => `sem-test-ws-${Date.now()}-${wsSeq++}`;

const acq = (ws: string, owner: string, resource: string, mode: ResourceMode) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireResource(tx, {
      coordinationDomain: ws,
      resource,
      mode,
      owner,
      ownerLabel: `sem:${owner}`,
      reason: 'semaphore test',
      ttlSec: 60,
    }),
  );

const rel = (ws: string, owner: string, lockId: string) =>
  inWorkspaceTxn(ws, owner, (tx) => tryReleaseResource(tx, { coordinationDomain: ws, owner, lockId }));

describe('resource counting semaphore (D-008)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('admits up to max_holders shared holders, then refuses with at_capacity', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const res = `sem-${Date.now()}-cap2`;
    // Register the resource with capacity 2.
    const reg = await inWorkspaceTxn(ws, 'admin', (tx) =>
      upsertResource(tx, { resource: res, description: 'test', max_holders: 2 }),
    );
    expect(reg.max_holders).toBe(2);

    const a = await acq(ws, 'A', res, 'shared');
    const b = await acq(ws, 'B', res, 'shared');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Third distinct holder is refused — the semaphore is full.
    const c = await acq(ws, 'C', res, 'shared');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('at_capacity');

    // An existing holder refreshing does NOT consume a fresh slot.
    const aRefresh = await acq(ws, 'A', res, 'shared');
    expect(aRefresh.ok).toBe(true);

    // Free a slot → C now fits.
    await rel(ws, 'A', a.lock_id);
    const c2 = await acq(ws, 'C', res, 'shared');
    expect(c2.ok).toBe(true);
  });

  it.skipIf(!live)('a resource with no max_holders is unbounded (default shared behavior)', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const res = `sem-${Date.now()}-unbounded`;
    await inWorkspaceTxn(ws, 'admin', (tx) => upsertResource(tx, { resource: res, description: 'test' }));
    expect((await getResource(getTxPool(), res))?.max_holders).toBeNull();

    // Many shared holders all admitted.
    for (const owner of ['A', 'B', 'C', 'D', 'E']) {
      expect((await acq(ws, owner, res, 'shared')).ok).toBe(true);
    }
    await _resetForTests();
  });
});
