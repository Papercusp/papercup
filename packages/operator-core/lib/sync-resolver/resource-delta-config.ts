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
  // codeRecipes resolves to the recipe corpus for /admin/recipes, keyed by `id` — the
  // PRIMARY KEY of harness_shared.code_recipes, and measured distinct on 1000/1000 live
  // rows. The corpus is re-fetched whole on every recipe write (capture-recipe,
  // recipes:sweep and recipes:merge all fire notifySyncInvalidate('codeRecipes')), and a
  // capture changes exactly ONE row — so this is the same re-send shape plans.attention
  // has, at 1,000 rows a poll.
  'codeRecipes': { itemKeyField: 'id', schemaVersion: 'code-recipes-v1' },
  // ── no-http-anywhere-2026-07-28 D-091: the three fattest CONFIG-LESS resources on the
  // /adv/harnesses route family. Each was re-sending its whole view on every 180s SSE
  // drift-repair tick (measured on :3170 2026-08-08 via rest-query, args as the call sites
  // send them). Key uniqueness was MEASURED on the live rows, not assumed — a wrong key
  // costs a refetch, never a wrong view (see the header note), but a COLLIDING key costs
  // the whole win, so it is checked rather than hoped for.
  //
  // workItems.byHarness — 500 rows / 225,536 B; `id` distinct 500/500.
  // Several arg shapes exist (AdvChatPanel states+perState, DepGraphPanel limit, HudView's
  // fair per-status slice). Each is its own viewKey (the route keys on `name:argsJson`), and
  // `id` is unique within any of them because a work-item holds exactly one state.
  'workItems.byHarness': { itemKeyField: 'id', schemaVersion: 'work-items-byharness-v1' },
  // agentRunsConsolidated.bySlug — 2,000 rows / 554,871 B; `runId` distinct 2000/2000.
  // (`sessionId` collides 123/2000 and `featureId` 87/2000 — neither is usable as the key.)
  // Mostly-historical corpus: only genuinely running rows churn per tick, so the steady-state
  // delta is small even though the view is the largest of the three.
  'agentRunsConsolidated.bySlug': { itemKeyField: 'runId', schemaVersion: 'agent-runs-consolidated-v1' },
  // featuresConsolidated.bySlug — 1,645 rows / 516,096 B; `featureId` distinct 1645/1645.
  // ⚠ This resource is EXPLICITLY BARRED from slimming/windowing (the resolver states the full
  // row count must stay complete for client-side search/count). That bar does NOT apply here and
  // this is not a route around it: a delta changes nothing about the view's completeness or its
  // row shape — the client still holds every row — it only stops re-sending rows that did not
  // change. Delta is the RIGHT lever precisely for a view that must stay complete.
  'featuresConsolidated.bySlug': { itemKeyField: 'featureId', schemaVersion: 'features-consolidated-v1' },
};

/** The delta config for a sync resource name, or undefined → serve full (today's behavior). */
export function resourceDeltaConfig(name: string): ResourceDeltaConfig | undefined {
  return CONFIG[name];
}

/**
 * Every resource that delta-negotiates SERVER-side — the authoritative set the client codec
 * must mirror (apps/operator/providers/sync-delta-codec.ts `DELTA_RESOURCES`).
 *
 * Exported because the two halves DRIFTED and silently cost the win twice: the client gates on
 * its own literal (`query-fetcher.ts:468` — `!codec.enabled(name)` ⇒ no cursor is sent ⇒ the
 * server serves full), so a resource configured here but missing there can NEVER take a delta.
 * Measured 2026-08-08: this file gained `plans.byHive` (WI-7083, which deduped the harness_slugs
 * fan-out specifically to make `slug` unique so it COULD have an entry) and `codeRecipes`
 * (2026-08-02), while the client set had not changed since 2026-06-23 — so both fixes were inert.
 * `sync-delta-codec.test.ts` now asserts parity against this export so it cannot recur silently.
 */
export const RESOURCE_DELTA_NAMES: readonly string[] = Object.freeze(Object.keys(CONFIG));
