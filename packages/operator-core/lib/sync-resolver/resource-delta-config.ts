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
  // v2 (WI-7039 / D-025): the UI projection now omits null-valued keys, which
  // changes every row's content hash. The bump makes in-flight cursors take ONE
  // clean full instead of reporting the whole view as `updated`.
  'plans.attention': { itemKeyField: 'key', schemaVersion: 'plans-attention-v2' },
  // plans.list resolves to the plan rows, keyed by `slug` (same key the plans:list tool uses).
  // v2 (WI-7045 / D-025): the UI projection now omits null-valued keys here too,
  // which changes every row's content hash. Same reason as the attention bump —
  // without it an in-flight cursor reports the entire view as `updated` instead of
  // taking ONE clean full.
  'plans.list': { itemKeyField: 'slug', schemaVersion: 'plans-list-v2' },
  // plans.byHive resolves to the SAME rows as plans.list (it reuses that read with the
  // hive's member-slug set), so it takes the same `slug` key. It could not have one
  // before WI-7083: the harness_slugs fan-out fabricated one copy of the hive's plan set
  // PER MEMBER, so `slug` had 910 distinct values across 1,820 rows and no single field
  // was unique. With the fan-out deduped on the resolved PLAN SCOPE, one hive reads one
  // plan set and `slug` is unique again.
  //
  // If a caller ever assembles a slug set spanning two DIFFERENT hive homes, `slug` could
  // collide across them — that costs a refetch, never a wrong view (the response carries
  // the full-view checksum and the client refetches on mismatch; see the header note).
  'plans.byHive': { itemKeyField: 'slug', schemaVersion: 'plans-byhive-v1' },
};

/** The delta config for a sync resource name, or undefined → serve full (today's behavior). */
export function resourceDeltaConfig(name: string): ResourceDeltaConfig | undefined {
  return CONFIG[name];
}
