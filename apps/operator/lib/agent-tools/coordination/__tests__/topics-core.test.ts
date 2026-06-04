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
