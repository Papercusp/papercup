/**
 * feature-issue-op-keys — Stage 2 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * Pure mappers that turn a `harness_shared.substrate_outbox` row (captured by
 * the Stage-1 AFTER trigger as `to_jsonb` of the full consolidated row) into a
 * `LocalWriteOp` the Stage-3 drain appends to this device's own Hypercore log.
 * The existing read-side projections (`projections/harness-features.ts`,
 * `projections/issues.ts`) then apply that op on peers.
 *
 * Two correctness facts this module owns (see the test for the rationale):
 *
 *  (1) `LocalWriteOp.table` is the projection's REGISTERED tableTag, NOT the
 *      raw `harness_*_consolidated` table_name. `applyOpVia` dispatches on
 *      `lookup(op.table)` keyed by tableTag, so the map below MUST match the
 *      `tableTag` literals in the two projection builders:
 *        `harness_features_consolidated` → `'features-by-id'`
 *        `harness_issues_consolidated`   → `'issues'`
 *
 *  (2) `to_jsonb` renders TIMESTAMPTZ columns as ISO strings, but the
 *      projection's row validators require epoch-ms NUMBERS. The mapper
 *      converts `taken_at`/`expires_at` (features) and `found_at` (issues) back
 *      to epoch ms so `decodeValue` accepts the op on peers.
 *
 * No PG, no IO — trivially unit-testable.
 */

import type { LocalWriteOp } from './boot';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import type { HarnessFeatureRow } from './projections/harness-features';
import type { HarnessIssueRow } from './projections/issues';
import type { ContributorUsageEventRow } from './projections/usage';

/**
 * The two consolidated table names the Stage-1 trigger writes into the outbox
 * (`TG_TABLE_NAME`), mapped to the projection `tableTag` each row projects
 * through. Adding a third federated table is a one-line addition here +
 * registering its projection.
 */
const TABLE_NAME_TO_TABLE_TAG: Record<string, string> = {
  harness_features_consolidated: 'features-by-id',
  harness_issues_consolidated: 'issues',
  // P-070: the append-only contributor activity ledger. Its projection is
  // registered under tableTag 'usage' (projections/usage.ts buildUsageProjection).
  contributor_usage_events: 'usage',
};

/**
 * Shape of one `substrate_outbox` row, as the drain reads it. `row` is the
 * `to_jsonb` of the full consolidated row (a superset of the projection row),
 * or `null` for a `del`.
 */
export interface OutboxRow {
  table_name: string;
  op: 'put' | 'del';
  key: string;
  /** Epoch ms of the capture (the outbox row's `ts` BIGINT). */
  ts: number;
  row: Record<string, unknown> | null;
}

/** Per-harness Hyperbee key for a feature == its feature_id (mirrors the
 *  projection's `composeKey`, which returns `row.feature_id`). */
export function composeFeatureKey(featureId: string): string {
  return featureId;
}

/** Per-harness Hyperbee key for an issue == its issue_id (mirrors the
 *  projection's `composeKey`, which returns `row.issue_id`). */
export function composeIssueKey(issueId: string): string {
  return issueId;
}

/**
 * Coerce a `to_jsonb` TIMESTAMPTZ field (ISO string) — or a value already
 * parsed to epoch ms by a future client — into epoch ms `number | null`.
 * Idempotent over numbers; `null`/`undefined` → `null`.
 */
function isoOrMsToEpochMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Coerce a value to `number | null` (BIGINT → number; ISO timestamps handled
 *  separately by `isoOrMsToEpochMs`). */
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** Coerce a value to `number` (issues' NOT NULL counters); falls back to 0. */
function numOrZero(v: unknown): number {
  const n = numOrNull(v);
  return n == null ? 0 : n;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : v == null ? null : String(v);
}

/** Map an outbox `row` jsonb to the `HarnessFeatureRow` value the projection
 *  INSERT consumes (the subset of the consolidated row, with TIMESTAMPTZ fields
 *  converted to epoch ms). */
function toFeatureValue(row: Record<string, unknown>): HarnessFeatureRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    feature_id: String(row.feature_id ?? ''),
    title: strOrNull(row.title),
    summary: strOrNull(row.summary),
    status: strOrNull(row.status),
    attempts: numOrNull(row.attempts),
    claims: strOrNull(row.claims),
    notes: strOrNull(row.notes),
    metadata: row.metadata ?? null,
    kind: strOrNull(row.kind),
    project_id: strOrNull(row.project_id),
    expected_cost_cents: numOrNull(row.expected_cost_cents),
    tags: row.tags ?? null,
    needs_human_review:
      typeof row.needs_human_review === 'boolean' ? row.needs_human_review : null,
    ts: numOrNull(row.ts),
    created_ts: numOrNull(row.created_ts),
    updated_ts: numOrNull(row.updated_ts),
    parent_id: strOrNull(row.parent_id),
    goal_id: strOrNull(row.goal_id),
    taken_by: strOrNull(row.taken_by),
    taken_at: isoOrMsToEpochMs(row.taken_at),
    expires_at: isoOrMsToEpochMs(row.expires_at),
  };
}

/** Map an outbox `row` jsonb to the `HarnessIssueRow` value the projection
 *  INSERT consumes. `found_at` (TIMESTAMPTZ) → epoch ms. */
function toIssueValue(row: Record<string, unknown>): HarnessIssueRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    issue_id: String(row.issue_id ?? ''),
    title: String(row.title ?? ''),
    severity: String(row.severity ?? ''),
    source: String(row.source ?? ''),
    status: String(row.status ?? ''),
    found_at: isoOrMsToEpochMs(row.found_at) ?? 0,
    found_during: strOrNull(row.found_during),
    repro: strOrNull(row.repro),
    evidence: strOrNull(row.evidence),
    suggested_fix: strOrNull(row.suggested_fix),
    code_pointer: strOrNull(row.code_pointer),
    linked_feature_id: strOrNull(row.linked_feature_id),
    attempts: numOrZero(row.attempts),
    notes: row.notes ?? [],
    created_ts: numOrZero(row.created_ts),
    updated_ts: numOrZero(row.updated_ts),
  };
}

/** Map an outbox `row` jsonb to the `ContributorUsageEventRow` value the usage
 *  projection INSERT consumes. `ts` is TIMESTAMPTZ → ISO string under `to_jsonb`;
 *  the projection validator requires epoch-ms NUMBER, so convert it. github_user_id
 *  / schema_version (BIGINT) are coerced to numbers. Append-only → no del reshape. */
function toUsageValue(row: Record<string, unknown>): ContributorUsageEventRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    event_id: String(row.event_id ?? ''),
    github_user_id: numOrZero(row.github_user_id),
    device_pubkey: String(row.device_pubkey ?? ''),
    kind: String(row.kind ?? ''),
    ref_id: strOrNull(row.ref_id),
    payload: row.payload ?? null,
    ts: isoOrMsToEpochMs(row.ts) ?? 0,
    schema_version: numOrZero(row.schema_version),
  };
}

/**
 * Map one `substrate_outbox` row to the `LocalWriteOp` the drain appends to the
 * own log. Throws on an unknown `table_name` (a programming error — the trigger
 * only ever writes the federated tables in `TABLE_NAME_TO_TABLE_TAG`). For a
 * `del`, `value` is undefined (the projection's delete path needs only `hbKey`).
 */
export function outboxRowToLocalWriteOp(outboxRow: OutboxRow): LocalWriteOp {
  const table = TABLE_NAME_TO_TABLE_TAG[outboxRow.table_name];
  if (!table) {
    throw new Error(
      `outboxRowToLocalWriteOp: unknown table_name '${outboxRow.table_name}'`,
    );
  }

  const ts = typeof outboxRow.ts === 'number' ? outboxRow.ts : Number(outboxRow.ts);

  if (outboxRow.op === 'del') {
    return {
      type: 'del',
      table,
      hbKey: outboxRow.key,
      ts,
      schema_version: CURRENT_SCHEMA_VERSION,
    };
  }

  const row = outboxRow.row ?? {};
  let value: HarnessFeatureRow | HarnessIssueRow | ContributorUsageEventRow;
  switch (outboxRow.table_name) {
    case 'harness_features_consolidated':
      value = toFeatureValue(row);
      break;
    case 'contributor_usage_events':
      value = toUsageValue(row);
      break;
    default:
      value = toIssueValue(row);
  }

  return {
    type: 'put',
    table,
    hbKey: outboxRow.key,
    value,
    ts,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
}
