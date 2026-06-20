/**
 * Hyperbee → PG projection for `harness_shared.feature_queue`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Per-user feature-queue pointer table. The Hyperbee key inside one
 * harness's Hyperbee is `<github_user_id>/<feature_id>` (the harness
 * is implicit per-Hyperbee). PG primary key is
 * `(workspace_id, harness_slug, github_user_id, feature_id)`.
 *
 * Soft-delete shape: `removed_at` flips from null → epoch ms when a
 * user dequeues. The projection treats `del` ops as hard-deletes
 * (full DELETE), while a `put` with `removed_at != null` is the
 * soft-delete tombstone shape — both supported per the v5 spec.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { shouldApplyMemberContentOp } from '../member-content-guard';

export interface FeatureQueueRow {
  harness_slug: string;
  github_user_id: number;
  feature_id: string;
  queued_at: number;            // epoch ms
  removed_at: number | null;    // null = still queued
  schema_version: number;
}

export interface FeatureQueueProjectionOpts {
  /** Test/multi-peer seam — write to THIS postgres-js client instead of the
   *  process-global `getOrgPg().sql`. Production leaves this undefined. */
  sql?: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
  /** WI-259 P-002: hive-home slug when this harness is a hive MEMBER (cross-member content is
   *  membership-gated only when set); undefined for a non-hive / owned-home harness. */
  hiveHomeSlug?: string;
  /** WI-259 P-002: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities); threaded via RegisterAllOpts. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
}

export function composeFeatureQueueKey(githubUserId: number, featureId: string): string {
  return `${githubUserId}/${featureId}`;
}

function composeKey(row: FeatureQueueRow): string {
  return composeFeatureQueueKey(row.github_user_id, row.feature_id);
}

export function isFeatureQueueRow(input: unknown): input is FeatureQueueRow {
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
    typeof r.queued_at === 'number' &&
    Number.isFinite(r.queued_at) &&
    (r.removed_at === null || (typeof r.removed_at === 'number' && Number.isFinite(r.removed_at))) &&
    typeof r.schema_version === 'number' &&
    Number.isInteger(r.schema_version)
  );
}

function decodeValue(raw: unknown): FeatureQueueRow | null {
  return isFeatureQueueRow(raw) ? raw : null;
}

async function writeToPg(
  opts: FeatureQueueProjectionOpts,
  row: FeatureQueueRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  // WI-259 P-002 membership guard (see member-content-guard.ts): own-slug applies; a cross-member
  // op applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. resolveAuthorDevice
  // maps the immutable sourceLogKeyHex (provenance.authorPubkey for a remote op) → the admit-verified device.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  if (!(await shouldApplyMemberContentOp(row.harness_slug, opts, sourceLogDevice))) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.feature_queue
      (workspace_id, harness_slug, github_user_id, feature_id, queued_at, removed_at, schema_version,
       author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.feature_id},
       to_timestamp(${row.queued_at} / 1000.0),
       ${row.removed_at == null ? null : sql`to_timestamp(${row.removed_at} / 1000.0)`},
       ${row.schema_version}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, github_user_id, feature_id) DO UPDATE SET
      queued_at = EXCLUDED.queued_at,
      removed_at = EXCLUDED.removed_at,
      schema_version = EXCLUDED.schema_version,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc
    -- EI-79 step 2 + D-001: PG-level LWW guard, ordered by the SAME HLC key the
    -- merge fold uses; fall back to wall-clock fed_ts when either side lacks one.
    WHERE (EXCLUDED.fed_hlc IS NOT NULL AND feature_queue.fed_hlc IS NOT NULL
             AND EXCLUDED.fed_hlc >= feature_queue.fed_hlc)
       OR ((EXCLUDED.fed_hlc IS NULL OR feature_queue.fed_hlc IS NULL)
             AND (feature_queue.fed_ts IS NULL OR EXCLUDED.fed_ts >= feature_queue.fed_ts))
  `;
}

async function deleteFromPg(
  opts: FeatureQueueProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  // key shape: `<github_user_id>/<feature_id>`
  const sepIdx = key.indexOf('/');
  if (sepIdx <= 0) return;
  const userIdStr = key.slice(0, sepIdx);
  const featureId = key.slice(sepIdx + 1);
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId <= 0 || !featureId) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.feature_queue
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      AND feature_id = ${featureId}
      -- EI-79 step 2 + D-001: guard the delete by the SAME HLC-then-fed_ts order
      -- as the put guard; fall back to the ts-guard when either side lacks an HLC.
      AND (
        (${hlc}::text IS NOT NULL AND fed_hlc IS NOT NULL AND ${hlc}::text >= fed_hlc)
        OR ((${hlc}::text IS NULL OR fed_hlc IS NULL)
              AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint))
      )
  `;
}

export function buildFeatureQueueProjection(
  opts: FeatureQueueProjectionOpts,
): TableProjection<FeatureQueueRow> {
  return {
    tableTag: 'queue',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isFeatureQueueRow,
};
