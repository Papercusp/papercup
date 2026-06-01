---
title: Substrate revocation v2 — GitHub-anchored owner revocation (re-verify admitted peers)
slug: papercusp-substrate-revocation-v2-owner-2026-06-01
status: draft
created: 2026-06-01
owner: avi@storewolf.com
relates_to: papercusp-substrate-revocation-v1-2026-06-01, papercusp-phase1b-bidirectional-federation-2026-06-01, papercusp-trust-model-2026-05-31
---

# Substrate revocation v2 — GitHub-anchored owner revocation

## Now

**State:** DESIGN SPEC. The trust-model authority decision (Approach A — GitHub-anchored)
was MADE by the agent under the user's standing "use your judgement / continue with what
you recommend" delegation, transparently, with the rejected alternatives recorded below
(D-001). If the owner disagrees with A, re-plan before building. No code yet.

**Problem (the gap, code-verified 2026-06-01):** Model B admission verifies a peer's
channel-2 binding ONCE (at admission) + re-checks only PENDING peers (the pending-retry).
**An already-ADMITTED peer is NEVER re-verified.** So if a contributor's GitHub channel-2
artifact is later removed (a repo admin deletes their `user/<id>` branch / contributor
file — the natural "kick out a bad actor" action) or otherwise becomes invalid, the
substrate does NOT notice and keeps replicating them. Revocation-v1 enforces the
*self-published* `revoked_pubkeys`; it does NOT handle owner-revocation of a different
contributor. v2 closes the gap.

**Next:** writing-plans → subagent-driven build.

## Decisions

- **D-001 — Authority = GitHub (Approach A), NOT a papercusp-native owner authority.**
  Revocation defers to GitHub repo administration, consistent with the established posture
  (`papercusp-trust-model-2026-05-31`; the no-collaborator-gate decision; Phase-1b §8 /
  D-009: "GitHub is the real authority; gated at the GitHub step"). A repo admin revokes a
  bad actor by **deleting that contributor's `user/<id>` branch** (or contributor file) on
  GitHub; the substrate enforces it by **re-verifying admitted peers' channel-2 periodically**
  and dropping any whose artifact is gone/invalid.
  - **Rejected — B (owner-signed revocation list):** reintroduces the papercusp-side
    authority gate the no-collaborator-gate decision deliberately avoided, adds a new trust
    primitive (peers trusting an owner's revocations; "who is the owner / can they be
    malicious"), and the P-068 owner is only *provisional*/contestable. More trust-surface,
    no posture-fit.
  - **Rejected — C (defer):** the "admitted peers never re-checked" gap is a real hole
    worth closing regardless of the trigger.
- **D-002 — Re-verification is the unified enforcement mechanism.** It is NOT a collaborator
  gate; it re-applies the SAME `verifyChannel2` admission already requires, just periodically.
  It uniformly handles owner-revocation, "contributor lost repo access," and key rotation.
- **D-003 — Cadence is infrequent + rate-limit-aware.** Channel-2 hits the GitHub API, so
  re-verify each admitted peer on a slow cadence (default ~15 min, configurable), not every
  merge. Stagger / bound the calls so a many-peer harness doesn't burst the GitHub rate limit.
- **D-004 — Fail-open on re-verify load failure (consistent with rev-v1 D-006).** A GitHub
  API failure during re-verification does NOT drop the peer (advisory substrate; GitHub is
  the authority; a transient API blip must not evict everyone). Only a CONCLUSIVE result —
  channel-2 `fail` (artifact gone / signature invalid / commit-author mismatch / not
  verified) — drops the peer. `pending`/`github_api_down` → keep + retry next cycle. Record
  the failure (visible, not silent).
- **D-005 — In-app owner trigger is OPTIONAL (v2.1, can ship after the enforcement core).**
  The enforcement core (re-verify driver) is the load-bearing part; a repo admin can already
  trigger revocation by deleting the branch on GitHub directly. An in-app endpoint/MCP tool
  that deletes a contributor's `user/<id>` branch via the GitHub API (operator token needs
  repo admin) is a convenience layered on top.

## Design

### Component A — admitted-peer channel-2 re-verification driver (the core)
A driver in/alongside `boot.ts` (sibling to the merge driver + the rev-v1 revoked-refresh):
- On a slow timer (`reverifyIntervalMs`, default ~15 min; injectable; `.unref()`'d; cleared
  on `close()`), iterate the currently-`admitted` peers (excluding the own log). For each,
  re-run `verifyChannel2` against its `{github_login, github_user_id, device_pubkey}` (the
  same inputs the admission adapter used — reconstruct from the stored announce / the admitted
  log's identity).
- Result handling: `ok` → keep. `fail` (conclusive: file/branch missing, signature invalid,
  commit-author mismatch, not GitHub-verified) → **drop** the peer (reuse the existing
  `revoke()`/refresh drop steps: remove from `admitted` + `pubkeyToLogKey`, record
  `peer_revoked` with reason `channel2_revoked`, re-merge). `pending`/`github_api_down`
  (transient) → keep + re-check next cycle (D-004 fail-open).
- Rate-limit awareness (D-003): stagger the per-peer calls (don't fire all at once) and/or
  cap concurrency; reuse the local gh token for the API reads.
- Inject a `reverifyChannel2Override` test seam (like the rev-v1 `loadRevokedOverride`) so
  the driver is unit-testable without GitHub.

### Component B — owner trigger (v2.1, optional)
- Core `revokeContributorViaGithub({ workspaceId, harnessSlug, githubUserId })`: resolves the
  shared repo (shared.json) + the operator's gh token; if the token has admin on the repo,
  **deletes the contributor's `user/<id>` branch** via the GitHub API (`git.deleteRef
  heads/user/<id>`). Returns a structured result (deleted / not_admin / not_found).
- Endpoint `POST /api/admin/substrate/revoke-contributor` (`auth:{trust:['verified','trusted']}`,
  deps-injected like the rev-v1 self-revoke route) + an MCP tool `substrate:revoke_contributor`
  with guidance ("Owner action: revoke ANOTHER contributor by deleting their GitHub binding
  branch — requires repo-admin token. Distinct from self-revocation.").
- After the branch delete, the periodic re-verify (Component A) propagates the drop to all
  peers within one cycle; the local node can also drop immediately via the live handle.

### Error handling
- Re-verify GitHub API failure → fail-open (keep peer, retry), record event (D-004).
- Owner trigger without admin token → `not_admin` (403); branch already gone → `not_found`
  (treat as success / idempotent).

### Testing
- **Unit:** the re-verify driver (inject `reverifyChannel2Override`): an admitted peer whose
  override flips to `fail` is dropped (+ `peer_revoked`/`channel2_revoked`); a `pending`/
  api-down result keeps the peer (fail-open); `ok` keeps the peer; the timer is bounded +
  cleared on close (no leak). Component B core (deps-injected): deletes the right branch,
  `not_admin`/`not_found` mapping. Endpoint + MCP tool (deps-injected + tools-md-sync).
- **Integration (extend the testnet two-peer test):** admit a peer, flip its injected
  channel-2 to `fail`, drive a re-verify cycle, assert it's dropped + its ops stop merging.
- No new browser test.

## Verification (definition of done)
1. An admitted peer whose channel-2 artifact is deleted/invalidated is dropped within one
   re-verify cycle (proven by the integration test).
2. A transient GitHub API failure does NOT drop admitted peers (fail-open).
3. (v2.1) The owner endpoint deletes a contributor's `user/<id>` branch (admin token), and
   the re-verify propagates the drop.
4. Full hyperbee + admin-route + tools-md-sync suites green.

## References
- The gap: `boot.ts` (admitted peers not re-verified; only pending-retry re-checks).
- Reuse: `verify-binding-adapter.ts` / `two-channel-verifier.ts` `verifyChannel2`; the
  `revoke()` drop path + the rev-v1 refresh pattern in `boot.ts`; the rev-v1 self-revoke
  route/tool as the deps-injection + auth-gate template.
- Trust model: `papercusp-trust-model-2026-05-31`; Phase-1b §8 / D-009 (advisory substrate,
  GitHub is authority, non-retroactive removal).
- v1 (self-revocation, the complement): `papercusp-substrate-revocation-v1-2026-06-01`.
