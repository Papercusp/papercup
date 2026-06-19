# Brief AI — Shared-hive ownership: provisional → claimed authority

**Priority: S0/S1 lane.** Integration + GUI + live. Owner-requested (2026-06-19). The
provisional/claimed model is BUILT but NOT in the systematic release-test program.

## Objective
Prove the **provisional-owner → GitHub-verified claimed-owner** authority model is correct,
secure, and honest end-to-end: only the true repo owner can claim, the status is accurate
everywhere, and the authority transitions (claim / supersede / stale) are sound.

## Why it matters
This is the **authority root** of a public shared hive — it decides who is allowed to set
hive policy (the owner-enforcement layer, `PLAN-owner-enforcement-layer.md`, builds on it).
It's fully implemented (`binding-service.ts`, `shared_repo_binding_cache.claim_status`, the
claim API + GUI) but has only piece-level tests — no release-grade end-to-end + adversarial
pass. If a non-owner could claim, or claim-status mis-rendered, the whole spam/abuse-control
story collapses.

## Scope / scenarios
1. **Create → provisional → unclaimed (the default):** creating a shared hive sets
   `claim_status='unclaimed'`, records the creator as `provisional_owner_github_user_id`,
   and the GUI shows the `ProvisionalOwnerExplainer` modal. Assert the binding + the
   provisional-owner identity.
2. **Verified claim (the S0 path):** the true repo owner (GitHub `maintain`/`admin`) calls
   `claimBinding` / `POST /api/harness/binding/claim` → a LIVE GitHub permission check passes
   → `unclaimed→claimed`, claimant appended. Assert the flip + the claimed-by record.
3. **S0 — a NON-owner CANNOT claim:** a user WITHOUT maintain/admin on the bound repo is
   REJECTED (403/permission error), status stays `unclaimed`. Teeth-verify: stub the perm
   check to "admin" → the reject test goes RED (proves it's the real gate, not a UI nicety).
4. **Supersede (admin-only):** only `admin` can `supersedeBinding`; a `maintain`-only
   claimant cannot supersede. Assert the authority ladder.
5. **Stale re-verification:** the 24h daemon (`recheckClaimantPermissions`) flips
   `claimed→stale` when a claimant LOSES repo permission. Simulate permission loss → assert
   the flip + that a `stale` owner's authority is suspended.
6. **Claim status FEDERATES + is honest everywhere:** does `claim_status` reach a joiner
   (so a member sees claimed/unclaimed correctly)? Assert the 4-state badge renders correctly
   in `/adv` harness header, Cupboard, Insights `ProjectCard`, profiles — no surface lies
   (an unclaimed hive never shows "claimed").
7. **Edge/adversarial:** re-claim is idempotent (no dup claimant); two maintainers race to
   claim (deterministic, both recorded or first-wins, no corruption); claim a hive whose repo
   was renamed/deleted (resolves or fails honestly); a forged claim request (wrong identity).
8. **GUI E2E (Tauri, headless, never :0):** drive the real Claim CTA — `HarnessClaimHeader`
   shows "Claim this harness" only when `unclaimed && viewerCanClaim`; clicking → POST →
   status flips → badge updates. Capture DOM/screenshot evidence.

## Method
- Integration (real PG + the binding-service + a mocked/recorded GitHub permission API) for
  scenarios 1–7; reuse `binding-claim.test.ts` + `claim-status-resolver.test.ts` as prior art,
  extend to the adversarial + federation cases. GUI E2E via the Tauri shell + `adv-hive-from-
  github-url.spec.ts` prior art. Teeth-verify the S0 gates (non-owner-claim reject, stale flip).

## Deliverables
- `findings-AI.md`: the authority matrix (create/claim/supersede/stale/federate/render), any
  unauthorized-claim (S0), mis-rendered status (S1), or non-federating claim state (S1).

## Done / verdict
GREEN only when ONLY the GitHub-verified true owner can claim, the 4-state authority model
(unclaimed/claimed/stale/superseded) transitions correctly, claim status federates + renders
honestly on every surface, and no non-owner can seize authority.

## Key files (from the 2026-06-19 ownership trace)
- `packages/operator-core/lib/harness/binding-service.ts` — `createUnclaimedBinding`/`claimBinding`/`supersedeBinding`/`recheckClaimantPermissions`
- `…/harness/claim-status-resolver.ts` — `resolveClaimStatus` view-model
- `…/endpoint-route/routes/harness/{claim-status,binding-claim}.ts`
- `libs/papercusp/libs/db/sql/000-baseline.sql` — `shared_repo_binding_cache` (claim_status)
- GUI: `apps/operator/app/_components/{ProvisionalOwnerExplainer,HarnessClaimHeader,ClaimStatusBadge}.tsx` + `adv/harnesses/useHarnessClaimStatus.ts`
- Plans: `papercusp-dogfood-v5` §15/§5.1, `dogfood-design-memo-binding-service-api`, phase-8 P-068/P-069
