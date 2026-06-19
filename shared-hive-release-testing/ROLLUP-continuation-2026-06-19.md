# Shared-Hive Continuation Wave — Live Rollup (su-9140a, monitor)

**Purpose.** Single honest source of truth for the wave-2 (briefs H–N) status and
the running public-release verdict. Maintained by the monitor as lanes report.
Last updated: 2026-06-19 ~12:08 (coord MCP degraded/timing-out — statuses read from landed findings files + on-disk artifacts).

## ⚠ OPERATIONAL RISK (12:32): git-sync STALLED
Last auto-commit 2h ago · 0 commits in 30 min · **92 files uncommitted** (all 7 lanes'
work). Likely the routines-ticker safe-mode (engine-gated auto git-sync). The box
restarted once today and lost state — this 2h of work is exposed to the same loss.
Flagged to fleet + needs owner to re-enable git-sync / persist. (Monitor will NOT commit
— git-sync owns commit+push.) Integrated build reads the working tree so it's unaffected.

## Running verdict: 🔴 NOT READY — two engineering items remain, both now SPECIFIC (13:56)

**D-001 (the S0) is FULLY CLOSED — code + LIVE** (J live-witnessed convergence under real
clock skew on the shipped binary). **A-002 live-GREEN** (dc9db). Core federation, scale (N),
honesty (G-001/G-002 live, G-004 live) all GREEN. Remaining:
1. **A-003 (S1, compounds revocation)** — a REAL projection-binding bug the LIVE witness
   caught (green rig, red real binary): hive_members/hive_settings don't reach the joiner.
   d2230 root-causing (rebind not engaging at rekey) + fixing. Engineering, in progress.
2. **C-001 read-revocation — OWNER DECIDED (2026-06-19): RE-KEY / cut reads.** This is now a
   REQUIRED BUILD, not a decision: **Move 2** (per-epoch group key MLS/TreeKEM-style +
   content-core encryption; member-remove/go-private advances the epoch → removed peer can't
   read NEW content; DESIGN-hive-federation-long-term.md). It **subsumes A-003 revocation +
   E-001**. This is now the **CRITICAL-PATH-TO-RELEASE** item — the largest remaining piece,
   a substantial crypto effort. Needs a crypto-capable owner.
**Net:** the test program is essentially complete + everything testable is GREEN; the road
to public release is now (a) land A-003 fix + re-witness, and (b) **build + verify the C-001
re-key (Move 2)** — the dominant remaining effort. No more S0; this is a known build list.

## Re-confirmed GREEN this session (fresh boot, real binary + suite)
- **Automated backbone:** `vitest run lib/sync/hyperbee lib/shared-hive-loop` →
  891 passed · 2 expected-fail (D-001 markers) · 1 skipped (110 files). ✅
- **Live core federation** (Papercusp_0.0.2 .deb, 2 peers, :154): A-001 boot ·
  negative-isolation · topic-equal · **8/11 types bidirectional** (backfill + incr
  A→B + incr B→A). ✅
- **Live backfill-at-size:** 300 rows → full backfill on the joiner in ~6s, 300
  distinct = no loss/dup. ✅ (→ findings-N.md §live, su-9140a)

## Lane status board

| Lane | Owner | Focus | Status | Evidence / blocker |
|------|-------|-------|--------|--------------------|
| **H** | su-dc9db | A-002 multi-hive stall (swarm.ts announce channel) | 🟢 **GREEN** (fix landed) | announce channel now keyed `muxer×topic` (WeakMap<mux,Map<topicHex,…>>); teeth-verified unit + real-Hyperswarm; suite + single-hive green. Optional: live .deb 2-hive pass |
| **I** | su-d2230 | A-003 member/settings→joiner + joiner revocation | 🔴 **ROOT-CAUSED (live): SEND-side gap** | LIVE witness + A-PG drilling reframed it: d2230's receive-side rebind is CORRECT + fires live (trace `rekey…rebind=true`) but MOOT — A (owner) NEVER federates hive_members/hive_settings: outbox rows `drained_at=NULL` + the hive-HOME harness isn't on the topic (only member+invite hives are). = su-963ee's **increment-2** (hive-home harness's own content doesn't federate). Fix (a) wire hive-home to federate (boot-on-topic + outbox-drain — Move-1's send-side half, the foundation the re-key needs) [recommended] vs (b) re-scope capture onto the member log [stopgap]. Architecture call (d2230 + 963ee). |
| **J** | su-46b7a | **D-001 LWW convergence (S0 GATE)** | 🟢 **GREEN — S0 CLOSED** | full sync/hyperbee federation integration suite passes (48 files) + unit 878 + convergence-fuzz converges (10/10) + federated-column-completeness 14/14 + backbone 901. Migration 314 (`fed_hlc` HLC-of-record) + write-time HLC + del-guard-by-HLC. Optional last-mile: a live clock-skew pair (in-core + real-PG twin already prove convergence). **The hardest blocker is done.** |
| **K** | su-313d1 | C-001/E-001 read-plane revocation live witness | 🟡 **YELLOW** (witnessed live) | found the authorized removal path; **genuine device-key revoke → removed member STILL reads new content** (live, real binary). Documented limitation, not silent leak. GREEN needs re-key (product decision) |
| **L** | su-ed300 | G-001/G-002 honesty on a fix-.deb | 🟢 **GREEN** | live matrix on fix-.deb (2 peers, :160/:161): from-repo **12/12** · **G-001 invite reachablePeers=0** (was 1) · **G-002 dead-secret → joined:false** (was true) · G-003 withdraw-drops ~3s. Route-level G-002 fix landed + teeth-verified. .deb: `.cargo-target-L/release/bundle/deb/Papercusp_0.0.2_amd64.deb` |
| **M** | su-d53bf | desktop UI + G-004 live status surface | 🟢 **GREEN (live-proven)** | `GET /api/discovery/federation-status` + `HiveFederationStatus` UI; 14 tests teeth-verified; **LIVE-PROVEN on the integrated .deb pair** (reach=1 == B, matches directory ground truth) |
| **N** | su-c318e | N-peer scale/churn (+ live note) | 🟢 **GREEN** | 5-peer×8-type rig + 432-row backfill + churn, teeth-verified; my live §live note folded; 1 scope caveat (live 3+ impossible — 2-identity box) |

Legend: 🟢 landed/green · 🔧 in progress · 🟡 caveat · 🔴 blocked

## What flips the verdict toward GREEN
1. **J lands** + skew sweep green + full federation suite (862) green → clears the S0.
2. **A-002 (H)** + **A-003/revocation (I)** land + live 2-hive pass green.
3. **C-001 (K)** — owner's read-cutoff decision; then either re-key lands or it's
   documented + honest UI (M's G-004 + L's honest copy).
4. **L** re-verifies G-001/G-002 GREEN on the fix-.deb (not just bug-confirmed).
5. Re-run the **live multi-peer E2E + the skew sweep** on a fix-built .deb; if both
   green → flip to ✅.

## Monitor log
- 12:05 — board created. All 7 lanes owned + active. Backbone + live core re-green.
  Live-N scale note delivered. Awaiting lane landings.
- 16:01 — **A-003 (a′) REASSIGNED to J (46b7a).** dc9db had been idle ~90min (went idle BEFORE
  the 15:12 (a′) assignment — never picked it up; intent stuck on A-002), so the critical-path
  blocker had NO driver. Reassigned to J (free, offered, best-leveraged — built D-001's
  capture→drain→merge→PG-HLC + knows swarm). The change: extend the per-hive announce channel
  (swarm.ts ~:187, `createChannel` returns null on the 2nd same-topic harness) to carry MULTIPLE
  log announces per topic → the owner's hive-home log federates alongside the member's. d2230
  STAGED to re-apply the hive-home re-key (~2min diff) + re-witness via /tmp/a003-trace.sh the
  instant J lands it; K then wires P3 epoch-key distribution. Woke all 4. **Operator recovered
  (200); integrated staging GREEN (backbone 935/0); re-key cut-off verified 19/19.** The release
  path is now: J (a′) → d2230 re-key → I re-witness → K P3 → re-key witness → AE capstone.
- 15:12 — **A-003 send-side APPROACH DECIDED (lead): (a′)** — dc9db's bounded announce-channel
  extension (carry the hive-home log's announce alongside the member's on the shared muxer/topic).
  Both (b) variants are DEAD (d2230 proved: member-drain re-scope regresses after restart;
  capture-side SQL can't resolve "a member"). (a′) needs ZERO capture/drain change, federates the
  hive-home as-is, d2230's receive-side rebind applies it end-to-end, AND it's the clean "hive is
  the federation unit" model the re-key needs. OWNERS: dc9db (announce extension) + d2230 (re-apply
  hive-home re-key + re-witness) + J co-build (HLC context). **This is THE blocker (P-002) for the
  whole re-key.** RE-KEY PROGRESS: P1 crypto (ed300, 12 teeth-verified) + P4 serving (K, 7/7 incl.
  cut-off) LANDED; P3 epoch-key distribution gated on (a′). OPS: routine engine re-freezing
  (routinesTick starved) — 67d39 implementing infra-self-healing; work committed (uncommitted=0), kopia-safe.
- 14:13 — **A-003 FINALIZED (this pass): RED, two-sided, send-side dominant.** d2230's receive-side
  rebind fix is CORRECT + teeth-verified + fires live → STAYS in tree (required component). Dominant
  blocker = SEND-side: hive-home harnesses (kind:'hive') don't federate their own content on the owner
  (outbox drained_at=NULL, never on topic). **DECISION (su-9140a): the send-side fix gets a LANE NOW**
  (owned by d2230, option a) — it's NOT deferrable, the C-001 re-key DEPENDS on it (epoch/membership ops
  federate via the hive-home). **CONNECTION: this is almost certainly EI-681** (su-963ee's pinned root
  cause) for the hive-home unit — owner-publish never boots the hive-home substrate; the fix primitive
  `rebootHarness()` (boot-all.ts ~576) EXISTS but is DEAD CODE (0 callers). Fix = wire `rebootHarness`
  into `publishListingForMeta`/`republishHiveAfterMemberAdd` for the hive-home harness. So A-003's fix
  is a known, low-risk wiring change → re-witness on landing. Re-key (Move 2): ed300 crypto foundation
  starts now (no A-003 dep); K distribution sequences behind A-003.
- 14:04 — **A-003 ROOT-CAUSED (live): it's a SEND-side gap, not receive-side.** d2230's instrumented
  :180 witness + A-PG evidence: A writes hive_members/hive_settings (origin=local) but the outbox is
  `drained_at=NULL` (NEVER drained) + A's hive-HOME harness isn't on the hive topic → they never
  federate OFF the owner. d2230's receive-side rebind fires correctly but is moot. = su-963ee's
  increment-2 (hive-home harness's own content federation unwired). **CONSOLIDATION:** this is the
  send-side half of Move-1 ("hive is the top-level federation unit" — mirror of H's per-hive announce
  channel), and it's the SAME substrate the **C-001 re-key (Move 2)** needs (epoch/membership state
  must federate via the hive-home). So A-003 + the re-key now share ONE foundation: complete Move-1's
  hive-home federation. Recommended fix (a) wire hive-home to federate; looped in 963ee (Move-1 architect).
- 13:56 — **🎯 D-001 FULLY CLOSED (live)** — J live-witnessed convergence under real clock skew on
  the shipped binary (split-brain inversion A:fed_hlc-high/fed_ts-low → both converge to A). S0 done
  code+live. **🚩 OWNER DECIDED C-001 = RE-KEY** (cut reads on member-remove/go-private) → Move 2
  (epoch group key + content encryption) is now the CRITICAL-PATH-TO-RELEASE build; subsumes A-003
  revocation + E-001; K lane shifts document→BUILD; needs a crypto owner. Decision saved to memory
  (0e2696ce) + broadcast. Tore down the :158 pair (J's skew leg done) to free box room for K (:175)
  + d2230 (:180). git-sync = EI-1607 (DBOS catch-up throttle, kopia-safe, not broken — per 55c0a).
  A-003 fix in progress (d2230, /tmp/a003-trace.sh safe harness).
- 13:36 — **H 🟢 CLOSED** (dc9db: A-002 live — the 2-hive announce-collision path WAS exercised,
  A's spoon-knife handler fired on the A↔B conn, hello-world federated 8/8 anyway; 2nd-hive→B
  content leg covered by the teeth-verified two-hive-shared-swarm.test.ts). **NEW incidental bug
  (filed discovery/M, not a blocker):** invite-hive status-beacon capture type error —
  `[hive-directory] beacon capture failed for spoon-knife-hive: "string" argument must be of
  type string... Received an Object`. **A-003 fix IN PROGRESS** (d2230 editing boot.ts, +
  boot_events instrumentation). git-sync STILL stalled (131 uncommitted) despite the engine
  revival — kopia-safe but unpushed; flagged. :158 pair still up (offered to J for the optional skew leg).
- 13:32 — **🎯 J 🟢 GREEN — S0 (D-001) CLOSED** (full 48-file federation integration suite
  passes). **A-002 🟢 live-DONE** (dc9db: 2-hive no-stall on the real binary). **From-repo flow
  PASS** on the integrated .deb (create→discover→join→bidirectional content federation).
  **A-003 → REAL BUG**: the live witness caught that hive_members/hive_settings still don't reach
  the joiner despite I's rig-green fix (B=0 rows, all phases) — leading cause home-slug mismatch
  (A op carries hive_home_slug=hello-world-hive; rebind binds B's projection to a different slug);
  d2230 instrumenting boot_events to pin + fix. 6 of 7 lanes GREEN; A-003 + C-001 are the only gaps.
- 13:06 — **M 🟢 GREEN (G-004 live-proven** on the integrated .deb, reach=1==B). **J near-green:**
  full integration sweep surfaced 12 rig files with schema drift on the new fed_hlc/op_hlc cols
  (test-harness, NOT core) — all fixed; confirms the rig sweep was test-only → validates firing
  the build in parallel. dc9db staged for the A-002 2nd-hive leg (reusing my pair post-matrix).
  **INTEGRATED WITNESS RESULT (matrix, real .deb, 2 hives):** A-002 ✅ no-stall (1st hive 8/8
  bidirectional w/ 2nd hive present); A-003 ⚠️ INCONCLUSIVE (synthetic discovery-join doesn't
  trigger I's re-key → hive_members/settings don't cross; B=0 rows, 0 rekey log lines → needs
  the FROM-REPO join witness); D-001 fed_hlc=109 in binary (live skew = J's separate leg);
  B→A baseline ✅ 8/8 (clears K's anomaly as revoke-induced). presence by-design.
- 12:53 — **🚀 FIRING the integrated live witness** (/tmp/integrated-witness.sh, bg blyltly21).
  Decided to fire in PARALLEL with J's still-running rig sweep: operator-core runtime files
  frozen ~55 min (projection.ts 08:12, swarm.ts 08:05) so the sidecar is runtime-final; J's
  sweep is on test rigs (not bundled into serve.mjs); my 3 probes already confirm the runtime
  green. Build: sidecar-from-staging → swap into L's fix-.deb → repack → content-matrix
  WITHOUT SKIP_INVITE (A-002 2-hive + A-003 member/settings cross + 8/11 baseline + B→A) on
  :158, mig-314 auto-applies on boot. ~15 min. The up pair = J's skew leg + K's revocation
  legs + M's G-004 render (M :171/:172, dc9db :165+, me :158). This is the verdict-mover.
- 12:48 — **J done-pending-final-sweep + ENGINE escalation handled.** J confirmed code-complete
  (mig 314 + fed_hlc on all 15 projections + write-time HLC + del-guard; unit 878 green, key
  integration green); running a final sync/hyperbee integration + shared-hive-loop rig sweep
  (~10-15 min) before pinging "all green." My probes corroborate GREEN. **Deeper root cause
  (55c0a):** the PRIMARY background-worker host has been DOWN since ~06:50 → DBOS routines /
  queen / scout / git-export / git-sync ALL frozen (not just git-sync). **GREEN-LIT 55c0a's
  revive (path A: BACKGROUND_WORKERS=1 + restart):** safe for the campaign (my federation
  tests are fully isolated — own embedded PG + private testnet DHT, disjoint from :3070),
  desired (owner asked for git-sync), and it flushes the 92-file backlog to remote.
  **Build consolidated:** I build the integrated .deb ONCE → run the backend A-002/A-003/D-001
  witness → hand the SAME .deb to M (d53bf) for the G-004 GUI render. Fires on J's "all green".
- 12:45 — **🎯 J IS BUILD-READY (probes GREEN).** `federated-column-completeness`
  integration **14/14** (the 12-RED canary is green → fed_hlc mapping complete, no silent
  drops) + convergence-fuzz converges. J's D-001 code is functionally done at unit +
  integration level. J still hasn't replied to the wake — LIKELY DEADLOCKED: its
  done-criteria says "committed to staging" but git-sync (EI-1598) can't commit, so it
  can't declare done. BREAKING THE DEADLOCK: I build from the WORKING TREE (kopia-backed;
  build reads the tree, not git). Running the full backbone suite as the final regression
  gate; if green → I BUILD the integrated witness now (no waiting on J's "committed").
- 12:42 — **🎯 D-001 CONVERGES at the fuzz level (the S0 is fixed in-core).** Probed
  convergence-fuzz: now **9 passed | 1 expected-fail** (was 8|2 at session start) — the skew
  sweep that diverged now converges under `fed_hlc`; the lone expected-fail is J's
  intentional legacy-`fed_ts` teeth-guard. Most lanes (I/K/L/M/H) are DONE + PARKED waiting
  on my integrated witness; J alive but idle ~18min (woke it for a code-green confirm).
  Probing `federated-column-completeness` (integration) to confirm the full fed_hlc mapping
  is build-ready → if green, I build the integrated witness without waiting on J's signal.
  K asks to fold K-2 (revoked_pubkeys→joiner) + C-001 re-confirm + a B→A anomaly re-check
  into the integrated pass (K saw B→A federation die post-revoke on :154 — possible new finding).
- 12:38 — **M G-004 independently verified 4/4** (federation-status route green on current
  tree). **A-002 live-witness assertion captured (dc9db):** run content-matrix WITHOUT
  SKIP_INVITE → PASS = the 2nd/invite hive's content also federates A↔B origin='remote'
  (pre-fix it stalls while peer_connected+topic-equal still look healthy). dc9db owns
  verifying that leg on my .deb. **⚠ build contention:** 2 `tauri build` on the warm cargo
  target; pid 672008 WEDGED 46min (holds the lock, blocks 1307076). My integrated build
  uses the no-cargo sidecar-swap path → adds zero contention. Flagged fleet to hold
  individual .deb builds. J still grinding guards (fed_hlc 24, gate 1).
- 12:35 — **git-sync stall root cause = EI-1598** (operator :3070 event-loop hang — the
  federation layer's synchronous replication/LWW-merge/projection work not yielding the
  loop → routine scheduler frozen → 92-file backlog uncommitted). 55c0a restarting +
  installing an event-loop-lag auto-restart watchdog (the real fix). Work is kopia-backed
  (5-min) + on persistent disk → only unpushed-to-remote at risk, not local loss. **Owner
  is restarting git-sync.** Tore down the leftover :154 PRE-FIX pair (sidecars DOWN, ports
  freed) — hygiene + removes a federation-CPU consumer (integrated run builds a fresh pair).
  **A-003 GREEN criteria (d2230) for the integrated content-matrix pass:** on joiner B's PG,
  `hive_members` AND `hive_settings` with `origin='remote'` ≥ 1 (both 0 today = the RED
  line); engages on the join re-key. (N-peer scale test is c318e's, not mine.)
- 12:29 — **build-path decided** for the integrated witness: no serve.ts content rig
  exists (both two-instance smokes are .deb-based), so FAST path = rebuild sidecar from
  staging (`build-desktop-sidecar.sh`, ~2-5 min) → swap into an extracted L fix-.deb →
  `dpkg-deb` repack = integrated .deb in ~5-8 min (vs 20-min cargo; Tauri shell unchanged
  by operator-core fixes). **M update:** G-004 shipped+teeth-verified; scenarios 1-3 covered
  by L; only the live G-004 GUI render remains → rides the integrated .deb (desktop drive
  under Xvfb). J still finishing fed_hlc mapping; no suite-green signal yet.
- 12:26 — **J skew sweep FLIPPED to passing** (converges under fed_hlc); finishing the
  fed_hlc column mapping (transient federated-column-completeness 12-RED is J's own
  mig-314, NOT a bug — per d2230). I re-confirmed: closes BOTH halves (member/settings
  federate + revocation reaches joiner admission union). **Build trigger = J reports the
  full federation suite green** (column-completeness back to green); then I build the
  integrated sidecar + run the A-002/A-003/D-001 live witness.
- 12:23 — **J close:** Migration 314 landed, projection.ts seam + integration twin GREEN
  on real PG, fed_hlc 13→20 files (guards swapping). Build-trigger prep: the integrated
  live witness can use the FAST path — rebuild the sidecar from staging
  (`build-desktop-sidecar.sh`, ~2 min) and drop it into an extracted L fix-.deb, instead
  of a full ~20-min cargo/tauri build (federation code lives in the sidecar, not the Tauri
  shell). Fire the moment J's sweep flips.
- 12:20 — **I landed (A-003): 🟡→🟢-on-deploy.** Fix + teeth-verified joiner binding;
  revocation half closed. **J propagating fed_hlc across projections (7→13 files)** — the
  all-projection guard change; gate still 1 it.fails. ENDGAME PLAN: H (A-002), I (A-003),
  J (D-001) are all landing on staging, each with a **deploy-gated** live witness. Monitor
  (me) will build ONE integrated fix-.deb from staging once J lands + run a comprehensive
  content-matrix (no SKIP_INVITE → A-002; check hive_members/settings cross → A-003; skew
  variant → D-001) to flip all three deploy-gated witnesses in a single pass. Proposed to
  the lanes to avoid redundant per-lane builds.
- 12:17 — **L 🟢 GREEN.** Live-verified G-001/G-002 on the fix-.deb (2 peers): from-repo
  12/12, invite reachablePeers=0 (deceptive-publish lie dead on the real binary),
  dead-secret join honest (joined:false), withdraw-drops ~3s. Route-level G-002 cure
  landed + teeth-verified. **Now 4 lanes GREEN (H, L, M, N).** Fix-.deb at .cargo-target-L
  is the candidate binary for the eventual final integrated live run (after J's migration
  is folded in + rebuilt). Remaining: J (S0 gate, landing), I (A-003, pending), K (YELLOW,
  product decision).
- 12:14 — **J (S0 gate) landing:** `fed_hlc` now in 6 source files; `convergence-fuzz`
  `it.fails` dropped 2→1 (one divergence marker now converging). Not running the
  sweep yet — J's tree is mid-edit; will verify the integrated result once J reports
  done. findings-I still not posted. coord MCP still down.
- 12:11 — **independent verify of H (A-002):** re-ran the swarm/announce area on
  staging → 86 tests / 9 files GREEN, incl. real-Hyperswarm kill-reconnect chaos
  (admission + mid-session revocation enforced). H's landed fix confirmed
  non-regressing. D-001 gate still open (convergence-fuzz 2 it.fails). findings-I
  still not posted. coord MCP still timing out — filesystem signals only.
- 12:08 — first lane reports landed (read from findings files; coord MCP timing out).
  **H 🟢** (A-002 fixed) · **N 🟢** · **M 🟢** (G-004 shipped) · **K 🟡** (C-001
  witnessed LIVE — genuine device-key revoke, removed member still reads) · **L**
  fix-.deb built (luxon + G fixes bundled, live re-verify next) · **J** Migration 314
  landing (S0 gate) · **I** not yet posted. Verdict stays 🔴: J (S0) not landed +
  green; K needs the product decision; I unreported. Net: 3 lanes GREEN, strong trajectory.
