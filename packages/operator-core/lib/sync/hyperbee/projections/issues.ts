/**
 * Hyperbee → PG projection for `harness_shared.harness_issues_consolidated`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * One row per (harness, issue_id). Hyperbee key per-harness:
 * `<issue_id>`. PG primary key: `(harness_slug, issue_id)`.
 *
 * `notes` is a JSONB array (issue history); pass-through opaque.
 * `linked_feature_id` is the F-FIX-* feature linking a fix back to
 * the originating issue (per project memory).
 */

import { getOrgPg } from '@papercusp/db-org';
import { normalizeJsonbInput } from './_jsonb-input';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface HarnessIssueRow {
  harness_slug: string;
  issue_id: string;
  title: string;
  severity: string;
  source: string;
  status: string;
  found_at: number;                     // epoch ms
  found_during: string | null;
  repro: string | null;
  evidence: string | null;
  suggested_fix: string | null;
  code_pointer: string | null;
  linked_feature_id: string | null;
  attempts: number;
  notes: unknown;                       // JSONB array
  created_ts: number;
  updated_ts: number;
}

export interface IssuesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * Test/multi-peer seam — write to THIS postgres-js client instead of the
   * process-global `getOrgPg().sql`. See `HarnessFeaturesProjectionOpts.sql`:
   * the Stage-6 federation acceptance test injects a per-peer client so two
   * peers in one process project into two separate databases. Defaults to
   * `getOrgPg().sql`.
   */
  sql?: postgres.Sql;
}

function composeKey(row: HarnessIssueRow): string {
  return row.issue_id;
}

function isString(v: unknown): v is string { return typeof v === 'string'; }
function isStringOrNull(v: unknown): v is string | null { return v === null || typeof v === 'string'; }
function isFiniteNumber(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

export function isHarnessIssueRow(input: unknown): input is HarnessIssueRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    isString(r.harness_slug) && r.harness_slug.length > 0 &&
    isString(r.issue_id) && r.issue_id.length > 0 &&
    isString(r.title) && r.title.length > 0 &&
    isString(r.severity) &&
    isString(r.source) &&
    isString(r.status) &&
    isFiniteNumber(r.found_at) &&
    isStringOrNull(r.found_during) &&
    isStringOrNull(r.repro) &&
    isStringOrNull(r.evidence) &&
    isStringOrNull(r.suggested_fix) &&
    isStringOrNull(r.code_pointer) &&
    isStringOrNull(r.linked_feature_id) &&
    isFiniteNumber(r.attempts) &&
    isFiniteNumber(r.created_ts) &&
    isFiniteNumber(r.updated_ts)
    // notes is JSONB opaque — accept anything
  );
}

function decodeValue(raw: unknown): HarnessIssueRow | null {
  return isHarnessIssueRow(raw) ? raw : null;
}

async function writeToPg(
  opts: IssuesProjectionOpts,
  row: HarnessIssueRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  await sql`
    INSERT INTO harness_shared.harness_issues_consolidated
      (harness_slug, issue_id, title, severity, source, status,
       found_at, found_during, repro, evidence, suggested_fix,
       code_pointer, linked_feature_id, attempts, notes,
       created_ts, updated_ts, author_pubkey, origin, fed_ts)
    VALUES
      (${row.harness_slug}, ${row.issue_id}, ${row.title}, ${row.severity}, ${row.source}, ${row.status},
       to_timestamp(${row.found_at} / 1000.0),
       ${row.found_during}, ${row.repro}, ${row.evidence}, ${row.suggested_fix},
       ${row.code_pointer}, ${row.linked_feature_id}, ${row.attempts},
       -- jsonb: bind via JSON.stringify(x)::jsonb — sql.json THROWS under the getOrgPg runtime
       -- client (agent-insights/postgres-js-jsonb-binding).
       ${JSON.stringify(normalizeJsonbInput(row.notes) ?? [])}::text::jsonb,
       ${row.created_ts}, ${row.updated_ts}, ${authorPubkey}, ${origin}, ${fedTs})
    ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
      title = EXCLUDED.title,
      severity = EXCLUDED.severity,
      source = EXCLUDED.source,
      status = EXCLUDED.status,
      found_at = EXCLUDED.found_at,
      found_during = EXCLUDED.found_during,
      repro = EXCLUDED.repro,
      evidence = EXCLUDED.evidence,
      suggested_fix = EXCLUDED.suggested_fix,
      code_pointer = EXCLUDED.code_pointer,
      linked_feature_id = EXCLUDED.linked_feature_id,
      attempts = EXCLUDED.attempts,
      notes = EXCLUDED.notes,
      updated_ts = EXCLUDED.updated_ts,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts
    -- EI-79 step 2: PG-level LWW guard — drop a strictly-older op.
    WHERE harness_issues_consolidated.fed_ts IS NULL
       OR EXCLUDED.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= harness_issues_consolidated.fed_ts
  `;
  void opts.workspaceId;
}

async function deleteFromPg(
  opts: IssuesProjectionOpts,
  key: string,
  delTs?: number,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  await sql`
    DELETE FROM harness_shared.harness_issues_consolidated
    WHERE harness_slug = ${opts.harnessSlug}
      AND issue_id = ${key}
      -- EI-79 step 2: ts-guard the delete (a stale del must not erase a newer row).
      AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint)
  `;
}

export function buildIssuesProjection(opts: IssuesProjectionOpts): TableProjection<HarnessIssueRow> {
  return {
    tableTag: 'issues',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs) => deleteFromPg(opts, key, delTs),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessIssueRow,
};
