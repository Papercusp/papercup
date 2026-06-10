/**
 * Hyperbee → PG projection for `harness_shared.plan_item_assignments`.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 0 federation, D-002).
 *
 * The ASSIGNMENT half of "who's doing this" is durable, low-churn, shared-knowledge,
 * so it federates as CONTENT over the same peer-log machinery as features/issues/
 * plans (a later assignment legitimately wins under LWW on this small per-item
 * record). The CLAIM half (plan_item_claims) is authority-mediated and NEVER
 * federated — it has no projection.
 *
 * The per-harness Hyperbee key is `<plan_slug>:<item_id>` (the table's generated
 * `fed_key` column, which the capture trigger writes as the outbox key). Federated
 * fields = the assignment document: assignee_name / assigned_by_user / assigned_ts /
 * released_ts / strategy / note. NOT federated (machine-local): workspace_id (the
 * projection binds it), created_at/updated_at, fed_key (regenerated), origin/
 * author_pubkey (stamped on apply). No jsonb columns → no jsonb-binding dance.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface PlanItemAssignmentRow {
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  assignee_name: string | null;
  assigned_by_user: string | null;
  assigned_ts: string | null; // ISO string (timestamptz under to_jsonb)
  released_ts: string | null; // ISO string; null = active assignment
  strategy: string | null;
  note: string | null;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isPlanItemAssignmentRow(input: unknown): input is PlanItemAssignmentRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.plan_slug !== 'string' || r.plan_slug.length === 0) return false;
  if (typeof r.item_id !== 'string' || r.item_id.length === 0) return false;
  return (
    isStringOrNull(r.assignee_name) &&
    isStringOrNull(r.assigned_by_user) &&
    isStringOrNull(r.assigned_ts) &&
    isStringOrNull(r.released_ts) &&
    isStringOrNull(r.strategy) &&
    isStringOrNull(r.note)
  );
}

export interface PlanItemAssignmentsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
}

/** Per-harness Hyperbee key == `<plan_slug>:<item_id>` (the table's fed_key). */
export function composeAssignmentKey(planSlug: string, itemId: string): string {
  return `${planSlug}:${itemId}`;
}

function composeKey(row: PlanItemAssignmentRow): string {
  return composeAssignmentKey(row.plan_slug, row.item_id);
}

function decodeValue(raw: unknown): PlanItemAssignmentRow | null {
  return isPlanItemAssignmentRow(raw) ? raw : null;
}

async function writeToPg(
  opts: PlanItemAssignmentsProjectionOpts,
  row: PlanItemAssignmentRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  await sql`
    INSERT INTO harness_shared.plan_item_assignments
      (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user,
       assigned_ts, released_ts, strategy, note, author_pubkey, origin, fed_ts)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.plan_slug}, ${row.item_id},
       ${row.assignee_name}, ${row.assigned_by_user}, ${row.assigned_ts}, ${row.released_ts},
       ${row.strategy}, ${row.note}, ${authorPubkey}, ${origin}, ${fedTs})
    ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO UPDATE SET
      assignee_name    = EXCLUDED.assignee_name,
      assigned_by_user = EXCLUDED.assigned_by_user,
      assigned_ts      = EXCLUDED.assigned_ts,
      released_ts      = EXCLUDED.released_ts,
      strategy         = EXCLUDED.strategy,
      note             = EXCLUDED.note,
      author_pubkey    = EXCLUDED.author_pubkey,
      origin           = EXCLUDED.origin,
      fed_ts           = EXCLUDED.fed_ts
    -- EI-79 step 2: PG-level LWW guard — drop a strictly-older op.
    WHERE plan_item_assignments.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= plan_item_assignments.fed_ts
  `;
}

async function deleteFromPg(
  opts: PlanItemAssignmentsProjectionOpts,
  key: string,
  delTs?: number,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  // key == '<plan_slug>:<item_id>'; item_id has no colon, so split on the LAST ':'.
  const cut = key.lastIndexOf(':');
  if (cut <= 0) return;
  const planSlug = key.slice(0, cut);
  const itemId = key.slice(cut + 1);
  if (!planSlug || !itemId) return;
  const ts = delTs ?? null;
  await sql`
    DELETE FROM harness_shared.plan_item_assignments
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND plan_slug = ${planSlug}
      AND item_id = ${itemId}
      -- EI-79 step 2: ts-guard the delete (a stale del must not erase a newer row).
      AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint)
  `;
}

export function buildPlanItemAssignmentsProjection(
  opts: PlanItemAssignmentsProjectionOpts,
): TableProjection<PlanItemAssignmentRow> {
  return {
    tableTag: 'item-assignments',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs) => deleteFromPg(opts, key, delTs),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isPlanItemAssignmentRow,
};
