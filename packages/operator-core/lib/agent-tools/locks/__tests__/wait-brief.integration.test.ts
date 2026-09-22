/**
 * wait-brief.integration.test.ts — plan use-existing-router-for-review-requests-2026-09-08
 * P-010, spec OP-BRIEF-P010-WAIT (integration layer).
 *
 * The wait briefs are projections of records the lock and await stores already own, so the
 * integration question is: fed the REAL rows those stores return (not hand-built fixtures),
 * does the projection name the right owner, deadline, wake key and retract handle — and does
 * it go silent the moment the real store says the wait no longer blocks?
 *
 * Both stores are real, exactly as in lock-grant-wake.integration.test.ts:
 *   locks side-DB (papercusp_su via getTxPool — skipIf down) + the awaits store on a
 *   migrated org fixture.
 *
 * Every expected value is a literal or is read straight off the store row; nothing is
 * recomputed through the code under test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  ws: 'ws-wait-brief-test',
  sendMessage: vi.fn(async () => ({ msg_id: 'm-x' })),
  admitSpawn: vi.fn(async () => ({ admitted: true })),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    // locks/configure.ts calls this at import time (WI-832).
    setAdminPoolStatementTimeoutProvider: () => {},
  };
});
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../../coordination/messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('../../../fleet/governor', () => ({ admitSpawn: h.admitSpawn }));

const { ensureBootstrap, getTxPool, normalizePaths, tryAcquire, tryInsertWaiter } = await import('../su-lock-store');
const { inWorkspaceTxn } = await import('../in-workspace-txn');
const { lockGrantKey } = await import('../lock-grant-bridge');
const { busyToJson } = await import('../enrich-busy');
const awaitStore = await import('../../../events/await/store');
const { projectLockWaitOperationalBrief, projectAwaitWaitOperationalBrief } = await import(
  '../../../operational-brief/wait-brief'
);
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

describe('lock/await wait briefs over real store rows (real PG ×2)', async () => {
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
    'a queued wake_on_grant lock wait projects the holder, the waiter window and the grant key; the real fire silences it',
    async () => {
      const domain = 'wait-brief-' + Date.now();
      const paths = normalizePaths(['lib/p010-wait-brief.ts']);

      // Holder A takes the lock with a long lease.
      const a = await inWorkspaceTxn(domain, 'agent-a', (tx) =>
        tryAcquire(tx, { coordinationDomain: domain, owner: 'agent-a', ownerLabel: 'A', paths, intent: 'hold for p010', ttlSec: 300 }),
      );
      expect(a.ok).toBe(true);
      const holderExpiry = (a as { expires_ts: Date }).expires_ts;

      // Waiter B: the busy refusal locks:acquire reads its holder snapshot from…
      const first = await inWorkspaceTxn(domain, 'agent-b', (tx) =>
        tryAcquire(tx, { coordinationDomain: domain, owner: 'agent-b', ownerLabel: 'B', paths, intent: 'queue for p010', ttlSec: 60 }),
      );
      expect(first.ok).toBe(false);
      const busy = (first as { busy: Parameters<typeof busyToJson>[0][] }).busy;
      expect(busy.map((b) => b.owner)).toEqual(['agent-a']);
      // The holder snapshot is a separate read of A's lease, so its timestamp can differ from
      // A's own acquire return by sub-millisecond rounding. It is the SAME lease; the brief
      // reports the snapshot locks:acquire hands the waiter, so that is the oracle below.
      const snapshotExpiry = busy[0].expires_ts;
      expect(Math.abs(snapshotExpiry.getTime() - holderExpiry.getTime())).toBeLessThanOrEqual(5);

      // …then the queued ticket and the one-shot wake await, with the exact parameters
      // locks:acquire { wake_on_grant:true } registers.
      const before = Date.now();
      const inserted = await inWorkspaceTxn(domain, 'agent-b', (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: domain,
          owner: 'agent-b',
          ownerLabel: 'B',
          paths,
          intent: 'queue for p010',
          ttlSec: 60,
          maxWaitSec: 1800,
        }),
      );
      expect(inserted.ok).toBe(true);
      expect('self_granted' in inserted).toBe(false);
      const { ticket_id: ticketId, wait_until: waitUntil } = inserted as { ticket_id: string; wait_until: Date };
      // The store computed the queue window (~30 min out), not the test.
      expect(waitUntil.getTime()).toBeGreaterThan(before + 1_700_000);
      expect(waitUntil.getTime()).toBeLessThan(Date.now() + 1_900_000);

      const wakeAwait = await awaitStore.registerAwait({
        subscriberId: 'su-p010-waiter-b',
        eventKey: lockGrantKey(ticketId),
        policy: 'wake',
        note: 'lock wait: lib/p010-wait-brief.ts — queue for p010',
        timeoutBehavior: 'wake',
        timeoutSec: 1800 + 120,
      });
      expect(wakeAwait.eventKey).toBe(`lock:grant:${ticketId}`);
      expect((await awaitStore.listActiveAwaits('su-p010-waiter-b')).map((r) => r.id)).toContain(wakeAwait.id);

      const brief = projectLockWaitOperationalBrief({
        ticketId,
        paths,
        waitUntil,
        wakeAwait,
        holders: busy.map(busyToJson),
      });
      expect(brief).not.toBeNull();
      expect(brief!.surface).toBe('lock-wait');
      expect(brief!.subject).toBe(`lock lib/p010-wait-brief.ts (ticket ${ticketId})`);
      expect(brief!.state).toEqual({ status: 'known', value: 'queued-for-wake', source: 'agent_lock_waiters' });
      expect(brief!.owner).toEqual({ status: 'known', value: 'agent-a', source: 'agent_locks holder snapshot' });
      expect(brief!.deadline).toEqual({
        status: 'known',
        value: waitUntil.toISOString(),
        source: 'agent_lock_waiters.wait_until',
      });
      expect(brief!.blockers).toEqual({
        status: 'known',
        value: [`lib/p010-wait-brief.ts held by agent-a (A) for "hold for p010" until ${snapshotExpiry.toISOString()}`],
        source: 'agent_locks holder snapshot',
      });
      expect(brief!.nextAction.status).toBe('known');
      expect((brief!.nextAction as { value: string }).value.startsWith('END YOUR TURN. On grant you are re-invoked')).toBe(
        true,
      );
      expect(brief!.facts.awaitId).toEqual({ status: 'known', value: wakeAwait.id, source: 'event_awaits' });
      expect(brief!.facts.grantEventKey).toEqual({
        status: 'known',
        value: `lock:grant:${ticketId}`,
        source: 'event_awaits',
      });
      expect(brief!.facts.holderLeaseEndsAt).toEqual({
        status: 'known',
        value: snapshotExpiry.toISOString(),
        source: 'agent_locks holder snapshot',
      });
      expect(brief!.facts.retract).toBe(
        `locks:cancel_wait { ticket_id: '${ticketId}' } + events:cancel { await_id: ${wakeAwait.id} }`,
      );

      // The grant bridge fires the ticket's key: the store marks the one-shot row fired and
      // the SAME projection over that real row returns no brief.
      const fired = await awaitStore.fireAwaitsForKey({
        eventKey: lockGrantKey(ticketId),
        source: 'lock-grant-bridge',
        payload: { granted: true },
      });
      const firedRow = fired.find((r) => r.id === wakeAwait.id);
      expect(firedRow?.firedAt).toBeTruthy();
      expect((await awaitStore.listActiveAwaits('su-p010-waiter-b')).map((r) => r.id)).not.toContain(wakeAwait.id);
      expect(
        projectLockWaitOperationalBrief({ ticketId, paths, waitUntil, wakeAwait: firedRow!, holders: busy.map(busyToJson) }),
      ).toBeNull();
    },
    60_000,
  );

  it.skipIf(!live)(
    'a pending await on an announced gate names the declarer as owner and the row deadline; notify/standing rows and a real fire yield no brief',
    async () => {
      const key = `p010:wait-brief-gate:${Date.now()}`;
      await awaitStore.registerAnnouncement({
        subscriberId: 'su-p010-declarer',
        eventKey: key,
        scopeKind: 'global',
        note: 'p010 integration gate',
      });

      const before = Date.now();
      const row = await awaitStore.registerAwait({
        subscriberId: 'su-p010-waiter',
        eventKey: key,
        policy: 'wake',
        timeoutBehavior: 'wake',
        timeoutSec: 600,
      });
      expect(row.expiresTs).toBeTruthy();
      expect(Date.parse(row.expiresTs!)).toBeGreaterThan(before + 590_000);

      // The handler's own read: the pending declaration for this exact key.
      const anns = await awaitStore.findAnnouncementsForKey(key);
      const declared = anns.find((a) => !a.firedAt);
      expect(declared?.subscriberId).toBe('su-p010-declarer');

      const brief = projectAwaitWaitOperationalBrief({
        wakeAwait: row,
        announcement: { announcedBy: declared!.subscriberId },
      });
      expect(brief).not.toBeNull();
      expect(brief!.surface).toBe('await-wait');
      expect(brief!.subject).toBe(key);
      expect(brief!.state).toEqual({ status: 'known', value: 'waiting', source: 'event_awaits' });
      expect(brief!.owner).toEqual({
        status: 'known',
        value: 'su-p010-declarer',
        source: 'events:emit announce declaration',
      });
      expect(brief!.deadline).toEqual({ status: 'known', value: row.expiresTs, source: 'event_awaits.expires_ts' });
      expect(brief!.facts.awaitId).toBe(row.id);
      expect(brief!.facts.onTimeout).toBe('wake');
      expect(brief!.facts.announced).toBe(true);
      expect(brief!.facts.retract).toBe(`events:cancel { await_id: ${row.id} }`);
      expect((brief!.nextAction as { value: string }).value).toBe(
        `END YOUR TURN. You are re-invoked when ${key} fires, or with a timeout wake by ${row.expiresTs}. On a timeout wake, check that su-p010-declarer is progressing before re-arming; a stalled emitter is your blocker to diagnose.`,
      );

      // Rows the store returns for NON-blocking registrations carry no brief.
      const notifyRow = await awaitStore.registerAwait({ subscriberId: 'su-p010-notify', eventKey: key, policy: 'notify' });
      expect(notifyRow.policy).toBe('notify');
      expect(projectAwaitWaitOperationalBrief({ wakeAwait: notifyRow })).toBeNull();
      const standingRow = await awaitStore.registerAwait({
        subscriberId: 'su-p010-standing',
        eventKey: key,
        policy: 'wake',
        once: false,
      });
      expect(standingRow.once).toBe(false);
      expect(projectAwaitWaitOperationalBrief({ wakeAwait: standingRow })).toBeNull();

      // The emit fires the one-shot row; the fired row the store returns yields no brief.
      const fired = await awaitStore.fireAwaitsForKey({ eventKey: key, source: 'su-p010-declarer' });
      const firedRow = fired.find((r) => r.id === row.id);
      expect(firedRow?.firedAt).toBeTruthy();
      expect(projectAwaitWaitOperationalBrief({ wakeAwait: firedRow!, announcement: { announcedBy: 'su-p010-declarer' } })).toBeNull();
    },
    60_000,
  );

  it.skipIf(!live)('an await whose real expires_ts has passed yields no brief (lapsed is not blocking)', async () => {
    const key = `p010:wait-brief-lapse:${Date.now()}`;
    const row = await awaitStore.registerAwait({
      subscriberId: 'su-p010-lapse',
      eventKey: key,
      policy: 'wake',
      timeoutBehavior: 'wake',
      timeoutSec: 1,
    });
    // Pending right after registration…
    expect(projectAwaitWaitOperationalBrief({ wakeAwait: row })).not.toBeNull();
    // …and silent once the store's own deadline has passed.
    await sleep(1_300);
    expect(Date.parse(row.expiresTs!)).toBeLessThanOrEqual(Date.now());
    expect(projectAwaitWaitOperationalBrief({ wakeAwait: row })).toBeNull();
  });
});
