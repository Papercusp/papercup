"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.papercuspGateBypass = papercuspGateBypass;
function papercuspGateBypass(opts) {
    const su = opts.isSuperuser === true;
    const pu = opts.isPowerUser === true;
    return {
        role: su,
        capability: su,
        quota: su && !pu,
    };
}
