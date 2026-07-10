# Brief EN-1 — Owner-enforcement: policy model + claim-gated authoring

**Implementation brief.** Plan: `PLAN-owner-enforcement-layer.md` (Phase EN-1). The
FOUNDATION — no enforcement yet, just the owner-signed federated policy + the authoring
surface. Independent; unblocked (A-003 (a′) landed). EN-2/3/4 build on this.

## Build
1. **`hive_policy` storage (federated, owner-signed).** New `harness_shared.hive_policy`
   mirroring the `hive_settings` projection pattern (the one A-003 (a′) made federate):
   columns = `(workspace_id, hive_home_slug, policy_json jsonb, owner_pubkey, signature,
   policy_version int, origin, fed_ts, fed_hlc, created_at, updated_at)`, PK `(workspace_id,
   hive_home_slug)`. fed_hlc (mig-314) so a newer policy wins deterministically. Migration +
   the projection module (data-apply mirroring `projections/pot-settings.ts`) + the op-keys
   mapper + capture/drain wiring so it federates owner→members on the pot-home seam.
2. **Policy schema (typed).** `policy_json` = `{ rate?: {opsPerMin, rowsPerHour, prsPerDay},
   membership?: 'open'|'approval'|'allowlist', allowlist?: string[], moderation?: {reportable:
   bool}, contrib?: {...} }`. Versioned; forward-compatible (unknown keys ignored, not dropped).
   Default = absent policy ⇒ no enforcement (permissive), so existing pots are unaffected.
3. **Owner signature.** Policy is signed by the owner's pot key; the projection apply
   VERIFIES the signature (reuse the read-admission signature plumbing) — an unsigned/forged
   policy is REJECTED, never applied. This is what makes the policy authoritative over P2P.
4. **Claim-gated authoring API + GUI.** `POST /api/pot/:id/policy` — gated: ONLY
   `claim_status==='claimed'` AND viewer ∈ `claimed_by_github_user_ids` (live maintain/admin
   re-check via `binding-service`). An `unclaimed` pot returns 403 (provisional owner can't
   lock down — matches the design). Minimal GUI: a "Pot policy" settings panel gated on the
   same authority (reuse `useHarnessClaimStatus` / `HarnessClaimHeader` patterns), nuqs-driven
   open-state.

## Depends on / reuses
- A-003 (a′) pot-home federation (✅ landed) — policy federates owner→members on it.
- `binding-service.ts` (authority check), `hive_settings` projection (federation pattern),
  mig-314 fed_hlc (policy ordering), read-admission signature plumbing.
- NO dep on the C-001 re-key (that's only for EN-3's revocation teeth).

## Tests (teeth-verified)
- Policy round-trips owner→member (federates); a NEWER policy_version wins (fed_hlc order).
- S0: only a `claimed` + claimant-viewer can write policy (non-claimant 403; unclaimed 403) —
  teeth: stub the authority to claimant → the reject test goes RED.
- S0: a forged/unsigned policy is REJECTED at apply (teeth: neuter the sig check → forged
  policy applies = RED).
- Absent policy = no behavior change (existing pots unaffected).

## Done
GREEN when an owner-signed policy authored only by the claimed owner federates to members,
is signature-verified, orders by fed_hlc, and a non-owner/forged policy cannot be written or applied.
