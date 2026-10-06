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
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-await-test' }));

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const store = await import('./store');
const { reconcileInterestEventAwaits } = await import('../../interest-auto-arm');
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

  /**
   * EI-21295379735880011 — loop-fire Guard 4 withholds an agent's routine wake while
   * this read reports it PARKED. A park must mean "the agent CHOSE to sleep on an
   * event"; a PLATFORM-ARMED binding means the system registered an interest on the
   * agent's behalf while it keeps working. Reading the second as the first silences a
   * fleet leader's own supervision loop from the moment it takes the fleet (~5 rows per
   * fleet), and throttles any work-item holder.
   *
   * The deliberate-park row is a POSITIVE CONTROL: without it a query that returned
   * nothing at all would satisfy both exclusion assertions and look like a pass.
   */
  it('listParkedAwaitsForSubscribers excludes PLATFORM-ARMED bindings (work-item-claim, fleet-leadership) and keeps a deliberate park (EI-21295379735880011)', async () => {
    const sub = 'su-parked-exclusions';

    await store.registerAwait({ subscriberId: sub, eventKey: 'gate:green' });
    await store.registerAwait({
      subscriberId: sub,
      eventKey: 'claim:released:WI-9001',
      note: 'claim-holder auto-arm for WI-9001',
      boundTo: { kind: 'work-item-claim', ref: 'WI-9001' },
    });
    await store.registerAwait({
      subscriberId: sub,
      eventKey: 'fleet:member-dead:demo-fleet',
      note: 'fleet-leader auto-arm (fleet:member-dead:demo-fleet)',
      boundTo: { kind: 'fleet-leadership', ref: 'demo-fleet' },
    });

    const keys = (await store.listParkedAwaitsForSubscribers([sub])).map((r) => r.eventKey);

    // Positive control — the read works and this subscriber's rows are visible.
    expect(keys).toContain('gate:green');
    // Neither auto-arm is a park: the agent chose neither.
    expect(keys).not.toContain('claim:released:WI-9001');
    expect(keys).not.toContain('fleet:member-dead:demo-fleet');
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

  it('returns an uncapped live-await total alongside the bounded sample', async () => {
    const subscriberId = 'su-wake-count-over-cap';
    for (let i = 1; i <= 6; i += 1) {
      await store.registerAwait({ subscriberId, eventKey: `counted:${i}` });
    }

    const result = await store.listWakeAwaitsForSubscriber(subscriberId);

    expect(result.totalCount).toBe(6);
    expect(result.sample).toHaveLength(5);
    expect(result.sample.every((row) => row.eventKey.startsWith('counted:'))).toBe(true);
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

  it('keeps one newest exact one-shot across sequential and concurrent registration surfaces', async () => {
    const subscriberId = 'su-exact-registration-dedup';
    const eventKey = 'exact:registration:dedup';
    const first = await store.registerAwait({ subscriberId, eventKey, note: 'direct events:await' });
    const second = await store.registerAwait({
      subscriberId,
      eventKey,
      note: 'lifecycle auto-arm',
      boundTo: { kind: 'work-item-claim', ref: 'EI-exact-registration-dedup' },
    });

    expect((await store.listActiveAwaits(subscriberId)).map((row) => row.id)).toEqual([second.id]);

    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.registerAwait({
          subscriberId,
          eventKey,
          note: `concurrent surface ${index}`,
          ...(index % 2 === 0
            ? {}
            : { boundTo: { kind: 'fleet-leadership', ref: 'exact-registration-dedup' } }),
        }),
      ),
    );
    const active = (await store.listActiveAwaits(subscriberId)).filter((row) => row.eventKey === eventKey);
    expect(active).toHaveLength(1);
    expect(concurrent.map((row) => row.id)).toContain(active[0].id);

    const history = await db.adminSql<{ id: number; cancelled_at: string | null }[]>`
      SELECT id, cancelled_at
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ${subscriberId} AND event_key = ${eventKey}
       ORDER BY id
    `;
    expect(history).toHaveLength(14);
    expect(history.filter((row) => row.cancelled_at == null)).toHaveLength(1);
    expect(history.find((row) => row.id === first.id)?.cancelled_at).not.toBeNull();
    expect(history.find((row) => row.id === second.id)?.cancelled_at).not.toBeNull();
  });

  it.each([
    ['unfiltered', null],
    ['filtered', { result: { equals: 'ready' } }],
  ])('auto-arm preserves the original bounded %s wait identity, deadline and predicate', async (name, payloadFilter) => {
    const subscriberId = `su-preserve-explicit-${name}`;
    const eventKey = `work-item:done:source-${name}`;
    const manual = await store.registerAwait({
      subscriberId, eventKey, timeoutSec: 3600, timeoutBehavior: 'expire', payloadFilter,
      note: 'explicit source wait', wakeHandle: { kind: 'plan-run', runId: 9 },
    });
    const out = await reconcileInterestEventAwaits(
      { ownerId: subscriberId, eventKeys: [eventKey], boundTo: { kind: 'work-item-blocked', ref: `WI-${name}` }, note: 'blocked-item-holder auto-arm' },
      { captureHandle: async () => ({ handle: { kind: 'plan-run', runId: 10 }, note: 'reachable' }), listActive: store.listActiveAwaits, register: store.registerAwait, cancel: store.cancelAwait },
    );
    expect(out.await_ids).toEqual([manual.id]);
    expect(await store.listActiveAwaits(subscriberId)).toEqual([manual]);
  });

  it.each([
    ['unfiltered', null],
    ['filtered', { result: { equals: 'ready' } }],
  ])('preserves a bounded %s wait registered after the reconciliation snapshot', async (name, payloadFilter) => {
    const subscriberId = `su-preserve-late-${name}`;
    const eventKey = `work-item:done:late-${name}`;
    let manual: Awaited<ReturnType<typeof store.registerAwait>>;
    const out = await reconcileInterestEventAwaits(
      { ownerId: subscriberId, eventKeys: [eventKey], boundTo: { kind: 'work-item-blocked', ref: `WI-late-${name}` }, note: 'blocked-item-holder auto-arm' },
      {
        captureHandle: async () => ({ handle: { kind: 'plan-run', runId: 10 }, note: 'reachable' }),
        listActive: async (ownerId) => {
          const snapshot = await store.listActiveAwaits(ownerId);
          manual = await store.registerAwait({ subscriberId, eventKey, timeoutSec: 3600, payloadFilter, note: 'late explicit wait' });
          return snapshot;
        },
        register: store.registerAwait, cancel: store.cancelAwait,
      },
    );
    expect(out.await_ids).toEqual([manual!.id]);
    expect(await store.listActiveAwaits(subscriberId)).toEqual([manual!]);
  });

  it('concurrent preservation registrations reuse the original deadline without inserting replacements', async () => {
    const subscriberId = 'su-preserve-concurrent';
    const eventKey = 'work-item:done:concurrent-source';
    const manual = await store.registerAwait({ subscriberId, eventKey, timeoutSec: 3600, note: 'explicit source wait' });
    const registered = await Promise.all(Array.from({ length: 6 }, () => store.registerAwait({
      subscriberId, eventKey, boundTo: { kind: 'work-item-blocked', ref: 'WI-concurrent' },
      ...{ preserveExplicitWait: true },
    })));
    expect(registered.every((row) => row.id === manual.id && row.expiresTs === manual.expiresTs)).toBe(true);
    expect(await store.listActiveAwaits(subscriberId)).toEqual([manual]);
    const history = await db.adminSql<{ id: number }[]>`
      SELECT id FROM harness_shared.event_awaits WHERE subscriber_id = ${subscriberId} AND event_key = ${eventKey}
    `;
    expect(history.map((row) => Number(row.id))).toEqual([manual.id]);
  });

  it('keeps filtered predicates and fleet benches distinct from ordinary exact dedup', async () => {
    const subscriberId = 'su-exact-special-surfaces';
    const eventKey = 'exact:special:surfaces';
    const filtered = await store.registerAwait({
      subscriberId,
      eventKey,
      payloadFilter: { candidate: { equals: 'one' } },
    });
    const filteredSibling = await store.registerAwait({
      subscriberId,
      eventKey,
      payloadFilter: { candidate: { equals: 'two' } },
    });
    const bench = await store.registerAwait({
      subscriberId,
      eventKey,
      note: '[fleet:bench] staged assignment',
    });
    const ordinary = await store.registerAwait({ subscriberId, eventKey });

    expect((await store.listActiveAwaits(subscriberId)).map((row) => row.id).sort()).toEqual(
      [filtered.id, filteredSibling.id, bench.id, ordinary.id].sort(),
    );
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

  it('lists recent deliveries for one await with its composed verdict payload', async () => {
    const subscriberId = 'su-focused-await-history';
    const target = await store.registerAwait({ subscriberId, eventKey: 'composed-root:408' });
    const other = await store.registerAwait({ subscriberId, eventKey: 'composed-root:409' });
    const payload = {
      composed: true,
      satisfied: true,
      reason: 'event',
      fired: [{ event: 'green-checkpoint:inconclusive:papercusp', payload: { reason: 'skipped-locked' } }],
    };
    await store.insertDeliveries({ awaits: [target], payload, summary: 'composed verdict' });
    await store.insertDeliveries({ awaits: [other], payload: { unrelated: true }, summary: 'other delivery' });

    const recent = await store.listRecentDeliveries(subscriberId, 10, target.id);

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ awaitId: target.id, payload, summary: 'composed verdict' });
  });

  it('a newer loop fire drops older pending/parked wakes from the same loop instance', async () => {
    const awaited = await store.registerAwait({
      subscriberId: 'su-loop-supersession',
      eventKey: 'coord:inbox-wake:su-loop-supersession',
      once: false,
    });

    await store.insertDeliveries({ awaits: [awaited], summary: 'fire 1', source: 'loop:rt-loop-supersession' });
    await store.insertDeliveries({ awaits: [awaited], summary: 'fire 2', source: 'loop:rt-loop-supersession' });
    await store.insertDeliveries({ awaits: [awaited], summary: 'fire 3', source: 'loop:rt-loop-supersession' });

    const recent = await store.listRecentDeliveries('su-loop-supersession', 10);
    expect(recent.find((d) => d.summary === 'fire 3')).toMatchObject({ status: 'pending' });
    expect(recent.find((d) => d.summary === 'fire 2')).toMatchObject({
      status: 'dropped',
      lastError: expect.stringContaining('superseded by newer loop wake'),
    });
    expect(recent.find((d) => d.summary === 'fire 1')).toMatchObject({ status: 'dropped' });

    // Do not leave a live row behind for the shared-fixture tests below.
    await store.markDeliveryDropped(recent.find((d) => d.summary === 'fire 3')!.id, 'test cleanup');
  });

  it('a fresh delivery gets its first attempt before an old repeatedly-failed row', async () => {
    const oldAwait = await store.registerAwait({ subscriberId: 'su-fair-old', eventKey: 'fair:old' });
    await store.insertDeliveries({ awaits: [oldAwait], summary: 'old retry' });
    const old = (await store.claimDueDeliveries({ limit: 10 })).find((d) => d.subscriberId === 'su-fair-old')!;
    await store.markDeliveryFailed({ id: old.id, error: 'still unreachable', attempts: old.attempts, maxAttempts: 8, backoffMs: 0 });

    const freshAwait = await store.registerAwait({ subscriberId: 'su-fair-fresh', eventKey: 'fair:fresh' });
    await store.insertDeliveries({ awaits: [freshAwait], summary: 'fresh first attempt' });

    const [claimed] = await store.claimDueDeliveries({ limit: 1 });
    expect(claimed.subscriberId).toBe('su-fair-fresh');
    expect(claimed.attempts).toBe(1);

    await store.markDeliveryDropped(claimed.id, 'test cleanup');
    await store.markDeliveryDropped(old.id, 'test cleanup');
  });

  it('reserves one slot for an aged parked retry without letting retries monopolize the batch', async () => {
    const prefix = 'su-fair-aged';
    const oldAwait = await store.registerAwait({ subscriberId: `${prefix}-old`, eventKey: 'fair:aged:old' });
    await store.insertDeliveries({ awaits: [oldAwait], summary: 'aged parked retry' });
    const old = (await store.claimDueDeliveries({ limit: 10 })).find((d) => d.subscriberId === `${prefix}-old`)!;
    await store.markDeliveryParked(old.id, 'subscriber is currently uninjectable', 0);
    // Make the retry old enough to enter the bounded starvation reserve. The
    // current query's attempts tier would leave it behind every fresh row.
    await db.adminSql`
      UPDATE harness_shared.event_wake_deliveries
         SET created_at = now() - interval '2 minutes',
             next_attempt_at = now()
       WHERE id = ${old.id}
    `;

    for (let i = 0; i < 5; i += 1) {
      const freshAwait = await store.registerAwait({
        subscriberId: `${prefix}-fresh-${i}`,
        eventKey: `fair:aged:fresh:${i}`,
      });
      await store.insertDeliveries({ awaits: [freshAwait], summary: `fresh ${i}` });
    }

    const claimed = await store.claimDueDeliveries({ limit: 5 });
    const ours = claimed.filter((d) => d.subscriberId.startsWith(`${prefix}-`));
    expect(ours).toHaveLength(5);
    expect(ours.find((d) => d.subscriberId === `${prefix}-old`)).toMatchObject({
      attempts: 2,
      status: 'delivering',
    });
    expect(ours.filter((d) => d.subscriberId.startsWith(`${prefix}-fresh-`))).toHaveLength(4);

    for (const delivery of ours) await store.markDeliveryDropped(delivery.id, 'test cleanup');
    await db.adminSql`
      DELETE FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id LIKE ${`${prefix}-%`}
    `;
  });

  it('drops queued and claimed deliveries for any cancelled await before wake execution', async () => {
    const key = `${store.INBOX_WAKE_KEY_PREFIX}su-cancelled-wake`;
    await store.upsertInboxWakeAwait({ subscriberId: 'su-cancelled-wake', eventKey: key, note: 'standing wake' });

    const first = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: first, summary: 'claimed-before-cancel' });
    const [claimed] = await store.claimDueDeliveries({ limit: 5 });
    expect(claimed.status).toBe('delivering');

    // A second delivery remains pending when cancellation begins. The cancel
    // path drops it immediately; the pump guard owns only the already-claimed
    // race above.
    const second = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: second, summary: 'pending-before-cancel' });
    expect(await store.cancelInboxWakeAwaits('su-cancelled-wake')).toBe(1);

    expect(await store.settleCancelledAwaitDeliveries([claimed])).toEqual([claimed.id]);

    const recent = await store.listRecentDeliveries('su-cancelled-wake', 10);
    expect(recent.find((delivery) => delivery.summary === 'claimed-before-cancel')).toMatchObject({
      status: 'dropped',
      channel: null,
    });
    expect(recent.find((delivery) => delivery.summary === 'pending-before-cancel')).toMatchObject({
      status: 'dropped',
    });

    expect(await store.settleCancelledAwaitDeliveries([claimed])).toEqual([]);
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

  it('reopens an optimistically delivered resume after its detached turn dies', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-resume-death', eventKey: 'resume:dies' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'resume:dies' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = (await store.claimDueDeliveries({ limit: 5 })).filter(
      (row) => row.subscriberId === 'su-resume-death',
    );
    await store.markDeliveryDelivered(w.id, 'resume-headless');

    expect(
      await store.reopenDeliveredAfterResumeDeath({
        id: w.id,
        error: 'resume-turn-death:rate_limited',
        maxAttempts: 8,
        backoffMs: 1,
      }),
    ).toBe('retrying');
    const recent = await store.listRecentDeliveries('su-resume-death');
    expect(recent[0]).toMatchObject({
      status: 'pending',
      channel: null,
      deliveredAt: null,
      lastError: 'resume-turn-death:rate_limited',
    });

    // A stale duplicate exit callback cannot revise the row a second time.
    expect(
      await store.reopenDeliveredAfterResumeDeath({
        id: w.id,
        error: 'duplicate',
        maxAttempts: 8,
        backoffMs: 1,
      }),
    ).toBe('ignored');
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
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-imposter' })).toEqual({
      acked: false,
      alreadySettled: false,
    });
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack' })).toEqual({
      acked: true,
      alreadySettled: false,
    });
    const recent = await store.listRecentDeliveries('su-ack');
    expect(recent[0]).toMatchObject({ status: 'delivered', channel: 'inbox' });
    // Idempotence: a second ack is a no-op (already settled).
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack' })).toEqual({
      acked: false,
      alreadySettled: true,
      status: 'delivered',
    });
  });

  it('does not ack a wake already being delivered by the pump', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-ack-delivering', eventKey: 'ack:delivering' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'ack:delivering' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });

    expect(w.status).toBe('delivering');
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack-delivering' })).toEqual({
      acked: false,
      alreadySettled: false,
      status: 'delivering',
    });
    expect((await store.listRecentDeliveries('su-ack-delivering'))[0]).toMatchObject({
      id: w.id,
      status: 'delivering',
    });
  });

  it('settleCaughtUpInboxWakeDeliveries (EI-9389): settles MY pre-cutoff pending/parked standing-inbox-wake deliveries as coalesced; a post-cutoff row and a peer\'s row are left alone', async () => {
    const key = `${store.INBOX_WAKE_KEY_PREFIX}su-settle`;
    // The always-armed standing (once:false) inbox-wake watch — mirrors the real thing.
    await store.registerAwait({ subscriberId: 'su-settle', eventKey: key, once: false });

    // Delivery #1 (parked): claim it IMMEDIATELY (nothing else queued yet, so
    // claimDueDeliveries can't accidentally sweep a sibling row too) then park it —
    // both pre-cutoff settle paths (pending AND parked) must be covered.
    const fired1 = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: fired1, summary: 'seen-parked' });
    const [toPark] = await store.claimDueDeliveries({ limit: 1 });
    await store.markDeliveryParked(toPark.id, 'alive, no pty', 60_000);

    // Delivery #2 (pending): traffic the agent has ALREADY read in a bulk coord:inbox,
    // left untouched (never claimed) — this is the common case.
    const fired1b = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: fired1b, summary: 'seen-pending' });

    // A peer's own standing wake, fired at the same moment — must NEVER be touched by
    // MY settle call (subscriber_id-scoped, like ackDelivery).
    const peerKey = `${store.INBOX_WAKE_KEY_PREFIX}su-settle-peer`;
    await store.registerAwait({ subscriberId: 'su-settle-peer', eventKey: peerKey, once: false });
    const firedPeer = await store.fireAwaitsForKey({ eventKey: peerKey });
    await store.insertDeliveries({ awaits: firedPeer, summary: 'peer-untouched' });

    // The cutoff: everything above was queued before this instant.
    const cutoffTs = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20)); // ensure strictly-later created_at below

    // Delivery #2: fired AFTER the cutoff (arrived mid-read) — must survive untouched.
    const fired2 = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: fired2, summary: 'post-cutoff' });

    const settledCount = await store.settleCaughtUpInboxWakeDeliveries({ subscriberId: 'su-settle', cutoffTs });
    expect(settledCount).toBe(2); // the pending + the parked pre-cutoff rows

    const mine = await store.listRecentDeliveries('su-settle', 10);
    expect(mine.find((d) => d.summary === 'seen-pending')).toMatchObject({ status: 'delivered', channel: 'coalesced' });
    expect(mine.find((d) => d.summary === 'seen-parked')).toMatchObject({ status: 'delivered', channel: 'coalesced' });
    expect(mine.find((d) => d.summary === 'post-cutoff')).toMatchObject({ status: 'pending' });

    const peer = await store.listRecentDeliveries('su-settle-peer', 10);
    expect(peer.find((d) => d.summary === 'peer-untouched')).toMatchObject({ status: 'pending' });

    // Idempotence: re-settling the same (now-empty) window finds nothing left to do.
    expect(await store.settleCaughtUpInboxWakeDeliveries({ subscriberId: 'su-settle', cutoffTs })).toBe(0);
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

  it('gives an in-window event fire precedence over a one-shot timeout (real PG)', async () => {
    const eventKey = 'timeout-race:event-wins';
    const awaited = await store.registerAwait({
      subscriberId: 'su-timeout-race-event',
      eventKey,
      timeoutBehavior: 'wake',
      timeoutSec: 0,
      once: true,
    });
    const sql = h.sql as import('postgres').Sql;

    // Use the real latch writer, then place the await deadline just after the
    // recorded fire so the row is already due while the fire remains in its
    // [created_at, expires_ts] window.
    await store.recordKeyFire({ eventKey, firedBy: 'integration-test' });
    const [fire] = await sql<{ last_fired_at: string }[]>`
      SELECT last_fired_at
        FROM harness_shared.event_key_fires
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND event_key = ${eventKey}
    `;
    expect(fire).toBeDefined();
    await sql`
      UPDATE harness_shared.event_awaits
         SET created_at = ${fire.last_fired_at}::timestamptz - interval '1 second',
             expires_ts = ${fire.last_fired_at}::timestamptz + interval '1 millisecond'
       WHERE id = ${awaited.id}
    `;
    await new Promise((r) => setTimeout(r, 20));

    const timedOut = await store.fireTimedOutAwaits();

    expect(timedOut.some((a) => a.id === awaited.id)).toBe(false);
    const [state] = await sql<{ fired_at: string | null; fired_reason: string | null }[]>`
      SELECT fired_at, fired_reason
        FROM harness_shared.event_awaits
       WHERE id = ${awaited.id}
    `;
    expect(state).toEqual({ fired_at: null, fired_reason: null });
  });

  it('does not timeout standing watches in the wake-timeout sweep', async () => {
    const awaited = await store.registerAwait({
      subscriberId: 'su-standing-timeout',
      eventKey: 'timeout-race:standing',
      timeoutBehavior: 'wake',
      timeoutSec: 0,
      once: false,
    });
    await new Promise((r) => setTimeout(r, 20));

    const timedOut = await store.fireTimedOutAwaits();

    expect(timedOut.some((a) => a.id === awaited.id)).toBe(false);
    expect((await store.listActiveAwaits('su-standing-timeout')).map((a) => a.id)).toEqual([awaited.id]);
  });

  it('the wake meter aggregates per subscriber/status/channel', async () => {
    const meter = await store.wakeMeter({ sinceHours: 24 });
    expect(meter.length).toBeGreaterThan(0);
    const delivered = meter.find((m) => m.subscriberId === 'su-6' && m.status === 'delivered');
    expect(delivered).toMatchObject({ channel: 'plan-run-resume', count: 1 });
  });

  it('is single-workspace by construction: no caller can scope a row to a different namespace (WI-3575, formerly the live WI-40 regression)', async () => {
    // Originally this test proved that a `workspaceId: '*'` registration and a
    // `workspaceId: 'some-active-workspace'` emit still landed in the same coord
    // namespace (an unscoped SU shell vs. a system source emitting under the
    // active workspace). WI-3575 found the store never actually branched on the
    // input at all — every exported function silently pinned DEFAULT_COORD_WORKSPACE
    // regardless, so the two-different-workspaceIds scenario the test wrote wasn't
    // exercising isolation, it just proved the ignoring was self-consistent. The
    // dead parameter was removed everywhere (rather than "honored", which would
    // resurrect the exact cross-workspace-mismatch bug this design fixed) — so the
    // scenario is now a type error, not a runtime normalization. Assert the
    // invariant that survives: registerAwait/fireAwaitsForKey take no workspaceId
    // input at all and always land under the one coord workspace.
    await store.registerAwait({ subscriberId: 'su-13', eventKey: 'ws:k' });
    const fired = await store.fireAwaitsForKey({ eventKey: 'ws:k' });
    expect(fired).toHaveLength(1);
    expect(fired[0].subscriberId).toBe('su-13');
    expect(fired[0].workspaceId).toBe(DEFAULT_COORD_WORKSPACE);
  });

  // ── unify-watch-primitive: cardinality + floor + coalesce (P-005/P-007) ──

  it('fair grant-to-next: a targeted key fires ONLY its one waiter, never a broadcast (P-008/D-005)', async () => {
    // The lock-grant-bridge pattern: a freed lock grants ONE next waiter and emits that
    // waiter's targeted `lock:grant:<ticket>` key. Two waiters on two distinct tickets must
    // not thunder-herd — firing ticket A wakes only A's watch, leaving B's armed.
    await store.registerAwait({ subscriberId: 'su-waiterA', eventKey: 'lock:grant:ticketA' });
    await store.registerAwait({ subscriberId: 'su-waiterB', eventKey: 'lock:grant:ticketB' });
    const firedA = await store.fireAwaitsForKey({ eventKey: 'lock:grant:ticketA' });
    expect(firedA.map((a) => a.subscriberId)).toEqual(['su-waiterA']);
    // B is untouched — still active, not woken.
    expect((await store.listActiveAwaits('su-waiterB')).map((a) => a.eventKey)).toEqual(['lock:grant:ticketB']);
  });

  it('standing watches (once:false) fire on EVERY emit; a one-shot peer fires once (cardinality, D-001)', async () => {
    await store.registerAwait({ subscriberId: 'su-standing', eventKey: 'card:k', once: false, minSleepSec: 30 });
    await store.registerAwait({ subscriberId: 'su-oneshot', eventKey: 'card:k', once: true });
    const first = await store.fireAwaitsForKey({ eventKey: 'card:k' });
    expect(first.map((a) => a.subscriberId).sort()).toEqual(['su-oneshot', 'su-standing']);
    // Subsequent emits: the standing watch keeps firing; the one-shot is consumed.
    const second = await store.fireAwaitsForKey({ eventKey: 'card:k' });
    expect(second.map((a) => a.subscriberId)).toEqual(['su-standing']);
    const third = await store.fireAwaitsForKey({ eventKey: 'card:k' });
    expect(third.map((a) => a.subscriberId)).toEqual(['su-standing']);
    expect(third[0].once).toBe(false);
    expect(third[0].minSleepSec).toBe(30);
  });

  it('floor inputs round-trip; the watch-level urgency OR’s onto its deliveries (P-005)', async () => {
    const a = await store.registerAwait({
      subscriberId: 'su-floor',
      eventKey: 'floor:k',
      once: false,
      minSleepSec: 45,
      urgency: true,
    });
    expect(a.minSleepSec).toBe(45);
    expect(a.urgency).toBe(true);
    const fired = await store.fireAwaitsForKey({ eventKey: 'floor:k' });
    // emit-time urgent=false, but the watch is always-urgent → delivery urgent=true.
    await store.insertDeliveries({ awaits: fired, urgent: false });
    const [w] = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-floor');
    expect(w.urgent).toBe(true);
    expect(w.minSleepSec).toBe(45);
  });

  it('coalesced siblings settle as a no-turn delivery; last_woken counts only turn-burning channels (P-005)', async () => {
    await store.registerAwait({ subscriberId: 'su-coal', eventKey: 'coal:k', once: false });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'coal:k' }) });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'coal:k' }) });
    const work = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-coal');
    expect(work.length).toBe(2);
    const [headline, sibling] = work;
    await store.markDeliveryDelivered(headline.id, 'resume', 2);
    await store.markDeliveriesCoalesced([sibling.id], headline.id);
    const recent = await store.listRecentDeliveries('su-coal');
    expect(recent.find((d) => d.id === sibling.id)).toMatchObject({ status: 'delivered', channel: 'coalesced' });
    expect(recent.find((d) => d.id === headline.id)).toMatchObject({ coalescedCount: 2 });
    // The headline 'resume' is a real wake; it sets last_woken.
    expect((await store.lastWokenAtForSubscribers(['su-coal'])).get('su-coal')).toBeGreaterThan(0);

    // A subscriber whose ONLY delivery is coalesced has NO last wake (no turn spent).
    await store.registerAwait({ subscriberId: 'su-coalonly', eventKey: 'coalonly:k' });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'coalonly:k' }) });
    const [only] = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-coalonly');
    await store.markDeliveriesCoalesced([only.id], 999);
    expect((await store.lastWokenAtForSubscribers(['su-coalonly'])).has('su-coalonly')).toBe(false);
  });

  // ── turn-lifecycle-control: always-arm inbox-wake (D-002/D-003, P-002) ──

  it('upsertInboxWakeAwait is idempotent: re-arming refreshes ONE standing row, never duplicates', async () => {
    const key = 'coord:inbox-wake:su-arm-1';
    const first = await store.upsertInboxWakeAwait({
      subscriberId: 'su-arm-1',
      eventKey: key,
      note: 'first',
      wakeHandle: { kind: 'adv-session', advSessionId: 7, agent: 'claude', sessionId: 'sid-1', ompThreadId: null, cwd: '/r', pid: 10 },
      minSleepSec: 60,
    });
    const second = await store.upsertInboxWakeAwait({
      subscriberId: 'su-arm-1',
      eventKey: key,
      note: 'second',
      wakeHandle: null, // re-arm without a fresh handle
      minSleepSec: 30,
    });
    // Same row, refreshed in place.
    expect(second.id).toBe(first.id);
    expect(second.note).toBe('second');
    expect(second.minSleepSec).toBe(30);
    // A null handle on re-arm KEEPS the previously-captured handle (COALESCE).
    expect(second.wakeHandle).toMatchObject({ kind: 'adv-session', advSessionId: 7 });
    // Exactly one active standing inbox-wake await for this agent.
    expect((await store.listActiveAwaits('su-arm-1')).filter((a) => a.eventKey === key)).toHaveLength(1);
  });

  it('cancelInboxWakeAwaits cancels the standing watch; a later arm starts a fresh row', async () => {
    const key = 'coord:inbox-wake:su-arm-2';
    const armed = await store.upsertInboxWakeAwait({ subscriberId: 'su-arm-2', eventKey: key, note: 'armed' });
    expect(await store.cancelInboxWakeAwaits('su-arm-2')).toBe(1);
    expect((await store.listActiveAwaits('su-arm-2')).filter((a) => a.eventKey === key)).toHaveLength(0);
    // Re-arming after cancel creates a NEW active row (the unique index frees on cancel).
    const rearmed = await store.upsertInboxWakeAwait({ subscriberId: 'su-arm-2', eventKey: key, note: 're' });
    expect(rearmed.id).not.toBe(armed.id);
    expect((await store.listActiveAwaits('su-arm-2')).filter((a) => a.eventKey === key)).toHaveLength(1);
    // A second cancel once nothing is active returns 0.
    expect(await store.cancelInboxWakeAwaits('su-arm-2')).toBe(1); // cancels the re-armed row
    expect(await store.cancelInboxWakeAwaits('su-arm-2')).toBe(0);
  });

  it('the unique index is scoped to inbox-wake keys: OTHER standing watches still allow duplicates', async () => {
    // A non-inbox-wake standing watch is NOT constrained by the partial index,
    // so two identical registrations coexist (unchanged behavior for pot/watch).
    await store.registerAwait({ subscriberId: 'su-arm-3', eventKey: 'pot:wake:x', once: false });
    await store.registerAwait({ subscriberId: 'su-arm-3', eventKey: 'pot:wake:x', once: false });
    expect((await store.listActiveAwaits('su-arm-3')).filter((a) => a.eventKey === 'pot:wake:x')).toHaveLength(2);
  });

  it('always-arm round-trip: an armed inbox-wake watch FIRES on a wake emit and stays armed (P-002/D-002)', async () => {
    // The end-to-end always-arm claim, against real PG with the migration-183
    // index: upsertInboxWakeAwait makes an agent wakeable, a wake emit to its
    // inbox-wake key fires the standing watch and yields a claimable delivery
    // carrying the captured handle, and (once:false) the watch survives the wake
    // so the agent stays armed across idle→woken→idle — the whole point of D-002.
    const key = 'coord:inbox-wake:su-rt';
    const armed = await store.upsertInboxWakeAwait({
      subscriberId: 'su-rt',
      eventKey: key,
      note: 'idle — armed at SessionStart',
      wakeHandle: {
        kind: 'adv-session',
        advSessionId: 11,
        agent: 'claude',
        sessionId: 'sid-rt',
        ompThreadId: null,
        cwd: '/r',
        pid: 20,
      },
      minSleepSec: 0,
    });

    // A wake emit to the agent's key fires its armed standing watch (woken ≥ 1).
    const fired = await store.fireAwaitsForKey({ eventKey: key });
    expect(fired.map((a) => a.subscriberId)).toEqual(['su-rt']);
    expect(fired[0].id).toBe(armed.id);

    // …and produces a real, claimable delivery carrying the captured wake handle.
    await store.insertDeliveries({ awaits: fired });
    const work = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-rt');
    expect(work).toHaveLength(1);
    expect(work[0].wakeHandle).toMatchObject({ kind: 'adv-session', advSessionId: 11 });

    // once:false → still armed after the wake (idle→woken→idle stays wakeable).
    const again = await store.fireAwaitsForKey({ eventKey: key });
    expect(again.map((a) => a.subscriberId)).toEqual(['su-rt']);
    expect((await store.listActiveAwaits('su-rt')).filter((a) => a.eventKey === key)).toHaveLength(1);
  });

  it('unguarded-halt rescue skips one-shot inbox waits but keeps the standing keepalive and ordinary wakes intact', async () => {
    const key = 'coord:inbox-wake:su-rescue-filter';
    const oneShot = await store.registerAwait({
      subscriberId: 'su-rescue-one-shot',
      eventKey: key,
      once: true,
    });
    await store.upsertInboxWakeAwait({
      subscriberId: 'su-rescue-standing',
      eventKey: key,
    });

    // The synthetic rescue is not a directed message: it must leave the
    // message-only one-shot armed, while the standing keepalive remains the
    // path that can actually wake the halted session.
    const rescued = await store.fireAwaitsForKey({
      eventKey: key,
      source: 'unguarded-halt-rescue',
    });
    expect(rescued.map((row) => row.subscriberId).sort()).toEqual(['su-rescue-standing']);
    expect((await store.listActiveAwaits('su-rescue-one-shot')).map((row) => row.id)).toEqual([oneShot.id]);

    // A real directed wake on the same key still consumes the one-shot row.
    const directed = await store.fireAwaitsForKey({
      eventKey: key,
      source: 'coord:send',
    });
    expect(directed.map((row) => row.subscriberId).sort()).toEqual([
      'su-rescue-one-shot',
      'su-rescue-standing',
    ]);
    expect(await store.listActiveAwaits('su-rescue-one-shot')).toEqual([]);
  });

  it('rescue source does not suppress one-shot awaits on ordinary event keys', async () => {
    const awaited = await store.registerAwait({
      subscriberId: 'su-rescue-ordinary-key',
      eventKey: 'ordinary:rescue-key',
      once: true,
    });

    const fired = await store.fireAwaitsForKey({
      eventKey: awaited.eventKey,
      source: 'unguarded-halt-rescue',
    });

    expect(fired.map((row) => row.id)).toEqual([awaited.id]);
    expect(await store.listActiveAwaits('su-rescue-ordinary-key')).toEqual([]);
  });
});
