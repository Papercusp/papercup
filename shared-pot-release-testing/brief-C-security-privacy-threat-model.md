# Brief C — Security & privacy threat model (adversarial)

**Priority: S0 lane — the most important for a PUBLIC release.** A public P2P
network means untrusted peers can reach you. Assume the attacker controls a peer.

## Objective
Threat-model and adversarially test the federation attack surface. Try to **break**
admission, revocation, privacy, and identity. Every hole here is a release blocker.

## Why it matters for release
Federation-layer adversarial coverage today is ~one file
(`federation-adversarial.integration.test.ts`). Authority/revocation have decent
coverage (`hardened-authority`, `revocation-enforcement`, `peer-eviction`,
`authority-failover-flood`), but the *content/privacy* attack surface is thin.

## Threats to test (write an adversarial test that FAILS if the threat succeeds)
1. **Privacy leak — private pot.** A peer that never joined / wasn't admitted must
   NOT be able to read a private or invite-only pot's content, EVEN if it knows
   the repo id / guesses the topic. Confirm invite pots never list on the global
   directory topic (there's a seed test in `pot-directory-live-two-peer` — extend
   it adversarially). Try deriving `gh:<repo_id>` and joining — must get nothing.
2. **Unauthorized write.** A non-member / non-admitted peer announces + appends ops
   to the pot topic. The admission gate (channel-2 GitHub-binding,
   `verifyBindingOverride` in tests is the REAL gate in prod) must reject; its ops
   must NOT apply on honest peers. Test the gate is actually enforced end-to-end,
   not just in the unit.
3. **Revoked member still writes.** After revocation, the revoked peer keeps
   appending. Honest peers must drop its post-revocation ops (see
   `revocation-propagation` G6/G7/G9) — extend to the LIVE/transport path and to
   ALL content types, not just the raw sink.
4. **Identity spoofing.** Forge an announcement signed with the wrong key / claim
   another peer's `owner_id` / `author_pubkey`. Signature check (each peer signs
   with a real Ed25519 key) must reject. Test `trusted_authors` /
   `verified_author_github_user_id` enforcement: an op whose author isn't trusted
   must not be auto-pickable / must not be admitted.
5. **Replay.** Capture a valid op and replay it (same/old watermark). The
   replay-revert guard (`ei117-replay-revert-guard`) must hold across reboot.
6. **Poisoning / malformed ops.** Feed malformed/oversized/wrong-schema envelopes,
   wrong `table_tag`, NaN watermarks, huge payloads. Honest peer must reject
   gracefully (no crash, no corruption, no unbounded memory).
7. **Workspace isolation.** Cross-workspace data must not leak through federation
   (the F-C3 isolation + the `reg.current` strand class — see the EI-1534 +
   pending-wakes fixes). A pot in workspace X must not surface in workspace Y.
8. **Invite-secret enforcement.** Joining an invite pot without the secret must
   fail; with a wrong secret must fail; the secret must not be derivable from the
   public directory.

## Method
- Integration + unit. Build adversarial peers on the real rigs by INJECTING bad
  behavior (skip the signature, forge the author, replay the envelope). The rigs
  let you control each peer's append/announce.
- Where prod enforces something the rigs bypass (e.g. `verifyBindingOverride`),
  write a test that runs WITHOUT the override to prove the real gate fires.

## Deliverables
- `findings-C.md`: a threat matrix (threat × {tested? , enforced? , severity}),
  every new adversarial test, and any hole found (each S0).
- A short **threat-model doc** for the release notes: what the system defends
  against and what it explicitly does NOT (so the release is honest about its
  trust assumptions).

## Done / verdict
GREEN only when every threat above has a teeth-verified test proving the defense
fires, and no S0/S1 hole is open. If any privacy leak or unauthorized-write path
exists, verdict is RED regardless of everything else.
