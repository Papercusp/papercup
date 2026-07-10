/**
 * rebindLockOwner — live smoke (EI-8999/P-002, fleet-reliability-verification-
 * 2026-07-10). The "file locks" family named in the compaction-survival plan
 * item: `agent_file_locks` + `agent_lock_waiters` live in the papercusp_su
 * side-database, a connection `rebindIdentity`'s own harness_shared `sql`
 * never reaches (see rebind-identity.ts's `rebindLockOwner` option doc) — so
 * unlike the harness_shared families (covered by the isolated-testcontainer
 * rebind-identity-mid-hold.integration.test.ts), this family can only be
 * proven against the REAL locks substrate, which is process-global and
 * shared with every other live agent on this box.
 *
 * Safety: synthetic owner ids (uuid-suffixed, never used by a real session)
 * + a dedicated coordination domain, so this can never touch another agent's
 * live lock. `.skipIf(!live)`, matching every other su-locks integration test
 * (su-locks.integration.test.ts et al.) — same DB, same convention.
 */
import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryRelease,
  tryInsertWaiter,
  rebindLockOwner,
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

describe('rebindLockOwner — live smoke', async () => {
  const live = await dbLive();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ws = `rebind-owner-smoke-ws-${suffix}`;
  const FROM = `su-rebind-smoke-dead-${suffix}`;
  const TO = `su-rebind-smoke-live-${suffix}`;

  it.skipIf(!live)('re-keys a held file lock + a queued waiter from a dead sid to the live one', async () => {
    await ensureBootstrap();

    // FROM holds a file lock on path A — the compaction-mid-hold scenario.
    const held = await inWorkspaceTxn(ws, FROM, (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: FROM, ownerLabel: 'smoke:from',
        paths: normalizePaths(['libs/rebind-owner-smoke-a.ts']),
        intent: 'rebind-owner smoke', ttlSec: 60,
      }),
    );
    expect(held.ok).toBe(true);

    // A different agent holds path B; FROM ALSO queues as a waiter behind it
    // (a second, independent piece of FROM's state — a real mid-hold session
    // can hold a lock on one path and be queued on another at once).
    const holderOwner = `su-rebind-smoke-holder-${suffix}`;
    const otherHeld = await inWorkspaceTxn(ws, holderOwner, (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: holderOwner, ownerLabel: 'smoke:holder',
        paths: normalizePaths(['libs/rebind-owner-smoke-b.ts']),
        intent: 'rebind-owner smoke holder', ttlSec: 60,
      }),
    );
    expect(otherHeld.ok).toBe(true);

    const waiterResult = await inWorkspaceTxn(ws, FROM, (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: FROM, ownerLabel: 'smoke:from',
        paths: normalizePaths(['libs/rebind-owner-smoke-b.ts']),
        intent: 'rebind-owner smoke waiter', ttlSec: 60, maxWaitSec: 300,
      }),
    );
    expect('ticket_id' in waiterResult ? waiterResult.ticket_id : undefined).toBeTruthy();

    const res = await rebindLockOwner(FROM, TO);
    expect(res).toMatchObject({ ok: true, fileLocksMoved: 1, waitersMoved: 1 });

    // The live TO id now holds path A; the dead FROM id holds nothing.
    const sql = getTxPool();
    const toHolds = await sql<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks WHERE coordination_domain = ${ws} AND owner = ${TO}
    `;
    expect(toHolds).toHaveLength(1);
    const fromHolds = await sql<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks WHERE coordination_domain = ${ws} AND owner = ${FROM}
    `;
    expect(fromHolds).toHaveLength(0);
    // The queued waiter on path B now belongs to TO, not the dead FROM.
    const toWaits = await sql<Array<{ owner: string }>>`
      SELECT owner FROM agent_lock_waiters WHERE coordination_domain = ${ws} AND owner = ${TO} AND status = 'waiting'
    `;
    expect(toWaits).toHaveLength(1);
    const fromWaits = await sql<Array<{ owner: string }>>`
      SELECT owner FROM agent_lock_waiters WHERE coordination_domain = ${ws} AND owner = ${FROM}
    `;
    expect(fromWaits).toHaveLength(0);

    // Clean up — release every lock/waiter this smoke test created so it
    // never leaves live state behind for another agent to trip over.
    await inWorkspaceTxn(ws, TO, (tx) => tryRelease(tx, { coordinationDomain: ws, owner: TO, allMine: true }));
    await inWorkspaceTxn(ws, holderOwner, (tx) => tryRelease(tx, { coordinationDomain: ws, owner: holderOwner, allMine: true }));
    await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${ws}`;
  });

  it.skipIf(!live)('refuses identical ids without touching the DB (same guard as rebindIdentity itself)', async () => {
    const res = await rebindLockOwner(FROM, FROM);
    expect(res).toMatchObject({ ok: false, fileLocksMoved: 0, waitersMoved: 0 });
  });
});
