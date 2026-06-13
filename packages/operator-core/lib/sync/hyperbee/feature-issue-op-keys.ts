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
import type { HarnessPlanRow } from './projections/harness-plans';
import type { HiveSettingRow } from './projections/hive-settings';
import type { HarnessIssueRow } from './projections/issues';
import type { ContributorUsageEventRow } from './projections/usage';
import type { CoordConversationRow } from './projections/coord-conversation';
import type { CoordMessageRow } from './projections/coord-message';
import type { CoordThreadRow } from './projections/coord-thread';
import type { CoordThreadPostRow } from './projections/coord-thread-post';
import type { PlanItemAssignmentRow } from './projections/plan-item-assignments';
import type { HiveMemberRow } from './projections/hive-members';
import type { EngineerIssueRow } from './projections/engineer-issues';
import type { PlanPartWireRow } from './projections/harness-plan-parts';

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
  // plans-pg-canonical-migration-2026-06-03 (Stage 2): PG-canonical plans federate
  // as papercup-harness content. Projection registered under 'plans-by-slug'
  // (projections/harness-plans.ts buildHarnessPlansProjection); key == plan_slug.
  harness_plans: 'plans-by-slug',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): harness-scoped
  // coordination conversations. Projection registered under 'coord-conversations'
  // (projections/coord-conversation.ts buildCoordConversationProjection); key == id.
  coord_conversations: 'coord-conversations',
  // distributed-coordination-shared-harness-2026-06-04 (Track A, surface #1):
  // harness-scoped coord messages/handoffs/escalations. Projection 'coord-messages'
  // (projections/coord-message.ts buildCoordMessageProjection); key == msg_id.
  coord_event_log: 'coord-messages',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): conversation
  // reply timeline. coord_threads → 'coord-threads' (key thread_id);
  // coord_thread_posts → 'coord-thread-posts' (key post_msg_id).
  coord_threads: 'coord-threads',
  coord_thread_posts: 'coord-thread-posts',
  // plan-item-assignment-claim-liveness-2026-06-04 (D-002): per-plan-item ASSIGNMENT
  // federates as content. Projection 'item-assignments' (projections/plan-item-assignments.ts);
  // key == '<plan_slug>:<item_id>' (the table's generated fed_key column).
  plan_item_assignments: 'item-assignments',
  // shared-hive-federation-2026-06-08 (P-005): per-Hive settings. Projection
  // 'hive-settings-by-key' (projections/hive-settings.ts); key == setting_key.
  hive_settings: 'hive-settings-by-key',
  // shared-hive-federation-2026-06-08 (P-006): per-Hive contributor/device admission.
  // Projection 'hive-members' (projections/hive-members.ts); key == github_user_id.
  // The capture trigger (mig 189) writes outbox.harness_slug := NEW.hive_home_slug so
  // it rides the Hive peer-log.
  hive_members: 'hive-members',
  // fed-reanchor B5: the work-queue's issue/task family. Projection 'engineer-issues'
  // (projections/engineer-issues.ts); key == issue_id. The capture trigger (mig 197)
  // derives the federation slug from `scope` + stamps it into the row as harness_slug.
  engineer_issues: 'engineer-issues',
  // plan-federation-regrain-2026-06-13 (P-006): per-PART plan federation. Projection
  // 'plan-parts' (projections/harness-plan-parts.ts); key == '<plan_slug>/<part_key>'
  // (the harness_plan_parts.part_fed_key generated column, mig 270). DARK until the
  // papercusp-plan-part-federation flag flips (capture trigger is mig 271).
  harness_plan_parts: 'plan-parts',
};

/**
 * The PG tables whose LOCAL writes are CDC-captured into `substrate_outbox` by a
 * `capture_substrate_outbox` / `capture_hive_members_outbox` trigger (migrations
 * 108/125/144/145/149/150/186/189/197) and federated by the drain — i.e. the
 * "PG-first" federated set. Derived from `TABLE_NAME_TO_TABLE_TAG` so it stays
 * the single source of truth: adding a CDC-captured table here (paired with its
 * SQL trigger + projection) is the one edit. Consumed by the capture-coverage
 * guard (`capture-coverage.ts` / `harness-state` `checkCaptureCoverage`), which
 * asserts every `sync:'peer-log'` registry table has SOME producer — a CDC
 * trigger here, a log-first append, or a documented accepted-unfederated entry —
 * so a NEW federated table can't silently ship with no capture (the EI-382 class
 * at the data layer; shared-hive-hardening P-011).
 */
export const CDC_CAPTURED_TABLES: readonly string[] = Object.keys(TABLE_NAME_TO_TABLE_TAG);

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

/** Per-harness Hyperbee key for a plan == its plan_slug (mirrors the
 *  projection's `composeKey`, which returns `row.plan_slug`). */
export function composePlanKey(planSlug: string): string {
  return planSlug;
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
    // Work-item dispatch columns (D-013 + dispatch-scaling): without these a
    // Queen reorder / swarm pin / redundancy declaration never federated and
    // remote swarms never saw steering (su-ae509 2026-06-10). payload stays
    // jsonb-opaque. Per-assignee ordering (assignee_rank/rank_writer/
    // rank_updated_at) is deliberately NOT federated — it is local work-list
    // state, same call as engineer_issues below.
    item_kind: strOrNull(row.item_kind),
    feature_order: numOrNull(row.feature_order),
    swarm_affinity: strOrNull(row.swarm_affinity),
    redundancy: numOrNull(row.redundancy),
    payload: row.payload ?? null,
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

/** Map an outbox `row` jsonb to the `HarnessPlanRow` value the plans projection
 *  INSERT consumes — the federated subset of harness_plans. No TIMESTAMPTZ
 *  conversion (the op_ columns + created_at/updated_at are machine-local, not
 *  federated) and no jsonb (content is TEXT, supersedes is text[] → a JSON array
 *  under to_jsonb). */
function toPlanValue(row: Record<string, unknown>): HarnessPlanRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    plan_slug: String(row.plan_slug ?? ''),
    content: typeof row.content === 'string' ? row.content : '',
    content_hash: typeof row.content_hash === 'string' ? row.content_hash : '',
    title: strOrNull(row.title),
    status: strOrNull(row.status),
    created: strOrNull(row.created),
    updated: strOrNull(row.updated),
    owner: strOrNull(row.owner),
    supersedes: Array.isArray(row.supersedes)
      ? row.supersedes.filter((s): s is string => typeof s === 'string')
      : [],
    superseded_by: strOrNull(row.superseded_by),
    archived: typeof row.archived === 'boolean' ? row.archived : false,
    is_legacy: typeof row.is_legacy === 'boolean' ? row.is_legacy : false,
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

/** Map an outbox `row` jsonb to the `CoordConversationRow` value the conversation
 *  projection INSERT consumes. created_at/updated_at/resolved_at (TIMESTAMPTZ) →
 *  epoch ms; accepted_post_id is NOT federated (local bigserial, dropped here). */
function toConversationValue(row: Record<string, unknown>): CoordConversationRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    id: String(row.id ?? ''),
    kind: String(row.kind ?? ''),
    scope: String(row.scope ?? 'harness'),
    asker_id: String(row.asker_id ?? ''),
    title: strOrNull(row.title),
    body: typeof row.body === 'string' ? row.body : '',
    state: String(row.state ?? 'open'),
    accepted_answer: strOrNull(row.accepted_answer),
    capture_target: strOrNull(row.capture_target),
    promoted_issue_id: strOrNull(row.promoted_issue_id),
    created_at: isoOrMsToEpochMs(row.created_at) ?? 0,
    updated_at: isoOrMsToEpochMs(row.updated_at) ?? 0,
    resolved_at: isoOrMsToEpochMs(row.resolved_at),
  };
}

/** Map an outbox `row` jsonb to the `CoordMessageRow` the message projection
 *  INSERT consumes. `body` is a nested jsonb object (the envelope); `ts`
 *  (TIMESTAMPTZ) → epoch ms; the local bigserial `id` is dropped (not federated). */
function toMessageValue(row: Record<string, unknown>): CoordMessageRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    msg_id: String(row.msg_id ?? ''),
    surface: String(row.surface ?? ''),
    writer_key: strOrNull(row.writer_key),
    body:
      row.body && typeof row.body === 'object' && !Array.isArray(row.body)
        ? (row.body as Record<string, unknown>)
        : {},
    ts: isoOrMsToEpochMs(row.ts) ?? 0,
  };
}

/** Map an outbox `row` jsonb to the `CoordThreadRow` the thread projection
 *  consumes. created_at/last_post_at (TIMESTAMPTZ) → epoch ms. */
function toThreadValue(row: Record<string, unknown>): CoordThreadRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    thread_id: String(row.thread_id ?? ''),
    parent_kind: String(row.parent_kind ?? ''),
    parent_ref: String(row.parent_ref ?? ''),
    title: strOrNull(row.title),
    created_by: strOrNull(row.created_by),
    created_at: isoOrMsToEpochMs(row.created_at) ?? 0,
    last_post_at: isoOrMsToEpochMs(row.last_post_at),
    post_count: numOrZero(row.post_count),
  };
}

/** Map an outbox `row` jsonb to the `CoordThreadPostRow` the post projection
 *  consumes. created_at (TIMESTAMPTZ) → epoch ms; the bigserial id is dropped. */
function toThreadPostValue(row: Record<string, unknown>): CoordThreadPostRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    post_msg_id: String(row.post_msg_id ?? ''),
    thread_id: String(row.thread_id ?? ''),
    author_id: strOrNull(row.author_id),
    body: typeof row.body === 'string' ? row.body : '',
    created_at: isoOrMsToEpochMs(row.created_at) ?? 0,
  };
}

/** Map an outbox `row` jsonb to the `PlanItemAssignmentRow` the assignment
 *  projection INSERT consumes — the federated subset. assigned_ts/released_ts stay
 *  ISO strings (PG casts them to timestamptz on insert); no jsonb, no epoch dance. */
function toAssignmentValue(row: Record<string, unknown>): PlanItemAssignmentRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    plan_slug: String(row.plan_slug ?? ''),
    item_id: String(row.item_id ?? ''),
    assignee_name: strOrNull(row.assignee_name),
    assigned_by_user: strOrNull(row.assigned_by_user),
    assigned_ts: strOrNull(row.assigned_ts),
    released_ts: strOrNull(row.released_ts),
    strategy: strOrNull(row.strategy),
    note: strOrNull(row.note),
  };
}

/** Map an outbox `row` jsonb to the `HiveSettingRow` the hive-settings projection
 *  INSERT consumes — the federated subset (harness_slug = the Hive home slug,
 *  setting_key, JSON-text value). No epoch dance, no jsonb (value is TEXT). */
function toHiveSettingValue(row: Record<string, unknown>): HiveSettingRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    setting_key: String(row.setting_key ?? ''),
    value: strOrNull(row.value),
  };
}

/** Map an outbox `row` jsonb to the `HiveMemberRow` the hive-members projection
 *  INSERT consumes — the federated subset of harness_shared.hive_members. The Hive
 *  scope key (`hive_home_slug`) is the projection demux; device_attestations stays a
 *  jsonb array; github_user_id (BIGINT) → number. No TIMESTAMPTZ (joined_at/channels
 *  are machine-local, not federated). */
function toHiveMemberValue(row: Record<string, unknown>): HiveMemberRow {
  return {
    hive_home_slug: String(row.hive_home_slug ?? ''),
    github_user_id: numOrZero(row.github_user_id),
    github_username: String(row.github_username ?? ''),
    device_attestations: Array.isArray(row.device_attestations)
      ? (row.device_attestations as HiveMemberRow['device_attestations'])
      : [],
    revoked_pubkeys: Array.isArray(row.revoked_pubkeys) ? (row.revoked_pubkeys as string[]) : [],
    binding_status: String(row.binding_status ?? 'unverified'),
  };
}

/** Map an outbox `row` jsonb to the `EngineerIssueRow` the engineer-issues projection
 *  INSERT consumes — the federated subset of harness_shared.engineer_issues. The capture
 *  trigger (mig 197) stamped `harness_slug` (the federation slug derived from `scope`)
 *  into the row for the projection demux. assigned_at/created_at are TIMESTAMPTZ → ISO
 *  strings under to_jsonb; the projection inserts them straight (PG casts ISO →
 *  timestamptz). payload stays jsonb-opaque. created_at falls back to now ISO if absent
 *  (a real row always carries it; defensive against a malformed op). The per-bee
 *  work-list ordering (assignee_rank/rank_writer/rank_updated_at) is NOT federated. */
function toEngineerIssueValue(row: Record<string, unknown>): EngineerIssueRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    issue_id: String(row.issue_id ?? ''),
    scope: String(row.scope ?? ''),
    kind: String(row.kind ?? 'bug'),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    severity: String(row.severity ?? ''),
    source: String(row.source ?? ''),
    state: String(row.state ?? ''),
    assignee: strOrNull(row.assignee),
    assigned_by: strOrNull(row.assigned_by),
    assigned_at: strOrNull(row.assigned_at),
    payload: row.payload ?? null,
    found_during: strOrNull(row.found_during),
    linked_feature_id: strOrNull(row.linked_feature_id),
    created_by: strOrNull(row.created_by),
    created_at: typeof row.created_at === 'string' && row.created_at
      ? row.created_at
      : new Date().toISOString(),
  };
}

/** Map an outbox `row` jsonb to the `PlanPartWireRow` the plan-parts projection
 *  consumes — the federated subset of harness_plan_parts (plan-federation-regrain
 *  P-006). part_key/kind/body/ordinal/tombstone are the part; fed_ts + author ride
 *  the op provenance, not the row. */
function toPlanPartValue(row: Record<string, unknown>): PlanPartWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    plan_slug: String(row.plan_slug ?? ''),
    part_key: String(row.part_key ?? ''),
    kind: String(row.kind ?? 'item') as PlanPartWireRow['kind'],
    body: typeof row.body === 'string' ? row.body : '',
    ordinal: typeof row.ordinal === 'number' ? row.ordinal : Number(row.ordinal ?? 0),
    tombstone: row.tombstone === true,
  };
}

/**
 * Thrown when an outbox row names a `table_name` this build has no mapper for.
 * This is BOTH a programming error (a new trigger shipped without its mapper) AND
 * a legitimate forward-compat rolling-deploy state: a NEWER operator/migration may
 * have a capture trigger for a table an OLDER co-located operator (sharing the same
 * PG outbox) can't map yet. The drain catches THIS class specifically and SKIPS the
 * row (leaving it undrained for a newer build to federate) instead of halting the
 * whole drain — so a forward-compatible federated-table addition degrades to "that
 * one table doesn't federate here yet" rather than "all federation stops."
 */
export class UnknownOutboxTableError extends Error {
  readonly tableName: string;
  constructor(tableName: string) {
    super(`outboxRowToLocalWriteOp: unknown table_name '${tableName}'`);
    this.name = 'UnknownOutboxTableError';
    this.tableName = tableName;
  }
}

/**
 * Map one `substrate_outbox` row to the `LocalWriteOp` the drain appends to the
 * own log. Throws `UnknownOutboxTableError` on an unmapped `table_name` (the drain
 * skips that class — see the class doc). For a `del`, `value` is undefined (the
 * projection's delete path needs only `hbKey`).
 */
export function outboxRowToLocalWriteOp(outboxRow: OutboxRow): LocalWriteOp {
  const table = TABLE_NAME_TO_TABLE_TAG[outboxRow.table_name];
  if (!table) {
    throw new UnknownOutboxTableError(outboxRow.table_name);
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
  let value:
    | HarnessFeatureRow
    | HarnessIssueRow
    | ContributorUsageEventRow
    | HarnessPlanRow
    | CoordConversationRow
    | CoordMessageRow
    | CoordThreadRow
    | CoordThreadPostRow
    | PlanItemAssignmentRow
    | HiveSettingRow
    | HiveMemberRow
    | EngineerIssueRow
    | PlanPartWireRow;
  switch (outboxRow.table_name) {
    case 'harness_features_consolidated':
      value = toFeatureValue(row);
      break;
    case 'harness_plans':
      value = toPlanValue(row);
      break;
    case 'contributor_usage_events':
      value = toUsageValue(row);
      break;
    case 'coord_conversations':
      value = toConversationValue(row);
      break;
    case 'coord_event_log':
      value = toMessageValue(row);
      break;
    case 'coord_threads':
      value = toThreadValue(row);
      break;
    case 'coord_thread_posts':
      value = toThreadPostValue(row);
      break;
    case 'plan_item_assignments':
      value = toAssignmentValue(row);
      break;
    case 'hive_settings':
      value = toHiveSettingValue(row);
      break;
    case 'hive_members':
      value = toHiveMemberValue(row);
      break;
    case 'engineer_issues':
      value = toEngineerIssueValue(row);
      break;
    case 'harness_plan_parts':
      value = toPlanPartValue(row);
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
