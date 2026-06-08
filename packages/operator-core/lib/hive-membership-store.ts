/**
 * hive-membership-store — PG access to harness_shared.hive_members, the per-Hive
 * contributor/device admission record (shared-hive-federation-2026-06-08 P-006,
 * D-004; migration 185).
 *
 * The Hive-grain analog of the per-harness contributor access
 * (load-revoked-pubkeys.ts + write-contributor-row.ts). A contributor/device
 * joins the HIVE once and thereby its harnesses, so admission keys on the Hive
 * (workspace_id, hive_home_slug) instead of a harness slug. The read-admission
 * decider + verifyBinding are REUSED unchanged — only the source of the
 * revoked-set union changes.
 *
 * `loadRevokedHivePubkeys` is the seam the P-004 substrate re-key wires into
 * boot.ts's admission seed/refresh: when an announcing peer's harness belongs to
 * a Hive (the P-004 harness↔Hive membership link), union this into the `revoked`
 * Set passed to makeAdmissionDecider.
 *
 * Crypto-free + PG-only: the keypair/identity live elsewhere; federation of these
 * rows (peer-log publish + projection) is the substrate's job (P-004). Every fn
 * takes an optional `sql` client so integration tests pass a per-file schema, and
 * carries an explicit `WHERE workspace_id = $1` (RLS is the backstop).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { DeviceAttestationEntry } from './harness/contributor-row-types';

/** A Hive member row — a contributor admitted to a Hive (all their devices +
 *  the revoked blocklist). Mirrors ContributorRow at Hive grain. */
export interface HiveMemberRecord {
  workspaceId: string;
  /** The Hive's home_slug (the hives PK handle this membership attaches to). */
  hiveHomeSlug: string;
  githubUserId: number;
  githubUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** This member's bound devices on this Hive. */
  deviceAttestations: DeviceAttestationEntry[];
  /** Pubkeys this member explicitly revoked (e.g. a lost device). The admission
   *  decider MUST refuse any attestation whose pubkey is in the UNION of these
   *  across all members (loadRevokedHivePubkeys). */
  revokedPubkeys: string[];
  bindingStatus: string;
}

export interface UpsertHiveMemberInput {
  workspaceId: string;
  hiveHomeSlug: string;
  githubUserId: number;
  githubUsername: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  deviceAttestations?: DeviceAttestationEntry[];
  revokedPubkeys?: string[];
  bindingStatus?: string;
}

interface HiveMemberPgRow {
  workspace_id: string;
  hive_home_slug: string;
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** jsonb — postgres-js usually parses it to an array, but a string is tolerated. */
  device_attestations: DeviceAttestationEntry[] | string | null;
  revoked_pubkeys: string[] | null;
  binding_status: string;
}

/** jsonb may arrive parsed (array) or, depending on the client/driver, as a raw
 *  JSON string — accept both so the read never silently drops the devices. */
function parseAttestations(v: DeviceAttestationEntry[] | string | null): DeviceAttestationEntry[] {
  if (v == null) return [];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as DeviceAttestationEntry[]) : [];
    } catch {
      return [];
    }
  }
  return v;
}

function rowToRecord(r: HiveMemberPgRow): HiveMemberRecord {
  return {
    workspaceId: r.workspace_id,
    hiveHomeSlug: r.hive_home_slug,
    githubUserId: Number(r.github_user_id),
    githubUsername: r.github_username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    deviceAttestations: parseAttestations(r.device_attestations),
    revokedPubkeys: r.revoked_pubkeys ?? [],
    bindingStatus: r.binding_status,
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const COLS = `workspace_id, hive_home_slug, github_user_id, github_username,
  display_name, avatar_url, device_attestations, revoked_pubkeys, binding_status`;

/**
 * Load the UNION of revoked device pubkeys for a Hive — the blocklist the
 * read-admission decider checks first. This is the wire-in point for boot.ts's
 * admission seed/refresh at Hive scope (P-004). Mirrors load-revoked-pubkeys.ts.
 */
export async function loadRevokedHivePubkeys(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<Set<string>> {
  const rows = (await pg(sql).unsafe(
    `SELECT revoked_pubkeys FROM harness_shared.hive_members
      WHERE workspace_id = $1 AND hive_home_slug = $2`,
    [workspaceId, hiveHomeSlug],
  )) as unknown as Array<{ revoked_pubkeys: string[] | null }>;
  const set = new Set<string>();
  for (const r of rows) {
    for (const k of r.revoked_pubkeys ?? []) set.add(k);
  }
  return set;
}

/** Get one Hive member. */
export async function getHiveMember(
  workspaceId: string,
  hiveHomeSlug: string,
  githubUserId: number,
  sql?: Sql,
): Promise<HiveMemberRecord | null> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${COLS} FROM harness_shared.hive_members
      WHERE workspace_id = $1 AND hive_home_slug = $2 AND github_user_id = $3 LIMIT 1`,
    [workspaceId, hiveHomeSlug, githubUserId],
  )) as unknown as HiveMemberPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** All members of a Hive. */
export async function listHiveMembers(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<HiveMemberRecord[]> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${COLS} FROM harness_shared.hive_members
      WHERE workspace_id = $1 AND hive_home_slug = $2 ORDER BY joined_at ASC`,
    [workspaceId, hiveHomeSlug],
  )) as unknown as HiveMemberPgRow[];
  return rows.map(rowToRecord);
}

/** The device pubkeys a member has bound to a Hive (for revoke targeting). */
export async function loadHiveMemberDevicePubkeys(
  workspaceId: string,
  hiveHomeSlug: string,
  githubUserId: number,
  sql?: Sql,
): Promise<string[]> {
  const member = await getHiveMember(workspaceId, hiveHomeSlug, githubUserId, sql);
  if (!member) return [];
  const out = new Set<string>();
  for (const a of member.deviceAttestations) {
    if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
      out.add(a.device_pubkey);
    }
  }
  return [...out];
}

/**
 * Upsert a Hive member row (admission). On conflict the mutable fields are
 * updated; device_attestations / revoked_pubkeys are REPLACED with the supplied
 * arrays when provided (the caller owns the merge — mirrors single-writer
 * peer-log semantics where a peer rewrites its own whole row).
 */
export async function upsertHiveMember(
  input: UpsertHiveMemberInput,
  sql?: Sql,
): Promise<HiveMemberRecord> {
  const rows = (await pg(sql).unsafe(
    `INSERT INTO harness_shared.hive_members
       (workspace_id, hive_home_slug, github_user_id, github_username,
        display_name, avatar_url, device_attestations, revoked_pubkeys, binding_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text[], $9)
     ON CONFLICT (workspace_id, hive_home_slug, github_user_id) DO UPDATE SET
       github_username = EXCLUDED.github_username,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       device_attestations = EXCLUDED.device_attestations,
       revoked_pubkeys = EXCLUDED.revoked_pubkeys,
       binding_status = EXCLUDED.binding_status
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.hiveHomeSlug,
      input.githubUserId,
      input.githubUsername,
      input.displayName ?? null,
      input.avatarUrl ?? null,
      JSON.stringify(input.deviceAttestations ?? []),
      input.revokedPubkeys ?? [],
      input.bindingStatus ?? 'unverified',
    ],
  )) as unknown as HiveMemberPgRow[];
  return rowToRecord(rows[0]);
}

/**
 * Add `pubkeys` to a member's revoked_pubkeys (idempotent union). Owner-revocation
 * adds the TARGET's device pubkeys to the OWNER's OWN row (single-writer: a peer
 * can only write its own row; the admission union across all rows is the effective
 * blocklist — see revoke-contributor.ts). Returns the updated row, or null if the
 * owner has no member row yet (must join the Hive before revoking).
 */
export async function addRevokedHivePubkeys(
  workspaceId: string,
  hiveHomeSlug: string,
  ownerGithubUserId: number,
  pubkeys: string[],
  sql?: Sql,
): Promise<HiveMemberRecord | null> {
  if (pubkeys.length === 0) {
    return getHiveMember(workspaceId, hiveHomeSlug, ownerGithubUserId, sql);
  }
  // array_cat + dedupe via a fresh distinct set in SQL keeps it a single round-trip.
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.hive_members
        SET revoked_pubkeys = (
          SELECT array_agg(DISTINCT k)
          FROM unnest(revoked_pubkeys || $4::text[]) AS k
        )
      WHERE workspace_id = $1 AND hive_home_slug = $2 AND github_user_id = $3
      RETURNING ${COLS}`,
    [workspaceId, hiveHomeSlug, ownerGithubUserId, pubkeys],
  )) as unknown as HiveMemberPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}
