/**
 * Hyperbee → PG projection for `harness_shared.shared_presence`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * One row per (workspace, harness, github_user_id, machine_label).
 * The Hyperbee key inside one harness's Hyperbee is
 * `<github_user_id>/<machine_label>` — matches v5 §7.1's
 * `presence/<github_user_id>/<machine_label>` shape after the
 * substrate's tag-prefix is stripped.
 *
 * Distinct from `coord_presence` (the operator-internal per-owner_id
 * dashboard presence). This is the shared, multi-engineer presence
 * surface: which contributors are looking at this harness right now,
 * from which machine, and what they're doing.
 *
 * LWW: ON CONFLICT DO UPDATE always overwrites (last writer wins on
 * the substrate's merge order). del-ops hard-delete the row.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface SharedPresenceRow {
  harness_slug: string;
  github_user_id: number;
  machine_label: string;
  device_pubkey: string;
  intent: string | null;
  current_view: string | null;
  last_seen_at: number;            // epoch ms
  schema_version: number;
}

export interface PresenceProjectionOpts {
  /** Test/multi-peer seam — write to THIS postgres-js client instead of the
   *  process-global `getOrgPg().sql`. Production leaves this undefined. */
  sql?: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
}

function composeKey(row: SharedPresenceRow): string {
  return `${row.github_user_id}/${row.machine_label}`;
}

export function isSharedPresenceRow(input: unknown): input is SharedPresenceRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' && r.harness_slug.length > 0 &&
    typeof r.github_user_id === 'number' && Number.isInteger(r.github_user_id) && r.github_user_id > 0 &&
    typeof r.machine_label === 'string' && r.machine_label.length > 0 &&
    typeof r.device_pubkey === 'string' && r.device_pubkey.length > 0 &&
    (r.intent === null || typeof r.intent === 'string') &&
    (r.current_view === null || typeof r.current_view === 'string') &&
    typeof r.last_seen_at === 'number' && Number.isFinite(r.last_seen_at) &&
    typeof r.schema_version === 'number' && Number.isInteger(r.schema_version)
  );
}

function decodeValue(raw: unknown): SharedPresenceRow | null {
  return isSharedPresenceRow(raw) ? raw : null;
}

async function writeToPg(
  opts: PresenceProjectionOpts,
  row: SharedPresenceRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const fedTs = provenance?.ts ?? null;
  await sql`
    INSERT INTO harness_shared.shared_presence
      (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey,
       intent, current_view, last_seen_at, schema_version, fed_ts)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.machine_label},
       ${row.device_pubkey}, ${row.intent}, ${row.current_view},
       to_timestamp(${row.last_seen_at} / 1000.0),
       ${row.schema_version}, ${fedTs})
    ON CONFLICT (workspace_id, harness_slug, github_user_id, machine_label) DO UPDATE SET
      device_pubkey = EXCLUDED.device_pubkey,
      intent = EXCLUDED.intent,
      current_view = EXCLUDED.current_view,
      last_seen_at = EXCLUDED.last_seen_at,
      schema_version = EXCLUDED.schema_version,
      fed_ts = EXCLUDED.fed_ts
    -- EI-79 step 2: PG-level LWW guard — drop a strictly-older op.
    WHERE shared_presence.fed_ts IS NULL
       OR EXCLUDED.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= shared_presence.fed_ts
  `;
}

async function deleteFromPg(opts: PresenceProjectionOpts, key: string): Promise<void> {
  // key shape: `<github_user_id>/<machine_label>`
  const sepIdx = key.indexOf('/');
  if (sepIdx <= 0) return;
  const userIdStr = key.slice(0, sepIdx);
  const machineLabel = key.slice(sepIdx + 1);
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId <= 0 || !machineLabel) return;
  const sql = opts.sql ?? getOrgPg().sql;
  await sql`
    DELETE FROM harness_shared.shared_presence
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      AND machine_label = ${machineLabel}
  `;
}

export function buildPresenceProjection(opts: PresenceProjectionOpts): TableProjection<SharedPresenceRow> {
  return {
    tableTag: 'presence',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isSharedPresenceRow,
};
