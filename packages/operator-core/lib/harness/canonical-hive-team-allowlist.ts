/**
 * canonical-hive-team-allowlist — the TEAM allowlist for the canonical `papercusp`
 * hive, in a module of its own so it can NEVER reach a client bundle.
 *
 * WHY THIS IS A SEPARATE FILE (WI-38322, split out of canonical-hive-invite.ts 2026-08-12)
 * ---------------------------------------------------------------------------------------
 * It used to live beside CANONICAL_PAPERCUSP_HIVE_INVITE in canonical-hive-invite.ts.
 * That module has TWO consumers with DISJOINT reach:
 *
 *   CANONICAL_PAPERCUSP_HIVE_INVITE  → papercusp-hive-join.ts   → reaches the CLIENT bundle
 *   CANONICAL_HIVE_TEAM_ALLOWLIST    → papercusp-hive-share.ts  → SERVER only
 *
 * Bundlers include a module WHOLE. So the client chunk (papercusp-hive-join-*.js), which
 * legitimately needs only the baked invite, was also shipping the real GitHub logins of
 * every team member to anyone who downloaded the app. Measured during the 0.0.16-alpha cut:
 * the emitted chunk literally contained `W=["aviynw","papercupai"]`, and the same bytes were
 * present in the SHIPPED sidecar SPA — not merely in a stale local dist.
 *
 * The leak had no compensating benefit, because this allowlist is NOT a client-side check.
 * Admission is decided server-side in goSharedHive against each peer's device-attestation-
 * bound GitHub identity. A copy in the client authorises nothing; it only discloses.
 *
 * KEEP IT THAT WAY: import this module ONLY from server-side code. If a client-reachable
 * module ever imports it, the handles return to the bundle. That is not left to discipline —
 * the release identity gate now FAILS on these strings (the AUTHORISED_PRODUCT_STRINGS
 * acceptance that used to permit them was retired together with this split), so a
 * reintroduction breaks the release build rather than shipping quietly.
 */

/**
 * GitHub LOGINS that the owner-signed admission policy admits IN ADDITION to the owner
 * (papercusp-hive-share.ts goSharedHive). This is what makes the dogfood a real SHARED
 * hive: every teammate who installs auto-joins and federates content, while repos stay
 * PRIVATE and non-allowlisted installs are refused (dogfood-silent-canonical-hive-join
 * D-001 / P-007).
 *
 * POPULATED (P-007, 2026-06-29) by DERIVING from the live canonical-hive membership — the
 * GitHub identities VERIFIED in the `papercusp` hive (harness_shared.pot_members,
 * binding_status 'verified'): `aviynw` (the owner) + `papercupai` (the org/bot identity, a
 * verified member across all of this workspace's hives). These are the actual team, not
 * guessed. `aviynw` is also auto-merged as the owner in goSharedHive (dedup-safe). To add a
 * NEW teammate: append their GitHub login here. Empty ⇒ only the owner's own devices
 * auto-merge. Logins are matched against each peer's device-attestation-bound GitHub
 * identity (not spoofable).
 */
export const CANONICAL_HIVE_TEAM_ALLOWLIST: readonly string[] = ['aviynw', 'papercupai'];
