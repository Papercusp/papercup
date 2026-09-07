/**
 * Hyperbee → PG projection for `harness_shared.engineer_issues` — the work-queue's
 * issue/task family (work_items[kind ∈ bug|change|task]) federated over the Hive
 * peer-log (fed-reanchor brief B5; closes engineer-issues-2026-06-03 D-009).
 *
 * Mirrors projections/plan-item-assignments.ts + hive-settings.ts (a workspace-owned
 * key riding the peer-log). The federated subset = the work-item document: scope /
 * kind / title / body / severity / source / state / assignee / assigned_by /
 * assigned_at / payload / found_during / linked_feature_id / created_by / created_at.
 * NOT federated (machine-local): workspace_id (the projection binds it), updated_at
 * (locally bumped), _search (generated), AND the per-bee work-list ordering
 * (assignee_rank / rank_writer / rank_updated_at — the bee's CLAIMED-queue order on
 * its OWN Swarm, written by the reorder_work_item SQL fn; not shared backlog state,
 * so it stays local and is preserved across a peer's content update). The standard
 * provenance columns (author_pubkey/origin/fed_ts) carry the echo-guard + LWW.
 *
 * The per-harness guard (`row.harness_slug !== opts.harnessSlug`) demuxes: the
 * capture trigger (mig 197) derives the federation slug from `scope`
 * ('harness:<slug>' → <slug>; 'operator' → the Hive home) and STAMPS it into the
 * wire row as `harness_slug`, so only the owning harness's projection applies the op.
 * engineer_issues has no harness_slug COLUMN — `scope` is the source of truth; the
 * write below persists `scope`, not the demux slug.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';
import { composeEngineerIssueKey, parseEngineerIssueKey } from '../feature-issue-op-keys';
import { ANY_FAMILY_TERMINAL_STATES } from '../../../work-item-dispatch-states';

/** Wire-shape of an engineer_issues row in Hyperbee — the federated subset plus the
 *  capture-stamped `harness_slug` (the demux key). Defensive on every field. */
export interface EngineerIssueRow {
  /** The federation slug stamped by the capture trigger (the per-harness demux key). */
  harness_slug: string;
  /**
   * Physical work_items.harness_slug.  Added after migration 826 proved that a
   * home log can contain the same issue_id for several authored harnesses.
   * Optional for pre-829 wire ops; their bare keys remain readable.
   */
  storage_harness_slug?: string;
  issue_id: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
  severity: string;
  source: string;
  state: string;
  assignee: string | null;
  assigned_by: string | null;
  assigned_at: string | null; // ISO string (timestamptz under to_jsonb)
  payload: unknown; // jsonb (a task's resume metadata); null for bug/change
  found_during: string | null;
  linked_feature_id: string | null;
  created_by: string | null;
  created_at: string; // ISO string
  /**
   * WI-6327 — the row's creation instant in epoch ms, the SAME unit and value as the
   * `work_items.created_ts` column. This, not `created_at`, is what the EI-13285
   * collision guard compares: `created_at` is derived/defaulted by the mapper and so
   * can be a synthesized stand-in, while `created_ts` is passed through untouched and
   * is null exactly when the op did not carry one.
   *
   * OPTIONAL on the wire, and its ABSENCE is load-bearing: ops appended to the
   * hypercore before mig 688 carry a FABRICATED `created_at` (drain time) that is
   * indistinguishable from a genuine one, so the guard must not judge them. Null here
   * ⇒ legacy op ⇒ fail open. Non-null ⇒ authoritative ⇒ guard applies.
   */
  created_ts?: number | null;
  /**
   * work-item-completion-integrity-2026-07-01 (WI-1403 / EI-5269): the "who did
   * it + what proves it" pair recorded at the terminal-state choke point. OPTIONAL
   * on the wire (pre-432 history lacks them → dropped on write → NULL).
   */
  terminal_owner?: string | null;
  terminal_completion_ref?: string | null;
  /**
   * work-item-status-full-unify-2026-07-19 (P-009, owner hard-req D-001): the
   * pre-collapse terminal nuance (resolved → done, closed → dropped) preserved on
   * the work_items base table (mig 638; the CDC issue wire-shape stamps it in mig
   * 640). MUST federate so an issue keeps its resolution kind across the wire.
   * OPTIONAL on the wire (pre-638 history lacks it → dropped on write → NULL).
   */
  terminal_reason?: string | null;
  /**
   * mig 708 / EI-18785839681430807: the AUTHORITY axis (mig 677,
   * agent-protocol-authority-semantics-2026-07-26 P-003; D-035). Same
   * completion-integrity treatment as the terminal_* pair above — federated as
   * a plain column and joined into the EI-16756 digest below. OPTIONAL on the
   * wire (pre-708 history lacks it → dropped on write → NULL).
   */
  authority?: string | null;
  /**
   * mig 708 PART 2 / EI-18820653360383242: the trigger-maintained close time
   * (mig 698) — same treatment as toFeatureValue's sibling field: a plain
   * carried column, NOT part of the EI-16756 digest below. OPTIONAL on the
   * wire (pre-708 history lacks it → dropped on write → NULL).
   */
  closed_ts?: number | null;
  /**
   * EI-21467654382027859 (mig 965) — nine columns the federated-column-completeness
   * guard caught landing NULL on every peer. Full per-column reasoning is in mig 965's
   * header. The one that is a correctness hole rather than data loss is `admission`:
   * the issue claim gate is `admittedWhereSql` = `(admission IS DISTINCT FROM
   * 'pending')`, so an item federated WITHOUT the column arrives NULL and reads as
   * ADMITTED — a deliberately born-pending item became claimable on every peer.
   *
   * ALL OPTIONAL ON THE WIRE, and that is load-bearing, not stylistic: the other side
   * of the wire is a DIFFERENT BUILD, and `decodeValue` discards a row the validator
   * rejects — wholesale, not field-wise. Making any of these required would make an
   * older peer's every issue op undecodable. (Learned the expensive way on this same
   * item: the `producer` column of EI-21462599108204160 shipped required and had to be
   * amended.)
   */
  admission?: string | null;
  admitted_at?: string | null;
  admitted_by?: string | null;
  state_changed_at?: string | null;
  tags?: unknown; // jsonb — opaque, like `payload`
  parent_id?: string | null;
  source_plan_slug?: string | null;
  source_plan_item_ids?: string[] | null;
  expected_cost_cents?: number | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isEngineerIssueRow(input: unknown): input is EngineerIssueRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (
    r.storage_harness_slug !== undefined &&
    (!isString(r.storage_harness_slug) || r.storage_harness_slug.length === 0)
  )
    return false;
  if (!isString(r.issue_id) || r.issue_id.length === 0) return false;
  if (!isString(r.scope) || r.scope.length === 0) return false;
  if (!isString(r.kind)) return false;
  if (!isString(r.title)) return false;
  if (!isString(r.body)) return false;
  if (!isString(r.severity)) return false;
  if (!isString(r.source)) return false;
  if (!isString(r.state)) return false;
  if (!isStringOrNull(r.assignee)) return false;
  if (!isStringOrNull(r.assigned_by)) return false;
  if (!isStringOrNull(r.assigned_at)) return false;
  if (!isStringOrNull(r.found_during)) return false;
  if (!isStringOrNull(r.linked_feature_id)) return false;
  if (!isStringOrNull(r.created_by)) return false;
  if (!isString(r.created_at)) return false;
  // WI-6327: optional on the wire (absent on every pre-688 op) — but when present it
  // must be a real finite epoch, since the collision guard trusts it.
  if (r.created_ts !== undefined && r.created_ts !== null && !Number.isFinite(r.created_ts)) return false;
  if (r.terminal_owner !== undefined && !isStringOrNull(r.terminal_owner)) return false;
  if (r.terminal_completion_ref !== undefined && !isStringOrNull(r.terminal_completion_ref)) return false;
  if (r.terminal_reason !== undefined && !isStringOrNull(r.terminal_reason)) return false; // P-009/D-001 — optional on the wire
  if (r.authority !== undefined && !isStringOrNull(r.authority)) return false; // mig 708/D-035 — optional on the wire
  if (r.closed_ts !== undefined && r.closed_ts !== null && !Number.isFinite(r.closed_ts)) return false; // mig 708 PART 2 — optional on the wire
  // EI-21467654382027859 (mig 965) — every one of these is OPTIONAL on the wire: an op
  // from a peer running pre-965 code carries none of them, and REJECTING such a row here
  // would discard the WHOLE issue op (decodeValue is all-or-nothing), not just the new
  // fields. Absent ⇒ undefined ⇒ bound as null below ⇒ the ON CONFLICT preserves the
  // local value, which is the fail-safe direction for `admission` in particular.
  if (r.admission !== undefined && !isStringOrNull(r.admission)) return false;
  if (r.admitted_at !== undefined && !isStringOrNull(r.admitted_at)) return false;
  if (r.admitted_by !== undefined && !isStringOrNull(r.admitted_by)) return false;
  if (r.state_changed_at !== undefined && !isStringOrNull(r.state_changed_at)) return false;
  if (r.parent_id !== undefined && !isStringOrNull(r.parent_id)) return false;
  if (r.source_plan_slug !== undefined && !isStringOrNull(r.source_plan_slug)) return false;
  if (
    r.source_plan_item_ids !== undefined &&
    r.source_plan_item_ids !== null &&
    !(Array.isArray(r.source_plan_item_ids) && r.source_plan_item_ids.every((s) => typeof s === 'string'))
  )
    return false;
  if (r.expected_cost_cents !== undefined && r.expected_cost_cents !== null && !Number.isFinite(r.expected_cost_cents))
    return false;
  // payload and tags are jsonb-opaque — accept anything (incl. undefined → null on write).
  return true;
}

// EI-13285: the creation instant is part of the federated document (see the module
// header) and — for a genuine edit or re-delivery of the SAME logical issue — is ALWAYS
// identical to what's already stored: it's set once at INSERT and deliberately never
// touched by the `ON CONFLICT ... DO UPDATE SET` list below. So an existing row whose
// `created_ts` disagrees with an incoming remote op's by more than clock-
// skew slop is NOT an edit of that row — it's a DIFFERENT logical issue that happens
// to have been allocated the same issue_id (root cause + the fix to the allocator
// itself: issues-engineer.ts's nextIssueId / newCollisionResistantIssueTail). Refuse
// to apply the write in that case rather than upserting over it: a dropped op is
// bounded, logged, recoverable data loss (the authoring peer's own local copy is
// untouched); silently overwriting was unbounded, silent, PERMANENT local data loss —
// the actual EI-13285 incident (a freshly captured local improvement replaced by an
// unrelated remote issue).
//
// WI-6327: the comparison keys on the wire's `created_ts` (epoch ms, passed through
// untouched), NOT on `created_at` (mapper-derived, and before mig 688 outright
// fabricated as drain-time `now()` because the capture trigger emitted no creation
// timestamp at all). Keying a REFUSE-THE-WRITE decision on a field the mapper was free
// to invent turned this guard into a 100% false positive for the entire issue family:
// on the P-302 rig it refused ops for 10,070 distinct issue_ids, so no issue update
// could ever land on a peer that already held the row. A missing `created_ts` (every
// pre-688 op) now fails OPEN rather than being judged against an invented value.
const COLLISION_CREATED_AT_TOLERANCE_MS = 5_000;
const FEDERATED_TERMINAL_STATES = [...ANY_FAMILY_TERMINAL_STATES];

async function isDistinctEntityCollision(
  sql: postgres.Sql,
  harnessSlug: string,
  featureId: string,
  incomingCreatedTs: number | null | undefined,
): Promise<{ collided: boolean; existingCreatedAtIso?: string }> {
  // WI-6327: fail OPEN when the op carries no authoritative creation instant. Every op
  // appended before mig 688 has a `created_at` fabricated at drain time (the capture
  // trigger never emitted one) which is indistinguishable from a genuine value — judging
  // those dropped 10,070 distinct ids on the P-302 rig. Only a carried `created_ts` is
  // trustworthy enough to refuse a write over.
  if (incomingCreatedTs === null || incomingCreatedTs === undefined) return { collided: false };
  const rows = await sql<{ created_ts: string | number }[]>`
    SELECT created_ts FROM harness_shared.work_items
     WHERE harness_slug = ${harnessSlug} AND feature_id = ${featureId}`;
  const existing = rows[0];
  if (!existing) return { collided: false };
  const incomingMs = Number(incomingCreatedTs);
  const existingMs = Number(existing.created_ts);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(existingMs)) return { collided: false };
  if (Math.abs(incomingMs - existingMs) <= COLLISION_CREATED_AT_TOLERANCE_MS) return { collided: false };
  return { collided: true, existingCreatedAtIso: new Date(existingMs).toISOString() };
}

/**
 * Migration 826 retired a bounded set of same-ID source rows by either merging
 * them into the Papercusp survivor or rekeying the divergent source entity.
 * Pre-829 Hyperbee PUTs carry only the bare issue id, so replaying one after the
 * repair would recreate the retired physical row.  The survivor markers are
 * the persisted identity proof; without one we fail open so unrelated legacy
 * history keeps converging.
 */
async function isRetiredLegacyTwinSource(
  sql: postgres.Sql,
  workspaceId: string,
  sourceHarness: string,
  issueId: string,
): Promise<boolean> {
  const rows = await sql<{ retired: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM harness_shared.work_items survivor
       WHERE survivor.workspace_id = ${workspaceId}
         AND (
           (survivor.feature_id = ${issueId}
            AND survivor.payload->'_physicalTwinRepair'->>'migration' = '826'
            AND survivor.payload->'_physicalTwinRepair'->>'sourceHarness' = ${sourceHarness})
           OR
           (survivor.payload->'_physicalTwinRekey'->>'migration' = '826'
            AND survivor.payload->'_physicalTwinRekey'->>'oldId' = ${issueId}
            AND survivor.payload->'_physicalTwinRekey'->>'sourceHarness' = ${sourceHarness})
         )
    ) AS retired`;
  return rows[0]?.retired === true;
}

const WATCHDOG_IDENTITY_INDEX = 'work_items_watchdog_identity_uq';

interface WatchdogIdentity {
  watchdogKey: string;
  signalOrigin: string;
  lane: string;
}

/**
 * Read the exact identity migration 865 indexes from the incoming wire payload.
 * Fail closed on a malformed explicit component: PostgreSQL's jsonb `->>` would
 * stringify it, but the federation path must not guess that a non-string value
 * denotes the same logical signal as an existing row.
 */
function watchdogIdentityFromPayload(payload: unknown): WatchdogIdentity | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.watchdogKey !== 'string') return null;

  const ei = record._ei;
  const signalOrigin =
    ei && typeof ei === 'object' && !Array.isArray(ei) ? (ei as Record<string, unknown>).signal_origin : undefined;
  if (signalOrigin !== undefined && signalOrigin !== null && typeof signalOrigin !== 'string') return null;
  if (record.lane !== undefined && record.lane !== null && typeof record.lane !== 'string') return null;

  return {
    watchdogKey: record.watchdogKey,
    signalOrigin: typeof signalOrigin === 'string' ? signalOrigin : 'organic',
    lane: typeof record.lane === 'string' ? record.lane : 'improvement',
  };
}

/** Only migration 865's arbiter is recoverable; every other 23505 remains fatal. */
function isWatchdogIdentityConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  if (String(candidate.code ?? '') !== '23505') return false;
  if (candidate.constraint === WATCHDOG_IDENTITY_INDEX || candidate.constraint_name === WATCHDOG_IDENTITY_INDEX) {
    return true;
  }
  return [candidate.message, candidate.detail].some(
    (value) => typeof value === 'string' && value.includes(`"${WATCHDOG_IDENTITY_INDEX}"`),
  );
}

/**
 * Re-read the database arbiter after its named 23505. Returning a winner is
 * deliberately stricter than merely finding the same watchdogKey: every
 * component and the partial-index predicate must match, and the winner must be
 * a different physical row. Migration 865 guarantees at most one such row;
 * anything else fails closed and leaves the merge cursor retryable.
 */
async function findWatchdogIdentityWinner(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  incomingIssueId: string,
  identity: WatchdogIdentity,
): Promise<string | null> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND feature_id <> ${incomingIssueId}
       AND item_kind IN ('bug', 'change', 'task')
       AND (status IS NULL OR status <> ALL (
         ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
       ))
       AND payload ->> 'watchdogKey' = ${identity.watchdogKey}
       AND COALESCE(payload -> '_ei' ->> 'signal_origin', 'organic') = ${identity.signalOrigin}
       AND COALESCE(payload ->> 'lane', 'improvement') = ${identity.lane}
     ORDER BY feature_id
     LIMIT 2`;
  return rows.length === 1 ? rows[0]!.feature_id : null;
}

export interface EngineerIssuesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** WI-259 parity (shared-hive member-content federation): hive-home slug when this harness is a
   *  hive MEMBER — a cross-member issue op is membership-gated only when set. */
  potHomeSlug?: string;
  /** WI-259 parity: resolve an op's VERIFIED source-log device pubkey from sourceLogKeyHex. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004 parity: content-before-membership defer buffer. */
  pendingMemberContent?: PendingMembershipContent;
}

/** Per-harness Hyperbee key == issue_id (matches the capture trigger's TG_ARGV[0]). */
function composeKey(row: EngineerIssueRow): string {
  return row.storage_harness_slug ? composeEngineerIssueKey(row.storage_harness_slug, row.issue_id) : row.issue_id;
}

function decodeValue(raw: unknown): EngineerIssueRow | null {
  return isEngineerIssueRow(raw) ? raw : null;
}

async function writeToPg(
  opts: EngineerIssuesProjectionOpts,
  row: EngineerIssueRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259/D-027 parity (shared-hive member-content federation): own-slug applies; a CROSS-member
  // issue/task applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. The bare slug
  // early-return previously DROPPED every peer member's issue (members have distinct slugs in a real
  // hive). It lands under its AUTHORED slug (the write persists row.scope = 'harness:<authored>').
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'engineer-issues',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'engineer-issues',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // P-010 unification: apply the issue op to the work_items BASE table (engineer_issues is
  // now a compat view → no ON CONFLICT). Map issue→work_items: issue_id→feature_id,
  // scope→canonical issue harness_slug (migration 382: 'operator:<workspace>' for
  // operator-scope rows; '<harness>' for harness-scoped rows) + issue-only cols into
  // payload->'_ei', body→summary, state→status, assignee→taken_by, kind→item_kind.
  // payload binds via ::text::jsonb (postgres-js-jsonb-binding gotcha).
  const vSlug =
    typeof row.scope === 'string' && row.scope.startsWith('harness:')
      ? row.scope.slice(8)
      : `operator:${opts.workspaceId || 'default'}`;
  // The storage slug is part of every post-829 op's identity.  Refuse a row
  // whose payload disagrees with its scope-derived destination: accepting it
  // would make the put land under one key while its later tombstone targets a
  // different physical row.
  if (row.storage_harness_slug && row.storage_harness_slug !== vSlug) {
    console.warn(
      `[engineer-issues projection] storage harness mismatch for issue_id=${row.issue_id}: ` +
        `wire=${row.storage_harness_slug}, scope=${vSlug}; refusing op`,
    );
    return;
  }
  // WI-40113 / migration 859: a bare pre-829 PUT has no physical identity of
  // its own.  If migration-826 survivor evidence proves that this exact source
  // identity was retired, applying the op would recreate the physical twin.
  // Qualified post-829 PUTs intentionally bypass this guard: their storage key
  // is authoritative and must remain able to represent a current source row.
  if (!row.storage_harness_slug && (await isRetiredLegacyTwinSource(sql, opts.workspaceId, vSlug, row.issue_id))) {
    console.warn(
      `[engineer-issues projection] suppressing legacy replay for retired migration-826 source ` +
        `issue_id=${row.issue_id} (harness_slug=${vSlug}); a qualified post-829 PUT is required`,
    );
    return;
  }
  // EI-13285: id-collision guard — see isDistinctEntityCollision's header. Must run
  // BEFORE the upsert below, which would otherwise blindly clobber a distinct local
  // record sharing this issue_id.
  const collision = await isDistinctEntityCollision(sql, vSlug, row.issue_id, row.created_ts);
  if (collision.collided) {
    console.warn(
      `[engineer-issues projection] EI-13285 id collision: refusing to apply remote op for ` +
        `issue_id=${row.issue_id} (harness_slug=${vSlug}) — the existing local row was created at ` +
        `${collision.existingCreatedAtIso}, but the incoming op claims created_at=${row.created_at}. ` +
        `These are two distinct issues that were allocated the same id; the incoming op is DROPPED ` +
        `(not applied) to avoid destroying the local record. The authoring peer's own copy is unaffected.`,
    );
    return;
  }
  const basePayload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
  const payloadText = JSON.stringify({
    ...basePayload,
    _ei: {
      scope: row.scope ?? null,
      severity: row.severity ?? null,
      source: row.source ?? null,
      found_during: row.found_during ?? null,
      linked_feature_id: row.linked_feature_id ?? null,
      created_by: row.created_by ?? null,
      assigned_by: row.assigned_by ?? null,
    },
  });
  try {
    await sql`
      INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, summary, status,
       taken_by, taken_at, payload, author_pubkey, origin, fed_ts, fed_hlc,
       created_ts, updated_ts, ts, terminal_owner, terminal_completion_ref, terminal_reason,
       authority, closed_ts,
       admission, admitted_at, admitted_by, state_changed_at, tags, parent_id,
       source_plan_slug, source_plan_item_ids, expected_cost_cents)
    VALUES
      (${opts.workspaceId}, ${vSlug}, ${row.issue_id}, ${row.kind}, ${row.title},
       ${row.body}, ${row.state}, ${row.assignee}, ${row.assigned_at},
       ${payloadText}::text::jsonb, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc},
       COALESCE((extract(epoch FROM ${row.created_at}::timestamptz) * 1000)::bigint,
                (extract(epoch FROM now()) * 1000)::bigint),
       (extract(epoch FROM now()) * 1000)::bigint,
       (extract(epoch FROM now()) * 1000)::bigint,
       ${row.terminal_owner ?? null}, ${row.terminal_completion_ref ?? null}, ${row.terminal_reason ?? null},
       ${row.authority ?? null}, ${row.closed_ts ?? null},
       -- EI-21467654382027859 (mig 965). The tags column binds via ::text::jsonb like
       -- payload above, but must bind SQL NULL (not the jsonb 'null' literal) when
       -- absent: JSON.stringify(null) would store a jsonb null that reads as present.
       ${row.admission ?? null}, ${row.admitted_at ?? null}, ${row.admitted_by ?? null},
       ${row.state_changed_at ?? null},
       ${row.tags === undefined || row.tags === null ? null : JSON.stringify(row.tags)}::text::jsonb,
       ${row.parent_id ?? null}, ${row.source_plan_slug ?? null},
       ${row.source_plan_item_ids ?? null}::text[], ${row.expected_cost_cents ?? null})
    ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
      item_kind     = EXCLUDED.item_kind,
      title         = EXCLUDED.title,
      summary       = EXCLUDED.summary,
      status        = EXCLUDED.status,
      taken_by      = EXCLUDED.taken_by,
      taken_at      = EXCLUDED.taken_at,
      payload       = EXCLUDED.payload,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc,
      updated_ts    = EXCLUDED.updated_ts,
      terminal_owner = EXCLUDED.terminal_owner,
      terminal_completion_ref = EXCLUDED.terminal_completion_ref,
      -- P-009/D-001 (work-item-status-full-unify): the terminal nuance
      -- (resolved→done / closed→dropped) must converge like status itself.
      terminal_reason = EXCLUDED.terminal_reason,
      -- mig 708/D-035: same rationale as terminal_reason — the authority axis
      -- must converge like status itself.
      authority = EXCLUDED.authority,
      -- mig 708 PART 2: honour a federated close time; the BEFORE trigger's own
      -- COALESCE/freeze logic (mig 698) then decides whether it actually wins.
      closed_ts = EXCLUDED.closed_ts,
      -- EI-21467654382027859 (mig 965). These plain content columns converge like
      -- status does: last writer in fed_order_key space wins.
      tags = EXCLUDED.tags,
      parent_id = EXCLUDED.parent_id,
      source_plan_slug = EXCLUDED.source_plan_slug,
      source_plan_item_ids = EXCLUDED.source_plan_item_ids,
      expected_cost_cents = EXCLUDED.expected_cost_cents,
      -- state_changed_at COALESCEs rather than taking EXCLUDED outright, and the
      -- difference is not cosmetic. An op from a pre-965 peer carries NULL here, and
      -- the mig 896 BEFORE trigger treats a NULL that DIFFERS from the stored value as
      -- "an explicit origin timestamp" and preserves it -- so a bare EXCLUDED would let
      -- one older peer's update ERASE the state age this column exists to protect.
      -- COALESCE means: a 965 peer supplies the true origin time, an older peer
      -- supplies nothing and the local value stands.
      state_changed_at = COALESCE(EXCLUDED.state_changed_at, work_items.state_changed_at),
      -- admission is MONOTONIC (pending -> admitted/auto/unreviewed; no writer anywhere
      -- moves it back), so it is upserted with a floor rather than blindly:
      --
      --   * EXCLUDED NULL  => the op predates mig 965 (or the column really is NULL).
      --     Keep the local value. Taking NULL would read as ADMITTED at the claim gate
      --     and un-hide a born-pending item -- the exact bypass this column federates
      --     to close.
      --   * EXCLUDED 'pending' over a locally PROMOTED row => a peer that has not yet
      --     seen the promotion. Keep the promotion. The LWW guard below does not cover
      --     this: a LOCAL promotion does not restamp fed_ts/fed_hlc, so a later remote
      --     op legitimately outranks it in fed_order_key space and would re-hide work
      --     that was already judged.
      --   * otherwise => take the incoming value, including 'pending' over a NULL
      --     legacy row (hiding is the fail-safe direction, and it is what the origin
      --     asserts about the item).
      --
      -- admitted_at/admitted_by follow the SAME branch so the trio can never disagree
      -- about who promoted the row and when.
      admission = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admission
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admission
        ELSE EXCLUDED.admission
      END,
      admitted_at = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admitted_at
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admitted_at
        ELSE EXCLUDED.admitted_at
      END,
      admitted_by = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admitted_by
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admitted_by
        ELSE EXCLUDED.admitted_by
      END
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    -- WI-2923 (mig 504): at an EQUAL order key the WRITER tie-break decides —
    -- the bare ">=" applied unconditionally on ties, so two cells that each
    -- completed the same item in the same clock tick SWAPPED values on heal
    -- (each applied the other's write, echo suppression froze the swap, and
    -- convergence reported a fixed point over divergent replicas —
    -- composition-chaos P-002). fed_apply_wins breaks the tie by writer-pair
    -- when both are known, else by the SYMMETRIC content digest (local rows are
    -- author_pubkey-NULL by design, mig 214), so every replica settles on the
    -- same value in one exchange. The digest covers CONTENT columns only.
    --
    -- EI-16756: terminal_owner/terminal_completion_ref MUST be in this digest.
    -- They were originally omitted as "bookkeeping", but they are not — they are
    -- the completion-integrity attribution pair, and two DIFFERENT completions of
    -- the same item routinely converge to an IDENTICAL status/taken_by (terminal
    -- status, taken_by NULL) while carrying DIFFERENT terminal_owner/ref. With
    -- those two columns excluded, such ops hash to the SAME digest, so the tie
    -- branch's "equal digest ⇒ identical content ⇒ applying is a no-op" invariant
    -- is FALSE for them: a stale/racing peer completion can silently overwrite the
    -- correct completer's terminal_owner while every other field looks converged
    -- (observed live: a completion's terminalCompletionRef matched the caller's own
    -- text exactly, but terminalOwner was stamped as an unrelated peer who had
    -- earlier briefly held the same item).
    -- P-009/D-001: terminal_reason joins the digest for the SAME reason as the
    -- terminal_owner pair above — two completions can converge to an identical
    -- status (e.g. both 'done') while carrying a different terminal_reason
    -- (resolved vs plain-done), so excluding it would let a racing peer silently
    -- overwrite the correct terminal nuance under the "equal digest ⇒ no-op" tie.
    --
    -- mig 708 / EI-18785839681430807 (D-035): authority joins the digest for the
    -- SAME reason — two racing completions can converge to an identical
    -- status/taken_by/terminal_owner while carrying a DIFFERENT authority (an
    -- evidence-backed 'committed' vs a racing under-evidenced 'proposed').
    -- WARNING: SINGLE quotes, never backticks. This comment lives INSIDE a
    -- tagged sql template literal, so a backtick here CLOSES the template and
    -- the whole module stops PARSING (TS1005/TS1443) -- a hard compile failure
    -- for every consumer and a red green-gate for the whole fleet, not a style
    -- nit. It landed here AND in the sibling projections/harness-features.ts in
    -- the same edit; run: npm run lint:no-sql-comment-backtick
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, EXCLUDED.author_pubkey,
            md5(concat_ws('|', EXCLUDED.item_kind, EXCLUDED.title, EXCLUDED.summary,
                          EXCLUDED.status, EXCLUDED.taken_by, EXCLUDED.payload::text,
                          EXCLUDED.terminal_owner, EXCLUDED.terminal_completion_ref,
                          EXCLUDED.terminal_reason, EXCLUDED.authority)),
            work_items.fed_hlc, work_items.fed_ts, work_items.author_pubkey,
            md5(concat_ws('|', work_items.item_kind, work_items.title, work_items.summary,
                          work_items.status, work_items.taken_by, work_items.payload::text,
                          work_items.terminal_owner, work_items.terminal_completion_ref,
                          work_items.terminal_reason, work_items.authority)))
      -- EI-22581437944679741: a later remote OPEN snapshot is not proof that a
      -- terminal row was deliberately reopened. The local lifecycle writer records
      -- an explicit reopen by appending the exact displaced completion to the newest
      -- payload.reopenHistory entry. Require that proof atomically here; a peer that
      -- never observed the close otherwise erases the terminal result merely because
      -- its unrelated edit has a later federation clock.
      AND (
        EXCLUDED.origin IS DISTINCT FROM 'remote'
        OR NOT (
          work_items.status = ANY(${FEDERATED_TERMINAL_STATES}::text[])
          AND NOT (EXCLUDED.status = ANY(${FEDERATED_TERMINAL_STATES}::text[]))
        )
        OR (
          jsonb_typeof(EXCLUDED.payload -> 'reopenHistory' -> -1) = 'object'
          AND NULLIF(btrim(EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'at'), '') IS NOT NULL
          AND NULLIF(btrim(EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'by'), '') IS NOT NULL
          AND jsonb_typeof(EXCLUDED.payload -> 'reopenHistory' -> -1 -> 'force') = 'boolean'
          AND EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'prevState' = work_items.status
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'terminalOwner')
                IS NOT DISTINCT FROM work_items.terminal_owner
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'terminalCompletionRef')
                IS NOT DISTINCT FROM work_items.terminal_completion_ref
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'completionAuthority')
                IS NOT DISTINCT FROM work_items.authority
          AND NULLIF(
                EXCLUDED.payload -> 'reopenHistory' -> -1 -> 'terminalCompletionEvidence',
                'null'::jsonb
              ) IS NOT DISTINCT FROM (work_items.payload -> '_completionEvidence')
          AND NULLIF(
                EXCLUDED.payload -> 'reopenHistory' -> -1 -> 'assumptions',
                'null'::jsonb
              ) IS NOT DISTINCT FROM (work_items.payload -> '_assumptions')
          -- A prior reopen retained on a re-closed row is not authority to reopen
          -- it again. The lifecycle writer always appends a fresh newest entry.
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1) IS DISTINCT FROM
              (work_items.payload -> 'reopenHistory' -> -1)
        )
      )
    `;
  } catch (error) {
    // The physical-row ON CONFLICT above cannot arbitrate migration 865's
    // separate partial unique index. A historical terminal row can therefore
    // receive a stale remote PUT that tries to reopen it while a newer live row
    // already owns the same watchdog identity. Retrying that deterministic
    // 23505 forever pins every per-harness merge cursor on the same op.
    //
    // Recover only the named index and only after the complete incoming
    // identity resolves to exactly one different non-terminal row. That row is
    // the already-coalesced logical signal, so the obsolete physical-row PUT is
    // a no-op. Any missing/malformed component, lookup failure, or other 23505
    // rethrows the original error and remains visible to the merge retry path.
    if (!isWatchdogIdentityConflict(error)) throw error;
    const identity = watchdogIdentityFromPayload(row.payload);
    if (!identity) throw error;
    let winnerId: string | null;
    try {
      winnerId = await findWatchdogIdentityWinner(sql, opts.workspaceId, vSlug, row.issue_id, identity);
    } catch {
      throw error;
    }
    if (!winnerId) throw error;
    console.warn(
      `[engineer-issues projection] coalesced stale watchdog replay issue_id=${row.issue_id} ` +
        `onto existing non-terminal winner=${winnerId} (harness_slug=${vSlug}, ` +
        `watchdogKey=${identity.watchdogKey}, signal_origin=${identity.signalOrigin}, lane=${identity.lane}); ` +
        `remote PUT treated as no-op`,
    );
  }
}

async function deleteFromPg(
  opts: EngineerIssuesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  const parsed = parseEngineerIssueKey(key);
  const storageHarnessSlug = parsed?.storageHarnessSlug ?? opts.harnessSlug;
  const issueId = parsed?.issueId ?? key;
  // Author-scoped tombstones must never widen into an unscoped delete when a
  // legacy/direct caller omits the provenance context. The canonical apply
  // path always supplies it; refusing here protects direct callers and keeps
  // the authorization boundary fail-closed.
  if (!provenance) return;
  const authorPubkey = provenance.authorPubkey;
  await sql`
    DELETE FROM harness_shared.work_items
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${storageHarnessSlug}
      AND feature_id = ${issueId}
      AND item_kind IN ('bug', 'change', 'task')
      -- Remote tombstones may delete only the row materialised from that same
      -- source log.  This makes every pre-829 bare-key replay fail closed instead
      -- of erasing a same-id local/sibling row (the migration-826 incident).
      AND author_pubkey = ${authorPubkey}
      -- ts-guard the delete (a stale del must not erase a newer row).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildEngineerIssuesProjection(opts: EngineerIssuesProjectionOpts): TableProjection<EngineerIssueRow> {
  return {
    tableTag: 'engineer-issues',
    // EI-117: CDC-captured table (mig 197 custom capture) — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc, provenance) => deleteFromPg(opts, key, delTs, delHlc, provenance),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isEngineerIssueRow,
};
