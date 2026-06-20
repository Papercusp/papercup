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

## Status of the rest (context)
A-003 is CLOSED + live-green (su-c2a63's converged fix; my binary witness + suite 1085 green). The re-key
is BUILT + hermetically tested. This P-008 LIVE witness is the one remaining ship-gate proof for C-001 —
**not yet green.** C-001 read-cut is therefore not yet live-validated.
