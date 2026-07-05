/**
 * hive-store — PG access to harness_shared.hives, the first-class Hive entity
 * (shared-hive-federation-2026-06-08 P-002, D-008; migration 184).
 *
 * A Hive = a PROJECT, identified by a stable Ed25519 keypair (D-002). This module
 * is the single PG read/write path for the entity and is intentionally CRYPTO-FREE:
 * the keypair is minted/loaded by identity/hive-keypair.ts, and the get-or-mint
 * orchestration lives in hive-identity.ts. PG holds only the PUBLIC key (the
 * dial-able identity + the federation topic key, P-003) plus the OS-keychain id
 * that locates the secret — never the secret itself.
 *
 * The pubkey crosses this module's boundary as base64 (raw 32 bytes) — the exact
 * encoding identity/hive-keypair.ts mints and derive-swarm-topic.ts consumes — and
 * is stored as `bytea` (round-tripped via Buffer). Workspace-scoped: every query
 * carries an explicit `WHERE workspace_id = $1` (RLS is the backstop, mirroring
 * harness_shared.contributors). Every fn takes an optional `sql` client so
 * integration tests can pass a per-file test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** A Hive entity row. `pubkeyBase64` is the raw-32 base64 encoding that
 *  identity/hive-keypair.ts mints and derive-swarm-topic.ts consumes. */
export interface HiveRecord {
  workspaceId: string;
  /** The home `kind:'hive'` harness slug — the local handle. */
  homeSlug: string;
  /** Raw 32-byte Ed25519 public key, base64 — the Hive identity / federation key. */
  pubkeyBase64: string;
  /** OS-keychain id holding the secret (identity/hive-keypair.ts `hiveKeychainId`). */
  keychainId: string;
  title: string | null;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InsertHiveInput {
  workspaceId: string;
  homeSlug: string;
  pubkeyBase64: string;
  keychainId: string;
  title?: string | null;
  description?: string | null;
}

export interface UpsertRemoteHiveIdentityInput extends InsertHiveInput {
  /**
   * Explicit legacy keychain ids that this caller has proven are remote-view
   * artifacts, not locally owned hives. Kept opt-in so owned identities remain
   * immutable by default.
   */
  repairKeychainIds?: string[];
}

/** Raw Ed25519 public key length — asserted on store so a malformed key never
 *  lands as a Hive identity. */
export const ED25519_RAW_PUBKEY_BYTES = 32;

function pubkeyToBytea(pubkeyBase64: string): Buffer {
  const buf = Buffer.from(pubkeyBase64, 'base64');
  if (buf.length !== ED25519_RAW_PUBKEY_BYTES) {
    throw new Error(
      `hive public_key must be ${ED25519_RAW_PUBKEY_BYTES} raw bytes (got ${buf.length}) — ` +
        `expected a raw-32 base64 Ed25519 pubkey from identity/hive-keypair.ts`,
    );
  }
  return buf;
}

/** Decode a candidate id to a 32-byte pubkey Buffer, or null if it is not one
 *  (e.g. it is a home-slug). Lets `getHive` accept slug OR pubkey transparently. */
function tryDecodePubkey(idOrSlug: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(idOrSlug, 'base64');
  } catch {
    return null;
  }
  // base64 of a non-key string can decode to 32 bytes by coincidence only rarely;
  // a round-trip check rejects slugs that aren't actually this key's encoding.
  if (buf.length !== ED25519_RAW_PUBKEY_BYTES) return null;
  if (buf.toString('base64') !== idOrSlug) return null;
  return buf;
}

interface HiveRow {
  workspace_id: string;
  home_slug: string;
  public_key: Buffer | Uint8Array;
  keychain_id: string;
  title: string | null;
  description: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function rowToRecord(r: HiveRow): HiveRecord {
  return {
    workspaceId: r.workspace_id,
    homeSlug: r.home_slug,
    pubkeyBase64: Buffer.from(r.public_key).toString('base64'),
    keychainId: r.keychain_id,
    title: r.title,
    description: r.description,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const COLS = `workspace_id, home_slug, public_key, keychain_id, title, description, created_at, updated_at`;

/** Get one Hive by its home-slug. */
export async function getHiveBySlug(
  workspaceId: string,
  homeSlug: string,
  sql?: Sql,
): Promise<HiveRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.hives WHERE workspace_id = $1 AND home_slug = $2 LIMIT 1`,
    [workspaceId, homeSlug],
  )) as unknown as HiveRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Get one Hive by its raw-32 base64 pubkey (the federation / dial identity). */
export async function getHiveByPubkey(
  workspaceId: string,
  pubkeyBase64: string,
  sql?: Sql,
): Promise<HiveRecord | null> {
  const buf = tryDecodePubkey(pubkeyBase64);
  if (!buf) return null;
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.hives WHERE workspace_id = $1 AND public_key = $2 LIMIT 1`,
    [workspaceId, buf],
  )) as unknown as HiveRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Resolve a Hive by home-slug OR by pubkey (the forward-compat identity). */
export async function getHive(
  workspaceId: string,
  idOrSlug: string,
  sql?: Sql,
): Promise<HiveRecord | null> {
  const bySlug = await getHiveBySlug(workspaceId, idOrSlug, sql);
  if (bySlug) return bySlug;
  if (tryDecodePubkey(idOrSlug)) return getHiveByPubkey(workspaceId, idOrSlug, sql);
  return null;
}

/** Every Hive in the workspace, newest first. */
export async function listHives(workspaceId: string, sql?: Sql): Promise<HiveRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.hives WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  )) as unknown as HiveRow[];
  return rows.map(rowToRecord);
}

/**
 * Get-or-create the Hive identity row. Idempotent: if a row already exists for
 * (workspace, home_slug) it is returned UNCHANGED (the keypair + metadata are an
 * immutable identity — never silently rotated/clobbered by an ensure call);
 * `created` reflects whether a new row was inserted. `title`/`description` apply
 * only on first insert — edit them later via `updateHiveMeta`.
 */
export async function insertHiveIfAbsent(
  input: InsertHiveInput,
  sql?: Sql,
): Promise<{ record: HiveRecord; created: boolean }> {
  const s = pg(sql);
  const pk = pubkeyToBytea(input.pubkeyBase64);
  const now = Date.now();
  const inserted = (await s.unsafe(
    `INSERT INTO harness_shared.hives (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (workspace_id, home_slug) DO NOTHING
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.homeSlug,
      pk,
      input.keychainId,
      input.title ?? null,
      input.description ?? null,
      now,
    ],
  )) as unknown as HiveRow[];
  if (inserted[0]) return { record: rowToRecord(inserted[0]), created: true };
  // Conflict: a row already exists — return it unchanged.
  const existing = await getHiveBySlug(input.workspaceId, input.homeSlug, sql);
  if (!existing) {
    // Should not happen (conflict implies a row), but never return a phantom.
    throw new Error(`insertHiveIfAbsent: conflict on (${input.workspaceId}, ${input.homeSlug}) but no row found`);
  }
  return { record: existing, created: false };
}

/**
 * Get-or-create a REMOTE hive identity row for a joiner view.
 *
 * Owned Hive identities are immutable. A joiner-side remote view is different:
 * its pubkey is learned from the owner's directory announce, so a stale prior
 * join can leave the view slug pointed at an obsolete pubkey. This helper may
 * repair only rows that are already marked `remote:*`; local owned rows are
 * returned unchanged on conflict.
 */
export async function upsertRemoteHiveIdentity(
  input: UpsertRemoteHiveIdentityInput,
  sql?: Sql,
): Promise<{ record: HiveRecord; created: boolean; repaired: boolean }> {
  if (!input.keychainId.startsWith('remote:')) {
    throw new Error('upsertRemoteHiveIdentity requires a remote:* keychain id');
  }
  const s = pg(sql);
  const pk = pubkeyToBytea(input.pubkeyBase64);
  const now = Date.now();
  const repairKeychainIds = (input.repairKeychainIds ?? []).filter(Boolean);
  const rows = (await s.unsafe(
    `INSERT INTO harness_shared.hives (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (workspace_id, home_slug) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           keychain_id = EXCLUDED.keychain_id,
           title = COALESCE(EXCLUDED.title, harness_shared.hives.title),
           description = COALESCE(EXCLUDED.description, harness_shared.hives.description),
           updated_at = EXCLUDED.updated_at
       WHERE harness_shared.hives.keychain_id LIKE 'remote:%'
          OR harness_shared.hives.keychain_id = ANY($8::text[])
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.homeSlug,
      pk,
      input.keychainId,
      input.title ?? null,
      input.description ?? null,
      now,
      repairKeychainIds,
    ],
  )) as unknown as HiveRow[];
  if (rows[0]) {
    const record = rowToRecord(rows[0]);
    return { record, created: record.createdAt === now, repaired: record.createdAt !== now };
  }
  const existing = await getHiveBySlug(input.workspaceId, input.homeSlug, sql);
  if (!existing) {
    throw new Error(
      `upsertRemoteHiveIdentity: conflict on (${input.workspaceId}, ${input.homeSlug}) but no row found`,
    );
  }
  return { record: existing, created: false, repaired: false };
}

/** Edit a Hive's directory metadata (title/description). No identity side effects. */
export async function updateHiveMeta(
  workspaceId: string,
  homeSlug: string,
  meta: { title?: string | null; description?: string | null },
  sql?: Sql,
): Promise<HiveRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.hives
        SET title = COALESCE($3, title),
            description = COALESCE($4, description),
            updated_at = $5
      WHERE workspace_id = $1 AND home_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, homeSlug, meta.title ?? null, meta.description ?? null, Date.now()],
  )) as unknown as HiveRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Delete a Hive identity row (create-rollback + pot:dissolve). Idempotent. */
export async function deleteHive(
  workspaceId: string,
  homeSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `DELETE FROM harness_shared.hives WHERE workspace_id = $1 AND home_slug = $2 RETURNING home_slug`,
    [workspaceId, homeSlug],
  )) as unknown as Array<{ home_slug: string }>;
  return rows.length > 0;
}
