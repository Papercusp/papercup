/**
 * Runtime §G auth/sandbox overrides (live-configurability-audit-2026-06-20 P-019).
 *
 * Three baked auth/security literals become runtime-settable, read through a D-010 module SYNC cache
 * GATED by the DARK `papercusp-auth-config-overrides` flag (owner-authority — the owner flips it ON to
 * ratify the dials). OFF (default) ⇒ the cache stays empty ⇒ every surface uses its baked literal ⇒
 * byte-identical.
 *
 *   - `fullAccessRoles` → auth:set_full_access_roles REPLACES the baked TESTING_FULL_ACCESS_ROLES
 *     gate-bypass set (the strongest escalation in the system — adding a role lets it skip ALL
 *     role+capability gates, so this is the reason the whole cluster is dark). Reached by agent-mcp's
 *     gate-bypass via the host resolver installed below.
 *   - `safeToolsRemove` → clamp:set_safe_tools NARROWS the scoped-SU cross-workspace allowlist
 *     (SCOPED_SAFE_CROSSWORKSPACE). TIGHTEN-ONLY: a REMOVE-set (you can only take tools OUT of the
 *     allowlist), never an add — narrowing can only reduce a scoped superuser's reach.
 *   - `sandboxMaskAdditions` / `sandboxDenyAllEgress` → exec_sandbox:set_policy ADDS sandbox mask dirs
 *     (unioned over CAPABILITY_SANDBOX_MASK_DIRS) and/or forces deny-all-egress. TIGHTEN-ONLY:
 *     add-masks / lock-down only — it can never UNMASK a baked dir or RE-OPEN egress.
 *
 * Separately, the `papercusp-testing-full-access` flag is the runtime master kill-switch (the env→flag
 * conversion of PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off): OFF ⇒ testing-full-access is globally
 * disabled (the resolver returns false for every role). Default ON ⇒ current behaviour. This flag is
 * read REGARDLESS of the dark override flag (the kill-switch must work even with no override set).
 *
 * The module import is PURE (no import-time getFlag/PG read) — importing it on the dispatch hot path
 * (via gate-bypass's resolver, the clamp, or exec-sandbox) never does IO; the getters are plain cache
 * reads. Refresh on (a) onFlagChange(null | the two flags), (b) local write, (c) a ~60s unref timer.
 */
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { FLAGS } from '@papercusp/flags';
import { setTestingFullAccessResolver } from '@papercusp/agent-mcp';
import { systemDistinctId } from './flag-distinct-id';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

const STATE_TABLE = 'operator_auth_config' as const;

export interface AuthConfigOverrides {
  /** REPLACES the baked TESTING_FULL_ACCESS_ROLES bypass set (escalation; dark-gated). */
  fullAccessRoles?: string[];
  /** Tools to REMOVE from the scoped-SU cross-workspace allowlist (narrow-only). */
  safeToolsRemove?: string[];
  /** Extra home-relative dirs to ADD to the sandbox mask set (add-only). */
  sandboxMaskAdditions?: string[];
  /** Force deny-all-egress in the capability sandbox (lock-down only; undefined ⇒ defer to the env). */
  sandboxDenyAllEgress?: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const strList = (xs: unknown): string[] =>
  Array.isArray(xs) ? [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];

// ── D-010 sync cache ──────────────────────────────────────────────────────────
let overridesEnabled = false; // papercusp-auth-config-overrides (DARK)
let testingFullAccessEnabled = true; // papercusp-testing-full-access (kill-switch; default ON)
let cached: AuthConfigOverrides = {};
// Derived structures recomputed on refresh so the hot-path getters never allocate.
let fullAccessSet: ReadonlySet<string> | null = null;
let safeToolsRemoveSet: ReadonlySet<string> = EMPTY_SET;
let maskAdditions: readonly string[] = [];

function recomputeDerived(): void {
  if (!overridesEnabled) {
    fullAccessSet = null;
    safeToolsRemoveSet = EMPTY_SET;
    maskAdditions = [];
    return;
  }
  const roles = strList(cached.fullAccessRoles);
  fullAccessSet = roles.length ? new Set(roles) : null;
  const removes = strList(cached.safeToolsRemove);
  safeToolsRemoveSet = removes.length ? new Set(removes) : EMPTY_SET;
  maskAdditions = strList(cached.sandboxMaskAdditions);
}

// ── hot-path getters (SYNC, zero-await) ───────────────────────────────────────
/** Tools to subtract from SCOPED_SAFE_CROSSWORKSPACE (narrow-only). Empty when off/unset. */
export function authSafeToolsRemoveSet(): ReadonlySet<string> {
  return safeToolsRemoveSet;
}
/** Extra sandbox mask dirs to union over CAPABILITY_SANDBOX_MASK_DIRS (add-only). Empty when off/unset. */
export function authSandboxMaskAdditions(): readonly string[] {
  return maskAdditions;
}
/** Deny-all-egress override (undefined ⇒ defer to the env). Only honoured when the dark flag is ON. */
export function authSandboxDenyAllEgressOverride(): boolean | undefined {
  return overridesEnabled ? cached.sandboxDenyAllEgress : undefined;
}

// The gate-bypass resolver (installed once below). Reads the live module vars each call.
function resolveTestingFullAccess(role: string | null | undefined): boolean | null {
  if (!testingFullAccessEnabled) return false; // kill-switch flag OFF ⇒ globally disabled
  if (fullAccessSet) return role != null && fullAccessSet.has(role); // dark override REPLACES the baked set
  return null; // fall through to the baked TESTING_FULL_ACCESS_ROLES
}
setTestingFullAccessResolver(resolveTestingFullAccess);

export async function refreshAuthConfigOverrides(): Promise<void> {
  try {
    const [ovr, tfa] = await Promise.all([
      getFlag(FLAGS.AUTH_CONFIG_OVERRIDES, systemDistinctId()),
      getFlag(FLAGS.TESTING_FULL_ACCESS, systemDistinctId()),
    ]);
    overridesEnabled = ovr;
    testingFullAccessEnabled = tfa;
    cached = overridesEnabled ? (await readOperatorState<AuthConfigOverrides>(STATE_TABLE)) ?? {} : {};
  } catch {
    overridesEnabled = false;
    testingFullAccessEnabled = true; // fail SAFE to current behaviour (testing-full-access on)
    cached = {};
  }
  recomputeDerived();
}
// Boot + flip refresh (pure import — no import-time IO here).
onFlagChange((key) => {
  if (key === null || key === FLAGS.AUTH_CONFIG_OVERRIDES || key === FLAGS.TESTING_FULL_ACCESS) {
    void refreshAuthConfigOverrides();
  }
});
// P-008: visible in schedule:inventory as a 'cache' timer (per-process config memo refresh).
managedSetInterval('config-refresh:auth-config', 60_000, () => refreshAuthConfigOverrides(), {
  category: 'cache',
});

// ── async read/write (the tools) ──────────────────────────────────────────────
export async function readAuthConfigOverrides(): Promise<AuthConfigOverrides> {
  return (await readOperatorState<AuthConfigOverrides>(STATE_TABLE)) ?? {};
}

async function persist(next: AuthConfigOverrides): Promise<AuthConfigOverrides> {
  await writeOperatorState<AuthConfigOverrides>(STATE_TABLE, next);
  await refreshAuthConfigOverrides(); // same-process immediacy
  return next;
}

/** Set (or clear, when roles=null) the full-access bypass-role REPLACEMENT set (escalation; dark-gated). */
export async function setFullAccessRoles(roles: string[] | null): Promise<AuthConfigOverrides> {
  const cur = await readAuthConfigOverrides();
  const next = { ...cur };
  if (roles === null) delete next.fullAccessRoles;
  else next.fullAccessRoles = strList(roles);
  return persist(next);
}

/** Set (or clear, when tools=null) the scoped-SU safe-tool REMOVE set (narrow-only). */
export async function setSafeToolsRemove(tools: string[] | null): Promise<AuthConfigOverrides> {
  const cur = await readAuthConfigOverrides();
  const next = { ...cur };
  if (tools === null) delete next.safeToolsRemove;
  else next.safeToolsRemove = strList(tools);
  return persist(next);
}

/** Set the sandbox policy override: ADD mask dirs (add-only) and/or force deny-all-egress. null clears. */
export async function setSandboxPolicy(
  policy: { maskAdditions?: string[] | null; denyAllEgress?: boolean | null } | null,
): Promise<AuthConfigOverrides> {
  const cur = await readAuthConfigOverrides();
  const next = { ...cur };
  if (policy === null) {
    delete next.sandboxMaskAdditions;
    delete next.sandboxDenyAllEgress;
  } else {
    if (policy.maskAdditions !== undefined) {
      if (policy.maskAdditions === null) delete next.sandboxMaskAdditions;
      else next.sandboxMaskAdditions = strList(policy.maskAdditions);
    }
    if (policy.denyAllEgress !== undefined) {
      if (policy.denyAllEgress === null) delete next.sandboxDenyAllEgress;
      else next.sandboxDenyAllEgress = policy.denyAllEgress;
    }
  }
  return persist(next);
}

export async function setAuthConfigOverrides(o: AuthConfigOverrides): Promise<void> {
  await persist(o ?? {});
}
export async function resetAuthConfigOverrides(): Promise<void> {
  await persist({});
}

// ── config:list-overrides / config:reset-overrides registration (D-005) ───────
registerOverrideConcern({
  name: 'auth-config-overrides',
  description:
    'runtime §G auth/sandbox overrides — full-access bypass roles (replace), scoped-SU safe-tools (narrow), sandbox mask dirs/egress (tighten). DARK: papercusp-auth-config-overrides',
  auditAction: 'auth:set_full_access_roles',
  diff: async () => {
    const o = await readAuthConfigOverrides();
    const entries: OverrideEntry[] = [];
    if (o.fullAccessRoles?.length) {
      entries.push({ key: 'fullAccessRoles', effective: o.fullAccessRoles, default: 'TESTING_FULL_ACCESS_ROLES baked', layer: 'pg-settings' });
    }
    if (o.safeToolsRemove?.length) {
      entries.push({ key: 'safeToolsRemove', effective: o.safeToolsRemove, default: [], layer: 'pg-settings' });
    }
    if (o.sandboxMaskAdditions?.length) {
      entries.push({ key: 'sandboxMaskAdditions', effective: o.sandboxMaskAdditions, default: [], layer: 'pg-settings' });
    }
    if (o.sandboxDenyAllEgress !== undefined) {
      entries.push({ key: 'sandboxDenyAllEgress', effective: o.sandboxDenyAllEgress, default: 'env PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS', layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readAuthConfigOverrides(),
  reset: () => resetAuthConfigOverrides(),
  restore: (snap) => setAuthConfigOverrides((snap as AuthConfigOverrides) ?? {}),
});
