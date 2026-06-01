---
title: Phase 1b — bidirectional federation (join-flow Model-B redesign)
slug: papercusp-phase1b-bidirectional-federation-2026-06-01
status: draft
created: 2026-06-01
owner: avi@storewolf.com
supersedes_design: extends papercusp-substrate-model-b-rewrite-2026-05-31 (the substrate is built through Stage 7; this wires the live join/share identity pipeline onto it so two real engineers federate bidirectionally)
---

# Phase 1b — Bidirectional federation: join-flow Model-B redesign

## Now

**State:** **DESIGN SPEC — approved in brainstorm; awaiting an implementation plan (writing-plans).** No code yet.

**What this is:** The Model B substrate (per-peer signed logs + LWW read-merge) is built + unit-proven through Stage 7, and its transport is verified by the testnet two-peer test (`two-peer-swarm.test.ts`). The original "Phase 1b" (OAuth + clone + attestation + binding service + two-channel verifier, plan `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24`) is also marked complete — but it was built for the *old Autobase* substrate, and a code audit (2026-06-01) found the live join/share identity pipeline is **not** correctly wired onto Model B. This spec is that wiring, redesigned for Model B.

**North star (D-001):** **Fully federated + bidirectional.** "Join succeeded" must mean data is actually flowing *both ways*: both peers publish a verifiable binding, the substrate boots on join, the peers admit each other, and a first read-merge has landed (the joiner sees the publisher's feature queue and vice-versa). This makes a gate-active two-machine P-079 a real, checkable test.

**Next:** writing-plans turns this spec into staged implementation items; then build + the bidirectional verification (§9).

---

## Context / problem

For two engineers to collaborate over the substrate, **five stages** must work *for each peer, in each direction*:

1. **Identity** — device Ed25519 key + `gh` auth. *(live)*
2. **Binding publish** — push a device-signed `.harness/contributors/<login>.json` to the shared repo's `user/<id>` branch on GitHub (the artifact proving "device X = GitHub user Y").
3. **Boot + announce** — `bootHarnessSubstrate` joins the swarm topic + sends a signed announce.
4. **Admission** — on a peer's announce, verify *that peer's* published binding; admit only if it verifies.
5. **Replicate + merge** — the admitted peer's log replicates into local PG.

A 2026-06-01 audit found the machinery for these stages is ~95% built and mostly wired, but with **three defects** that make true bidirectional federation impossible today:

- **Defect 1 — join can't authenticate.** `EntryHarnessLinkForm` (Entry 4, live in the operator-vite shell) calls `/api/harness/join-link` with `token:'', githubUserId:0, githubLogin:''` (comment: *"OAuth credentials not yet wired (Phase 1b OAuth plugin)"*). The endpoint hard-requires those from the body → returns 400 "GitHub authentication required." Nothing resolves the joiner's identity server-side, even though `local-announce-identity.ts` and `verify-binding-adapter.ts` already resolve exactly that from local `gh` auth.
- **Defect 2 — admission can't verify a *different* user (keystone).** `verify-binding-adapter.ts` calls `verifyBoth` with `channel1: { token: <LOCAL token>, claimedGithubUserId: <REMOTE id> }`. `verifyChannel1` does `GET /user` with that token and fails `oauth_user_id_mismatch` whenever `data.id !== claimedGithubUserId` — i.e. for any *different* engineer (the actual use case). `deriveBindingStatus` maps a channel-1 fail → `unverified` → **not admitted.** Two different GitHub users literally cannot federate. Never hit because a gate-active two-user federation has never run.
- **Defect 3 — only the joiner publishes a binding.** `step7_pushContributorFile` is called *only* from the join orchestrator. The publisher's share path (`ShareWizard` → `share-finalize`) writes `shared.json`, creates a provisional canonical-owner binding row, and reboots — but **never publishes the publisher's contributor file.** So even after Defect 2 is fixed, a joiner can't verify the publisher → no data flows publisher→joiner. Federation is one-way.

Plus two divergences from comparable systems, surfaced by a research pass (Keybase / Sigstore / Radicle / Signal / MLS — see §8):
- **No replay/freshness on the signed announce** (Radicle/Nostr carry a timestamp). Folded into scope (D-007).
- **One verifiable device per GitHub login** (contributor-file path is login-keyed). Recorded as a known limitation, not built (D-008).

---

## Decisions

- **D-001 — North star: fully federated + bidirectional.** Join success = both bindings published + substrate booted + mutual admission + first read-merge landed.
- **D-002 — Admission verifies channel-2 ONLY (keystone).** A remote peer can only verify the *remote-verifiable* channel — the GitHub-published, device-signed contributor file whose commit GitHub attests as authored by that login. Channel-1 (OAuth `GET /user`) is a *self*-attestation (you can't run it for another user — no token), so it leaves the admission path and stays a publish-time/self badge check. **Aligns with Keybase (verify the public signed proof), Sigstore (OIDC at issuance; verify the artifact later), and Radicle (verify signed refs against the published key).** The current code is the outlier; this fixes it (§8).
- **D-003 — Symmetric publish.** One reusable `ensureMyBindingPublished()` is called by *both* share (publisher) and join (joiner), so the mutual binding can't be forgotten on either side.
- **D-004 — Server-side identity resolution.** The joiner's `{token, githubUserId, githubLogin}` is resolved server-side from local `gh` auth (a shared `resolveLocalGithubIdentity()`), not sent from the UI. Not authed → `gh_auth_required`.
- **D-005 — Join orchestrator restructured to 6 Model-B steps + auto-boot.** The Autobase-era steps are collapsed/removed (§ Section 4).
- **D-006 — Channel-2-only admission verifier + pending-retry.** `verify-binding-adapter` returns a 3-state (ok/pending/fail); `pending` peers are retried within the grace window; `fail`/`bad_sig`/`revoked` never retry.
- **D-007 — Announce freshness.** Add `ts` (+ optional `nonce`) to the signed `AnnounceBody`; `verifyAnnounce` rejects announces outside a clock-skew-tolerant window. Wire-format change (alpha, no back-compat).
- **D-008 — Multi-device-per-login is OUT OF SCOPE.** Recorded as a known limitation; not built this pass.
- **D-009 — Revocation/freshness rides on re-verification + the revoked-set** (no Sigstore-style short-lived certs / transparency log). Channel-2 is re-read on each re-announce; a deleted branch/file or rotated key flips the peer to fail/pending; the `revoked_pubkeys` set is the explicit removal path.

---

## Design

### Section 1 — Admission = channel-2 only (keystone) [D-002]

When peer B receives peer A's announce, B verifies **only** the remote-verifiable channel-2 against A's published contributor file:
- (b) the file's `signature_by_device` is valid Ed25519 over the JCS-canonical body → the announcing device controls the key in the file;
- (c) the commit that published it is **GitHub-verified and authored by `github_login`** → GitHub itself attests the identity.

So channel-2 alone binds `device_pubkey ↔ github_login ↔ github_user_id`. Channel-1 (`GET /user`) is **not** runnable cross-user (no token in the announce; running it with B's own token only ever proves B's identity) — it stays a *self/publish-time* check (own "✓ verified" badge, claim-CTA gate) and is removed from admission.

**Implementation:** `verify-binding-adapter.ts` is rewritten to run `verifyChannel2` only and return a 3-state. `verifyBoth` is retained for the self/publish path. Channel-2's `token` arg stays — it's the local peer's GitHub-API *read* credential (correct), not an identity check.

**Not a security regression:** channel-1 was never remote-verifiable, so removing it from admission removes nothing B could trust; channel-2(c) (a GitHub-verified commit authored by that login) is a stronger anchor than an OAuth re-check.

### Section 2 — Symmetric publish pipeline: `ensureMyBindingPublished()` [D-003]

New module `apps/operator/lib/harness/ensure-binding-published.ts`. The one sequence that makes *me* a verifiable peer, called by **both** share and join:
1. Resolve my GitHub identity (Section 3) + ensure my device keypair (`loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(githubUserId))`).
2. Ensure my device-signed `.harness/contributors/<login>.json` exists on the `user/<id>` branch via a **GitHub-verified commit** (see Open Risk R-1). Idempotent: if the published file already carries my current device pubkey, no-op.
3. Return the resolved identity for the caller to reuse.

**Absorbs** the join orchestrator's old `step6_createUserBranch` + `step7_pushContributorFile` (they become this unit) and is **added to the share path** (`share-finalize`) — the Defect-3 fix.

### Section 3 — Identity resolution + endpoint/UI wiring [D-004]

- New shared `resolveLocalGithubIdentity()` → `{token, githubUserId, githubLogin}` or a `gh_auth_required` outcome, consolidating `getGhAuthToken()` + `getOctokit().users.getAuthenticated()` (dedupes what `local-announce-identity` already does).
- `join-link.ts`: resolve identity server-side; drop the body requirement for `token/githubUserId/githubLogin`; return **401 `gh_auth_required`** when not authed. `keychainId` stays server-derived from the resolved id.
- `EntryHarnessLinkForm.tsx`: stop sending empty creds; surface `gh_auth_required` as "Run `gh auth login`"; update the `JoinProgress` step list to the new steps.

### Section 4 — Join orchestrator restructured for Model B [D-005]

The 10-step Autobase-era list collapses to **6 honest steps**:

`oauth_attest` (resolve identity + ensure device key) → `clone_repo` → `publish_binding` (= `ensureMyBindingPublished`) → `boot_federate` (boot the substrate → join swarm + announce) → `await_admission_merge` (bounded wait until the peer is admitted + first read-merge lands — the *fully-federated* success signal) → `route_insights`.

Removed/folded: `join_hyperswarm` (stub) folds into `boot_federate`; `seed_pg` (stub) folds into `await_admission_merge`; **`publish_binding`-as-Hyperbee-row is deleted** (Model B has no binding rows — the binding is the GitHub artifact + the announce). Join **auto-boots** the substrate so federation starts immediately rather than on the next boot cycle.

### Section 5 — Admission rewrite + announce freshness [D-006, D-007]

- `verify-binding-adapter.ts`: run `verifyChannel2` only → `ok`=admit, `pending`=retry-within-grace, `fail`=reject; return the 3-state so the decider can act on `pending`.
- **Pending-retry (self-healing window):** `pending` peers go in a re-verify set, retried on the next announce + a bounded timer up to the grace window; `fail`/`bad_sig`/`revoked` never retry. This absorbs the GitHub-propagation lag between "binding pushed" and "binding visible to the verifier."
- **Announce freshness [D-007]:** add `ts: number` (+ optional `nonce`) to `AnnounceBody` so the signature covers it; `announceSigningBytes` includes the new field(s); `verifyAnnounce` rejects announces whose `ts` is outside a clock-skew-tolerant window. Both peers adopt the new wire format (alpha, no back-compat). Low-severity hardening (a replayed announce only re-presents an already-verifiable identity, and a revoked pubkey is refused regardless), but it closes a gap reviewers will flag and that Radicle/Nostr already close.

### Section 6 — Errors, testing, known limitations

**Errors:**
- `gh_auth_required` → UI prompts `gh auth login`.
- GitHub API down → channel-2 `fail` (`github_api_down`); admission rejects but the pending-retry re-attempts.
- Propagation 404 (binding not yet visible) → channel-2 `pending` → self-heals via retry.
- Push / slug-conflict (409) surfaced per-step in `JoinProgress`.

**Testing:**
- **Unit:** `ensureMyBindingPublished` (idempotent + mutual), `resolveLocalGithubIdentity` + `gh_auth_required`, the channel-2-only adapter (ok/pending/fail mapping), the pending-retry loop, announce-freshness (rejects stale/replayed; accepts fresh).
- **Integration (deterministic):** extend the testnet two-peer-swarm test to **two distinct identities** each with a **fixture contributor file + injected `verifyChannel2`**, asserting **bidirectional** convergence (each peer's PG shows the other's rows) over the real swarm. This is the gate-active equivalent, offline + deterministic.
- **Manual (final acceptance):** the real two-GitHub-account, two-machine P-079 — now actually runnable.

**Known limitations (recorded, NOT built — D-008):**
- One verifiable device per GitHub login (contributor-file path is login-keyed; a second device for the same login overwrites the first's file and breaks its federation). A multi-device design needs an array of device pubkeys or per-device file paths — future work.
- Login-rename fragility: the contributor-file path is keyed by `github_login`, which changes on a GitHub rename (the `user/<id>` branch is keyed by the stable numeric id). Rare; future work.

---

## Open risks

- **R-1 — GitHub-verified commit for channel-2(c).** Channel-2 step (c) requires `commit.verification.verified === true`. A plain local `git commit` + push is **not** GitHub-verified unless the signing key is registered on the account. If the existing `step7_pushContributorFile` git-pushes a locally-signed commit, channel-2(c) fails for everyone. **The implementation plan must confirm how the contributor-file commit becomes GitHub-verified** — most likely by publishing via the GitHub **Contents API** (PUT `/repos/.../contents/...`), which produces a web-flow-signed → verified commit. This is correctness-critical, not optional.

---

## Verification (definition of done)

1. A real second engineer joins a shared harness through the live desktop UI (Entry 4) with only local `gh` auth — no manual credential entry.
2. Both peers' contributor files are published (verified commits) on the `user/<id>` branches.
3. The two peers admit each other (channel-2 verified, both directions) over the live swarm.
4. A write on peer A appears in peer B's PG and vice-versa (bidirectional read-merge).
5. The deterministic two-identity testnet test (§6) is green; the manual two-machine P-079 passes 5+/7 walkthrough steps within 30s (per the Phase-11 plan's decision rule).

---

## References

- Substrate: `papercusp-substrate-model-b-rewrite-2026-05-31` (the rewrite this builds on); `papercusp-substrate-model-b-impl-2026-06-01` (its impl plan).
- Original Phase 1b: `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24` (the machinery, built for Autobase).
- P-079 / dogfood: `papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-26` (Q-2 same-laptop surrogate; the 5+/7-in-30s decision rule).
- Trust model: `papercusp-trust-model-2026-05-31` (Addendum C/D).
- Key code: `apps/operator/lib/identity/{two-channel-verifier,binding-verifier-types,contributor-file-types,device-keychain-id,gh-token,octokit-client}.ts`; `apps/operator/lib/sync/hyperbee/{boot,announce,read-admission,verify-binding-adapter,local-announce-identity}.ts`; `apps/operator/lib/harness/join-shared-harness.ts`; `apps/operator/lib/endpoint-route/routes/harness/{join-link,share-finalize}.ts`; `apps/operator/app/harness/{EntryHarnessLinkForm,ShareWizard,JoinProgress}.tsx`.
- Research analogs (§8 justification): Keybase social proofs, Sigstore/Fulcio keyless (OIDC at issuance, verify artifact later), Radicle signed refs, Signal/MLS multi-device + PCS.

## §8 — Research alignment (why D-002 is right)

Comparable systems all verify a **publicly-verifiable signed artifact against public key material; the secret is used only by the prover, at creation time**:
- **Keybase** — others verify your GitHub binding by reading your *public signed statement* and checking the signature; they never hold your secret. = channel-2.
- **Sigstore/Fulcio** — OIDC verified once at *issuance*; verification is done later against the artifact + transparency log, *separate from issuance*. = channel-1 at publish / channel-2 at admission.
- **Radicle** — peers verify signed refs/announcements against the published Ed25519 key; "verify another node's content without inspecting the node directly."

So D-002 moves Papercusp *toward* the standard; the current channel-1-at-admission code is the category error (running a secret-credential check on the verifier side with the wrong party's secret). The one conscious divergence (no short-lived certs / transparency log for freshness) is covered by D-009 (re-verification + revoked-set), justified because the substrate is advisory and GitHub PR-merge is the real authority.
