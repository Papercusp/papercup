/**
 * Hyperbee → PG projection for `harness_shared.contributor_usage_events`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031
 * + P-070 (the addendum-3 D-027 usage-events ledger).
 *
 * Append-only. Source of truth for all tier-C activity stats per v5
 * §17 — never store mutable counters on `contributors`; rollups
 * derive on read from this ledger.
 *
 * Hyperbee key per-harness: `<github_user_id>/<event_id>`.
 * PG primary key: `(harness_slug, event_id)`.
 *
 * `del` ops are silent no-ops — append-only contract.
 */

import { getOrgPg } from '@restart/db-org';
import type { TableProjection } from '../projection';

export interface ContributorUsageEventRow {
  harness_slug: string;
  event_id: string;
  github_user_id: number;
  device_pubkey: string;
  kind: string;
  ref_id: string | null;
  payload: unknown;                     // JSONB; opaque
  ts: number;                           // epoch ms
  schema_version: number;
}

export interface UsageProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
}

function composeKey(row: ContributorUsageEventRow): string {
  return `${row.github_user_id}/${row.event_id}`;
}

export function isContributorUsageEventRow(input: unknown): input is ContributorUsageEventRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' && r.harness_slug.length > 0 &&
    typeof r.event_id === 'string' && r.event_id.length > 0 &&
    typeof r.github_user_id === 'number' && Number.isInteger(r.github_user_id) && r.github_user_id > 0 &&
    typeof r.device_pubkey === 'string' && r.device_pubkey.length > 0 &&
    typeof r.kind === 'string' && r.kind.length > 0 &&
    (r.ref_id === null || typeof r.ref_id === 'string') &&
    typeof r.ts === 'number' && Number.isFinite(r.ts) &&
    typeof r.schema_version === 'number' && Number.isInteger(r.schema_version)
    // payload is JSONB-opaque
  );
}

function decodeValue(raw: unknown): ContributorUsageEventRow | null {
  return isContributorUsageEventRow(raw) ? raw : null;
}

async function writeToPg(opts: UsageProjectionOpts, row: ContributorUsageEventRow): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.contributor_usage_events
      (harness_slug, event_id, github_user_id, device_pubkey, kind, ref_id, payload, ts, schema_version)
    VALUES
      (${row.harness_slug}, ${row.event_id}, ${row.github_user_id}, ${row.device_pubkey},
       ${row.kind}, ${row.ref_id},
       ${row.payload == null ? null : sql.json(row.payload as unknown as Parameters<typeof sql.json>[0])},
       to_timestamp(${row.ts} / 1000.0),
       ${row.schema_version})
    ON CONFLICT (harness_slug, event_id) DO NOTHING
  `;
  // workspaceId captured for future partitioning of the ledger.
  void opts.workspaceId;
}

async function deleteFromPg(opts: UsageProjectionOpts, _key: string): Promise<void> {
  // Append-only: silent no-op on del.
  void opts;
  void _key;
}

export function buildUsageProjection(opts: UsageProjectionOpts): TableProjection<ContributorUsageEventRow> {
  return {
    tableTag: 'usage',
    composeKey,
    decodeValue,
    writeToPg: (row) => writeToPg(opts, row),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isContributorUsageEventRow,
};
