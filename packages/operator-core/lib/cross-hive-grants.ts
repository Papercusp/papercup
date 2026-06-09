/**
 * cross-hive-grants — owner-set capability grants for the cross-Hive boundary
 * (cross-hive-boundary-2026-06-08 P-002). Trust between sovereign Hives is per-peer-Hive
 * + revocable: which peer-Hive pubkeys may send which kinds INTO this Hive. Stored as a
 * single `hive_settings` value (federates to ALL of this Hive's Swarms over the Hive
 * peer-log, so every Swarm enforces the same admission policy) keyed by the Hive's home
 * slug. Absence of a grant is a hard reject — the boundary is allow-list (default-deny).
 *
 * Consumed by the boundary: `loadCrossHiveGrants` → `admitCrossHiveEnvelope`
 * (cross-hive-boundary.ts). Written by the owner via `hive:cross_grant`.
 */
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting } from './hive-settings-store';
import type { CrossHiveGrant, CrossHiveKind } from './cross-hive-boundary';

/** The single hive_settings key under which the grant map lives. */
export const CROSS_HIVE_GRANTS_KEY = 'xhive-capability-grants';

/** Wire shape: { [peerHivePubkey]: CrossHiveKind[] }. */
type GrantMap = Record<string, CrossHiveKind[]>;

const KINDS: readonly CrossHiveKind[] = ['ask', 'work-request'];
const isKind = (k: unknown): k is CrossHiveKind => KINDS.includes(k as CrossHiveKind);

/** Parse the stored setting value into a clean grant map (tolerant of junk). */
function toGrantMap(value: unknown): GrantMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: GrantMap = {};
  for (const [peer, kinds] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(kinds)) {
      const clean = [...new Set(kinds.filter(isKind))];
      if (clean.length > 0) out[peer] = clean;
    }
  }
  return out;
}

/** Load this Hive's cross-Hive capability grants (the boundary's admission policy). */
export async function loadCrossHiveGrants(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<CrossHiveGrant[]> {
  const rec = await getHiveSetting(workspaceId, hiveHomeSlug, CROSS_HIVE_GRANTS_KEY, sql);
  return Object.entries(toGrantMap(rec?.value)).map(([peerHivePubkey, allowedKinds]) => ({
    peerHivePubkey,
    allowedKinds,
  }));
}

/** Grant (upsert) a peer-Hive the named kinds. Empty kinds is equivalent to a revoke. */
export async function setCrossHiveGrant(
  workspaceId: string,
  hiveHomeSlug: string,
  peerHivePubkey: string,
  allowedKinds: readonly CrossHiveKind[],
  sql?: Sql,
): Promise<void> {
  const rec = await getHiveSetting(workspaceId, hiveHomeSlug, CROSS_HIVE_GRANTS_KEY, sql);
  const map = toGrantMap(rec?.value);
  const clean = [...new Set(allowedKinds.filter(isKind))];
  if (clean.length === 0) delete map[peerHivePubkey];
  else map[peerHivePubkey] = clean;
  await setHiveSetting({ workspaceId, hiveHomeSlug, settingKey: CROSS_HIVE_GRANTS_KEY, value: map }, sql);
}

/** Revoke a peer-Hive's grant entirely (idempotent). */
export async function revokeCrossHiveGrant(
  workspaceId: string,
  hiveHomeSlug: string,
  peerHivePubkey: string,
  sql?: Sql,
): Promise<void> {
  const rec = await getHiveSetting(workspaceId, hiveHomeSlug, CROSS_HIVE_GRANTS_KEY, sql);
  const map = toGrantMap(rec?.value);
  if (!(peerHivePubkey in map)) return;
  delete map[peerHivePubkey];
  await setHiveSetting({ workspaceId, hiveHomeSlug, settingKey: CROSS_HIVE_GRANTS_KEY, value: map }, sql);
}
