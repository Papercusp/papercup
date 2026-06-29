/**
 * hive-epoch-keys-store — local PG read/write for `harness_shared.hive_epoch_keys`
 * (Brief RE-KEY / Move 2, P-005). Mirrors hive-settings-store: the LOCAL write/read
 * path; federation is the capture trigger's job (mig 316). The wrapped key crosses +
 * is stored as base64 TEXT; this module is the Uint8Array↔base64 boundary.
 *
 *   - putWrappedKeys: the OWNER's boundary trigger persists advanceEpochAndWrap's
 *     per-member rows (origin='local' → the capture trigger federates them).
 *   - createPgWrappedKeyLoader: the member-side `WrappedKeyLoader` the EpochKeyProvider
 *     uses to fetch + decode THIS device's wrapped row.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { WrappedKeyLoader } from './hive-epoch-key-provider';

type Sql = postgres.Sql;
function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** One wrapped epoch key to persist (the wrapped blob is raw bytes; stored base64). */
export interface WrappedKeyInput {
  memberDevicePubkey: string;
  wrappedKey: Uint8Array;
}

/** Options for putWrappedKeys. */
export interface PutWrappedKeysOptions {
  /**
   * BUG B self-heal (shared-hive-member-content-federation D-028, layer 2). When true,
   * a row that ALREADY exists is RE-WRITTEN via ON CONFLICT DO UPDATE (instead of the
   * write-once DO NOTHING) so the member that MISSED the original federated grant gets
   * the key RE-SENT with a FRESH HLC.
   *
   * MECHANISM (verified against the live triggers, not assumed): the DO UPDATE re-writes
   * `wrapped_key` — a NON-masked content column (re-wrap is a libsodium sealed box with a
   * per-call ephemeral key, so the blob always differs) — and sets origin='local', but
   * does NOT touch fed_ts/fed_hlc. That makes the BEFORE stamp trigger
   * (stamp_local_federated_write, mig 314) take its CONTENT-CHANGED branch and mint a
   * FRESH fed_ts + fed_hlc (origin='local'); the AFTER INSERT OR UPDATE capture trigger
   * (mig 411) then re-enqueues the federation op carrying that fresh HLC, and the
   * member's LWW projection (fed_hlc >= existing) accepts the re-send.
   *
   * Why NOT null fed_ts/fed_hlc (the naive re-stamp): mig-314's stamp trigger treats a
   * MOVED fed_ts (`NEW.fed_ts IS DISTINCT FROM OLD.fed_ts`, which NULL satisfies) as a
   * verbatim projection-apply / explicit repair and returns WITHOUT re-stamping — so
   * nulling fed_ts would leave the row at fed_ts/fed_hlc=NULL and NOT mint a fresh HLC.
   *
   * Default false = the original write-once ON CONFLICT DO NOTHING (behavior unchanged).
   */
  refederate?: boolean;
}

/**
 * Persist the per-member wrapped epoch keys for (hive, epoch) as LOCAL rows — the
 * boundary trigger (advanceEpochAndWrap) calls this on the owner; the capture trigger
 * (mig 316/411) federates them. Idempotent per (hive, epoch, member).
 *
 * `opts.refederate` (default false) switches the ON CONFLICT clause from write-once
 * DO NOTHING to a re-stamping DO UPDATE — the BUG-B reconnect re-grant uses it to
 * RE-SEND a key a member missed (see PutWrappedKeysOptions).
 */
export async function putWrappedKeys(
  workspaceId: string,
  hiveHomeSlug: string,
  epoch: number,
  rows: readonly WrappedKeyInput[],
  authorPubkey: string | null,
  sql?: Sql,
  opts?: PutWrappedKeysOptions,
): Promise<number> {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`putWrappedKeys: bad epoch ${epoch}`);
  const s = pg(sql);
  // refederate ⇒ DO UPDATE re-writing wrapped_key (a non-masked content column → the
  // BEFORE stamp trigger mints a FRESH fed_ts/fed_hlc on its content-changed branch) +
  // origin='local', WITHOUT touching fed_ts/fed_hlc (nulling them would hit the trigger's
  // "moved fed_ts ⇒ verbatim" branch and skip the re-stamp). The AFTER INSERT OR UPDATE
  // capture (mig 411) then re-federates with the fresh HLC. See PutWrappedKeysOptions.
  // Otherwise the original write-once DO NOTHING.
  const conflict = opts?.refederate
    ? `DO UPDATE SET
         wrapped_key = EXCLUDED.wrapped_key,
         author_pubkey = EXCLUDED.author_pubkey,
         origin = 'local',
         updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint`
    : `DO NOTHING`;
  let written = 0;
  for (const r of rows) {
    if (!r.memberDevicePubkey) continue;
    const wrapped = Buffer.from(r.wrappedKey).toString('base64');
    // origin='local' + fed_ts/fed_hlc left NULL → the BEFORE stamp trigger (mig 214/314)
    // stamps them + the AFTER capture trigger federates. created_at/updated_at default.
    await s.unsafe(
      `INSERT INTO harness_shared.hive_epoch_keys
         (workspace_id, harness_slug, epoch, member_device_pubkey, wrapped_key, author_pubkey, origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'local')
       ON CONFLICT (workspace_id, harness_slug, epoch, member_device_pubkey) ${conflict}`,
      [workspaceId, hiveHomeSlug, epoch, r.memberDevicePubkey, wrapped, authorPubkey],
    );
    written += 1;
  }
  return written;
}

/** Read THIS device's wrapped key (base64) for (hive, epoch), or null. */
export async function getWrappedKey(
  workspaceId: string,
  hiveHomeSlug: string,
  epoch: number,
  memberDevicePubkey: string,
  sql?: Sql,
): Promise<string | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT wrapped_key FROM harness_shared.hive_epoch_keys
      WHERE workspace_id = $1 AND harness_slug = $2 AND epoch = $3 AND member_device_pubkey = $4
      LIMIT 1`,
    [workspaceId, hiveHomeSlug, epoch, memberDevicePubkey],
  )) as unknown as Array<{ wrapped_key: string }>;
  return rows[0]?.wrapped_key ?? null;
}

/**
 * The member-side `WrappedKeyLoader` for the EpochKeyProvider, bound to (workspace,
 * Hive home). `load` returns the device's wrapped blob as bytes (base64-decoded), or
 * null when absent (removed member / not-yet-arrived → the provider fails closed).
 * The `hiveId` arg is the crypto identity (used by the provider for deriveEpochKey +
 * caching); the PG lookup keys by the bound `hiveHomeSlug`.
 */
export function createPgWrappedKeyLoader(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): WrappedKeyLoader {
  return {
    async load(_hiveId: string, epoch: number, memberDevicePubkey: string): Promise<Uint8Array | null> {
      const b64 = await getWrappedKey(workspaceId, hiveHomeSlug, epoch, memberDevicePubkey, sql);
      return b64 == null ? null : new Uint8Array(Buffer.from(b64, 'base64'));
    },
  };
}
