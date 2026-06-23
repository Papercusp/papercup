/**
 * operator-core cache adapters (caching-layer-tag-eca-2026-06-22 P-003 + P-016).
 *
 * The PG-backed tiers that sit behind the generic, dependency-free seams. They live
 * HERE (not in `@papercusp/cache` / `@papercusp/projection-index`) because they need
 * `postgres` — the generic libs stay zero-runtime-dep.
 *
 * - PgL2Store           — durable L2 cache tier (harness_shared.cache_l2; migration 369).
 * - PgProjectionStore   — generic PG-backed ProjectionStore for @papercusp/projection-index.
 * - GuardedProjectionIndex — fail-soft wrapper so a poison record can't crash the loop.
 */

export { PgL2Store } from './pg-l2-store';
export type { L2Entry, L2SetOptions } from './pg-l2-store';

export { PgProjectionStore } from './pg-projection-store';
export type { PgProjectionStoreConfig } from './pg-projection-store';

export { GuardedProjectionIndex } from './guarded-projection-index';
export type { ProjectionErrorSink, GuardedProjectionIndexOptions } from './guarded-projection-index';

// The operator's singleton Cache instance (P-004) — the one process-wide cache
// the operator reads/writes through and the `cache.bumpTags` ECA action bumps.
export { getOperatorCache, setOperatorCache, installOperatorCache, resetOperatorCacheForTests } from './instance';

// The one operator-side getOrSet wrapper every expensive read-mostly tool caches
// through (cache-expensive-tool-reads-2026-06-22 P-001 / D-003).
export {
  cachedRead,
  stableKey,
  resolveCacheWorkspaceId,
  snapshotCachedReadStats,
  resetCachedReadStatsForTests,
} from './cached-read';
export type { CachedReadCtx, CachedReadOptions, CachedReadToolStats } from './cached-read';
