/**
 * su-locks-contention — plan harness-test-coverage-for-launch P-015.
 *
 * `inWorkspaceTxn` serializes every mutating locks:* op per workspace via a
 * `pg_advisory_xact_lock`, under a 5s `lock_timeout` / `statement_timeout`. The
 * defensive contract: when a second op on the SAME workspace can't get the lock
 * in time (a slow/stuck holder), it must surface a STRUCTURED result — a typed
 * `WorkspaceContendedError` that `locks:acquire` turns into `{ok:false}` — never
 * a raw postgres error to the agent.
 *
 * This drives real same-workspace contention: a holder grabs the advisory lock
 * and parks the transaction idle-in-transaction (awaiting a JS gate — no SQL
 * runs, so statement_timeout doesn't fire and the lock stays held); a second
 * inWorkspaceTxn on the same domain then blocks on the advisory lock until
 * lock_timeout and rejects with the typed error. `.skipIf(!live)` when the su DB
 * is unreachable (mirrors the rest of the su-locks integration suite).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ensureBootstrap, getTxPool, _resetForTests } from '../su-lock-store';
import { inWorkspaceTxn, WorkspaceContendedError } from '../in-workspace-txn';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('su-locks inWorkspaceTxn contention (P-015)', async () => {
  const live = await dbLive();

  afterAll(async () => {
    if (live) await _resetForTests();
  });

  it.skipIf(!live)('returns the fn value with no contention', async () => {
    await ensureBootstrap();
    const domain = `p015-ok-${randomUUID()}`;
    const v = await inWorkspaceTxn(domain, 'owner-x', async (tx) => {
      const r = await tx<Array<{ n: number }>>`SELECT 42 AS n`;
      return r[0].n;
    });
    expect(v).toBe(42);
  }, 30_000);

  it.skipIf(!live)(
    'a 2nd txn on the same workspace times out → typed WorkspaceContendedError, not a raw PG throw',
    async () => {
      await ensureBootstrap();
      const domain = `p015-contend-${randomUUID()}`;

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let signalHeld!: () => void;
      const held = new Promise<void>((r) => {
        signalHeld = r;
      });

      // Holder: the advisory lock is acquired by inWorkspaceTxn BEFORE fn runs,
      // so by the time fn signals `held` the lock is ours; awaiting the gate
      // parks the txn idle-in-transaction, keeping the lock held.
      const holder = inWorkspaceTxn(domain, 'owner-holder', async () => {
        signalHeld();
        await gate;
      });
      await held;

      try {
        const err = await inWorkspaceTxn(domain, 'owner-waiter', async (tx) => tx`SELECT 1`).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(WorkspaceContendedError);
        expect((err as WorkspaceContendedError).coordinationDomain).toBe(domain);
        // The PG SQLSTATE is preserved — lock_timeout (55P03) or, if that path
        // ever maps to statement_timeout, 57014.
        expect(['55P03', '57014']).toContain((err as WorkspaceContendedError).pgCode);
      } finally {
        release();
        await holder;
      }
    },
    30_000,
  );
});
