/**
 * two-plane-coordination.test.ts — the load-bearing invariants of the Hive
 * coordination model (hive-coordination-model-2026-06-08 P-003, D-001/D-003).
 *
 * The model has TWO planes:
 *   • HORIZONTAL — agents coordinate DIRECTLY over the coord substrate
 *     (coord:send / topics / conversations). The Queen (the pot operator) is
 *     NEVER on the agent-to-agent path; agent chatter through the Queen is a bug.
 *   • VERTICAL — the Queen STEERS on summaries (curation feed / priorities); she
 *     does not route individual messages.
 *
 * This suite asserts the two properties that make the horizontal plane scale
 * WITHOUT the Queen:
 *   1. a directed peer→peer message reaches its addressee and NO ONE else —
 *      in particular not the Queen (operator/pot), who is never an implicit hop;
 *   2. coordination is INTEREST-ROUTED, not broadcast — a topic notify only ever
 *      touches that topic's subscribers (per-agent load is O(its topics)), and
 *      each subscriber's delivery_mode caps its own volume.
 *
 * It is a pure in-memory test (InMemoryCoordLog + in-memory subscription store +
 * a fake inject sink) — no PG, no operator, no network. The CROSS-SWARM and
 * CROSS-HIVE transport legs of the model are exercised by the federation suite,
 * NOT duplicated here:
 *   • within-/cross-Swarm: sync/hyperbee/__tests__/coord-message-federation.integration.test.ts
 *     + hive-two-peer-federation.test.ts (two Swarms of one Hive over the Hive
 *     pubkey topic, real Hyperswarm).
 *   • cross-Hive mediated ask→answer: designed in shared-hive-federation-2026-06-08
 *     (boundary admission + capability grants); the literal cross-machine/cross-Hive
 *     run is owner-gated (cloud budget) — see this plan's status note.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import {
  InMemoryEntitySubscriptionStore,
  type ResolvedSubscriber,
} from '@papercusp/coordination/capabilities';
import { configureCoordLog, resetCoordLog } from '../log';
import { readInbox, sendMessage } from '../messages';
import { deliverInject, type InjectEvent, type InjectSink } from '../fanout-delivery';
import type { AgentIdentity } from '../identity';

function fakeIdentity(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId: 'default', userId: null };
}

const TS = '2026-06-08T00:00:00.000Z';

describe('Horizontal plane — agents coordinate directly; the Queen is never in the peer path', () => {
  beforeEach(() => configureCoordLog(new InMemoryCoordLog()));
  afterEach(() => resetCoordLog());

  it('a directed peer→peer message reaches its addressee and NO ONE else (not the Queen)', async () => {
    const beeA = fakeIdentity('bee-A');
    await sendMessage(beeA, { to: ['bee-B'], summary: 'need your read on the auth change' });

    // The addressee gets it — directly, by reading its OWN inbox (a log filter by
    // recipient), with no operator/pot mediating the delivery.
    expect((await readInbox('bee-B')).map((m) => m.summary)).toEqual([
      'need your read on the auth change',
    ]);

    // The Queen is never an implicit hop: whatever identity the pot operator runs
    // under, a peer→peer message addressed to bee-B does not land in its inbox.
    for (const queenId of ['operator', 'queen', 'pot']) {
      expect(await readInbox(queenId)).toEqual([]);
    }
    // And the sender doesn't see its own message (excludeOwn default).
    expect(await readInbox('bee-A')).toEqual([]);
  });

  it('a hand-off between two bees stays between them — the Queen is not copied', async () => {
    const beeA = fakeIdentity('bee-A');
    const beeB = fakeIdentity('bee-B');
    await sendMessage(beeA, { to: ['bee-B'], summary: 'taking the validator slice, you keep the scoper' });
    await sendMessage(beeB, { to: ['bee-A'], summary: 'ack — go' });

    expect(await readInbox('bee-B')).toHaveLength(1);
    expect(await readInbox('bee-A')).toHaveLength(1);
    expect(await readInbox('operator')).toEqual([]); // the Queen saw none of it
  });
});

describe('Interest-routing bounds per-agent load (coordination is not broadcast)', () => {
  function makeSink(): { sink: InjectSink; rows: { writerKey: string; env: CoordEnvelope }[] } {
    const rows: { writerKey: string; env: CoordEnvelope }[] = [];
    return { rows, sink: { async appendLine(_s, writerKey, env) { rows.push({ writerKey, env }); } } };
  }
  const resolve = (r: { subscriber_id: string; delivery_mode: 'full' | 'digest' | 'mention' }): ResolvedSubscriber => ({
    subscriber_id: r.subscriber_id,
    delivery_mode: r.delivery_mode,
    via: 'object',
  });

  it('a topic notify only ever touches that topic\'s subscribers — not the whole fleet', async () => {
    const subs = new InMemoryEntitySubscriptionStore();
    const TOPIC = 'auth-refactor';
    // Two agents declare interest; bee-uninterested does NOT — so it carries ZERO load.
    await subs.subscribe({ subscriber_id: 'bee-full', target_kind: 'topic', target_ref: TOPIC, delivery_mode: 'full', created_ts: TS });
    await subs.subscribe({ subscriber_id: 'bee-mention', target_kind: 'topic', target_ref: TOPIC, delivery_mode: 'mention', created_ts: TS });

    // The fan-out set is exactly the subscribers — O(subscribers), not O(all agents).
    const audience = await subs.listTargetSubscribers('topic', TOPIC);
    expect(audience.map((s) => s.subscriber_id).sort()).toEqual(['bee-full', 'bee-mention']);
    expect(audience.map((s) => s.subscriber_id)).not.toContain('bee-uninterested');

    const { sink, rows } = makeSink();
    const ev: InjectEvent = { from: 'bee-X', subject: `topic:${TOPIC}`, summary: 'pushed an auth fix', notify_kind: 'topic_post' };
    for (const s of audience) await deliverInject(resolve(s), ev, sink);

    const delivered = rows.map((r) => r.writerKey);
    // bee-full wants everything → delivered. bee-mention capped itself to @-mentions
    // → this non-mention post is gated out. bee-uninterested never even entered the set.
    expect(delivered).toEqual(['bee-full']);
  });

  it('a subscriber on mention-mode still gets @-mentions and resolutions (its own volume dial)', async () => {
    const { sink, rows } = makeSink();
    const mention = resolve({ subscriber_id: 'bee-mention', delivery_mode: 'mention' });
    const base: InjectEvent = { from: 'bee-X', subject: 'topic:auth-refactor', summary: 's', notify_kind: 'topic_post' };

    expect(await deliverInject(mention, base, sink)).toBe(false); // plain post: gated
    expect(await deliverInject(mention, { ...base, mentions: ['bee-mention'] }, sink)).toBe(true); // @-mention: through
    expect(await deliverInject(mention, { ...base, isResolution: true }, sink)).toBe(true); // resolution: through
    expect(rows).toHaveLength(2);
  });
});
