/**
 * Hyperbee → PG projection for `harness_shared.harness_plans`.
 *
 * Plan: plans-pg-canonical-migration-2026-06-03 (Stage 2 — federation). Plans
 * went PG-canonical and federate as papercup-harness content over the same
 * peer-log machinery as features/issues (D-004). The per-harness Hyperbee key
 * is the `plan_slug` (the harness is implicit per-Hyperbee).
 *
 * Federated fields = the DOCUMENT: the canonical markdown `content` + its hash +
 * the frontmatter index (title/status/dates/owner/supersedes) + archived/is_legacy.
 * NOT federated (machine-local): `workspace_id` (set from the local projection's
 * bound workspace), `version` (the local CAS counter — bumped on a remote apply),
 * the `op_*` operational dispatch state (started/paused/priority — each machine
 * manages its own started set), and `created_at`/`updated_at`/`_search`.
 *
 * harness_plans has NO jsonb columns (content is TEXT, supersedes is text[]), so
 * no jsonb-binding dance is needed — unlike features/issues.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/**
 * Wire-shape of a plan row in Hyperbee — the federated subset of harness_plans.
 * Defensive on every field: a remote op with a malformed shape is dropped
 * (decodeValue → null) rather than crashing the projection loop.
 */
export interface HarnessPlanRow {
  harness_slug: string;
  plan_slug: string;
  content: string;
  content_hash: string;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  supersedes: string[];
  superseded_by: string | null;
  archived: boolean;
  is_legacy: boolean;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isHarnessPlanRow(input: unknown): input is HarnessPlanRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.plan_slug) || r.plan_slug.length === 0) return false;
  if (!isString(r.content)) return false;
  if (!isString(r.content_hash)) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isStringOrNull(r.status)) return false;
  if (!isStringOrNull(r.created)) return false;
  if (!isStringOrNull(r.updated)) return false;
  if (!isStringOrNull(r.owner)) return false;
  if (!isStringOrNull(r.superseded_by)) return false;
  if (!Array.isArray(r.supersedes) || !r.supersedes.every((s) => typeof s === 'string')) return false;
  if (typeof r.archived !== 'boolean') return false;
  if (typeof r.is_legacy !== 'boolean') return false;
  return true;
}

export interface HarnessPlansProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of the global getOrgPg().sql. */
  sql?: postgres.Sql;
}

function composeKey(row: HarnessPlanRow): string {
  // Per-harness Hyperbee → key is just plan_slug.
  return row.plan_slug;
}

function decodeValue(raw: unknown): HarnessPlanRow | null {
  return isHarnessPlanRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HarnessPlansProjectionOpts,
  row: HarnessPlanRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  // workspace_id is the LOCAL projection's bound workspace (not the sender's) —
  // a remote plan lands in the workspace this harness is bound to here. version
  // is the local CAS counter: 0 on first insert, bumped on every remote apply so
  // an in-flight local optimistic-CAS edit is correctly invalidated. op_* are
  // NOT set (preserved on update / NULL on insert) — operational state is local.
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version,
       title, status, created, updated, owner, supersedes, superseded_by,
       archived, is_legacy, author_pubkey, origin, fed_ts)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.plan_slug}, ${row.content}, ${row.content_hash}, 0,
       ${row.title}, ${row.status}, ${row.created}, ${row.updated}, ${row.owner}, ${row.supersedes}, ${row.superseded_by},
       ${row.archived}, ${row.is_legacy}, ${authorPubkey}, ${origin}, ${fedTs})
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
      content       = EXCLUDED.content,
      content_hash  = EXCLUDED.content_hash,
      version       = harness_shared.harness_plans.version + 1,
      title         = EXCLUDED.title,
      status        = EXCLUDED.status,
      created       = EXCLUDED.created,
      updated       = EXCLUDED.updated,
      owner         = EXCLUDED.owner,
      supersedes    = EXCLUDED.supersedes,
      superseded_by = EXCLUDED.superseded_by,
      archived      = EXCLUDED.archived,
      is_legacy     = EXCLUDED.is_legacy,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts
    -- EI-79 step 2: PG-level LWW guard — drop a strictly-older op.
    WHERE harness_shared.harness_plans.fed_ts IS NULL
       OR EXCLUDED.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= harness_shared.harness_plans.fed_ts
  `;
}

async function deleteFromPg(opts: HarnessPlansProjectionOpts, key: string): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  await sql`
    DELETE FROM harness_shared.harness_plans
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND plan_slug = ${key}
  `;
}

export function buildHarnessPlansProjection(
  opts: HarnessPlansProjectionOpts,
): TableProjection<HarnessPlanRow> {
  return {
    tableTag: 'plans-by-slug',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessPlanRow,
};
