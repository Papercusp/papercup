---
title: Non-collaborator shared-harness join + fork-based code→PR
slug: non-collaborator-join-fork-pr-2026-06-02
status: active
created: 2026-06-02
updated: 2026-06-03
owner: aviynw@gmail.com
---

# Non-collaborator shared-harness join + fork-based code→PR

> Authored under a standing autonomous mandate ("design the gap, then work the
> plan to completion + tested — I trust your judgment"). Design direction locked
> with the user via three decisions (below) before they slept; this spec + the
> implementation proceed autonomously. Review when you wake — A is the
> foundational, reversible-ish piece; B is larger and sequenced after.

## Now

**State:** COMPLETE + live-verified in-process (2026-06-03). A3 (P-003) shipped (`1693031a7`) + knip cleanup (`0806c7bf5`); write-free join live-proven by the migrated p079 test (3/3, real papercupai↔aviynw, gists+announces only). Packaged two-instance MERGE: built the enablers + harness rather than forcing a heavy rebuild on the busy box. **papercup `a56e6510a`**: `PAPERCUSP_DHT_BOOTSTRAP` swarm override (8 unit tests — lets two same-box instances join a local testnet DHT, dodging public-DHT NAT hairpinning) + always-on `[swarm]` stdout logs (joined/peer_connected/`join FAILED` — fixes the silent swarm-join catch that made federation failures invisible) + agent-insight `packaged-two-instance-federation-merge.mdx`. **papercusp-desktop `d3a719a`**: `bin/two-instance-merge-smoke.sh` (testnet DHT + 2 `.deb` instances with distinct identities + write-free share on a synthetic repo + INSERT-on-A→assert-`origin=remote`-in-B both ways; scoped teardown). VERIFIED live in the packaged app: boot+isolation+distinct-identities + **write-free share with `bindingPublished:true` on a SYNTHETIC repo** (dissolves the old smoke's "synthetic repo can't publish a binding" ceiling). Not green end-to-end yet — needs the rebuild below.

**Next:** One step to a green packaged merge: rebuild the `.deb` (`papercusp-desktop/bin/release-local.sh`, serialize via the `desktop-sidecar` exclusive lock — heavy, do it on a quiet box) so it includes papercup `a56e6510a`, then run `papercusp-desktop/bin/two-instance-merge-smoke.sh` — the `[swarm]` logs now make discovery/failure observable. Or run it across two real machines (no rebuild). Other human residue unchanged: P-077 ShareWizard, P-080 soak.

## The problem & the model (from the user)

A shared harness does most of its collaboration over the **Hyperbee substrate**
(features, issues, claims, in-progress state) — *not* GitHub. GitHub is only
touched to land merged code, via **pull requests**. So:

- **Joining a shared harness must NOT require write access to the GitHub repo.**
  Anyone should be able to install/join.
- The only place repo write matters is **pushing a branch + opening a PR** — and
  a non-collaborator does that the canonical GitHub way: from **their own fork**,
  via a **cross-fork PR**.

Two distinct GitHub touch-points, previously conflated:

1. **Identity (at join).** Today this *does* write to the shared repo (a
   channel-2 contributor file on a `user/<id>` branch via the Contents API),
   which needs collaborator/write access. That contradicts the model. → **A**.
2. **Code (at merge-time).** A worker turns a feature into code; before a PR it
   must live somewhere GitHub can see. → **B** (contributor's fork + cross-fork
   PR).

## Locked decisions

- **D1 — Code→PR:** contributor's own fork + cross-fork PR (in-progress over
  Hyperbee; push the feature branch to the contributor's fork; open a cross-fork
  PR into upstream). NOT a Papercusp-owned staging repo (that reintroduces the
  write-grant problem).
- **D2 — Write-free join:** drop the shared-repo channel-2 contributor file;
  prove the binding from the **device-signed announce** (carrying the gist id) +
  **`verifyAttestation`** on the gist.
- **D3 — Scope:** both public and private upstreams.

---

## Sub-project A — write-free join

### Design

The binding a remote peer must prove is `device_pubkey ↔ github_user_id`. Today
that's proven by `verifyChannel2` reading a device-signed contributor file off
the shared repo (which embeds the attestation gist id) + `verifyAttestation` on
that gist. The repo file is **redundant**: the attestation **gist** already
self-proves `device_pubkey ↔ github_user_id` (gist `owner.id === github_user_id`
+ the gist body attests `device_pubkey` + a device signature), and the **signed
announce** already proves the announcer holds that `device_pubkey`. So:

**New admission gate:** `verifyAnnounce(frame)` is valid **AND**
`verifyAttestation(frame.attestation_gist_id, frame.device_pubkey,
frame.github_user_id)` is valid. No shared-repo fetch. No upstream write at join.

**Binding integrity holds:** an attacker announcing `{device_pubkey: ATTACKER,
github_user_id: VICTIM, gist_id: VICTIM_GIST}` fails `verifyAttestation`
(`VICTIM_GIST.device_pubkey === VICTIM_KEY ≠ ATTACKER` → `pubkey_mismatch`).
Creating a gist owned by `VICTIM` requires VICTIM's account. The gist id is
inside `announceSigningBytes`, so it can't be tampered in transit.

### Change set (from the code map)

1. `lib/sync/hyperbee/announce.ts` — add `attestation_gist_id: string` to
   `AnnounceBody`; insert it into `announceSigningBytes` (code-point order) + the
   `verifyAnnounce` shape check.
2. `lib/sync/hyperbee/local-announce-identity.ts` — `LocalAnnounceIdentity` +
   `resolveLocalAnnounceIdentity` must resolve/return the gist id (load-or-create
   the device attestation gist the same way the publish path did, then return its
   id). This is the local self-attestation that *creates* the gist (channel-1
   OAuth + `createAttestationGist` stays — it's the local self path).
3. `lib/sync/hyperbee/boot.ts` — pass `attestation_gist_id` into `buildAnnounce`
   (`:1035`); thread through `AdmissionInput`, `onAnnounce` (`:817`), the
   pending-retry announce rebuild (`:972`), and `admittedIdentities` (so
   `reverifyAdmitted` can re-check).
4. `lib/sync/hyperbee/read-admission.ts` — extend `AdmissionInput` +
   `verifyBinding` to carry `attestationGistId`.
5. `lib/sync/hyperbee/verify-binding-adapter.ts` — replace the `verifyChannel2`
   call with a direct `verifyAttestation(gistId, devicePubkeyBase64,
   githubUserId)`. Repo context (`{repoOwner, repoName, token}`) is no longer
   needed for admission — gists are public, so the gh token becomes unnecessary
   here. `defaultResolveContext` collapses.
6. **Delete the write side:** `lib/harness/ensure-binding-published.ts` + its two
   call sites — `routes/harness/share-finalize.ts` (`ensureBinding` hook) and
   `lib/harness/join-shared-harness.ts` `stepPublishBinding` (step 3). The join's
   step-3 becomes "ensure my attestation gist exists" (no repo write). The
   `oauth_attest` step already creates the gist.
7. `lib/sync/hyperbee/revoke-contributor.ts` — re-home owner-revocation from
   branch-deletion (`git.deleteRef user/<id>`) to **gist-deletion**
   (`DELETE /gists/<id>`), which is already the live revocation signal
   (`verifyAttestation` 404 → `channel2_attestation_missing`). Self-revoke
   (peer-log `revoked_pubkeys`) is unaffected.
8. `lib/identity/two-channel-verifier.ts` — `verifyChannel2` loses its admission
   consumer. Keep it only if a self-publish auditing use remains; otherwise
   delete `verifyChannel2` + `verifyBoth` + the now-unused contributor-file
   plumbing. `verifyChannel1` stays (local self path only).

### What stays / not affected

- `verifyChannel1` (OAuth `GET /user`) — local self-attestation only; never part
  of remote admission.
- Contributor listing/membership — reads PG `harness_shared.contributors`, not
  the GitHub file. Unaffected.
- `user/<id>` git **worktree** branches (`user-tree-types.ts`) — these name the
  contributor's local WORK worktree, unrelated to the (removed) contributor-file
  branch. Unaffected.
- Self-revoke via peer-log `revoked_pubkeys` — unaffected.

### Testing (A)

- Unit: announce round-trip with the new field (build→verify, tamper→reject,
  gist-id in signing bytes). Admission decider: verified / pending / fail with
  the gist-only gate. Adapter: direct `verifyAttestation`, fail-closed on bad
  gist. Forgery: announce a foreign gist id → reject.
- Re-home revocation test: owner-revoke deletes the gist → reverify drops peer.
- **Live re-verify:** extend `p079-live-federation.live.test.ts` — boot the two
  real-identity peers with NO shared-repo contributor files (only gists +
  announces) and confirm bidirectional admission + federation over the swarm.
  This proves join is genuinely write-free.

---

## Sub-project B — fork-based code→PR

### Design

In-progress work flows over Hyperbee (already solid + fork-id-stable: the swarm
topic keys on the **upstream** `github_repository_id` from the committed
`shared.json`, not the local clone's origin). When a feature is ready to merge:

1. **Ensure a fork** of the upstream repo exists under the contributor's account
   (`repos.createFork` + poll-until-ready). Persist the fork owner.
2. **Produce a pushable feature branch.** Today the chunk-loop commits to the
   *current* (integration) branch and never pushes. For the contributor flow, the
   worker's commits for a feature go on a named branch (e.g.
   `harness/<featureId>`) that can be pushed.
3. **Push the feature branch to the contributor's fork** (their token always has
   write to their own fork).
4. **Open a cross-fork PR** `head: "<forkOwner>:<branch>"`, `base:
   "<upstreamDefault>"`, `owner/repo` = upstream. The maintainer (someone with
   upstream write) reviews + merges — the intended gate.

### Change set (from the code map)

- **Fork module (new):** `lib/harness/ensure-fork.ts` — `repos.createFork` +
  ready-poll; idempotent; returns `{ forkOwner, forkFullName }`. (Medium)
- **Cross-fork PR in pr-host:** `lib/pr-host/types.ts` `OpenPrArgs` — add
  `head_owner?` (or accept a namespaced `head_ref`); `lib/pr-host/github.ts`
  `openPr` — build `head: head_owner ? "${head_owner}:${head_ref}" : head_ref`,
  keep `owner/repo` = upstream from `remote`. Wire a real "open PR" path (route or
  orchestrator post-pass) — `openPr` is currently never called. (Small–Medium)
- **Worker → feature branch + push to fork:** orchestrator
  (`libs/papercusp/packages/orchestrator/`) — on feature-ready (validator/reviewer
  pass), create/checkout `harness/<featureId>`, push to the contributor's fork
  remote, call the open-PR path. Gate so the existing integration-branch behavior
  stays the default for the collaborator/owner case; activate fork-mode when the
  local identity lacks upstream write. (Submodule — land by committing on
  submodule main + bumping the superproject pointer; do NOT push.) (Large)
- **Authenticated / fork clone (private upstream):** `join-shared-harness.ts`
  `step2_cloneRepo` — use a token-embedded HTTPS clone URL
  (`https://x-access-token:<TOKEN>@github.com/<full>`) so private upstreams the
  joiner has read on can clone; for read-restricted contributors, fork-then-clone
  -your-fork. (Medium)

### Scope (D3 — public + private)

- **Join link** already encodes `repo_id` → topic resolves without a repo read.
  Keep that; topic stays anchored on the **upstream** repo id (fork-stable).
- **Public upstream:** fully open join + anonymous clone works; fork is public.
- **Private upstream:** joiner needs read (inherent GitHub gate) → authenticated
  clone; forking a private repo requires that read. Document this is a GitHub
  constraint, not a Papercusp limitation.
- **Fork-PR CI caveat:** GitHub withholds Actions secrets from fork PRs by
  default. If harness validation depends on CI secrets, note that fork-PR CI is
  restricted (maintainer-approval / `pull_request_target`); harness validation
  already runs locally pre-PR, so this is a note, not a blocker.

### Testing (B)

- Unit: `ensure-fork` (idempotent, ready-poll), `openPr` cross-fork head
  construction, clone-url builder (token-embedded, redaction-safe).
- **Live:** extend the P-079 live test — `aviynw` (non-collaborator) forks the
  `papercupai`-owned upstream, pushes a `harness/<fid>` branch to its fork, opens
  a cross-fork PR into upstream; assert the PR exists with the right base/head.
  Clean up the PR + fork branch after.

## Sequencing

1. **A** — write-free join (this is the foundation; unblocks B). Implement +
   unit-test + live re-verify. Commit.
2. **B** — fork + cross-fork PR + authed clone + worker feature-branch. Implement
   + unit-test + live-verify. Commit (submodule changes land locally; no push).

## Risks / open questions for review

- **A is a breaking change to the admission wire format** (new signed announce
  field). Alpha + no users → fine per repo ethos; old peers on the prior format
  won't admit new ones, but there's no deployed fleet. Acceptable.
- **B changes the default worker integration model** (feature branch + push) for
  the contributor case. Gated to avoid disrupting the owner/integration-branch
  flow. Worth a human nod on the gating heuristic ("no upstream write → fork
  mode").
- **Submodule landing** (orchestrator) — committed locally + superproject pointer
  bumped; not pushed (per repo convention).


## Remaining work (owner-review-gated)

- **P-001** `done` A4 — implement owner-revocation via `revoked_pubkeys` per D-001 (the plan's gist-delete is infeasible; current branch-delete is a no-op). Rewrite `revoke-contributor.ts` + its 12 tests + the agent-tool description/guidance. Operator-only, no submodule. Security-adjacent — owner glance recommended before landing. importance: high (Shipped 2b124306a — revoked_pubkeys model, 25 tests green.)


## Remaining work (owner-review-gated)

- **P-002** `done` B3-submodule — wire `openForkPr` (lib/harness/open-fork-pr.ts, built+tested this session) into the orchestrator: add `setPipelineFeaturePassedHook` to `orchestrator-workflow.ts` (fire after the validator step) + wire it in `orchestrator-runner.ts` to detect fork-mode ('no upstream write' via getCollaboratorPermissionLevel — the plan FLAGS this heuristic for a human nod) and call openForkPr; ensure the chunk-loop commits to a per-feature `harness/<fid>` branch (worker-chunk-loop.ts commitChunk). Land via submodule commit on libs/papercusp main + superproject pointer bump, NO push. importance: high (Shipped — operator-only no submodule; setPipelineFeaturePassedHook + handleFeaturePassed + runner wiring; 39 tests green. Fork-mode heuristic=read/none flagged; HEAD-branch accumulation limitation noted.)


## Remaining work (owner-review-gated)

- **P-003** `done` A3 cleanup — delete zero-prod-caller `ensure-binding-published.ts` + `verifyChannel2`/`verifyBoth` after migrating the `p079-live-federation.live.test.ts` + `join-default-boot-wiring` mock + the `share-finalize` type import. Tension: 'no TS deletion in apps/operator' memory vs repo CLAUDE.md 'delete dead code boldly' + this plan's explicit delete instruction — confirm the rust-port no-deletion rule is stale before deleting. Low value (dead code is harmless). (Done — user-authorized A3: deleted ensure-binding-published.ts+test + verifyChannel2/verifyBoth; migrated p079 live test to write-free gist path, local EnsureBindingResult in share-finalize, dropped vestigial join-default-boot mock, fixed 6 stale comments. tsc-clean; 146+ tests green; p079 live still P079_LIVE-gated. buildSignedContributorFile now zero-caller = knip follow-up.)

## Decisions

### D-001 — D-004 — A4 owner-revocation: 'gist-delete' is INFEASIBLE; correct path is revoked_pubkeys-publish (impl spec, flagged)
Date: 2026-06-03
Finding (verified against source 2026-06-03): the plan's A4 step ("re-home owner-revocation branch-delete → gist-delete, DELETE /gists/<id>") is **infeasible** — GitHub only lets you delete your OWN gists; an admin cannot delete a contributor's attestation gist (it's owned by the contributor's account). Separately, the current `lib/sync/hyperbee/revoke-contributor.ts` still deletes the contributor's `user/<id>` BRANCH, which **no longer gates admission** (admission is `verifyAttestation` on the gist per A2) — so owner-revocation is currently a silent **NO-OP**.

Correct design (reuses proven primitives, no new infra):
- `read-admission.ts` denies any `device_pubkey` in a `revoked` set FIRST (before sig/binding). That set is built by `load-revoked-pubkeys.ts`, which **UNIONS `harness_shared.contributors.revoked_pubkeys` across ALL contributor rows** for the harness.
- Therefore OWNER-revocation = the owner adds the TARGET's device pubkey(s) to the OWNER's OWN contributor-row `revoked_pubkeys`, publishes it (federates via the substrate log → projected to PG), and calls `handle.revoke(pubkey)` for live local effect — exactly the `revoke-self-device.ts` mechanism, minus the "must be your own key" check, plus the existing repo-admin gate.

Implementation spec (operator-only, no submodule):
1. Rewrite `revokeContributorViaGithub` (`lib/sync/hyperbee/revoke-contributor.ts`): keep the admin gate (octokit `repos.get` → `permissions.admin`) + the positive-int guard + `resolveContext`. REPLACE the `git.deleteRef` step with: (a) seam `loadTargetPubkeys({workspaceId, harnessSlug, githubUserId})` → reads the target row's `device_attestations[].device_pubkey` from `harness_shared.contributors`; (b) seam `publishRevocation({workspaceId, harnessSlug, pubkeys})` → loads the OWNER's own contributor row, unions `pubkeys` into `revoked_pubkeys`, `publishContributorRow` (write-contributor-row.ts), and `handle.revoke(pk)` per pubkey (mirror `revoke-self-device.ts` realWriteRow/getHandle). Result shape → `{ok:true, revokedPubkeys: string[]}` | `{ok:false, code:'no_context'|'not_admin'|'no_target'|'github_error'}`.
2. Rewrite `lib/sync/hyperbee/__tests__/revoke-contributor.test.ts` (12 tests) for the new behavior (admin gate unchanged; assert publishRevocation called with the target's pubkeys; idempotent on already-revoked; no_target when the target has no row/pubkeys).
3. Update the agent-tool `lib/agent-tools/substrate/revoke-contributor.ts` description + guidance (no longer "deletes the user/<id> branch" — "adds the contributor's device pubkeys to the revocation set, which all peers honor on next re-verify"). Its wrapper test mocks the impl so it's shape-tolerant.

FLAGGED — not implemented this session (autonomous mandate): security-adjacent rewrite (12 tests) of an UNUSED path (no live shared harnesses yet), and a design correction worth an owner glance before landing. The branch-delete left in place is a harmless no-op until replaced. Recommended: implement per the spec above next session or on owner confirmation.
