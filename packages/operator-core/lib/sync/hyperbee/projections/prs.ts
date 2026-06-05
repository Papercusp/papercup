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
import type { TableProjection } from '../projection';

export interface HarnessFeaturePrRow {
  harness_slug: string;
  feature_id: string;
  pr_url: string;
  pr_state: string;             // 'open' | 'merged' | 'closed' | 'unknown' — opaque to projection
  opened_ts: number;            // epoch ms; 0 = unknown
  updated_ts: number;
}

export interface PrsProjectionOpts {
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

async function writeToPg(opts: PrsProjectionOpts, row: HarnessFeaturePrRow): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.harness_feature_prs
      (workspace_id, harness_slug, feature_id, pr_url, pr_state, opened_ts, updated_ts)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.feature_id},
       ${row.pr_url}, ${row.pr_state}, ${row.opened_ts}, ${row.updated_ts})
    ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE SET
      pr_url = EXCLUDED.pr_url,
      pr_state = EXCLUDED.pr_state,
      opened_ts = EXCLUDED.opened_ts,
      updated_ts = EXCLUDED.updated_ts
  `;
}

async function deleteFromPg(opts: PrsProjectionOpts, key: string): Promise<void> {
  if (!key) return;
  const { sql } = getOrgPg();
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
    writeToPg: (row) => writeToPg(opts, row),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessFeaturePrRow,
};
