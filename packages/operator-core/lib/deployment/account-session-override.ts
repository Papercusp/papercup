/**
 * account-session-override — the owner's "session-now" steer over WHICH pool accounts
 * the fleet may spawn/deploy on (accounts-pool-tab-2026-06-15 P-004; owner greenlit
 * "allow-list + exclude", whole-fleet, no TTL). The account sibling of owner-steering.ts
 * (the Queen-focus lever): same hive_settings-backed, no-migration, fail-soft pattern.
 *
 * Two axes, both empty by default (⇒ EXACTLY today's selection — purely additive):
 *   account-session-override:forced   — JSON [accountId]; the Queen may use ONLY these
 *                                       (allow-list). Empty ⇒ no restriction.
 *   account-session-override:exclude  — JSON [accountId]; skip these (e.g. a flaky /
 *                                       rate-limited account). Empty ⇒ skip none.
 *
 * Applied as a precedence layer BEFORE the existing headroom/drain selectors
 * (account-pool-store.ts): restrict to `forced`, drop `exclude`, then select among
 * what survives. FAIL-SOFT and NO-OP-WHEN-UNSET — a read error or an empty override is
 * exactly the pre-override behaviour, so it can never wedge the live spawn chokepoint.
 *
 * Whole-fleet: stored on the workspace's HOME hive (the same hive_settings owner-steering
 * uses), and the spawn/deploy selectors read it regardless of the spawning harness.
 */
import type { Sql } from 'postgres';
import { listHiveSettings, setHiveSetting, deleteHiveSetting } from '../hive-settings-store';

/** The hive_settings keys the account override occupies (P-004). */
export const ACCOUNT_OVERRIDE_KEYS = {
  forcedAccounts: 'account-session-override:forced',
  excludeAccounts: 'account-session-override:exclude',
} as const;

/** The decoded override. Both empty ⇒ no restriction (today's behaviour). */
export interface AccountSessionOverride {
  /** Allow-list — the fleet may use ONLY these account ids. Empty ⇒ no restriction. */
  forcedAccounts: string[];
  /** Skip these account ids (e.g. a flaky / rate-limited account). Empty ⇒ skip none. */
  excludeAccounts: string[];
}

export const DEFAULT_ACCOUNT_OVERRIDE: AccountSessionOverride = { forcedAccounts: [], excludeAccounts: [] };

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/** True when the override imposes no restriction at all (the common, no-op case). */
export function isOverrideEmpty(o: AccountSessionOverride): boolean {
  return o.forcedAccounts.length === 0 && o.excludeAccounts.length === 0;
}

/**
 * Apply the override to a candidate account-id list: restrict to `forced` (when set),
 * then drop `exclude`. Pure + order-preserving. An empty override returns the input
 * unchanged (no-op); an over-restrictive one may return [] (the caller fails soft to the
 * frame-default credential, exactly as an empty pool does today).
 */
export function applyAccountOverride(accountIds: readonly string[], o: AccountSessionOverride): string[] {
  let ids = [...accountIds];
  if (o.forcedAccounts.length > 0) {
    const allow = new Set(o.forcedAccounts);
    ids = ids.filter((id) => allow.has(id));
  }
  if (o.excludeAccounts.length > 0) {
    const deny = new Set(o.excludeAccounts);
    ids = ids.filter((id) => !deny.has(id));
  }
  return ids;
}

/** Read the override for a hive (one query; missing keys default to no-restriction). */
export async function getAccountSessionOverride(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<AccountSessionOverride> {
  const rows = await listHiveSettings(workspaceId, hiveHomeSlug, sql);
  const byKey = new Map(rows.map((r) => [r.settingKey, r.value]));
  return {
    forcedAccounts: asStringArray(byKey.get(ACCOUNT_OVERRIDE_KEYS.forcedAccounts)),
    excludeAccounts: asStringArray(byKey.get(ACCOUNT_OVERRIDE_KEYS.excludeAccounts)),
  };
}

export interface AccountSessionOverridePatch {
  forcedAccounts?: string[];
  excludeAccounts?: string[];
  /** Wipe both axes back to no-restriction. */
  clear?: boolean;
}

/**
 * Write an override patch (upsert per axis). `clear:true` wipes both; otherwise only the
 * provided axes are written ([] clears that axis; omitted is untouched). Returns the result.
 */
export async function setAccountSessionOverride(
  workspaceId: string,
  hiveHomeSlug: string,
  patch: AccountSessionOverridePatch,
  sql?: Sql,
): Promise<AccountSessionOverride> {
  if (patch.clear) {
    for (const key of Object.values(ACCOUNT_OVERRIDE_KEYS)) {
      await deleteHiveSetting(workspaceId, hiveHomeSlug, key, sql);
    }
    return DEFAULT_ACCOUNT_OVERRIDE;
  }
  if (patch.forcedAccounts !== undefined) {
    await setHiveSetting({ workspaceId, hiveHomeSlug, settingKey: ACCOUNT_OVERRIDE_KEYS.forcedAccounts, value: asStringArray(patch.forcedAccounts) }, sql);
  }
  if (patch.excludeAccounts !== undefined) {
    await setHiveSetting({ workspaceId, hiveHomeSlug, settingKey: ACCOUNT_OVERRIDE_KEYS.excludeAccounts, value: asStringArray(patch.excludeAccounts) }, sql);
  }
  return getAccountSessionOverride(workspaceId, hiveHomeSlug, sql);
}
