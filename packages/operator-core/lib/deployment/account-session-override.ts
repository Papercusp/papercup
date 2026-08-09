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
 * WORKSPACE-LEVEL, not per-hive (D-015): persisted as a single-row-per-workspace JSONB
 * in `harness_shared.operator_account_override` (migration 297) — the operator-state
 * idiom, the same store the account POOL uses. The original P-004 design keyed it to the
 * home hive's hive_settings, which broke when no home hive was configured
 * ("no_home_harness") and split the write key from the read key. Living in its own
 * operator-state row (apart from operator_account_pool) keeps the owner's intent from
 * being clobbered by the pool's high-churn rate-projection writes.
 */
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { registerOverrideConcern, type OverrideEntry } from '../config-overrides/registry';

/** The decoded override. Both lists empty + no default ⇒ no steer at all (today's behaviour). */
export interface AccountSessionOverride {
  /** Allow-list — the fleet may use ONLY these account ids. Empty ⇒ no restriction. */
  forcedAccounts: string[];
  /** Skip these account ids (e.g. a flaky / rate-limited account). Empty ⇒ skip none. */
  excludeAccounts: string[];
  /**
   * The pool account that stands in for this box's own `~/.claude` login
   * (default-deploy-account-2026-08-08 D-001). Unset ⇒ the local login, exactly as before.
   *
   * This is a DIFFERENT AXIS from the two lists above: they RESTRICT what may be selected,
   * this one only replaces the implicit fallback when nothing else pinned a choice. A
   * default therefore never narrows the pool and never defeats failover — see D-003, and
   * note `isOverrideEmpty` below deliberately ignores it.
   */
  defaultAccountId?: string;
}

export const DEFAULT_ACCOUNT_OVERRIDE: AccountSessionOverride = { forcedAccounts: [], excludeAccounts: [] };

const OVERRIDE_STATE_TABLE = 'operator_account_override' as const;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/**
 * True when the override imposes no RESTRICTION at all (the common, no-op case).
 *
 * ⚠ Deliberately ignores `defaultAccountId`. This gates the candidate-narrowing path in
 * account-pool-store (`isOverrideEmpty(override) ? wholePool : applyAccountOverride(...)`),
 * and a default is a FALLBACK preference, not a restriction — folding it in here would make
 * the selectors treat "I picked a default" as "narrow the pool", silently killing failover.
 * If you need "has the owner steered accounts at all", ask for that explicitly rather than
 * widening this predicate.
 */
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
  /**
   * Set (non-empty string) or CLEAR (`null`) the default account. Omitted ⇒ untouched.
   * `null` is meaningful and distinct from omission, which is why this is `?: string | null`
   * rather than `?: string` — there must be a way to say "go back to the ~/.claude login".
   */
  defaultAccountId?: string | null;
  /** Wipe every axis — both lists AND the default — back to no steer. */
  clear?: boolean;
}

/** Trim to a usable account id, or undefined. Empty/whitespace ⇒ undefined (= unset). */
function asAccountId(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Read the workspace's account override (no hive needed; missing row ⇒ no steer). */
export async function getAccountOverride(workspaceId: string): Promise<AccountSessionOverride> {
  const raw = await readOperatorState<Partial<AccountSessionOverride>>(OVERRIDE_STATE_TABLE, workspaceId);
  const defaultAccountId = asAccountId(raw?.defaultAccountId);
  return {
    forcedAccounts: asStringArray(raw?.forcedAccounts),
    excludeAccounts: asStringArray(raw?.excludeAccounts),
    // Omit the key entirely when unset so the shape matches DEFAULT_ACCOUNT_OVERRIDE and
    // `toEqual` comparisons in existing callers/tests keep passing.
    ...(defaultAccountId ? { defaultAccountId } : {}),
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
  // null ⇒ clear; a string ⇒ set; omitted ⇒ keep. `?? undefined` collapses null to unset.
  const nextDefault =
    patch.defaultAccountId !== undefined ? asAccountId(patch.defaultAccountId) : cur.defaultAccountId;
  const next: AccountSessionOverride = {
    forcedAccounts: patch.forcedAccounts !== undefined ? asStringArray(patch.forcedAccounts) : cur.forcedAccounts,
    excludeAccounts: patch.excludeAccounts !== undefined ? asStringArray(patch.excludeAccounts) : cur.excludeAccounts,
    ...(nextDefault ? { defaultAccountId: nextDefault } : {}),
  };
  await writeOperatorState(OVERRIDE_STATE_TABLE, next, workspaceId);
  return next;
}

// Self-register as a runtime-config override concern (P-024 registry / sentinel-herald P-037):
// the owner's session-now account allow/exclude steer shows up in config:list-overrides, and
// config:reset-overrides wipes it back to no-restriction (the "drop my account steer" lever).
// The two axes are intrinsically paired but reported per-axis (each empty by default), so the
// readback shows exactly which steer is active.
registerOverrideConcern({
  name: 'account-session-override',
  description:
    "owner's account steer (forcedAccounts allow-list / excludeAccounts / defaultAccountId)",
  auditAction: 'accounts:set-session-override',
  diff: async () => {
    const o = await getAccountOverride(activeWorkspaceId());
    const entries: OverrideEntry[] = [];
    if (o.forcedAccounts.length > 0) entries.push({ key: 'forcedAccounts', effective: o.forcedAccounts, default: [], layer: 'pg-settings' });
    if (o.excludeAccounts.length > 0) entries.push({ key: 'excludeAccounts', effective: o.excludeAccounts, default: [], layer: 'pg-settings' });
    // The default's DEFAULT is the box's own ~/.claude login, which has no account id —
    // hence null, not '' (an empty string would read as "an account named ''").
    if (o.defaultAccountId) entries.push({ key: 'defaultAccountId', effective: o.defaultAccountId, default: null, layer: 'pg-settings' });
    return entries;
  },
  capture: () => getAccountOverride(activeWorkspaceId()),
  reset: () => setAccountOverride(activeWorkspaceId(), { clear: true }),
  restore: async (snap) => {
    const o = snap as AccountSessionOverride;
    await setAccountOverride(activeWorkspaceId(), {
      forcedAccounts: o.forcedAccounts,
      excludeAccounts: o.excludeAccounts,
      // Explicit null (not undefined) so restoring a snapshot taken with NO default
      // actually CLEARS a default set since — otherwise restore silently keeps it.
      defaultAccountId: o.defaultAccountId ?? null,
    });
  },
});
