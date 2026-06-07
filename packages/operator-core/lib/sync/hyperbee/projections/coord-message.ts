/**
 * Hyperbee → PG projection for `harness_shared.coord_event_log` (the coordination
 * message rail).
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A, surface #1).
 * A HARNESS-SCOPED original coord_event_log row (surface messages|handoffs|
 * escalations, harness_slug set, NOT a fan-out delivery copy) federates over the
 * harness's peer-log. The per-harness Hyperbee key is the globally-unique
 * `msg_id`. On the remote machine the row lands in coord_event_log and the
 * recipient's coord:inbox read finds it by the envelope `to[]` — no separate
 * fan-out (fan-out delivery copies are local per-machine state, D-002, and are
 * excluded by the capture trigger's notify_kind filter).
 *
 * Federated fields = the row's CONTENT: surface, writer_key, the `body` envelope
 * (jsonb), the timestamp, harness_slug. NOT federated (machine-local): the
 * bigserial `id` (a fresh local id is assigned on apply) and `workspace_id` (the
 * local projection's bound workspace).
 *
 * `ts` is wired as epoch-ms (the op-key reshape converts the to_jsonb ISO string)
 * and written back via to_timestamp.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/** The coord_event_log surfaces that federate (plan-events stay local — plans
 *  federate via harness_plans). */
const FEDERATED_SURFACES = new Set(['messages', 'handoffs', 'escalations']);

/** Wire-shape of a federated coord_event_log row. */
export interface CoordMessageRow {
  harness_slug: string;
  msg_id: string;
  surface: string;                  // 'messages' | 'handoffs' | 'escalations'
  writer_key: string | null;
  body: Record<string, unknown>;    // the CoordEnvelope
  ts: number;                       // epoch ms
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isCoordMessageRow(input: unknown): input is CoordMessageRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.msg_id) || r.msg_id.length === 0) return false;
  if (!isString(r.surface) || !FEDERATED_SURFACES.has(r.surface)) return false;
  if (!isStringOrNull(r.writer_key)) return false;
  if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body)) return false;
  // A fan-out delivery copy must never federate — defensive double of the
  // capture trigger's notify_kind filter.
  if ((r.body as Record<string, unknown>).notify_kind != null) return false;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return false;
  return true;
}

function decodeValue(raw: unknown): CoordMessageRow | null {
  return isCoordMessageRow(raw) ? raw : null;
}

export interface CoordMessageProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of the global getOrgPg().sql. */
  sql?: postgres.Sql;
}

function composeKey(row: CoordMessageRow): string {
  return row.msg_id;
}

async function writeToPg(
  opts: CoordMessageProjectionOpts,
  row: CoordMessageRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? row.ts ?? null;
  // workspace_id is the LOCAL projection's bound workspace; id is a fresh local
  // bigserial. ON CONFLICT targets the partial fed unique index (ws, msg_id)
  // over the federated subset — msg_id is globally unique so this updates the one
  // existing row (never violating the separate event_uq).
  await sql`
    INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, writer_key, msg_id, body, harness_slug,
       ts, origin, author_pubkey, fed_ts)
    VALUES
      (${opts.workspaceId}, ${row.surface}, ${row.writer_key}, ${row.msg_id},
       ${JSON.stringify(row.body)}::text::jsonb, ${row.harness_slug},
       to_timestamp(${row.ts} / 1000.0), ${origin}, ${authorPubkey}, ${fedTs})
    ON CONFLICT (workspace_id, msg_id)
      WHERE harness_slug IS NOT NULL AND (body->>'notify_kind') IS NULL
    DO UPDATE SET
      surface       = EXCLUDED.surface,
      writer_key    = EXCLUDED.writer_key,
      body          = EXCLUDED.body,
      ts            = EXCLUDED.ts,
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey,
      fed_ts        = EXCLUDED.fed_ts
    -- EI-79 step 2: PG-level LWW guard — drop a strictly-older op.
    WHERE coord_event_log.fed_ts IS NULL
       OR EXCLUDED.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= coord_event_log.fed_ts
  `;
}

async function deleteFromPg(
  opts: CoordMessageProjectionOpts,
  key: string,
  delTs?: number,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  await sql`
    DELETE FROM harness_shared.coord_event_log
    WHERE workspace_id = ${opts.workspaceId}
      AND msg_id = ${key}
      AND harness_slug = ${opts.harnessSlug}
      -- EI-79 step 2: ts-guard the delete (a stale del must not erase a newer row).
      AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint)
  `;
}

export function buildCoordMessageProjection(
  opts: CoordMessageProjectionOpts,
): TableProjection<CoordMessageRow> {
  return {
    tableTag: 'coord-messages',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs) => deleteFromPg(opts, key, delTs),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isCoordMessageRow,
  FEDERATED_SURFACES,
};
