# Brief K — C-001 / E-001: read-plane revocation findings

Owner: su-313d1. Lane: read-plane revocation live witness (S1 → S0-potential).
Status: **member-remove leg WITNESSED LIVE** on the real binary (closing the leg
Brief E left open) + two new findings (K-1, K-2) + one observation (K-3). Re-key
(Move 2) is **product-gated**; the owner has already chosen **option (d)** for this
release (document honestly; re-key is roadmap — see `threat-model-C.md`,
`DESIGN-hive-federation-long-term.md`).

---

## TL;DR verdict — **YELLOW** (matches C/E; release-honest, not release-clean)

The release-gating question — *does removing a member cut off their READS?* — is now
answered **live, on the shipped binary**: **NO.** A genuinely-removed member keeps
reading every new piece of owner content. The owner has consciously accepted this for
this release (option (d): make the UI honest, defer the real cut-off). So this is a
**documented limitation, not a silent leak → YELLOW.** **GREEN** still requires
closing the read path (re-key on transition / replication gated on admission /
device-level eviction) — roadmap, not this release.

This lane's contribution over the prior A–G pass:
1. **Found the authorized removal path** that unblocks the witness E could not get
   (E hit a 403; the superuser bearer elevates past it — §Method).
2. **Witnessed the member-remove read-persistence LIVE** with a *genuine production
   revoke of the member's real device key* (§Witness).
3. **Two new defects** the prior pass had not isolated: the Hive-scope revoke is a
   no-op beyond a local PG write (K-1), and it never federates to the joiner (K-2).

---

## Method — the authorized removal path (unblocks Brief E's 403)

Brief E's live witness was blocked because `POST /api/admin/substrate/revoke-contributor`
returned **403 "trust unverified-loopback not in allowlist"** to a loopback curl.
The endpoint's auth gate is `auth: { trust: ['verified', 'trusted'] }`
(`endpoint-route/routes/admin/substrate-revoke-contributor.ts`), and a bare loopback
request is the `unverified-loopback` principal — correctly refused.

**The authorized owner path: the superuser bearer.** Each packaged instance writes its
own token to `<instance-home>/.papercusp/superuser-token`. Calling the endpoint with
`?superuser=1` + `Authorization: Bearer <token>` **elevates the `unverified-loopback`
principal to `trusted`**, so the handler runs. Verified live: the same call that 403'd
for Brief E reached the handler logic and returned a *semantic* error (`no_target`),
not an auth error. This is the same mechanism `gym/smoke.ts` uses to drive admin
routes ("superuser bearer (elevates trust past the loopback allowlist)").

The remaining blocker was then **`no_target`** — the synthetic content-matrix smoke
pair seeds `hive_members` with **empty `device_attestations`** (and A-003 means a
joiner's membership never crosses to the owner anyway), so the revoke lever
(`revokeHiveContributor` → `loadHiveMemberDevicePubkeys`) finds no device pubkey to
revoke. Resolved by extracting the member's **real** device pubkey from its keychain
and seeding it as the membership precondition (a stand-in for the join record A-003
prevents from arriving) — see §Witness step 2. The *removal itself* then runs through
the genuine production lever, unmodified.

### Pair under test
`~/.papercusp-shared-hive-retest` (su-9140a's fresh-boot pair, real
`Papercusp_0.0.2_amd64.deb`, luxon-bundled, Xvfb `:154`):
- **A = owner** `papercupai` (gh `279242982`), holds the Hive keypair
  (`keypair-hive_default_hello-world-hive.enc`) → recognized as the Hive owner.
  sidecar `:23788`, embedded PG `17692`.
- **B = joiner** `aviynw` (gh `1567022`), real device pubkey
  `Z2LOLc/QCz84xIin8yUXgedmgJu7nBgW3bgmErFyZoY=`. sidecar `:16553`, PG `22267`.
- Hive `hello-world-hive`; content harness `hello-world`; content topic `75e49c5c…`.
- Federation verified via each peer's embedded-PG `origin` column
  (`harness_shared.harness_features_consolidated`).

---

## Witness — member-remove → reads persist (LIVE, real binary)

**Step 0 — baseline (read plane works).** A wrote `F-KWIT-BASE` → B observed it
`origin=remote` in <10s. A→B federation is healthy.

**Step 1 — precondition.** A's `hive_members` carried only the synthetic seed row
(`88881`, empty attestations). Seeded two rows on A so the production lever can run:
the owner's own row (`279242982`/papercupai) and the target row
(`1567022`/aviynw) carrying B's **real** device pubkey in `device_attestations`. This
stands in for the join membership record A-003 prevents from arriving naturally; the
device key is B's authentic one (extracted from B's keychain).

**Step 2 — genuine production removal (authorized).** Drove the real lever via A's
superuser bearer:
```
POST :23788/api/admin/substrate/revoke-contributor?superuser=1
  { workspaceId:"default", hiveSlug:"hello-world-hive", githubUserId:1567022 }
→ { ok:true, revokedPubkeys:["Z2LOLc/QCz84xIin8yUXgedmgJu7nBgW3bgmErFyZoY="], live:false }
```
A's owner row `revoked_pubkeys` then contained B's real device key. **The removal
landed** — recorded by the genuine production path, not a hand-written revocation.

**Step 3 — the gap (reads persist).** A (owner) then wrote a NEW feature
`F-KWIT-POST` *after* removing B. **B — the removed member — still read it**
(`origin=remote`) in ~12s, indistinguishable from the pre-removal baseline.

> **C-001 / E-001 read-plane gap CONFIRMED LIVE on the shipped binary: removing a
> member does not cut their reads.** A→B positive control (`F-KWIT-AB2`) confirmed the
> link was healthy throughout, so the persisted read is real, not stale cache.

This closes the member-remove leg Brief E left open ("no removal happened → 'B still
reads' proved nothing"). Here a removal *did* happen — through the production lever,
revoking B's real device key — and B still reads.

---

## Findings

### K-1 (NEW, S1) — Hive-scope revoke is a no-op beyond a local PG write (`live:false`)

`revokeHiveContributor` (`hive-revoke-contributor.ts`, the Hive-scope "remove member"
the desktop/Pots path uses) returns **`live:false`**: its `realPublishRevocation` only
calls `addRevokedHivePubkeys` (a PG `UPDATE` of the owner's own row) and comments *"the
Hive peer-log publish that replicates it to peers is wired by the P-004 substrate
re-key"* — i.e. **not wired**. Contrast the harness-scope lever
(`sync/hyperbee/revoke-contributor.ts:324`) which does `for (const pk of pubkeys) await
h.revoke(pk)` for immediate local effect. So a Hive member "removed" via the Hive path:
- is **not live-revoked** on the booted handle (no `h.revoke`) — write-plane cutoff is
  deferred to the next admission-union reload, not immediate;
- and (K-2) the revocation **never leaves the owner's box**.

Net: the Hive-scope "remove member" is weaker than the harness-scope one — effectively
a local bookkeeping write until a reboot/re-admission. Severity **S1** (a removal the
UI presents as effective is, on the Hive path, inert live and non-propagating).

### K-2 (NEW, S1) — Revocation never federates to the joiner

After the removal, B's `hive_members` held only its own synthetic row with empty
`revoked_pubkeys` — **A's revocation never reached B.** A removed member learns nothing
of its own removal, and no *other* peer learns it either, so no peer can enforce it.
This is the revocation-side companion to **A-003** (Brief I: `hive_members`/`hive_settings`
don't federate to a joiner) and the unwired P-004 peer-log publish (K-1). Member
revocation is therefore broken on **both** planes for joiners: read-not-cut (C-001) +
revocation-record-not-delivered (A-003/K-2). Brief I (su-d2230) owns the federation
fix; K-2 is the same root surfaced from the revocation path.

> **UPDATE (Brief I fix landed, su-d2230, 2026-06-19):** Move 1 (mechanical, no product
> decision) now binds a joiner's member-harness `hive_members`/`hive_settings`
> projections to the **hive-home slug** (register-all), so the owner's `hive_members`
> row — *including its `revoked_pubkeys`* — should now federate to a joiner. That is
> exactly the delivery K-2 was missing — and su-d2230 **confirmed** it closes the
> revocation half "for free" (`loadRevokedHivePubkeys` now finds the federated
> `revoked_pubkeys`). So **K-2 is resolved by the Brief I fix** (filed in **EI-1604**,
> marked CLOSED-by-I). Caveat: (a) needs a **fix-`.deb`** to live-re-verify — the
> pre-fix `:154` pair was torn down (su-9140a); the re-witness rides su-9140a's
> **integrated** fix-`.deb` (A-002 + A-003 + D-001 in one pass); (b) it closes the
> revocation-*record-delivery* gap, **not** K-1 (`live:false`, still needs the P-004
> live-revoke wiring) and **not** C-001 (the READ cutoff still requires Move 2 re-key).
> Net after Brief I: removed members' new *writes* can be denied on joiners (record
> delivered) but they keep *reading* until Move 2.
>
> **UPDATE 2 (live re-witness path — su-9140a, 2026-06-19):** on su-9140a's integrated
> fix-`.deb` (`/tmp/integrated-witness/Papercusp_integrated.deb`, carries Brief I's
> `joinerHiveHomeSlug`), A-003 came back **inconclusive on the content-matrix** — B had
> **0** `hive_members`/`hive_settings` rows and **0** rekey log lines: the hive-home
> binding engages on the **from-repo join** (`join-shared-harness.ts`
> stepBootFederate→bootSingleHarness), **not** the lighter **discovery-join**
> (`POST /api/discovery/join-hive`) the content-matrix uses. This also explains why my
> `:154` witness had to *seed* A's `hive_members` (discovery-join never populates them).
> ⇒ **K-2's LIVE re-witness must use the FROM-REPO join flow**
> (`two-instance-hive-from-repo-smoke.sh`), not the content-matrix. K-2 is code-/unit-
> verified (d2230's teeth-verified test) but its live confirmation is **pending the
> from-repo pass** (coordinated with su-9140a; recipe sent). Open question for d2230:
> does the Brief I fix hook discovery-join too, or only the from-repo join?

### K-3 (OBSERVATION, inconclusive) — B→A content federation was fragile this run

B's post-removal writes (`F-KWIT-BWRITE`, and `F-KWIT-BWRITE2` written *after*
un-revoking) never reached A within 60s+, while A→B carried 300+ scale markers + all
my A-writes reliably. Only **one** B→A marker (`F-MX-ba`, from the retest, before the
scale-seed and before my revoke) ever crossed. **I cannot cleanly attribute this**: it
is consistent with *either* (a) the revoke dropping B's log on A and the un-revoke not
re-admitting it live (which would mean the write-plane cut *did* take effect, just
irreversibly without a re-announce/reboot), *or* (b) B→A incremental degrading
independently under the concurrent 300-marker scale-seed. Flagged to su-9140a
(Brief N, scale/churn) and su-d2230 (Brief I, directionality) — not filed as a
confirmed defect. The **write-plane cutoff is already teeth-verified at the integration
layer** (`federation-adversarial`: "removed member can no longer WRITE"), so this
ambiguity does not affect the C-001 conclusion (which is about READS).

---

## Scenario coverage (vs brief)

| # | Scenario | Result |
|---|----------|--------|
| 1 | Member-remove live witness (read persists) | ✅ **DONE** — genuine revoke of B's real device key; B still reads `F-KWIT-POST` (`origin=remote`). |
| 2 | Rejoin-after-link / non-member-with-link reads | ✅ **structurally shown** — the content topic = `hash(immutable pubkey)`; B never left it, so reads continue by construction. The post-revoke read *is* a link-holder-keeps-reading demonstration. A standalone "B leaves → rejoins → reads" drive was not run (the immutable-topic root is already proven; low marginal value). |
| 3 | Re-key prototype (cut reads) | ⛔ **product-gated, deferred** — owner chose option (d) for this release; re-key is `DESIGN-hive-federation-long-term.md` **Move 2** (per-epoch group key / TreeKEM + content-core encryption), roadmap. Not built into this release. See §Re-key. |

---

## Re-key (Move 2) — the only real fix, and why it is NOT in this release

Per `DESIGN-hive-federation-long-term.md`, the read-plane gap (C-001 + E-001) is one of
two architectural problems and the **only** fix that actually cuts reads is **Move 2**:
an immutable-identity hive with unencrypted cores and `content topic = hash(pubkey)`
*structurally cannot* cut a reader — the principled answer is a **per-epoch group key**
(MLS/TreeKEM-style) + content-core encryption, where member-remove / public→private
advances the epoch and re-keys to the remaining members so a removed peer cannot
decrypt new content (this also subsumes A-003/K-2 revocation enforcement).

**The owner has already made the cut-off decision: option (d)** — keep write+discovery-
plane revocation this release, make the UI honest (`threat-model-C.md`; the honest copy
landed in `ShareHiveDialog.tsx` / `HowSharingWorks.tsx`). Therefore Move 2 is **not**
prototyped into this release; building it would contradict the shipped decision. The
`coord:ask-owner` the brief asks for is **already answered** (option d) — re-confirm
before any Move-2 work, since Move 2 is real crypto + a product call, not a patch.

---

## Deliverables status
- ✅ Live member-remove read-persistence witness (this doc, §Witness) — closes E's leg.
- ✅ Authorized-path discovery (superuser bearer) — unblocks the witness E couldn't get.
- ✅ New findings K-1, K-2 (filed as an EI; see coord) + K-3 observation flagged to N/I.
- ✅ Teeth-verified regression guard for the read-plane gap + the K-1 `live:false`
  invariant (Vitest — see §Regression).
- ✅ Cut-off decision: already answered (option d); re-key = roadmap.

## Regression (Vitest, teeth-verified)
The read-plane gap is already codified + teeth-verified at the integration layer:
`packages/operator-core/lib/sync/hyperbee/federation-adversarial.integration.test.ts`
("C-001 (release gap): a removed member can no longer WRITE, but STILL READS new
content") — asserts the read crosses post-revoke and is written to FLIP when read-plane
revocation lands, so it is a live regression guard for the fix.
This lane adds a unit guard for **K-1** (`hive-revoke-contributor`'s `live:false` /
PG-only behavior) so the no-op-beyond-PG property can't silently change without a test
going red — see `hive-revoke-contributor.*test*`. (teeth-verified: green → neuter the
invariant → RED → restore → GREEN.)

## State left on the pair (for su-9140a / Brief M)
- A's `revoked_pubkeys` was cleared back to `{}` after the witness (control step).
- Seeded `hive_members` rows left in place on A (papercupai `279242982`, aviynw
  `1567022` with B's real device key) — benign, and make the pair's membership render
  *more* realistic for M's status surface.
- Witness markers `F-KWIT-*` left in the feature tables as evidence.
- **Pair since TORN DOWN by su-9140a** (sidecars `:23788`/`:16553` down, ports freed)
  after the witness was captured — it was the pre-fix 05:33 `.deb`, only useful for the
  pre-fix witness. The K-2 / C-001 re-witness rides su-9140a's **integrated fix-`.deb`**
  pair (A-002 + A-003 + D-001) — see the coord ask; no separate pair needed.
