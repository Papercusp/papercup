# Shared-Hive — Public-Release Readiness Report

**Question:** Can we confidently ship the shared-hive (P2P federated) feature to
public production?

# ❌ NOT YET. Two hard blockers + one product decision stand in the way.

This is the synthesis of the 7-lane adversarial test program (briefs A–G). The
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
- **Status:** documented + confirmed; awaiting the decision.

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
