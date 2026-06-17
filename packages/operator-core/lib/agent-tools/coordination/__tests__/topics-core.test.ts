/**
 * topics-core.test.ts — the topic workflow + subscribe→inject delivery gating,
 * over the in-memory capability doubles + a fake inject sink (no PG).
 */

import { describe, expect, it } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import {
  InMemoryEntitySubscriptionStore,
  InMemoryTopicStore,
} from '@papercusp/coordination/capabilities';
import { createTopicCore, mergeTopicsCore, NEW_TOPIC, type TopicsStores } from '../topics-core';
import { deliverInject, shouldDeliver, type InjectSink, type InjectEvent } from '../fanout-delivery';

function makeSink(): { sink: InjectSink; rows: { writerKey: string; env: CoordEnvelope }[] } {
  const rows: { writerKey: string; env: CoordEnvelope }[] = [];
  return {
    rows,
    sink: {
      async appendLine(_surface, writerKey, env) {
        rows.push({ writerKey, env });
      },
    },
  };
}

function makeStores(): TopicsStores {
  return { topics: new InMemoryTopicStore(), subscriptions: new InMemoryEntitySubscriptionStore() };
}

const TS = '2026-06-04T00:00:00.000Z';

describe('createTopicCore — new_topic emission (D-004)', () => {
  it('notifies new_topic subscribers (not the creator) when a topic is genuinely new', async () => {
    const stores = makeStores();
    const { sink, rows } = makeSink();
    // Two followers of new_topic; one of them is also the creator.
    await stores.subscriptions.subscribe({ subscriber_id: 'watcher', target_kind: 'topic', target_ref: NEW_TOPIC, created_ts: TS });
    await stores.subscriptions.subscribe({ subscriber_id: 'creator', target_kind: 'topic', target_ref: NEW_TOPIC, created_ts: TS });

    const res = await createTopicCore(stores, sink, { slug: 'federation', description: 'cross-machine sync', created_by: 'creator', nowIso: TS });

    expect(res.created).toBe(true);
    expect(res.notified).toBe(1); // creator excluded
    expect(rows).toHaveLength(1);
    expect(rows[0].writerKey).toBe('watcher');
    expect(rows[0].env.kind).toBe('notify');
    expect(rows[0].env.notify_kind).toBe('topic_created');
    expect(rows[0].env.subject).toBe('topic:federation');
  });

  it('a re-create of an existing topic is a no-op (no notify)', async () => {
    const stores = makeStores();
    const { sink, rows } = makeSink();
    await stores.subscriptions.subscribe({ subscriber_id: 'watcher', target_kind: 'topic', target_ref: NEW_TOPIC, created_ts: TS });
    await createTopicCore(stores, sink, { slug: 'federation', description: 'first', created_by: 'a', nowIso: TS });
    rows.length = 0;
    const res = await createTopicCore(stores, sink, { slug: 'federation', description: 'second', created_by: 'b', nowIso: TS });
    expect(res.created).toBe(false);
    expect(rows).toHaveLength(0);
    // description is prefer-existing (unchanged).
    expect(res.topic.description).toBe('first');
  });

  it('creating the built-in new_topic itself does not broadcast', async () => {
    const stores = makeStores();
    const { sink, rows } = makeSink();
    await stores.subscriptions.subscribe({ subscriber_id: 'watcher', target_kind: 'topic', target_ref: NEW_TOPIC, created_ts: TS });
    const res = await createTopicCore(stores, sink, { slug: NEW_TOPIC, description: 'override', created_by: 'a', nowIso: TS });
    expect(res.created).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe('mergeTopicsCore', () => {
  it('aliases the slug and re-points the merged topic’s subscribers onto the target', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'fed', description: 'dup', created_ts: TS });
    await stores.topics.create({ slug: 'federation', description: 'canonical', created_ts: TS });
    await stores.subscriptions.subscribe({ subscriber_id: 'agentA', target_kind: 'topic', target_ref: 'fed', delivery_mode: 'digest', created_ts: TS });

    const res = await mergeTopicsCore(stores, { from: 'fed', into: 'federation', nowIso: TS });
    expect(res.moved).toBe(1);

    expect(await stores.topics.resolve('fed')).toBe('federation');
    // agentA now follows federation, not fed.
    expect(await stores.subscriptions.listTargetSubscribers('topic', 'fed')).toEqual([]);
    const onTarget = await stores.subscriptions.listTargetSubscribers('topic', 'federation');
    expect(onTarget.map((s) => s.subscriber_id)).toEqual(['agentA']);
    expect(onTarget[0].delivery_mode).toBe('digest'); // mode preserved
  });

  // P2-18a: a self-merge (from === into) is a no-op short-circuit — it must not
  // touch the alias graph or re-subscribe anyone (re-pointing a subscriber from
  // X onto X, then unsubscribing X, would orphan them).
  it('a self-merge is a no-op: {moved:0}, no alias, no subscription churn', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'x', description: 'solo', created_ts: TS });
    await stores.subscriptions.subscribe({ subscriber_id: 'agentA', target_kind: 'topic', target_ref: 'x', delivery_mode: 'digest', created_ts: TS });

    const res = await mergeTopicsCore(stores, { from: 'x', into: 'x', nowIso: TS });
    expect(res).toEqual({ moved: 0 });

    // No alias was written (x still resolves to itself), and agentA is untouched.
    expect(await stores.topics.resolve('x')).toBe('x');
    const onX = await stores.subscriptions.listTargetSubscribers('topic', 'x');
    expect(onX.map((s) => s.subscriber_id)).toEqual(['agentA']);
    expect(onX[0].delivery_mode).toBe('digest');
  });

  // P2-18b: a subscriber already on BOTH the old slug and the target must end
  // with ONE subscription on the target (the re-subscribe upserts, not
  // duplicates), preserving the digest mode — so the merged feed reaches them
  // exactly once, never twice.
  it('a subscriber on BOTH old + new ends with a single (deduped) subscription on the target', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'fed', description: 'dup', created_ts: TS });
    await stores.topics.create({ slug: 'federation', description: 'canonical', created_ts: TS });
    // agentA follows BOTH — fed in digest, federation already in digest too.
    await stores.subscriptions.subscribe({ subscriber_id: 'agentA', target_kind: 'topic', target_ref: 'fed', delivery_mode: 'digest', created_ts: TS });
    await stores.subscriptions.subscribe({ subscriber_id: 'agentA', target_kind: 'topic', target_ref: 'federation', delivery_mode: 'digest', created_ts: TS });

    const res = await mergeTopicsCore(stores, { from: 'fed', into: 'federation', nowIso: TS });
    expect(res.moved).toBe(1);

    // The old slug is drained; the target carries agentA exactly ONCE.
    expect(await stores.subscriptions.listTargetSubscribers('topic', 'fed')).toEqual([]);
    const onTarget = await stores.subscriptions.listTargetSubscribers('topic', 'federation');
    expect(onTarget.map((s) => s.subscriber_id)).toEqual(['agentA']); // not ['agentA','agentA']
    expect(onTarget[0].delivery_mode).toBe('digest'); // mode preserved
  });

  // T3 (pinned, not a bug): when a subscriber already follows the TARGET in a
  // DIFFERENT mode than the merged slug, the re-subscribe upserts — so the
  // FROM-side mode WINS (overwrites the target's existing mode). And `moved`
  // counts the re-point per FROM subscriber even though no NEW row was created
  // (the subscriber was already on the target). Pinned so a future change to the
  // collision policy (e.g. keep most-verbose, or don't double-count) is conscious.
  it('on a mode collision the from-side mode wins, and `moved` counts the already-on-target subscriber', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'fed', description: 'dup', created_ts: TS });
    await stores.topics.create({ slug: 'federation', description: 'canonical', created_ts: TS });
    // agentA follows fed in FULL but already follows federation in MENTION.
    await stores.subscriptions.subscribe({ subscriber_id: 'agentA', target_kind: 'topic', target_ref: 'fed', delivery_mode: 'full', created_ts: TS });
    await stores.subscriptions.subscribe({ subscriber_id: 'agentA', target_kind: 'topic', target_ref: 'federation', delivery_mode: 'mention', created_ts: TS });

    const res = await mergeTopicsCore(stores, { from: 'fed', into: 'federation', nowIso: TS });
    // Counts the move even though agentA was already on the target.
    expect(res.moved).toBe(1);

    const onTarget = await stores.subscriptions.listTargetSubscribers('topic', 'federation');
    expect(onTarget.map((s) => s.subscriber_id)).toEqual(['agentA']);
    // The from-side mode (full) overwrote the target's prior mention.
    expect(onTarget[0].delivery_mode).toBe('full');
  });

  // T2 (the chained-merge stranding bug): when `into` is ITSELF already merged
  // (into c), re-pointing the `from` subscribers onto `into` VERBATIM lands them
  // on a dead, list()-excluded slug. The fan-out
  // (resolveObjectSubscribers) keys delivery on the CANONICAL resolved tag slug,
  // never on a subscriber's raw target_ref — so a subscriber stranded on the
  // merged middle slug `b` is silently dropped from c's feed forever. The merge
  // must resolve `into` to its canonical head before re-pointing.
  it('re-points subscribers onto the CANONICAL head when `into` is itself already merged (no stranding)', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'a', description: 'a', created_ts: TS });
    await stores.topics.create({ slug: 'b', description: 'b', created_ts: TS });
    await stores.topics.create({ slug: 'c', description: 'c', created_ts: TS });
    // b is already merged into c.
    await mergeTopicsCore(stores, { from: 'b', into: 'c', nowIso: TS });
    // agentA follows a.
    await stores.subscriptions.subscribe({ subscriber_id: 'agentA', target_kind: 'topic', target_ref: 'a', delivery_mode: 'full', created_ts: TS });

    // Now merge a into b — but b is dead, so agentA must land on canonical c.
    const res = await mergeTopicsCore(stores, { from: 'a', into: 'b', nowIso: TS });
    expect(res.moved).toBe(1);

    // agentA ends on the live canonical c, NOT on the dead middle slug b.
    expect(await stores.subscriptions.listTargetSubscribers('topic', 'a')).toEqual([]);
    expect(await stores.subscriptions.listTargetSubscribers('topic', 'b')).toEqual([]); // not stranded here
    const onC = await stores.subscriptions.listTargetSubscribers('topic', 'c');
    expect(onC.map((s) => s.subscriber_id)).toEqual(['agentA']);
    expect(onC[0].delivery_mode).toBe('full'); // mode preserved

    // And c IS a live topic the subscriber can see (list excludes a and b).
    const live = (await stores.topics.list()).map((t) => t.slug);
    expect(live).toContain('c');
    expect(live).not.toContain('a');
    expect(live).not.toContain('b');
  });
});

describe('delivery-mode gating (D-006)', () => {
  const baseEv: InjectEvent = { from: 'x', subject: 'issue:ISS-1', summary: 's', notify_kind: 'issue_updated' };

  it('full + digest always pass; mention drops a non-mention non-resolution event', () => {
    expect(shouldDeliver('full', baseEv, 'me')).toBe(true);
    expect(shouldDeliver('digest', baseEv, 'me')).toBe(true);
    expect(shouldDeliver('mention', baseEv, 'me')).toBe(false);
  });

  it('mention passes when @-addressed or on resolution', () => {
    expect(shouldDeliver('mention', { ...baseEv, mentions: ['me'] }, 'me')).toBe(true);
    expect(shouldDeliver('mention', { ...baseEv, isResolution: true }, 'me')).toBe(true);
  });

  it('deliverInject flags digest rows and skips gated-out mention rows', async () => {
    const { sink, rows } = makeSink();
    const wrote = await deliverInject({ subscriber_id: 'me', delivery_mode: 'digest', via: 'object' }, baseEv, sink);
    expect(wrote).toBe(true);
    expect(rows[0].env.digest).toBe(true);

    const dropped = await deliverInject({ subscriber_id: 'me', delivery_mode: 'mention', via: 'object' }, baseEv, sink);
    expect(dropped).toBe(false);
    expect(rows).toHaveLength(1);
  });
});
