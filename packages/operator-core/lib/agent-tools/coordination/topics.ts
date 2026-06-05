/**
 * topics.ts — the PG-wired topics surface the topics:* tools call. Constructs
 * the capability stores over the org embedded-pg handle (mirroring
 * subscriptions.ts), and binds the pure topics-core workflow to coordLog +
 * getOrgPg. Topics are workspace-local in v1 (not federated — D-009).
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  PgEntitySubscriptionStore,
  PgTopicStore,
  type DeliveryMode,
  type SubscriptionRow,
  type TopicRow,
} from '@papercusp/coordination/capabilities';
import { coordLog } from './log';
import type { AgentIdentity } from './identity';
import {
  type CreateTopicResult,
  type MergeTopicsResult,
  type TopicsStores,
  createTopicCore,
  ensureBuiltinTopics,
  mergeTopicsCore,
  NEW_TOPIC,
} from './topics-core';

const storeOpts = {
  getSql: () => getOrgPg().sql,
  // Schema is defined by migration 123; the host seam is a no-op.
  ensureSchema: async () => {},
};
const topicStore = new PgTopicStore(storeOpts);
const subStore = new PgEntitySubscriptionStore(storeOpts);
const stores: TopicsStores = { topics: topicStore, subscriptions: subStore };

export { NEW_TOPIC };

function nowIso(): string {
  return new Date().toISOString();
}

export async function listTopics(opts: { includeMerged?: boolean } = {}): Promise<TopicRow[]> {
  await ensureBuiltinTopics(stores, nowIso());
  return topicStore.list(opts);
}

export async function createTopic(
  identity: AgentIdentity,
  input: { slug: string; title?: string; description: string },
): Promise<CreateTopicResult> {
  return createTopicCore(stores, coordLog, {
    slug: input.slug,
    title: input.title,
    description: input.description,
    created_by: identity.ownerId,
    nowIso: nowIso(),
  });
}

export async function subscribeTopic(
  identity: AgentIdentity,
  slug: string,
  opts: { mode?: DeliveryMode; ttl_sec?: number } = {},
): Promise<SubscriptionRow> {
  await ensureBuiltinTopics(stores, nowIso());
  const expires_ts = opts.ttl_sec != null ? new Date(Date.now() + opts.ttl_sec * 1000).toISOString() : null;
  return subStore.subscribe({
    subscriber_id: identity.ownerId,
    target_kind: 'topic',
    target_ref: slug,
    delivery_mode: opts.mode ?? 'full',
    created_ts: nowIso(),
    expires_ts,
  });
}

export async function unsubscribeTopic(identity: AgentIdentity, slug: string): Promise<void> {
  await subStore.unsubscribe(identity.ownerId, 'topic', slug);
}

export async function mergeTopics(
  _identity: AgentIdentity,
  from: string,
  into: string,
): Promise<MergeTopicsResult> {
  return mergeTopicsCore(stores, { from, into, nowIso: nowIso() });
}

/** A subscriber's own active topic subscriptions (for topics:list rendering). */
export async function listMyTopicSubscriptions(identity: AgentIdentity): Promise<SubscriptionRow[]> {
  const all = await subStore.listSubscriptions(identity.ownerId);
  return all.filter((s) => s.target_kind === 'topic');
}
