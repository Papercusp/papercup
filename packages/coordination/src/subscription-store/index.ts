/**
 * @papercusp/coordination/subscription-store — the watch/subscription seam
 * (PG by default, in-memory double). Under PG a watch is a mutable row
 * (insert on watch, cancelled_at on unwatch, expiry as a WHERE filter) — its
 * own seam, not the append-only CoordEventLog (D-009, coord-channels-pg-port
 * Q-2). The pure glob matcher stays in `@papercusp/coordination/core`.
 */

export type {
  SubscriptionStore,
  SubscriptionRecord,
  AddSubscriptionInput,
} from './types';
export { InMemorySubscriptionStore } from './memory-store';
export {
  PgSubscriptionStore,
  ensureCoordSubscriptionsTable,
  type PgSubscriptionStoreOptions,
} from './pg-store';
// NOTE: conformance imports `vitest`, so it is NOT re-exported here (this
// barrel is imported by production code). Test code imports it from the
// dedicated `@papercusp/coordination/subscription-store/conformance` subpath.
