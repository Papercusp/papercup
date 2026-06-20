/**
 * Hyperbee → PG projection for `harness_shared.harness_plans`.
 *
 * Plan: plans-pg-canonical-migration-2026-06-03 (Stage 2 — federation). Plans
 * went PG-canonical and federate as papercup-harness content over the same
 * peer-log machinery as features/issues (D-004). The per-harness Hyperbee key
 * is the `plan_slug` (the harness is implicit per-Hyperbee).
 *
 * Federated fields = the DOCUMENT: the canonical markdown `content` + its hash +
 * the frontmatter index (title/status/dates/owner/initiative/supersedes) + archived/is_legacy.
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
import { FLAGS } from '@papercusp/flags';
import type { TableProjection, ProvenanceContext } from '../projection';
import { observeMergedOp } from '../clobber-events';
import { shouldApplyMemberContentOp } from '../member-content-guard';

/**
 * P-007 — clobber detection for plans. A REMOTE plan apply (origin='remote')
 * reports the merged op to the clobber tracker; if this device made a LOCAL write
 * to the same plan_slug within the 60s window (recorded by the CDC drain,
 * outbox-drain.ts), it fires a `clobber` event so the user is told "your edit
 * raced X's" instead of losing it silently. The pubkey is the receiver-stamped,
 * unforgeable source identity (provenance.authorPubkey = sourceLogKeyHex, D-004) —
 * never the local own-log key, so a remote apply never self-clobbers. No-op for a
 * local apply or a provenance-less (legacy) op. Pure tracker call; never throws
 * into the projection loop.
 */
function flagPlanClobber(planSlug: string, provenance?: ProvenanceContext): void {
  if (!provenance || provenance.origin !== 'remote' || !planSlug) return;
  if (!provenance.authorPubkey || typeof provenance.ts !== 'number') return;
  try {
    observeMergedOp({
      table: 'plans-by-slug',
      hbKey: planSlug,
      ts: provenance.ts,
      pubkey: provenance.authorPubkey,
    });
  } catch {
    // clobber detection is best-effort observability — never break federation.
  }
}

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
  /** P-015 initiative grouping label. Optional on the wire for back-compat —
   *  a peer predating P-015 omits it; we tolerate absence and default to null. */
  initiative?: string | null;
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
  // Optional (back-compat): a pre-P-015 peer omits initiative entirely.
  if (r.initiative !== undefined && !isStringOrNull(r.initiative)) return false;
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
  /**
   * Test seam — the per-PART federation gate (default: getFlag(PLAN_PART_FEDERATION,'system')).
   * plan-federation-regrain-2026-06-13 D-004: when ON, the per-part recompose
   * (projections/harness-plan-parts.ts) is the SOLE writer of harness_plans
   * content + scalars, so this whole-blob projection drops to BOOTSTRAP-ONLY
   * (INSERT … ON CONFLICT DO NOTHING) — it can create a never-seen plan but
   * never UPDATE an existing one, so a stale whole-blob snapshot can never
   * clobber a per-part merge. When OFF, the whole-blob path is authoritative
   * (the full upsert) exactly as before.
   */
  isFlagOn?: () => Promise<boolean>;
  /** WI-259 P-002: hive-home slug when this harness is a hive MEMBER (cross-member content is
   *  membership-gated only when set); undefined for a non-hive / owned-home harness. */
  hiveHomeSlug?: string;
  /** WI-259 P-002: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities); threaded via RegisterAllOpts. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
}

async function planPartFederationOn(opts: HarnessPlansProjectionOpts): Promise<boolean> {
  if (opts.isFlagOn) return opts.isFlagOn();
  const { getFlag } = await import('@papercusp/flags/server');
  return getFlag(FLAGS.PLAN_PART_FEDERATION, 'system');
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
  // plan-federation-regrain D-004: when per-part federation is ON, the per-part
  // recompose owns content + scalars. This whole-blob path drops to BOOTSTRAP-
  // ONLY: INSERT a never-seen plan (so a brand-new plan still lands on a remote
  // peer) but DO NOTHING on an existing row — never updating content or scalars,
  // so a stale whole-blob snapshot cannot clobber a per-part merge. The single
  // fed_ts stays a single LWW stream (recompose owns updates).
  if (await planPartFederationOn(opts)) {
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version,
         title, status, created, updated, owner, initiative, supersedes, superseded_by,
         archived, is_legacy, author_pubkey, origin, fed_ts, fed_hlc)
      VALUES
        (${opts.workspaceId}, ${row.harness_slug}, ${row.plan_slug}, ${row.content}, ${row.content_hash}, 0,
         ${row.title}, ${row.status}, ${row.created}, ${row.updated}, ${row.owner}, ${row.initiative ?? null}, ${row.supersedes}, ${row.superseded_by},
         ${row.archived}, ${row.is_legacy}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
      ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING
    `;
    flagPlanClobber(row.plan_slug, provenance);
    return;
  }
  // workspace_id is the LOCAL projection's bound workspace (not the sender's) —
  // a remote plan lands in the workspace this harness is bound to here. version
  // is the local CAS counter: 0 on first insert, bumped on every remote apply so
  // an in-flight local optimistic-CAS edit is correctly invalidated. op_* are
  // NOT set (preserved on update / NULL on insert) — operational state is local.
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version,
       title, status, created, updated, owner, initiative, supersedes, superseded_by,
       archived, is_legacy, author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.plan_slug}, ${row.content}, ${row.content_hash}, 0,
       ${row.title}, ${row.status}, ${row.created}, ${row.updated}, ${row.owner}, ${row.initiative ?? null}, ${row.supersedes}, ${row.superseded_by},
       ${row.archived}, ${row.is_legacy}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
      content       = EXCLUDED.content,
      content_hash  = EXCLUDED.content_hash,
      version       = harness_shared.harness_plans.version + 1,
      title         = EXCLUDED.title,
      status        = EXCLUDED.status,
      created       = EXCLUDED.created,
      updated       = EXCLUDED.updated,
      owner         = EXCLUDED.owner,
      initiative    = EXCLUDED.initiative,
      supersedes    = EXCLUDED.supersedes,
      superseded_by = EXCLUDED.superseded_by,
      archived      = EXCLUDED.archived,
      is_legacy     = EXCLUDED.is_legacy,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc
    -- EI-79 step 2 + D-001: PG-level LWW guard — order by HLC, fall back to fed_ts.
    WHERE (EXCLUDED.fed_hlc IS NOT NULL AND harness_shared.harness_plans.fed_hlc IS NOT NULL
             AND EXCLUDED.fed_hlc >= harness_shared.harness_plans.fed_hlc)
       OR ((EXCLUDED.fed_hlc IS NULL OR harness_shared.harness_plans.fed_hlc IS NULL)
             AND (harness_shared.harness_plans.fed_ts IS NULL
                  OR EXCLUDED.fed_ts >= harness_shared.harness_plans.fed_ts))
  `;
  flagPlanClobber(row.plan_slug, provenance);
}

async function deleteFromPg(
  opts: HarnessPlansProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.harness_plans
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND plan_slug = ${key}
      -- EI-79 step 2 + D-001: guard the delete by the same HLC-then-fed_ts order.
      AND (
        (${hlc}::text IS NOT NULL AND fed_hlc IS NOT NULL AND ${hlc}::text >= fed_hlc)
        OR ((${hlc}::text IS NULL OR fed_hlc IS NULL)
              AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint))
      )
  `;
}

export function buildHarnessPlansProjection(
  opts: HarnessPlansProjectionOpts,
): TableProjection<HarnessPlanRow> {
  return {
    tableTag: 'plans-by-slug',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessPlanRow,
  flagPlanClobber,
};
