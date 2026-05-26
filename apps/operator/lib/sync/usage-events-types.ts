/**
 * usage-events-types — types for the contributor_usage_events ledger.
 *
 * Sources from `papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.md`
 * P-070 + v5 addendum 3 D-027.
 *
 * Types-only — no I/O, no PG, no Hyperbee writes. Sibling-pattern to
 * binding-types / binding-verifier-types / attestation-types: ships
 * the wire-shapes now so P-070's runtime can land cleanly when Phase
 * 5a's other gates pass.
 *
 * The table schema (`harness_shared.contributor_usage_events`) already
 * lives in `ensure-schema-dogfood.ts` (commit `556b37d7`); these types
 * are the row-shape contract for emit + rollup callers.
 *
 * When P-070 implementation begins:
 *   - apps/operator/lib/sync/usage-events.ts imports these types
 *   - feature CRUD / PR daemon / decision writes / plan writes / agent
 *     run completion all consume `emitUsageEvent({kind, ...})`
 *   - Contributor stat rollups (Phase 8 P-073 Insights, §9.2
 *     Contributors row) consume `RollupSummary`
 */

/**
 * The set of activity kinds the ledger tracks. Each maps to a
 * payload shape via `UsageEventPayloadByKind` below.
 *
 * Closed enum — new kinds are added deliberately (not arbitrary
 * free-text), so the rollup helper can give meaningful counts per
 * kind without an open-set problem.
 */
export type UsageEventKind =
  | 'feature_created'
  | 'feature_claimed'
  | 'feature_unclaimed'
  | 'feature_shipped'
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_closed_unmerged'
  | 'plan_revision_added'
  | 'decision_added'
  | 'agent_run_completed';

/**
 * Per-kind payload shapes. Discriminated by `kind`. The payload is
 * intentionally minimal — `ref_id` carries the foreign-key (feature
 * id, PR number, plan revision id, etc.); payload carries event-
 * specific context that's not already on the referenced row.
 */
export type UsageEventPayload =
  | { kind: 'feature_created'; title: string; tags?: string[] }
  | { kind: 'feature_claimed'; claimer_pubkey: string }
  | { kind: 'feature_unclaimed'; reason?: 'voluntary' | 'timeout' | 'override' }
  | { kind: 'feature_shipped'; commit_sha: string; pr_number?: number }
  | { kind: 'pr_opened'; pr_number: number; pr_url: string }
  | { kind: 'pr_merged'; pr_number: number; merge_commit_sha: string }
  | { kind: 'pr_closed_unmerged'; pr_number: number; reason?: string }
  | { kind: 'plan_revision_added'; plan_slug: string; revision_seq: number }
  | { kind: 'decision_added'; decision_id: string; title: string }
  | { kind: 'agent_run_completed'; role: string; outcome: 'success' | 'failure' | 'cancelled' };

/**
 * The full row as it lands in `harness_shared.contributor_usage_events`.
 * Column names match the SQL exactly (snake_case).
 */
export interface UsageEventRow {
  harness_slug: string;
  event_id: string;
  github_user_id: number;
  device_pubkey: string;
  kind: UsageEventKind;
  ref_id?: string;
  payload?: UsageEventPayload;
  ts: number; // epoch ms
  schema_version: number;
}

/**
 * Emit input — the caller-visible shape. The runtime fills in
 * `event_id` (UUIDv7-style for time-ordering), `ts`, `schema_version`,
 * and `device_pubkey` from the OS keychain.
 */
export interface EmitUsageEventInput {
  harness_slug: string;
  github_user_id: number;
  kind: UsageEventKind;
  ref_id?: string;
  payload?: UsageEventPayload;
}

/**
 * Rollup summary — what the §9.2 Contributors tab + Insights People
 * card render per contributor. Counts are per-kind to allow the UI to
 * highlight specific activity types (e.g. "23 features shipped" is
 * stronger social proof than "127 events").
 */
export interface RollupSummary {
  github_user_id: number;
  harness_slug: string;
  totalEvents: number;
  countsByKind: Record<UsageEventKind, number>;
  /** Most-recent event timestamp (epoch ms). Drives the "last active"
   * pill on the contributor row. */
  lastActiveTs: number | null;
  /** When the rollup was computed. Used by the UI to show "as of N s
   * ago" when the data is older than the freshness threshold. */
  computedAtTs: number;
}

/**
 * Initial-state factory — produces an empty RollupSummary with every
 * UsageEventKind initialized to 0. Use in the read path to avoid
 * sparse-count footguns (UI doing `counts.pr_opened` and getting
 * `undefined` when no PRs have been opened yet).
 *
 * Exported for both testing + runtime use; the rollup helper folds
 * over the event stream starting from this seed.
 */
export function emptyRollupSummary(input: {
  github_user_id: number;
  harness_slug: string;
  nowMs?: number;
}): RollupSummary {
  const now = input.nowMs ?? Date.now();
  const counts: Record<UsageEventKind, number> = {
    feature_created: 0,
    feature_claimed: 0,
    feature_unclaimed: 0,
    feature_shipped: 0,
    pr_opened: 0,
    pr_merged: 0,
    pr_closed_unmerged: 0,
    plan_revision_added: 0,
    decision_added: 0,
    agent_run_completed: 0,
  };
  return {
    github_user_id: input.github_user_id,
    harness_slug: input.harness_slug,
    totalEvents: 0,
    countsByKind: counts,
    lastActiveTs: null,
    computedAtTs: now,
  };
}

/**
 * Pure folder — given a current rollup + a new event row, produce
 * the updated rollup. Used by both the read-path scan (start from
 * `emptyRollupSummary`, fold over events) and the projection-time
 * incremental update (start from cached rollup, fold one new event).
 *
 * The fold is associative + identity-respecting: folding two
 * non-overlapping event sequences produces the same final rollup as
 * folding the concatenated sequence.
 *
 * Exported pure — the runtime layer wraps PG reads + caching around
 * this function.
 */
export function applyEventToRollup(
  rollup: RollupSummary,
  event: { kind: UsageEventKind; ts: number },
): RollupSummary {
  return {
    ...rollup,
    totalEvents: rollup.totalEvents + 1,
    countsByKind: {
      ...rollup.countsByKind,
      [event.kind]: rollup.countsByKind[event.kind] + 1,
    },
    lastActiveTs:
      rollup.lastActiveTs == null
        ? event.ts
        : Math.max(rollup.lastActiveTs, event.ts),
  };
}

/**
 * Predicate — does this kind count toward "shipped work" social
 * proof? Used by the Insights People card to distinguish a tier-C
 * "active" contributor from a tier-B "shipped work" contributor.
 *
 * `feature_shipped` + `pr_merged` are the shipped-work kinds;
 * everything else is "activity" (still meaningful, but a lower
 * trust signal).
 */
export function isShippedWorkKind(kind: UsageEventKind): boolean {
  return kind === 'feature_shipped' || kind === 'pr_merged';
}

/**
 * Current schema version of the UsageEventRow shape. Bumped when
 * the row gains a column or changes a column's semantics. Consumed
 * by Hyperbee's D-024 schema-versioning enforcement (P-030d).
 */
export const USAGE_EVENT_SCHEMA_VERSION = 1;
