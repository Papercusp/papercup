/**
 * Hyperbee → PG projection for `harness_shared.coord_thread_posts`.
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A). A post on a
 * harness-scoped thread federates over the harness's peer-log. The per-harness
 * Hyperbee key is `post_msg_id` (a global newMsgId() the writer mints — the PK
 * `id` is a machine-local bigserial, not federation-safe).
 *
 * Federated fields = the post content (thread_id, author_id, body, created_at).
 * NOT federated: the bigserial `id` (a fresh local id is assigned on apply) and
 * `workspace_id` (the local projection's bound workspace).
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface CoordThreadPostRow {
  harness_slug: string;
  post_msg_id: string;
  thread_id: string;
  author_id: string | null;
  body: string;
  created_at: number;            // epoch ms
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isCoordThreadPostRow(input: unknown): input is CoordThreadPostRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.post_msg_id) || r.post_msg_id.length === 0) return false;
  if (!isString(r.thread_id) || r.thread_id.length === 0) return false;
  if (!(r.author_id === null || typeof r.author_id === 'string')) return false;
  if (!isString(r.body)) return false;
  if (typeof r.created_at !== 'number' || !Number.isFinite(r.created_at)) return false;
  return true;
}

function decodeValue(raw: unknown): CoordThreadPostRow | null {
  return isCoordThreadPostRow(raw) ? raw : null;
}

export interface CoordThreadPostProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  sql?: postgres.Sql;
}

function composeKey(row: CoordThreadPostRow): string {
  return row.post_msg_id;
}

async function writeToPg(
  opts: CoordThreadPostProjectionOpts,
  row: CoordThreadPostRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? row.created_at ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.coord_thread_posts
      (workspace_id, thread_id, author_id, body, created_at, post_msg_id, harness_slug, origin, author_pubkey, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.thread_id}, ${row.author_id}, ${row.body},
       to_timestamp(${row.created_at} / 1000.0), ${row.post_msg_id}, ${row.harness_slug}, ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, post_msg_id)
      WHERE harness_slug IS NOT NULL AND post_msg_id IS NOT NULL
    DO UPDATE SET
      thread_id     = EXCLUDED.thread_id,
      author_id     = EXCLUDED.author_id,
      body          = EXCLUDED.body,
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc
    -- EI-79 step 2 + D-001: PG-level LWW guard, ordered by the SAME HLC key the
    -- merge fold uses. When both ops carry an HLC, order by it; fall back to the
    -- wall-clock fed_ts guard when either side lacks one.
    WHERE (EXCLUDED.fed_hlc IS NOT NULL AND coord_thread_posts.fed_hlc IS NOT NULL
             AND EXCLUDED.fed_hlc >= coord_thread_posts.fed_hlc)
       OR ((EXCLUDED.fed_hlc IS NULL OR coord_thread_posts.fed_hlc IS NULL)
             AND (coord_thread_posts.fed_ts IS NULL OR EXCLUDED.fed_ts >= coord_thread_posts.fed_ts))
  `;
}

async function deleteFromPg(
  opts: CoordThreadPostProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.coord_thread_posts
    WHERE workspace_id = ${opts.workspaceId} AND post_msg_id = ${key}
      -- EI-79 step 2 + D-001: guard the delete by the SAME HLC-then-fed_ts order
      -- as the put guard (fall back to the ts-guard when either side lacks an HLC).
      AND (
        (${hlc}::text IS NOT NULL AND fed_hlc IS NOT NULL AND ${hlc}::text >= fed_hlc)
        OR ((${hlc}::text IS NULL OR fed_hlc IS NULL)
              AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint))
      )
  `;
}

export function buildCoordThreadPostProjection(
  opts: CoordThreadPostProjectionOpts,
): TableProjection<CoordThreadPostRow> {
  return {
    tableTag: 'coord-thread-posts',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isCoordThreadPostRow };
