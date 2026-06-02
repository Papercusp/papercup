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
export declare function papercuspGateBypass(opts: {
    isSuperuser?: boolean;
    isPowerUser?: boolean;
}): GateBypass;
