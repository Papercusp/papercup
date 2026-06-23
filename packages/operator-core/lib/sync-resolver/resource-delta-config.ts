/**
 * Per-sync-RESOURCE delta config (agent-tool-delta-client-rollout-2026-06-23 P-006).
 *
 * A sync resource (a `resolveNamedQueryV2` name) opts into the rows-delta protocol by
 * declaring how to KEY its rows: `itemKeyField` (a simple, stable field access) + a
 * `schemaVersion` that invalidates in-flight client cursors when the row shape changes.
 * The rest-query handler negotiates full|delta (via `negotiateRowsDelta`) for a cursor-
 * sending (delta-aware) client; a resource WITHOUT a config always serves full — today's
 * behavior, byte-identical.
 *
 * Only high-cost, frequently-re-fetched LIST resources need this. `plans.attention`
 * (~633KB re-fetched on every plans-table invalidation) is the headline ~327GB/3d win:
 * it returns one AttentionGroup per plan, so a single-plan write re-sends only that group.
 *
 * Correctness is not at stake here: the negotiated response carries the full-view checksum,
 * the client verifies its merge against it and refetches a full on any mismatch — so a wrong
 * or stale `itemKeyField` can only cost a refetch (no win), never a wrong view.
 */
export interface ResourceDeltaConfig {
  /** Field uniquely + stably identifying a row (e.g. AttentionGroup.key, plan.slug). */
  itemKeyField: string;
  /** Bumped when the row shape changes — invalidates in-flight client cursors. */
  schemaVersion: string;
}

const CONFIG: Readonly<Record<string, ResourceDeltaConfig>> = {
  // plans.attention resolves to AttentionGroup[] (one group per plan + an alerts group);
  // keyed by `key`. A single-plan write changes only that group's content-hash → re-send 1 of N.
  'plans.attention': { itemKeyField: 'key', schemaVersion: 'plans-attention-v1' },
  // plans.list resolves to the plan rows, keyed by `slug` (same key the plans:list tool uses).
  'plans.list': { itemKeyField: 'slug', schemaVersion: 'plans-list-v1' },
};

/** The delta config for a sync resource name, or undefined → serve full (today's behavior). */
export function resourceDeltaConfig(name: string): ResourceDeltaConfig | undefined {
  return CONFIG[name];
}
