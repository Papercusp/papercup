# Brief C — Security & Privacy findings

Owner: lead (Claude). Lane: security/privacy threat model.

---

## C-001 — Member revocation is WRITE-PLANE ONLY; a removed member keeps READ access (S1, S0-potential)

**Severity:** S1 (major privacy limitation). **S0 if** the product/UI promises that
"Remove member" fully cuts someone off — then it's a privacy incident, not a
limitation.

**Claim:** Revoking/removing a hive member stops their *writes* from being
accepted, but does NOT stop them from *reading* the hive's ongoing content. A
removed member who retains the hive link (the pubkey) can reconnect to the swarm
topic and continue reading every new feature/conversation/plan/message indefinitely.

**Why the green suite missed it:** every revocation test
(`revocation-propagation`, `revocation-enforcement`, `federation-adversarial`
"admission + revocation gate the data plane") asserts the revoked peer's *ops stop
applying* (writes). None asserts the revoked peer can no longer *read*. The defense
that exists is real — it's just only half the threat.

**Evidence (code, not speculation):**
1. **Revocation = write-control only.** `boot.ts:377-382`: on revoke it
   (a) adds the pubkey to `revoked` so a re-announce is refused, and (b) removes
   that pubkey's `log_core_key` from the aggregated set. It does NOT disconnect the
   peer or stop serving replication to it.
2. **Replication is unconditional for any topic peer.** `swarm.ts:329`
   `opts.store.replicate(socket)` plugs the corestore into EVERY connection on the
   topic, before/independent of the announce-based admission. `swarm.ts:143`
   comment: "best-effort — **replication still proceeds**". Admission (the announce
   exchange) gates which logs get *aggregated/applied*, not whether content is
   served for reading.
3. **The firewall can't enforce revocation.** `swarm.ts:478` `firewall:
   (remotePublicKey) => guard.firewall(remotePublicKey)` bans by **swarm/DHT
   connection key**. Revocation is by **device pubkey** (the hive identity, the
   announce key). Different key spaces — a revoked device reconnects under any
   swarm keypair, which the firewall has never seen. So device-level revocation is
   structurally unenforceable at the connection layer.
4. **The hive identity is immutable — no re-key on removal.**
   `hive-identity-phase0.integration.test.ts:97`: "idempotent and IMMUTABLE —
   re-ensure never rotates the identity key." Topic = `hash(pubkey)`, so the topic
   never changes when a member is removed → the removed member retains the topic.
5. **Cores aren't encrypted per-member** (no `encryptionKey` in `corestore.ts` /
   `boot.ts`), so replicated content is directly readable.

**Repro (the test to add — demonstrates the gap):** 2 peers A (owner) + B (member)
on a hive. B reads A's content (baseline). A revokes B. A writes a NEW feature. B
reconnects on the same topic → assert B STILL receives/reads the new feature
(origin=remote) even though its own writes are now refused. (Today this passes =
the gap; a fix makes it fail = read cut off.)

**Fix options (product/security decision required before public release):**
- (a) **Re-key on removal** — rotate the hive pubkey/topic on member-remove and
  re-distribute to remaining members. True cryptographic removal. (Biggest change;
  the identity is currently deliberately immutable — that decision must be revisited.)
- (b) **Gate replication on admission** — don't `store.replicate` (or serve cores)
  until the peer passes the announce/admission, and evict on revoke. Closes the
  ongoing-read path without re-keying (but a removed member who cached old content
  keeps that).
- (c) **Connection-level eviction by device** — bind the swarm connection key to
  the announced device pubkey and add revoked devices to the firewall/ban set;
  destroy live connections from revoked devices on revoke.
- (d) **Document as a trust-model limitation** (minimum bar) — release notes +
  the "Remove member" UI must state removal stops writes; reading the hive's
  future content is only fully cut off by dissolving + recreating the hive. The UI
  must not imply more than it delivers.

**Recommendation:** at minimum (d) before release, and (b)/(c) as the real fix.
Get a product call on whether "remove member" must mean full cutoff.

**STATUS: EMPIRICALLY CONFIRMED** (not just code-reading). Test
`federation-adversarial.integration.test.ts` → "C-001 (release gap): a removed
member can no longer WRITE, but STILL READS new content" passes today: a removed
member's new write does NOT reach the owner (write-plane cut ✓) while the owner's
new content STILL reaches the removed member (read-plane open = the gap). The
assertion is written to FLIP (`.toBeUndefined()`) when read-plane revocation lands,
so it's a live regression guard for the fix.

**GENERALIZATION — there is NO read-plane revocation ANYWHERE.** C-001 is the
member-removal instance of a single root cause: the hive identity (pubkey = topic)
is immutable and reads are a permanent topic-capability. The SAME gap recurs at
visibility transitions:
- **public → private does NOT re-key** — `hive-set-listing.ts:65-95` (P-015): the
  private flip is a "WITHDRAWAL — stop re-announcing + Cupboard unlist" + a
  directory tombstone. It removes the hive from DISCOVERY only. Anyone who obtained
  the pubkey while it was public (it's published in the directory!) keeps reading
  the now-"private" hive's ongoing content. (Corollary of C-001 — S1.)
- **dissolve** DOES tear the hive down (`hive-dissolve.ts`), so it's the only true
  read-stop — but it destroys the hive entirely, not selective removal.

So the real, single finding for the release threat model: **membership and
visibility control DISCOVERY and WRITES; read access is a permanent capability
that cannot be selectively revoked without re-keying (unimplemented) or dissolving
the hive.** This MUST be a conscious, documented design decision before public
release, and the "Remove member" / "Make private" UI must not imply more than it
delivers. (Brief E owns the live private-flip cut-off test — it will fail to cut
off a prior pubkey-holder; coordinate so we file ONE finding, not two.)

---

## Brief C threat coverage status (running)

| # | Threat | Status |
|---|--------|--------|
| 1 | Privacy leak — non-member reads private hive | **COVERED for NEVER-members (unit + END-TO-END).** topic = hash(pubkey), pubkey only in links: unit `derive-swarm-topic.test.ts` (hive ≠ gh topic; distinct pubkeys → distinct topics; domain-sep) + NEW over-wire `federation-threat-model.test.ts` "never-member on a guessed gh: topic reads nothing": a guesser booting on `gh:<repo_id>` never connects to a private hive on `hive:<pubkey>` (admits 0 remote logs, reads nothing) while a legit member on the hive topic reads it. Teeth-verified. **The one open path is the FORMER-member read-revocation gap → C-001** (S0 on the strict rubric). |
| 2 | Unauthorized write (non-member) | COVERED — `federation-adversarial` admission gate (verifyBinding fail → not admitted). Verify the REAL gate (no override) is next. |
| 3 | Revoked member still WRITES | COVERED — `revocation-*` (refused announce + dropped log). |
| 4 | Identity spoofing — forged sig | **COVERED — unit + OVER-WIRE.** unit (`announce.test.ts`: bad key, garbage sig, tampered field/ts/nonce/gist, stale/future ts) + NEW end-to-end `federation-threat-model.test.ts` "forged-signature announce never federates": a peer advertising a valid device_pubkey but signing with a DIFFERENT key is never admitted (bad_sig) over the real wire **with the binding gate wide open** (verify→'verified'), isolating the sig gate; a correctly-signed control peer crosses. Author-substitution (user_id/pubkey mismatch) → 'fail' (`verify-binding-adapter.test.ts`). Teeth-verified (un-forge → forger crosses → RED). |
| 5 | Replay | **COVERED (incl. across reboot, structurally).** `announce.test.ts` freshness window (±5min; stale/future → reject) blocks replay-ANNOUNCE; `ei117-replay-revert-guard` (6 cases) blocks replay-OP. The guard is PG-persisted (`fed_ts`/`origin` columns, read per-op — not in-memory), so it holds across a process restart by construction. *Residual:* no explicit "replay after restart" cell (low priority — guard state is durable in PG). |
| 6 | Malformed/poisoning ops | **COVERED — ROBUST.** New test "garbage ops … cannot wedge the pipeline" (federation-adversarial): NaN ts, null value, junk schema_version, unknown op-type, AND a 1MB oversized payload all fail to crash or wedge an honest peer — a valid op always still federates. (Initial 25s-poll failure was load-induced slowness, NOT a wedge — confirmed transient with a 75s poll.) Minor note **C-002 (S3)**: no explicit op-SIZE bound — huge ops replicate but slow sync under load (head-of-line); consider a payload cap to blunt a slowness-DoS. Not a blocker. |
| 7 | Workspace isolation | **COVERED at the topic layer** — `derive-swarm-topic.test.ts` "different workspace → different topic even for same slug" (`local:` binding embeds `workspace_id`); apply-side EI-1534 (conversations) + `crossworkspace-invariant.test.ts` (memory). *Assumption (documented):* `hive:<pubkey>` topics are workspace-INDEPENDENT by design (a Hive is the cross-workspace unit; pubkey minted once per hive → no same-pubkey-in-two-workspaces federation). |
| 8 | Invite-secret enforcement | **COVERED.** `derive-hive-topic.test.ts` ("deriveInviteTopic differs per secret AND differs from the global topic"; "rejects an empty secret"; exact sha256) + `visibility-content-topic-separation.test.ts` E-002 ("invite directory topic ≠ global → non-secret-holder never sees it"; "per-secret isolation — two secrets → two topics"). Wrong secret → different topic; absent secret → rejected; not derivable from the public directory. |

**Next actions (this lane):** ALL of (1) C-001 demonstrating test, (2) real
admission-gate (covered by composition — see su-b62fa assessment), (3) forged-sig
end-to-end (#4), (4) malformed-op robustness (#6), plus #1 topic-secrecy end-to-end —
are DONE + teeth-verified (see the su-b62fa section below). **The only remaining gate
is the C-001 product/security decision** (write+discovery-plane revocation vs full
read cutoff) — owner's call.

**Dimension verdict so far: YELLOW → trending RED** pending the C-001 product
decision. A public-release privacy story with write-only revocation must be a
conscious, documented choice — not a silent gap.

---

## su-b62fa additions (2026-06-19) — over-wire sig gate, unit-layer complements, coverage assessment

New dedicated test file: **`packages/operator-core/lib/sync/hyperbee/__tests__/federation-threat-model.test.ts`**
(4 tests, all GREEN + teeth-verified; **unit layer** — capture-sink, no PG, so they
run in the green gate that the sibling `*.integration.test.ts` cases do NOT).

1. **Threat #4 — forged-signature over the wire (NET-NEW).** Closes the matrix-#4
   "end-to-end forge-over-wire test still to add" gap. A forger advertises a valid
   32-byte device_pubkey but signs the announce with a different key; the receiver
   admits any *userId* (binding gate wide open), so the only thing that can reject
   it is `verifyAnnounce → sigValid=false → bad_sig`. Asserts the forger's log is
   never admitted + its content never federates, while a valid-sig control crosses.
   Confirms `boot.ts:1164` (`verifyAnnounce(frame)`) fires end-to-end. **Teeth:**
   un-forge (sign with the advertised key) → forger crosses → RED.

2. **C-001 — read-after-revocation demonstrator (unit-layer second confirmation).**
   Owner A + member B mutually federate; A `handle.revoke(B)`; A writes new content;
   B STILL reads it. Complements the lead's integration version with a green-gated
   unit-layer guard. **Teeth:** make B reject A → baseline read fails → RED (proves
   the test genuinely observes B reading, not a false positive).

3. **Threat #6 — malformed/poisoning op battery (unit-layer, dispatch grain).**
   `applyOpVia` against 12 hostile envelopes (unknown/retired type, missing/unknown
   table, null/primitive/wrong-schema/non-string-id value, del-without-hbKey,
   NaN & Infinity watermark ts, 256 KiB payload): every malformed *shape* is DROPPED
   (false), valid-shape-bad-metadata ops apply without throwing, NOTHING crashes,
   and no malformed-shape op reaches the projection writer. Complements the lead's
   integration "garbage ops cannot wedge the pipeline" + C-002 (op-size). **Teeth:**
   widen `decodeValue` to accept anything → poisoned ops reach the writer → RED.

4. **Threat #1 — topic-secrecy end-to-end (NET-NEW).** A never-member booting on the
   GUESSED `gh:<repo_id>` topic never connects to a private hive federating on
   `hive:<pubkey>` (admits 0 remote logs, reads nothing), while a legit member on the
   hive topic reads the content. Lifts the unit topic-divergence (`derive-swarm-topic`)
   to an over-wire proof that a topic-guesser gets nothing. **Teeth:** put the guesser
   on the real hive binding → topics collide → RED.

### Coverage assessment of the remaining "partial" matrix rows (no new test needed)

- **#1 topic-secrecy — COVERED** by `derive-swarm-topic.test.ts`: a private hive uses
  `hive:<pubkey>` (topic = `sha256("papercusp-substrate-v1:hive:"+pubkey)`); a
  never-member who knows only the GitHub repo derives `gh:<repo_id>` — a *different*
  topic (cells: "a joiner with only the link topic matches the owner HIVE topic — NOT
  the gh-repo topic", "distinct hive pubkeys → distinct topics", domain-separation).
  The hive topic is unguessable from public info. (The removed-member read path is
  C-001, the one real gap.)
- **#2 unauthorized-write — COVERED by composition.** The REAL admission decider is
  unit-tested in `verify-binding-adapter.test.ts` (valid→'verified'; user_id_mismatch
  forgery→'fail'; pubkey_mismatch→'fail'; gist_not_found→'fail'; missing gist→'fail'
  without calling verifyAttestation) + `two-channel-verifier.test.ts`; the three-tier
  admission flow is `trust-admission-e2e.integration.test.ts` (untrusted→quarantine→
  auditor; trusted→auto-run; revoke→re-screen); data-plane enforcement is the
  `federation-adversarial` admission gate; the sig half is now over-wire-proven (#4
  above). The ONLY non-hermetic piece — the live GitHub-gist HTTP fetch — is
  necessarily stood-in offline (every sibling does this) and exercised live only in
  the owner-gated Hetzner runbook.
- **#5 replay — COVERED (incl. across reboot, structurally).** `announce.test.ts`
  freshness window (±5 min, stale/future → reject) blocks replay-ANNOUNCE;
  `ei117-replay-revert-guard.integration.test.ts` (6 cases) blocks replay-OP. The
  guard is PG-persisted (`fed_ts`/`origin` columns, not in-memory), so it survives a
  process restart by construction. *Residual:* no explicit "replay after restart"
  integration cell — low priority (the guard state is durable in PG).
- **#7 workspace isolation — COVERED at the topic layer.** `derive-swarm-topic.test.ts`
  already has "different workspace → different topic even for same slug" (`local:`
  binding embeds `workspace_id`). Apply-side isolation: EI-1534 (conversations) +
  `crossworkspace-invariant.test.ts` (memory). *Documented assumption:* `hive:<pubkey>`
  topics are workspace-INDEPENDENT by design (a Hive is the cross-workspace unit; a
  pubkey is minted once per hive, so no same-pubkey-in-two-workspaces federation).
- **#8 invite-secret — COVERED (structurally).** The invite directory topic =
  `deriveInviteTopic(inviteSecret)` — unguessable without the secret (same secrecy
  property as #1); `hive-directory-meta.ts:33` refuses an invite hive with no secret;
  `hive-directory-live-two-peer` carries the invite no-leak seed. *Residual:* no
  explicit "wrong secret → no listing" cell (same shape as topic-secrecy).

### Brief E sibling (su-963ee) — same root cause, visibility axis

C-001 (membership revocation) and Brief E's public→private withdrawal are two axes of
ONE defect: replication is unconditional for any already-connected topic peer
(swarm.ts:329), the topic never re-keys (hash of the immutable pubkey), cores are not
per-member encrypted. Acked with su-963ee; release notes should carry ONE honest
statement: *membership/visibility changes do not cut off a reader already connected
to the topic.*

### C-001 DISPOSITION — owner chose option (d) (2026-06-19) → verdict YELLOW (achieved)

The owner decided: **do NOT change behavior this release; make the UI honest** (C-001
option (d)). LANDED — two user-facing strings reworded (no logic change):
- `apps/operator/app/harness/ShareHiveDialog.tsx` — the "Private" visibility consequence
  copy now says members who already joined keep reading new content over the existing
  topic; only Dissolve cuts off an existing reader.
- `apps/operator/app/_components/HowSharingWorks.tsx` — the revoke explainer now says
  revocation stops your *writes* across every member repo; if you already joined you
  keep *read* access to new content until the hive is dissolved.
`ShareHiveDialog.test.tsx` re-run green (17 tests); no test asserted the old copy. The
read-cutoff fix (b/c/a) stays on the roadmap as the path to GREEN. So the verdict is now
**YELLOW**: a documented, in-UI limitation rather than a silent leak.

### Dimension verdict (su-b62fa) — was RED on the strict rubric; now YELLOW after the option-(d) honest-copy fix

By the program's S0 definition ("privacy leak = non-member reads private data") and
its rule ("if any privacy leak exists, verdict is RED regardless"), **C-001 is RED**:
a removed member (now a non-member) keeps reading private content, and a former
public-then-private hive's prior pubkey-holder does too. This is a real read-plane
privacy leak. It reduces to **YELLOW** the moment the product makes + DOCUMENTS the
conscious trust-model decision (C-001 option (d): "Remove member / Make private stops
writes + discovery; it does NOT cut off an already-connected reader — only dissolve
does") AND the UI stops implying full cutoff. It is **GREEN** only when option (b)
[replication gated on admission], (c) [connection-level device eviction], or (a)
[re-key on boundary change] actually closes the read path. Every OTHER threat
(#2,#3,#4,#5,#6,#7,#8) is defended with teeth-verified coverage. **UPDATE 2026-06-19:**
the owner made the call — option (d), honest copy landed (see the disposition above), so
the dimension verdict is now **YELLOW** (documented limitation). GREEN remains gated on
the read-cutoff fix (b/c/a), tracked as roadmap, not a v1 blocker.

Full release-notes threat model: **`shared-hive-release-testing/threat-model-C.md`**.
