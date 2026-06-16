/**
 * account-session-override — the owner's "session-now" steer over WHICH pool accounts
 * the fleet may spawn/deploy on (accounts-pool-tab-2026-06-15 P-004; owner greenlit
 * "allow-list + exclude", whole-fleet, no TTL). The account sibling of owner-steering.ts
 * (the Queen-focus lever).
 *
 * Two axes, both empty by default (⇒ EXACTLY today's selection — purely additive):
 *   forcedAccounts   — the Queen may use ONLY these (allow-list). Empty ⇒ no restriction.
 *   excludeAccounts  — skip these (e.g. a flaky / rate-limited account). Empty ⇒ skip none.
 *
 * Applied as a precedence layer BEFORE the existing headroom/drain selectors
 * (account-pool-store.ts): restrict to `forced`, drop `exclude`, then select among
 * what survives. FAIL-SOFT and NO-OP-WHEN-UNSET — a read error or an empty override is
 * exactly the pre-override behaviour, so it can never wedge the live spawn chokepoint.
 *
 * WORKSPACE-LEVEL, not per-hive (D-017): persisted as a single-row-per-workspace JSONB
 * in `harness_shared.operator_account_override` (migration 297) — the operator-state
 * idiom, the same store the account POOL uses. The original P-004 design keyed it to the
 * home hive's hive_settings, which broke when no home hive was configured
 * ("no_home_harness") and split the write key from the read key. Living in its own
 * operator-state row (apart from operator_account_pool) keeps the owner's intent from
 * being clobbered by the pool's high-churn rate-projection writes.
 */
import { readOperatorState, writeOperatorState } from '../operator-state-pg';

/** The decoded override. Both empty ⇒ no restriction (today's behaviour). */
export interface AccountSessionOverride {
  /** Allow-list — the fleet may use ONLY these account ids. Empty ⇒ no restriction. */
  forcedAccounts: string[];
  /** Skip these account ids (e.g. a flaky / rate-limited account). Empty ⇒ skip none. */
  excludeAccounts: string[];
}

export const DEFAULT_ACCOUNT_OVERRIDE: AccountSessionOverride = { forcedAccounts: [], excludeAccounts: [] };

const OVERRIDE_STATE_TABLE = 'operator_account_override' as const;

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

export interface AccountSessionOverridePatch {
  forcedAccounts?: string[];
  excludeAccounts?: string[];
  /** Wipe both axes back to no-restriction. */
  clear?: boolean;
}

/** Read the workspace's account override (no hive needed; missing row ⇒ no restriction). */
export async function getAccountOverride(workspaceId: string): Promise<AccountSessionOverride> {
  const raw = await readOperatorState<Partial<AccountSessionOverride>>(OVERRIDE_STATE_TABLE, workspaceId);
  return {
    forcedAccounts: asStringArray(raw?.forcedAccounts),
    excludeAccounts: asStringArray(raw?.excludeAccounts),
  };
}

/**
 * Write an override patch (read-modify-write the single row). `clear:true` wipes both;
 * otherwise only the provided axes change ([] clears that axis; omitted is untouched).
 * Returns the resulting override.
 */
export async function setAccountOverride(
  workspaceId: string,
  patch: AccountSessionOverridePatch,
): Promise<AccountSessionOverride> {
  if (patch.clear) {
    await writeOperatorState(OVERRIDE_STATE_TABLE, DEFAULT_ACCOUNT_OVERRIDE, workspaceId);
    return DEFAULT_ACCOUNT_OVERRIDE;
  }
  const cur = await getAccountOverride(workspaceId);
  const next: AccountSessionOverride = {
    forcedAccounts: patch.forcedAccounts !== undefined ? asStringArray(patch.forcedAccounts) : cur.forcedAccounts,
    excludeAccounts: patch.excludeAccounts !== undefined ? asStringArray(patch.excludeAccounts) : cur.excludeAccounts,
  };
  await writeOperatorState(OVERRIDE_STATE_TABLE, next, workspaceId);
  return next;
}
