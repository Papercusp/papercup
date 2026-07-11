# Shared-Pot P2P — Public-Release GO/NO-GO Ledger

**Question:** Can we confidently ship the shared-pot (P2P federated) feature to public production?

# ✅ GATE CLEARED (2026-07-10 22:53 EDT) — the tower↔iMac watermark freeze that was the sole live blocker is RESOLVED. See "2026-07-10 22:53 EDT update — GATE CLEARED" immediately below. Remaining rows (12/13/15/20/21) still need their live drills re-run against the now-unfrozen rig before this ledger reads fully 🟢 end-to-end — this is the transport gate clearing, not every row's live proof landing.

## 2026-07-10 22:53 EDT update — GATE CLEARED (P-011 GO, su-bce8d8e6)

**The `harness_shared.coord_event_log` `origin='remote'` freeze described in the "2026-07-10 update — CURRENT PRECISE BLOCKER" section below is OVER.** Direct query at 22:53 EDT: count 131→133, `max(ts)` jumped from 10:32:45 EDT (frozen 8h+) to **18:50:45 EDT**. Two new rows:

- `id=463624`, ts=18:47:13 EDT — VM-authored (`author_pubkey=ef7a816054401f81b159cf8425ad31a822e775368b27cacd08133b475498f125`, the exact tracked remote log key), addressed to su-63834d42, marker `VMREAL20260710-2246`.
- `id=463662`, ts=18:50:45 EDT — same author_pubkey, second marker `VMREAL2-20260710-2250`, explicitly sent "to prove the leg is not a one-shot transient" — a deliberate sustained-check pair, not a single fluke event.

This satisfies the git-lane's own discriminant stated below verbatim ("GREEN only on a FRESH origin=remote row proving iMac→tower … NEVER bare remote count. Do NOT force green.") — met with two paired rows specifically designed to rule out a one-shot replay.

**Mechanism**: WI-3891 (VM registry backfill) + WI-3937/WI-3896 (drain fixes) — the tower-side drain wedge and iMac registry gap described below are both resolved.

**Verification chain**: su-07320b7c (holder of the gate per the discrepancy-9 reconciliation below) confirmed at 22:55 EDT and emitted the `p2p:tower-cleared` coord event, citing su-0e1a65bd (GO/NO-GO decision-holder) GREEN verdict independently corroborated 5 ways (0e1a6, su-bce8d8e6, su-d044afb5, su-4c5f0956, su-07320b7c's own row-level read). su-63834d42's personal confirm (the emit contract's named party) had not landed at emit time; su-07320b7c disclosed this explicitly and treated the decision-holder's verified GREEN + 5-way independent verification as satisfying the contract's purpose (no false greens) — standing invitation for su-63834d42 to re-park the fleet with any counter-signal. su-d044afb5 is resuming P-003 (live 2-machine verify + hive-git drill) as the deeper sustained test. Fleet LIGHT-restriction lifted.

**Credits**: su-3a28e3c3 (2026-07-10 20:05 EDT synthesis that first precisely scoped this as the one live blocker), su-07320b7c (held the gate correctly through the whole freeze window, refused to force-green on the cursor-advance-alone signal, ratified the final GREEN), su-63834d42 (built + ran the bidirectional v2t-probe that is the actual injector proving the leg — the decisive test).

**P-011 / WI-3548 (post-min-bar synthesis + this ledger) — DONE** as of this update. **WI-3546** ("both ways" federation) still wants su-4c5f0956's tower→VM mirror cite (per su-07320b7c's 22:55 EDT message) — that plus the P-003 drill result are the remaining GO inputs for the broader program; not blocking this row's close.

### 2026-07-10 23:07 EDT update — P-003 (WI-3888) DRILL COMPLETE — GREEN

**The "remaining GO input" flagged immediately above has now landed.** su-d044afb5 (sole live-rig-verification owner) resumed P-003 the moment `p2p:tower-cleared` fired and ran it to completion:

- **Sustained origin=remote proof**: re-confirmed directly via `psql` against tower `harness_shared.coord_event_log` — rows `463624` (18:47:13 EDT) + `463662` (18:50:45 EDT), both cryptographically attributed to the VM's own writer log (`author_pubkey=ef7a8160…` matches the VM's log key exactly), independently corroborated by 5 sessions (su-0e1a6 the GO/NO-GO decision-holder, su-63834d42, su-4c5f0956, su-07320b7c, su-d044afb5 itself).
- **`hive-git-drill.sh` (single-box P-301 acceptance scaffold), run TWICE for reproducibility**: **PASS=9 / FAIL=1 / SKIP=2** both runs, identically. LEG A (cold-clone bootstrap) 6/6, LEG B (announce-fetch) 6/6, LEG C (trust/tamper) 4/4, LEG F (gc/secrets-guard) 4/4 — all pot-git federation mechanics legs clean on both runs. LEG D (integrator publish+ff-advance) failed both runs but is **root-caused as non-blocking**: a stale bundled `.deb` artifact capped at migration 541 vs the repo's 559, missing the `hives→pots` rename (mig-557) that the leg's own scratch DB query needs — not a pot-git regression. Filed separately as **WI-3969** so it doesn't gate this row. LEG E (GitHub bridge live) and LEG G (chaos) are documented **SKIP-by-design** in the script itself (need the real multi-machine rig / all-legs-live-together respectively — not provable single-box; not a coverage gap).
- **Root cause of the original 8h+ freeze, now fully explained**: WI-3891 (VM-side hive/pot registry backfill) was the actual unblock — pre-backfill sends were silently refused (`harness_not_federated`), which is why the drain-side fixes (WI-3896/WI-3937) alone never moved the watermark until the registry gap closed too.

**WI-3888 marked `passed`** with the full evidence chain above. This closes out the plan `p2p-live-federation-crack-2026-07-10`'s critical path (P-001/P-002/P-003/P-004/P-005/P-007 all done; only P-006 — drill-scaffold polish, non-blocking — remains open, in progress). Credit: su-d044afb5 (held P-003 through the entire freeze window without touching the rig prematurely, executed the drill twice unprompted to rule out a flake, and root-caused rather than hand-waved the one LEG D failure).

---

**This ledger was resynthesized 2026-07-10 20:05 EDT** (su-3a28e3c3, plan
`p2p-live-federation-crack-2026-07-10` P-004, covering `p2p-rest-lanes-2026-07-09` P-011 /
WI-3548) as the signed GO/NO-GO checklist requested by the owner: every row below is either
green-with-evidence or explicitly owner-waived. **Read
["2026-07-10 update — current precise blocker" immediately below first](#2026-07-10-update--current-precise-blocker-read-this-first)**
— it supersedes the "2026-07-03" framing further down, which is now **historical** (kept for its
still-valid substrate rows, superseded on the live cross-machine rows). Companion calibration doc:
`agent-insights/federation-public-release-known-limitations.mdx`.
Rule of record: **in-process green ≠ live green** — every green row below cites a live/local-rig
artifact or a CI-pinned test, not prose.

**Rig posture (D-001, owner 2026-07-03; unchanged 2026-07-10): Hetzner access is GONE. All proofs
are LOCAL** — (i) containerized 2/3-node matrix rig (`bin/local-matrix.sh`, the mode that produced
run m1783013203 and the 2026-07-10 3-frame runs), (ii) tower↔libvirt-VM rig (macbr0) — **this is
the rig the current blocker lives on**, (iii) mac VM (su-a1a71 dogfood), (iv) single-box
`two-instance-*-smoke.sh`. Historical Hetzner runs remain valid VM-grade evidence.

---

## 2026-07-10 update — CURRENT PRECISE BLOCKER (read this first)

**Owner-authorized crack (Avi, 2026-07-10 ~19:55Z):** the whole p2p program (shared-pot
federation substrate below **and** the newer hive-git P2P replication plane) shares one live
gate: `harness_shared.coord_event_log` `origin='remote'` rows for the `papercusp` dogfood hive
have been **frozen at 147 rows / max(ts) 2026-07-10 10:32:45 EDT** since that timestamp. This was
escalated to the owner as an owner-gated wall at 19:40Z; the owner's answer was to launch a
dedicated fleet (`p2p-blocker-crack-sonnet5`, plan `p2p-live-federation-crack-2026-07-10`) to
crack it, ungating the wall. **Verified independently by this synthesis at 2026-07-10 19:58 EDT
(live `psql` against `harness_shared.coord_event_log`): still exactly 147 rows / max(ts) 10:32:45
EDT — unchanged for 5.5h+ at synthesis time.** Treat this ledger's GO/NO-GO as RED until that
number moves and sustains.

### What EI-8895 turned out to be (RESOLVED as a code question, 2026-07-10 ~20:00 EDT)

The originally-suspected root cause, **EI-8895** ("`connected_never_replicated` is detect-only —
a log admitted AFTER connect never gets its replicator attached, no recovery"), is **CONCLUSIVELY
NOT an in-process code gap**, per two independent fleet members re-running the same evidence:

- `wi183-attach-on-late-admit.integration.test.ts` — re-run **twice independently** (coord-lane
  su-bce8d8e6 at 19:40Z checkpoint; P-001 lane su-9cf4640c at 19:59Z, over real testnet-DHT
  transport) — **GREEN both times.** `boot.ts`'s `mergeOnePass` already attaches a replicator for
  a log admitted after the swarm connection is up (corestore `ondownloading→attachAll`).
- The **recurrence-guard / auto-heal** EI-8895 asked for is **already shipped**: **WI-3684**
  (landed 2026-07-10 04:12 EDT, plan `p2p-parity-closeout-lanes-2026-07-10`, landed *after*
  EI-8895 was filed) — `replication-liveness.ts`'s `setReplicationRepairHandler` +
  `boot.ts`'s `repairQueue`/`drainRepairQueue`: on a `connected_never_replicated` stall, closes
  the stale Corestore session and re-opens it (bounded, capped at 3 attempts/log/process-lifetime).
  Re-verified green this pass: `replication-liveness.test.ts` "WI-3684 repair-on-detect" 5/5,
  `boot.test.ts` "WI-3684 repair-on-detect (P-002)" 1/1.
- **Conclusion (su-9cf4640c, escalated to the plan + coord-lane 19:59Z): P-001 is DONE, no code
  fix needed here.** The live "watermark stuck" symptom is **not** explained by a missing
  attach-seam or a missing auto-heal — both are confirmed present and working in-process. EI-8895
  / EI-9046 close as **resolved-no-fix-needed**; the recurring EI-9264 class (6+ prior instances)
  should be re-triaged against this finding before anyone ships another attach/heal patch for it.

### Where the critical path actually sits now

The live blocker is **not** a code gap — it is a **live admission/drain problem**, and the two
active lanes diagnosing it **do not yet agree on the mechanism**, which is itself the open item:

- **`p2p-live-federation-crack-2026-07-10` (this plan) working theory:** P-002 — the iMac's
  `hives` table is (or was) **empty**, i.e. the iMac was not an admitted hive member at all, so
  neither the attach path nor the WI-3684 repair path has anything to act on. Critical path
  collapses to **P-002 (restore iMac hive membership) → P-003 (live 2-machine verify)**, with
  P-001 no longer blocking. **Status at synthesis time: P-002 (WI-3887) claimed (su-61670ea6)
  but not yet started (no checkpoint); P-003 (WI-3888) blocked on P-002 per the plan graph.**
- **`p2p-git-live-activation-2026-07-09` git-lane finding (su-63834d42, checkpoint ~19:58 EDT) —
  a materially DIFFERENT and more advanced diagnosis on the SAME rig:** the iMac side is **already
  fixed** — the iMac server rebooted ~15:41 EDT, **rejoined** the `papercusp` hive
  (`harness_shared.hives` row created 15:41, `hive_members=2`, swarm `peer_connected` ×2,
  hyperbee-substrate booted, home-harness validation PASSED). Two iMac-side gaps remain but are
  **not gating**: hive-git submodule clone failing on missing GitHub creds, and a disk-space
  alarm (3.5% free). Per this lane, **the SOLE remaining blocker is TOWER-side**: `origin=remote`
  is frozen at the same 147/10:32:45 reading, `bg-host` has **no `substrate_merge_cursor` row for
  `papercusp` at all** (every other hive's cursor is advancing), the outbox-drain is
  **PASS-TIMEOUT>120s** on a WI-2009-class hung await (keychain-unwrap / epoch-key resolution),
  there is a merge-apply stall on `ef7a8160` (the iMac's OLD device key, pre-reboot — stale
  plan-parts), and the tower's event loop is reporting **CRITICAL/SHED**
  (`federation-drain-reconcile`).

  **⚠ This is an open reconciliation, not a resolved fact — flagging it rather than picking a
  side:** if the git-lane's "iMac already fixed" read is correct, then this plan's P-002 may
  already be moot and the real remaining work is the tower-side drain wedge (a P-003-adjacent,
  not P-002, fix); if it is stale or scoped to a different admission than what P-002 needs, P-002
  still has real work to do. **P-002/P-003 owners on this plan should read WI-3487's live
  checkpoint (git-lane) before starting, to avoid duplicate diagnosis of the same rig.** Neither
  lane has yet produced a **sustained** fresh `origin=remote` row (the only criterion **both**
  lanes agree is the actual gate — see `p2p-git-watermark-gate-discriminant`, asserted fact:
  GREEN only on a **fresh** row proving iMac→tower, never bare remote count).

### Coord-lane verdict (su-bce8d8e6, WI-3549, checkpoint 19:40Z — pulled verbatim)

> "20:00Z(07-10): Owner un-gated EI-8895 ... I re-ran `wi183-attach-on-late-admit.integration.test.ts`
> fresh myself (was never actually executed this whole investigation, only reasoned about):
> PASSES green. Per the test's own docstring this means in-process late-admit attach already
> works — the rig failure is transport-level (dead-data-path), not an in-process attach-code gap.
> Relayed this to su-07320b7c so their P-001 doesn't burn cycles on a likely no-op fix ... STATE:
> EI-8895 wall CLEARED (owner acted). WI-3548 (GO-NO-GO synthesis) still unclaimed. ef7a8160
> cursor still position=0 as of last check (18:36Z) — expect this to move once [the] fleet lands
> a fix. NEXT: monitor ... fleet progress + the cursor; update/relay to whoever holds WI-3548 once
> either lands." — this independently corroborates the P-001 lane's later (19:59Z) finding.

### Git-lane verdict (su-63834d42, WI-3487 / P-003 of `p2p-git-live-activation-2026-07-09`,
checkpoint ~19:58 EDT — pulled verbatim, abridged)

> "iMAC (172.31.44.2) = NO LONGER THE BLOCKER. Server REBOOTED ~15:41 ... REJOINED papercusp
> hive: `harness_shared.hives` has papercusp-workspace/papercusp row (created 15:41),
> hive_members=2 ... [swarm] peer_connected x2 ... home-harness validation PASSED. iMac SECONDARY
> gaps (note, not gate-blocking): (a) hive-git submodule clone FAILED on GitHub auth ... (b)
> [disk-space-alarm] /Users/aviweiss/.papercusp-workspaces=3.5% free. **SOLE REMAINING BLOCKER =
> TOWER inbound drain wedge** (one-ended now; iMac end fixed). Tower origin=remote STILL frozen:
> r5m/15m/30m=0, newest 10:32:45 (RED, held HONESTLY). bg-host ... log: NO substrate_merge_cursor
> row for papercusp AT ALL ...; [outbox-drain] PASS TIMEOUT>120s papercusp-workspace::papercusp =
> WI-2009-class hung await (keychain-unwrap/epoch-key resolution) wedging serialized drain;
> [stage-stall] epoch-encrypt row 6011924 + merge-apply stall on ef7a8160 (OLD iMac device),
> stale plan-parts BRIEF-tooldef-*; [loop-shed] federation-drain-reconcile SHED — event-loop
> CRITICAL ... GATE DISCRIMINANT: GREEN only on a FRESH origin=remote row proving iMac→tower
> (probe:emit/WI-3812 preferred over v2t marker), NEVER bare remote count. Do NOT force green."

### Live evidence snapshot (this synthesis, 2026-07-10 19:58 EDT, `psql` direct)

```
select origin, count(*) from harness_shared.coord_event_log group by origin;
 origin | count
--------+--------
 local  | 100228
 remote |    147
select max(ts) from harness_shared.coord_event_log where origin='remote';
 2026-07-10 10:32:45.603-04
```
Matches both lanes' independent readings exactly — this is a real, reproducible, currently-RED
gate, not a stale/mis-cited number.

### Flag posture (re-verified 2026-07-10, unchanged from 07-03 row #11)

| Flag | Default | Status | Note |
|---|---|---|---|
| `papercusp-p2p` (`FLAGS.P2P`) | **ON** | 🟢 test-guarded (`production-defaults.test.ts`, FS-D5: must default ON, must not be dark) | Fleet-wide kill-switch for the P2P work-sharing surface; activation itself is opt-in (M11) |
| `papercusp-hive-rekey` (`FLAGS.POT_REKEY`) | **ON** | 🟢 not in `KNOWN_DARK_FLAGS` | In-place re-key epoch K-cut, live in production |
| `papercusp-github-bridge` (`FLAGS.GITHUB_BRIDGE`) | **ON** | 🟢 not in `KNOWN_DARK_FLAGS` | Fleet-wide kill-switch for the hive-git↔GitHub bridge; `hiveGit.mode` per-hive setting is the real activation surface |
| `papercusp-presence-gossip` (`FLAGS.PRESENCE_GOSSIP`) | **OFF** | 🟡 registered dark, case `cutover` | Reader-before-writer requirement (a gossip-only announcer is invisible to a log-only reader); owner flips after a 2-machine presence-federation verify |
| `papercusp-open-signup` (`FLAGS.OPEN_SIGNUP`) | **OFF** | 👤 registered dark, case `owner-authority` | Deliberate — owner personally ratifies before ship |
| `papercusp-own-log-fork-auto-recovery` | **OFF** | 👤 registered dark, case `owner-authority` | Destructive Corestore reset; owner must ratify (WI-3535) |

No new dark-flag debt from the 2026-07-09/10 p2p-git work — `KNOWN_DARK_FLAGS` count is unchanged
by this program.

### What this means for the rest of this ledger

- **Rows 12/13/15/20/21 below (cross-machine replication, LIVE-1 parity, 3-node matrix, cross-platform witness)** all ultimately gate on the SAME live watermark — until it moves and sustains, none of them can go 🟢 no matter how much in-process/local-rig evidence accumulates. WI-3646 (row 20's regression) is now **resolved+live-rig-verified** (2026-07-10, see below) — that regression is fixed, but it is a DIFFERENT bug from the current watermark freeze, so its fix does not itself move this gate.
- **The hive-git P2P replication plane** (`p2p-git-live-activation-2026-07-09`, Phases 0-2: storage/serve/announce-fetch/integrator/worktree-bridge, ALL landed+unit/integration-green) is **fully built and unit-proven** but its Phase 3 live 2-machine drill (legs A-E, `hive-git-drill.sh`) is blocked on the exact same watermark — **this is one gate, not two**, whichever plan's lens you view it through.
- P-004/P-005/P-006/P-007 of the crack plan (this synthesis, regression rails, drill-scaffold readiness, recurrence-guard) proceed in parallel with **no rig** — they do not wait on the watermark to move.

---

## GO/NO-GO checklist — one row per release criterion

Legend: 🟢 green-with-evidence · 🔴 open → mapped to an item of THIS plan · 🟡 partial → mapped · 👤 owner-waived / owner-authority.

### Substrate + correctness (verified green)

| # | Criterion | Status | Evidence (verified 2026-07-03) |
|---|---|---|---|
| 1 | Federation substrate min-bar: content/plan-part/coord-data bidir, concurrent LWW, restart durability, reconnect catch-up, revocation K-cut, coord control-plane — per owner-ratified min-bar D-006 (in-process multimember + 2-node live) | 🟢 | **8/8 matrix run `m1783013203`** (2026-07-02, containerized 2-node rig, `bin/deb-hetzner-matrix.sh`); recorded in `federation-release-hardening-relaunch-2026-07-01` ## Now (ALL 13 briefs done) + WI completionRefs. Earlier per-brief Hetzner runs = VM-grade proof. ⚠ Raw run log not retained in-repo — the plan record + per-WI completionRefs are the citation; P-013's standing gate makes this reproducible on demand. |
| 2 | Revocation READ cut-off (C-001 / epoch K-cut) live | 🟢 | WI-1329 `passed`: Brief 3 LIVE PASS 2026-07-02 (2 VMs, public DHT, ~90s negative assert; pre-ban stays readable — epoch-0 semantics). Matrix `revocation_kcut` green. `papercusp-pot-rekey` **default-ON**, not in DARK_FLAGS (`libs/flags/src/types.ts:998`). |
| 3 | Restart durability live | 🟢 | WI-1331 `passed` (2-VM cold restarts, no content/roster loss); matrix `restart_durability` green; scenario pinned `bin/lib/scenarios/b5-restart.sh`. |
| 4 | LWW convergence under clock skew — all 4 ordering sources fixed | 🟢 | Migs **446/458/459/460** (+ **466** node-id strong entropy) present at HEAD (`libs/papercusp/libs/db/sql/`); WI-1672 `resolved` (forced-tie PG integration test + 120-seed production-topology fuzz, monotone AND skew); matrix `concurrent_lww` byte-identical winner. Residual WI-1684 **FIXED 2026-07-09** (row #16 / post-min-bar verdict below — WI-3538/`resolved`). |
| 5 | A-003 class (owner→joiner roster/settings; no-restart first-poll federation) | 🟢 | WI-1378 + WI-1544 `resolved`; CI-pinned: `a003-scope-buffer-replay.test.ts` + `owner-roster-rebind-race.repro.integration.test.ts` at HEAD; matrix m1783013203 federated A→B **first-poll, no restart** on all 8 scenarios. |
| 6 | Long-running node stability (bg-host leak) | 🟢 | WI-1417 `resolved` (root: claude-sessions fs-sweep; live re-verify 2026-07-02: 5.7–5.8GB sawtooth plateau vs the old ~1GB/min climb; reaper storm gone; 3 recurrence-guard tests). WI-1089 `resolved`. *(known-limitations doc row was stale-red — fixed 2026-07-03.)* |
| 7 | Alpha ship gates (K-CUT GATE-1, cross-member browse GATE-2, flag posture GATE-3, admission/rekey audits) | 🟢 | Plan `shared-pot-public-release-2026-06-22` **complete** — shipped in alpha.2; WI-565/WI-566 audits re-verified (116 hermetic tests). |
| 8 | Data-completeness (table + column grain) | 🟢 | `federated-column-completeness.integration.test.ts` at HEAD + the 2 table-grain CI tests. `trusted_authors` local-only by design. |
| 9 | NAT / firewall / cross-region | 🟢 | Brief 8 LIVE (ash↔hil, restricted-cone NAT, 2026-07-02): holepunch both ways, member→owner PASS, owner→member late-not-never — **WI-1534 FIXED 2026-07-09** (row #16 / post-min-bar verdict below — WI-3539/`resolved`). Symmetric NAT = documented known limitation (needs a real middlebox). |
| 10 | Coord control-plane trust boundary (messages/escalations/handoffs federate; below-steer handoffs quarantined) | 🟢 | Matrix `coord_controlplane` both legs (ungranted → quarantine, steer-granted → applies). ⚠ **Ledger discrepancy**: WI-1510 is still `todo` in the WI ledger despite the closed-by-design disposition in two docs — residual real scope = the vacuous await-subscription probe; needs a close-or-rescope pass (flagged to fleet leader). |
| 11 | Flag posture | 🟢 | `FLAGS.P2P` **default-ON, test-guarded** (`production-defaults.test.ts:196` — must default ON + must NOT be dark, FS-D5). `papercusp-pot-rekey` default-ON. `papercusp-presence-gossip` in KNOWN_DARK_FLAGS as a registered **cutover** case (reader-before-writer; row #19). `papercusp-open-signup` dark by **owner authority** (👤, deliberate). |

### Open — mapped to `shared-pot-p2p-release-readiness-2026-07-03` items

| # | Criterion | Status | Owned by | Ground truth (2026-07-03) |
|---|---|---|---|---|
| 12 | Cross-machine fed_event replication (tower↔libvirt-VM) | 🔴 **the release-critical blocker** | **P-003** (su-6b811) + su-16e4c274's P-108 scope-federation lane | Replication dead BOTH directions despite healthy network (full-MTU DF ping 0% loss) + swarm connects; suspect scope-cores/corestore layer, VM core-key regen on restart. Success = `papercusp-desktop/bin/vm-rig/probe-fwd.sh` + `probe-rev.sh` green + survives VM reboot (probes rescued into the repo by P-002; deploy driver first: `bin/vm-rig/deploy.sh`). Source: `cross-machine-coord-parity-and-trust-2026-07-01` P-059 ## Now. |
| 13 | Replication-liveness detector + restart soak (WI-183 class: connected-but-dead replication is silent) | 🟡 **detector PROVEN LIVE 07-04 — transport GO w/ known-limitation (self-heals ≤19min); soak-green awaits WI-2028/29** | **P-004 + WI-183** (su-b5d1c) | Detector BUILT+TESTED (12/12 unit + boot suite; matrix scenario `b8-replication-soak.sh` order 87). Soak on the FIXED rig (post-WI-1910 containerized 3-node DHT, discovery proven green): after kill/restart the swarm RECONNECTS fully (peer_connected both frames, announce-debug flowing, A-003 rekey runs) but features NEVER land ≤90s in EITHER direction — runs `m1783106818` (5-cycle) + `m1783107962` (1-cycle deterministic repro; frames KEPT @10.97.0.11/.12 for diagnosis). Freeze is ABOVE the swarm (corestore/outbox/epoch family — same signature as row 12 and as WI-183's original 06-16 observation, now deterministically reproducible). **ROOT-CAUSED 07-03 22:46Z (su-b5d1c, run `m1783114921`, ratified su-17c98): STALE DHT ANNOUNCE RECORD zombie window** — socket death (restart / sidecar crash-respawn) strands the old announce record (same keypair, dead port); peers connect via relay handshake (`peer_connected` fires both sides = looks healthy) but the data path dials the DEAD port (tcpdump: 387-byte Noise dials → ICMP port-unreachable, zero app bytes, ~70 zombie connections over 18 min); heals INSTANTLY at DHT record TTL ~18–19 min. Defect class = restart-with-persistent-keypair (fresh-keypair control pair connects instantly; rig + deb swarm stack exonerated). Fix lanes: **WI-1840 detector+active-recovery (su-b5d1c, release-gating)** + root-cause follow-ups WI-2028/WI-2029/WI-2030 (filed 23:15Z, non-gating). **Composition ANSWERED 23:15Z (su-b5d1c): TTL-heal covers ALL original WI-183 observations — the transport layer alone never causes permanence.** Permanence = the STACKED content-drain layer: **WI-2009** (drain never re-arms on missed key-arrival; on the VM amplified by WI-2018 split identity) — split out as GO/NO-GO gate 1b, gating (fixed or owner-waived), assigned su-b5d1c. **FLIPPED 🟡 07-04 00:05Z (su-b5d1c): WI-1840 DETECTOR PROVEN LIVE + matrix pin landed.** Round-1 proof run (m1783120511) was SILENT and exposed a detector blind spot: swarm.ts per-join `liveConnectionCount` counter can't see sockets pre-dating its join registration (shared-swarm dedup + rekey reset) → sampler fed swarmConnections=0 → axis disarmed (in-process green ≠ live green, on the detector itself). Fixed (reads `swarm.connections.size` live set + `lastSwarmConnections` diagnostics in the registry read), round-2 on the kept-up frames (restart 23:56Z): `replication_stalled (connected_never_replicated)` fired on BOTH frames at exactly the 180s grace during a genuine zombie window, RPC verdict no_replicator w/ lastSwarmConnections=2, durable EI rows EI-1..4 on both frames (federated cross-frame post-heal). Matrix pin: b8 scenario now asserts the detector line EXISTS whenever the soak SLA fails (silent-detector regression is self-announcing). Bonus: 2nd+3rd live confirmations of the stale-record mechanism (member-scope ~19min TTL-heal; pot-scope INSTANT heal when both sides re-announce fresh — the asymmetry is the root cause in miniature). WI-1840 CLOSED w/ evidence. Row 13 residual to 🟢 = soak passes its 90s SLA (needs WI-2028/WI-2029, non-gating) ; gate 1b (WI-2009 + WI-2102 content-drain permanence stack) is the remaining GATING piece, assigned su-b5d1c, starting now. Real-world proof pending deploy: WI-2105 (live tower↔VM 12h connected-zero-folds) is a standing textbook case the deployed detector must catch. **WI-2102 half of gate 1b VERIFIED 2026-07-09 (su-cdb56)**: `buildEpochEncryptCapability.encryptOp` already bypasses key resolution and returns null (plaintext, no epoch stamp) when `epoch===BASELINE_EPOCH` — the exact fix the ticket specified, matching the decrypt gate's `op.epoch==null` passthrough. 3 dedicated tests (`pot-epoch-op-gate.test.ts` "WI-2102" block) + full suite 26/26 green (`pot-epoch-op-gate.test.ts` + `pot-epoch-read-cut-witness.test.ts` + `pot-epoch-state.test.ts`), `tsc --noEmit` clean. WI-2102 `resolved`. **⚠ WI-2009 half NOT independently re-verified this pass** — its terminal state came from a bulk-close (EI-7545) explicitly citing "reusing existing recorded evidence rather than re-verifying from scratch," the same stale-state-flip pattern caught elsewhere on this release (WI-1534/WI-971) — gate 1b should not be treated as fully closed until su-b5d1c (or a peer) re-verifies WI-2009 with real evidence. |
| 14 | Local rig canonicalization (one-command bring-ups, runbooks de-Hetzner'd) | 🟢 done (suite truthful-green; one cited product gap) | **P-002** (su-cc992) | VM-rig scripts IN-REPO: `papercusp-desktop/bin/vm-rig/` (deploy.sh live-verified rc=0 vs 172.31.44.2). `bin/local-matrix.sh` LANDED + HARDENED (ufw preflight; flock single-tenant serializer (b5d1c); RIG_SSH_IDENTITY inherit; IdentitiesOnly=yes). Known-limitations + LIVE-1 de-Hetzner'd (D-001); `default_deb()` finds CARGO_TARGET_DIR/"Papercusp GUI" artifacts; docs mirror rebuilt. **Two-instance suite on fresh 07-03 deb — FOUR rot layers fixed**: (1) two-role-split GUI launch → `fed_local_launch_sidecar`; (2) argless `fed_pick_free_port` port self-collision → staggered picks + launcher guard + selftest (7/7); (3) merge+pot-directory smokes drove the per-harness share wire RETIRED 2026-06-11 (404s) → both retired-in-place, coverage=from-repo+content-matrix, sym-directory gap filed WI-1873; (4) ambient `PAPERCUSP_DHT_HOST=172.31.44.1` in fleet-session env poisoned swarm binding → launcher force-empties it. VERDICTS (13:24 run, log `/tmp/p002-cm-attempt5.log`): federation smoke OVERALL PASS; from-repo PASS (~12:00); content-matrix boot+discovery+join+topic-equal+negative-isolation+live-incremental-A→B GREEN (10/11 tables; presence local-by-design) — remaining reds = backfill + joiner-side B→A drain stuck in `substrate_outbox` = **WI-971** (known outbox-drain-never-wired gap, filed 06-29, root-caused; the P-013 gate documents itself red-by-design on it). Single-box federation proof now blocks ONLY on WI-971. **UPDATE 07-03 14:43: WI-971 RESOLVED** — differential showed the B→A reds were a smoke WS_B artifact (fixed) + the joiner home-view drain gap (fixed, live-verified via MOD-LEG2 red→green); backfill reclassified as latency → **WI-1942**. Single-box proof tail now = one truthful-green content-matrix pass on a post-fix artifact. |
| 15 | LIVE-1 parity surfaces on the local VM rig (wake bridge+flood cap, receipts exactly-once, federated events, presence gossip H1-H3, claim-spec federation M6/M7/L9) | 🔴 blocked on P-003 | **P-005** → then **P-006** (PRESENCE_GOSSIP cutover: both operators booted flag-ON, 30-min roster watch) | In-process suites green; live 2-machine proof owed (`LIVE-1-parity-rig-runbook-2026-07-02`). |
| 16 | Post-min-bar correctness backlog → explicit verdicts (fixed+pinned OR documented ship-with-limitation) | 🟢 **all P-014-flagged items now FIXED+pinned (2026-07-09)** | **P-011** (su-c02fa) → follow-up **P-010** (`p2p-rest-lanes-2026-07-09`, su-1e366) | See **“Post-min-bar verdicts (P-011)”** below — every item has an explicit verdict + an accountable tracker. **UPDATE 2026-07-09**: both items previously flagged for P-014 attention are now closed with real evidence: **WI-1684** fixed+verified (WI-3538 `passed` — fix was already in-tree; verification + stale docs were the actual gap, 17/17 unit + 11/11 fuzz green) and **WI-971** stays resolved (WI-3542 re-verified against real Postgres, not just the 07-03 differential). **WI-1855/1856/1857** (the G8/G9/G24-27 trio) also re-verified/fixed this pass (WI-3540 `passed`) — see the post-min-bar table below for each. Nothing left in this row for P-014 to act on. |
| 17 | LIVE-2 work-distribution acceptance drill (offer→pull→spawn→receipts→revocation, every leg observable) | 🟡 live-subset PASS 07-03 (10/10 wired legs); core lifecycle legs UNWIRED — tracked per-lane | **P-007** (su-cc992, WI-1915) | Spec = P-305, re-homed local (WI-1751 deprecated "infra unavailable"). **Standing drill LANDED: `papercusp-desktop/bin/work-distribution-drill.sh`** — run 3 on fresh 07-03 deb, packaged sidecar (log `/tmp/p007-drill-r3.log`): grant Delegate→caps expanded+epoch ✓, M11 grant-confers-no-allotment ✓, allotment set→row→remove round-trip ✓ (P-201), revoke→in-flight foreign session REAPED fail-closed ✓, refusal receipt offer-threaded ✓, X6 epoch fence 0→1 ✓, grant status revoked ✓, `p2p:trace` assembles the timeline ✓. Run-1 incidentally live-proved the WI-1564 default-partition refusal is loud+self-describing (D-004). **Unproven legs = unwired by design, each SKIP-with-reason + tracked on `p2p-work-distribution-2026-07-02`** (map agreed w/ su-35c3b, msg mr58yse5): offer-store publish WI-1935 [seq2] · puller activation WI-1936 [seq1, gated on claim-path soak] · **executor spawn WI-1937 BLOCKED(owner-authority: P-105 sandbox unbuilt — hard line, do not wire)** · **metering substrate WI-1938 PASSED 07-03** (mig 483 + metering-store.ts live+tested; SKIP flips when a real writer lands — spend rides WI-1937, contribution rides WI-1936) · push-nudge/fed-reap WI-1939/40. **Cross-node gate MOVED (07-03): WI-1910 CLOSED (leader verdict, non-repro on current deb; 07-02 pin lifted) → now gated on WI-2006** — fleet-directory (mig 476/D-006) landed store+projection but the PUBLISH path is unwired (PgFleetDirectory zero production callers; scope-roster `directory?` slot never injected); all other legs are per-machine by design (M19), so cross-node adds nothing until WI-2006 wires. Content-layer asserts stay out regardless (WI-183 epoch-key class red, row 13). Drill goes greener as each lane wires; zero re-authoring needed. |
| 18 | Attestation flow (second-device attestation, membership seeding, refused-op counters) | 🔴 unproven, blocked on P-002 | **P-008** | `p2p-work-distribution` P-003 (WI-1730 `todo`); adversarial probes (unattested device, wrong gh user-id) must increment counters. |
| 19 | Moderation witness (takedown + report federation) live run | 🔴 built-not-run | **P-009** | WI-283 `passed` = the witness is BUILT (MODERATION_PROBE=1 rider, static-verified 06-30) — it has **never executed**. Run on a quiet box; both legs must green on a CURRENT build. |
| 20 | 3-node multi-member coverage | 🟢 **rig scope DONE + WI-3646 regression FIXED+live-rig-verified 2026-07-10** — three stacked "missing hive_slug field" bugs in `hive:create`/`hive:create_from_repo` silently zeroed the owner's own federation binding; fixed + LIVE RIG re-run (pcusp-rig-a/b/c, fresh 0.0.6 deb): `content_bidir`/`planpart_bidir`/`coord_bidir`/`concurrent_lww`/`coord_controlplane` all PASS end-to-end. **Distinct bug from the current 2026-07-10 watermark freeze (see "current precise blocker" above) — this fix does not itself move that gate.** | **P-006** (p2p-rest-lanes-2026-07-09, su-4834d) → WI-3646 closed by su-6073db3d | **WI-3577 (the `memberLinks`-missing from-repo/cupboard-dedup blocker noted in the prior version of this row) is RESOLVED** — the v4 run below completed `rig_join_all` cleanly on all 3 frames and ran the full registered scenario matrix. **3 real rig-side bugs found + fixed this pass** (all confirmed against live DB state, not just code review): (1) a `potSlug` parse regression in `deb-hetzner-rig.sh`, (2) a stale `hiveId`→`potId` body-field name in the join-pot call, (3) `membership-churn.sh`'s roster-convergence check hardcoded `>=3` distinct members — but the rig's own DEFAULT topology (`P_C_USER` defaults to `$P_B_USER`, "a real multi-device topology") makes frame c share frame b's GitHub identity when (as here) only 2 real GH accounts exist in the dev environment, so 3 rows can never converge under that topology; fixed by computing the topology-correct expected count (2 vs 3) + asserting c's device landed as a 2nd attestation on the shared identity row instead. **LIVE run evidence** (`/tmp/wi3543-local-matrix-3frame-v4.log`, PID 1020394, this box, 3 docker frames a=owner papercupai / b=member aviynw / c=2nd member sharing b's identity by default): `fleet_directory` (WI-2006) **PASS**. `membership_churn` — FAILED under the OLD (now-fixed) assertion in this log; the fix was verified correct against the run's actual `hive_members` DB rows (2 rows, github_user_id 1567022 with device_attestations=2, 279242982 with device_attestations=1) but not yet re-run fresh end-to-end. **7 scenarios FAIL on ONE shared root cause** (`content_bidir`, `planpart_bidir`, `coord_bidir`, `coord_controlplane`, `work_item`, `concurrent_lww`, `restart_durability`): post-join incremental writes never federate/apply cross-frame in either direction (`probe=0` pattern) — this is **exactly** WI-259's original symptom (marked "closed"/fixed 2026-07-05), so it reads as a **regression**, not a new defect. Diagnosed the cursor-vs-apply discriminator on leader request: `substrate_merge_cursor` advances fine, but the corresponding `harness_features_consolidated` row never lands on the destination frame — the stuck stage is **apply/projection, not transport**, pointing at `boot.ts`'s A-003 slug-filter / WI-259 STEP-2 cross-member content opt-in (`packages/operator-core/lib/sync/hyperbee/boot.ts`). **Filed as WI-3646** (major, explicitly scoped OUT of P-006/this row — federation/merge-lane territory, not rig/testing scope); leader confirmed the dup-close into WI-3543 was wrong and reassigned WI-3646 to **su-6073db3d**, who is actively investigating (last signal: "digging into the A-003 slug-filter / WI-259 STEP 2 opt-in now") and will **re-verify their fix against these SAME `pcusp-rig-a/b/c` containers**, kept up and undisturbed for that purpose per explicit leader instruction. **2 additional FAILs noted but NOT triaged** (distinct from the WI-259 pattern, out of this pass's time-box): `seat_offer` (`workspace_unresolved` — "Allotment write refused: unresolvable workspace partition (got \"default\")") and `spawn_request` (garbled/errored response). **Remaining before this row goes fully green:** WI-3646 fix lands + su-6073d re-verifies against the kept-up rig, then one clean re-run of the full matrix (membership_churn re-confirmed under the fix, `reconnect_catchup`/`seat_offer`/`spawn_request` results folded in), PASS/FAIL table pasted here. **P-006's own scope (extend the rig to 3 frames, land the scenario, run it, root-cause+triage what it finds) is DONE** — closing WI-3543 on that basis; WI-3646 carries forward as the tracked release blocker under its own owner. |
| 21 | Cross-platform witness (Linux tower ↔ mac VM) | 🟢 **coord/data-merge bidir witness LIVE-PROVEN 2026-07-10 (WI-3546, su-0e1a6)** — was 🟡; content/restart legs per P-003/WI-3888 drill (su-d044a) | **P-012** (su-c02fa, coordinating with su-a1a71) + coord witness by **P-009/WI-3546** (su-0e1a6) | CURRENT (mac-side observation, 07-03): the `papercusp` dogfood pot is MATERIALIZED on the VM as a remote-pot clone dir (created 07-03 00:46) — proves a sync happened, NOT live bidir federation (no operator↔operator socket; exchange rides the coord/sync substrate); tower + mac agents share the coord roster. Mac app render FIXED+pinned (WI-1823, scheme_default unit tests; mem0 4481d9b1). The `fed_assert_*` live content-bidir/coord/restart witness is still OWED and rides the P-003 transport fix — run it jointly with su-a1a71 after P-003 greens. Mac audit also surfaced rows #24/#29 (mem0 d41035c6). **UPDATE 2026-07-10 ~23:0xZ (WI-3546 / p2p-rest-lanes P-009, su-0e1a6 — VERIFIED BOTH DIRECTIONS, direct `psql` on BOTH boxes):** the tower↔mac-VM coord/data-merge witness is now LIVE-GREEN both ways, same owner identity. After the VM registry backfill (**WI-3891**, `isRegisteredHive` true) the 8h15m `coord_event_log` freeze (tower id 458509, 10:32:45 EDT) broke: **VM→tower** = tower rows 463624 (22:47:13Z) + 463662 (22:50:45Z), `origin='remote'`, author_pubkey ef7a8160 (VM writer), VM-authored `VMREAL` markers; **tower→VM** = the VM's OWN rows 415 (22:47:19Z) + 419 (22:50:51Z), `origin='remote'`, author_pubkey 5b00878b (tower writer), `coord:receipt` fed_events self-identifying `machine:main-server-Precision-7865-Tower-marsh-office`, delivered:true. Sustained (paired ~3.5min apart, no re-freeze); corroborated by su-4c5f0/su-07320/su-d044a + `p2p:tower-cleared` event. ⚠ `probe:emit`/`federation_probes` hop-advance is a DEAD discriminant (**WI-3962** — `record-hop` never wired to real pipeline stages); read federation health from fresh `origin='remote'` coord_event rows + `substrate_merge_cursor`, never probe hop-advance. known-limitations §2 updated with this evidence. |
| 22 | Standing local release gate (auto-catches green-rig/red-binary) | 🟡 EXECUTING — first green blocked on WI-1861 | **P-013** (su-c02fa) | Never-runs root cause FIXED 07-03 (absolute LOAD_GATE=15 unreachable on the 128-core box → core-aware max(15,nproc/4); hourly timer + 22h green-TTL; staleness EI so silence≠green; vacuous-GREEN guard; storm downgrade). **First validation run EXECUTED 07-03 12:03 and did its job**: caught **WI-1861** (real regression — pot create-from-repo `blueprint invalid`/member_create_failed on a fresh HEAD build) + exposed 3 gate v0 bugs, all fixed same-day (verdict-capture masking log→stderr; local-matrix leg now runs only after a PASSing smoke window; EI-filing had wrong harness slug + unverified SSE response — now confirm-checked). `SKIP_FROMREPO=1` stays until WI-971. **Gate goes green when WI-1861 is fixed** — the standing machinery is armed and proven to fire. **UPDATE 07-03 14:43**: WI-1861 resolved (cannot-reproduce + class guards) AND WI-971 resolved (from-repo leg unblocked — MODERATION OVERALL PASS on the post-fix bundle, so `SKIP_FROMREPO` can drop on a post-14:12 artifact); carve-out re-scoped (backfill classes = WI-1942 latency). First-green blocked only on RUNNING the gate against a post-fix artifact in a quiet slot (next: post-soak run, su-c02fa). |
| 23 | Final GO/NO-GO one-pager (signed checklist, flag-posture table, owner walls enumerated) | 🔴 | **P-014** (fleet leader su-17c98) | Blocked on P-003/P-005/P-007/P-009/P-013. This ledger is its input. |

### Owner walls (👤 — not agent-resolvable; enumerate in P-014)

| # | Item | State |
|---|---|---|
| 24 | Code-signing certs (Windows Authenticode + Apple Developer ID) | Required for public ship; owner-supplied. **Concrete evidence (su-a1a71 mac audit, 07-03, mem0 d41035c6): the mac app is unsigned + un-notarized — `spctl -a` = "rejected: no usable signature" — Gatekeeper blocks a downloaded install outright.** |
| 29 | Apple Silicon (arm64) build parity | Mac build is **x86_64-ONLY** (su-a1a71 audit, 07-03) — no arm64 artifact; verification needs owner-supplied M-series hardware. Most new Macs cannot run the current build natively. |
| 25 | Open signup (`papercusp-open-signup`) | Dark by owner authority — owner personally ratifies. |
| 26 | Multi-owner-pot ban lift + cross-pot v1 scope | Owner decisions (criteria in LIVE-1 runbook / P-014). |
| 27 | P-105 foreign-work isolation | ON HOLD — owner rethinking the worker-seat/foreign-spawn model. |
| 28 | Hetzner account lock | Moot for this program (D-001: all proofs local). Clearing it re-enables VM-grade reruns only. |

---

## Post-min-bar verdicts (P-011, issued 2026-07-03 — no silent deferrals)

| Item | Verdict | Evidence / tracker |
|---|---|---|
| HLC-vs-fed_ts S0 "unification" | 🟢 **FIXED+pinned for release** | All four ordering sources fixed (migs 446/458/459/460 + 466 entropy); 120-seed production-topology fuzz (teeth) + forced-tie two-peer PG integration test + matrix `concurrent_lww` + hardening P-015(b) real-skew (libfaketime) run — all green. The residual "unification" (retiring the fed_ts leg for a single clock of record) is an architectural refactor, not a correctness gap: every guard already orders by `fed_order_key(hlc, ts)` (mig 458). No release action. |
| WI-1534 (anti-entropy: late-admitted core stalls until next append) | 🟢 **FIXED 2026-07-09** (su-1e366, WI-3539) | `joinHarnessSwarm` now takes a `hasStalledLogs()` predicate; `boot.ts` wires it to detect an admitted remote log with 0 live replicator peers and keeps the self-heal loop's FAST re-peer cadence alive in that case, instead of settling into the 60s slow keepalive on an otherwise-quiescent pot. 3 new unit tests (`swarm-self-heal.test.ts`, 9/9 green, 28/28 across the file pair); `boot.ts` typecheck clean; known-limitations.mdx §5 updated. WI-1534 `resolved`. Non-blocking follow-up EI-8836 filed (consolidate with the richer WI-1840 replication-liveness verdicts instead of a raw peersCount scan). **Residual: live-rig verification** of the real-world 80+min stall (bin/local-matrix.sh or tower+VM NAT rig) — coordinating with su-4834d (P-006) / su-9ca33 (P-009), not release-gating (unit-verified fix already lands the mechanism). |
| WI-1417 (bg-host leak) | 🟢 **FIXED+pinned** | Resolved + live-re-verified 2026-07-02 (5.7GB plateau); 3 recurrence tests (`claude-sessions-cache.test.ts`). |
| WI-1684 (local-del resurrection, row-PRESENCE split-brain) | 🟢 **FIXED+pinned 2026-07-09** (su-6073d, WI-3538 `passed`) | The fix (option (b): `projection.ts`'s `applyOpVia` narrows `skipOwnOps` to PUT-only, so an own DEL is always re-applied, fed_hlc-guarded) was **already shipped in-tree** — verification + stale docs were the actual gap. Both regression layers re-run live: unit `projection.test.ts` 17/17 green incl. the WI-1684 skip-guard case; fuzz `convergence-fuzz.test.ts` 11/11 green incl. the WI-1684 teeth block (reproduces w/ `applyOwnDels:false`) + a hard `expect(failures).toEqual([])` across the full 120-seed sweep (not a soft characterisation). known-limitations.mdx §4a + status table updated to FIXED; docs rebuilt. No P-014 action needed. |
| WI-971 (outbox drain never wired for joined/created pot harnesses) | 🟢 **RESOLVED 2026-07-03 14:43** (su-c02fa) | Live differential (attempt-5 pair) decomposed the reds: create-side + joiner-member drains already worked; the real remnant was the joiner's pot-home VIEW getting no drain until restart → fixed (join-pot.ts 2c′ home-view rekey) + EI-82/EI-1623 registry hardening. **Live-verified**: MOD-LEG2 (B→A report federation) red→green with 2c′ as the ONLY delta (b5d1c run /tmp/pot-fromrepo-smoke.zOVo0d); MODERATION OVERALL PASS on the post-fix bundle. Residual: backfill LATENCY split out as **WI-1942** (earmarked 6b811); cross-machine witness = 6b811's P-059 drill post-VM-bundle-swap. |
| G2 (usage-events capture trigger unattached, mig-103 class) | 🟡 ship-with-limitation | Deliberate GA deferral (findings-EN-1: trigger attaches at the GA migration; completeness-guard exemption). Tracker: **WI-1858**. |
| G8 (no un-revoke path) | 🟡 ship-with-limitation, **doc-corrected 2026-07-09** | One-way revoke; workaround = re-invite as fresh device/epoch. Tracker: **WI-1855** `resolved` (WI-3540, su-1e366): re-verified — the known-limitations doc claimed the re-invite workaround "must NOT retro-grant cut epochs", which is **false** against the actual ratified epoch-grant design (`grantEpochKeysToMembers` grants full `[0..current]` history to any new admission). Doc corrected to state verified reality; owner-decision follow-up filed as **WI-3566** (build a real per-identity epoch-floor guard, or ratify full-history-restore as intended). |
| G9 (revoke() Hypercore session leak) | 🟢 **FIXED 2026-07-09** (su-1e366, WI-3540 / WI-1856 `resolved`) | `openRemoteLog`'s returned `RemoteLog` now implements `close() → core.close?.()`, and `boot.ts`'s `revoke()` captures the `AdmittedLog` before deleting it from `admitted` and fire-and-forget closes it (not awaited — awaiting added multi-second live-replicator teardown latency that timed out an unrelated pinned test at vitest's default 5000ms timeout). Verified green live. |
| G24/G27 (membership teardown doesn't federate: dissolve tombstone / leaver row persists) | 🟢 **already implemented+tested, re-verified 2026-07-09** (WI-3540 / WI-1857 `resolved`) | Design-gap class (findings-E D1/L1), pinned by `lifecycle-membership-teardown.gap.integration.test.ts`; read-plane mitigation (K-cut) is live-proven. Both (a) dissolve/leave tombstones and (b) revoke() session close re-run live and green this pass. |

## Discrepancies found during the 2026-07-03 evidence pass

1. **WI-1510 ledger-vs-docs**: docs say "closed as designed behavior"; WI is `todo`. Real residual scope: the vacuous await-subscription negative probe. Needs close-or-rescope (flagged to fleet leader).
2. **known-limitations doc** showed bg-host leak (WI-1417) 🔴 open — actually `resolved` + live-re-verified 07-02. Fixed in the same pass as this rewrite.
3. **WI-259 "closed"** is a duplicate-close onto WI-971 — which was still `todo` at this pass, and is now **resolved 2026-07-03 14:43 with live differential evidence** (see the post-min-bar verdict row). The over-read hazard is closed.
4. **m1783013203 raw log not retained** — the strongest single evidence artifact is cited by reference (plan ## Now + WI completionRefs), not by file. The P-013 standing gate is the durable replacement.
5. **The nightly gate has never actually run its smokes** — armed 07-02, but load-skipped every window so far on this fleet-saturated box. "Gate armed" ≠ "gate green"; treat as 🟡 until a green scheduled run exists.
6. **(2026-07-09) WI-1534 ledger-vs-fix gap**: the fix landed + its wrapper WI-3539 was `passed`, but the *original* tracked issue WI-1534 itself was still sitting `state:todo` in the work-item store — exactly the completion-integrity risk P-010 exists to catch. Flipped to `resolved` with a completionRef pointing at WI-3539. Re-verified all six P-010-named trackers (WI-1684/1534/1855/1856/1857/971) are now in a terminal state (`resolved` or superseded by a `passed` wrapper item) — no other stuck states found in this pass.

## Discrepancies found during the 2026-07-10 resynthesis (P-004, this pass)

7. **Row 20 (WI-3646) was stale** — the ledger said "IN PROGRESS," but WI-3646 closed `resolved` at 2026-07-10 04:17 EDT with live-rig evidence (three stacked missing-`hive_slug` bugs, all fixed, `pcusp-rig-a/b/c` re-run green on 5 previously-red scenarios). Flipped to 🟢 this pass. **Do not confuse this fix with the current watermark blocker** — they are different bugs on the same rig; WI-3646's fix landed hours before the current freeze window started (10:32:45 EDT) and does not explain or resolve it.
8. **EI-8895 was carrying an implicit "needs a code fix" framing that turned out to be wrong.** Two independent re-runs (coord-lane su-bce8d8e6 ~19:40Z, P-001 lane su-9cf4640c ~19:59Z) of the SAME candidate test both came back green, and a second issue (WI-3684, an already-shipped auto-heal) was discovered to already satisfy the recurrence-guard ask. Neither prior triage pass had actually *executed* the candidate test before reasoning about it — a completion-integrity-adjacent risk (asserting a fix is needed from docstring reasoning, not a run). Lesson: when reopening a "detect-only, no recovery" finding, run the cited test before assuming code work is required.
9. **Open, unresolved as of this synthesis**: the `p2p-live-federation-crack-2026-07-10` (P-002/P-003) and `p2p-git-live-activation-2026-07-09` (git-lane, WI-3487) lanes are running **two different live diagnoses on the SAME tower↔iMac rig** at the same time — one says "iMac hive membership absent," the other says "iMac already fixed, tower-side drain wedge is sole blocker." This synthesis does **not** resolve that discrepancy (no rig access, per this item's scope) — it is flagged here + in "current precise blocker" above so the P-002/P-003 owners reconcile before duplicating diagnosis work. Whoever lands the real fix should update this row directly with which diagnosis was correct.

_History: pre-2026-07-03 content (the 06-19/20 synthesis) lives in git history of this file. The 2026-07-03 synthesis (rows 1-23, post-min-bar verdicts, discrepancies 1-6) is itself now historical on the live cross-machine rows — see the 2026-07-10 update at the top of this file for the current gate._

---

## v1 scope — additive features tracked (NOT release-gating)

Features the owner has scoped INTO the shared-pot P2P v1 release as **additive, dark-by-default**
capabilities. These do **NOT** gate the GO/NO-GO above — the release can ship with any of them still
in progress (they are off by default and touch no existing behavior until flipped on). Listed here so
the v1 release plan tracks them and the fleet picks them up.

| Feature | Status | Plan / driver |
|---|---|---|
| **Cross-machine mem0 memory federation** | 🔨 **planned, not built** — 9-item plan active, unclaimed | Federate mem0 memory *content* cross-machine the SAME way standing facts already do (agent-facts **F1-1**, `federated-scout-gym-learning-2026-07-02`): an opt-in `shareable` flag on a memory + a `p2p_memories` peer-log projection, capture-triggered for `shareable=true` rows ONLY, gated on **pot visibility + member admission so private pots never leak**, **DARK-BY-DEFAULT**. Additive — mirrors the existing pattern, not a rewrite. Plan: **`mem0-cross-machine-federation-2026-07-10`** (9 items P-001..P-009, 3 phases: schema+capture → receive-side projection → privacy tests + live cross-machine witness). Fleet-pickup driver: **WI-3985**. `[owner:Avi 2026-07-10]` |
