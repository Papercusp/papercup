# Shared-Hive P2P federation — threat model (public-release notes)

*Brief C deliverable. Audience: release notes + anyone deciding whether to put
private data in a shared hive. Written to be HONEST about the trust boundary — what
the federation layer defends against, and what it does not.*

The shared-hive feature federates harness/hive state peer-to-peer over Hyperswarm.
A public network means **untrusted peers can reach you**. This is the trust model.

---

## What the system DOES defend against (teeth-verified)

- **Unauthorized writes from non-members.** A peer is admitted (its log aggregated)
  only if its signed announce verifies AND it proves a real GitHub identity bound to
  its device key (channel-2 attestation gist). A peer that fails admission can connect
  but its ops never apply on honest peers.
  *Tests:* `verify-binding-adapter` (the real decider: forgery / id-mismatch /
  pubkey-mismatch / missing-gist → reject), `trust-admission-e2e` (untrusted →
  quarantine → auditor; trusted → auto-run; revoke → re-screen),
  `federation-adversarial` (admission gates the data plane).

- **Identity spoofing / forged signatures.** Every announce is Ed25519-signed over a
  canonical body; a frame whose signature doesn't verify against its advertised
  device_pubkey is rejected (`bad_sig`) — even with the binding gate wide open. An
  attacker cannot impersonate another device or claim an author it can't sign for.
  *Tests:* `announce.test.ts` (unit: bad key, garbage sig, tampered field/ts/nonce/
  gist), `federation-threat-model` (over-wire: a forged-sig peer never federates).

- **A revoked member's continued WRITES.** After revocation, the revoked device's
  re-announce is refused and its log is dropped from the admitted set, so its new ops
  no longer apply. The authority layer also refuses a revoked caller's lease RPC.
  *Tests:* `revocation-propagation` (G7/G8/G9/G10), `revocation-enforcement`,
  `revoked-swarm.integration` (no zombie federation + `caller_revoked`),
  `federation-adversarial` (mid-session revocation drops the peer).

- **Replay.** Announces carry a signed timestamp and are rejected outside a ±5-minute
  freshness window (replay-announce). A replayed/older *op* cannot revert newer local
  content — the replay-revert guard is persisted in Postgres (`fed_ts`/`origin`), so
  it holds across a process restart.
  *Tests:* `announce.test.ts` (stale/future ts), `ei117-replay-revert-guard` (6 cases).

- **Poisoning / malformed ops.** Malformed, wrong-schema, wrong-table, NaN/Infinity-
  watermark, and oversized (256 KiB) op envelopes are dropped or applied without
  throwing — an honest peer never crashes, corrupts, or wedges on hostile input.
  *Tests:* `federation-adversarial` (wrong tableTag; "garbage ops cannot wedge"),
  `federation-threat-model` (12-case dispatch battery).

- **Topic secrecy for never-members.** A private hive's swarm topic is
  `sha256("papercusp-substrate-v1:hive:" + hivePubkey)`. The pubkey travels only in a
  member/invite link, never on the public directory. Someone who knows the GitHub repo
  id derives a *different* (`gh:`) topic and learns nothing. Invite hives gate on an
  `inviteSecret`-derived directory topic, unguessable without the secret.
  *Tests:* `derive-swarm-topic.test.ts` (hive ≠ gh topic; distinct pubkeys → distinct
  topics; domain separation), `hive-directory-live-two-peer` (invite no-leak).

- **Cross-workspace isolation.** `local:` swarm topics embed the workspace id, so the
  same harness slug in two workspaces never shares a topic. Apply-side isolation is
  enforced per workspace (EI-1534, memory cross-workspace invariant).
  *Tests:* `derive-swarm-topic.test.ts` ("different workspace → different topic"),
  `crossworkspace-invariant`.

---

## What the system does NOT defend against (state these in the product)

- **⚠ Reading is not cut off by removing a member or making a hive private (C-001).**
  Revocation and visibility changes control **discovery and WRITES, not READS**.
  Replication is served unconditionally to any peer already connected to the topic;
  the hive identity (pubkey = topic) is immutable and never re-keys; cores are not
  per-member encrypted. Therefore a removed member — or anyone who obtained the pubkey
  while a hive was public — who keeps the link can reconnect and **continue reading
  all future content** until the hive is dissolved. The product UI ("Remove member",
  "Make private") MUST NOT imply more than this. *Demonstrated by `federation-threat-
  model` (read-after-revocation) and asserted as current behavior by
  `revoked-swarm.integration` step 2.* This is the one release-gating decision.

- **Anyone with a valid GitHub identity can READ a hive's content** if they obtain its
  link. Admission is "prove a real GitHub identity," NOT "be a repo collaborator" —
  the federation layer is deliberately open to any real GitHub user; GitHub's PR-merge
  gate is the real authority over what lands in the canonical repo. Treat hive content
  as readable by any link-holder with a GitHub account.

- **Caching.** A peer that already replicated content keeps its local copy forever.
  No revocation can claw back data a peer has already read.

- **Self-reported holder pubkey on lease RPC** is defense-in-depth, not anti-spoofing
  (the envelope is unauthenticated; EI-284 residual). Authority decisions gate on hive
  standing, but a determined caller can mis-report its own holder pubkey.

- **Op-size DoS (C-002, S3).** There is no payload-size cap; a huge op replicates and
  can slow sync under load (head-of-line). Not a correctness/privacy issue; consider a
  cap to blunt a slowness-DoS.

---

## Trust assumptions (the one-paragraph version for users)

> A shared hive federates over a public P2P network. Membership and signatures stop
> *unauthorized writes, forged identities, and replay*, and the topic is secret from
> anyone who never had the link. **But anyone who holds a hive's link can read its
> content (now and going forward), and removing a member or switching a hive to
> private stops their writes and hides it from discovery — it does NOT stop them from
> reading future content.** Only *dissolving* the hive fully cuts off reads. Do not
> put data in a shared hive that you could not tolerate every past and present
> link-holder reading.

---

## Release verdict (security/privacy dimension)

**RED** on the program's strict rubric (C-001 is a non-member read-of-private-data
path). Reduces to **YELLOW** the moment the owner makes + documents the conscious
trust-model decision above (and the UI wording matches it). **GREEN** only when the
read path is actually closed (re-key on boundary change, replication gated on
admission, or connection-level device eviction). Every other threat is defended with
teeth-verified coverage. The gate is the C-001 product/security call — the owner's to
make.
