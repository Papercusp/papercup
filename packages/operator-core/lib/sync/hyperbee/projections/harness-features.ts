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
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

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
  /**
   * WI-251 (findings-B B-002): content/lineage columns now FEDERATED — were
   * dropped by the mapper so a feature federated A→B landed with them NULL.
   * verifier_*, audit_*, worked_by_history, current_wave stay LOCAL (each peer
   * re-audits / local cursors). OPTIONAL on the wire (back-compat: ops before
   * this change lack them → writeToPg maps absent → the PG default/NULL; the
   * NOT-NULL cols see_also/needs_design/discarded_design_work default []/false).
   */
  design_spec_id?: string | null;
  design_status?: string | null;
  needs_design?: boolean | null;
  discarded_design_work?: boolean | null;
  source_plan_slug?: string | null;
  source_plan_item_ids?: string[] | null;   // text[]
  see_also?: string[] | null;               // text[] NOT NULL DEFAULT '{}'
  wave?: string | null;
  deprecation_reason?: string | null;
  completion_ref?: unknown;            // JSONB blob — opaque to projection
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
  /** WI-259 P-002: hive-home slug when this harness is a hive MEMBER (cross-member content is
   *  membership-gated only when set); undefined for a non-hive / owned-home harness. */
  hiveHomeSlug?: string;
  /** WI-259 P-002: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities); threaded via RegisterAllOpts. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004: the content-before-membership defer buffer. When the membership guard would
   *  DROP a cross-member op ONLY because the author's hive_members row hasn't federated yet, the
   *  op is buffered here (keyed on the author device) + re-applied when that member joins — not
   *  lost. Undefined ⇒ today's drop (no buffer wired). Threaded via RegisterAllOpts. */
  pendingMemberContent?: PendingMembershipContent;
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
  // WI-259 P-002 membership guard (see member-content-guard.ts): own-slug applies; a cross-member
  // op applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. resolveAuthorDevice
  // maps the immutable sourceLogKeyHex (provenance.authorPubkey for a remote op) → the admit-verified device.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    // WI-259 P-004: a cross-member op the guard drops ONLY because the author's hive_members row
    // hasn't federated to this peer yet (decision 'defer', author device known) is BUFFERED + re-
    // applied when that member joins (the onMemberApplied drain), instead of lost to the advancing
    // merge cursor. A genuine non-member's op also defers, but the buffer's TTL evicts it (D-007).
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'features-by-id',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  // D-001: the op's HLC ordering key — the SAME causal key the merge fold orders
  // by. Stored as `fed_hlc` and compared by the LWW guard below (with a `fed_ts`
  // fallback when either side is NULL — pre-P-010 / pre-314 history).
  const fedHlc = provenance?.fedHlc ?? null;
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
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, summary, status, attempts, claims, notes,
       metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
       ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at,
       item_kind, feature_order, swarm_affinity, redundancy, payload,
       design_spec_id, design_status, needs_design, discarded_design_work,
       source_plan_slug, source_plan_item_ids, see_also, wave, deprecation_reason, completion_ref,
       author_pubkey, origin, fed_ts, fed_hlc, verified_author_github_user_id)
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
       -- WI-251 (findings-B B-002): federated content/lineage columns. text[] +
       -- jsonb bound explicitly; the NOT-NULL PG cols default ([]/false) when an
       -- older op (no these fields) is replayed.
       ${row.design_spec_id ?? null}, ${row.design_status ?? null},
       ${row.needs_design ?? false}, ${row.discarded_design_work ?? false},
       ${row.source_plan_slug ?? null}, ${row.source_plan_item_ids ?? null}::text[],
       ${row.see_also ?? []}::text[], ${row.wave ?? null}, ${row.deprecation_reason ?? null},
       ${row.completion_ref == null ? null : JSON.stringify(normalizeJsonbInput(row.completion_ref))}::text::jsonb,
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${verifiedAuthorGithubUserId})
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
      -- WI-251 (findings-B B-002): federated content/lineage columns. Safe to
      -- overwrite from EXCLUDED — the fed_hlc/fed_ts WHERE guard below gates the
      -- whole UPDATE on the op being newer, so an older op (which lacks these
      -- fields → maps to defaults) can never win the guard and clobber them.
      design_spec_id = EXCLUDED.design_spec_id,
      design_status = EXCLUDED.design_status,
      needs_design = EXCLUDED.needs_design,
      discarded_design_work = EXCLUDED.discarded_design_work,
      source_plan_slug = EXCLUDED.source_plan_slug,
      source_plan_item_ids = EXCLUDED.source_plan_item_ids,
      see_also = EXCLUDED.see_also,
      wave = EXCLUDED.wave,
      deprecation_reason = EXCLUDED.deprecation_reason,
      completion_ref = EXCLUDED.completion_ref,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc,
      verified_author_github_user_id = EXCLUDED.verified_author_github_user_id
    -- EI-79 step 2 + D-001: PG-level LWW guard, ordered by the SAME key the merge
    -- fold uses. When BOTH ops carry an HLC, order by it (the causal key — so a
    -- skewed-clock fold-winner is never silently rejected, the D-001 split-brain).
    -- When either side lacks an HLC (pre-P-010 / pre-314 history, or an append-
    -- path op), fall back to the wall-clock fed_ts guard (today's behaviour: a
    -- NULL stored fed_ts applies; a ts-less op cannot clobber a stamped row).
    WHERE (EXCLUDED.fed_hlc IS NOT NULL AND harness_features_consolidated.fed_hlc IS NOT NULL
             AND EXCLUDED.fed_hlc >= harness_features_consolidated.fed_hlc)
       OR ((EXCLUDED.fed_hlc IS NULL OR harness_features_consolidated.fed_hlc IS NULL)
             AND (harness_features_consolidated.fed_ts IS NULL
                  OR EXCLUDED.fed_ts >= harness_features_consolidated.fed_ts))
  `;
}

async function deleteFromPg(
  opts: HarnessFeaturesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${opts.harnessSlug}
      AND feature_id = ${key}
      -- EI-79 step 2 + D-001: guard the delete by the SAME HLC-then-fed_ts order
      -- as the put guard. A stale del (lower HLC) must not erase a row a newer put
      -- recreated; on an HLC tie del beats put (>=). Fall back to the ts-guard
      -- when either side lacks an HLC.
      AND (
        (${hlc}::text IS NOT NULL AND fed_hlc IS NOT NULL AND ${hlc}::text >= fed_hlc)
        OR ((${hlc}::text IS NULL OR fed_hlc IS NULL)
              AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint))
      )
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
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHarnessFeatureRow,
};
