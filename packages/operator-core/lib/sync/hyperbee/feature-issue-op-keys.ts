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
import type { BeeClaimSpecRow } from './projections/bee-claim-spec';
import type { GateVerdictWireRow } from './projections/gate-verdicts';
import type { HivePolicyRow } from './projections/hive-policy';
import type { ReportWireRow } from './projections/hive-reports';
import type { PendingJoinWireRow } from './projections/hive-pending-joins';
import type { HarnessIssueRow } from './projections/issues';
import type { ContributorUsageEventRow } from './projections/usage';
import type { CoordConversationRow } from './projections/coord-conversation';
import type { CoordMessageRow } from './projections/coord-message';
import type { CoordThreadRow } from './projections/coord-thread';
import type { CoordThreadPostRow } from './projections/coord-thread-post';
import type { PlanItemAssignmentRow } from './projections/plan-item-assignments';
import type { HiveMemberRow } from './projections/hive-members';
import type { HiveEpochKeyRow } from './projections/hive-epoch-keys';
import type { EngineerIssueRow } from './projections/engineer-issues';
import type { PlanPartWireRow } from './projections/harness-plan-parts';
import type { P2pPeerGrantWireRow } from './projections/p2p-peer-grants';
import type { P2pReceiptWireRow } from './projections/p2p-receipts';
import type { FleetDirectoryRow } from './projections/fleet-directory';
import type { AgentFactWireRow } from './projections/agent-facts';
import type { GymQdEliteWireRow } from './projections/gym-qd-elites';

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
  // federated-scout-gym-learning-2026-07-02 (F1-1): SHAREABLE standing facts.
  // Projection 'agent-facts-by-key' (projections/agent-facts.ts); key == the
  // generated fed_key column (scope/coalesce(scope_ref,'')/key — mig 462).
  // Epoch-ENCRYPTED content (deliberately NOT in REKEY_PLAINTEXT_TAGS: fact
  // bodies must not be readable by non-members on the wire — D-006 privacy).
  agent_facts: 'agent-facts-by-key',
  // federated-scout-gym-learning-2026-07-02 (F1-2/F1-5): FEDERATABLE QD elites
  // (mig 464 capture triggers gate on the D-002 eligibility stamp; wire key ==
  // niche_key ⇒ latest-per-niche-per-source on the wire). Receive side writes
  // gym_qd_foreign_elites ONLY (mig 465 own-table redesign — provenance in the
  // PK, local archive untouchable by peers). Projection 'gym-qd-elites-by-niche'
  // (projections/gym-qd-elites.ts). Epoch-ENCRYPTED content (deliberately NOT in
  // REKEY_PLAINTEXT_TAGS — descriptors/rationales unreadable to non-members on
  // the wire, D-006).
  gym_qd_archive: 'gym-qd-elites-by-niche',
  // cross-machine-coord-parity-and-trust-2026-07-01 (P-016): per-bee claim specs.
  // Projection 'bee-claim-specs' (projections/bee-claim-spec.ts); key == bee_id.
  bee_claim_specs: 'bee-claim-specs',
  // cross-machine-coord-parity-and-trust-2026-07-01 (P-044 DG-1): the distributed
  // test gate's device-signed verdict facts. Projection 'gate-verdicts'
  // (projections/gate-verdicts.ts); key == verdict_id (the content address).
  gate_verdicts: 'gate-verdicts',
  // shared-hive-owner-enforcement-2026-06-19 (EN-1): the owner-signed Hive policy
  // record. Projection 'hive-policy' (projections/hive-policy.ts); SINGLETON, so
  // key == harness_slug (the Hive home).
  hive_policy: 'hive-policy',
  // shared-hive-owner-enforcement-2026-06-19 (EN-3 / P-MOD): the member→owner moderation
  // report queue. Projection 'hive-reports' (projections/hive-reports.ts); key == report_id.
  hive_reports: 'hive-reports',
  // shared-hive-owner-enforcement-2026-06-19 (EN-3 / P-MEMBER): approval-mode pending join
  // requests. Projection 'hive-pending-joins' (projections/hive-pending-joins.ts); key ==
  // github_user_id (the generated pending_join_fed_key column).
  hive_pending_joins: 'hive-pending-joins',
  // shared-hive-federation-2026-06-08 (P-006): per-Hive contributor/device admission.
  // Projection 'hive-members' (projections/hive-members.ts); key == github_user_id.
  // The capture trigger (mig 189) writes outbox.harness_slug := NEW.hive_home_slug so
  // it rides the Hive peer-log.
  hive_members: 'hive-members',
  // shared-hive-rekey-2026-06-19 (P-005): per-member WRAPPED epoch keys for the read-plane
  // re-key. Projection 'hive-epoch-keys' (projections/hive-epoch-keys.ts); key ==
  // '<epoch>:<member_device_pubkey>' (the generated epoch_key_fed_key column). The capture
  // trigger (mig 316) writes outbox.harness_slug := the Hive home so it rides the Hive
  // peer-log. DARK until papercusp-hive-rekey flips (the boundary trigger + producer are
  // flag-gated, so nothing writes the table — the trigger never fires — until cutover).
  hive_epoch_keys: 'hive-epoch-keys',
  // fed-reanchor B5: the work-queue's issue/task family. Projection 'engineer-issues'
  // (projections/engineer-issues.ts); key == issue_id. The capture trigger (mig 197)
  // derives the federation slug from `scope` + stamps it into the row as harness_slug.
  engineer_issues: 'engineer-issues',
  // plan-federation-regrain-2026-06-13 (P-006): per-PART plan federation. Projection
  // 'plan-parts' (projections/harness-plan-parts.ts); key == '<plan_slug>/<part_key>'
  // (the harness_plan_parts.part_fed_key generated column, mig 270). DARK until the
  // papercusp-plan-part-federation flag flips (capture trigger is mig 271).
  harness_plan_parts: 'plan-parts',
  // p2p-work-distribution-2026-07-02 (P-001): P2P capability grants — hive-home-scoped,
  // receiver-enforced (the projection verifies the op author's ATTESTED gh user-id ==
  // grantor_github_user_id). Projection 'p2p-peer-grants' (projections/p2p-peer-grants.ts);
  // key == '<grantor_ghid>:<grantee_kind>:<grantee_ref>' (the generated grant_fed_key
  // column, mig 463).
  p2p_peer_grants: 'p2p-peer-grants',
  // p2p-work-distribution-2026-07-02 (P-004): loud-refusal receipt FACTS — immutable,
  // INSERT-only (gate_verdicts pattern), hive-home-scoped, M21 offer_id threaded.
  // Projection 'p2p-receipts' (projections/p2p-receipts.ts); key == receipt_id (mig 468).
  p2p_receipts: 'p2p-receipts',
  // p2p-work-distribution-2026-07-02 (P-101 / D-006): the owner-SIGNED fleet directory
  // record — hive-home-scoped, receiver-verified (attested-device signature; hive key
  // only for H10 force-archive). Projection 'p2p-fleet-directory'
  // (projections/fleet-directory.ts); key == '<owner_ghid>/<fleet_slug>' (the generated
  // fleet_dir_fed_key column, mig 476).
  p2p_fleet_directory: 'p2p-fleet-directory',
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
 * The PHYSICAL relation backing each federated logical `table_name`. Post-mig-374
 * (work-items-unify) the two unified work-item families — `engineer_issues` and
 * `harness_features_consolidated` — are VIEWS over the `work_items` base table, which
 * physically carries their capture (`capture_work_items_outbox`), LWW-stamp
 * (`stamp_local_federated_write_trg`) and RLS apparatus. The capture trigger demuxes by
 * `item_kind` and stamps the LOGICAL `table_name` on each op (mig-375) so the read-side
 * projections demux unchanged — but anything introspecting the PHYSICAL schema (the
 * rls / stamp / capture COVERAGE GUARDS) must look at the base table, not the view, or it
 * checks an object that can never carry a row trigger or RLS. Every other federated table
 * is its own physical relation (identity).
 */
export const CDC_PHYSICAL_TABLE: Readonly<Record<string, string>> = {
  engineer_issues: 'work_items',
  harness_features_consolidated: 'work_items',
};

/** The physical relation backing a federated logical `table_name` (identity for the
 *  non-unified tables). The coverage guards introspect THIS, since triggers + RLS live on
 *  the base table, not the post-374 views. */
export function cdcPhysicalTable(tableName: string): string {
  return CDC_PHYSICAL_TABLE[tableName] ?? tableName;
}

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
  /**
   * D-001 (Brief J): the op's HLC ordering key (`encodeHlc` string), stamped at
   * capture from the ONE PG clock of record (`substrate_outbox.op_hlc`) — put →
   * the row's `fed_hlc`; del → a fresh `hlc_now()`. Threaded onto the wire op as
   * `op.hlc` so the remote peer's projection writes the SAME `fed_hlc` the local
   * row carries → identical ordering key on both peers. `undefined` for a pre-314
   * outbox row / append-only table → `stampOpHlc` generates a fallback at append.
   */
  op_hlc?: string;
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
    // migration 357 (agent-activity-liveness-truth): the item-scoped progress signal,
    // bumped on real state transitions. It pairs with taken_by/taken_at for cross-cell
    // stalled-item detection, so it MUST federate — else a peer reads NULL and wrongly
    // flags an actively-worked item as stalled (the exact bug 357 fixed). TIMESTAMPTZ → epoch ms.
    last_progress_at: isoOrMsToEpochMs(row.last_progress_at),
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
    // WI-251 (findings-B B-002): federate content/lineage columns (were dropped
    // → NULL on peers). verifier_*/audit_*/worked_by_history/current_wave stay
    // LOCAL (each peer re-audits / local cursors).
    design_spec_id: strOrNull(row.design_spec_id),
    design_status: strOrNull(row.design_status),
    needs_design: typeof row.needs_design === 'boolean' ? row.needs_design : null,
    discarded_design_work:
      typeof row.discarded_design_work === 'boolean' ? row.discarded_design_work : null,
    source_plan_slug: strOrNull(row.source_plan_slug),
    source_plan_item_ids: Array.isArray(row.source_plan_item_ids)
      ? (row.source_plan_item_ids as string[])
      : null,
    see_also: Array.isArray(row.see_also) ? (row.see_also as string[]) : null,
    wave: strOrNull(row.wave),
    deprecation_reason: strOrNull(row.deprecation_reason),
    completion_ref: row.completion_ref ?? null,
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
    initiative: strOrNull(row.initiative),
    // mig 329/331 — plan-template provenance + auto-promote policy (federate; part of
    // the plan definition). template is TEXT; template_data + promote_policy are jsonb blobs.
    template: strOrNull(row.template),
    template_data: row.template_data ?? null,
    promote_policy: row.promote_policy ?? null,
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

/** Map an outbox `row` jsonb to the `BeeClaimSpecRow` the bee-claim-spec projection
 *  consumes — the federated subset (harness_slug = the hive home, bee_id, spec
 *  jsonb, revision, updated_by). updated_at is machine-local. */
function toBeeClaimSpecValue(row: Record<string, unknown>): BeeClaimSpecRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    bee_id: String(row.bee_id ?? ''),
    spec: (row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
      ? (row.spec as Record<string, unknown>)
      : {}),
    revision: Number(row.revision ?? 0),
    updated_by: strOrNull(row.updated_by),
  };
}

/** Map an outbox `row` jsonb to the `GateVerdictWireRow` the gate-verdicts
 *  projection consumes — the federated subset (harness_slug = the hive home,
 *  verdict_id = the content address, the signed verdict fields + sig).
 *  created_at is machine-local. bigint columns (duration_ms, verdict_ts) render
 *  as numbers via to_jsonb (epoch-ms scale, well under 2^53). */
function toGateVerdictValue(row: Record<string, unknown>): GateVerdictWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    verdict_id: String(row.verdict_id ?? ''),
    schema_v: numOrZero(row.schema_v),
    repo_key: String(row.repo_key ?? ''),
    staging_sha: String(row.staging_sha ?? ''),
    shard_id: String(row.shard_id ?? ''),
    inputs_hash: String(row.inputs_hash ?? ''),
    verdict: String(row.verdict ?? ''),
    duration_ms: numOrZero(row.duration_ms),
    device_pubkey: String(row.device_pubkey ?? ''),
    verdict_ts: numOrZero(row.verdict_ts),
    sig: String(row.sig ?? ''),
  };
}

/** Map an outbox `row` jsonb to the `HivePolicyRow` the hive-policy projection INSERT
 *  consumes — the owner-signed federated subset (harness_slug = the Hive home,
 *  policy_json = the canonical signed JSON TEXT, owner_pubkey, signature,
 *  policy_version). No epoch dance, no jsonb (policy_json is TEXT — the exact bytes the
 *  signature covers). The projection verifies the signature before applying. */
function toHivePolicyValue(row: Record<string, unknown>): HivePolicyRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    policy_json: String(row.policy_json ?? ''),
    owner_pubkey: String(row.owner_pubkey ?? ''),
    signature: String(row.signature ?? ''),
    policy_version: numOrZero(row.policy_version),
  };
}

/** Map an outbox `row` jsonb to the `FleetDirectoryRow` the p2p-fleet-directory
 *  projection INSERT consumes (P-101 / D-006) — the owner-signed federated subset
 *  (harness_slug = the Hive home, record_json = the canonical signed JSON TEXT — the
 *  exact bytes the signature covers, never jsonb). The projection verifies the device
 *  signature + device→owner attestation before applying. */
function toFleetDirectoryValue(row: Record<string, unknown>): FleetDirectoryRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    owner_github_user_id: numOrZero(row.owner_github_user_id),
    fleet_slug: String(row.fleet_slug ?? ''),
    record_json: String(row.record_json ?? ''),
    signer_device_pubkey: String(row.signer_device_pubkey ?? ''),
    signature: String(row.signature ?? ''),
    record_version: numOrZero(row.record_version),
    archived: row.archived === true,
  };
}

/** Map an outbox `row` jsonb to the `ReportWireRow` the hive-reports projection INSERT
 *  consumes (EN-3 / P-MOD). The federated subset of harness_shared.hive_reports —
 *  harness_slug = the Hive home (demux), report_id = the peer-log key, the reporter
 *  identity + target + status. created_at/updated_at are machine-local (not federated). */
function toHiveReportValue(row: Record<string, unknown>): ReportWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    report_id: String(row.report_id ?? ''),
    reporter_github_user_id: numOrZero(row.reporter_github_user_id),
    reporter_github_username: strOrNull(row.reporter_github_username),
    target_kind: String(row.target_kind ?? ''),
    target_ref: String(row.target_ref ?? ''),
    report_reason: strOrNull(row.report_reason),
    status: String(row.status ?? ''),
  };
}

/** Map an outbox `row` jsonb to the `PendingJoinWireRow` the hive-pending-joins projection
 *  INSERT consumes (EN-3 / P-MEMBER). The federated subset of harness_shared.hive_pending_joins
 *  — harness_slug = the Hive home (demux), github_user_id = the peer-log key, the joiner's
 *  identity + devices + the decision (status/decided_*). device_attestations stays a jsonb
 *  array; requested_at/decided_at are bigint epoch-ms (federated, the request/decision order).
 *  created_at/updated_at are machine-local (not federated). */
function toHivePendingJoinValue(row: Record<string, unknown>): PendingJoinWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    github_user_id: numOrZero(row.github_user_id),
    github_username: String(row.github_username ?? ''),
    display_name: strOrNull(row.display_name),
    avatar_url: strOrNull(row.avatar_url),
    device_attestations: Array.isArray(row.device_attestations)
      ? (row.device_attestations as PendingJoinWireRow['device_attestations'])
      : [],
    status: String(row.status ?? ''),
    reason: strOrNull(row.reason),
    requested_at: numOrZero(row.requested_at),
    decided_at: numOrNull(row.decided_at),
    decided_by_github_user_id: numOrNull(row.decided_by_github_user_id),
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

/** Map an outbox `row` jsonb to the `HiveEpochKeyRow` the hive-epoch-keys projection
 *  INSERT consumes (shared-hive-rekey-2026-06-19 P-005). The federated subset of
 *  harness_shared.hive_epoch_keys — harness_slug = the Hive home (the projection demux),
 *  epoch + member_device_pubkey = the compound peer-log key, wrapped_key = the epoch key
 *  sealed to that member's device. workspace_id/author_pubkey/origin/fed_ts come from the
 *  op envelope, not the wire value (mirrors toHiveSettingValue). */
function toHiveEpochKeyValue(row: Record<string, unknown>): HiveEpochKeyRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    epoch: numOrZero(row.epoch),
    member_device_pubkey: String(row.member_device_pubkey ?? ''),
    wrapped_key: String(row.wrapped_key ?? ''),
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

/** Map an outbox `row` jsonb to the `P2pPeerGrantWireRow` the p2p-peer-grants
 *  projection consumes (P-001, mig 463) — the federated subset. BIGINTs
 *  (grantor_github_user_id, grantor_epoch) render as numbers via to_jsonb
 *  (both far under 2^53); text[] columns render as JSON string arrays.
 *  created_at/updated_at are machine-local (not federated); origin/
 *  author_pubkey/fed_ts/fed_hlc ride the op provenance, not the wire value. */
function toP2pPeerGrantValue(row: Record<string, unknown>): P2pPeerGrantWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    grantor_github_user_id: numOrZero(row.grantor_github_user_id),
    grantor_login: strOrNull(row.grantor_login),
    grantee_kind: String(row.grantee_kind ?? ''),
    grantee_ref: String(row.grantee_ref ?? ''),
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.filter((c): c is string => typeof c === 'string')
      : [],
    preset: strOrNull(row.preset),
    status: String(row.status ?? ''),
    grantor_epoch: numOrZero(row.grantor_epoch),
    wake_rate_cap_per_hour: numOrNull(row.wake_rate_cap_per_hour),
    excluded_device_pubkeys: Array.isArray(row.excluded_device_pubkeys)
      ? row.excluded_device_pubkeys.filter((c): c is string => typeof c === 'string')
      : [],
    note: strOrNull(row.note),
  };
}

/** Map an outbox `row` jsonb to the `P2pReceiptWireRow` the p2p-receipts projection
 *  consumes (P-004, mig 468) — the federated subset. BIGINTs (user ids, receipt_ts)
 *  render as numbers via to_jsonb; created_at is machine-local (not federated);
 *  origin/author_pubkey/fed_ts/fed_hlc ride the op provenance. */
function toP2pReceiptValue(row: Record<string, unknown>): P2pReceiptWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    receipt_id: String(row.receipt_id ?? ''),
    kind: String(row.kind ?? ''),
    offer_id: strOrNull(row.offer_id),
    action: String(row.action ?? ''),
    refusal_code: strOrNull(row.refusal_code),
    missing_capability: strOrNull(row.missing_capability),
    budget_axis: strOrNull(row.budget_axis),
    detail: typeof row.detail === 'string' ? row.detail : '',
    requester_kind: strOrNull(row.requester_kind),
    requester_ref: strOrNull(row.requester_ref),
    requester_github_user_id: numOrNull(row.requester_github_user_id),
    responder_github_user_id: numOrZero(row.responder_github_user_id),
    responder_device_pubkey: strOrNull(row.responder_device_pubkey),
    receipt_ts: numOrZero(row.receipt_ts),
  };
}

/**
 * Map an outbox `row` jsonb to the `AgentFactWireRow` the agent-facts projection
 * consumes (F1-4 / P-012, mig 461/462) — the SHAREABLE federated subset. The
 * capture stores `to_jsonb(row)`, so `expires_at`/`retracted_at` (timestamptz)
 * are already ISO strings on the wire and pass through as-is. Peers stamp
 * `source_hive` from the admitted log identity — it is deliberately NOT carried
 * (a sender-claimed source is never trusted). Must satisfy `isAgentFactWireRow`
 * or the op is dropped on every peer (the bug this case fixes: facts fell to
 * `toIssueValue`, which produced issue columns and dropped body/scope/key). */
function toAgentFactValue(row: Record<string, unknown>): AgentFactWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    scope: String(row.scope ?? ''),
    scope_ref: strOrNull(row.scope_ref),
    key: String(row.key ?? ''),
    body: String(row.body ?? ''),
    source_ref: strOrNull(row.source_ref),
    expires_at: String(row.expires_at ?? ''),
    retracted_at: strOrNull(row.retracted_at),
    created_by: String(row.created_by ?? ''),
  };
}

/**
 * Map an outbox `row` jsonb to the `GymQdEliteWireRow` the gym-qd-elites
 * projection consumes (F1-2/F1-5, mig 464) — the federatable subset. `updated_at`
 * is a `bigint` epoch-ms column so `to_jsonb` renders it as a number; `descriptor`
 * is jsonb (an object); `federatable` is the sender eligibility stamp (capture only
 * fires when true, and the receiver re-checks `=== true`). Must satisfy
 * `isGymQdEliteWireRow` or the op is dropped on every peer (same class of bug as
 * agent_facts above — elites fell to `toIssueValue` and lost rationale/niche/
 * fitness/descriptor). `source_hive`/`novelty_gift` are receiver-stamped, not
 * carried. */
function toGymQdEliteValue(row: Record<string, unknown>): GymQdEliteWireRow {
  return {
    harness_slug: String(row.harness_slug ?? ''),
    niche_key: String(row.niche_key ?? ''),
    candidate_id: String(row.candidate_id ?? ''),
    scope: String(row.scope ?? ''),
    domain: String(row.domain ?? ''),
    risk: String(row.risk ?? ''),
    fitness: numOrZero(row.fitness),
    descriptor:
      row.descriptor && typeof row.descriptor === 'object' && !Array.isArray(row.descriptor)
        ? (row.descriptor as Record<string, unknown>)
        : {},
    rationale: strOrNull(row.rationale),
    federatable: row.federatable === true,
    updated_at: numOrZero(row.updated_at),
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
      // D-001: carry the capture-stamped HLC so the del orders against puts by the
      // same causal key the merge fold does (stampOpHlc preserves a preset hlc).
      ...(outboxRow.op_hlc ? { hlc: outboxRow.op_hlc } : {}),
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
    | BeeClaimSpecRow
    | GateVerdictWireRow
    | HivePolicyRow
    | ReportWireRow
    | PendingJoinWireRow
    | HiveMemberRow
    | HiveEpochKeyRow
    | EngineerIssueRow
    | PlanPartWireRow
    | P2pPeerGrantWireRow
    | P2pReceiptWireRow
    | AgentFactWireRow
    | GymQdEliteWireRow;
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
    case 'bee_claim_specs':
      value = toBeeClaimSpecValue(row);
      break;
    case 'gate_verdicts':
      value = toGateVerdictValue(row);
      break;
    case 'hive_policy':
      value = toHivePolicyValue(row);
      break;
    case 'hive_reports':
      value = toHiveReportValue(row);
      break;
    case 'hive_pending_joins':
      value = toHivePendingJoinValue(row);
      break;
    case 'hive_members':
      value = toHiveMemberValue(row);
      break;
    case 'hive_epoch_keys':
      value = toHiveEpochKeyValue(row);
      break;
    case 'engineer_issues':
      value = toEngineerIssueValue(row);
      break;
    case 'harness_plan_parts':
      value = toPlanPartValue(row);
      break;
    case 'p2p_peer_grants':
      value = toP2pPeerGrantValue(row);
      break;
    case 'p2p_receipts':
      value = toP2pReceiptValue(row);
      break;
    case 'p2p_fleet_directory':
      value = toFleetDirectoryValue(row);
      break;
    case 'agent_facts':
      value = toAgentFactValue(row);
      break;
    case 'gym_qd_archive':
      value = toGymQdEliteValue(row);
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
    // D-001: carry the local row's PG-stamped HLC (substrate_outbox.op_hlc =
    // row.fed_hlc) so the remote peer materialises an IDENTICAL fed_hlc — the
    // write-time-HLC half that makes local-vs-remote conflicts converge.
    ...(outboxRow.op_hlc ? { hlc: outboxRow.op_hlc } : {}),
  };
}
