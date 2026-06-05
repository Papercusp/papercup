/**
 * Hyperbee → PG projection for `harness_shared.coord_conversations`.
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A — federate
 * coordination content). A HARNESS-SCOPED conversation (scope='harness')
 * federates as harness content over the same peer-log machinery as
 * features/issues/plans. The per-harness Hyperbee key is the conversation `id`
 * ('conv-<…>', globally unique).
 *
 * Federated fields = the conversation's shared scalars: kind, the seed
 * question/discussion text (title/body), Lifecycle `state`, the captured
 * `accepted_answer`, `capture_target`, `promoted_issue_id`, and the
 * created/updated/resolved timestamps. NOT federated (machine-local):
 *   • `workspace_id` — the LOCAL projection's bound workspace (a remote
 *     conversation lands in the workspace this harness is bound to here).
 *   • `accepted_post_id` — a LOCAL bigserial → coord_thread_posts.id; the post
 *     ids differ per machine, so the pointer is meaningless cross-machine. The
 *     accepted ANSWER TEXT (`accepted_answer`) carries the content; the pointer
 *     stays NULL on a remote apply.
 *   • the reply timeline (coord_thread_posts), tags (coord_links) and
 *     subscriptions (coord_entity_subscriptions) — separate surfaces / local
 *     delivery state (D-002).
 *
 * Timestamps are wired as epoch-ms NUMBERS (the op-key reshape converts the
 * `to_jsonb` ISO strings) and written back via `to_timestamp`, mirroring
 * features' taken_at/expires_at.
 *
 * decodeValue validates the CHECK-constrained enums (kind/scope/state) so a
 * malformed remote op is DROPPED rather than crashing the projection loop on a
 * constraint violation.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/** Wire-shape of a federated harness-scoped conversation. */
export interface CoordConversationRow {
  harness_slug: string;
  id: string;
  kind: string;        // 'question' | 'discussion'
  scope: string;       // always 'harness' for a federated row
  asker_id: string;
  title: string | null;
  body: string;
  state: string;       // 'open' | 'resolved' | 'closed'
  accepted_answer: string | null;
  capture_target: string | null;
  promoted_issue_id: string | null;
  created_at: number;          // epoch ms
  updated_at: number;          // epoch ms
  resolved_at: number | null;  // epoch ms | null
}

const KINDS = new Set(['question', 'discussion']);
const STATES = new Set(['open', 'resolved', 'closed']);

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isCoordConversationRow(input: unknown): input is CoordConversationRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.id) || r.id.length === 0) return false;
  if (!isString(r.kind) || !KINDS.has(r.kind)) return false;
  // A federated conversation is by definition harness-scoped.
  if (r.scope !== 'harness') return false;
  if (!isString(r.asker_id) || r.asker_id.length === 0) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isString(r.body)) return false;
  if (!isString(r.state) || !STATES.has(r.state)) return false;
  if (!isStringOrNull(r.accepted_answer)) return false;
  if (!isStringOrNull(r.capture_target)) return false;
  if (!isStringOrNull(r.promoted_issue_id)) return false;
  if (!isFiniteNumber(r.created_at)) return false;
  if (!isFiniteNumber(r.updated_at)) return false;
  if (!(r.resolved_at === null || isFiniteNumber(r.resolved_at))) return false;
  return true;
}

export interface CoordConversationProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of the global getOrgPg().sql. */
  sql?: postgres.Sql;
}

function composeKey(row: CoordConversationRow): string {
  // Per-harness Hyperbee → key is just the conversation id.
  return row.id;
}

function decodeValue(raw: unknown): CoordConversationRow | null {
  return isCoordConversationRow(raw) ? raw : null;
}

async function writeToPg(
  opts: CoordConversationProjectionOpts,
  row: CoordConversationRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  // workspace_id is the LOCAL projection's bound workspace (not the sender's).
  // accepted_post_id is NOT federated (local bigserial) — NULL on insert,
  // preserved on update (the SET list omits it).
  await sql`
    INSERT INTO harness_shared.coord_conversations
      (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state,
       accepted_answer, capture_target, promoted_issue_id,
       created_at, updated_at, resolved_at, origin, author_pubkey)
    VALUES
      (${opts.workspaceId}, ${row.id}, ${row.kind}, 'harness', ${row.harness_slug}, ${row.asker_id},
       ${row.title}, ${row.body}, ${row.state}, ${row.accepted_answer}, ${row.capture_target},
       ${row.promoted_issue_id},
       to_timestamp(${row.created_at} / 1000.0),
       to_timestamp(${row.updated_at} / 1000.0),
       ${row.resolved_at === null ? null : sql`to_timestamp(${row.resolved_at} / 1000.0)`},
       ${origin}, ${authorPubkey})
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      kind              = EXCLUDED.kind,
      asker_id          = EXCLUDED.asker_id,
      title             = EXCLUDED.title,
      body              = EXCLUDED.body,
      state             = EXCLUDED.state,
      accepted_answer   = EXCLUDED.accepted_answer,
      capture_target    = EXCLUDED.capture_target,
      promoted_issue_id = EXCLUDED.promoted_issue_id,
      updated_at        = EXCLUDED.updated_at,
      resolved_at       = EXCLUDED.resolved_at,
      origin            = EXCLUDED.origin,
      author_pubkey     = EXCLUDED.author_pubkey
  `;
}

async function deleteFromPg(opts: CoordConversationProjectionOpts, key: string): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  await sql`
    DELETE FROM harness_shared.coord_conversations
    WHERE workspace_id = ${opts.workspaceId}
      AND id = ${key}
  `;
}

export function buildCoordConversationProjection(
  opts: CoordConversationProjectionOpts,
): TableProjection<CoordConversationRow> {
  return {
    tableTag: 'coord-conversations',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isCoordConversationRow,
};
