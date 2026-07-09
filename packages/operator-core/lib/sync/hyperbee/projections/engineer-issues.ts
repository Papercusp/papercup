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

/** Wire-shape of an engineer_issues row in Hyperbee — the federated subset plus the
 *  capture-stamped `harness_slug` (the demux key). Defensive on every field. */
export interface EngineerIssueRow {
  /** The federation slug stamped by the capture trigger (the per-harness demux key). */
  harness_slug: string;
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
   * work-item-completion-integrity-2026-07-01 (WI-1403 / EI-5269): the "who did
   * it + what proves it" pair recorded at the terminal-state choke point. OPTIONAL
   * on the wire (pre-432 history lacks them → dropped on write → NULL).
   */
  terminal_owner?: string | null;
  terminal_completion_ref?: string | null;
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
  if (r.terminal_owner !== undefined && !isStringOrNull(r.terminal_owner)) return false;
  if (r.terminal_completion_ref !== undefined && !isStringOrNull(r.terminal_completion_ref)) return false;
  // payload is jsonb-opaque — accept anything (incl. undefined → null on write).
  return true;
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
  return row.issue_id;
}

function decodeValue(raw: unknown): EngineerIssueRow | null {
  return isEngineerIssueRow(raw) ? raw : null;
}

async function writeToPg(
  opts: EngineerIssuesProjectionOpts,
  row: EngineerIssueRow,
  provenance?: ProvenanceContext,
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
  const origin = provenance?.origin ?? 'local';
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
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, summary, status,
       taken_by, taken_at, payload, author_pubkey, origin, fed_ts, fed_hlc,
       created_ts, updated_ts, ts, terminal_owner, terminal_completion_ref)
    VALUES
      (${opts.workspaceId}, ${vSlug}, ${row.issue_id}, ${row.kind}, ${row.title},
       ${row.body}, ${row.state}, ${row.assignee}, ${row.assigned_at},
       ${payloadText}::text::jsonb, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc},
       COALESCE((extract(epoch FROM ${row.created_at}::timestamptz) * 1000)::bigint,
                (extract(epoch FROM now()) * 1000)::bigint),
       (extract(epoch FROM now()) * 1000)::bigint,
       (extract(epoch FROM now()) * 1000)::bigint,
       ${row.terminal_owner ?? null}, ${row.terminal_completion_ref ?? null})
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
      terminal_completion_ref = EXCLUDED.terminal_completion_ref
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
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, EXCLUDED.author_pubkey,
            md5(concat_ws('|', EXCLUDED.item_kind, EXCLUDED.title, EXCLUDED.summary,
                          EXCLUDED.status, EXCLUDED.taken_by, EXCLUDED.payload::text)),
            work_items.fed_hlc, work_items.fed_ts, work_items.author_pubkey,
            md5(concat_ws('|', work_items.item_kind, work_items.title, work_items.summary,
                          work_items.status, work_items.taken_by, work_items.payload::text)))
  `;
}

async function deleteFromPg(
  opts: EngineerIssuesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.work_items
    WHERE workspace_id = ${opts.workspaceId}
      AND feature_id = ${key}
      AND item_kind IN ('bug', 'change', 'task')
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
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isEngineerIssueRow,
};
