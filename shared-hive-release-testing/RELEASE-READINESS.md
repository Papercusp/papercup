# Shared-Hive P2P — Public-Release GO/NO-GO Ledger

**Question:** Can we confidently ship the shared-hive (P2P federated) feature to public production?

# ❌ NO-GO today (2026-07-03) — but every open row is owned by an item of `shared-hive-p2p-release-readiness-2026-07-03`. No unowned unknowns.

**Maintained under plan `shared-hive-p2p-release-readiness-2026-07-03` P-001 (WI-1838, su-c02fa).
Last full evidence-verified reconcile: 2026-07-03.** Prior versions of this file (the 06-19/06-20
synthesis: D-001 skew, C-001/WI-280, A-003-just-closed era) are SUPERSEDED — see git history.
Companion calibration doc: `agent-insights/federation-public-release-known-limitations.mdx`.
Rule of record: **in-process green ≠ live green** — every green row below cites a live/local-rig
artifact or a CI-pinned test, not prose.

**Rig posture (D-001, owner 2026-07-03): Hetzner access is GONE. All proofs are LOCAL** —
(i) containerized 2-node matrix rig (`deb-hetzner-rig.sh` + `RIG_FRAME_IPS`, the mode that produced
run m1783013203), (ii) tower↔libvirt-VM rig (macbr0), (iii) mac VM (su-a1a71 dogfood),
(iv) single-box `two-instance-*-smoke.sh`. Historical Hetzner runs remain valid VM-grade evidence.

---

## GO/NO-GO checklist — one row per release criterion

Legend: 🟢 green-with-evidence · 🔴 open → mapped to an item of THIS plan · 🟡 partial → mapped · 👤 owner-waived / owner-authority.

### Substrate + correctness (verified green)

| # | Criterion | Status | Evidence (verified 2026-07-03) |
|---|---|---|---|
| 1 | Federation substrate min-bar: content/plan-part/coord-data bidir, concurrent LWW, restart durability, reconnect catch-up, revocation K-cut, coord control-plane — per owner-ratified min-bar D-006 (in-process multimember + 2-node live) | 🟢 | **8/8 matrix run `m1783013203`** (2026-07-02, containerized 2-node rig, `bin/deb-hetzner-matrix.sh`); recorded in `federation-release-hardening-relaunch-2026-07-01` ## Now (ALL 13 briefs done) + WI completionRefs. Earlier per-brief Hetzner runs = VM-grade proof. ⚠ Raw run log not retained in-repo — the plan record + per-WI completionRefs are the citation; P-013's standing gate makes this reproducible on demand. |
| 2 | Revocation READ cut-off (C-001 / epoch K-cut) live | 🟢 | WI-1329 `passed`: Brief 3 LIVE PASS 2026-07-02 (2 VMs, public DHT, ~90s negative assert; pre-ban stays readable — epoch-0 semantics). Matrix `revocation_kcut` green. `papercusp-hive-rekey` **default-ON**, not in DARK_FLAGS (`libs/flags/src/types.ts:998`). |
| 3 | Restart durability live | 🟢 | WI-1331 `passed` (2-VM cold restarts, no content/roster loss); matrix `restart_durability` green; scenario pinned `bin/lib/scenarios/b5-restart.sh`. |
| 4 | LWW convergence under clock skew — all 4 ordering sources fixed | 🟢 | Migs **446/458/459/460** (+ **466** node-id strong entropy) present at HEAD (`libs/papercusp/libs/db/sql/`); WI-1672 `resolved` (forced-tie PG integration test + 120-seed production-topology fuzz, monotone AND skew); matrix `concurrent_lww` byte-identical winner. Residual: WI-1684 (row #16). |
| 5 | A-003 class (owner→joiner roster/settings; no-restart first-poll federation) | 🟢 | WI-1378 + WI-1544 `resolved`; CI-pinned: `a003-scope-buffer-replay.test.ts` + `owner-roster-rebind-race.repro.integration.test.ts` at HEAD; matrix m1783013203 federated A→B **first-poll, no restart** on all 8 scenarios. |
| 6 | Long-running node stability (bg-host leak) | 🟢 | WI-1417 `resolved` (root: claude-sessions fs-sweep; live re-verify 2026-07-02: 5.7–5.8GB sawtooth plateau vs the old ~1GB/min climb; reaper storm gone; 3 recurrence-guard tests). WI-1089 `resolved`. *(known-limitations doc row was stale-red — fixed 2026-07-03.)* |
| 7 | Alpha ship gates (K-CUT GATE-1, cross-member browse GATE-2, flag posture GATE-3, admission/rekey audits) | 🟢 | Plan `shared-hive-public-release-2026-06-22` **complete** — shipped in alpha.2; WI-565/WI-566 audits re-verified (116 hermetic tests). |
| 8 | Data-completeness (table + column grain) | 🟢 | `federated-column-completeness.integration.test.ts` at HEAD + the 2 table-grain CI tests. `trusted_authors` local-only by design. |
| 9 | NAT / firewall / cross-region | 🟢 | Brief 8 LIVE (ash↔hil, restricted-cone NAT, 2026-07-02): holepunch both ways, member→owner PASS, owner→member late-not-never (→ WI-1534, row #16). Symmetric NAT = documented known limitation (needs a real middlebox). |
| 10 | Coord control-plane trust boundary (messages/escalations/handoffs federate; below-steer handoffs quarantined) | 🟢 | Matrix `coord_controlplane` both legs (ungranted → quarantine, steer-granted → applies). ⚠ **Ledger discrepancy**: WI-1510 is still `todo` in the WI ledger despite the closed-by-design disposition in two docs — residual real scope = the vacuous await-subscription probe; needs a close-or-rescope pass (flagged to fleet leader). |
| 11 | Flag posture | 🟢 | `FLAGS.P2P` **default-ON, test-guarded** (`production-defaults.test.ts:196` — must default ON + must NOT be dark, FS-D5). `papercusp-hive-rekey` default-ON. `papercusp-presence-gossip` in KNOWN_DARK_FLAGS as a registered **cutover** case (reader-before-writer; row #19). `papercusp-open-signup` dark by **owner authority** (👤, deliberate). |

### Open — mapped to `shared-hive-p2p-release-readiness-2026-07-03` items

| # | Criterion | Status | Owned by | Ground truth (2026-07-03) |
|---|---|---|---|---|
| 12 | Cross-machine fed_event replication (tower↔libvirt-VM) | 🔴 **the release-critical blocker** | **P-003** (su-6b811) + su-16e4c274's P-108 scope-federation lane | Replication dead BOTH directions despite healthy network (full-MTU DF ping 0% loss) + swarm connects; suspect scope-cores/corestore layer, VM core-key regen on restart. Success = `/tmp/p059-e1c.sh` + `/tmp/p059-rev2.sh` green + survives VM reboot. Source: `cross-machine-coord-parity-and-trust-2026-07-01` P-059 ## Now. |
| 13 | Replication-liveness detector + restart soak (WI-183 class: connected-but-dead replication is silent) | 🔴 missing | **P-004** (su-b5d1c) | No per-peer liveness signal exists today; ≥5 kill/restart soak + matrix scenario pin required. |
| 14 | Local rig canonicalization (one-command bring-ups, runbooks de-Hetzner'd) | 🔴 | **P-002** (su-cc992) | `/tmp/p059-*.sh`, `/tmp/vmcall.sh` not yet in-repo; `local-matrix.sh` wrapper absent; known-limitations Hetzner-wall callout obsolete per D-001 (P-002's edit). |
| 15 | LIVE-1 parity surfaces on the local VM rig (wake bridge+flood cap, receipts exactly-once, federated events, presence gossip H1-H3, claim-spec federation M6/M7/L9) | 🔴 blocked on P-003 | **P-005** → then **P-006** (PRESENCE_GOSSIP cutover: both operators booted flag-ON, 30-min roster watch) | In-process suites green; live 2-machine proof owed (`LIVE-1-parity-rig-runbook-2026-07-02`). |
| 16 | Post-min-bar correctness backlog → explicit verdicts (fixed+pinned OR documented ship-with-limitation) | 🔴 | **P-011** | **WI-1534** (`todo`, anti-entropy/unbounded staleness on quiescent hives) · **WI-1684** (`todo`, local-del resurrection, row-PRESENCE split-brain — fix or explicitly accept) · **WI-971** (`todo` — outbox drain never wired for joined/created hive harnesses; WI-259 closed as its dup ⇒ **from-repo joiner incremental federation is still an open question**) · HLC-vs-fed_ts S0 two-clock seam · G2/G8/G9/G24-27. |
| 17 | LIVE-2 work-distribution acceptance drill (offer→pull→spawn→receipts→revocation, every leg observable) | 🔴 unrun, blocked on P-002 | **P-007** | Spec = `p2p-work-distribution-2026-07-02` P-305 (WI-1751 `todo`). Verifies the p2p-hive-git fleet's build (P-301/P-303/P-201 landing now). |
| 18 | Attestation flow (second-device attestation, membership seeding, refused-op counters) | 🔴 unproven, blocked on P-002 | **P-008** | `p2p-work-distribution` P-003 (WI-1730 `todo`); adversarial probes (unattested device, wrong gh user-id) must increment counters. |
| 19 | Moderation witness (takedown + report federation) live run | 🔴 built-not-run | **P-009** | WI-283 `passed` = the witness is BUILT (MODERATION_PROBE=1 rider, static-verified 06-30) — it has **never executed**. Run on a quiet box; both legs must green on a CURRENT build. |
| 20 | 3-node multi-member coverage | 🔴 gap — now locally coverable | **P-010** | The old "2-server quota" wall is OBSOLETE under D-001: extend the containerized rig to 3 frames + membership churn. (D-006 accepted 2-node as min-bar; 3-node is the residual for public multi-member hives.) |
| 21 | Cross-platform witness (Linux tower ↔ mac VM) | 🔴 | **P-012** (coordinate with su-a1a71's dogfood lane — do not duplicate) | Content bidir + coord control-plane + restart catch-up with the same `fed_assert_*` core. |
| 22 | Standing local release gate (auto-catches green-rig/red-binary) | 🟡 armed but never green | **P-013** | WI-261 `resolved`: nightly systemd timer armed + firing (verified: fired 2026-07-03 04:40) — **but every run so far load-SKIPS** (today: load 16.78 > LOAD_GATE 15; box is fleet-saturated). Zero green scheduled runs. Also still `SKIP_FROMREPO=1` (unblock: WI-280 `resolved` + WI-1666 `resolved`, but WI-971 still gates the from-repo leg). P-013 = validate green, solve the load-gate-vs-busy-box conflict, fold in the matrix. |
| 23 | Final GO/NO-GO one-pager (signed checklist, flag-posture table, owner walls enumerated) | 🔴 | **P-014** (fleet leader su-17c98) | Blocked on P-003/P-005/P-007/P-009/P-013. This ledger is its input. |

### Owner walls (👤 — not agent-resolvable; enumerate in P-014)

| # | Item | State |
|---|---|---|
| 24 | Code-signing certs (Windows Authenticode + Apple Developer ID) | Required for public ship; owner-supplied. |
| 25 | Open signup (`papercusp-open-signup`) | Dark by owner authority — owner personally ratifies. |
| 26 | Multi-owner-hive ban lift + cross-hive v1 scope | Owner decisions (criteria in LIVE-1 runbook / P-014). |
| 27 | P-105 foreign-work isolation | ON HOLD — owner rethinking the worker-seat/foreign-spawn model. |
| 28 | Hetzner account lock | Moot for this program (D-001: all proofs local). Clearing it re-enables VM-grade reruns only. |

---

## Discrepancies found during the 2026-07-03 evidence pass

1. **WI-1510 ledger-vs-docs**: docs say "closed as designed behavior"; WI is `todo`. Real residual scope: the vacuous await-subscription negative probe. Needs close-or-rescope (flagged to fleet leader).
2. **known-limitations doc** showed bg-host leak (WI-1417) 🔴 open — actually `resolved` + live-re-verified 07-02. Fixed in the same pass as this rewrite.
3. **WI-259 "closed"** is a duplicate-close onto **WI-971, which is still `todo`** — anyone reading "WI-259 closed" as "from-repo incremental federation works" is over-reading. Row #16 carries it.
4. **m1783013203 raw log not retained** — the strongest single evidence artifact is cited by reference (plan ## Now + WI completionRefs), not by file. The P-013 standing gate is the durable replacement.
5. **The nightly gate has never actually run its smokes** — armed 07-02, but load-skipped every window so far on this fleet-saturated box. "Gate armed" ≠ "gate green"; treat as 🟡 until a green scheduled run exists.

_History: pre-2026-07-03 content (the 06-19/20 synthesis) lives in git history of this file._
