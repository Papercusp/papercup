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
  // payload is jsonb-opaque — accept anything (incl. undefined → null on write).
  return true;
}

export interface EngineerIssuesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
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
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  // payload: bind via JSON.stringify(x)::text::jsonb — sql.json THROWS under the
  // getOrgPg runtime client (agent-insights/postgres-js-jsonb-binding). null stays null.
  const payloadText = row.payload == null ? null : JSON.stringify(row.payload);
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, kind, title, body, severity, source, state,
       assignee, assigned_by, assigned_at, payload, found_during, linked_feature_id,
       created_by, created_at, updated_at, author_pubkey, origin, fed_ts)
    VALUES
      (${opts.workspaceId}, ${row.issue_id}, ${row.scope}, ${row.kind}, ${row.title},
       ${row.body}, ${row.severity}, ${row.source}, ${row.state},
       ${row.assignee}, ${row.assigned_by}, ${row.assigned_at}, ${payloadText}::text::jsonb,
       ${row.found_during}, ${row.linked_feature_id}, ${row.created_by},
       ${row.created_at}, now(), ${authorPubkey}, ${origin}, ${fedTs})
    ON CONFLICT (workspace_id, issue_id) DO UPDATE SET
      scope             = EXCLUDED.scope,
      kind              = EXCLUDED.kind,
      title             = EXCLUDED.title,
      body              = EXCLUDED.body,
      severity          = EXCLUDED.severity,
      source            = EXCLUDED.source,
      state             = EXCLUDED.state,
      assignee          = EXCLUDED.assignee,
      assigned_by       = EXCLUDED.assigned_by,
      assigned_at       = EXCLUDED.assigned_at,
      payload           = EXCLUDED.payload,
      found_during      = EXCLUDED.found_during,
      linked_feature_id = EXCLUDED.linked_feature_id,
      created_by        = EXCLUDED.created_by,
      updated_at        = now(),
      author_pubkey     = EXCLUDED.author_pubkey,
      origin            = EXCLUDED.origin,
      fed_ts            = EXCLUDED.fed_ts
    -- PG-level LWW guard — drop a strictly-older op (created_at is immutable, preserved).
    WHERE harness_shared.engineer_issues.fed_ts IS NULL
       OR EXCLUDED.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= harness_shared.engineer_issues.fed_ts
  `;
}

async function deleteFromPg(
  opts: EngineerIssuesProjectionOpts,
  key: string,
  delTs?: number,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  await sql`
    DELETE FROM harness_shared.engineer_issues
    WHERE workspace_id = ${opts.workspaceId}
      AND issue_id = ${key}
      -- ts-guard the delete (a stale del must not erase a newer row).
      AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint)
  `;
}

export function buildEngineerIssuesProjection(
  opts: EngineerIssuesProjectionOpts,
): TableProjection<EngineerIssueRow> {
  return {
    tableTag: 'engineer-issues',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs) => deleteFromPg(opts, key, delTs),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isEngineerIssueRow,
};
