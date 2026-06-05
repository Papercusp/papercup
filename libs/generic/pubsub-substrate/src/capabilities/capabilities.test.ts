/**
 * capabilities.test.ts — runs the pub/sub capability conformance suites against
 * the in-memory doubles (the swappability proof; the Pg* stores run the SAME
 * suites in the operator's live-PG integration test via @papercusp/coordination).
 * Plus the resolveObjectSubscribers fan-out over the in-memory trio — which pulls
 * the Taggable/Linkable doubles from @papercusp/linkable-edges (the typed-entity
 * graph this slice depends on).
 */

import { InMemoryLinkStore, InMemoryTaggableStore } from '@papercusp/linkable-edges';
import {
  describeResolveObjectSubscribers,
  describeSubscribableStoreConformance,
  describeThreadableStoreConformance,
  describeTopicStoreConformance,
} from './conformance';
import {
  InMemoryEntitySubscriptionStore,
  InMemoryThreadStore,
  InMemoryTopicStore,
} from './memory-stores';

describeTopicStoreConformance('InMemoryTopicStore', () => new InMemoryTopicStore());
describeSubscribableStoreConformance('InMemoryEntitySubscriptionStore', () => new InMemoryEntitySubscriptionStore());
describeThreadableStoreConformance('InMemoryThreadStore', () => new InMemoryThreadStore());

describeResolveObjectSubscribers('in-memory trio', () => {
  const links = new InMemoryLinkStore();
  return {
    subscriptions: new InMemoryEntitySubscriptionStore(),
    tags: new InMemoryTaggableStore(links),
    topics: new InMemoryTopicStore(),
  };
});
