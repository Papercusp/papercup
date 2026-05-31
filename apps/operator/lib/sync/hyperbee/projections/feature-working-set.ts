/**
 * Hyperbee → PG projection for `harness_shared.feature_working_set`.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-038
 * (manual "set active") + v5 §0.5 working_users.
 *
 * Per-user "actively working" pointer table. Same key shape as
 * feature_queue (`<github_user_id>/<feature_id>` inside one harness's
 * Hyperbee; PG PK is `(workspace_id, harness_slug, github_user_id,
 * feature_id)`).
 *
 * Soft-delete shape: `cleared_at` flips null → epoch ms when the user
 * stops working. A `put` with `cleared_at != null` is the tombstone;
 * a `del` op is a hard DELETE. Same dual-support as feature_queue.
 *
 * Semantics vs neighbors:
 *   - feature_queue   = "I intend to work on this" (queue membership).
 *   - feature_working_set = "I am working on this NOW" (this table).
 *   - harness_features.claims = orchestrator worker dispatch (machine).
 * The orchestrator's claim-eligibility check excludes any feature with
 * a non-empty working set (P-038b).
 */

import { getOrgPg } from '@papercusp/db-org';
import type { TableProjection } from '../projection';

export interface FeatureWorkingSetRow {
  harness_slug: string;
  github_user_id: number;
  feature_id: string;
  started_at: number; // epoch ms
  cleared_at: number | null; // null = still active
  schema_version: number;
}

export interface FeatureWorkingSetProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
}

export function composeFeatureWorkingSetKey(
  githubUserId: number,
  featureId: string,
): string {
  return `${githubUserId}/${featureId}`;
}

function composeKey(row: FeatureWorkingSetRow): string {
  return composeFeatureWorkingSetKey(row.github_user_id, row.feature_id);
}

export function isFeatureWorkingSetRow(input: unknown): input is FeatureWorkingSetRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.github_user_id === 'number' &&
    Number.isInteger(r.github_user_id) &&
    r.github_user_id > 0 &&
    typeof r.feature_id === 'string' &&
    r.feature_id.length > 0 &&
    typeof r.started_at === 'number' &&
    Number.isFinite(r.started_at) &&
    (r.cleared_at === null ||
      (typeof r.cleared_at === 'number' && Number.isFinite(r.cleared_at))) &&
    typeof r.schema_version === 'number' &&
    Number.isInteger(r.schema_version)
  );
}

function decodeValue(raw: unknown): FeatureWorkingSetRow | null {
  return isFeatureWorkingSetRow(raw) ? raw : null;
}

async function writeToPg(
  opts: FeatureWorkingSetProjectionOpts,
  row: FeatureWorkingSetRow,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.feature_working_set
      (workspace_id, harness_slug, github_user_id, feature_id, started_at, cleared_at, schema_version)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.feature_id},
       to_timestamp(${row.started_at} / 1000.0),
       ${row.cleared_at == null ? null : sql`to_timestamp(${row.cleared_at} / 1000.0)`},
       ${row.schema_version})
    ON CONFLICT (workspace_id, harness_slug, github_user_id, feature_id) DO UPDATE SET
      started_at = EXCLUDED.started_at,
      cleared_at = EXCLUDED.cleared_at,
      schema_version = EXCLUDED.schema_version
  `;
}

async function deleteFromPg(
  opts: FeatureWorkingSetProjectionOpts,
  key: string,
): Promise<void> {
  // key shape: `<github_user_id>/<feature_id>`
  const sepIdx = key.indexOf('/');
  if (sepIdx <= 0) return;
  const userIdStr = key.slice(0, sepIdx);
  const featureId = key.slice(sepIdx + 1);
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId <= 0 || !featureId) return;
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.feature_working_set
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      AND feature_id = ${featureId}
  `;
}

export function buildFeatureWorkingSetProjection(
  opts: FeatureWorkingSetProjectionOpts,
): TableProjection<FeatureWorkingSetRow> {
  return {
    tableTag: 'working-set',
    composeKey,
    decodeValue,
    writeToPg: (row) => writeToPg(opts, row),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isFeatureWorkingSetRow,
};
