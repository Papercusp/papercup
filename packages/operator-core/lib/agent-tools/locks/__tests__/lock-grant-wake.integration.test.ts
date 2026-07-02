/**
 * lock-grant-wake.integration.test.ts — the P1 proving ground end-to-end
 * (await-event-primitive-2026-06-05 P-008/P-009, D-004/D-005).
 *
 * The lease-backstop loop against BOTH real stores:
 *   locks side-DB (papercusp_su via getTxPool — skipIf down, like the other
 *   locks integration suites) + the awaits store on a migrated org fixture.
 *
 *   1. Holder A acquires with a 1s TTL and CRASHES (never releases).
 *   2. Waiter B queues a ticket + registers a wake await on its grant key
 *      (exactly what locks:acquire{wake_on_grant:true} does).
 *   3. The lease lapses → pokeWorkspace (the janitor path) runs the cascade →
 *      B's ticket flips to granted.
 *   4. reconcileLockGrantAwaits re-derives the fire from waiter TRUTH (no
 *      NOTIFY needed — the durable backstop) → the await fires one-shot →
 *      a wake delivery row lands with the lock_id payload.
 *   5. B never takes the lock (dead grantee) → ITS granted lease lapses too →
 *      the cascade moves on and grants live waiter C. The lease backstops
 *      dead holders AND dead grantees (D-004 net #3).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  ws: 'ws-lock-wake-test',
  sendMessage: vi.fn(async () => ({ msg_id: 'm-x' })),
  admitSpawn: vi.fn(async () => ({ admitted: true })),
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: h.sql }),
  // locks/configure.ts calls this at import time (WI-832); the narrow mock must ship it.
  setAdminPoolStatementTimeoutProvider: () => {},
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../../coordination/messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('../../../fleet/governor', () => ({ admitSpawn: h.admitSpawn }));

const {
  ensureBootstrap,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryInsertWaiter,
  readWaiterStatus,
  pokeWorkspace,
} = await import('../su-lock-store');
const { inWorkspaceTxn } = await import('../in-workspace-txn');
const { lockGrantKey, reconcileLockGrantAwaits } = await import('../lock-grant-bridge');
const awaitStore = await import('../../../events/await/store');
const { createOrgTestDb } = await import('../../../../test/_org-test-db');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function locksDbLive(): Promise<boolean> {
  try {
    const sql = getTxPool();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('lock grant → wake, lease-backstopped (real PG ×2)', async () => {
  const live = await locksDbLive();
  let db: OrgTestDb | null = null;

  beforeAll(async () => {
    if (!live) return;
    await ensureBootstrap();
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.skipIf(!live)(
    'crashed holder → lease expiry → cascade grants the sleeping waiter → wake delivery queued; dead grantee re-cascades to the next live waiter',
    async () => {
      const domain = 'wake-e2e-' + Date.now();
      const paths = normalizePaths(['lib/wake-e2e.ts']);

      // 1. Holder A: 1s TTL, then "crashes" (never releases).
      const a = await inWorkspaceTxn(domain, 'agent-a', (tx) =>
        tryAcquire(tx, {
          coordinationDomain: domain,
          owner: 'agent-a',
          ownerLabel: 'A',
          paths,
          intent: 'hold then crash',
          ttlSec: 1,
        }),
      );
      expect(a.ok).toBe(true);

      // 2. Waiter B queues + registers the wake await (the wake_on_grant shape).
      //    B's grant will carry a 1s TTL too — B is our dead grantee for step 5.
      const insertedB = await inWorkspaceTxn(domain, 'agent-b', (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: domain,
          owner: 'agent-b',
          ownerLabel: 'B',
          paths: ['lib/wake-e2e.ts'],
          intent: 'sleeping waiter',
          ttlSec: 1,
          maxWaitSec: 120,
        }),
      );
      expect(insertedB.ok).toBe(true);
      const ticketB = (insertedB as { ticket_id: string }).ticket_id;
      await awaitStore.registerAwait({
        subscriberId: 'su-waiter-b',
        eventKey: lockGrantKey(ticketB),
        note: 'lock wait: lib/wake-e2e.ts',
      });

      // Waiter C (live, also asleep) behind B.
      const insertedC = await inWorkspaceTxn(domain, 'agent-c', (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: domain,
          owner: 'agent-c',
          ownerLabel: 'C',
          paths: ['lib/wake-e2e.ts'],
          intent: 'second sleeping waiter',
          ttlSec: 60,
          maxWaitSec: 120,
        }),
      );
      expect(insertedC.ok).toBe(true);
      const ticketC = (insertedC as { ticket_id: string }).ticket_id;
      await awaitStore.registerAwait({
        subscriberId: 'su-waiter-c',
        eventKey: lockGrantKey(ticketC),
      });

      // 3. A's lease lapses; the poke (janitor path) sweeps + cascades.
      await sleep(1_200);
      await inWorkspaceTxn(domain, 'agent-b', (tx) => pokeWorkspace(tx, domain));
      const statusB = await readWaiterStatus(getTxPool(), ticketB);
      expect(statusB.status).toBe('granted');
      expect(statusB.granted_lock_id).toBeTruthy();

      // 4. The durable backstop fires the wake from waiter truth (no NOTIFY).
      await reconcileLockGrantAwaits(h.ws);
      await sleep(150); // let the emit's pump kick settle

      const wakesB = await awaitStore.listRecentDeliveries('su-waiter-b');
      expect(wakesB.length).toBeGreaterThanOrEqual(1);
      expect(wakesB[0].eventKey).toBe(lockGrantKey(ticketB));
      expect(wakesB[0].payload).toMatchObject({
        granted: true,
        lock_id: statusB.granted_lock_id,
      });
      // One-shot: a second reconcile emits nothing new for B.
      await reconcileLockGrantAwaits(h.ws);
      expect((await awaitStore.listRecentDeliveries('su-waiter-b')).length).toBe(wakesB.length);

      // 5. B never takes its lock — B's granted 1s lease lapses → the cascade
      //    moves on to C (the lease backstops dead grantees too).
      await sleep(1_200);
      await inWorkspaceTxn(domain, 'agent-c', (tx) => pokeWorkspace(tx, domain));
      const statusC = await readWaiterStatus(getTxPool(), ticketC);
      expect(statusC.status).toBe('granted');

      await reconcileLockGrantAwaits(h.ws);
      const wakesC = await awaitStore.listRecentDeliveries('su-waiter-c');
      expect(wakesC.length).toBeGreaterThanOrEqual(1);
      expect(wakesC[0].payload).toMatchObject({ granted: true });
    },
    60_000,
  );
});
