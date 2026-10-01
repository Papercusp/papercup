/**
 * account-pool-concurrency.integration.test.ts — WI-38164.
 *
 * WHAT THIS GUARDS
 * The account pool is ONE single-row-per-workspace JSONB document holding both
 * high-churn rate projections AND the account MEMBERSHIP the owner edits from the
 * Deploy Accounts page. Every writer therefore rewrites the whole document, and for a
 * long time it did so as a bare `mutator(await load())` + blind `write()` — no
 * transaction. The comment defending that called the pool "a low-churn PROJECTION"
 * whose lost writes "self-heal on the next pause". Rate fields do. Membership does not.
 *
 * The owner hit it twice in one evening (2026-08-11 / 2026-08-12): accounts `aviynw2`
 * and `aviynw4` were registered from the Deploy Accounts page and were gone hours
 * later, both times. The tell was an account REAPPEARING — `aviynw` was dropped at
 * 18:01 and back at 18:40 with no registration in between, which no mutator in
 * `account-pool.ts` can do (they are all `accounts.map(...)`; none can add an id that
 * was not in its input). Only a writer flushing a document it read hours earlier can,
 * and the same flush is what erased the two new accounts.
 *
 * HOW IT IS FALSIFIABLE
 * `lostUpdateTheOldWay()` below is the PRE-FIX code shape, kept permanently in this
 * file as a control (never by mutating production code — mutation probes on this shared
 * tree get committed by the git-sync sweep). The first test asserts the control still
 * loses an account; the rest assert the shipped `updateAccountPool` does not. If the
 * control ever stops losing, the later assertions have gone vacuous and this test says
 * so instead of quietly passing.
 *
 * Requires Docker (shared testcontainers PG via the org fixture).
 * Run: npm run test:file -- packages/operator-core/lib/deployment/account-pool-concurrency.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { AccountPool } from './account-pool';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-account-pool-concurrency', notify: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: h.notify }));

const { loadAccountPool, updateAccountPool } = await import('./account-pool-store');
const { readOperatorState, writeOperatorState, updateOperatorState } = await import('../operator-state-pg');
const { registerAccount, recordAccountPenalty } = await import('./account-pool');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const acct = (id: string) => ({ id, credentialRef: `token:/creds/${id}` });

/**
 * THE PRE-FIX SHAPE, verbatim in spirit: read the whole document, mutate the snapshot,
 * write the whole document back. `betweenReadAndWrite` stands in for everything a real
 * caller did in that window — an `await provider.allocate()` network hop, a
 * teardown+redeploy loop, or simply being descheduled behind a busy PG pool.
 */
async function lostUpdateTheOldWay(
  mutator: (p: AccountPool) => AccountPool,
  betweenReadAndWrite: () => Promise<void>,
): Promise<void> {
  const snapshot = (await readOperatorState<AccountPool>('operator_account_pool')) ?? { accounts: [] };
  await betweenReadAndWrite();
  await writeOperatorState('operator_account_pool', { accounts: mutator(snapshot).accounts });
}

const ids = async (): Promise<string[]> => (await loadAccountPool()).accounts.map((a) => a.id);

describe('account pool writes under concurrency (WI-38164)', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws}`;
    await updateAccountPool((p) => registerAccount(p, acct('incumbent'), 1));
    h.notify.mockClear();
  });

  it('an unchanged account-pool mutation does not rewrite the row or invalidate accounts.pool', async () => {
    const before = await db.adminSql`
      SELECT xmin::text AS version, updated_at FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws}
    `;
    // A real caller can do this when an already-removed account reports a penalty.
    // updateAccountPool still normalizes/rebuilds the object before this mutator runs.
    const pool = await updateAccountPool((p) => recordAccountPenalty(p, 'already-removed', 10));
    expect(pool.accounts.map((a) => a.id)).toEqual(['incumbent']);
    const after = await db.adminSql`
      SELECT xmin::text AS version, updated_at FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws}
    `;
    expect(after).toEqual(before);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('JSONB-equivalent key reordering stays quiet, but an in-place rate change persists and invalidates', async () => {
    const before = await db.adminSql`
      SELECT xmin::text AS version FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws}
    `;
    await updateAccountPool((p) => ({ accounts: p.accounts.map((a) => {
      const { id, ...rest } = a;
      return { ...rest, id };
    }) }));
    expect(await db.adminSql`
      SELECT xmin::text AS version FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws}
    `).toEqual(before);
    expect(h.notify).not.toHaveBeenCalled();

    await updateAccountPool((p) => {
      p.accounts[0]!.rate.pausedUntil = 999;
      return p;
    });
    expect((await loadAccountPool()).accounts[0]!.rate.pausedUntil).toBe(999);
    expect(h.notify.mock.calls.map(([name]) => name)).toEqual(['accounts.pool']);
  });

  it('an unchanged pool write still waits for the row lock and returns the committed membership', async () => {
    const outsider = postgres(db.adminDsn, { max: 1, prepare: false, onnotice: () => {} });
    try {
      let settled = false;
      let pending!: Promise<AccountPool>;
      await outsider.begin(async (tx) => {
        await tx`SELECT payload FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws} FOR UPDATE`;
        pending = updateAccountPool((p) => p).then((p) => { settled = true; return p; });
        await new Promise((r) => setTimeout(r, 100));
        expect(settled).toBe(false);
        await tx`
          UPDATE harness_shared.operator_account_pool
          SET payload = jsonb_set(payload, '{accounts}', payload->'accounts' || ${tx.json([
            { id: 'committed-peer', credentialRef: 'token:/creds/peer', addedAt: 20, boundTo: [], rate: {} },
          ])}::jsonb)
          WHERE workspace_id = ${h.ws}
        `;
      });
      expect((await pending).accounts.map((a) => a.id).sort()).toEqual(['committed-peer', 'incumbent']);
    } finally {
      await outsider.end({ timeout: 5 });
    }
  });

  it('the direct state-write seam also suppresses an unchanged pool refresh', async () => {
    const pool = await loadAccountPool();
    const before = await db.adminSql`
      SELECT xmin::text AS version FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws}
    `;
    await writeOperatorState('operator_account_pool', pool);
    expect(await db.adminSql`
      SELECT xmin::text AS version FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws}
    `).toEqual(before);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('an unchanged non-pool state write retains its write and timestamp semantics', async () => {
    await writeOperatorState('operator_first_run', { seen: true });
    const before = await db.adminSql`
      SELECT xmin::text AS version FROM harness_shared.operator_first_run WHERE workspace_id = ${h.ws}
    `;
    await writeOperatorState('operator_first_run', { seen: true });
    const after = await db.adminSql`
      SELECT xmin::text AS version FROM harness_shared.operator_first_run WHERE workspace_id = ${h.ws}
    `;
    expect(after[0]!.version).not.toBe(before[0]!.version);
    await updateOperatorState('operator_first_run', {}, (p) => p);
    expect((await db.adminSql`
      SELECT xmin::text AS version FROM harness_shared.operator_first_run WHERE workspace_id = ${h.ws}
    `)[0]!.version).not.toBe(after[0]!.version);
  });

  it('CONTROL — the pre-fix load/mutate/blind-write shape DOES eat a concurrent registration', async () => {
    // A slow writer reads the pool, the owner registers an account, the slow writer flushes.
    await lostUpdateTheOldWay(
      (p) => recordAccountPenalty(p, 'incumbent', 2, { pausedUntil: 3 }),
      async () => void (await updateAccountPool((p) => registerAccount(p, acct('owner-added'), 2))),
    );
    // This is the bug, reproduced: the registration is gone, and nothing errored.
    expect(await ids()).toEqual(['incumbent']);
  });

  it('the shipped updateAccountPool does NOT eat it — same interleaving, account survives', async () => {
    await updateAccountPool((p) => {
      // The mutator runs under the row lock, so "read" and "write" cannot straddle
      // another writer at all — there is no snapshot to go stale.
      return recordAccountPenalty(p, 'incumbent', 2, { pausedUntil: 3 });
    });
    await updateAccountPool((p) => registerAccount(p, acct('owner-added'), 2));
    expect((await ids()).sort()).toEqual(['incumbent', 'owner-added']);
  });

  it('N concurrent registrations ALL land (no lost update under real parallelism)', async () => {
    const many = Array.from({ length: 8 }, (_, i) => `parallel-${i}`);
    await Promise.all(many.map((id) => updateAccountPool((p) => registerAccount(p, acct(id), 5))));
    expect((await ids()).sort()).toEqual(['incumbent', ...many].sort());
  });

  it('a registration racing a rate-projection write keeps BOTH — the real gateway/owner collision', async () => {
    // The gateway writes a usage window per account per 30s; the owner registers from the
    // UI. Under the old shape whichever finished second erased the other's change.
    await Promise.all([
      updateAccountPool((p) => recordAccountPenalty(p, 'incumbent', 10, { pausedUntil: 999 })),
      updateAccountPool((p) => registerAccount(p, acct('owner-added'), 10)),
    ]);
    const pool = await loadAccountPool();
    expect(pool.accounts.map((a) => a.id).sort()).toEqual(['incumbent', 'owner-added']);
    expect(pool.accounts.find((a) => a.id === 'incumbent')!.rate.pausedUntil).toBe(999);
  });

  it('serializes behind a held row lock and mutates the value that writer COMMITTED', async () => {
    // Deterministic proof of the FOR UPDATE, not a timing coincidence: an outside
    // transaction takes the row lock and adds an account; the concurrent
    // updateAccountPool must block, then observe that account rather than a pre-lock read.
    // Its own connection, so it cannot starve the (max:2) fixture pool the RMW needs.
    const outsider = postgres(db.adminDsn, { max: 1, prepare: false, onnotice: () => {} });
    try {
      let unblocked = false;
      let pending!: Promise<AccountPool>;
      await outsider.begin(async (tx) => {
        await tx`SELECT payload FROM harness_shared.operator_account_pool WHERE workspace_id = ${h.ws} FOR UPDATE`;
        pending = updateAccountPool((p) => registerAccount(p, acct('after-lock'), 20)).then((r) => {
          unblocked = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(unblocked).toBe(false); // still waiting on the lock we hold
        await tx`
          UPDATE harness_shared.operator_account_pool
             SET payload = jsonb_set(payload, '{accounts}', payload->'accounts' || ${db.adminSql.json([
               { id: 'inside-lock', credentialRef: 'token:/creds/inside-lock', addedAt: 20, boundTo: [], rate: {} },
             ])}::jsonb)
           WHERE workspace_id = ${h.ws}
        `;
      });
      await pending;
      // Both survive: the RMW read the COMMITTED row, not the snapshot it would have
      // taken when it was first called.
      expect((await ids()).sort()).toEqual(['after-lock', 'incumbent', 'inside-lock']);
    } finally {
      await outsider.end({ timeout: 5 });
    }
  }, 30_000);
});
