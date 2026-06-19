# Brief E — Membership lifecycle & visibility findings

Owner: su-963ee. Lane: membership & visibility transitions (S1).
Status: integration + code-evidence complete; **live witness OBTAINED** — the
`public→private` leg (E-001) is now **PROVEN live** on Lane A's 2-instance pair (owner
went private, then wrote new content → the joined peer still received it in ~6s). The
member-remove leg's live revoke is gated by verified-trust auth (a loopback curl is
correctly refused 403); that leg is covered by **C-001** (Lane C) + **A-003** (Lane A).
See §Live pass — results.

---

## TL;DR verdict — **YELLOW, trending RED**

The dimension's GREEN criterion is *"every transition has the correct + tested
consequence, and specifically a `public→private` flip and a member-remove are PROVEN
(live) to cut off the affected peer with zero further exposure."*

**That criterion is structurally UNMET.** Every *directory-side* and *write-plane*
consequence is correct and tested. But **no lifecycle or visibility transition cuts off
an existing peer's READ access**, because:

- a hive's content-replication topic is `sha256("papercusp-substrate-v1:hive:<pubkey>")`
  — a pure function of the **immutable** hive pubkey, never re-keyed on any transition;
- `public→private` only withdraws the **directory listing** (a *different* topic
  family, `papercusp-hive-v1:*`); the content swarm is untouched;
- member-remove is **write-plane only** (Brief C / C-001): the removed device's writes
  stop applying, but replication continues to serve it.

So a member/non-member who already holds the hive pubkey keeps reading new content after
*both* a private-flip and a remove. This is the same architectural root as **C-001** and
gates the same product decision (re-key on transition). It is **S1**, and **S0** if the
product/UI promises "go private" or "remove member" fully cuts someone off.

Directory withdrawal, write-plane revocation, presence-tombstone federation, and the
invite-no-leak topic split are all **real and correct** — this is not "nothing works,"
it's "the cut-off guarantee a release reader expects from these two transitions does not
exist."

---

## Transition table

Effect columns: **Fed** = content (log-replication) federation effect · **Dir** = directory/discovery effect · **Access** = the affected peer's read/write access afterward. Verdict: 🟢 correct+tested · 🟡 caveat/gap · 🔴 blocker-class.

| # | Transition | Fed (content topic) | Dir (discovery) | Access (affected peer) | Tested by | Verdict |
|---|---|---|---|---|---|---|
| J1 | **Join via member link** | joiner admitted, lands on content topic, backfills | — | gains read+write | `harness/join-shared-harness.ts`; `join-leave-roundtrip.test.ts`; `agent-tools/harness/__tests__/membership.test.ts` | 🟡 works; **joiner-resolves-own-topic integration path uncovered** (README blind spot — rigs wire topics directly) |
| J2 | **Join via invite link + secret** | same as J1 | joins invite-scoped topic only | gains | `discovery/join-invite.test.ts`; `hive-directory-live-two-peer.test.ts` | 🟡 happy path 🟢; **wrong/absent-secret rejection** partial (Brief C #8) |
| J3 | **Re-join after leaving** | re-admitted, re-backfills | — | regains | `harness/join-leave-roundtrip.test.ts` | 🟡 (backfill correctness ties to Brief F) |
| J4 | **Join a hive you used to own** | re-joins on the (immutable) same topic | — | regains | `agent-tools/harness/__tests__/membership.test.ts` (light) | 🟡 lightly covered |
| L1 | **Leave (joiner-side)** | leaver closes its swarm (stops receiving while gone); a **presence tombstone** federates → peers drop its presence row | — | leaver off-topic locally; **but `hive_members` admission row PERSISTS on peers (G27)**; leaver retains the link → can re-read | `leave-hive-tombstone-federation.integration.test.ts` (presence ✓); `lifecycle-membership-teardown.gap.integration.test.ts` (G27: membership NOT cleaned) | 🟡 presence ✓; **membership not torn down; no crypto read-cutoff** |
| R1 | **Member remove (by owner)** | write-plane cutoff: `handle.revoke` adds pubkey to `revoked` + drops its `log_core_key`; **replication still served** | — | **writes refused; reads PERSIST** | `revocation-enforcement/-propagation/-prior-row-semantics.test.ts`, `boot-revoke-production-path.test.ts` (write ✓); `hive-membership-teardown-federation.integration.test.ts` (transport ✓, but **not triggered by a lifecycle op** — G24/G27); **C-001 (read persists, Lane C)** | 🔴 **write-only revocation** (S1 / S0-potential) |
| V1 | **private → public** | unchanged | announce pubkey + member_repos; discoverable; Cupboard rows | becomes discoverable | `hive-set-listing.test.ts` (publish branch); `hive-directory-*.test.ts` | 🟢 |
| V2 | **public → private** | **UNCHANGED — content topic untouched (E-001)** | withdraw listing: unlist tombstone (`withdrawHiveFromDirectory`) + Cupboard unlist | **NEW discovery stopped; existing topic-peers/pubkey-holders keep reading** | `hive-set-listing.test.ts` (withdraw branch ✓); **`visibility-content-topic-separation.test.ts` (E-001, NEW ✓)**; **LIVE-PROVEN on Lane A's pair (§Live pass)** | 🔴 directory withdrawal ✓; **no content-read cutoff** (the privacy gap) — **witnessed live** |
| V3 | **public ↔ invite** | unchanged | invite announces on the **invite topic, never global** (no-leak) | only secret-holders discover | **`visibility-content-topic-separation.test.ts` (E-002, NEW)**; `hive-directory-live-two-peer.test.ts`; `discovery/set_hive.test.ts` | 🟢 topic no-leak; 🟡 wrong-secret rejection (Brief C #8) |
| V4 | **re-publish after private** | **same topic re-exposed (no re-key; identity immutable)** | re-announced | anyone with the *old* pubkey can rejoin | publish branch (V1 path) | 🟡 re-exposes the SAME swarm (by design — not a re-key) |
| D1 | **Dissolve (owner)** | **LOCAL-ONLY**: clears Queen wake, cancels bees, deregisters home harness, tears down learning loop; **NO membership tombstone federated (G24)**; peers' rows age out by TTL (orphaned) | withdraw must be done separately | local schema kept by default (`dropSchema:false`) | `agent-tools/hive/dissolve.test.ts`; `lifecycle-membership-teardown.gap.integration.test.ts` (G24 static) | 🟡 no federated teardown; **orphaned rows; peers retain topic (no re-key)** |
| O1 | **Re-join after long offline** | re-admit + backfill catch-up | — | regains | (ties to Brief F backfill) | ⚪ deferred to Brief F |

---

## Findings

### E-001 — `public→private` withdraws DIRECTORY discovery, NOT CONTENT federation (S1, S0-potential)

**Severity:** S1 (a hive that "went private" keeps federating its content to anyone
already on the topic). **S0** if the UI/release notes imply going private stops exposure.

**Claim:** Flipping a hive `public→private` (`discovery:set_hive` / `POST
/api/discovery/set-hive` → `setHiveListing`) removes the hive from the directory so it is
no longer *discoverable*, but does **not** stop the content swarm. A member — or a
non-member who grabbed the pubkey from the directory while it was public — stays joined to
the content topic and keeps reading every new feature/conversation/plan/message.

**Why the green suite missed it:** `hive-set-listing.test.ts` asserts the private branch
*withdraws the listing + unlists Cupboard rows* — and stops there. No test asked whether a
peer already on the content topic is cut off, because the directory and content layers
were never crossed in one test.

**Evidence (code):**
1. **Visibility is a directory-layer attribute, stored off-substrate.**
   `hive-directory-meta.ts:32` `saveOwnedHiveMeta` writes `visibility` into the
   `harness_registry` blob (workspace PG, no migration) — *not* into any federated table.
2. **The private flip touches the directory only.** `hive-set-listing.ts:68-101`: the
   `private` branch calls `withdrawHiveFromDirectory` (`hive-publish.ts:140` — broadcasts a
   signed `hive-unlist` tombstone on the **directory gossip topic**) + `unlistHiveCupboardRows`.
   There is **no** swarm/revoke/re-key/evict/replication leg. (Asserted statically in
   `visibility-content-topic-separation.test.ts` — teeth-verified: injecting a `revoke` leg
   flips it RED.)
3. **Directory and content are different topic families.**
   - directory = `sha256("papercusp-hive-v1:directory")` / `…:invite:<secret>`
     (`derive-hive-topic.ts:33,50`).
   - content = `sha256("papercusp-substrate-v1:hive:<pubkey>")` (`derive-swarm-topic.ts:99`).
   Withdrawing on the first cannot affect a peer on the second.
4. **The content topic is never re-keyed.** It is a pure function of the **immutable** hive
   pubkey (`hive-identity-phase0.integration.test.ts:97` "IMMUTABLE — re-ensure never
   rotates the identity key"). A visibility transition carries no re-key.

**Repro (the new test — passes today = the gap):**
`packages/operator-core/lib/sync/hyperbee/visibility-content-topic-separation.test.ts`
(7 tests, teeth-verified) proves (a) the content topic ≠ the global + invite directory
topics, (b) the content topic carries no visibility input (identical across any flip), and
(c) `setHiveListing`'s private branch has no content-swarm cutoff leg. Live witness pending
(§Live pass): on two packaged instances, owner goes private, then writes a new
feature → the peer still reads it.

**Relationship to C-001:** same architectural root (immutable identity + unconditional
replication + content topic = `hash(pubkey)`, never re-keyed). C-001 is the **member-remove**
axis; E-001 is the **visibility** axis. The fix options are shared (C-001 (a)/(c):
re-key-on-transition or connection-level eviction; (d): document the limitation honestly).

**Recommendation:** a product/security decision is required before public release, identical
to C-001's. At minimum (d): the "Make private" UI + release notes must state it stops *new
discovery* and *writes from removed members*, not ongoing reads by anyone who already holds
the link. The real fix is re-key-on-transition (rotate the hive pubkey → new content topic →
re-distribute to remaining members).

### E-002 — Invite-no-leak holds at the topic layer (positive)

An `invite`-visibility hive announces on `deriveInviteTopic(secret)`, which is provably
distinct from the global directory topic and per-secret isolated
(`visibility-content-topic-separation.test.ts` E-002; `derive-hive-topic.ts:50-54`). A
non-secret-holder watching the global directory never sees an invite hive. 🟢 — with the
open caveat that *wrong/absent-secret rejection* on the join path is only partially tested
(Brief C threat #8, that lane's to close).

---

## Gaps left open (with rationale)

1. **Live read-cutoff witness** — V2 (`public→private`) is now **DONE / PROVEN live**
   (§Live pass — results). R1 (member-remove) live revoke is **deferred** — the route is
   verified-trust-gated (a loopback curl is correctly refused 403); the leg is already RED
   via C-001 (Lane C) + A-003 (Lane A). A true live remove witness needs a verified token
   against instance A.
2. **Joiner-resolves-own-topic integration path (J1)** — the README's named blind spot: the
   2-peer rigs (`_cross-peer-rig`, `_hive-substrate-rig`, `composition-rig`) wire both peers
   onto a matching `local:` binding directly and stub admission (`verifyBindingOverride`,
   `loadRevokedOverride`), so none exercises `defaultResolveSwarmBinding` resolving a
   *joiner's* topic from the file-based `.papercusp/shared.json`. **UPDATE: now covered at
   the LIVE level** — Lane A's findings-A (federation proof table) explicitly exercises "the
   real joiner-resolves-its-own-topic path (the topic-split bug's home) that the 2-peer
   integration rigs bypass" via `POST /api/discovery/join-hive` on the real packaged binary
   (topic-equality PASS). Combined with the verified topic-split unit tests
   (`derive-swarm-topic.test.ts`, `default-swarm-binding-p007.test.ts`), the blind spot is
   closed for release. An *in-process* integration test of the file-resolution path remains
   a nice-to-have faster regression guard (belt-and-suspenders), not an open coverage gap.
3. **Dissolve federated teardown (D1 / G24)** & **leave membership teardown (L1 / G27)** —
   both already *documented* as real gaps by
   `lifecycle-membership-teardown.gap.integration.test.ts` +
   `hive-membership-teardown-federation.integration.test.ts` (the transport exists; no
   lifecycle op calls it). Not re-tested here to avoid duplication; folded into the table.
   The fix (have `leaveHive`/`hive:dissolve` DELETE the `hive_members` row → the existing
   `del` capture federates a tombstone) is small and in `harness/leave-hive.ts` +
   `agent-tools/hive/dissolve.ts`; I did **not** apply it (it's a behavior change to two
   lifecycle ops with cross-peer effects — wants the owner's call + a coordinated landing,
   not a drive-by from a testing lane).
4. **Wrong/absent invite-secret rejection (J2/V3)** — Brief C threat #8's lane.
5. **Re-join backfill correctness (J3/O1)** — Brief F's lane.

## Bugs fixed this lane

None — no in-scope, clearly-low-risk *bug* was found. The findings are architectural
limitations requiring a product decision (E-001) or are already-documented feature gaps
(G24/G27), not defects to patch from a testing lane. Adding a cutoff leg = the C-001 product
fix, out of scope here.

## New tests added (teeth-verified)

- `packages/operator-core/lib/sync/hyperbee/visibility-content-topic-separation.test.ts`
  — 7 tests grounding E-001 (content topic ≠ directory topics; content topic visibility-
  independent; private flip has no cutoff leg) + E-002 (invite no-leak). Teeth-verified
  both ways: neutering `deriveHiveFederationTopic` to collide with the directory topic →
  RED; injecting a `revoke` leg into `hive-set-listing.ts` → RED; both restored GREEN.

## Live pass — results (GREEN gate)

Ran on Lane A's handed-off 2-instance pair (`hello-world-hive`; owner A = `papercupai`,
joiner B = `aviynw`; A-001-fixed bootable build). Held the `shared-hive-live-instances`
lock for the run, restored the hive to `public`, and released it. Method: write a feature
`origin='local'` on A → observe it arrive `origin='remote'` on B's embedded PG (Lane A's
proven federation-assert path). **Driven curl + psql only — no GUI, honoring the active
fleet halt; the instances run on a sandbox `DISPLAY=:155`, never `:0`.**

| step | action | result |
|---|---|---|
| 1 | baseline write A→B | **PASS** — B received it in ~6s (pair federating) |
| 2 | owner `POST /api/discovery/set-hive {visibility:'private'}` | HTTP 200 `{visibility:'private', withdrawn:true, tombstoneSent:true}` — directory listing withdrawn |
| 3 | **after private, owner writes a new feature** | **B STILL RECEIVED it in ~6s (same latency as baseline)** → **E-001 PROVEN LIVE**: going private withdraws directory discovery but does NOT cut off an existing peer's reads |
| 4 | owner `POST /api/admin/substrate/revoke-contributor` | **HTTP 403** `trust unverified-loopback not in allowlist` — the revoke is correctly gated to verified/trusted; a loopback curl cannot trigger it |

- **V2 / E-001 — witnessed live.** The single most release-relevant assertion of this
  lane (public→private ⇏ read cutoff) is now proven on the real packaged binaries, not
  just by code/topic evidence.
- **R1 / member-remove — live revoke not obtained.** The revoke route requires
  verified-trust auth, so it could not be driven from a loopback curl (a correct security
  guard, not a bug). The member-remove read-cutoff finding therefore rests on **C-001**
  (Lane C, integration: writes refused, reads persist) + **A-003** (Lane A, live: the
  `hive_members` revocation record itself does **not** federate to a joiner — so in a join
  topology the removed device may never even reach the peer's revoked set). A live revoke
  witness would need a verified token against instance A; deferred, but the leg is already
  RED via those two lanes. (Note: a naïve `revoke→write→peer-still-reads` curl would have
  *looked* like a witness even though the 403 meant no removal occurred — I did not count
  it.)

**A-003 compounding (important):** Lane A proved live that `hive_members`/`hive_settings`
do not federate to a joiner. Since `hive_members` carries `revoked_pubkeys`, even the
write-plane half of revocation may be unenforced on a joined peer — strengthening the case
that "remove member" needs the same re-key-on-transition fix as E-001/C-001.
