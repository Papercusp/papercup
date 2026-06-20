# Re-key (C-001) live cut-off witness — RUN RESULT (su-9140a, 2026-06-19 ~23:10)

**For the re-key witness owners (su-ee7e9 / su-313d1-K / the `shared-hive-rekey-2026-06-19` lane).**
I ran the P-008 cut-off witness that findings-K.md marks "⏳ pending the run." It came back
**INCOMPLETE** — it did NOT validate the cut-off. Details so you can close it.

## How I ran it
```
PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1 PAPERCUSP_SMOKE_DISPLAY=198 \
  bash papercusp-desktop/bin/two-instance-hive-from-repo-smoke.sh \
  /tmp/a003-rewitness/Papercusp_integrated.deb
```
`.deb` = fresh build from HEAD (8b90f93d9; carries mig-316 + the epoch code; B applied
`316-hive-epoch-keys.sql`). Box load ~26 (loaded). gh tokens for papercupai + aviynw present.

## Result: OVERALL INCOMPLETE (EXIT=6)
```
create=PASS announced=PASS discovered=PASS member-links=PASS join-offer=PASS join=PASS join-clone=PASS
federate-A→B=FAIL  federate-B→A=PASS  federate-continuous=FAIL
```
**It failed at the baseline `federate-A→B` merge (F-HIVE1) BEFORE reaching K0** — so the AK + K0–K3
cut-off steps never ran. No cut-off data.

## What's puzzling / needs your eyes
1. **A→B failed but B→A + the full join sequence PASSED.** The link is up (B→A `F-HIVE2` crossed). So
   it's an asymmetric owner→joiner merge failure on F-HIVE1 (a plain feature, not owner-content), OR a
   timing flake (40s probe on a load-26 box). My earlier CONTENT-MATRIX runs crossed features A→B fine
   — so this is from-repo-flow-specific or a flake.
2. **Flag engagement UNVERIFIED.** `a.log`/`b.log` (3400+ lines each) show ZERO epoch/encrypt/decrypt/
   op-gate/grantEpoch/advanceEpoch activity — only the mig-316 schema apply. Either the crypto runs
   SILENT, or `PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1` env didn't engage `getFlag(FLAGS.HIVE_REKEY,
   'system')` (flag-bus.ts:92 says PAPERCUSP_FLAG_* env IS layered, so it *should* — but confirm). If the
   flag was OFF, K3 would be meaningless anyway (no encryption → no cut).

## To close the witness (your call — it's your lane)
- Run on a QUIET box (federate-A→B 40s probe needs headroom; the discovery/federation timing flaked all
  session under fleet load — DISCOVERY_RETRIES helped the content-matrix; the from-repo probe may need a
  similar bump).
- VERIFY the flag actually engages (log an epoch line on boot when on, or assert K0 b_keys>0 early).
- If federate-A→B is a real from-repo owner→joiner gap (not a flake), that's a NEW finding parallel to
  A-003 — but A-003's content-matrix witness crossed features A→B, so suspect flow/timing first.

## UPDATE — 3 runs total, all INCOMPLETE; the blocker is from-repo DISCOVERY under fleet load
- **Run 1** (load 26): discovery+join PASS → `federate-A→B=FAIL` (pre-K0). 40s merge probe on a hot box.
- **Run 2** (load 19, no window bump): `discovered=FAIL` (120s).
- **Run 3** (load ~19, DISCOVERY_RETRIES=100→300s + MERGE_PROBE_SEC=120): **STILL `discovered=FAIL` at 300s.**
- **ROOT CAUSE of the discovery fails:** the from-repo flow runs **cupboard-disabled** (`Cupboard at
  127.0.0.1:9 unreachable → directory-only`), so B discovers A's hive via **directory-only DHT gossip**,
  which is UNRELIABLE under fleet load — 300s isn't "too short," the announce often just doesn't arrive
  (run 1 got lucky). NOTE: the CONTENT-MATRIX discovery path DID work at 300s (my A-003 witness saw
  rows=2) — so the two flows discover differently; the from-repo/cupboard-off path is the flaky one here.
- I extended BOTH smokes' discovery polls to honor `DISCOVERY_RETRIES` (content-matrix + from-repo) and
  the from-repo merge probe to honor `MERGE_PROBE_SEC` — committed, backward-compatible. But the gossip
  reliability, not the window, is the wall.
- **⇒ The P-008 re-key cut-off witness cannot be reliably completed on THIS loaded box.** To close it:
  run on a genuinely QUIET box (DHT gossip reliable) and/or with the **cupboard service reachable**, then
  the run reaches federate-A→B (now 120s) → K0–K3. This is the re-key lane's to finish; I've removed the
  window/timeout false-fails so a quiet-box run should reach the actual cut-off.

## 🔴 DEFINITIVE (run 4, direct PG query of the LIVE :204 instances) — THE FLAG NEVER ENGAGED VIA ENV
Run 4 got past discovery+join (gossip landed), so I queried A's + B's PG directly mid-run:
- **A `hive_epoch_keys` = 0; A epoch setting (hive_settings LIKE '%epoch%') = EMPTY.** If the re-key flag
  were on, the owner would have an epoch + epoch-0 key (and `grantEpochKeysToMembers` on B's join would
  have produced keys). A has NONE — and run-1's debug logs showed ZERO epoch/encrypt activity.
- **⇒ `PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1` (env) does NOT turn on the re-key on the packaged binary.**
  All 4 of my runs were FLAG-OFF — **the P-008 witness never exercised the re-key cut-off at all.**
- **The witness recipe in findings-K.md ("flag-on via env PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1") is
  INSUFFICIENT.** Before C-001 can be witnessed: enable the flag a way that actually takes (flags:set in
  PG / a startup assert that an epoch exists), and make the witness FAIL-FAST if A has 0 epoch keys at K0
  (right now a flag-off run silently fails at federate-A→B, masquerading as a federation bug). **This is
  the real blocker to validating C-001 — not a quiet box.** (flag-bus.ts:92 claims PAPERCUSP_FLAG_* env IS
  layered; either it needs a restart ordering the smoke doesn't do, or the sidecar doesn't inherit it —
  re-key lane to resolve.)

## 🟡 OBSERVATION (flag-off) — from-repo `federate-A→B` (member-harness feature) failed BOTH runs
`✗ A→B: F-HIVE1 never reached B` with **`F-HIVE1 drained=true` on A** (sent) but **B never APPLIED it**
(`harness_features_consolidated F-HIVE1 = 0` on B). B→A worked. So the from-repo JOINER does not apply the
OWNER's member-harness *feature* writes after join — even though su-ee7e9's from-repo witness showed
*hive-home* `hive_settings` crossing A→B. Reproducible (run 1 + run 4). NEEDS the federation team to
confirm real-gap vs known from-repo-vs-content-matrix flow difference (content-matrix crossed features
A→B fine). NOT confirmed as a defect by me — flagged for d2230/the federation lane. (My MERGE_PROBE_SEC=120
was iterations not seconds → made the failing probe ~7min; default 40 is fine for a fail-fast.)

## Status of the rest (context)
A-003 is CLOSED + live-green (su-c2a63's converged fix; my binary witness + suite 1085 green). The re-key
is BUILT + hermetically tested. This P-008 LIVE witness is the one remaining ship-gate proof for C-001 —
**not yet green.** C-001 read-cut is therefore not yet live-validated.
