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
  /** The harness's home Hive slug (shared-hive-federation-2026-06-08 P-008/P-009),
   *  or null for a non-Hive harness. Denormalizes the membership onto each
   *  presence row so the per-Hive lock authority can scope by Hive
   *  (lockAuthorityForHive's `WHERE hive_slug=?`, mig 187) without a registry join
   *  on the hot path. Optional on DECODE so pre-P-008 peer-log rows (which lack
   *  it) still validate; the presence publisher stamps it (resolved via
   *  hiveHomeSlugForHarness) at announce time. */
  hive_slug?: string | null;
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
    typeof r.schema_version === 'number' && Number.isInteger(r.schema_version) &&
    // hive_slug is optional (absent on pre-P-008 rows) + nullable (non-Hive harness).
    (r.hive_slug === undefined || r.hive_slug === null || typeof r.hive_slug === 'string')
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
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.shared_presence
      (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey,
       intent, current_view, last_seen_at, schema_version, hive_slug, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.machine_label},
       ${row.device_pubkey}, ${row.intent}, ${row.current_view},
       to_timestamp(${row.last_seen_at} / 1000.0),
       ${row.schema_version}, ${row.hive_slug ?? null}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, github_user_id, machine_label) DO UPDATE SET
      device_pubkey = EXCLUDED.device_pubkey,
      intent = EXCLUDED.intent,
      current_view = EXCLUDED.current_view,
      last_seen_at = EXCLUDED.last_seen_at,
      schema_version = EXCLUDED.schema_version,
      hive_slug = EXCLUDED.hive_slug,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc
    -- EI-79 step 2 + D-001: PG-level LWW guard, ordered by the SAME HLC key the
    -- merge fold uses; fall back to wall-clock fed_ts when either side lacks one.
    WHERE (EXCLUDED.fed_hlc IS NOT NULL AND shared_presence.fed_hlc IS NOT NULL
             AND EXCLUDED.fed_hlc >= shared_presence.fed_hlc)
       OR ((EXCLUDED.fed_hlc IS NULL OR shared_presence.fed_hlc IS NULL)
             AND (shared_presence.fed_ts IS NULL OR EXCLUDED.fed_ts >= shared_presence.fed_ts))
  `;
}

async function deleteFromPg(
  opts: PresenceProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  // key shape: `<github_user_id>/<machine_label>`
  const sepIdx = key.indexOf('/');
  if (sepIdx <= 0) return;
  const userIdStr = key.slice(0, sepIdx);
  const machineLabel = key.slice(sepIdx + 1);
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId <= 0 || !machineLabel) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.shared_presence
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      AND machine_label = ${machineLabel}
      -- EI-79 step 2 + D-001: guard the delete by the SAME HLC-then-fed_ts order
      -- as the put guard; fall back to the ts-guard when either side lacks an HLC.
      AND (
        (${hlc}::text IS NOT NULL AND fed_hlc IS NOT NULL AND ${hlc}::text >= fed_hlc)
        OR ((${hlc}::text IS NULL OR fed_hlc IS NULL)
              AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint))
      )
  `;
}

export function buildPresenceProjection(opts: PresenceProjectionOpts): TableProjection<SharedPresenceRow> {
  return {
    tableTag: 'presence',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isSharedPresenceRow,
};
