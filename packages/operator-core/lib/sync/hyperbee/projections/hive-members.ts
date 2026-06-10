/**
 * Hyperbee → PG projection for `harness_shared.hive_members` — per-Hive
 * contributor/device admission federated across a Hive's Swarms
 * (shared-hive-federation-2026-06-08 P-006, D-004). MULTI-SWARM ONLY (P-010/P-011):
 * it replicates the admission record (who's admitted + the revoked_pubkeys
 * blocklist) so a revocation written on one Swarm reaches another Swarm's
 * admission union (loadRevokedHivePubkeys → boot.ts seam-1). Single-box + the
 * per-Hive gate work without it.
 *
 * Mirrors projections/contributors.ts (the harness-grain analog) + the federation
 * shape of projections/hive-settings.ts (the freshest per-Hive template). The
 * federated subset = the Hive scope (`hive_home_slug` = the Hive's home_slug, the
 * per-projection demux key), the contributor identity, and the admission-bearing
 * fields (device_attestations + the revoked_pubkeys blocklist + binding_status).
 * NOT federated (machine-local): joined_at/last_seen_at/the channel timestamps.
 *
 * The per-projection guard (`row.hive_home_slug !== opts.harnessSlug`, where
 * opts.harnessSlug is the registered Hive HOME harness slug) demuxes: a Hive home
 * harness's projection applies its Hive's member ops; everyone else drops them.
 * No hard dependency on the local hives row (a member can land before the hive
 * identity materializes on a peer — cross-machine join ordering).
 *
 * ── WIRING THIS NEEDS (su-02ae39's register-all/op-keys lane, mirrors hive_settings) ──
 *   1. Migration on hive_members adding the standard federation columns
 *      `fed_ts bigint`, `origin text NOT NULL DEFAULT 'local'`, `author_pubkey text`
 *      (this projection's writeToPg reads/writes them for the echo-guard + LWW).
 *   2. The capture trigger. NOTE: capture_substrate_outbox reads `NEW.harness_slug`
 *      for the outbox scope (000-baseline), but hive_members' scope column is
 *      `hive_home_slug`. So EITHER a thin custom capture fn that sets
 *      outbox.harness_slug := NEW.hive_home_slug, OR align the column to
 *      `harness_slug` like hive_settings did. (Read-side here is column-agnostic.)
 *   3. feature-issue-op-keys.ts: `hive_members → 'hive-members'` + a toHiveMemberValue
 *      mapper (the to_jsonb row → HiveMemberRow; device_attestations stays an array).
 *   4. register-all.ts: register buildHiveMembersProjection per Hive home harness.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';

/** Wire-shape of a hive_members row in Hyperbee — the federated subset. Defensive
 *  on every field; a malformed remote op is dropped (decodeValue → null). */
export interface HiveMemberRow {
  /** The Hive's home_slug — the per-projection demux key. */
  hive_home_slug: string;
  github_user_id: number;
  github_username: string;
  /** This member's bound devices on this Hive (the admission material). */
  device_attestations: DeviceAttestationEntry[];
  /** The revoked-pubkey blocklist (federates → admission union denies these). */
  revoked_pubkeys: string[];
  binding_status: string;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function isHiveMemberRow(input: unknown): input is HiveMemberRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.hive_home_slug !== 'string' || r.hive_home_slug.length === 0) return false;
  if (!isPosInt(r.github_user_id)) return false;
  if (typeof r.github_username !== 'string' || r.github_username.length === 0) return false;
  if (!Array.isArray(r.device_attestations)) return false;
  if (!Array.isArray(r.revoked_pubkeys)) return false;
  if (typeof r.binding_status !== 'string') return false;
  return true;
}

export interface HiveMembersProjectionOpts {
  workspaceId: string;
  /** The registered Hive HOME harness slug — the demux scope. */
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
}

/** Within a Hive's peer-log the member key is `<github_user_id>` (the Hive is
 *  implicit), mirroring contributors' per-harness `<github_user_id>` key. */
function composeKey(row: HiveMemberRow): string {
  return String(row.github_user_id);
}

function decodeValue(raw: unknown): HiveMemberRow | null {
  return isHiveMemberRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HiveMembersProjectionOpts,
  row: HiveMemberRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.hive_home_slug !== opts.harnessSlug) return; // cross-Hive op — drop
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance?.origin ?? 'local';
  const fedTs = provenance?.ts ?? null;
  await sql`
    INSERT INTO harness_shared.hive_members
      (workspace_id, hive_home_slug, github_user_id, github_username,
       device_attestations, revoked_pubkeys, binding_status,
       author_pubkey, origin, fed_ts)
    VALUES
      (${opts.workspaceId}, ${row.hive_home_slug}, ${row.github_user_id}, ${row.github_username},
       -- jsonb: JSON.stringify(x)::text::jsonb — sql.json THROWS under getOrgPg
       ${JSON.stringify(row.device_attestations ?? [])}::text::jsonb,
       ${row.revoked_pubkeys as unknown as string},
       ${row.binding_status},
       ${authorPubkey}, ${origin}, ${fedTs})
    ON CONFLICT (workspace_id, hive_home_slug, github_user_id) DO UPDATE SET
      github_username     = EXCLUDED.github_username,
      device_attestations = EXCLUDED.device_attestations,
      revoked_pubkeys     = EXCLUDED.revoked_pubkeys,
      binding_status      = EXCLUDED.binding_status,
      author_pubkey       = EXCLUDED.author_pubkey,
      origin              = EXCLUDED.origin,
      fed_ts              = EXCLUDED.fed_ts
    -- PG-level LWW guard — drop a strictly-older op.
    WHERE harness_shared.hive_members.fed_ts IS NULL
       OR EXCLUDED.fed_ts >= harness_shared.hive_members.fed_ts
  `;
}

async function deleteFromPg(
  opts: HiveMembersProjectionOpts,
  key: string,
  delTs?: number,
): Promise<void> {
  const userId = Number(key);
  if (!Number.isFinite(userId) || userId <= 0) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  await sql`
    DELETE FROM harness_shared.hive_members
    WHERE workspace_id = ${opts.workspaceId}
      AND hive_home_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      -- ts-guard the delete (a stale del must not erase a newer row).
      AND (${ts}::bigint IS NULL OR fed_ts IS NULL OR fed_ts <= ${ts}::bigint)
  `;
}

export function buildHiveMembersProjection(
  opts: HiveMembersProjectionOpts,
): TableProjection<HiveMemberRow> {
  return {
    tableTag: 'hive-members',
    // EI-117: CDC-captured table (mig 189 custom capture) — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs) => deleteFromPg(opts, key, delTs),
  };
}

export const _testing = { composeKey, decodeValue, isHiveMemberRow };
