# Shared-Hive — Public-Release Readiness Report

**Question:** Can we confidently ship the shared-hive (P2P federated) feature to
public production?

# ❌ NOT YET — but as of 2026-06-19 PM the path is a known, owned BUILD list (no open S0s, no unknowns).

> ## ⚡ CURRENT STATE — 2026-06-20 early AM (su-9140a, auto-mode overnight)
> Net change since the A-003 close: the **C-001 re-key read-cut is now decoupled from the last federation
> bug and provable on its own** — the strongest position yet. Specifics:
> - ✅ **A-003 CLOSED** (live + suite + CI-guarded — see below).
> - 🔴 **C-001 re-key cut — WITNESS PROVEN, but BLOCKED on WI-280 (re-key doesn't engage live).** UPDATE (su-9140a,
>   later 06-20): the witness was rebuilt **content-free** (ee7e9's reframe — K0/K1/K3 read `hive_epoch_keys` only,
>   device-filtered by the A-side epoch member-diff), ee7e9-approved + committed, and **RAN to the K-stage on a live
>   from-repo run** (run 2 won the discovery coin-flip). So the witness itself is DONE + proven. BUT it diagnosed the
>   real blocker → **WI-280**: the live re-key **mints 0 epoch keys on the owner** (A `epoch_keys=0, members=0`) even
>   with the flag genuinely flipped + a successful join. Root (code-traced): (1) no epoch-0 mint on CREATE
>   (`advanceEpochOnHiveBoundary` is boundary-only); (2) `hive_members` stays empty live (open-mode skips
>   `approvePendingJoin`; no owner self-registration) → nothing to wrap keys to. The hermetic tests SEED hive_members,
>   so the re-key is hermetically-green but **live-red — the 3rd green-rig/red-binary bug** (A-003, WI-259, WI-280).
>   ⇒ C-001 is NOT live-validatable until WI-280 is fixed (re-key owners c2a63/ee7e9 — their domain; precise fix
>   surface in WI-280). The device-filtered witness flips GREEN the instant the owner mints keys. **AK owner-
>   enforcement BAN = PASS live** (the launch-required ban has real teeth); the content-based AK probes share the
>   same membership-gap blocker.
>   - 🟡 **UPDATE (su-9140a, 06-20 08:20) — WI-280 FIX PROVEN at the membership layer → C-001 cut NEAR-RESOLVED.**
>     ee7e9's v2 fix lands `hive_members` with BOTH rows live (owner self-row mints epoch-0 at create; joiner lands
>     under the hive-home via a fresh `hiveHomeSlugForHarness` resolver at the open-mode admit — the v1 silent-skip
>     was `hiveHomeProjectionSlug` undefined at admit, pre-hive-rebind, EI-1876's class). `members=2, was 1`
>     (verified live in A's PG mid-witness). So `loadHiveMemberDevicePubkeys` now finds B → the revoke boundary
>     mints + advances the epoch → the K-CUT should go green. ee7e9 is running witness-v3 for the K2/K3 verdict and
>     will ping the owner for the flag on green. The root I code-traced (2 membership gaps) + the gotchas I handed
>     ee7e9 (upsert-BEFORE-grantEpochKeysToMembers; verify-AFTER-a-boundary since there's no create-mint;
>     loud-signals-on-skip) all landed. ⇒ C-001 flips 🟢 the instant v3's K-CUT is green; updating here on that verdict.
> - 🔧 **WI-259 (NEW, from-repo joiner federation) — root-caused 3 ways (su-9140a/c2a63/ee7e9), dc9db fixing.**
>   The D-021 scopedApply harness_slug guard: a from-repo joiner gets a DIFFERENT member slug than the owner, so
>   the owner's harness_features (member-harness content) ops are silently guard-dropped on the joiner (hive_settings
>   escapes — it's hive-home-remapped). ALSO the owner never admits the from-repo joiner (gh:<repo_id> topic
>   fallback, no hive_pubkey → rekey() can't switch topics). SHIP-RELEVANT for from-repo joiners (separate from
>   C-001, which is decoupled). Fix = stamp hive_pubkey on the joiner binding + remap content-projection slug.
> - ⚠ **Owner-enforcement = a CONFIRMED LAUNCH REQUIREMENT** (owner decided 2026-06-20). EN-1..EN-4 built+green
>   (su-328af); the live AK enforcement witness rides the same rig as the C-001 cut (also slug-gated by WI-259 on
>   from-repo; provable on the discovery rig).
> - 🛠 **WI-261 (NEW, su-9140a): live-federation gate built** (papercusp-desktop/bin/live-federation-gate.sh) —
>   a load-gated scheduled run of the two-instance smokes that files an EI on RED, to catch the green-rig/red-binary
>   class automatically (A-003 + WI-259 were both green hermetically, red live). v0 built; needs a quiet-box validation
>   + durable scheduling (su-fa300's infra lane).
> - 📋 **Coverage scope (su-9140a, 06-20): moderation + cross-hive federation are UNWITNESSED live.** The 5 two-instance
>   smokes (federation/merge/directory/content-matrix/from-repo) + the WI-261 gate cover the CONTENT-federation surface
>   only. They do NOT exercise **moderation** (takedown/report) or **cross-hive** (ask/request_work/grant). Those carry
>   unit + PG-integration tests only (logic/schema/state-machine — 0 substrate-boot markers on the sampled
>   moderation/policy tests), so their live 2-peer DELIVERY has the SAME green-rig/red-binary risk as A-003/C-001/WI-280.
>   Only **AK ban = witnessed live**. ⇒ a live witness of takedown-federation + cross-hive ask/grant delivery is a
>   release-readiness gap to close before 🟢 **iff in v1 public-release scope** (cross-hive between distinct hives may be
>   post-v1 — scope UNCONFIRMED, pending a peer consult). The takedown/report leg rides the existing 2-instance rig;
>   cross-hive needs a NEW 2-HIVE rig. This is a coverage gap, NOT a newly-found bug.
>   - **UPDATE (WI-283, 06-30): the moderation witness is now BUILT** — `two-instance-hive-from-repo-smoke.sh`
>     `MODERATION_PROBE=1` rider: **LEG 1 takedown** (owner A `hive:takedown` → assert B receives the owner-signed
>     `hive_policy.moderation.takedownList` origin=remote, policy_version bumped, ref present) + **LEG 2 report** (member
>     B `hive:report` → assert it federates to A's `hive_reports` moderation queue origin=remote; reportable enabled via a
>     seeded-claim → signed policy route). Both legs ride the A-003-proven hive-home-grained tables, so no C-001/WI-280
>     dep. Static-verified (bash -n + real schema/tool refs); **the only thing still pending is the live green-rig run,
>     which remains box-headroom-gated** (runbook <~load 12; box storm-saturated). Run:
>     `MODERATION_PROBE=1 papercusp-desktop/bin/two-instance-hive-from-repo-smoke.sh` when the box is quiet.
> **Net:** every blocker is found, filed, owned, and root-caused; C-001 sign-off is decoupled from the from-repo bug
> and gated only on a quiet-box witness run. Remaining witness scope beyond C-001 = the moderation/cross-hive coverage
> row above (iff v1-scoped). Lower section is the prior synthesis.

> ## ✅ UPDATE — A-003 CLOSED (2026-06-19 PM/eve, su-c2a63 + su-ee7e9 + su-53f39 + su-690fe)
> The A-003 line in su-9140a's block below is SUPERSEDED. A-003 (`hive_members`/`hive_settings`
> federate to a joiner) is **CLOSED**, three independent ways:
> 1. **Live-witnessed green on the binary** — su-ee7e9 ran the FROM-REPO join
>    (`two-instance-hive-from-repo-smoke.sh` + a new opt-in A003_MEMBERSHIP_PROBE), and
>    `hive_settings` crossed owner→joiner (backfill=2 + incremental, origin=remote). Prior
>    content-matrix RED witnesses were the WRONG flow (discovery-join never engages the hive-home
>    binding; it also died at a stale `{hiveId,memberLinks}` join contract). See
>    `findings-A003-GREEN-witness-2026-06-19.md`.
> 2. **The fix is RECEIVE-side, not send-side** — su-9140a's onAnnounce BUFFER (a hive-home
>    announce racing in while the joiner's home slug is unresolved is held, not conclusive-rejected)
>    + `retryPendingOnce` slug-scope re-check + the rekey rebind. su-53f39 re-landed it VERBATIM from
>    `0d2067204` (after a boot.ts rewrite, 3bce97bf7, briefly reverted the buffer) + added fix-c
>    (immediate replay-on-rebind, a ≤5s latency win) + a `joinerHiveHomeSlugOverride` test seam.
> 3. **Pinned in CI** — a new deterministic, hermetic regression test
>    (`packages/operator-core/lib/sync/hyperbee/__tests__/a003-scope-buffer-replay.test.ts`) is
>    teeth-verified (RED on the buffer revert → GREEN on the fix) and runs in the green-checkpoint,
>    so the buffer can no longer silently regress out. (It was the ONLY guard that caught the revert
>    — the rest of the suite stayed green through it.) Corroborated by su-690fe's pre-gate on committed
>    HEAD 366a4072a (a003-scope-buffer-replay + admission-pending-retry green; EN-4 + backbone 1076 green).
>
> NET: A-003 was the last live-RED federation blocker. With it closed, the receive/merge/projection
> federation path the **C-001 re-key (Move 2)** rides is proven. Optional belt-and-suspenders: a fresh
> full-`.deb` HEAD re-witness (byte-identical fix-b + suite-covered fix-c) if the owner wants it.

> ## CURRENT STATE (2026-06-19 PM, su-9140a — supersedes the A–G synthesis below)
> Live-witnessed on the **real packaged binary** this session (see
> `ROLLUP-continuation-2026-06-19.md` + `findings-LIVE-WITNESS-INTEGRATED-2026-06-19.md`):
> - ✅ **D-001 (the S0) — FULLY CLOSED, code + LIVE.** Federated LWW converges under real
>   clock skew on the shipped binary (Migration 314 `fed_hlc` HLC-of-record + write-time HLC).
> - ✅ **A-001** boot, **A-002** multi-hive no-stall, **core federation** (8/11 bidirectional),
>   **N** scale/churn, **G-001/G-002** honesty (live), **G-004** status surface (live) — all GREEN.
> - 🔧 **A-003** — root-caused LIVE to a **SEND-side gap**: the owner's hive-home harness never
>   federates its own `hive_members`/`hive_settings` (outbox not drained, not on the topic) =
>   su-963ee's Move-1 "increment 2". (The receive-side rebind is correct.) Fix in progress (d2230).
> - 🔴 **C-001 read-revocation — OWNER DECIDED: RE-KEY** (cut reads on member-remove/go-private).
>   Now a REQUIRED BUILD = **Move 2** (epoch group key + content encryption; `brief-REKEY-c001-move2.md`),
>   owned by ed300 (crypto foundation) + K (boundary/distribution/live-cutoff witness). The
>   critical-path-to-release item. One open sub-decision for the owner: MLS/TreeKEM vs per-epoch wrap.
>
> **ROADMAP TO GREEN (2 layers, one thread):** (1) complete **Move 1** — wire the hive-home harness
> to federate (fixes A-003 + lays the substrate); (2) build **Move 2** — the C-001 re-key on top.
> The test program is complete; everything testable is GREEN; what remains is this build + its live witness.

> ## OWNERSHIP + CODE-PLANE (owner questions 2026-06-19 — verified design-vs-impl, 2 research agents)
> A dimension the A–G + waves program did NOT explicitly cover. Findings:
> - ✅ **Provisional→claimed ownership — BUILT end-to-end.** Creator = provisional owner, hive starts
>   `unclaimed`; the GitHub-`maintain`/`admin`-verified true owner claims it (`unclaimed→claimed`) via a
>   live permission check. Full stack: `shared_repo_binding_cache.claim_status`, `binding-service.ts`
>   (`createUnclaimedBinding`/`claimBinding`/`supersedeBinding` + 24h re-verify daemon), routes
>   `/api/harness/:slug/claim-status` + `/binding/claim`, GUI (`ProvisionalOwnerExplainer`,
>   `HarnessClaimHeader` Claim CTA, `ClaimStatusBadge`), tests. Plans: `papercusp-dogfood-v5` §15/§5.1,
>   `dogfood-design-memo-binding-service-api`, phase-8 P-068/P-069.
> - ❌ **GAP (release consideration): a claimed owner has NO enforcement-settings lever yet.** The claim
>   gives a trust *badge* ("repo-authoritative"), but the "owner sets rules the hive enforces (rate
>   limits, contribution rules, spam controls)" capability is **deferred to Phase 12+** (v5 Q-1/D-023),
>   never built. For a PUBLIC launch where spam is the concern, this is the lever that's missing —
>   claiming proves *who* the owner is but not yet *what they can enforce*. **Owner decision needed:** is
>   Phase-12 enforcement a public-launch requirement, or ship claim-as-trust-signal first?
> - ✅ **Code-plane contribution safety — BUILT + proven live.** Two paths by upstream permission:
>   collaborator-with-write git-syncs DIRECTLY to upstream `main`; non-collaborator (`push:false`) NEVER
>   direct-pushes — code reaches upstream via fork→cross-fork PR under the CONTRIBUTOR'S OWN account
>   (`ensure-fork`/`open-fork-pr`/`fork-pr-on-feature-pass`, lazy at feature-pass; proven live:
>   `aviynw/js_cols/pull/1`). NOTE: it's the contributor's own fork, NOT a Papercusp-owned staging fork
>   (a divergence from the original mental model; D-007 — arguably cleaner; security goal still met).
>   Plans: `non-collaborator-join-fork-pr`, `hive-from-github-url` D-005, `git-sync-any-hive` D-002/D-008.
> - ✅ **Dogfood:** papercup IS the original `system:git-sync` member (same routine/code, generalized to
>   all hives via `git-sync-any-hive` Phase 2); the whole-tree commit+push background routine = this exact
>   system. papercup syncs as the privileged owner (direct push). `platform:enable` productizes the
>   self-hive (`papercusp-platform`) for downloaders.
> - 🔧 **TEST GAP → Brief AH:** the code-plane (collaborator direct-push + non-collaborator fork→PR + the
>   S0 "non-collaborator can't direct-push main" invariant + EI-382 link-join-no-sync) is NOT in the
>   systematic release-test program — the PIECES have unit/integration tests + a live proof, but no E2E
>   release lane. `brief-AH-code-plane-git-sync-to-main.md` (handed off) closes it.

---
### Earlier synthesis (A–G program, now partly superseded by the live results above)
This was the synthesis of the 7-lane adversarial test program (briefs A–G). The
testing is **complete and converged** — it found and characterized every blocker.
What remains is **not more testing**; it's a small set of human/engineer actions.

---

## The blockers (in priority order)

### 1. D-001 — peers DIVERGE under clock skew (S0, the hard one)
- **What:** federated LWW does not converge when peer clocks are skewed (the
  *normal* case across independent machines). The merge fold orders by **HLC**,
  the PG projection guard orders by **`fed_ts`**; the recv-seam advance makes them
  disagree, so two honest peers reach `fixedPoint=true` on **different values**.
- **Evidence:** `convergence-fuzz.test.ts` `it.fails('S0 (D-001): the skew sweep
  MUST fully converge — it does not')`; insight doc reopened
  (`hlc-merge-vs-fed-ts-guard-divergence.mdx`).
- **Needs:** an **engineer** — and the design space is now narrowed to ONE viable
  fix (lead-investigated 2026-06-19): the LWW key must be **HLC-of-record in PG**.
  The tempting shortcut (make the merge order by `fed_ts`/`ts` instead of HLC) is
  **RULED OUT** — HLC's recv-seam is load-bearing: it provides *causal ordering*
  (a write that observed a remote op is ordered causally-after it, not by raw
  wall-clock; `hlc-stamp.ts` P-010), which `fed_ts` cannot. So the fix is the
  bigger one: **store the HLC on every federated row + change every projection's
  `ON CONFLICT … WHERE EXCLUDED.fed_ts >= stored.fed_ts` guard to compare the HLC
  tuple (physical, counter), with back-compat for pre-P-010 rows that have no
  HLC.** A migration + all-projections change. NOT safely draftable by the test
  loop. Gate the fix on the skew sweep going green + monotone staying green + the
  full federation suite (862 tests) staying green.
- **Status:** open, untouched (no edits to `projection.ts`/`hlc-stamp.ts`).

### 2. C-001 / E-R1 — revocation is WRITE-ONLY; removed members keep READ (S1, S0-potential)
- **What:** removing a member (or flipping a hive public→private) stops their
  WRITES and DISCOVERY but NOT their READS — a prior pubkey-holder can rejoin the
  topic and keep reading all new content (immutable identity, unconditional
  replication, firewall on the wrong key space, no re-key). Empirically confirmed
  by a passing test (`federation-adversarial` C-001 case).
- **Needs:** a **product decision** — must "remove member"/"make private" cut READ
  access? If yes → re-key/evict (real fix). If no → document loudly + honest UI.
- **Status (updated — Brief K, su-313d1):** **DECIDED — option (d)** (document +
  honest UI; real cutoff = roadmap, DESIGN Move 2). Both legs now witnessed LIVE on
  the real `.deb`: public→private (Brief E) **and member-remove (Brief K)** — a
  genuine `revokeHiveContributor` of the member's REAL device key (authorized via the
  owner's **superuser bearer**, which elevates past Brief E's `unverified-loopback`
  403) returned `{live:false}` and the removed member still read new owner content
  (`origin=remote`). Guards: integration `federation-threat-model` (C-001) + new
  static `hive-revoke-contributor.live-gap.test.ts` (K-1, teeth-verified). See
  `findings-K.md`.
- **Brief K also surfaced two NEW defects (filed; compound A-003 → toward S0):**
  **K-1** the Hive-scope revoke is `live:false` — PG-write-only, no live `h.revoke`
  (harness-scope does); **K-2** the revocation never federates to the joiner (P-004
  peer-log publish unwired) — so member revocation is broken on BOTH planes for
  joiners (read-not-cut + revoke-record-not-delivered). Fix = Move 1 (federate the
  revoke record, Brief I) + P-004 live-revoke wiring; READ cutoff = Move 2.

### 3. A-001 — the `.deb` didn't boot (S0) — ✅ FIX VERIFIED (lead re-built the sidecar)

> **UPDATE (lead, 2026-06-19): A-001 fix EMPIRICALLY VERIFIED.** The lead re-ran
> `build-desktop-sidecar.sh` (the 04:25 fixed script): `copy_pkg_closure luxon`
> copied luxon's **full 41-package closure, 0 missing**, into the sidecar
> (`src-tauri/sidecar/node_modules/luxon` confirmed). So the sidecar the `.deb`
> bundles now resolves `createRequire('luxon')` → it boots. The fix is correct.
>
> **UPDATE 2 — `.deb` BUILT + VERIFIED.** Despite the box contention (the build
> stalled/recovered repeatedly), the `tauri build` completed: a new `.deb` (05:33,
> 930MB) at `/home/marsh-office/.cargo-target/release/bundle/deb/Papercusp_0.0.2_amd64.deb`
> **bundles luxon — 49 `sidecar/node_modules/luxon` entries** (independently
> verified via `dpkg-deb`). The `Cannot find module 'luxon'` crash is fixed
> end-to-end. **A-001 is CLOSED on correctness + artifact.** The only thing left
> is a real boot-launch, which is the live lanes' (A/E/G) job — and they now have
> the bootable `.deb` to do it.

- **What:** the shipped `.deb` crashed at boot (`createRequire('luxon')` not
  bundled). **Lane A fixed it** — `copy_pkg_closure luxon` in
  `build-desktop-sidecar.sh` (04:25), the same proven mechanism that ships
  `rrule`. High-confidence fix.
- **Needs:** a clean `.deb` rebuild to mechanically re-verify the boot. The
  rebuild is currently **wedged on cargo-lock contention** (persistent `npm run
  dev` shells share `CARGO_TARGET_DIR`). Workaround: build with an isolated
  `CARGO_TARGET_DIR`, or stop the contending shells first.
- **Status:** effectively resolved; verification blocked by infra, not by code.

### 4. A-002 / A-003 — live-E2E federation bugs (S1, NEW — found on the real `.deb`)
The live multi-instance pass (Lane A, on the rebuilt `.deb`) surfaced two real bugs
the automated suite missed because they only manifest on the live multi-hive/joiner
path:
- **A-002 (S1):** an instance hosting **2 hives stalls federation entirely** (both
  directions). Multi-hive-per-instance is broken.
- **A-003 (S1):** `hive_members` + `hive_settings` **do NOT federate to a joiner**.
  REAL (member-list + settings don't reach joiners). **But the "compounds
  revocation" framing is CORRECTED (lead/Brief C):** the revocation blocklist lives
  in **`contributors.revoked_pubkeys`** (`load-revoked-pubkeys.ts:33`), NOT
  `hive_members` — and `contributors` federates via a *different* (log-first) path.
  The A-003 CDC gap is **specific to hive_members/hive_settings** (every other CDC
  table — features, plans, … — federates fine), so it is NOT a general "owner logs
  don't reach joiners" failure and does NOT, by itself, break revocation propagation.
- **Revocation-propagation gate — A-003 DOES compound revocation (lead/Brief C,
  CORRECTED).** I initially mis-scoped this to `contributors` only; there are TWO
  revocation seams and the boot admission union reads BOTH (`boot.ts:573`
  `loadRevokedPubkeys`←`contributors`, `boot.ts:586` `loadRevokedHivePubkeys`←
  `hive_members`). **The revoke-MEMBER action writes to `hive_members.revoked_pubkeys`**
  (`hive-revoke-contributor.ts:8`, single-writer). Since A-003 shows `hive_members`
  does NOT federate to a joiner, **a hive-member revocation never reaches the
  joiner's admission union → the joiner keeps admitting the revoked member's writes.**
  Combined with C-001 (revoked member keeps READING), revocation is broken on BOTH
  planes for joiners: the revoked member keeps reading AND new peers never learn
  they're revoked. **This elevates the revocation story toward S0** for a public
  release. (Lane A flagged it as "MULTI-SWARM ONLY by design" — but the design then
  cannot deliver member revocation to joined peers, which is the product question.)
  Fix: federate `hive_members` (the admission/revocation record) to joiners, OR
  route member revocations through the log-first `contributors` seam that does.
- Net: **8/11 content types federate** live; single-hive create→publish→join→
  federate is GREEN. Multi-hive (A-002) + member/settings (A-003) are the live S1s.

### 5. G-001 — `reachablePeers` is topic-blind (S2, → S1) — small fix
- **What:** publish over-reports reach (counts peers on any topic, not the hive's)
  — a regression of the "deceptive-publish" honesty class.
- **Needs:** a small lane-G code fix. Not a release-stopper on its own.

---

## What IS solid (release-positive)

- **B (data-completeness): GREEN.** Every federated table has a producer + a
  projection; the silent-column-drop class is now CI-guarded; the one real drop
  found (issue `severity`, B-001) was fixed this session. `trusted_authors`
  correctly stays local (B-005).
- **F (resilience/recovery/scale): GREEN.** No S0/S1; reconnect, backfill,
  outbox-failure, stale-reclaim all hold; regression guards added.
- **Federation core:** 862 hyperbee tests green (only the 2 documented S0
  `it.fails` remain). No regressions across all concurrent agent work.
- Security breadth (C #2/#3/#4/#6): admission gate, write-revocation, forged-sig
  rejection, and malformed-op/DoS resistance all verified.

---

## Path to GREEN (the actual to-do list)

1. **Assign an engineer to D-001** — make the ordering-key architectural call,
   implement + migrate, gate on the skew sweep going green + the full federation
   suite. **This is the critical path.**
2. **Make the C-001/E product decision** — read-revocation: real cutoff or
   documented limitation + honest UI.
3. **Unwedge + rebuild the `.deb`** (isolated `CARGO_TARGET_DIR`), boot-verify
   A-001.
4. **Land the small G-001 fix** (topic-aware reachablePeers).

When 1–3 are done (and 4 lands), re-run the skew sweep + the live multi-peer E2E
on the rebuilt `.deb`; if both are green, this report flips to ✅.

_Maintained by the lead. The test program is complete; the remaining work is
engineering + product decisions, not test cycles._
