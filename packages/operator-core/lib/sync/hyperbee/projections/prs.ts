/**
 * Hyperbee → PG projection for `harness_shared.harness_feature_prs`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * One row per (harness, feature). Surfaces the current PR for a
 * feature — Phase 7 PrsTab + the poll daemon consume from here.
 *
 * Hyperbee key (per-harness): `<feature_id>`.
 * PG primary key: `(workspace_id, harness_slug, feature_id)`.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface HarnessFeaturePrRow {
  harness_slug: string;
  feature_id: string;
  pr_url: string;
  pr_state: string;             // 'open' | 'merged' | 'closed' | 'unknown' — opaque to projection
  opened_ts: number;            // epoch ms; 0 = unknown
  updated_ts: number;
}

export interface PrsProjectionOpts {
  /** Test/multi-peer seam — write to THIS postgres-js client instead of the
   *  process-global `getOrgPg().sql`. Production leaves this undefined. */
  sql?: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
}

function composeKey(row: HarnessFeaturePrRow): string {
  return row.feature_id;
}

export function isHarnessFeaturePrRow(input: unknown): input is HarnessFeaturePrRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' && r.harness_slug.length > 0 &&
    typeof r.feature_id === 'string' && r.feature_id.length > 0 &&
    typeof r.pr_url === 'string' && r.pr_url.length > 0 &&
    typeof r.pr_state === 'string' &&
    typeof r.opened_ts === 'number' && Number.isFinite(r.opened_ts) &&
    typeof r.updated_ts === 'number' && Number.isFinite(r.updated_ts)
  );
}

function decodeValue(raw: unknown): HarnessFeaturePrRow | null {
  return isHarnessFeaturePrRow(raw) ? raw : null;
}

async function writeToPg(
  opts: PrsProjectionOpts,
  row: HarnessFeaturePrRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const fedTs = provenance?.ts ?? null;
  await sql`
    INSERT INTO harness_shared.harness_feature_prs
      (workspace_id, harness_slug, feature_id, pr_url, pr_state, opened_ts, updated_ts, fed_ts)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.feature_id},
       ${row.pr_url}, ${row.pr_state}, ${row.opened_ts}, ${row.updated_ts}, ${fedTs})
    ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE SET
      pr_url = EXCLUDED.pr_url,
      pr_state = EXCLUDED.pr_state,
      opened_ts = EXCLUDED.opened_ts,
      updated_ts = EXCLUDED.updated_ts,
      fed_ts = EXCLUDED.fed_ts
    -- EI-79 step 2: PG-level LWW guard — drop a strictly-older op.
    WHERE harness_feature_prs.fed_ts IS NULL
       OR EXCLUDED.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= harness_feature_prs.fed_ts
  `;
}

async function deleteFromPg(opts: PrsProjectionOpts, key: string): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  await sql`
    DELETE FROM harness_shared.harness_feature_prs
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND feature_id = ${key}
  `;
}

export function buildPrsProjection(opts: PrsProjectionOpts): TableProjection<HarnessFeaturePrRow> {
  return {
    tableTag: 'prs',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessFeaturePrRow,
};
