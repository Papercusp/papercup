/**
 * Papercusp's auth-tier → gate-bypass mapping — the host half of plan P-014 /
 * D-006.
 *
 * `@papercusp/tooldef`'s dispatcher reads a neutral `ctx.gateBypass`
 * (`{ role?, capability?, quota? }`) and knows nothing about superuser or
 * power-user tiers. This function encodes the mapping the engine used to
 * hardcode, so the transports can set `ctx.gateBypass` alongside the
 * `isSuperuser`/`isPowerUser` metadata they already populate.
 *
 * The matrix (unchanged from the pre-P-014 baked logic):
 *   - **superuser** (loopback + bearer): bypasses role, capability, AND quota.
 *   - **power-user** (`?power_user=1`): bypasses role + capability for the
 *     operator-tier catalog, but NOT quota — workspace quotas apply to end
 *     users (omp-power-user-bundle-2026-05-20 §4.1). Power-user calls also set
 *     `isSuperuser`, so the carve-out is `quota: superuser && !powerUser`.
 *   - **neither**: no bypass (every gate enforces).
 */
import type { GateBypass } from '@papercusp/tooldef';
/**
 * TESTING-PHASE FULL TOOL ACCESS (owner directive 2026-06-20, EI-2048).
 *
 * While the system is under heavy test, a capability- or role-allowlist gate
 * that silently denies a NEEDED tool masquerades as a different bug and makes
 * debugging harder. So these trusted agent roles get the SAME role+capability
 * bypass as superuser — they should never fail a tool call for lack of a grant.
 *
 * Scope of the bypass: role + capability ONLY. Deliberately NOT quota (cost/
 * rate-limit bugs must still surface) and NOT cross-workspace/identity (unlike
 * a real superuser, these keep their own principal slug + workspace scope, so
 * attribution and RLS are unchanged).
 *
 * RESTRICT LATER: this is a testing-phase widening. To return to least-privilege,
 * the runtime dial `auth:set_full_access_roles` (live-configurability-audit P-019, DARK behind
 * papercusp-auth-config-overrides) REPLACES this baked set, and the runtime master kill-switch is the
 * `papercusp-testing-full-access` flag. Both are reached SYNC through the host-installed resolver below
 * (set by operator-core at boot) — agent-mcp stays free of operator-core + flag/PG IO on the hot path;
 * with no resolver installed, the baked set applies (byte-identical to today). The legacy
 * `PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off` env is KEPT as a test/launch-time override (still honoured
 * first), the flag being the operator-controllable runtime equivalent.
 *
 * KNOWN GAP: the capability-envelope DENY layer (ROLE_ENVELOPES — e.g. overwatch/
 * sentinel denied capability:fs-write/bash) is a SEPARATE gate; this bypass does
 * not lift it. If a watcher role needs code-exec tools under test, lift its
 * envelope too.
 */
export declare const TESTING_FULL_ACCESS_ROLES: ReadonlySet<string>;
/**
 * Host-installed SYNC resolver (live-configurability-audit P-019). Returns a definitive boolean to
 * OVERRIDE the baked decision (the kill-switch off ⇒ false; the dark override set ⇒ membership in it),
 * or `null`/`undefined` to FALL THROUGH to the baked TESTING_FULL_ACCESS_ROLES set. operator-core
 * installs the real resolver (flag-gated, reading its sync-cached store) at boot; until then the
 * baked set governs.
 */
export type TestingFullAccessResolver = (role: string | null | undefined) => boolean | null | undefined;
/** Install (or clear, with `undefined`) the host resolver. Called once by operator-core at boot. */
export declare function setTestingFullAccessResolver(fn: TestingFullAccessResolver | undefined): void;
export declare function testingFullAccess(role?: string | null): boolean;
export declare function papercuspGateBypass(opts: {
    isSuperuser?: boolean;
    isPowerUser?: boolean;
    /** Agent role of the caller (signed-URL spawns) — testing-phase full access. */
    role?: string | null;
}): GateBypass;
