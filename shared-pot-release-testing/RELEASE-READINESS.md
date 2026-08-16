# Shared-Pot P2P — Public-Release GO/NO-GO (signed)

**Question:** can we confidently ship the shared-pot (P2P federated) feature to public production?

**VERDICT — updated 2026-08-09T05:05Z (prior: 2026-08-01T19:15Z; originally 2026-07-27T06:05Z):
NO-GO for unconditional public ship.** The substrate is release-grade, but the conditional-go set
is **no longer the three rows the 08-01 verdict named** — a security regression was confirmed on
2026-08-09 and the standing gate that would have caught it is switched off. Nothing below is
waiting on a decision; every open row has a named owner and a concrete flip condition.

> ⚠ **VERDICT REASON UPDATED 2026-08-16T03:0xZ (su-c531b, WI-37110). The verdict is UNCHANGED —
> still NO-GO — but BOTH clauses of the sentence above are now stale, and the governing reason
> has moved.**
>
> - *"a security regression was confirmed on 2026-08-09"* — that is C-001 / `WI-37195`, now
>   **`done`** (verified in PG).
> - *"the standing gate that would have caught it is switched off"* — **FALSE as of today.**
>   `WI-37144` is **`dropped`**; the timer is armed and firing (53 runs since 2026-07-27, last
>   02:47:29Z, next 03:39Z).
>
> **The reason it is still NO-GO is now §3 row 0: the core p2p leg has never been measured.**
> `local_matrix` — the 18-scenario leg carrying `membership_churn`, `content_bidir`,
> `replication_soak`, `restart_durability` — executed exactly **once in the last 20 days**
> (2026-08-16T02:47:29Z, which failed on an incidental sidecar race); 51 of 53 runs never
> reached it, and `last-matrix-green` is **481h** stale against a 144h TTL.
>
> This is a **NO-GO on absent evidence, not on a known defect** — a materially different claim
> from the 08-09 verdict, and it must not be paraphrased as either "p2p is broken" or "p2p is
> fine, pending paperwork". The single flip condition is one gate run reporting
> `local_matrix=OK`; the next unforced attempt is the 03:39Z timer.

> ### ⚠ Two rows added 2026-08-09 — read these before quoting any 🟢 in this document
>
> **C-001 — consent withdrawal does not cut on the from-repo path (WI-37195). RELEASE BLOCKER.**
> `from-repo-witness` fails with `epoch advanced 0→0`: the re-key that enforces a revocation never
> fires, so a removed contributor is not actually cut off. **Confirmed REAL**, reproduced on a
> deliberately quiet box (host load ~20/128, gate build core-pinned so the frames were untouched) —
> it is *not* the frame-starvation artifact the `SKIPPED-STARVATION` label implied. Usefully
> narrowed: on the SAME run `revocation_kcut` passed completely with the epoch advancing `0→1` and
> `WI-560 K-CUT VERIFIED`, so the re-key machinery is **sound** and this is a defect on **one path**,
> not a universal revocation defect.
>
> > ⚠ **ROOT-CAUSED 2026-08-09T03:32Z — and the `no_target` lead this paragraph originally cited is
> > REFUTED. Do not repeat it.** (Correction by su-9228f, who owns this row under D-022, to text
> > signed by su-690098a1; the `no_target` reading was mine first — I supplied it — so this corrects
> > my own lead, not theirs.) The cause is **`not_owner`**, the FIRST guard
> > (`hive-revoke-contributor.ts:172`), not target resolution at `:194`. Primary evidence — the
> > WI-280/WI-6043 boot event, readable for the first time once WI-37222 stopped the harness deleting
> > it:
> >
> > ```
> > [2026-08-09T03:31:53.862Z] [boot-history] rekey_boundary_skipped harness=hello-world-pot
> >     revoke boundary advance skipped for gh=1567022: not_owner
> > ```
> >
> > `not_owner` ⇐ `isOwningSwarm()` ⇐ `loadHivePubkey(ws, potHomeSlug) === null`: the **creating
> > owner** holds no loadable Hive private key at revoke time, so the guard returns before the epoch
> > advance. Note the doc comment at `:99-111` genuinely does record the PRIOR `0→0` as `no_target` —
> > that precedent is real, and it was a red herring for THIS instance. The instrument beat the
> > documented precedent, which is exactly why it was built.
> >
> > **The wider defect, which outlives this bug:** `loadHivePubkey` flattens *"no key held"* and
> > *"key held but unreadable"* into one `null`. `identity/hive-keypair.ts:139-153` says so itself and
> > ships a tri-state `loadHiveKeyStatus` whose own comment calls flattening *"wrong for a
> > security-relevant ownership guard"* — and this **is** that guard. So a transient keychain read
> > failure is indistinguishable from "I am not the owner", and **both silently no-op the
> > revocation**: a security control that fails OPEN and SILENT. Fix tracked on WI-37195.
> >
> > Second, independent gap: the gate's K2 fires `substrate:revoke_contributor … >/dev/null 2>&1` and
> > then measures only the epoch delta, so the tool's own `ok:false code:'not_owner'` went to
> > /dev/null for four days. Asserting that return would have named this on 2026-08-05.
>
> **The standing live-federation gate is DARK (WI-37144). RELEASE BLOCKER.** Its timer was stopped
> 2026-08-07T04:35:31Z and disabled 04:36:29Z. Those five reds have since been shown to be **real**,
> and a dark gate is precisely how C-001 survived unnoticed — the blocker stands.
>
> ⚠ **MEASURED 2026-08-12T19:5xZ (su-ba5ef) — SPLIT THIS CLAIM IN TWO. The STANDING gate is still
> dark, but "therefore our newest verdict is the 8-day-old 08-01 green" is now FALSE.** The gate has
> kept running by hand while the timer stayed off, and it produced a **GREEN today**:
>
> | when (UTC) | how | verdict |
> |---|---|---|
> | 2026-08-11T20:16→21:39 | manual `systemctl start` of the **service** (timer never fired) | 🔴 `GATE: RED (content-matrix from-repo)` — `content-matrix=FAIL from-repo=FAIL from-repo-witness=SKIPPED local-matrix=SKIPPED-CONTENT-RED`. Consumed **8h41m CPU, 26.1G peak RSS** |
> | **2026-08-12T11:12:50** | manual run, outside systemd | 🟢 **GREEN** — `~/.papercusp/live-fed-gate/last-green` = `1786533170`, and `last-green` is written on the **green path only** |
>
> The green is **attributed**: `su-7f4eb492` closed **`WI-38192` — "Run admissible exact D-030 gate
> on post-credential-hardening release candidate"** — `done` at 2026-08-12T11:14:41Z, 113s after that
> marker, citing *"a clean terminal-green packaged D-030 run"*. The 08-11 red → 08-12 green ordering
> is coherent: the credential hardening landed between them.
>
> Two things follow, and they are different:
> 1. **The standing-coverage blocker STANDS.** `papercup-live-federation-gate.timer` is
>    `loaded/inactive/dead`, `UnitFileState=disabled`, absent from `timers.target.wants/` (verified
>    directly, not from a broadcast). Nothing re-arms it; re-arming is owner-gated (wall
>    `wall:live-federation-gate-timer-owner-stopped`). Coverage is whoever remembers to run it.
> 2. **The "no current verdict" implication does NOT stand.** There is a green from today.
>
> ⚠⚠ **And that green is itself an instance of this file's own §8 discrepancy #1 — *"a gate that
> goes green silently is indistinguishable from one that never did."*** It survives ONLY as an epoch
> integer in a marker file: the `/tmp` log dir is reaped, nothing was banked to `triage/` (newest
> bank is 2026-08-12T01:53Z), and the systemd journal has no 08-12 entry because the run was not
> under systemd. **Nobody can re-read what that green actually asserted.** Do not promote it to an
> evidentiary spine — cite it as "a green was recorded, its content is unrecoverable."
>
> ✅ **The MECHANISM is fixed as of 2026-08-12 (WI-38285) — this particular green is not.** Every
> terminal path in the gate now emits through `verdict()`, which banks the verdict token, the
> per-leg breakdown, the matrix skip reason, HEAD, and whether the run was systemd- or hand-invoked
> to `$STATE_DIR/verdicts.jsonl` before echoing. So the NEXT hand-run green is recoverable and can
> be cited as evidence. The 08-12 one predates the fix and stays unrecoverable — an empty
> `verdicts.jsonl` for a run before that date means "not recorded", never "no run happened".
>
> ⚠ **CORRECTED 2026-08-09 (su-c2f97, WI-37144): the "no recorded decision / 57 seconds after a 5th
> consecutive RED" reading was WRONG and must not be repeated.** The stop was ordered by the
> **owner**, explicitly, and NOT because of the red: session `d699c658` turn 20
> [owner:Avi 2026-08-07T04:34:50Z, verbatim] *"nvmd i know what it is, just stop it"*, followed
> 3 minutes later by *"I still hear my computer churning. why?"*. The motive was **CPU churn on the
> owner's box during an interactive session**; the agent complied at 04:35:27Z, stopping the run
> **mid-flight**. The 25s adjacency to the run's own `last-run` stamp (04:34:25Z) is coincidence.
> Verified by reading the owner's turns directly, not a search snippet. Recorded as the standing
> harness wall `wall:live-federation-gate-timer-owner-stopped` — **re-arming this timer reverses an
> explicit owner instruction.** (Two prior timestamps in this file read the journal's EDT
> wall-clock as `Z`; the events are 04:3xZ, not 00:3xZ.)
>
> What survives the correction is the part that matters: **the pause was never written to any
> work-item, plan Decision or coord message** — the only trace was an automated supervision
> broadcast firing every ~8 minutes for two days with nobody acting. That durable-record gap, not a
> concealed red, is the process defect.
>
> **Flip condition was three-part; leg (iii) `WI-37464` CLEARED 2026-08-12 — TWO remain.**
> Re-arming is still gated on `replication_soak` (WI-5481, 5/5 runs) and `restart_durability`
> (new), so a re-armed gate is readable rather than permanently noisy.
>
> ✅ **(iii) `WI-37464` — the cause of the churn the owner objected to — is FIXED and CLOSED.**
> The defect was real as stated: `live-federation-gate.sh` made hourly firing cheap ONLY via
> `age_h(last-green) < GATE_SUCCESS_TTL_H` while `last-green` is written on the **green path
> only**, so a RED gate had **no suppression at all** and re-ran the full heavy gate every hour
> forever. A three-tier fresh-exit backoff (green / downgrade / red) shipped 2026-08-09T12:17Z.
> LIVE-VERIFIED 2026-08-12T19:30Z by su-ba5ef executing the real script in an isolated
> `GATE_STATE_DIR` with `GATE_NO_FILE=1`: a fresh red exits `GATE: FRESH-RED`, rc 0, sub-second;
> **falsifiability control** — a red aged 7h (just past the 6h TTL) takes NO fresh exit and falls
> through to a real run, which is what proves the backoff is age-conditional and the pass was not
> vacuous. Three further controls pinned branch ordering green > downgrade > red.
> ⚠ Clearing (iii) is NOT permission to re-arm: legs (i) and (ii) stand, and the owner wall below
> is independent of all three.
>
> ⚠ **Therefore the 08-01 "CONDITIONAL-GO on three named rows" headline is SUPERSEDED, not merely
> aged.** Any summary — including prose elsewhere in this file, and any agent checkpoint quoting it
> — that still reports three conditional rows predates the C-001 confirmation and must not be
> repeated as current. Re-signed by su-690098a1 (WI-37110), correcting the headline only; the C-001
> row itself belongs to su-9228f under D-022.

> **The gate-coverage condition CLOSED 2026-08-01 — and that remains true, but it is no longer
> sufficient.** All three formerly-skipped legs got real verdicts: `from-repo` and
> `from-repo-witness` ran and PASSED on gate run `20260801-143855`
> (`GATE: GREEN — content-matrix=PASS from-repo=PASS from-repo-witness=PASS local-matrix=SKIPPED
> build=OK`, 2026-08-01T15:01:14Z), and `membership_churn` **executed for the first time in its
> history and passed** on a 3-frame rig. Details + scope caveats in §5. Closed by su-e02f5c3d
> under the standing owner instruction to drive the remaining p2p lanes to release-ready.
> ⚠ **Coverage existing is not the gate RUNNING**: `from-repo-witness` has since gone RED (C-001,
> above) and the timer that produces these verdicts is disabled. A closed coverage condition and a
> live gate are two different claims — this row asserts only the first.

Signed: su-e3b21216 (leader, fleet `p2p-release`), plan
`p2p-public-release-remaining-lanes-2026-07-16` P-405 / WI-5139.

> **This document replaces its own history.** Prior versions (the 2026-06-19, 2026-07-03 and
> 2026-07-10 syntheses, each of which appended a dated layer on top of the last) live in this
> file's git history. This is a single current table; do not append another layer to it —
> rewrite the affected rows.
>
> **Rule of record:** in-process green ≠ live green. Every 🟢 below cites a live artifact (a gate
> run, a scenario log, a rig verdict) or a CI-pinned test — never prose, and never another
> document's summary of a run. A leg the gate SKIPPED is recorded as ⏭, never as 🟢
> (`p2p-public-release-remaining-lanes-2026-07-16` **D-015**).

---

## 1. What changed, and the one fact that governs this document

The standing local release gate reached **first green on the merits at 2026-07-27T02:00:39Z** —
its own verdict line, in the service journal:

```
papercup-live-federation-gate.service, Jul 26 22:00:39 EDT (= 2026-07-27T02:00:39Z)
GATE: GREEN — content-matrix=PASS from-repo=SKIPPED from-repo-witness=SKIPPED local-matrix=PASS build=OK
```

with the first-ever write of `~/.papercusp/live-fed-gate/last-green` (epoch `1785117639`) and a
full 16-scenario bank at triage stamp `220032`, run `m1785117063`. It was **earned — not forced,
not owner-waived, not starvation-downgraded**. The four scenarios that had held it for its entire
history (`seat_offer`, `spawn_request`, `attestation_unattested_device`, `replication_soak`) all
PASS in that run.

Two things follow, and they are the spine of this table:

1. **Every substrate row below is now evidenced by ONE reproducible artifact** — the 220032 bank —
   instead of by a chain of citations to individually-run drills over three weeks.
2. **`content-matrix=PASS` is not `everything=PASS`.** `from-repo` and `from-repo-witness` were
   SKIPPED by the gate, and `membership_churn` never executes at all on a 2-frame rig (D-007).
   Those are §5 skip rows. A gate that reports GREEN while silently skipping legs is exactly the
   failure Phase 5 spent a week removing (roll-call invariant, EI-18660392396897977) — applying
   that same honesty to this table is a binding constraint, not a stylistic choice.

---

## 2. The signed table

Legend: 🟢 green, live-evidenced · 🔴 open, blocks unconditional ship · 🟡 shipped-with-named-limitation
· ⏭ SKIPPED by the gate (not a pass) · 👤 owner-supplied input, pending arrival.

Evidence paths are relative to `~/.papercusp/live-fed-gate/triage/` unless stated. All `-220032`
logs are from the green run `m1785117063`.

### 2.1 Federation substrate + data-plane correctness

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Content bidirectional federation | 🟢 | `scn.content_bidir-220032.log` — "content bidir OK (A→B landed, B→A landed)" |
| 2 | Plan-part bidirectional federation | 🟢 | `scn.planpart_bidir-220032.log` — item P-001 both directions, `origin=remote` |
| 3 | Coord control-plane federation + trust boundary | 🟢 | `scn.coord_bidir-220032.log` + `scn.coord_controlplane-220032.log` — harness-scoped msg/escalation/handoff federate; raw presence/watermark/await stay local |
| 4 | Concurrent-write convergence (LWW, byte-identical winner) | 🟢 | `scn.concurrent_lww-220032.log` — no loss on distinct keys; deterministic identical winner on the same key |
| 5 | Restart durability + settle barrier honesty | 🟢 | `scn.restart_durability-220032.log` (cold sidecar restart lost nothing, re-emitted nothing) + `scn.restart_settle_barrier-220032.log`. The barrier itself was fixed under P-415/WI-5772 — it previously reported a false PASS ("order 80 didn't run") when restart_durability had run and FAILED |
| 6 | Reconnect / catch-up after offline window | 🟢 | `scn.reconnect_catchup-220032.log` — offline member caught up on content + plan-part + coord, no loss/dup, roster intact |
| 7 | Revocation READ cut-off (epoch K-cut) applies live | 🔴→🟡 | **⚠ READ §3 A FIRST — UPDATED 2026-08-09T11:01Z: the breach NO LONGER REPRODUCES** after su-9228f's owner-gate fix (`revoke ok:true`, epoch `0→1`, `K4b CONTENT CUT: PASS`). It is NOT 🟢: that is one standalone witness run, not a gate run, and one leg (`K3 CUT`) is still red on its non-vacuity control. The 🔴 history below stands as the record of what was measured, and the "target resolution" narrowing in it is FALSIFIED — the revoke was being rejected at the OWNER GATE, before `loadTargetPubkeys` is reached. ⟨historical record follows⟩ **FALSIFIED 2026-08-09 (`WI-37195`) — this row was 🟢 on evidence that only ever covered ONE path.** The original green still holds *where it was measured*: `scn.revocation_kcut-220032.log` (local-matrix, `revoke.live=true`) passes, and passed again on the 2026-08-09 gate run. But the **from-repo-witness** path reproduces a **C-001 BREACH** on a demonstrably quiet box (host load 20/128, gate build pinned to cores 0-99 off the frames): `K2 REVOKE (A revokes B, epoch advanced 0→0): FAIL` → no re-key → `K4b CONTENT CUT: FAIL — B READ post-revoke content`. AK-ban, AK-unban-teeth, K0 join-keys and the K4a pre-revoke content control all PASS, which isolates it to **the epoch advance on revoke** — not encryption, not write-plane policy, not key wrapping. Path-specific, confirmed from two directions (revocation_kcut PASS + banked `rekey_boundary_applied … newEpoch=1` on that path, vs 0→0 here). Regression window: 2026-08-01T15:01Z green → 2026-08-05T09:39:58Z first red. Owner decision `0e2696ce` makes read-plane re-key the critical path to public release in terms, so this is **unshippable — not a known-limitation candidate**. ⚠ The standing gate was dark from 2026-08-07T04:35Z (`WI-37144`), so this breach was live and silent for ~2 days. ⚠ Do NOT repeat the earlier gloss that it was "disabled 57s after the 5th consecutive red of this leg" — CORRECTED 2026-08-09: the owner ordered the stop mid-run over CPU churn, not in response to the red (see the VERDICT block, §3 B). The breach's 2-day invisibility is real; the concealment implication is not. |
| 8 | Replication liveness detector + restart soak | 🟡 | **NOT CURRENT as of 2026-08-09 — downgraded from 🟢 ⚠.** The green quoted `scn.replication_soak-220032.log` ("OVERALL: PASS — 5 kill/restart cycles … detector quiet"); **that file is no longer on disk** (rotated out of `~/.papercusp/live-fed-gate/triage`), so the row's own evidence can no longer be re-read. The **newest banked run** (`scn.replication_soak-232013.log`) reads `OVERALL: INCOMPLETE — replication-liveness soak had failures`. This is a downgrade to 🟡 (unproven at HEAD), **not** a claim the detector regressed: the soak is genuinely flaky-or-broken and nobody has separated those yet. ⚠⚠ **Reading hazard when you check this yourself (`EI-19940993365684927`):** this scenario's log writes a trailing `✓ detector fire-path pin …` sub-assertion BELOW its verdict, so its LAST line reads as a pass on a FAILED run — a peer already concluded "all green" from it. Read the `OVERALL:` line, never the tail. Still carries the D-008 residual risk, §6. |
| 9 | Work-item federation completeness (WI-1964: 673 vs 2229 divergence) | 🟢 | P-101/WI-5060 — `hive_slug`-first fix verified twice: gate run 20260716-222552 content-matrix (all 10 content types, both directions) + rig-level exact convergence tower 6886 = VM 6886 |
| 10 | Data completeness at table AND column grain (incl. `p2p_memories`) | 🟢 | P-103/WI-5062 — `federated-column-completeness` extended; every column carried / PROVENANCE / reasoned NOT_FEDERATED |
| 11 | Moderation witness — takedown + report federation, live | 🟢 | P-102/WI-5129 — 3 legs PASS on a current build: MOD-LEG1 takedown A→B (`origin=remote`, v1→v2), reportable-authored, MOD-LEG2 report B→A into the owner's queue |
| 12 | Fresh-join cold-restart replication (the ~13.0s death) | 🟢 | Root-caused and fixed: a phantom SocketPool `bind(0)` port in the punch-derived remote address (host correct, port stale/unbound) — **not** host contention (that conclusion is formally OVERTURNED by D-009) and not a generic retransmission bug. Fix landed in `connect.js:354` (`samePrivateIPv4Subnet24` LAN shortcut, WI-5980); proven by row 8's 5-cycle soak |
| 13 | Boot-window item-assignment federation hole (WI-5441) | 🟡 | **Consciously WAIVED for public release, not closed** (P-410/WI-5764). Mechanism narrowed to a re-apply through the projection's `writeToPg` with provenance resolved to 'local' on already-federated content; exact call site needs a dedicated live-rig instrumentation session. Waiver + durable-fix direction: `agent-insights/federation-public-release-known-limitations.mdx` §11. WI-5441 left `blocked`/claim-held |

### 2.2 Work distribution (offers → pull → spawn → receipts → revocation)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 14 | Public-release posture for foreign-work EXECUTION decided | 🟢 | **D-001** [owner:Avi 2026-07-17]: ship v1 with foreign-work spawn LIVE, trust-layer-only security, **no P-105 sandbox, no app-level containment**. This closes what was previously an owner wall |
| 15 | Puller activation (M11 grant-confers-no-allotment, allotment round-trip) | 🟢 | P-202/WI-5132 — live-verified; the named suite independently re-run before close |
| 16 | Spawn leg wired live (deny-all envelope replaced per D-001) | 🟢 | P-204/WI-5134 + P-406/WI-5320 |
| 17 | Foreign-session supervision (H12/H13 liveness + orphan wind-down) | 🟢 | P-407/WI-5765 — and this row is why it matters: the sweep's `routines` row was mis-seeded under `workspace_id='default'`, so every ~60s tick refused `workspace_unresolved` and **the sweep had never once executed since inception**. Root cause fixed (WI-5780), then live-verified |
| 18 | Seat-offer federation (publisher-signed, sig-verified remote apply) | 🟢 | `scn.seat_offer-220032.log` — b→a, live open-seat card, account id kept local |
| 19 | Spawn-request federation, fail-closed | 🟢 | `scn.spawn_request-220032.log` — a→b, signed request, sig-verified remote apply of the new kind, gate-OFF honor hook stayed silent |
| 20 | Work-item federation to a peer's work queue | 🟢 | `scn.work_item-220032.log` — a→b, `engineer_issues` remote apply `origin='remote'` |
| 21 | Fleet-directory card publish + verified remote apply | 🟢 | `scn.fleet_directory-220032.log` — owner-signed publish on create, sig-verified remote apply, substrate-attributed card |
| 22 | **LIVE-2 end-to-end acceptance drill** (offer→pull→spawn→receipts→revocation, every leg observable from the origin, any silent leg = FAIL, on the 2-machine rig) | 🔴→🟡 | **RUN 2026-08-01 (P-205/WI-5135) — no longer "never run", but NOT a full pass; read the leg-by-leg, not the headline.** Single-box drill `PASS=12 FAIL=0 SKIP=6` (packaged deb, `bin/work-distribution-drill.sh`) **+** the federated-revocation leg proven cross-node by a NEW registered matrix scenario `bin/lib/scenarios/fed-reap.sh` (order 59), run `m1785612213`: `b: grant\|revoked\|remote → session\|reaped → receipt work-offer:reap`, with the ACTIVE-grant baseline passing first so the reap is *attributable*. Against this row's own bar: **offer ✓** · **pull ~** (X11 activation + the WI-3629 seam ship in the packaged bundle, but no live pull was ever exercised — nothing ticks it) · **spawn ✓ EXERCISED 2026-08-08** (superseding this row's ✗ — see the correction under the blocker note below: real 2-machine rig, packaged install, BOTH refused and honored branches, receipts `425b8ab1` / `af20b5e3`; ⚠ the honored member never took a turn — WI-35786) · **receipts ✓** (offer-threaded, single-box *and* cross-node) · **revocation ✓ local AND ✓ federated**. ⚠ Environment: 2 **container frames** on a **private testnet DHT** — *not* two physical machines, *not* the public DHT (sufficient for this leg because `origin='remote'` keys on hyperbee source-log/device provenance, not a physical boundary — but do not quote it as the 2-machine rig; row 35 still owes that). ⚠ Both proofs used a **SEEDED**, not spawned, foreign session — see the blocker note below. Also landed: **D-018** — this drill's SKIP census was six *hardcoded strings* whose reasons had rotted into falsehood (5 of 6 false; one contradicted the drill's own header), so a clean run would have produced a plausible, quotable, WRONG reading; every reason is now DETECTED at runtime from the artifact under test |
| 23 | Push-nudge wiring (latency only, never correctness) | ⚪ RETIRED | **SUPERSEDED PROTOCOL RESIDUE — not a missing release feature** (D-035, P-203/WI-5133). The original `kind:'work'` intake target is rejected fail-closed by `offer-store-schema.ts`; a landed remote `spawn_request` is honored directly by the work-offers projection, so there is no standing-poller delay left for the old nudge to optimize. Nudging seat publication would conflate availability with work, while nudging spawn-request publication would wake the peer before federation delivered the request. The pure modules remain preserved and tested. Current-staging verification: `testing:run` `30fd4414-fb18-43b3-82c2-38b3fbcbe062`, 5 files, **124 passed / 0 failed**. |

### 2.3 Attestation + trust closure

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 24 | Second-device attestation + membership seeding, on a GENUINE second frame | 🟢 | `scn.attestation_membership-220032.log` — "attestation OK on a GENUINE second frame (container boundary, not same-box): LEG1 A attests B + B roster seeded `origin=remote`, LEG2 second-device merge no-clobber". This is the leg P-301's original evidence did **not** meet (it was same-box); closed via P-423 |
| 25 | Adversarial refused-op counters (unattested device) | 🟢 | `scn.attestation_unattested_device-220032.log` — author device attested to no member → A refuses, `identity_unresolved` 0→2 |
| 26 | Refused-op counters cannot silently no-op | 🟢 | P-413/WI-5766 — `bumpRefusedOpCounter()` in `packages/operator-core/lib/p2p/receipts.ts` was **swallowing counter-increment failures**, precisely the class row 25 depends on. Now catches+logs; 4 tests in `receipts.test.ts` |

### 2.4 Release gate, packaging, docs

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 27 | Standing local release gate — FIRST GREEN | 🟢 | 2026-07-27T02:00:39Z, earned. See §1 and **D-015** |
| 28 | Gate honesty machinery | 🟢 | P-411 scenario-assert integrity audit (fixed `rig_assert_absent` silently PASSing when the probe never ran — security-relevant, backs the revocation/ban leak check) · P-415 settle-barrier false PASS · P-416 rig single-instance lock before the 3.4GB rebuild · P-417 standing-condition EI dedup (57 duplicates) · P-422 timestamped frame logs · roll-call invariant (`run + skipped == registered`) so OVERALL:PASS can no longer imply full coverage |
| 29 | Packaging freshness — artifacts carry HEAD migrations | 🟢 | P-401/WI-5063 (kills the WI-3969 class: a bundled `.deb` capped at migration 541 vs repo 559+) + P-412/WI-5769 re-confirming the guard holds |
| 30 | Apple-Silicon arm64 build parity | 🟢 | P-412/WI-5769 — universal build verified to build and boot; arm64/x86_64 parity confirmed ship-ready. (Signing is row 35, a separate input) |
| 31 | from-repo outbox drain for joined/created hive harnesses (WI-971 / WI-5628) | 🟢 code, 🟢 gate (2026-08-01) | P-418/WI-5775 — verified live on the real packaged binary: two `two-instance-hive-from-repo-smoke.sh` runs (plain, and with the gate's exact `WITNESS_PROBE=1`+rekey flags) both OVERALL:PASS incl. the bidirectional post-join assertions. **The gate now runs this leg for real** (`SKIP_FROMREPO=0`) and it passed on 2026-08-01 — see §5 |
| 32 | Public docs + known-limitations current | 🟢 | P-403/WI-5065; §10 (from-repo closure) and §11 (WI-5441 waiver) of `federation-public-release-known-limitations.mdx` updated this program |
| 33 | Federation substrate operational hygiene | 🟢 | P-419 outbox stall self-resolved to 0 undrained steady-state (was 19,973 rows) · P-420 wedged-bootstrap gap identified: `never_connected` is deliberately never-alarming, so the EI-8892 DHT liveness probe is the **only** independent signal — documented, not silently assumed |

### 2.5 hive-git P2P replication plane, and cross-machine witness

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 34 | hive-git P2P plane — LIVE legs | 🔴 | **Unproven, actively in flight** (lane `p2p-git-live-activation-2026-07-09`, WI-6276, as of 2026-07-27T04:30Z). The lane's own reading: the rig's entire log shows pot-git serves **100% REFUSED (8/8)** — never one successful fetch — so *"any clean reading is a FALSE GREEN"*. The rig is warm, so the G-8 bootstrap short-circuits every tick; a genuine cold condition was staged at 04:30:27Z. ⚠ **CORRECTED 2026-08-09 (su-690098a1)** — this row previously read *"EI-18765930091826096 (channel degrades until it serves nothing; only a restart clears it) **is fixed + deployed**, with WI-6272 adding the detector whose absence made it take days."* **The "fixed + deployed" half is FALSE.** EI-18765930091826096 is `state: open`, `needsHuman: true`, never checkpointed (last released 2026-07-27T03:51Z), and its own body says *"root cause not yet established — this is filed as a confirmed symptom with an unconfirmed mechanism"* under a heading literally titled **"SUGGESTED DIRECTION (not yet implemented)"**. Verified in code, not inferred from the item's state: the prescribed remedy is *"tear down and re-dial a FRESH channel (and/or de-prioritise that peer)"* after N consecutive non-timeout deaths — and `bootstrap.ts:563-569` shows the ONLY action on `flakes >= DEEPEN_FLAKE_TOLERANCE` is `writeDeepenStep(…, deepenNext / 2)`, i.e. **halve the rung size and reset the counter**. There is no channel teardown, no re-dial, no peer de-prioritisation anywhere in `bootstrap.ts` / `fetch-transport.ts`. So what landed is the **DETECTION half only** (the persisted `papercusp.bootstrapDeepenFlakes` counter from WI-6261/WI-6272); the EI is explicit that rung-logic hardening *"does NOT fix it, and can hide it"* by letting the ladder sit patiently on a dead channel. Treat the underlying degradation as **OPEN and unmitigated**. **Release-blocker #2** |
| 35 | Cross-platform witness — Linux tower ↔ mac VM | 🟡 | Coord/data-merge bidir was LIVE-PROVEN 2026-07-10 (WI-3546, direct `psql` on both boxes, paired rows both directions). **Inherited, not re-witnessed this pass** — and P-003/WI-5055's later baseline (2026-07-17) found cross-machine federation dead ~3 days with 4 VM-side merge cursors frozen, root cause owned by the git lane (WI-4070, stale VM code tree). A fresh two-box witness is owed before ship; it is the natural companion to row 34 |

---

## 3. Release blockers, in order

> **ADDED 2026-08-09 — these two outrank everything numbered below.** They are listed ahead of the
> original list rather than renumbered into it, so the pre-existing numbering stays quotable.

> ⚠ **SUPERSEDED 2026-08-16T03:0xZ (su-c531b, WI-37110) — BOTH of the two rows below are now
> TERMINAL, and a NEW row 0 outranks them.** Verified in PG, not inferred: `WI-37195` = **done**,
> `WI-37144` = **dropped**. Row B's premise ("the gate is DARK, timer stopped") is additionally
> FALSE as of today — the timer is armed and firing (53 runs since 2026-07-27; last 02:47:29Z;
> next 03:39Z). Read row 0 first; A and B are kept verbatim below for quotability only.

**0. THE CORE P2P LEG HAS NEVER BEEN MEASURED — this is the governing GO/NO-GO fact.**
   *Filed 2026-08-16 by su-c531b (WI-37110). This is an ABSENCE of evidence, not evidence of a
   defect — do not quote it as either "p2p is broken" or "p2p is unverified-but-probably-fine".*

   Measured directly from `~/.papercusp/live-fed-gate/verdicts.jsonl` (53 runs since 2026-07-27):

   | | |
   |---|---|
   | gate runs since 2026-07-27 | **53, all RED** |
   | runs where `local_matrix` ACTUALLY EXECUTED | **1** (2026-08-16T02:47:29Z → FAIL) |
   | runs where it was never reached (`leg='?'`) | **51** |
   | `SKIPPED-CONTENT-RED` | 1 |
   | `last-matrix-green` | **2026-07-27T02:00Z — 481h stale** against a 144h `MATRIX_TTL_H` |

   `local_matrix` is the 18-scenario leg carrying the core federation behaviour this release is
   about — `membership_churn`, `content_bidir`, `replication_soak`, `restart_durability`. It has
   run **once in 20 days**. So the honest GO/NO-GO position is that we hold **no current
   measurement** of core p2p behaviour, in either direction.

   **Why 51 runs never reached it (now FIXED, not by me):** the attestation write-preflight
   early-exited the *entire* gate on a credential wall that none of the 18 scenarios touch.
   Fixed by **su-0c703449 under `WI-39359`** at 2026-08-15 22:13 EDT (`live-federation-gate.sh`
   :1005–1044, commits `616a8328` + `210e7bc1`): the gate now runs the attestation-INDEPENDENT
   leg anyway and reports GitHub-dependent legs as `SKIPPED-ATTESTATION-WALL`. That fix is what
   let `local_matrix` be reached at all today.

   **Why the one execution still failed — a RACE, not a defect.** The build leg waited on a
   sidecar reader lock held by a live `bin/tauri-guarded dev` (pid 1332180), so
   `src-tauri/sidecar/bin/node` was still absent when `local_matrix` ran →
   `FATAL: sidecar node binary missing`. The rig itself was **healthy** on that run (network up,
   3 frames provisioned, `frames ssh-ready`) — it died on the missing binary alone. The sidecar
   finished building 02:58:16Z and `check-sidecar-freshness.js` now reports it fresh
   (`gitHead e179e487`). **Before reading any repeat of this as a regression, check sidecar
   freshness and whether a `tauri-guarded dev` process holds the lock.**

   **Flip condition:** one gate run in which `local_matrix` reports `OK`. No forcing is required
   or wanted — `local_matrix_due()` keys its cadence off `last-matrix-**green**`, not the last
   run, so a failed attempt does **not** reset the window and the leg stays DUE. The next
   unforced attempt is the 03:39Z timer. (Forcing it evicts 24 exclusive cores, 104–127, from
   peers on a shared box for zero schedule gain.)

   **⚠ The attestation wall is UNCHANGED and OWNER-GATED — and a `SKIPPED` leg is NOT it
   clearing.** Re-probed read-only 2026-08-16T03:0xZ: `papercupai` holds a valid token *with*
   `gist` scope but the account is **`email_unverified`** (GitHub 422 on `POST /gists`:
   "user must have a verified email"); `aviynw` has **no `oauth_token` key at all** in
   `hosts.yml` ("the token in default is invalid"). Both fixes are owner-only. Proof the wall is
   cleared = `attestation-write-preflight` reporting **OK with a minted gist** — *never* a SKIP.
   See fact `wall:p2p-release-gate-github-attestation-accounts`.

**A. C-001 — consent withdrawal does not cut on the from-repo path (`WI-37195`).** The single
   hardest blocker on this document. `from-repo-witness` reds with `epoch advanced 0→0`; a removed
   contributor is not actually cut off. **Confirmed real on a quiet box**, so the earlier
   `SKIPPED-STARVATION` reading is dead. ~~Narrowed to **target resolution on one path**~~ —
   `revocation_kcut` passed the same run with the epoch advancing `0→1`, proving the re-key
   machinery itself is sound. Owner: su-9228f under D-022. Flip condition: `from-repo-witness`
   green on a gate run with the epoch advancing, plus a recurrence guard. ⚠ This row directly
   contradicts §5's "no longer a skip — covered and green (2026-08-01)" entry for the same leg;
   §5 records a real green that has since REGRESSED — read both.

   ⚠ **UPDATE 2026-08-09T11:01Z (su-c2f97, WI-37144) — THE BREACH NO LONGER REPRODUCES, and the
   "target resolution" narrowing above is FALSIFIED.** Instrumenting the gate's own K2 call (which
   had been discarding its result to `>/dev/null` for four days) caught the revoke being **rejected
   at the OWNER GATE**: `revoke_contributor → {"ok":false,"code":"not_owner"}`, returning before
   `loadTargetPubkeys` is ever called. So `:194 no_target` was never on the path — do not resume
   that hunt. After su-9228f's tri-state gate (`ac5a457eba`) and a **sidecar rebuild**, the same
   script/args now measure: `revoke_contributor → ok:true`, `K2 REVOKE … epoch advanced 0→1: PASS`,
   boot event `rekey_boundary_applied … newEpoch=1 distributed=1`, and — the breach itself —
   `K4b CONTENT CUT … PASS (B-read=no, A-has=1)`.

   ⚠ **This is NOT a flip to 🟢, and must not be quoted as one.** It is ONE standalone witness run,
   not a gate run; the flip condition above is unchanged and still requires a green gate leg plus a
   recurrence guard — and the gate that would produce that verdict is itself blocker B. One
   residual leg is still red: `K3 CUT FAIL (B_DEV-new=0 remaining-on-B=0 A-new=1)`. Its security
   half HOLDS (B has no epoch-1 key); what fails is the **non-vacuity control** asserting the
   remaining members' epoch-1 rows still crossed to B. Undecidable on a 2-member hive — the only
   "remaining member" is A, the re-key's own origin — so it needs a 3-frame run to separate "stale
   control" from "key distribution regressed". Unsettled, referred to su-9228f as C-001's owner.

   ⚠ **Method note worth keeping:** the first re-run was WORTHLESS and looked authoritative. The
   smoke script asserts only that `serve.mjs` EXISTS, never that it is CURRENT, so it silently
   measured a bundle built ~7h before the fix and printed a well-formed `not_owner` about a gate
   that no longer existed. **Any probe whose subject is a BUILT ARTIFACT must assert a marker from
   the fix under test** — a static staleness guard keyed on `owner_key_unreadable` now refuses a
   pre-fix bundle, proven falsifiable by tier-2 copy-out.

**B. The standing live-federation gate is DARK (`WI-37144`).** Timer stopped 2026-08-07T04:35:31Z,
   disabled 04:36:29Z; the reds were all real. This is the detector failure that let C-001 run
   unnoticed, so it is a blocker in its own right and not merely operational hygiene.

   ⚠ **CORRECTED 2026-08-09 — the cause was the OWNER, not a concealed red.** This row previously
   read "57s after a 5th consecutive RED, with no recorded decision", implying someone switched off
   a gate that kept failing. Falsified: session `d699c658` turn 20 [owner:Avi 2026-08-07T04:34:50Z,
   verbatim] *"nvmd i know what it is, just stop it"* — over **CPU churn**, three minutes before
   *"I still hear my computer churning. why?"*. The stop was mid-run and the 25s adjacency to the
   run's `last-run` stamp is coincidence. The real process defect is narrower and still open: the
   pause was never recorded on any work-item, Decision or coord message.

   Flip condition — timer re-armed and producing verdicts. Originally THREE things; **(iii) is
   now CLEARED, so TWO remain:**
   (i) `replication_soak` (`WI-5481`, 5/5 runs, load hypothesis falsified by frame PSI
   `avg10=0.00` against host loadavg 42-51); (ii) `restart_durability` (new, untriaged) — both so a
   re-armed gate is readable rather than permanently noisy; and ~~(iii) **`WI-37464`: a RED gate
   has no firing suppression at all**~~ → **✅ CLEARED 2026-08-12.** The three-tier fresh-exit
   backoff shipped 2026-08-09T12:17Z and was live-verified 2026-08-12T19:30Z (fresh red ⇒
   `GATE: FRESH-RED` rc 0 sub-second; a 7h-old red correctly takes NO fresh exit — the control that
   proves it is age-conditional). `WI-37464` is closed, `completionAuthority=committed`.
   ⚠ Re-arming also reverses an explicit owner instruction (wall
   `wall:live-federation-gate-timer-owner-stopped`) — it is owner-gated, not an agent call.
   Recorded as a plan Decision so it is addressable rather than prose:
   **`p2p-public-release-remaining-lanes-2026-07-16#D-026`** — read that body, not this summary,
   before acting on the timer. (The pause itself was never recorded anywhere addressable; that
   omission, not a concealed red, is the §5 process gap this closes.)

1. **~~LIVE-2 acceptance drill (row 22, P-205)~~ → RE-SCOPED 2026-08-01 to a named bug:
   `WI-6680` (the packaged host never ticks the executor).** The drill HAS now been executed
   (row 22): the revocation half of the lifecycle is proven, including **federated** reap
   across frames — a host withdraws consent and the *other* machine fails closed on its
   in-flight session and says why in a receipt. What is still unproven is the **spawn** half,
   and the reason is no longer "nobody has run the exercise" — it is a specific defect the
   drill surfaced:

   > On a packaged install the `p2p-work-intake` routine **never seeds**, so nothing ever ticks
   > the offer→pull→spawn chain. Two paths, both live-observed: (a) `projectDirForSlug` returns
   > null in the sidecar (harness-registry miss); (b) worse — on a first boot `activeWorkspaceId()`
   > resolves `'default'`, the seeder correctly refuses, and the once-guard **latches**, so
   > *zero* of the three p2p host routines seed for the process lifetime (this also disables the
   > row-17 supervision sweep and orphan cleanup). Same class as WI-5780, new manifestation.

   Consequence for GO/NO-GO: the spawn leg is **dead code on every shipped host** until WI-6680
   lands — which is precisely the state D-004 forbids ("a spawn leg no production path ever ticks
   is dead code"). This is a bounded, schedulable fix, not an open-ended exercise.

   > ⚠ **CORRECTED 2026-08-08 (WI-7312) — the two paragraphs above are too strong, and row 22's
   > `spawn ✗ NOT EXERCISED` is FALSE. Do not quote either as-is.** The **delegated-seat spawn
   > honor** path was exercised end to end on the **real 2-machine rig** (Linux tower → Avis-iMac,
   > a **packaged** install: `/Applications/Papercusp Server.app/…/sidecar`, migration 759), and it
   > ticks on a shipped host **today**:
   >
   > - **refused branch** — `spawnreq-175c81e1e4c0ed7f` published 15:34:26Z, drained 15:34:26.720Z,
   >   applied on the peer, honor hook ran 18:00:02.500Z →
   >   `[work-offers] spawn-request … → refused (expired)` + receipt `425b8ab1` (a correct refusal:
   >   the peer was down ~2.5h of the offer's life).
   > - **honored branch** — `spawnreq-cb07e7849aebbb43` published 18:07:19Z → drained 18:07:21Z →
   >   `honored (1 member(s) opened)` 18:07:28.967Z + receipt `af20b5e3` → member presence 18:07:44Z.
   >   ~10s publish→honor.
   >
   > **Why this does not contradict WI-6680:** that defect is about the `p2p-work-intake` routine
   > never seeding, i.e. the **pull** chain. The delegated-seat honor path is **push**-driven — the
   > hyperbee replication-apply of the `p2p-work-offers` projection invokes the honor hook directly
   > and never consults work-intake. So WI-6680 kills the *pull* leg, not this one; "dead code on
   > every shipped host" over-generalises from one to the other. WI-6680 remains real and worth
   > fixing on its own terms.
   >
   > **What is still NOT proven** (so this correction is not a green light): the honored member was a
   > **phantom** — success receipt and a presence row, but no window, no process, and an EMPTY
   > `projects/` dir, i.e. not one turn ever taken. Filed as **WI-35786**; likely the known macOS
   > logged-out class (the honor log itself records that the account's usability "was ASSUMED, not
   > verified"), NOT the GUI-console cause first suspected. So: **spawn orchestration + receipts are
   > proven; a delegated member doing useful work is not.** Diagnose the phantom in ~30s with
   > `find <session-dir>/projects -type f | wc -l` = 0.
   >
   > Note also that this run used two **physical machines** on the real network, unlike row 22's
   > container-frame/private-testnet environment — relevant to the rig debt row 35 tracks, though
   > it exercised only this leg.
   ⚠ Do **not** read row 22's revocation green as containment: it proves an *honest* session
   **winds down** on withdrawal. It does **not** prove a hostile one is stopped — mechanical kill
   (revocation-reaper deferred #1: cgroup / dedicated OS user after the X13 wind-down) is P-105
   tier and **UNBUILT**, and D-001 deliberately ships v1 without it, on the user-trust chain alone.
   Residue also carried from row 22: metering substrate is live but has **no production writer**.
   Push-nudge is no longer residue: D-035 retired its obsolete protocol target (row 23).
2. **hive-git live legs (row 34).** Owned by `p2p-git-live-activation-2026-07-09`; do not
   duplicate its diagnosis.
3. **Gate coverage gaps (§5).** ~~Two of three~~ **RESOLVED 2026-08-01 for the from-repo pair —
   ⚠ but COVERAGE ONLY; `from-repo-witness` has since REGRESSED to RED (blocker A above, C-001,
   2026-08-09) and the gate producing these verdicts is now DARK (blocker B).** Read this row as
   "the legs are wired and were once green", never as "these legs are green now":
   both legs were enabled by D-016 and were **covered and GREEN** on a real gate window
   (run `20260801-143855`, `from-repo=PASS from-repo-witness=PASS`). `membership_churn`:
   **the substantive question is now ANSWERED — it PASSES on a real 3-frame rig.** The manual
   run landed 2026-08-01 15:14 and is banked at
   `~/.papercusp/live-fed-gate/triage/scn.membership_churn-151402.log`:
   `membership_churn OK (roster a=2 b=2 c=2; backfill=hello-world|remote; C→A='hello-world'
   C→B='hello-world')` — i.e. late-joining frame c converges the roster, backfills, and reaches
   full mesh in both directions (`content_bidir` passed in the same run). `CPUSET_C` is
   configured and working (128-core box ⇒ default `104-111`; frames were pinned exclusively).
   ⚠ **What is still open is the GATE PLUMBING, not the behaviour:** `last-matrix-verdict` still
   reads 2026-07-27 02:00 UTC, and with `MATRIX_TTL_H=144` that verdict does not expire until
   2026-08-02 02:00 — so the gate goes on deferring its local-matrix leg to a verdict that
   *predates the `--frames=3` flip* and therefore never included this scenario. **Do not stamp
   the marker from the manual run:** that run was `--only=content_bidir,membership_churn`
   (2 of 18 scenarios), and a full-matrix marker written from a 2-scenario run would assert
   coverage nobody produced — the exact false-green class D-018 exists to stop. The honest
   close is a full local-matrix run (or a marker whose scope is per-scenario rather than
   whole-matrix).
4. **Code-signing certs (§4).** Owner-supplied input, arriving when it arrives.

Rows 1–3 are agent work. Nothing on this list is waiting on a decision.

---

## 4. Owner-supplied inputs (👤 — pending arrival, NOT open asks)

**D-002** [owner:Avi 2026-07-17] is explicit: *"stop asking about these, we can get everything else
ready before these, I'll give you these when I have them."* These rows are therefore recorded as
known-pending inputs and are **not** re-surfaced as asks in status reports, escalations, or
GO/NO-GO prep. Everything else proceeds to ready in the meantime.

| Item | State |
|---|---|
| Code-signing certs — Windows Authenticode + Apple Developer ID | Pending owner supply. Until then the mac app is unsigned/un-notarized (`spctl -a` = "rejected: no usable signature") and Gatekeeper blocks a downloaded install. Gatekeeper/arm64 items that depend on the certs inherit the same posture |
| Open signup (`papercusp-open-signup`) | Dark by owner authority — `/auth/signup` is internet-reachable via the tunnel; owner flips after the auth-tier rollout |
| Own-log-fork auto-recovery (`papercusp-own-log-fork-auto-recovery`) | Dark by owner authority — performs a destructive per-harness Corestore store reset; detector still files a durable EI naming the supported MANUAL recovery |
| mem0 federation egress (`papercusp-mem0-federation-egress`) | Dark by owner authority — privacy (D-006 of the mem0 plan); opt-in `shareable` egress |
| Multi-owner-pot ban lift + cross-pot v1 scope | Owner decision, criteria in the LIVE-1 runbook |
| ~~P-105 foreign-work isolation~~ | **CLOSED** by D-001 — v1 ships with spawn live and trust-layer-only security. No longer a wall |
| ~~Hetzner account lock~~ | **MOOT** — all proofs are local per the standing rig posture |

---

## 5. Skip rows — explicitly NOT green (D-015 §2)

| Leg | Why it did not run | Flip condition |
|---|---|---|
| `from-repo` | Gate ran with `SKIP_FROMREPO=1`, a standing skip-by-default | 🟢 **NO LONGER A SKIP — COVERED AND GREEN (2026-08-01)**. D-016 flipped the default 1→0; gate run `20260801-143855` then actually EXERCISED it: `GATE: GREEN — content-matrix=PASS from-repo=PASS from-repo-witness=PASS local-matrix=SKIPPED build=OK` (2026-08-01T15:01:14Z, service journal). `from-repo.out` closes `OVERALL: PASS — create-from-repo → discover → join → BIDIRECTIONAL + continuous hive federation proven end-to-end (sidecar mode)` |
| `from-repo-witness` | Same | 🔴 **REGRESSED 2026-08-09 — C-001, `WI-37195` (release blocker A, §3).** The green below is REAL but HISTORICAL; do not quote this row as current status. The recurrence this row itself warned about has happened, and it is confirmed real rather than transient: reproduced on a quiet box with `epoch advanced 0→0`, while `revocation_kcut` passed the same run with the epoch advancing `0→1`. ⟨historical record follows⟩ 🟢 **NO LONGER A SKIP — COVERED AND GREEN (2026-08-01)**, same run. `WITNESS OVERALL: PASS` proves on the packaged binary: owner-enforcement (`AK ban (B's op DROPPED on A, EN-4): PASS` + unban teeth PASS), the C-001 re-key cut at device granularity (K1 held the pre-revoke epoch key → K3 `B_DEV new-keys=0, remaining-on-B=1, A-new=1`), and the content-level cut (K4b `B-read=no, A-has=1`). First live green since its blocker WI-5783 was fixed (root cause: two concurrent boot/merge passes on the owner's instance, pot/home slug vs the owner's member sub-harness slug). ⚠ Two `from-repo-witness` REDs fired 2026-07-31 (23:00Z, 00:02Z); their logs are gone from `/tmp` and the run banked no frame `serve.log`, so they remain **unattributed** — "transient" is the likely reading, not a proven one. Treat any recurrence as a real regression: it is no longer an expected red. **✅ That instruction was correct and has now been exercised — the 2026-08-09 recurrence WAS a real regression (C-001 / `WI-37195`), confirmed on a quiet box. The two unattributed 07-31 REDs should be re-read in that light: "transient" was the convenient reading, not the proven one, and the same leg has now failed for a real cause.** |
| `membership_churn` (order 35) | Needs a third frame; the gate ran `FRAMES=2`, so it had **never executed** in the gate's history (D-007). Until 2026-07-25 this exclusion was silent; it is now a declared SKIP with a stated reason and is covered by the roll-call invariant | 🟢 **FIRST-EVER EXECUTION — AND IT PASSES (2026-08-01).** The P-425 flip (`--frames="${MATRIX_FRAMES:-3}"`) had landed but the gate's local-matrix leg is TTL-deferred, so the leg still had no verdict of its own. Produced one directly with a 3-frame run on the freshly-repacked gate artifact: `✓ PASS membership_churn — membership_churn OK (roster a=2 b=2 c=2; backfill=hello-world\|remote; C→A='hello-world' C→B='hello-world')` — i.e. 3-node roster convergence, a **non-vacuous** backfill leg, and full mesh from the late-joining frame c. Run: `local-matrix.sh --frames=3 --only=content_bidir,membership_churn`, exclusive cores a=120-127 b=112-119 c=104-111, banked triage stamp `151402`. `content_bidir` was included deliberately — without it `membership_churn` finds no `F-A2B` row and silently downgrades its backfill leg to "verified vacuous". ⚠ **SCOPE: this proves the leg, NOT full-matrix coverage** — the run's own verdict says `all 2 EXECUTED scenarios green, but 16 of 18 registered were SKIPPED: this is NOT full-matrix coverage`, and it did **not** write the gate's `last-matrix-verdict`. The standing 18-scenario verdict still lands on the gate's own next window |

---

## 6. Named accepted residual risks (ship-with)

| Risk | Statement |
|---|---|
| **Sub-grace churn invisibility (D-008)** | The rig runs `RIG_REPLICATION_GRACE_MS = 15000`; production runs `DEFAULT_REPLICATION_STALL_GRACE_MS = 180000` (`sync/hyperbee/boot.ts:171`) — production is ~12× more permissive, so a churn event that resolves inside production's 180s window is **invisible** to the rig. **A green gate is a canary for the replication-stall/zombie-peer class, not a proof of production safety for it.** D-008 permits either adding a production-grace leg to the gate or naming this as an accepted risk; **this document takes the second option, explicitly.** OPEN + UNVERIFIED: whether the observed fixed ~13.0s churn interval is the same constant in production as on the rig — if it is rig-specific the exposure argument must be re-derived, not restated |
| **WI-5441 boot-window assignment hole** | Row 13 — consciously waived, documented, tracked |
| **Symmetric NAT** | Documented limitation; needs a real middlebox to verify |
| **DHT stale-announce zombie window** | Self-heals at the DHT record TTL (≤19 min); detector + active recovery shipped |
| **G2 usage-events capture trigger** | Deliberate GA deferral (trigger attaches at the GA migration); tracker WI-1858 |
| **G8 no un-revoke path** | One-way revoke; workaround = re-invite as a fresh device/epoch. Note the corrected fact: `grantEpochKeysToMembers` grants full `[0..current]` history to any new admission — a per-identity epoch-floor guard is owner-decision follow-up WI-3566 |

---

## 7. Flag posture (verified at HEAD, 2026-07-27)

| Flag | Default | Status |
|---|---|---|
| `papercusp-p2p` (`FLAGS.P2P`) | **ON** | 🟢 test-guarded (FS-D5: must default ON, must not be dark) |
| `papercusp-hive-rekey` (`FLAGS.POT_REKEY`) | **ON** | 🟢 not in `KNOWN_DARK_FLAGS` |
| `papercusp-github-bridge` (`FLAGS.GITHUB_BRIDGE`) | **ON** | 🟢 not in `KNOWN_DARK_FLAGS` |
| `papercusp-presence-gossip` (`FLAGS.PRESENCE_GOSSIP`) | **ON** | 🟢 **GRADUATED 2026-07-16** via the LIVE-1 P-059 drill (coordination lane) — it is no longer a dark cutover row. Prior versions of this ledger listing it as dark are stale |
| `papercusp-open-signup` | OFF | 👤 registered dark, case `owner-authority` |
| `papercusp-own-log-fork-auto-recovery` | OFF | 👤 registered dark, case `owner-authority` (destructive) |
| `papercusp-mem0-federation-egress` | OFF | 👤 registered dark, case `owner-authority` (privacy) |

`DARK_FLAGS_HIGH_WATERMARK = 13` (governs the parked/incomplete subset only);
`DARK_FLAGS_REVIEW_BY = 2026-08-09`. **This program added no parked/incomplete dark-flag debt** —
its three dark flags are all `owner-authority` kill-switches, which the watermark does not ration.

---

## 8. Discrepancies found during this resynthesis

1. **The gate was green for ~3.6h and nobody knew.** It passed at 02:00:39Z; at 05:45Z the plan's
   `## Now` still described the verification run as in flight, P-402 was still `wip`, and the
   announced event had never been emitted. **A gate that goes green silently is
   indistinguishable from one that never did.** Machine state and program state disagreed for
   hours with nothing reconciling them. Fixed this pass (event emitted, P-402 closed, Now
   rewritten, D-015 recorded).
   ⚠ **The rule this item used to carry — *"the verdict lives in the service journal — the marker
   file is a claim, the journal line is the evidence"* — was FALSIFIED on 2026-08-12 (WI-38285)
   and must not be repeated.** The journal holds the verdict only when the run went through
   systemd; a bare `./live-federation-gate.sh` never touches journald at all, and a manual
   `systemctl start` of the SERVICE leaves service entries and no timer ones. So the journal
   answers about the TIMER and lies by omission about the GATE — which is how the
   2026-08-12T11:12:50Z GREEN became unrecoverable while the rule above said the evidence
   existed. Since the timer was owner-stopped on 2026-08-07 **every** run is a hand-run, so this
   was the normal case, not an edge case.
   **Corrected rule: the verdict lives in `$STATE_DIR/verdicts.jsonl`** — every terminal path now
   emits through `verdict()`, which banks a structured record (verdict token, per-leg breakdown,
   matrix skip reason, HEAD, systemd-vs-hand invoker, pid, run dir) and then echoes the identical
   line. The marker files remain what they always were — bare epoch integers, a claim and never
   evidence. Fixed 2026-08-12 in `papercusp-desktop/bin/live-federation-gate.sh`; guarded by
   `packages/operator-core/lib/live-federation-gate-verdict-bank.test.ts`, whose static leg fails
   if any future terminal path goes back to emitting its own `echo`.
2. **Work-item ledger diverges from plan-item ledger on four rows.** `P-301`→WI-5136 `todo`,
   `P-402`→WI-5137 `todo` and WI-5064 `open`, `P-104`→WI-5130 `blocked` — while all four plan
   items read `done`. ⚠ **Do not attribute this to WI-6218** (skipCompletionGate stamping
   `terminal_owner` over an existing completion): that item is closed, and the live measurement
   it was asked for found **ZERO rows with the damage signature** across 30 days of
   `engineer_issues` + `harness_features_consolidated`. This is a *different*, still-unexplained
   plan-item↔work-item sync divergence. **Deliberately not mass-flipped here** — flipping four
   states to match a hypothesis is exactly the stale-state-flip pattern this ledger has caught
   three times (WI-1534, WI-971, WI-2009). Filed for root-cause as **WI-6303** instead
   (`system:plan-item-lane-sync` is the visible writer). Note P-402 has **two** work-items
   linked to it, and `source_plan_item_ids` is empty for every item on this plan — both worth
   checking as part of the same root cause
3. **Plan-item id ≠ work-item id.** P-405's work-item is **WI-5139**; `work_items:get P-405`
   returns not-found, and a checkpoint written against `P-405` goes nowhere. The linkage lives in
   `work_items.payload->'plan_item'`, not in `source_plan_item_ids` (which is empty for this
   plan's items).
4. **A stale "must not self-ratify" note in the git lane** contradicted that lane's own D-001 and
   had been carried forward twice by agents reading `## Now` instead of `## Decisions` — corrected
   by that lane 2026-07-27. Same class as #1: prose drifting away from the structured record.
5. **The `SKIP_FROMREPO` skip outlived BOTH of its own stated reasons, in writing, in two files.**
   The systemd unit said *"expected-RED while WI-971 is open … flip to 0 when WI-971 lands"* —
   WI-971 landed and was live-verified twice (WI-5775). The gate script said the leg's witness
   sub-probe was failing for an unrelated reason, WI-5783 — which is closed. So both artifacts
   carried their own satisfied flip condition and neither was flipped, because the script had
   explicitly deferred the call to the p2p-release leader and nobody had made it. Made this pass
   as **D-016**. The general shape is the same defect as #1 and #4: *a condition changed and the
   artifact describing it did not.* When you write "flip this when X lands", something has to
   watch X — a comment is not a watcher.

---

## 9. Provenance

Rows evidenced by `-220032` logs were read directly from the scenario bank of gate run
`m1785117063` during this pass. Rows evidenced by a WI completion were read from that work-item's
terminal completion record. Row 35 is explicitly marked inherited. Binding decisions cited:
**D-001** (spawn-live posture, owner), **D-002** (cert posture, owner), **D-007** (2-frame gate /
membership_churn), **D-008** (gate fidelity vs production grace), **D-009**–**D-013** (the
fresh-join diagnosis chain), **D-015** (first-green earned + the skip-row rule) — all on
`p2p-public-release-remaining-lanes-2026-07-16`.

Companion calibration doc: `agent-insights/federation-public-release-known-limitations.mdx`.
