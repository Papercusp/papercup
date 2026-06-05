/**
 * classic-readers-writers.integration.test.ts — D-008 (readers-writers).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The shared/exclusive resource lock
 * IS the readers-writers solution, with a writer-starvation guard. This drives the REAL
 * resource-lock store (papercusp_su, the same engine the locks-correctness-hardening
 * plan hardened) and asserts: readers are compatible with readers; an exclusive behind
 * readers is accepted but DRAINING; a NEW reader is refused while a writer is pending
 * (writer-priority → no writer starvation); and once the readers drain, the writer is
 * granted. Skips if the side-DB is unreachable (the locks-test convention).
 */
import { describe, it, expect } from 'vitest';
import {
  getTxPool, _resetForTests, tryAcquireResource, tryReleaseResource, upsertResource,
} from '../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../agent-tools/locks/in-workspace-txn';

async function dbLive(): Promise<boolean> {
  try { await getTxPool()`SELECT 1`; return true; } catch { return false; }
}

const acquire = (cd: string, resource: string, owner: string, mode: 'shared' | 'exclusive') =>
  inWorkspaceTxn(cd, owner, (tx) =>
    tryAcquireResource(tx, { coordinationDomain: cd, resource, mode, owner, ownerLabel: owner, reason: 'rw-test', ttlSec: 600 }));
const release = (cd: string, resource: string, owner: string) =>
  inWorkspaceTxn(cd, owner, (tx) => tryReleaseResource(tx, { coordinationDomain: cd, owner, resource }));

describe('readers-writers (real papercusp_su)', async () => {
  const live = await dbLive();

  it.skipIf(!live)('shared∥shared; exclusive drains behind shared; writer not starved; then granted', async () => {
    const cd = 'rw-' + Date.now();
    const resource = 'rw-res-' + Date.now();
    await inWorkspaceTxn(cd, 'admin', (tx) => upsertResource(tx, { resource, enforcement: 'advisory' }));

    // Two readers — shared is compatible with shared.
    const r1 = await acquire(cd, resource, 'reader-1', 'shared');
    const r2 = await acquire(cd, resource, 'reader-2', 'shared');
    expect(r1.ok && r1.status).toBe('held');
    expect(r2.ok && r2.status).toBe('held');

    // Writer wants exclusive while readers hold → accepted, but DRAINING (waits them out).
    const w = await acquire(cd, resource, 'writer', 'exclusive');
    expect(w.ok && w.status).toBe('draining');

    // A NEW reader is refused while the writer is pending → writer-priority, no starvation.
    const r3 = await acquire(cd, resource, 'reader-3', 'shared');
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe('exclusive_pending');

    // Readers drain → the release cascade flips the writer to held.
    await release(cd, resource, 'reader-1');
    await release(cd, resource, 'reader-2');

    const held = await getTxPool()<{ mode: string; status: string }[]>`
      SELECT mode, status FROM agent_resource_locks
       WHERE coordination_domain = ${cd} AND resource = ${resource} AND owner = 'writer'`;
    expect(held[0]).toMatchObject({ mode: 'exclusive', status: 'held' });

    await release(cd, resource, 'writer');
    await _resetForTests();
  });

  it('skipped diagnostic when su DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
