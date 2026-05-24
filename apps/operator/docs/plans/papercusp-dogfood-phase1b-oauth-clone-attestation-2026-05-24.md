---
title: Papercusp dogfood — Phase 1b (OAuth + clone + device attestation + binding service + two-channel verifier)
slug: papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 1b (OAuth + clone + device attestation + binding service + two-channel verifier)

## Now

**State:** **draft execution plan.** Phase 1b is the **largest single phase** in the dogfood arc (L-sized, design-heavy). It unlocks every shared-harness feature in Phases 5-9. P-008 (clone helper via `gh auth`) is DONE; **Q-4 (auth-token introspection) RESOLVED 2026-05-24** with the `gh-token.ts` spike (commit `80f2717a`). Remaining greenfield: P-009 Entry 4, P-011 device attestation, P-068 canonical repo binding service, P-075 two-channel verifier — still need a **design pass** before implementation.

**Next:** Write three design memos before any P-task implementation starts:
1. Device attestation UX (the gist creation flow, OAuth scope prompt, error messages).
2. Two-channel binding verifier UX (what does `pending`/`verified`/`unverified` look like in Contributors + Insights surfaces).
3. Canonical binding service API shape (the wire-format and endpoint semantics for P-068, which the Cupboard server in Phase 9 also extends).

Implementation starts only after the three memos are accepted. Q-4 resolved: P-068 / P-011 can consume `lib/identity/gh-token.ts` (cache + scope-check + structured errors).

## Background

Phase 1b implements `## Phase 1b — OAuth + clone + device attestation [L]` from v5 (~line 1190), augmented by addendum-1 (P-068 canonical binding service) and addendum-3 (P-075 two-channel verifier). It is the **single most consequential phase** for the trust properties of the entire dogfood arc — every contributor verification surface (Contributors badges, Insights People card, Cupboard maintainer claims) depends on Phase 1b being right.

**Gate:** Phase 0 `GATE: PASS`. Phase 1b runs **in parallel** with Phase 2 + Phase 4 (single-engineer dogfood doesn't need Phase 1b — Entry 3 + Entry 1 cover the private-harness creation path). However, Phase 5+ is blocked-by Phase 1b.

## Phase tasks

### P-008 — Entry 2 GitHub URL clone (revised 2026-05-24) [M] — ✅ DONE

v5 one-liner: *"Entry 2 (GitHub URL). REVISED 2026-05-24 to use `gh auth login` + system git credential helper, no new deps."*

**Status:** ✅ DONE in commit `6cc4f6c9`.
- Helper: `apps/operator/lib/harness/clone-github.ts` (170 LOC, no new deps).
- `parseGithubUrl` (strict regex allowlist).
- `cloneGithubRepo` (execFile shell-less, structured error codes).
- 35 unit tests pass including bad-org real-network test.
- POST `/api/harness/projects` extended to accept `{slug, githubUrl, shallow?}`.

**Note for Phase 1b consumers:** Entry 2 is now shared-only per D-025. The clone helper is still useful but is wired *downstream* from the new handler that calls P-068 binding service first. That wiring is part of P-068's scope, not P-008's.

**Decision rule:** PASS for clone-helper itself; wiring lands with P-068.

---

### P-068 — Canonical shared-repo binding service [M] — 🔴 NOT STARTED

v5 one-liner: *"Resolve GitHub `repository.id`; lookup/create binding by stable repo id; local `shared_repo_binding_cache`; claim/supersede endpoints; permission verifier for `maintain` / `admin`."*

**Expansion.** The binding service has two deployments: (1) embedded in the desktop operator as a local cache + canonical-id resolver; (2) extended into the Cupboard server in Phase 9 as the public-listing source of truth. v1 ships only (1); Cupboard layer is Phase 9.

**Files:**
- `apps/operator/lib/harness/binding-service.ts` (new) — public surface: `resolveRepoBinding(githubUrl): Promise<BindingRecord | null>` (network), `createUnclaimedBinding(input)`, `claimBinding(binding_id, github_user_id)`, `supersedeBinding(binding_id, replacement_topic, github_user_id)`. Each calls GitHub API (via `gh api`-shelled or direct `@octokit/rest`) for permission verification.
- `apps/operator/lib/harness/binding-service.test.ts` (new) — covers all four flows + permission-denied cases.
- `apps/operator/lib/ensure-schema-dogfood.ts` — add `ensureSharedRepoBindingCacheTable()` (this closes P-013a from Phase 1a).
- `apps/operator/app/api/harness/projects/route.ts` — wire Entry 2 handler to call `resolveRepoBinding` first; on existing-binding show "join existing" alert (UI in P-012e), on no-binding call `createUnclaimedBinding`. Strict per D-025: never creates a private harness from a GitHub URL.

**Sub-acceptances:**
- **P-068a — Resolve by stable id.** Pasting `https://github.com/foo/bar` resolves to a `BindingRecord` whose `github_repository_id` is GitHub's numeric id (not `foo/bar`, which is rename-fragile). Cache hits skip the network.
- **P-068b — Existing binding → join-existing flow.** Posting Entry 2 with a URL whose binding already exists returns a `{kind: 'existing_binding', binding: BindingRecord}` response. The UI layer (P-012e from Phase 1a) renders the join-existing alert.
- **P-068c — No binding → unclaimed creation.** Posting Entry 2 with a URL whose binding doesn't exist creates the binding + the harness + marks `claim_status='unclaimed'`. The harness's creator becomes `provisional_owner_github_user_id`.
- **P-068d — Claim by `maintain`/`admin`.** A user with `maintain` or `admin` perm on the bound repo calls `claimBinding`. Server-side verification via GitHub API confirms the perm before writing the claim. Other perms (read, write, triage) get rejected with a clear error.
- **P-068e — Supersede by `admin` only.** Same as P-068d but stricter perm requirement (admin only). Supersede produces a `superseded_by_harness_topic` pointer + a migration banner trigger for existing contributors.
- **P-068f — Daily permission re-check.** Background daemon re-verifies every claimed binding's claimant perms once per 24h. On revocation, flips `claim_status='stale'` (per v5 §5.1).

**Decision rule:** PASS when P-068a-e pass; P-068f can ship in the same plan or as a follow-up.

---

### P-009 — Entry 4 harness link [L] — 🔴 NOT STARTED

v5 one-liner: *"Entry 4 (harness link): add link-paste flow. Parse `papercusp://harness?topic=<hex>&github=<owner>/<repo>&repo_id=<github_repository_id>` URL scheme. On accept: GitHub OAuth → clone via P-008 → join Hyperswarm topic → bootstrap Hyperbee → seed PG. Device attestation (P-011) runs here on first-join."*

**Expansion.** The full join flow specified in v5 §3 Entry 4 (steps 1-9 including 6.5 push of `.harness/contributors/<github_login>.json`). This is the most-touched-by-other-tasks task in Phase 1b — it threads through P-011 (attestation), P-075 (binding verifier), and step 9 routes to Insights from §9.0.

**Files:**
- `apps/operator/lib/harness/url-scheme.ts` (new) — `parseHarnessLink(url): HarnessLink | null`. Validates the `papercusp://harness?...` scheme strictly (allowlist params, reject extras).
- `apps/operator/lib/harness/join-shared-harness.ts` (new) — the orchestration helper. Runs all 9 steps in sequence; each step has its own try/catch with a structured error that becomes a UI message. Idempotent at each step boundary so a partial-fail can be resumed.
- `apps/operator/app/harness/EntryHarnessLinkForm.tsx` — replace the Phase 1a placeholder with the live form. Paste URL → preview "you're about to join `<github_full_name>` (currently `<claimed/unclaimed>`, `<N contributors>`)" → confirm → run `join-shared-harness.ts` with progress UI.
- `apps/operator/app/harness/JoinProgress.tsx` (new) — 9-step progress UI mirroring the §3 Entry 4 flow. Each step shows pending/running/done/error with explanatory copy. Long-running steps (clone, Hyperbee bootstrap) get sub-progress.
- Tests in `apps/operator/lib/harness/__tests__/join-shared-harness.test.ts` — mocked-step happy path + each step's error path.

**Sub-acceptances:**
- **P-009a — URL scheme parser** — strict, rejects malformed URLs with clear errors.
- **P-009b — Each of the 9 steps is independently testable** — happy path mocked.
- **P-009c — Idempotent resume** — a partial-fail at step 5 can be re-run from step 5 without redoing 1-4.
- **P-009d — Routes to Insights on completion** — step 9 invokes the §9.0 first-visit auto-route (P-074 from Phase 1a/Phase 8 — coordinate with whichever lands first; Phase 1b should not block on it but should be wired through it).
- **P-009e — Live integration test** — against a real test harness link published from a sibling test workspace, the full flow completes without manual intervention.

**Decision rule:** PASS when all sub-acceptances pass.

---

### P-011 — Device attestation [L] — 🔴 NOT STARTED

v5 one-liner: *"Device attestation: Octokit + gist creation flow with required scopes `gist` + `read:user`. Verifier helper for inbound bindings. Local cache (~24h TTL). Tests against a real GitHub test account."*

**Expansion.** The §0.2 flow — generate Ed25519 keypair, store in OS keychain, complete OAuth, create gist with binding payload, publish Hyperbee binding row. The verifier helper is called by every peer on first sight of a new device pubkey.

**Files:**
- `apps/operator/lib/identity/attest.ts` (new) — main module. `generateDeviceKeypair()`, `createAttestationGist(token, payload)`, `verifyAttestation(gist_id, claimed_pubkey, claimed_github_user_id): Promise<{valid: boolean, reason?: string}>`.
- `apps/operator/lib/identity/keychain.ts` (new) — OS-specific keychain access (libsecret on Linux, Keychain on macOS, Credential Manager on Windows). Probably wraps an existing crate via Tauri command if direct Node access is hard.
- `apps/operator/lib/identity/attest.test.ts` — covers keypair gen, gist creation (mocked), verification (mocked GitHub API responses for valid/invalid cases), 24h cache hit/miss.
- A test fixture in `apps/operator/lib/identity/__fixtures__/` with a known-good gist payload + signature for verifier unit tests.

**Sub-acceptances:**
- **P-011a — Keypair lifecycle** — generate on first run, persist to keychain, re-read on subsequent runs.
- **P-011b — Gist creation with required scopes** — uses `gist` + `read:user` OAuth scopes; rejects gracefully if user grants only `read:user`.
- **P-011c — Verifier matches `gist.owner.id` to claimed `github_user_id`** — both must agree, otherwise reject as forged.
- **P-011d — Signature check** — gist body's `signature_by_device` is valid Ed25519 over the canonical payload.
- **P-011e — Cache hit/miss** — verified bindings cached for 24h; expired cache triggers re-verification on next use.
- **P-011f — Revocation detected** — gist deleted (404 on re-verify) → device's pubkey marked revoked locally; subsequent signatures from it are rejected.
- **P-011g — Real-GitHub integration test** — against a test GitHub account with a test gist, the full create + verify cycle works end-to-end.

**Decision rule:** PASS when P-011a-f pass; P-011g requires a test GitHub account and may be flagged as a separate CI lane.

---

### P-075 — Two-channel binding verifier (addendum 3) [M] — 🔴 NOT STARTED

v5 one-liner: *"Two-channel binding verifier (D-031 / §0.2.7). Channel 1 server-side `gh api /user`. Channel 2 signed `.harness/contributors/<github_login>.json` pushed via GitHub-verified commit. Augments `contributors` schema with `binding_status` etc."*

**Expansion.** Extension of P-011 — adds the second verification channel + persists the binding state on the `contributors` HYPERBEE row. P-011 alone leaves the asymmetric trust window open (see §0.2.7); P-075 closes it.

**Files:**
- `apps/operator/lib/identity/two-channel-verifier.ts` (new) — exports `verifyChannel1(token, claimed_github_user_id)`, `verifyChannel2(github_login, commit_sha)`, and `verifyBoth(...)`.
- `apps/operator/lib/identity/two-channel-verifier.test.ts` — covers each channel's pass/fail/network-error paths.
- Schema update via `apps/operator/lib/ensure-schema-dogfood.ts` — add the `binding_status`, `channel1_verified_at`, `channel2_verified_at`, `channel2_branch_ref`, `binding_last_checked_at` columns to `contributors` per §7.1 (addendum 3).
- `apps/operator/lib/harness/join-shared-harness.ts` (from P-009) — wire `verifyBoth` after step 8 of Entry 4 (per §3 Entry 4 step 8 wording).
- Background daily re-check daemon (similar to P-068f) — re-runs `verifyBoth` for every active contributor row.

**Sub-acceptances:**
- **P-075a — Channel 1 pass case** — OAuth token + claimed id → `gh api /user` returns matching id + login → channel 1 verified.
- **P-075b — Channel 1 fail case** — token doesn't match claimed id → verifier rejects, contributor row marked `unverified`.
- **P-075c — Channel 2 pass case** — `.harness/contributors/<github_login>.json` exists on `user/<github_user_id>` branch, body signature valid, `GET /repos/owner/repo/commits/<sha>` returns `author.login == github_login` AND `verification.verified == true` → channel 2 verified.
- **P-075d — Channel 2 fail cases** — file missing → unverified; signature invalid → unverified; commit author login mismatch → unverified; `verification.verified == false` → unverified.
- **P-075e — Pending state** — channel 1 passes but channel 2 still propagating (file not yet visible via `git fetch`) → contributor marked `pending` for up to 24h; demoted to `unverified` after that.
- **P-075f — UI hooks** — the new `binding_status` column drives the Contributors tab binding badge (Phase 8 P-048 update from addendum 3); verify the rendering pattern with a fixture.
- **P-075g — Daily re-check daemon** — pulls all `verified` contributor rows, re-runs `verifyBoth`, demotes to `unverified` if a channel fails (with a one-week grace + alert before final demotion to avoid flapping on transient GitHub outages).

**Decision rule:** PASS when P-075a-f pass; P-075g can ship as a follow-up if scope-cut needed but **must** be in by Phase 8 (Insights surfaces depend on accurate verified-status).

---

## Decisions

(Three design memos pending — see `## Now`. Memos become D-001 / D-002 / D-003 here when accepted.)

## Named fallback rollout

Phase 1b has no substrate-class fallback. The closest failure modes:

- **`gh auth login` flow turns out to be unreliable on Windows.** Mitigation: keep the OAuth-device-flow path (`@octokit/auth-oauth-device`) as a documented Plan B, even though the in-tree pattern is gh-CLI. If Windows gh-CLI is broken, swap that platform to the device flow. This is a scope expansion, not a substrate fallback; not formally documented as a rollout.
- **GitHub branch-push protections block the channel-2 commit.** Mitigation: the share-this-harness wizard (Phase 5a P-029) should detect + document branch protection requirements before share-time so the binding doesn't fail at join-time. If detected too late, channel-2 falls back to "approved-by-channel-1-only with limited stats access" — degraded but usable.

No formal named fallback section needed.

## Cross-references

- **`papercusp-dogfood-execution-plan-index-2026-05-24.md`** — index.
- **`papercusp-dogfood-v5-2026-05-23.md`** — `## Phase 1b`, `### §0.2 — Device binding`, `### §0.2.7 — Two-channel binding verification` (addendum 3), `### §3 — Create-harness UI`, `### §5.1 — Canonical repo binding + claim harness` (addendum 1), `### §10.2 — Cupboard schema`.
- **`papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24.md`** — Phase 1b unlocks the placeholder forms in P-012e. Coordinate the wire-up.
- **`apps/operator/lib/harness/clone-github.ts`** — P-008 DONE artifact, reused by P-009.
- **D-010** (numeric branch names), **D-025** (GitHub URL = shared-only), **D-026** (canonical binding by repo id), **D-027/D-028/D-030/D-031** (addendum 3 trust + identity decisions).

## Open questions

### Q-1 — Where do the three design memos live?

Suggested location: `apps/operator/content/internal-docs/design/dogfood-phase1b-*.mdx` (one MDX per memo). Memos lint via the existing docs site; they're discoverable by anyone browsing the design section. Confirm before writing the first memo.

### Q-2 — Channel 2's `.harness/contributors/<github_login>.json` file — what's the canonical-form serialization?

Stable canonicalization matters for signature verification across implementations. Suggested: JCS (RFC 8785) JSON Canonicalization Scheme. Decide before P-075c's signature-check implementation.

### Q-3 — How does the daily permission re-check (P-068f) handle GitHub API rate limits at scale?

At 100 shared harnesses × 24h re-check, that's still well under GitHub's 5000/hr authenticated rate limit. But: each harness may have multiple claimants. Realistic projection: ~500-1000 claimants total. Bunch with PR-poll daemon's budget allocation (Phase 7 P-042). Decide before P-068f ships.

### Q-4 — Can `gh auth login`-based git credentialing be reliably introspected to get the OAuth token for `@octokit/rest`?

P-068 (permission verification) needs to call GitHub APIs with the user's auth. If we're piggybacking on `gh auth`, can we read the token? `gh auth token` prints it, but shelling out for every API call is slow. Alternative: install `@octokit/rest` separately and have the user complete a second OAuth flow specifically for Papercusp. Decide before P-068's first commit.

## For the next agent (Phase 5a)

Phase 5a starts as soon as Phase 1b ships (or at minimum P-068 + P-075 ship — P-011 deeper edge cases can land later).

What Phase 5a inherits:
- The `contributors` HYPERBEE table with `binding_status` populated. Phase 5a's UI work assumes this column exists.
- The `shared_repo_binding_cache` LOCAL table from P-013a (closed by P-068's first commit).
- The clone helper + OAuth path used by §5 wizard (P-029).

What Phase 5a should NOT carry forward:
- Re-implementing the binding service. Phase 5a's wizard calls the existing service from P-068.
- Re-implementing the two-channel verifier. Phase 5a's contributor-publish step calls `verifyBoth` from P-075.

Phase 5a's first task (P-029 share wizard) directly consumes everything Phase 1b ships. Treat it as a single integrated thread.
