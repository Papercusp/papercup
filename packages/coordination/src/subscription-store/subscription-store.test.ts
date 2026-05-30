/**
 * subscription-store.test.ts — run the shared SubscriptionStore conformance
 * suite against the in-memory double (the package-level P-050 proof). The PG
 * impl is proven by the operator's live-PG integration test, mirroring
 * presence + event-log + watermark-store.
 */

import { describeSubscriptionStoreConformance } from './conformance';
import { InMemorySubscriptionStore } from './memory-store';

describeSubscriptionStoreConformance('InMemorySubscriptionStore', () => new InMemorySubscriptionStore());
