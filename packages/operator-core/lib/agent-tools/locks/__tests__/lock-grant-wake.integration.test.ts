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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  ws: 'ws-lock-wake-test',
  sendMessage: vi.fn(async () => ({ msg_id: 'm-x' })),
  admitSpawn: vi.fn(async () => ({ admitted: true })),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    // locks/configure.ts calls this at import time (WI-832); override it without
    // hiding generated schema exports imported by autoloop and future consumers.
    setAdminPoolStatementTimeoutProvider: () => {},
  };
});
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../../coordination/messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('../../../fleet/governor', () => ({ admitSpawn: h.admitSpawn }));

const {
  ensureBootstrap,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryInsertWaiter,
  tryRelease,
  readWaiterStatus,
  readPendingEditDisposition,
  readQueue,
  pokeWorkspace,
} = await import('../su-lock-store');
const { inWorkspaceTxn } = await import('../in-workspace-txn');
const { lockGrantKey, reconcileLockGrantAwaits, reconcileLockTicket } = await import('../lock-grant-bridge');
const { applyPendingEditOnGrant } = await import('../apply-on-grant');
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

  it.skipIf(!live)(
    'a grant released before bridge reconciliation produces a non-granted wake',
    async () => {
      const domain = 'wake-stale-' + Date.now();
      const paths = normalizePaths(['lib/wake-stale.ts']);
      const subscriberId = 'su-stale-wake-' + Date.now();

      const holder = await inWorkspaceTxn(domain, 'agent-a', (tx) =>
        tryAcquire(tx, {
          coordinationDomain: domain,
          owner: 'agent-a',
          ownerLabel: 'A',
          paths,
          intent: 'hold until waiter queues',
          ttlSec: 60,
        }),
      );
      expect(holder.ok).toBe(true);
      if (!holder.ok) return;

      const inserted = await inWorkspaceTxn(domain, 'agent-b', (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: domain,
          owner: 'agent-b',
          ownerLabel: 'B',
          paths,
          intent: 'wait for a grant that is then released',
          ttlSec: 60,
          maxWaitSec: 120,
        }),
      );
      expect(inserted.ok).toBe(true);
      if (!inserted.ok || !('ticket_id' in inserted)) return;
      const ticket = inserted.ticket_id;
      await awaitStore.registerAwait({
        subscriberId,
        eventKey: lockGrantKey(ticket),
        note: 'released grant regression',
      });

      await inWorkspaceTxn(domain, 'agent-a', (tx) =>
        tryRelease(tx, { coordinationDomain: domain, owner: 'agent-a', lockId: holder.lock_id }),
      );
      const grant = await readWaiterStatus(getTxPool(), ticket);
      expect(grant.status).toBe('granted');
      expect(grant.granted_lock_id).toBeTruthy();
      if (!grant.granted_lock_id) return;

      await inWorkspaceTxn(domain, 'agent-b', (tx) =>
        tryRelease(tx, { coordinationDomain: domain, owner: 'agent-b', lockId: grant.granted_lock_id }),
      );

      const released = await readWaiterStatus(getTxPool(), ticket);
      expect(released.status).toBe('released');
      expect(await reconcileLockTicket(ticket, h.ws, { applyOnGrant: async () => 'none' })).toBe('fired-terminal');
      await sleep(150);

      const wakes = await awaitStore.listRecentDeliveries(subscriberId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].eventKey).toBe(lockGrantKey(ticket));
      expect(wakes[0].payload).toMatchObject({
        granted: false,
        ticket_status: 'released',
        ticket_id: ticket,
      });
      expect(wakes[0].payload).not.toHaveProperty('lock_id');
    },
    30_000,
  );

  it.skipIf(!live)(
    'apply-on-grant stores an edit as a JSON object and applies it after the real grant cascade',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'papercusp-lock-apply-'));
      const file = 'apply-probe.txt';
      const abs = join(root, file);
      const paths = [file];
      writeFileSync(abs, 'before OLD after\n', 'utf8');

      try {
        // Use the temporary repository as the coordination domain because the
        // production apply path resolves its granted domain as the repo root.
        const holder = await inWorkspaceTxn(root, 'apply-holder', (tx) =>
          tryAcquire(tx, {
            coordinationDomain: root,
            owner: 'apply-holder',
            ownerLabel: 'holder',
            paths,
            intent: 'hold the live apply probe path',
            ttlSec: 1,
          }),
        );
        expect(holder.ok).toBe(true);

        const inserted = await inWorkspaceTxn(root, 'apply-waiter', (tx) =>
          tryInsertWaiter(tx, {
            coordinationDomain: root,
            owner: 'apply-waiter',
            ownerLabel: 'waiter',
            paths,
            intent: 'apply the live probe edit on grant',
            ttlSec: 30,
            maxWaitSec: 120,
            pendingEdit: { file, old_string: 'OLD', new_string: 'NEW' },
          }),
        );
        expect(inserted.ok).toBe(true);
        if (!inserted.ok || !('ticket_id' in inserted)) return;

        await sleep(1_200);
        await inWorkspaceTxn(root, 'apply-waiter', (tx) => pokeWorkspace(tx, root));
        const ticket = inserted.ticket_id;
        const granted = await readWaiterStatus(getTxPool(), ticket);
        expect(granted.status).toBe('granted');

        const locksSql = getTxPool();
        const stored = await locksSql<Array<{ kind: string }>>`
          SELECT jsonb_typeof(pending_edit) AS kind
            FROM agent_lock_waiters
           WHERE ticket_id = ${ticket}::uuid
        `;
        expect(stored[0]?.kind).toBe('object');

        const outcome = await reconcileLockTicket(ticket, h.ws, {
          applyOnGrant: (ticketId, workspaceId) =>
            applyPendingEditOnGrant(ticketId, workspaceId, {
              // The test verifies the real claim, filesystem apply, outcome,
              // and lock release; keep unrelated audit/inbox stores hermetic.
              recordAttribution: async () => {},
              cancelWakeAwaits: async () => {},
              notify: async () => {},
            }),
        });
        expect(outcome).toBe('applied');
        expect(readFileSync(abs, 'utf8')).toBe('before NEW after\n');
        expect(await readPendingEditDisposition(getTxPool(), ticket)).toBe('applied');
        const queue = await readQueue(getTxPool(), { coordinationDomain: root, includeCompleted: true });
        expect(queue.active_locks).toHaveLength(0);
        expect(queue.completed?.some((row) => row.ticket_id === ticket)).toBe(true);
      } finally {
        const sql = getTxPool();
        await sql`DELETE FROM agent_file_locks WHERE coordination_domain = ${root}`.catch(() => {});
        await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${root}`.catch(() => {});
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
