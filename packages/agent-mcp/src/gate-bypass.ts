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
 * RESTRICT LATER: this is a testing-phase widening. To return to least-
 * privilege, trim `TESTING_FULL_ACCESS_ROLES` to the roles that still need it,
 * or set env `PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off` as a global kill switch.
 *
 * KNOWN GAP: the capability-envelope DENY layer (ROLE_ENVELOPES — e.g. overwatch/
 * sentinel denied capability:fs-write/bash) is a SEPARATE gate; this bypass does
 * not lift it. If a watcher role needs code-exec tools under test, lift its
 * envelope too.
 */
export const TESTING_FULL_ACCESS_ROLES: ReadonlySet<string> = new Set([
  'operator',
  'queen',
  'bee',
  'overwatch',
  'sentinel',
  'scout',
]);

export function testingFullAccess(role?: string | null): boolean {
  if (process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES === 'off') return false;
  return role != null && TESTING_FULL_ACCESS_ROLES.has(role);
}

export function papercuspGateBypass(opts: {
  isSuperuser?: boolean;
  isPowerUser?: boolean;
  /** Agent role of the caller (signed-URL spawns) — testing-phase full access. */
  role?: string | null;
}): GateBypass {
  const su = opts.isSuperuser === true;
  const pu = opts.isPowerUser === true;
  const testRole = testingFullAccess(opts.role);
  return {
    role: su || testRole,
    capability: su || testRole,
    // testing-phase roles still pass through the quota gate (don't mask cost/
    // rate bugs); only a real superuser (and not power-user) bypasses quota.
    quota: su && !pu,
  };
}
