/**
 * Hyperbee → PG projection for `harness_shared.bee_claim_specs` — the Queen's
 * per-bee claim SPECS federated as hive state
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-016, mig 438).
 *
 * Mirrors projections/hive-settings.ts (the closest analog: a hive-home-scoped
 * key riding the peer-log). Federated subset = harness_slug (the hive HOME
 * slug — the demux/projection guard), bee_id, spec (jsonb), revision,
 * updated_by. NOT federated (machine-local): updated_at. Standard provenance
 * columns carry the echo-guard + HLC-then-fed_ts LWW.
 *
 * Why: get_next reads the spec from LOCAL PG — without federation, a queen on
 * machine A versioning a spec never reaches a bee pulling on machine B. With
 * it, spec authoring is cross-machine steering (the scheduler-usage model the
 * hive-coordination-health rubric grades).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/** Wire-shape of a federated bee_claim_specs row. Defensive on every field. */
export interface BeeClaimSpecRow {
  /** The hive HOME slug — the per-harness projection guard key. */
  harness_slug: string;
  bee_id: string;
  spec: Record<string, unknown>;
  revision: number;
  updated_by: string | null;
}

export function isBeeClaimSpecRow(input: unknown): input is BeeClaimSpecRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.bee_id !== 'string' || r.bee_id.length === 0) return false;
  if (!r.spec || typeof r.spec !== 'object' || Array.isArray(r.spec)) return false;
  if (typeof r.revision !== 'number' || !Number.isFinite(r.revision)) return false;
  if (r.updated_by !== null && typeof r.updated_by !== 'string') return false;
  return true;
}

export interface BeeClaimSpecProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
}

function composeKey(row: BeeClaimSpecRow): string {
  return row.bee_id;
}

function decodeValue(raw: unknown): BeeClaimSpecRow | null {
  return isBeeClaimSpecRow(raw) ? raw : null;
}

async function writeToPg(
  opts: BeeClaimSpecProjectionOpts,
  row: BeeClaimSpecRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.bee_claim_specs
      (workspace_id, bee_id, spec, revision, updated_by, harness_slug,
       origin, author_pubkey, fed_ts, fed_hlc, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.bee_id}, ${JSON.stringify(row.spec)}::text::jsonb,
       ${row.revision}, ${row.updated_by}, ${row.harness_slug},
       ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc}, now())
    ON CONFLICT (workspace_id, bee_id) DO UPDATE SET
      spec          = EXCLUDED.spec,
      revision      = EXCLUDED.revision,
      updated_by    = EXCLUDED.updated_by,
      harness_slug  = EXCLUDED.harness_slug,
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc,
      updated_at    = now()
    -- PG-level LWW guard (D-001): HLC when both sides carry one, else fed_ts.
    WHERE (EXCLUDED.fed_hlc IS NOT NULL AND harness_shared.bee_claim_specs.fed_hlc IS NOT NULL
             AND EXCLUDED.fed_hlc >= harness_shared.bee_claim_specs.fed_hlc)
       OR ((EXCLUDED.fed_hlc IS NULL OR harness_shared.bee_claim_specs.fed_hlc IS NULL)
             AND (harness_shared.bee_claim_specs.fed_ts IS NULL
                  OR EXCLUDED.fed_ts >= harness_shared.bee_claim_specs.fed_ts))
  `;
}

async function deleteFromPg(
  opts: BeeClaimSpecProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.bee_claim_specs
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND bee_id = ${key}
      AND (
        (${hlc}::text IS NOT NULL AND fed_hlc IS NOT NULL AND ${hlc}::text >= fed_hlc)
        OR ((${hlc}::text IS NULL OR fed_hlc IS NULL)
              AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint))
      )
  `;
}

export function buildBeeClaimSpecProjection(
  opts: BeeClaimSpecProjectionOpts,
): TableProjection<BeeClaimSpecRow> {
  return {
    tableTag: 'bee-claim-specs',
    // EI-117: CDC-captured table — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isBeeClaimSpecRow };
