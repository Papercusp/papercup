# Brief K — C-001 / E-001: read-plane revocation findings

Owner: su-313d1. Lane: read-plane revocation live witness (S1 → S0-potential).
Status: **member-remove leg WITNESSED LIVE** on the real binary (closing the leg
Brief E left open) + two new findings (K-1, K-2) + one observation (K-3). Re-key
(Move 2) is **product-gated**; the owner has already chosen **option (d)** for this
release (document honestly; re-key is roadmap — see `threat-model-C.md`,
`DESIGN-pot-federation-long-term.md`).

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
3. **Two new defects** the prior pass had not isolated: the Pot-scope revoke is a
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
`~/.papercusp-shared-pot-retest` (su-9140a's fresh-boot pair, real
`Papercusp_0.0.2_amd64.deb`, luxon-bundled, Xvfb `:154`):
- **A = owner** `papercupai` (gh `279242982`), holds the Pot keypair
  (`keypair-hive_default_hello-world-pot.enc`) → recognized as the Pot owner.
  sidecar `:23788`, embedded PG `17692`.
- **B = joiner** `aviynw` (gh `1567022`), real device pubkey
  `Z2LOLc/QCz84xIin8yUXgedmgJu7nBgW3bgmErFyZoY=`. sidecar `:16553`, PG `22267`.
- Pot `hello-world-pot`; content harness `hello-world`; content topic `75e49c5c…`.
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
  { workspaceId:"default", hiveSlug:"hello-world-pot", githubUserId:1567022 }
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

### K-1 (NEW, S1) — Pot-scope revoke is a no-op beyond a local PG write (`live:false`)

`revokeHiveContributor` (`pot-revoke-contributor.ts`, the Pot-scope "remove member"
the desktop/Pots path uses) returns **`live:false`**: its `realPublishRevocation` only
calls `addRevokedHivePubkeys` (a PG `UPDATE` of the owner's own row) and comments *"the
Pot peer-log publish that replicates it to peers is wired by the P-004 substrate
re-key"* — i.e. **not wired**. Contrast the harness-scope lever
(`sync/hyperbee/revoke-contributor.ts:324`) which does `for (const pk of pubkeys) await
h.revoke(pk)` for immediate local effect. So a Pot member "removed" via the Pot path:
- is **not live-revoked** on the booted handle (no `h.revoke`) — write-plane cutoff is
  deferred to the next admission-union reload, not immediate;
- and (K-2) the revocation **never leaves the owner's box**.

Net: the Pot-scope "remove member" is weaker than the harness-scope one — effectively
a local bookkeeping write until a reboot/re-admission. Severity **S1** (a removal the
UI presents as effective is, on the Pot path, inert live and non-propagating).

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
> projections to the **pot-home slug** (register-all), so the owner's `hive_members`
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
> **0** `hive_members`/`hive_settings` rows and **0** rekey log lines: the pot-home
> binding engages on the **from-repo join** (`join-shared-harness.ts`
> stepBootFederate→bootSingleHarness), **not** the lighter **discovery-join**
> (`POST /api/discovery/join-pot`) the content-matrix uses. This also explains why my
> `:154` witness had to *seed* A's `hive_members` (discovery-join never populates them).
> ⇒ **K-2's LIVE re-witness must use the FROM-REPO join flow**
> (`two-instance-pot-from-repo-smoke.sh`), not the content-matrix. K-2 is code-/unit-
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
| 3 | Re-key prototype (cut reads) | ⛔ **product-gated, deferred** — owner chose option (d) for this release; re-key is `DESIGN-pot-federation-long-term.md` **Move 2** (per-epoch group key / TreeKEM + content-core encryption), roadmap. Not built into this release. See §Re-key. |

---

## Re-key (Move 2) — the only real fix, and why it is NOT in this release

Per `DESIGN-pot-federation-long-term.md`, the read-plane gap (C-001 + E-001) is one of
two architectural problems and the **only** fix that actually cuts reads is **Move 2**:
an immutable-identity pot with unencrypted cores and `content topic = hash(pubkey)`
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
This lane adds a unit guard for **K-1** (`pot-revoke-contributor`'s `live:false` /
PG-only behavior) so the no-op-beyond-PG property can't silently change without a test
going red — see `pot-revoke-contributor.*test*`. (teeth-verified: green → neuter the
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

---

## Re-key (Move 2) — **IMPLEMENTED** (2026-06-19, su-ee7e9 + 7dcd8 + 328af + c2a63)

The §"Re-key (Move 2) … NOT in this release" verdict above is **superseded**: the owner
re-confirmed and chose to **build Move 2** this session. It is now implemented end-to-end,
**flag-dark behind `papercusp-pot-rekey`** (default off → zero production behavior change
until the witness is green + the owner flips the flag), committed + pushed to
`origin/staging`. Full hyperbee backbone **1085** green with the whole stack together.

**What landed (all flag-dark):**
- **A-003 seam** — the pot-home→joiner path the epoch/key rows ride; first GREEN live
  witness on the real binary (`findings-A003-GREEN-witness-2026-06-19.md`) + re-landed +
  pinned. EI-1688 (snapshot delete-resurrection, the revocation-durability prereq) fixed.
- **Per-epoch content crypto** (`pot-epoch-op-gate.ts`) — encrypt-on-capture (7dcd8) +
  apply-side decrypt gate + owner|member key resolver (su-ee7e9). AEAD bound to
  (pot, epoch, op-identity); decrypt wraps the enforcement stack OUTERMOST
  (decrypt → EN-4 → EN-2 → scopedApply; 328af-reviewed). Boot thread + `buildHiveRekeyBootDeps`.
- **`hive_epoch_keys` distribution** — federated projection + CDC serializer (su-ee7e9).
- **Boundary trigger** (`advanceEpochOnHiveBoundary`) — member-remove + go-private advance
  the epoch + re-key REMAINING members. **This is the C-001 read cut:** a removed member's
  epoch-N+1 key never arrives → its post-boundary content defers forever, undecryptable.
  Closes **K-1** (revoke now `live:true`) + **K-2** (cut is at the CRYPTO layer; the content
  topic stays immutable, so no topic-level cutoff is needed).
- **Member-ADD key distribution** (`grantEpochKeysToMembers`, wraps [0..current]) — the
  join-time gap su-ee7e9 found by analysis: the boundary trigger fired ONLY on
  remove/go-private, so a JOINER got no key (the re-key cut everyone, not just removed
  members) — masked by hermetic tests seeding keys. Fix grants every epoch key [0..current]
  to a joiner (content is encrypted-once + never re-encrypted on advance → a collaborator
  needs all prior keys to read the existing project; c2a63's correctness call).
  Owner-self-gating; wired into BOTH admission seams (`upsertHiveMember` + open-mode
  `boot.ts` admit), dual-reviewed (su-ee7e9 + 328af).

**P-008 live cut-off witness — DESIGN (run pending, folded with 328af's AK in one flag-on
.deb rig):** extend `two-instance-pot-from-repo-smoke.sh`, flag-on via env
`PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1`. K0 B's `hive_epoch_keys` count ≥ 1 (origin=remote,
member-add grant federated) → K1 CONTROL A writes F-CTRL → B reads it (decrypts) → K2 A
revokes B via `substrate:revoke_contributor` (→ `revokeHiveContributor` → epoch advance) →
K3 CUT A writes F-CUT → B **cannot** read it (defers, undecryptable) while a remaining
member can. The 2-peer CUT (B read F-CTRL, can't read F-CUT) = the release-grade C-001
proof; 3rd-instance remaining-member-reads-F-CUT = non-regression follow-up.
**Result: ⏳ pending the run.** Ship gate, NOT a correctness gate — implementation proven
hermetically (backbone 1085 + 7dcd8 68/22 + 328af compose 6/6 + helper 8/8 + seam tests).
Plan: `shared-pot-rekey-2026-06-19`.

## P-008 live witness — the KEY-LEVEL reframe + the live diagnosis (2026-06-20, su-ee7e9 + su-9140a + 328af + c2a63)

The content-based K1/K3 design above (B reads F-CTRL → can't read F-CUT) was **re-designed mid-run**: on the live binary it false-RED'd — not on the cut, but on **WI-259** (the D-021 scopedApply `harness_slug` guard silently drops a *cross-member* content op, so A's member-slug F-CTRL never crosses to B regardless of the re-key). WI-259 is an orthogonal content-federation bug; conflating it with the cut made the witness un-passable.

**The reframe (the key insight):** a read-revocation cut lives in the CREDENTIAL plane, not the data plane — so prove it there. The C-001 cut = *the removed member's device gets no post-revoke epoch key*. `hive_epoch_keys` is POT-HOME-grained, so it federates A→B (A-003-proven) regardless of WI-259. The witness therefore probes the epoch-key plane, **content-free**:
- **B_DEV** (the cut-off device set) = `member_device_pubkey @ epoch=CUR EXCEPT @ epoch=NEW` on A (A stays a member ⇒ in both ⇒ excluded; the diff is exactly B's device) — authoritative, no hive_members JSON parse.
- **K0** B's device has wrapped keys origin=remote — the member-add grant federated.
- **K1 control** B's device has the CUR-epoch key (could decrypt pre-revoke).
- **K-revoke** A revokes B → epoch N→N+1, wrap to REMAINING members (not B).
- **K-CUT** B's device has **0** rows at epoch N+1 — the cut — **AND** B *did* receive the remaining members' N+1 rows (so the 0 is a true exclusion, not a federation miss) **AND** A actually minted N+1. Device-filtered, content-free, **WI-259-orthogonal**.

su-9140a implemented + ran it (su-ee7e9-reviewed). It **reached the K-stage** — proving the witness mechanics + the reframe both work — and **diagnosed the real live blocker, content-free**:

### WI-280 — the live re-key mints 0 epoch keys (root: the witness can't turn the flag ON in the sidecar — NOT the re-key code)
With the flag flipped (`/api/flags/set`) + a fresh build + a successful join, the owner minted **0** epoch keys. The root passed through FOUR *inferred-then-disproven* hypotheses before a verified one — a cautionary tale captured to mem0 as "the inferred-bug trap" (we kept reading code, ASSUMING a throw/behavior, never running it):
- ✗ `getHiveEpoch` assumed `=-1` (empty `[0..-1]` loop). DISPROVEN: it coerces unset→`BASELINE_EPOCH=0`; the loop runs.
- ✗ `sodium-native` assumed "unresolvable in the sidecar → the grant throws." DISPROVEN AT RUNTIME: it ships (in `NATIVE_PKGS` since June 1, with its linux-x64 `.node`) AND loads — `node -e "import('sodium-native')"` in the actual witness sidecar → **LOADED**, full crypto API. (3 agents had started a sidecar-build "fix" + 1 a native-addon-preflight change before the 30-second runtime load test killed the whole hypothesis.)
- ✗ the `PAPERCUSP_FLAG_*` env layer assumed unwired. DISPROVEN: `getFlag` (libs/flags/src/server.ts:211) calls `resolveEnvOverride` FIRST (highest precedence), and the env name it computes is *exactly* `PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY` — what the rig sets. (I made this one myself, ~10 min after writing the mem0 note warning against it — the trap bites everyone.)
- ✓ **VERIFIED ROOT** (c2a63's durable `rekey_grant_skipped` reason-trace + 328af's runtime): the grant early-returns `'flag-disabled'` — `getFlag(HIVE_REKEY,'system')` returns **false** in the admit-grant context. The re-key CODE is correct; the witness simply can't get the flag ON in the sidecar process. Both flag paths fail: the per-instance `PAPERCUSP_FLAG_*` env isn't reaching serve.mjs's `process.env` in `HIVE_SMOKE_MODE=sidecar` (the rig spawns serve.mjs directly), and the `/api/flags/set` fallback persists a **workspace-partitioned** PG override (flag-bus.ts:94-99) that the pot-boot's `getFlag` reads under a different workspace.

**Enforcement is live (separately):** AK owner-ban = **PASS** on the same run — the binary + moderation path work; only the re-key key-mint is gated (by the flag not being ON, not by any defect).

**The fix is the witness harness, not the re-key code:** forward the per-instance `PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY` into the sidecar serve.mjs spawn so `getFlag` sees it (su-9140a's rig — one line, per-instance + workspace-agnostic, satisfying the owner's "per-instance safe, never a global PostHog flip" constraint). Durable supporting work that landed regardless: c2a63's `rekey_grant_skipped` reason-trace (the 3 silent early-returns now name themselves — flag-disabled / no-fresh-members / no-author), 328af's `rekey_grant_failed` loud boot event (a throw is no longer swallowed), EI-1814 (a native-dep boot self-check guardrail).

**Result: ⏳ pending the witness flag-plumbing fix.** The grant logic, the crypto (`sodium-native` loads), the flag-gate, and the device-filtered witness are ALL verified-correct — the re-key implementation needed **zero** fixes. Once the per-instance flag reaches `getFlag` ON, the witness flips to a **green device-filtered K-CUT** in one run → findings-K green → the owner flips `papercusp-pot-rekey`. Net lesson for the next reader: hours of "the re-key is broken" dissolved into "the test harness couldn't set the flag," each wrong turn an inferred-not-verified root — when a root looks like "X can't load / Y throws", RUN it before fixing it.

### WI-280 CORRECTED — the real root was MEMBERSHIP-POPULATION, not flag-plumbing (2026-06-20, su-ee7e9 + the principal/role + 328af + dc9db)

The flag-plumbing diagnosis above was a *fifth* inferred-not-fully-verified root. With the env-flag forwarded into the sidecar (the rig's `REKEY_ENV`) **and** a fresh build, the live re-key **still minted 0 keys** — so the flag reaching `getFlag` was necessary but NOT sufficient. The principal/role traced the verified root by reading the call graph: **`hive_members` was never populated live**, so the grant wrapped to an EMPTY member set regardless of the flag. Two gaps:
- **No owner self-row at create.** `createHiveHarness` never registered the owner in `hive_members`, so the boundary's remaining-member wrap-set (`loadAllHiveMemberDevicePubkeys`) was empty → re-key could not advance.
- **No joiner upsert on open-mode auto-admit.** `upsertHiveMember` (which INSERTs the row AND grants) fired only via `approvePendingJoin`; the OPEN-mode auto-admit (boot.ts Seam-2) called the bare `grantEpochKeysToMembers` and never populated `hive_members`.

**THE FIX** (su-ee7e9 — 4 edits, type-clean, 19 hermetic tests green):
1. `_create.ts` step-6b: owner self-row via `upsertHiveMember` (raw-base64 devicePubkey, wrap-consistent).
2. `boot.ts` Seam-2: open-mode admit → `upsertHiveMember(joiner-from-frame)`, **plus** a `loadHivePubkey` FK gate — `hive_members` FKs `pots(workspace_id, home_slug)`, and the admit also fires on the MEMBER topic (no parent row) → gate to the pot-home owner box only (same self-gate the grant uses).
3. `pot-membership-store.ts`: the loud-signal superset — `rekey_grant_failed` (grant catch) **and** `rekey_grant_skipped` (result-check, `no-author` skip) emit from the single upsertHiveMember seam (a strict superset of the part-B admit-seam event: now fires on admit AND approve).

**PROVEN LIVE (de-confounding signal, GREEN):** a fresh-sidecar witness with the fix shows **A `members=1 epoch_keys=1` (was 0/0)** — the owner self-row mints **epoch-0 at CREATE** (getHiveEpoch=BASELINE_EPOCH=0 → loop `[0..0]`), exactly as the supervisor predicted; **K0-join-keys=PASS** (B has 1 wrapped key, via the approve path). The loud signal even caught a bug in its own author's edit — the member-topic FK violation surfaced as `[pot-rekey] open-mode admit upsertHiveMember failed`, loud not silent (now gated).

**K2 REVOKE — RESOLVED (the joiner never landed under the POT-HOME slug):** the live revoke returned `no_target` because B wasn't in `hive_members` under the pot-home slug. Root: the open-mode admit upserted under `opts.harnessSlug` — the MEMBER slug B joins via (the open-mode pot auto-admits, no pending-join, so the open-mode admit is B's SOLE registration path). The first redirect (`hiveHomeProjectionSlug`) was UNDEFINED at admit time (the owner's member boots on the gh topic *before* the pot rebind) → silently skipped → B unregistered (verified live: members stayed 1). Fix: resolve the pot-home via `hiveHomeSlugForHarness` (a fresh REGISTRY read: member → its hive_slug), so B lands under the pot-home → `loadHiveMemberDevicePubkeys(HIVE_SLUG, B)` finds it → `advanceEpochOnHiveBoundary` fires. (Also EI-1874: the owner self-row's best-effort FK-warn at create tripped vitest-fail-on-console — suppressed for the expected parent-missing case.)

**Result: ✅ GREEN K-CUT — the C-001 device-filtered read-revocation cut is PROVEN end-to-end (witness v3, 2026-06-20).** A `members=2 epoch_keys=2` (was 0/0); **K0-join=PASS(2) · K2-REVOKE=PASS (epoch 0→1) · K1-CONTROL=PASS · K3-CUT=PASS** (B's device has 0 epoch-1 keys = the cut; remaining-on-B=1 = remaining member crossed; A-new=1 = A holds the new epoch). Full WI-280 chain: owner self-row mints epoch-0 at create → joiner lands under the pot-home via the open-mode admit redirect → revoke advances → device-filtered cut. **Ready for the owner to flip `papercusp-pot-rekey`.** Two SEPARATE planes are still INCOMPLETE in the witness OVERALL but are NOT the cut: **AK-ban** (write-plane moderation — B's banned op still lands on A; B *is* now in hive_members, so this is its own write-plane enforcement bug, file separately) + **federate-A→B** (WI-259 content federation — the orthogonal scopedApply guard; c2a63's P-002 membership-aware guard is the fix). Net lesson — the *sixth-through-eighth* roots, each verified by RUNNING the witness + reading the DB rows, never inferred: `'flag-disabled'` masked the empty-wrap-set; the empty-wrap-set was two membership-population gaps; the joiner gap needed the REGISTRY resolver, not the boot-time projection. Verify to the BOTTOM — the minted-key count, the populated rows, AND the slug they're under — not the first plausible early-return.
