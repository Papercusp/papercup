/**
 * await-store.integration.test.ts — the await-event store against real
 * Postgres (await-event-primitive-2026-06-05 P-001/P-006, migration 163).
 *
 * Validates the migrated `event_awaits` + `event_wake_deliveries` tables and
 * the store's one-shot/claim/settle SQL — including the atomic one-shot
 * guarantee under concurrent emits (D-002) and the delivery state machine
 * (D-004). Follows the org-fixture mock pattern (test/_org-test-db.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-await-test' }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const store = await import('./store');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

describe('event_awaits + event_wake_deliveries (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('registers an await with the wake handle + computed deadline', async () => {
    const row = await store.registerAwait({
      subscriberId: 'su-1',
      eventKey: 'demo:done',
      note: 'waiting on the demo',
      wakeHandle: {
        kind: 'adv-session',
        advSessionId: 5,
        agent: 'claude',
        sessionId: 'sid',
        ompThreadId: null,
        cwd: '/r',
        pid: 1,
      },
      timeoutBehavior: 'wake',
      timeoutSec: 3600,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.policy).toBe('wake');
    expect(row.wakeHandle).toMatchObject({ kind: 'adv-session', advSessionId: 5 });
    expect(row.expiresTs).not.toBeNull();
    expect(new Date(row.expiresTs!).getTime()).toBeGreaterThan(Date.now() + 3000_000);
  });

  it('fires one-shot: the first fire returns the await, the second returns nothing', async () => {
    await store.registerAwait({ subscriberId: 'su-2', eventKey: 'once:k' });
    const first = await store.fireAwaitsForKey({ eventKey: 'once:k' });
    expect(first.map((a) => a.subscriberId)).toEqual(['su-2']);
    expect(first[0].firedReason).toBe('event');
    const second = await store.fireAwaitsForKey({ eventKey: 'once:k' });
    expect(second).toEqual([]);
  });

  it('CONCURRENT fires of one key fire each await exactly once (atomic one-shot)', async () => {
    await store.registerAwait({ subscriberId: 'su-3', eventKey: 'race:k' });
    await store.registerAwait({ subscriberId: 'su-4', eventKey: 'race:k' });
    const [a, b, c] = await Promise.all([
      store.fireAwaitsForKey({ eventKey: 'race:k' }),
      store.fireAwaitsForKey({ eventKey: 'race:k' }),
      store.fireAwaitsForKey({ eventKey: 'race:k' }),
    ]);
    const total = a.length + b.length + c.length;
    expect(total).toBe(2);
  });

  it('cancel is subscriber-scoped: yours cancels, a peer’s does not', async () => {
    const mine = await store.registerAwait({ subscriberId: 'su-5', eventKey: 'cancel:k' });
    expect(await store.cancelAwait({ awaitId: mine.id, subscriberId: 'su-other' })).toBe(false);
    expect(await store.cancelAwait({ awaitId: mine.id, subscriberId: 'su-5' })).toBe(true);
    // Cancelled awaits do not fire.
    expect(await store.fireAwaitsForKey({ eventKey: 'cancel:k' })).toEqual([]);
  });

  it('deliveries: insert → claim flips to delivering and joins the handle + note', async () => {
    const a = await store.registerAwait({
      subscriberId: 'su-6',
      eventKey: 'deliver:k',
      note: 'the join carries me',
      wakeHandle: { kind: 'plan-run', runId: 99 },
    });
    const fired = await store.fireAwaitsForKey({ eventKey: 'deliver:k' });
    expect(fired).toHaveLength(1);
    await store.insertDeliveries({ awaits: fired, payload: { n: 1 }, summary: 'done!' });

    const work = await store.claimDueDeliveries({ limit: 5 });
    const mine = work.filter((w) => w.awaitId === a.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('delivering');
    expect(mine[0].wakeHandle).toMatchObject({ kind: 'plan-run', runId: 99 });
    expect(mine[0].note).toBe('the join carries me');
    expect(mine[0].payload).toEqual({ n: 1 });
    expect(mine[0].summary).toBe('done!');

    // Claimed rows are not re-claimable while delivering.
    const again = await store.claimDueDeliveries({ limit: 5 });
    expect(again.filter((w) => w.awaitId === a.id)).toHaveLength(0);

    // Settle: delivered with channel attribution (the D-007 meter dimension).
    await store.markDeliveryDelivered(mine[0].id, 'plan-run-resume');
    const recent = await store.listRecentDeliveries('su-6');
    expect(recent[0]).toMatchObject({ status: 'delivered', channel: 'plan-run-resume' });
  });

  it('failure path: backoff-retry then dead at max attempts', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-7', eventKey: 'fail:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'fail:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    expect(w.subscriberId).toBe('su-7');

    expect(
      await store.markDeliveryFailed({ id: w.id, error: 'e1', attempts: 1, maxAttempts: 8, backoffMs: 1 }),
    ).toBe('retrying');
    expect(
      await store.markDeliveryFailed({ id: w.id, error: 'e2', attempts: 8, maxAttempts: 8, backoffMs: 1 }),
    ).toBe('dead');
    const recent = await store.listRecentDeliveries('su-7');
    expect(recent[0]).toMatchObject({ status: 'dead', lastError: 'e2' });
  });

  it('parked rows wait out their recheck window; dropped rows are terminal + visible', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-8', eventKey: 'park:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'park:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    await store.markDeliveryParked(w.id, 'alive, no pty', 60_000);
    // Not due yet → not re-claimed.
    expect((await store.claimDueDeliveries({ limit: 5 })).filter((x) => x.id === w.id)).toHaveLength(0);
    await store.markDeliveryDropped(w.id, 'dead waiter');
    const recent = await store.listRecentDeliveries('su-8');
    expect(recent[0]).toMatchObject({ status: 'dropped', lastError: 'dead waiter' });
  });

  it('ack settles MY parked wake as inbox-delivered; a peer cannot ack it', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-ack', eventKey: 'ack:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'ack:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    await store.markDeliveryParked(w.id, 'alive, no pty', 60_000);
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-imposter' })).toBe(false);
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack' })).toBe(true);
    const recent = await store.listRecentDeliveries('su-ack');
    expect(recent[0]).toMatchObject({ status: 'delivered', channel: 'inbox' });
    // Idempotence: a second ack is a no-op (already settled).
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack' })).toBe(false);
  });

  it('deferred rows give back their attempt and re-queue', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-9', eventKey: 'defer:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'defer:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    expect(w.attempts).toBe(1);
    await store.markDeliveryDeferred(w.id, 0);
    const [again] = (await store.claimDueDeliveries({ limit: 5 })).filter((x) => x.id === w.id);
    expect(again).toBeDefined();
    expect(again.attempts).toBe(1); // deferral did not burn the attempt
  });

  it('stuck-delivering recovery re-queues crashed-host claims', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-10', eventKey: 'stuck:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'stuck:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    // Simulate a crash long ago: claimed (delivering) with an old next_attempt_at.
    const sql = h.sql as import('postgres').Sql;
    await sql`UPDATE harness_shared.event_wake_deliveries SET next_attempt_at = now() - interval '1 hour' WHERE id = ${w.id}`;
    expect(await store.recoverStuckDeliveries({ olderThanMs: 5 * 60_000 })).toBeGreaterThanOrEqual(1);
    const reclaimed = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.id === w.id);
    expect(reclaimed).toHaveLength(1);
    await store.markDeliveryDelivered(w.id, 'inbox');
  });

  it('timeouts: wake-behavior awaits fire as TIMEOUT; expire-behavior awaits lapse silently', async () => {
    await store.registerAwait({
      subscriberId: 'su-11',
      eventKey: 'never:k',
      timeoutBehavior: 'wake',
      timeoutSec: 0,
    });
    await store.registerAwait({
      subscriberId: 'su-12',
      eventKey: 'never:k2',
      timeoutBehavior: 'expire',
      timeoutSec: 0,
    });
    await new Promise((r) => setTimeout(r, 50));
    const timedOut = await store.fireTimedOutAwaits();
    expect(timedOut.some((a) => a.subscriberId === 'su-11')).toBe(true);
    expect(timedOut.every((a) => a.firedReason === 'timeout')).toBe(true);
    expect(await store.expireLapsedAwaits()).toBeGreaterThanOrEqual(1);
    // Both settled — nothing active remains for either key.
    expect(await store.listActiveAwaits('su-11')).toEqual([]);
    expect(await store.listActiveAwaits('su-12')).toEqual([]);
  });

  it('the wake meter aggregates per subscriber/status/channel', async () => {
    const meter = await store.wakeMeter({ sinceHours: 24 });
    expect(meter.length).toBeGreaterThan(0);
    const delivered = meter.find((m) => m.subscriberId === 'su-6' && m.status === 'delivered');
    expect(delivered).toMatchObject({ channel: 'plan-run-resume', count: 1 });
  });

  it("workspace scoping NORMALIZES to the coord namespace: a '*'-scoped registration fires on a system emit (the live WI-40 regression)", async () => {
    // An unscoped SU shell registers with identity.workspaceId '*'; a system
    // source (work-items settle) emits with the active workspace. Both must
    // land in the ONE coord-plane namespace or the wake never fires.
    await store.registerAwait({ subscriberId: 'su-13', eventKey: 'ws:k', workspaceId: '*' });
    const fired = await store.fireAwaitsForKey({ eventKey: 'ws:k', workspaceId: 'some-active-workspace' });
    expect(fired).toHaveLength(1);
    expect(fired[0].subscriberId).toBe('su-13');
  });
});
