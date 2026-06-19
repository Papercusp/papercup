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

/**
 * Persist the per-member wrapped epoch keys for (hive, epoch) as LOCAL rows — the
 * boundary trigger (advanceEpochAndWrap) calls this on the owner; the capture trigger
 * (mig 316) federates them. Idempotent per (hive, epoch, member).
 */
export async function putWrappedKeys(
  workspaceId: string,
  hiveHomeSlug: string,
  epoch: number,
  rows: readonly WrappedKeyInput[],
  authorPubkey: string | null,
  sql?: Sql,
): Promise<number> {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`putWrappedKeys: bad epoch ${epoch}`);
  const s = pg(sql);
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
       ON CONFLICT (workspace_id, harness_slug, epoch, member_device_pubkey) DO NOTHING`,
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
