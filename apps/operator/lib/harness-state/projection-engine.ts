/**
 * Harness-state projection engine (plan harness-state-storage-unification-2026-06-01, P-003).
 *
 * The ONE place that reasons about a table's cross-machine SYNC AUTHORITY by
 * its registry classification. P-003a (this file): the peer-log half is a thin
 * guard over the existing Model-B registry (`lib/sync/hyperbee`) — it keeps the
 * registry's `sync:'peer-log'` set and the hand-wired projections in lock-step
 * — plus a live-inventory coverage check. P-003b adds the git-export adapter;
 * P-003c folds both into a single router.
 *
 * Intentionally substrate-free: this module does NOT import `lib/sync/**`. The
 * boot caller passes the registered projection tags in (see `checkPeerLogConsistency`),
 * so harness-state never drags the Hyperbee/holepunch dep graph.
 */
import {
  PEER_LOG_TABLES,
  classifyInventory,
  resolveTableSpec,
  type SyncAuthority,
} from './table-registry';

/**
 * Hyperbee projection tag → PG table. Mirrors `lib/sync/hyperbee/projections/*`
 * (each projection's `tableTag` + its `INTO harness_shared.<table>`, verified
 * P-003a). The drift guard asserts this is bijective with the registry's
 * `sync:'peer-log'` set.
 */
export const PEER_LOG_TAG_TO_TABLE: Readonly<Record<string, string>> = {
  contributors: 'contributors',
  claims: 'feature_claims',
  queue: 'feature_queue',
  'working-set': 'feature_working_set',
  'features-by-id': 'harness_features_consolidated',
  issues: 'harness_issues_consolidated',
  presence: 'shared_presence',
  prs: 'harness_feature_prs',
  usage: 'contributor_usage_events',
};

export interface PeerLogConsistency {
  ok: boolean;
  /** peer-log tables in the registry with no projection tag (a new sync:'peer-log' table needs a projection). */
  missingProjection: string[];
  /** projection tags whose mapped table is NOT sync:'peer-log' in the registry (a projection lost its registry entry). */
  orphanTag: string[];
}

/**
 * Assert the registry's `sync:'peer-log'` set and the hand-wired projection
 * tags stay in lock-step. The caller passes `REGISTERED_PROJECTION_TAGS` from
 * `lib/sync/hyperbee/projections/register-all` so this module stays
 * substrate-free. Fails when the two drift apart in either direction.
 */
export function checkPeerLogConsistency(registeredTags: readonly string[]): PeerLogConsistency {
  const tagTables = new Set(
    registeredTags.map((t) => PEER_LOG_TAG_TO_TABLE[t]).filter((x): x is string => Boolean(x)),
  );
  const missingProjection = [...PEER_LOG_TABLES].filter((t) => !tagTables.has(t));
  const orphanTag = registeredTags.filter((t) => {
    const tbl = PEER_LOG_TAG_TO_TABLE[t];
    return !tbl || resolveTableSpec(tbl).sync !== 'peer-log';
  });
  return {
    ok: missingProjection.length === 0 && orphanTag.length === 0,
    missingProjection,
    orphanTag,
  };
}

export interface InventoryCoverage {
  total: number;
  /** tables flagged NEEDS_REVIEW — must be empty (P-002 closed it). */
  unreviewed: string[];
  /** tables resolving to DEFAULT (slug-shared/none) — intentional, but surfaced so a NEW table can't hide. */
  defaulted: string[];
  byBucket: Record<string, number>;
}

/**
 * Coverage of a live table list (P-003a boot caller passes the
 * `information_schema` set). Surfaces unclassified + DEFAULT-fall-through so a
 * newly-added table can never silently inherit DEFAULT unseen.
 */
export function checkInventoryCoverage(liveTables: string[]): InventoryCoverage {
  const c = classifyInventory(liveTables);
  return { total: c.total, unreviewed: c.unreviewed, defaulted: c.defaulted, byBucket: c.byBucket };
}

/** Convenience: the sync authority for a table (strips a schema qualifier). */
export function syncAuthorityFor(table: string): SyncAuthority {
  return resolveTableSpec(table).sync;
}
