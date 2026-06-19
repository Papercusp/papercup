/**
 * hive-epoch-state — the EPOCH MODEL for the read-plane re-key (Brief RE-KEY /
 * C-001 / E-001 / Move 2, K's lane: P1). The hive's current re-key epoch is a single
 * federated `hive_settings` row (`setting_key='epoch'`, JSON monotonic int), so it
 * reaches joiners over the SAME hive-home→joiner path A-003's (a′) fix establishes and
 * is D-001-ordered by `fed_hlc` — no new table, no capture/drain change.
 *
 * Why hive_settings (not the local `hives` row): `hives` (184) is workspace-LOCAL +
 * RLS-isolated and does NOT federate; `hive_settings` (186) IS the federated key-value
 * Hive-state table (`hive-settings-store.ts` → capture trigger). Grounding read
 * 2026-06-19.
 *
 * Epoch 0 = the pre-re-key baseline (unset). The owner ADVANCES the epoch on a boundary
 * (member-remove / go-private — that's P2, which calls `advanceHiveEpoch`), then mints +
 * distributes the new epoch key (ed300's `deriveEpochKey` + K's `wrapKeyToMember`
 * distribution, P3). Content is written under the current epoch (P4 serving).
 *
 * Pure state helpers — no crypto, no key material here (keys live in the device
 * keychain + the `hive_epoch_keys` blobs, never in hive_settings).
 */
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting } from '../../hive-settings-store';

/** The hive_settings key holding the current re-key epoch (a JSON non-negative int). */
export const EPOCH_SETTING_KEY = 'epoch';

/** The pre-re-key baseline epoch (an unset hive == epoch 0). */
export const BASELINE_EPOCH = 0;

/**
 * Coerce a stored setting value to a valid epoch. Unset / legacy / malformed → the
 * baseline (0): a hive that predates the re-key reads as epoch 0, which is correct
 * (its content is unencrypted-legacy under the new-hives-only v1 back-compat).
 */
function coerceEpoch(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : BASELINE_EPOCH;
}

/** Read the hive's current epoch (BASELINE_EPOCH when unset). */
export async function getHiveEpoch(workspaceId: string, hiveHomeSlug: string, sql?: Sql): Promise<number> {
  const rec = await getHiveSetting(workspaceId, hiveHomeSlug, EPOCH_SETTING_KEY, sql);
  return coerceEpoch(rec?.value);
}

/** Set the hive's epoch to an explicit non-negative int (federates via hive_settings). */
export async function setHiveEpoch(
  workspaceId: string,
  hiveHomeSlug: string,
  epoch: number,
  sql?: Sql,
): Promise<number> {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`setHiveEpoch: epoch must be a non-negative integer, got ${epoch}`);
  }
  await setHiveSetting(
    { workspaceId, hiveHomeSlug, settingKey: EPOCH_SETTING_KEY, value: epoch },
    sql,
  );
  return epoch;
}

/**
 * Advance the hive epoch by 1 — the boundary trigger (P2: member-remove / go-private)
 * calls this, then mints + distributes the new epoch key. Returns the NEW epoch.
 *
 * v1 concurrency: read-then-write (LWW upsert). Boundary events are owner-side +
 * infrequent, so a lost-update race is not a v1 concern; if it ever becomes one, make
 * this a CAS / SQL-atomic increment. Documented, not silently assumed.
 */
export async function advanceHiveEpoch(workspaceId: string, hiveHomeSlug: string, sql?: Sql): Promise<number> {
  const next = (await getHiveEpoch(workspaceId, hiveHomeSlug, sql)) + 1;
  return setHiveEpoch(workspaceId, hiveHomeSlug, next, sql);
}
