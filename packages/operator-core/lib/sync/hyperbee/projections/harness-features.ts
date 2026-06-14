/**
 * Hyperbee → PG projection for `harness_shared.harness_features_consolidated`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * The shared feature row — the most-consumed Hyperbee table since
 * the feature queue, status badges, claim flow, and PR daemon all
 * read from it. The Hyperbee key inside one harness's Hyperbee is
 * `<feature_id>` (the harness is implicit per-Hyperbee).
 *
 * The PG table is shared (`harness_features_consolidated`), keyed on
 * `(harness_slug, feature_id)`. `harness_slug` is bound at projection
 * registration time (per-harness wiring) so the consumer doesn't
 * need to thread it through every op.
 */

import { getOrgPg } from '@papercusp/db-org';
import { resolveVerifiedAuthorGithubId } from '../../../work-items-admission';
import { normalizeJsonbInput } from './_jsonb-input';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/**
 * Wire-shape of a feature row in Hyperbee. Mirrors the PG columns
 * 1:1 with `number` / `null` for timestamps (epoch ms). Defensive
 * on every field — remote ops with malformed shapes are dropped
 * rather than crashing the projection loop.
 */
export interface HarnessFeatureRow {
  harness_slug: string;
  feature_id: string;
  title: string | null;
  summary: string | null;
  status: string | null;
  attempts: number | null;
  claims: string | null;
  notes: string | null;
  metadata: unknown;                   // JSONB blob — opaque to projection
  kind: string | null;
  project_id: string | null;
  expected_cost_cents: number | null;
  tags: unknown;                       // JSONB
  needs_human_review: boolean | null;
  ts: number | null;                   // epoch ms
  created_ts: number | null;
  updated_ts: number | null;
  parent_id: string | null;
  goal_id: string | null;
  taken_by: string | null;
  taken_at: number | null;             // epoch ms → TIMESTAMPTZ via to_timestamp
  expires_at: number | null;
  /**
   * Work-item DISPATCH columns (unify-work-items D-013 + dispatch-scaling):
   * kind discriminator, wave order, swarm pinning, redundancy opt-in, and the
   * kind-specific payload. Without these a Queen reorder / redundancy
   * declaration never federates — remote swarms never see steering (found by
   * su-ae509 2026-06-10, blocks shared-hive-loop P-001). OPTIONAL on the wire:
   * ops appended before this change lack them, and replaying that history must
   * keep decoding (the guard accepts undefined; writeToPg maps absent → NULL,
   * item_kind → its PG default).
   */
  item_kind?: string | null;
  feature_order?: number | null;
  swarm_affinity?: string | null;
  redundancy?: number | null;
  payload?: unknown;                   // JSONB blob — opaque to projection
}

function isString(v: unknown): v is string { return typeof v === 'string'; }
function isStringOrNull(v: unknown): v is string | null { return v === null || typeof v === 'string'; }
function isNumberOrNull(v: unknown): v is number | null { return v === null || (typeof v === 'number' && Number.isFinite(v)); }
function isBoolOrNull(v: unknown): v is boolean | null { return v === null || typeof v === 'boolean'; }

export function isHarnessFeatureRow(input: unknown): input is HarnessFeatureRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.feature_id) || r.feature_id.length === 0) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isStringOrNull(r.summary)) return false;
  if (!isStringOrNull(r.status)) return false;
  if (!isNumberOrNull(r.attempts)) return false;
  if (!isStringOrNull(r.claims)) return false;
  if (!isStringOrNull(r.notes)) return false;
  if (!isStringOrNull(r.kind)) return false;
  if (!isStringOrNull(r.project_id)) return false;
  if (!isNumberOrNull(r.expected_cost_cents)) return false;
  if (!isBoolOrNull(r.needs_human_review)) return false;
  if (!isNumberOrNull(r.ts)) return false;
  if (!isNumberOrNull(r.created_ts)) return false;
  if (!isNumberOrNull(r.updated_ts)) return false;
  if (!isStringOrNull(r.parent_id)) return false;
  if (!isStringOrNull(r.goal_id)) return false;
  if (!isStringOrNull(r.taken_by)) return false;
  if (!isNumberOrNull(r.taken_at)) return false;
  if (!isNumberOrNull(r.expires_at)) return false;
  // Dispatch columns are OPTIONAL on the wire (absent in pre-2026-06-10 log
  // history) — tolerate undefined, validate when present.
  if (r.item_kind !== undefined && !isStringOrNull(r.item_kind)) return false;
  if (r.feature_order !== undefined && !isNumberOrNull(r.feature_order)) return false;
  if (r.swarm_affinity !== undefined && !isStringOrNull(r.swarm_affinity)) return false;
  if (r.redundancy !== undefined && !isNumberOrNull(r.redundancy)) return false;
  // metadata + tags + payload are JSONB blobs; accept anything (incl. null/missing).
  return true;
}

export interface HarnessFeaturesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * Test/multi-peer seam — write to THIS postgres-js client instead of the
   * process-global `getOrgPg().sql`. Production leaves this undefined (the
   * single embedded-pg / native-pg connection). The Stage-6 federation
   * acceptance test injects a per-peer client so two peers in ONE process
   * project into two SEPARATE databases — without it, both peers would write
   * to the same global connection and the "did the row land in B?" assertion
   * would be vacuous. Defaults to `getOrgPg().sql`.
   */
  sql?: postgres.Sql;
}

function composeKey(row: HarnessFeatureRow): string {
  // Per-harness Hyperbee → key is just feature_id.
  return row.feature_id;
}

function decodeValue(raw: unknown): HarnessFeatureRow | null {
  return isHarnessFeatureRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HarnessFeaturesProjectionOpts,
  row: HarnessFeatureRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  // P-008 (shared-hive-trust-admission): stamp the VERIFIED author identity on
  // REMOTE rows only — resolve author_pubkey → github_user_id via a verified,
  // non-revoked hive_members device attestation (NEVER a self-claimed id). NULL
  // when unverified/revoked/local, so the trust gate (autoPickableWhereSql /
  // isAutoPickable) conservatively refuses the fast-path. This is the PRODUCER
  // for the column the gate consumes (the consumer was landed in P-010).
  const verifiedAuthorGithubUserId =
    origin === 'remote' && authorPubkey
      ? await resolveVerifiedAuthorGithubId(sql, { workspaceId: opts.workspaceId, authorPubkey })
      : null;
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, summary, status, attempts, claims, notes,
       metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
       ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at,
       item_kind, feature_order, swarm_affinity, redundancy, payload,
       author_pubkey, origin, fed_ts, verified_author_github_user_id)
    VALUES
      (${row.harness_slug}, ${row.feature_id}, ${row.title}, ${row.summary}, ${row.status}, ${row.attempts}, ${row.claims}, ${row.notes},
       -- jsonb: bind via JSON.stringify(x)::jsonb — sql.json THROWS under getOrgPg (agent-insights/postgres-js-jsonb-binding)
       ${row.metadata == null ? null : JSON.stringify(normalizeJsonbInput(row.metadata))}::text::jsonb,
       ${row.kind}, ${row.project_id}, ${row.expected_cost_cents},
       ${row.tags == null ? null : JSON.stringify(normalizeJsonbInput(row.tags))}::text::jsonb,
       ${row.needs_human_review},
       ${row.ts}, ${row.created_ts}, ${row.updated_ts}, ${row.parent_id}, ${row.goal_id}, ${row.taken_by},
       ${row.taken_at == null ? null : sql`to_timestamp(${row.taken_at} / 1000.0)`},
       ${row.expires_at == null ? null : sql`to_timestamp(${row.expires_at} / 1000.0)`},
       -- Dispatch columns: item_kind is NOT NULL DEFAULT 'feature' in PG, so an
       -- op that doesn't carry it (pre-2026-06-10 history) inserts the default.
       ${row.item_kind ?? 'feature'}, ${row.feature_order ?? null}, ${row.swarm_affinity ?? null}, ${row.redundancy ?? null},
       ${row.payload == null ? null : JSON.stringify(normalizeJsonbInput(row.payload))}::text::jsonb,
       ${authorPubkey}, ${origin}, ${fedTs}, ${verifiedAuthorGithubUserId})
    ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      status = EXCLUDED.status,
      attempts = EXCLUDED.attempts,
      claims = EXCLUDED.claims,
      notes = EXCLUDED.notes,
      metadata = EXCLUDED.metadata,
      kind = EXCLUDED.kind,
      project_id = EXCLUDED.project_id,
      expected_cost_cents = EXCLUDED.expected_cost_cents,
      tags = EXCLUDED.tags,
      needs_human_review = EXCLUDED.needs_human_review,
      ts = EXCLUDED.ts,
      created_ts = EXCLUDED.created_ts,
      updated_ts = EXCLUDED.updated_ts,
      parent_id = EXCLUDED.parent_id,
      goal_id = EXCLUDED.goal_id,
      taken_by = EXCLUDED.taken_by,
      taken_at = EXCLUDED.taken_at,
      expires_at = EXCLUDED.expires_at,
      -- item_kind is the immutable discriminator: never let an op that doesn't
      -- carry it (defaulted to 'feature' above) flip a research-task/chunk back.
      item_kind = CASE WHEN harness_features_consolidated.item_kind <> 'feature'
                       THEN harness_features_consolidated.item_kind
                       ELSE EXCLUDED.item_kind END,
      feature_order = EXCLUDED.feature_order,
      swarm_affinity = EXCLUDED.swarm_affinity,
      redundancy = EXCLUDED.redundancy,
      payload = EXCLUDED.payload,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts,
      verified_author_github_user_id = EXCLUDED.verified_author_github_user_id
    -- EI-79 step 2: PG-level LWW guard. Drop a strictly-older op so the
    -- incremental merge cursor is correct even when an out-of-order / backfilled
    -- op arrives after a newer row already landed. A NULL STORED fed_ts applies
    -- (first write after the migration); a ts-less op cannot clobber a stamped
    -- row (EI-117 — the EXCLUDED-side NULL disjunct was the revert hole).
    WHERE harness_features_consolidated.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= harness_features_consolidated.fed_ts
  `;
}

async function deleteFromPg(
  opts: HarnessFeaturesProjectionOpts,
  key: string,
  delTs?: number,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  await sql`
    DELETE FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${opts.harnessSlug}
      AND feature_id = ${key}
      -- EI-79 step 2: ts-guard the delete (a stale del must not erase a newer row).
      AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint)
  `;
  // workspaceId is captured for future per-workspace partitioning of the
  // consolidated view; the table is currently shared across the workspace.
  void opts.workspaceId;
}

export function buildHarnessFeaturesProjection(
  opts: HarnessFeaturesProjectionOpts,
): TableProjection<HarnessFeatureRow> {
  return {
    tableTag: 'features-by-id',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs) => deleteFromPg(opts, key, delTs),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessFeatureRow,
};
