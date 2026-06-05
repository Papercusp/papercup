/**
 * Hyperbee → PG projection for `harness_shared.coord_threads`.
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A). A
 * harness-scoped thread (the reply timeline of a harness conversation) federates
 * over the harness's peer-log. The per-harness Hyperbee key is the `thread_id`,
 * which is DETERMINISTIC from the parent (`thr-<conversationId>`) so every machine
 * converges on one canonical thread per parent (the coord_threads parent-unique
 * index would otherwise reject a peer's thread under a federation race).
 *
 * Federated fields = the thread header (parent, title, created_by, created_at,
 * last_post_at, post_count). The remote applies federated POSTS via the
 * coord-thread-post projection (which does not bump post_count), so post_count
 * rides this header. NOT federated: workspace_id (local bound).
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface CoordThreadRow {
  harness_slug: string;
  thread_id: string;
  parent_kind: string;
  parent_ref: string;
  title: string | null;
  created_by: string | null;
  created_at: number;            // epoch ms
  last_post_at: number | null;   // epoch ms | null
  post_count: number;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isCoordThreadRow(input: unknown): input is CoordThreadRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.thread_id) || r.thread_id.length === 0) return false;
  if (!isString(r.parent_kind) || r.parent_kind.length === 0) return false;
  if (!isString(r.parent_ref) || r.parent_ref.length === 0) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isStringOrNull(r.created_by)) return false;
  if (typeof r.created_at !== 'number' || !Number.isFinite(r.created_at)) return false;
  if (!(r.last_post_at === null || (typeof r.last_post_at === 'number' && Number.isFinite(r.last_post_at)))) return false;
  if (typeof r.post_count !== 'number' || !Number.isInteger(r.post_count)) return false;
  return true;
}

function decodeValue(raw: unknown): CoordThreadRow | null {
  return isCoordThreadRow(raw) ? raw : null;
}

export interface CoordThreadProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  sql?: postgres.Sql;
}

function composeKey(row: CoordThreadRow): string {
  return row.thread_id;
}

async function writeToPg(
  opts: CoordThreadProjectionOpts,
  row: CoordThreadRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  await sql`
    INSERT INTO harness_shared.coord_threads
      (workspace_id, thread_id, parent_kind, parent_ref, title, created_by, created_at,
       last_post_at, post_count, harness_slug, origin, author_pubkey)
    VALUES
      (${opts.workspaceId}, ${row.thread_id}, ${row.parent_kind}, ${row.parent_ref}, ${row.title},
       ${row.created_by}, to_timestamp(${row.created_at} / 1000.0),
       ${row.last_post_at === null ? null : sql`to_timestamp(${row.last_post_at} / 1000.0)`},
       ${row.post_count}, ${row.harness_slug}, ${origin}, ${authorPubkey})
    ON CONFLICT (workspace_id, thread_id) DO UPDATE SET
      parent_kind   = EXCLUDED.parent_kind,
      parent_ref    = EXCLUDED.parent_ref,
      title         = EXCLUDED.title,
      created_by    = EXCLUDED.created_by,
      last_post_at  = EXCLUDED.last_post_at,
      post_count    = EXCLUDED.post_count,
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey
  `;
}

async function deleteFromPg(opts: CoordThreadProjectionOpts, key: string): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  await sql`
    DELETE FROM harness_shared.coord_threads
    WHERE workspace_id = ${opts.workspaceId} AND thread_id = ${key}
  `;
}

export function buildCoordThreadProjection(
  opts: CoordThreadProjectionOpts,
): TableProjection<CoordThreadRow> {
  return {
    tableTag: 'coord-threads',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = { composeKey, decodeValue, isCoordThreadRow };
