/**
 * event-subscriptions.test.ts — standing EVENT-KEY inject subscriptions (WI-4014
 * Part 2). Driven against a REAL InMemoryEntitySubscriptionStore (no PG) swapped
 * in for the workspace-resolving getCoordSubscriptionStore() singleton, so the
 * subscribe/unsubscribe/list roundtrip is exercised for real — mirrors
 * topics-core.test.ts's use of the same in-memory capability double.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEntitySubscriptionStore } from '@papercusp/coordination/capabilities';

const store = new InMemoryEntitySubscriptionStore();
vi.mock('./subscription-store', () => ({ getCoordSubscriptionStore: () => store }));

import {
  EVENT_SUBSCRIPTION_KIND,
  subscribeEventKey,
  unsubscribeEventKey,
  listMyEventKeySubscriptions,
  listEventKeySubscribers,
} from './event-subscriptions';
import type { AgentIdentity } from './identity';

function identity(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: 'ws-x', userId: null } as AgentIdentity;
}

beforeEach(async () => {
  // InMemoryEntitySubscriptionStore has no reset — unsubscribe every row we know
  // about between tests via a fresh identity per test instead (cheap + hermetic
  // enough for this store's row-scan semantics).
});

describe('EVENT_SUBSCRIPTION_KIND', () => {
  it('is the literal "event" — the migration-568 target_kind', () => {
    expect(EVENT_SUBSCRIPTION_KIND).toBe('event');
  });
});

describe('subscribeEventKey / listEventKeySubscribers roundtrip', () => {
  it('subscribing registers a target_kind:"event" row visible to listEventKeySubscribers', async () => {
    const row = await subscribeEventKey(identity('alice-1'), 'lock:grant:t1');
    expect(row.target_kind).toBe('event');
    expect(row.target_ref).toBe('lock:grant:t1');
    expect(row.delivery_mode).toBe('full'); // default mode

    const subs = await listEventKeySubscribers('lock:grant:t1');
    expect(subs.map((s) => s.subscriber_id)).toContain('alice-1');
  });

  it('honors an explicit mode + ttl_sec (expires_ts computed)', async () => {
    const before = Date.now();
    const row = await subscribeEventKey(identity('bob-1'), 'plan-run:finished:p1', { mode: 'digest', ttl_sec: 60 });
    expect(row.delivery_mode).toBe('digest');
    expect(row.expires_ts).not.toBeNull();
    expect(new Date(row.expires_ts as string).getTime()).toBeGreaterThanOrEqual(before + 59_000);
  });

  it('re-subscribing the SAME (subscriber, key) updates mode/ttl idempotently (no duplicate row)', async () => {
    await subscribeEventKey(identity('carol-1'), 'k-idem', { mode: 'full' });
    await subscribeEventKey(identity('carol-1'), 'k-idem', { mode: 'mention' });
    const subs = await listEventKeySubscribers('k-idem');
    const mine = subs.filter((s) => s.subscriber_id === 'carol-1');
    expect(mine).toHaveLength(1);
    expect(mine[0].delivery_mode).toBe('mention');
  });

  it('listEventKeySubscribers never returns a topic-kind subscriber to the same target_ref', async () => {
    // Cross-kind isolation: subscribing to a TOPIC of the same name must not leak
    // into the event-key subscriber list (different target_kind, same store).
    await store.subscribe({ subscriber_id: 'dana-1', target_kind: 'topic', target_ref: 'shared-name', delivery_mode: 'full', created_ts: new Date().toISOString(), expires_ts: null });
    await subscribeEventKey(identity('erin-1'), 'shared-name');
    const subs = await listEventKeySubscribers('shared-name');
    expect(subs.map((s) => s.subscriber_id)).toEqual(['erin-1']);
  });
});

describe('unsubscribeEventKey', () => {
  it('removes the subscriber from listEventKeySubscribers', async () => {
    await subscribeEventKey(identity('frank-1'), 'k-unsub');
    expect((await listEventKeySubscribers('k-unsub')).map((s) => s.subscriber_id)).toContain('frank-1');

    await unsubscribeEventKey(identity('frank-1'), 'k-unsub');
    expect((await listEventKeySubscribers('k-unsub')).map((s) => s.subscriber_id)).not.toContain('frank-1');
  });

  it('is idempotent — unsubscribing a key never followed is a no-op, not an error', async () => {
    await expect(unsubscribeEventKey(identity('grace-1'), 'never-followed-key')).resolves.toBeUndefined();
  });
});

describe('listMyEventKeySubscriptions', () => {
  it('returns only the caller\'s event-kind subscriptions, excluding topic-kind ones', async () => {
    const id = identity('henry-1');
    await subscribeEventKey(id, 'ev-a');
    await subscribeEventKey(id, 'ev-b');
    await store.subscribe({ subscriber_id: 'henry-1', target_kind: 'topic', target_ref: 'some-topic', delivery_mode: 'full', created_ts: new Date().toISOString(), expires_ts: null });

    const mine = await listMyEventKeySubscriptions(id);
    expect(mine.every((s) => s.target_kind === 'event')).toBe(true);
    expect(mine.map((s) => s.target_ref).sort()).toEqual(['ev-a', 'ev-b']);
  });
});
