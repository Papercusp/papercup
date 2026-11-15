/**
 * capabilities.test.ts — runs every capability conformance suite against the
 * in-memory doubles (the swappability proof; the Pg* stores run the SAME suites
 * in the operator's live-PG integration test). Plus the resolveObjectSubscribers
 * fan-out core over the in-memory trio.
 */

import { expect, it } from 'vitest';
import {
  isResolvedSubscriberLive as substrateIsResolvedSubscriberLive,
  resolvedSubscriberTarget as substrateResolvedSubscriberTarget,
} from '@papercusp/pubsub-substrate/capabilities';
import {
  isResolvedSubscriberLive,
  resolvedSubscriberTarget,
} from '@papercusp/coordination/capabilities';
import {
  describeLinkableStoreConformance,
  describeResolveObjectSubscribers,
  describeSubscribableStoreConformance,
  describeThreadableStoreConformance,
  describeTopicStoreConformance,
} from './conformance';
import {
  InMemoryEntitySubscriptionStore,
  InMemoryLinkStore,
  InMemoryTaggableStore,
  InMemoryThreadStore,
  InMemoryTopicStore,
} from './memory-stores';

it('exposes delivery-time subscription helpers through the public capabilities entrypoint', () => {
  expect(resolvedSubscriberTarget).toBe(substrateResolvedSubscriberTarget);
  expect(isResolvedSubscriberLive).toBe(substrateIsResolvedSubscriberLive);
});

describeTopicStoreConformance('InMemoryTopicStore', () => new InMemoryTopicStore());
describeSubscribableStoreConformance('InMemoryEntitySubscriptionStore', () => new InMemoryEntitySubscriptionStore());
describeLinkableStoreConformance('InMemoryLinkStore', () => new InMemoryLinkStore());
describeThreadableStoreConformance('InMemoryThreadStore', () => new InMemoryThreadStore());

describeResolveObjectSubscribers('in-memory trio', () => {
  const links = new InMemoryLinkStore();
  return {
    subscriptions: new InMemoryEntitySubscriptionStore(),
    tags: new InMemoryTaggableStore(links),
    topics: new InMemoryTopicStore(),
  };
});
