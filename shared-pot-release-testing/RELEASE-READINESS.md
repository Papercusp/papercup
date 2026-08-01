# Shared-Pot P2P — Public-Release GO/NO-GO (signed)

**Question:** can we confidently ship the shared-pot (P2P federated) feature to public production?

**VERDICT — updated 2026-08-01T19:15Z (originally 2026-07-27T06:05Z): NO-GO for unconditional
public ship. CONDITIONAL-GO on three named rows** (was four). The substrate is release-grade and
now has an EARNED green gate that no longer skips legs; what is missing is end-to-end live proof
of the work-distribution lifecycle, live proof of the hive-git plane, and one owner-supplied
input. Nothing below is waiting on a decision — every open row has a named owner and a concrete
flip condition.

> **The gate-coverage condition is CLOSED (2026-08-01).** All three formerly-skipped legs now have
> real verdicts: `from-repo` and `from-repo-witness` ran and PASSED on gate run `20260801-143855`
> (`GATE: GREEN — content-matrix=PASS from-repo=PASS from-repo-witness=PASS local-matrix=SKIPPED
> build=OK`, 2026-08-01T15:01:14Z), and `membership_churn` **executed for the first time in its
> history and passed** on a 3-frame rig. Details + scope caveats in §5. Closed by su-e02f5c3d
> under the standing owner instruction to drive the remaining p2p lanes to release-ready.

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
| 7 | Revocation READ cut-off (epoch K-cut) applies live | 🟢 | `scn.revocation_kcut-220032.log` — `revoke.live=true` (a real read cut, not a write-plane block); pre-ban content stays readable per epoch-0 semantics |
| 8 | Replication liveness detector + restart soak | 🟢 ⚠ | `scn.replication_soak-220032.log` — "OVERALL: PASS — 5 kill/restart cycles: live replication re-established BOTH directions within 90s every cycle; detector quiet". ⚠ carries the D-008 residual risk, §6 |
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
| 22 | **LIVE-2 end-to-end acceptance drill** (offer→pull→spawn→receipts→revocation, every leg observable from the origin, any silent leg = FAIL, on the 2-machine rig) | 🔴→🟡 | **RUN 2026-08-01 (P-205/WI-5135) — no longer "never run", but NOT a full pass; read the leg-by-leg, not the headline.** Single-box drill `PASS=12 FAIL=0 SKIP=6` (packaged deb, `bin/work-distribution-drill.sh`) **+** the federated-revocation leg proven cross-node by a NEW registered matrix scenario `bin/lib/scenarios/fed-reap.sh` (order 59), run `m1785612213`: `b: grant\|revoked\|remote → session\|reaped → receipt work-offer:reap`, with the ACTIVE-grant baseline passing first so the reap is *attributable*. Against this row's own bar: **offer ✓** · **pull ~** (X11 activation + the WI-3629 seam ship in the packaged bundle, but no live pull was ever exercised — nothing ticks it) · **spawn ✗ NOT EXERCISED** · **receipts ✓** (offer-threaded, single-box *and* cross-node) · **revocation ✓ local AND ✓ federated**. ⚠ Environment: 2 **container frames** on a **private testnet DHT** — *not* two physical machines, *not* the public DHT (sufficient for this leg because `origin='remote'` keys on hyperbee source-log/device provenance, not a physical boundary — but do not quote it as the 2-machine rig; row 35 still owes that). ⚠ Both proofs used a **SEEDED**, not spawned, foreign session — see the blocker note below. Also landed: **D-018** — this drill's SKIP census was six *hardcoded strings* whose reasons had rotted into falsehood (5 of 6 false; one contradicted the drill's own header), so a clean run would have produced a plausible, quotable, WRONG reading; every reason is now DETECTED at runtime from the artifact under test |
| 23 | Push-nudge wiring (latency only, never correctness) | 🔴→🟡 | BLOCKED (P-203/WI-5133, behind the same fresh-join class as WI-5863). **Not ship-blocking**: it is a latency optimisation; without it federation still converges on the poll cadence. Recorded as a deliberate ship-without |

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
| 34 | hive-git P2P plane — LIVE legs | 🔴 | **Unproven, actively in flight** (lane `p2p-git-live-activation-2026-07-09`, WI-6276, as of 2026-07-27T04:30Z). The lane's own reading: the rig's entire log shows pot-git serves **100% REFUSED (8/8)** — never one successful fetch — so *"any clean reading is a FALSE GREEN"*. The rig is warm, so the G-8 bootstrap short-circuits every tick; a genuine cold condition was staged at 04:30:27Z. EI-18765930091826096 (channel degrades until it serves nothing; only a restart clears it) is fixed + deployed, with WI-6272 adding the detector whose absence made it take days. **Release-blocker #2** |
| 35 | Cross-platform witness — Linux tower ↔ mac VM | 🟡 | Coord/data-merge bidir was LIVE-PROVEN 2026-07-10 (WI-3546, direct `psql` on both boxes, paired rows both directions). **Inherited, not re-witnessed this pass** — and P-003/WI-5055's later baseline (2026-07-17) found cross-machine federation dead ~3 days with 4 VM-side merge cursors frozen, root cause owned by the git lane (WI-4070, stale VM code tree). A fresh two-box witness is owed before ship; it is the natural companion to row 34 |

---

## 3. Release blockers, in order

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
   ⚠ Do **not** read row 22's revocation green as containment: it proves an *honest* session
   **winds down** on withdrawal. It does **not** prove a hostile one is stopped — mechanical kill
   (revocation-reaper deferred #1: cgroup / dedicated OS user after the X13 wind-down) is P-105
   tier and **UNBUILT**, and D-001 deliberately ships v1 without it, on the user-trust chain alone.
   Residue also carried from row 22: metering substrate is live but has **no production writer**,
   and push-nudge stays deferred (row 23).
2. **hive-git live legs (row 34).** Owned by `p2p-git-live-activation-2026-07-09`; do not
   duplicate its diagnosis.
3. **Gate coverage gaps (§5).** ~~Two of three~~ **RESOLVED 2026-08-01 for the from-repo pair:**
   both legs were enabled by D-016 and are now **covered and GREEN** on a real gate window
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
| `from-repo-witness` | Same | 🟢 **NO LONGER A SKIP — COVERED AND GREEN (2026-08-01)**, same run. `WITNESS OVERALL: PASS` proves on the packaged binary: owner-enforcement (`AK ban (B's op DROPPED on A, EN-4): PASS` + unban teeth PASS), the C-001 re-key cut at device granularity (K1 held the pre-revoke epoch key → K3 `B_DEV new-keys=0, remaining-on-B=1, A-new=1`), and the content-level cut (K4b `B-read=no, A-has=1`). First live green since its blocker WI-5783 was fixed (root cause: two concurrent boot/merge passes on the owner's instance, pot/home slug vs the owner's member sub-harness slug). ⚠ Two `from-repo-witness` REDs fired 2026-07-31 (23:00Z, 00:02Z); their logs are gone from `/tmp` and the run banked no frame `serve.log`, so they remain **unattributed** — "transient" is the likely reading, not a proven one. Treat any recurrence as a real regression: it is no longer an expected red |
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
   rewritten, D-015 recorded). Carry the rule: *the verdict lives in the service journal — the
   marker file is a claim, the journal line is the evidence.*
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
