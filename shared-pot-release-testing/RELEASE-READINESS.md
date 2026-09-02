# Shared-Pot P2P — Public-Release GO/NO-GO (signed)

**Question:** can we confidently ship the shared-pot (P2P federated) feature to public production?

**VERDICT — re-signed 2026-08-27T07:03Z (su-b3098, `WI-42218`, per
`p2p-public-release-remaining-lanes-2026-07-16#D-074`): NO-GO for unconditional public ship.**
The sole D-073 replacement run is terminal but **non-countable**. Its exact schema-2 verdict-bank
row (`2026-08-27T07:00:43Z`, writer PID `535974`) joins to
`/tmp/live-fed-gate-20260827-020717` and reports a superficially green token while explicitly
recording `legs.local_matrix=SKIPPED` and `matrix_skip="leg disabled for this run
(RUN_LOCAL_MATRIX=0)"`. That work directory contains no `local-matrix.out`, hence no exact-run
D-067 frame-b positive control proving `remote>=1` and `local=0`, and no deciding local-matrix
verdict. The rebuilt sidecar is also not clean current-HEAD evidence: embedded provenance names
`gitHead=ad44b6f3462a3ec9f78615dd29788702463c78c7` with `gitDirty=true` and
`gitHeadAtEmit=9ee881de7dcceec1371fd132840e2fe25685ebe1`; the bank records
`source_dirty_files=26` and a different terminal head. D-069 therefore remains in force and
P-506 is not retired. Per D-073, this gate will not be rerun; the separately authorized P-508
lane may build only a **new clean current-HEAD seeded Server artifact**, then must pass embedded
provenance/content audit, pristine boot, and the full physical two-host P-305 lifecycle before
P-511 can reconsider the public-release verdict. Lost exec 55784 and stale staged bytes remain
inadmissible.

**PRIOR SIGNATURE — re-signed 2026-08-22T05:30Z (su-6651e, `WI-40548`, per
`p2p-public-release-remaining-lanes-2026-07-16#D-046`): NO-GO for unconditional public ship.**
The verdict is unchanged; this signature corrects a rationale that current executed evidence has
overtaken. Two independent blockers now stand in the non-git/non-coordination P2P lane, and both
must resolve on live evidence before any GO:

1. **W1's stated waiting-condition is now MET — and W1 is STILL OPEN, on different grounds.**
   Rationale re-signed 2026-08-22T19:15Z (su-b1761, `WI-40656`, per
   `p2p-public-release-remaining-lanes-2026-07-16#D-058`). **The verdict above is UNCHANGED and
   this row does not bear on it.**
   The prior text (D-046, ~06:00Z) recorded that every run through `m1787374736` queried the
   owner frame's self-classification only once at `peer_connect`, roughly 30 scenario orders
   before the restart, so no retained result could say how the owner classified itself
   afterward; `WI-40534` had landed a measure-only order-82 re-poll, and the **next** qualifying
   run would be the first capable of measuring W1's post-restart half.
   **That run has since happened** — 2026-08-22T10:49:58Z, order 82, rig `m1787395184`
   (see `#D-055`, binding) — i.e. AFTER the D-046 signature, which therefore could not have
   accounted for it. It measured the branch as **0 rows `origin='remote'`** (both `pot_members`
   rows `origin='local'` after the restart), corroborated by order 80 `PASS restart_durability`.
   ⚠ **This does NOT retire W1, and the "structurally unobserved" framing above is what it
   retires — not the blocker.** It is ONE run against ONE restart, weighed against 11×
   OWNER-CONTENT at denominator 16 — and the not-reproduced branch is precisely what a healthy
   run AND a lucky run both print, so a single clean observation cannot discriminate between
   them. W1 therefore stands as a release blocker **on the merits**, where it previously stood
   on absent evidence. Read `#D-055` before quoting this row.
2. **`WI-40537` (revocation k-cut) is unresolved.** Run `m1787374736` produced a red that still
   needs two discriminator legs: whether banned frame B can decrypt post-ban content, and whether
   the result reproduces on current HEAD. Pending those answers, this is a release blocker but
   **not a confirmed read-access breach** and must not be described as one.

**CLOSED-BY-EXECUTION — the `aviynw` credential precondition is no longer a wall.** Run
`m1787374736` cleared the distinct-account host preflight with `aviynw` on frame B; its final
matrix summary records **15 passed, 2 failed, and 1 skipped of 18 registered**. That closes the
token gap specifically; it does not clear W1, resolve `WI-40537`, or change the NO-GO verdict.
There is therefore no valid single-step flip condition at this signature: both blockers above
need attributable executed evidence.

Git, coordination metadata, code-signing inputs, and the separately governed shipped-seed
artifact mismatch are outside this lane and are not additional P2P evidence walls. The dated
blocks below remain as audit history; where an older statement conflicts with this signature or
the current §3 row 0, the current text controls.

> ## ⚠ RE-SIGNED 2026-08-16T03:5xZ (su-0c703, `WI-39359`, owner-directed AUTO) — VERDICT UNCHANGED (**NO-GO**), but the reason above is no longer the ONLY one, and the "single flip condition" clause is now INCOMPLETE
>
> The block immediately above is correct on its own terms and I have not altered its rows. What
> has changed is that a **second, INDEPENDENT** reason now stands beside it — and unlike §3 row 0,
> **this one is a known defect, measured, not absent evidence.** Both must clear before any GO.
>
> ⚠ **FIRST, A CLAUSE IN THE HEADLINE VERDICT (line 6) NOW NEEDS A BOUND: *"The substrate is
> release-grade"*.** That sentence is the single most quotable line in this document and it was
> written when **no scale criterion existed on the signed table at all** (see new §2.1 row 14).
> It should now be read as: *the substrate's CORRECTNESS rows are release-grade; its behaviour
> UNDER MESH LOAD is established only to 64 peers, and only against a 120s convergence budget.*
> ⚠ An earlier revision of this same paragraph said "release-grade at ≤32 peers" — **withdrawn**;
> so is the "non-monotonic ladder (✅32 ✅40 ❌48 ✅56 ❌64)" reading that replaced it. BOTH were
> artifacts of a broken convergence instrument (D-014/D-015): the ladder on the FIXED instrument
> is monotone and fully green to 64. What is honestly established: **the mesh converges at 64
> peers within 120s (slowest reader ~60s); it does NOT converge within 30s; nothing above 64 is
> measurable on this host — see consequence 4.**
> I am not deleting the headline clause — the correctness rows behind it stand on their own
> evidence — but quoting it as a statement about *scale* overstates what has been measured, and
> that is precisely how "p2p is fine" gets into a release note.
>
> **NEW: §2.1 row 14 — mesh scale was never on this table at all.** That absence was the finding.
> The 256-peer target was unreachable **by configuration**: `swarm-guard.ts` keyed its
> connection-rate bucket `ip ?? keyHex` (IP first) and banned the **IP** on a trip, so co-located
> peers shared one 30-conns/10s budget and a single burst evicted every neighbour for 600,000ms.
> A flat N-peer mesh makes ~N−1 inbound connections by construction — 2× over budget at 64.
>
> Three consequences, in the order they matter:
>
> 1. ⚠⚠ **Every measurement above ~32 peers, ever taken, is VOID as a capacity statement** — all of
>    them ran through a guard that was banning the mesh. The substrate's true ceiling has **never
>    been measured**. Do not quote any historical peer-count number from this repo, including ones
>    in earlier revisions of this document.
> 2. **The guard is fixed and verified.** Controlled before/after: converged readers 30/63 →
>    61/63, p95 601,075ms → 152,020ms, 5.9× faster.
>    ⚠⚠ **THE REST OF THIS BULLET — "and 64 peers STILL fails", `convergencePassed: false`,
>    "readers 16 and 38", "not release-ready on measured evidence" — IS WITHDRAWN. It was the
>    BROKEN INSTRUMENT, not the substrate** (`EI-20581532536662596`, plan D-014/D-015). The
>    convergence verdict was measured by a SERIAL per-reader wait, making the deadline a function
>    of iteration order rather than of the run. On the fixed instrument the full ladder is green
>    and MONOTONE: ✅32(31/31) ✅40(39/39) ✅48(47/47) ✅56(55/55) ✅64(63/63).
>    **What replaces it — and it is a BOUNDED claim, not a green light:** at 64 peers all 63
>    readers converge **within a 120s budget**, p50 7,095ms · p95 35,355ms · **max 59,946ms**,
>    appendToVisible p95 55,678ms. The fix ALSO unified a budget drift (the child declared 120s
>    while the parent abandoned at 30s), so both defects were load-bearing: **the old 30s wait
>    would have failed this run outright.** Therefore "converges at 64 peers" is true **at 120s
>    and false at 30s**, and no convergence verdict may be quoted from this document without its
>    budget. 256 remains **far beyond the last honestly-measured point, which is 64.**
>    The open question is no longer correctness but SPEED — ~1min to last-reader convergence at
>    64 peers — and that is a product call, not a measurement. Residual `WI-39374` is refuted as
>    a substrate bug and closes against D-015.
> 3. **A third input arrived from the coordination lane and I am not signing past it:** peer machine
>    B has federated **nothing for 48h** with **zero alerts**, because stall detection is host-local
>    by construction (`EI-20579195481991931`, su-c531b). That is a data-plane observability gap.
>    ✅ **RESOLVED SAME-TURN, and recorded here so nobody re-opens it as a guess:** I asked whether it
>    shared a mechanism with row 14's two non-converging readers; su-c531b answered **NO — B's stall
>    is a boot-time storage guard (the substrate fails to BOOT), not replication lag.** They are two
>    distinct defects and must be tracked and cleared separately. The observability half stands on
>    its own regardless of mechanism: a total 48h federation outage on a peer that **no monitor on
>    the other machine can see** is a release blocker in its own right, because it means we cannot
>    detect this class in the field at all.
> 4. ⚠⚠ **>64 PEERS IS NOT MEASURABLE ON THIS HOST, AND THE ">64 LADDER" NUMBERS ARE VOID**
>    (measured 2026-08-16T09:40Z, `/tmp/attrib-above64.log`,
>    `test-results/p2p-perf/2026-08-16T09-40-17-138Z/`). The >64 non-monotonicity is **the
>    measurement exhausting host memory**, not a substrate mesh-formation defect and not
>    pre-existing host load. Each perf peer child holds **~430–550MB RSS** (`childRssPeak` p50,
>    4 configs), so 80 peers needs ~38–42GB and 96 peers ~41–53GB of anonymous memory. The run
>    **self-oversubscribes**: a pass beginning at loadavg 52 / PSI cpu some avg60 0.96% ended at
>    **loadavg 265 (2.07× cpus)** having moved **470,555 swap pages**, and the runner's own
>    EI-8843/EI-9145 guard fired *"host oversubscribed during this run AND host swapping"*.
>    **The decisive evidence is non-reproducibility, not the load number:** across two runs of the
>    same four configs, **96@100 went 22/95 → 95/95 while 96@10 went 95/95 → 51/95.** A capacity
>    ceiling cannot invert. Failing readers cluster at 115–116s against the 120s budget — deadline
>    clipping of an across-the-board-slow distribution, i.e. swap stalls.
>    **Consequences:** quote **no** >64-peer convergence verdict as a substrate property, including
>    the 80/96/128 rows of the 06:20Z ladder. 64 peers (~31GB) remains the largest config that fits.
>    **256 peers would need ~128GB of child RSS and is therefore not measurable on this box with a
>    process-per-peer harness at any load** — that is a HARNESS-ARCHITECTURE wall (a lower-footprint
>    peer, or multiple machines), not a substrate verdict and not an owner-credential wall.
>    ⚠ This does **not** say the substrate is fine above 64 — it says **we still do not know**, and
>    this host cannot tell us. **Guard added so this cannot recur silently:** `perf/host-capacity.ts`
>    refuses a proc-mesh that provably does not fit, at the `spawnProcMesh` chokepoint, before any
>    child is spawned (`HostCapacityError`; override via `PERF_MESH_AVAILABLE_FRACTION` /
>    `PERF_MESH_PER_PEER_BYTES`). This is the **fourth** time in this lane the instrument, not the
>    substrate, was the defect (serial per-reader deadline; budget drift; hyperswarm's default
>    `MAX_PEERS=64`; now per-peer RSS vs host memory).
> 5. ⚠⚠ **AND A FIFTH — THE HOST-CONTENTION GATE ITSELF COULD NEVER PASS, WHICH WAS SILENTLY
>    SUPPRESSING REGRESSION FINDINGS** (fixed 2026-08-17, `perf/runner.ts computeHostHealth`).
>    `hostLoad.oversubscribed` was set by a swap-page delta > **1,000 pages (~4MB) over a whole
>    run**. Measured on this host: a genuinely quiet moment — PSI memory `some avg60` = **0.76%**,
>    i.e. the kernel recorded essentially no stall — still moved **3,364** pages (3.4× the
>    threshold), and a 40s idle sample with no perf run at all moved **909,444**. Ambient rate is
>    ~**1.5M pages / 150s**. So the flag was pinned true and every run inherited it.
>    **This is not a conservative failure.** `oversubscribed` makes `p2p-perf-actions.ts`
>    `fileFindings` skip auto-filing regressions and SLO violations, so a permanently-true confound
>    **hides real regressions** — while simultaneously blocking every `--update-baseline`
>    promotion, so the baseline could not be refreshed either. It failed in both directions at once.
>    **Fix:** PSI is now the AUTHORITATIVE memory-contention signal (`some avg60 > 5%`), and the
>    page-delta is demoted to a fallback for hosts without PSI. The threshold is corroborated twice
>    independently — the 2026-08-02 audit in that file called ~2-5% "low, not the sustained
>    thrashing the verdict implies", and this host's own infra watchdog alerts at memory
>    `full avg60 >= 5` (`some` >= `full` always, so 5-on-`some` is the stricter reading). PSI also
>    catches reclaim/page-cache stall at *zero* swap I/O, which the page-count check missed entirely.
>    `swapping` is renamed `memoryContended`, with a new `memoryContendedReason`
>    (`psi-stall` | `swap-pages-fallback` | `null`) so no reader has to infer which branch fired.
>    **Verified in both directions with the real CLI**, not only unit tests: `oversubscribed:false`
>    at PSI 0.76% (the old logic refused this), and `memoryContendedReason:'psi-stall'` at PSI 6.03%
>    and 8.7%. A permanent pre-fix control (`decideByPageDeltaAlone`) plus a calibration case live in
>    `runner.test.ts` so a future "fix" that merely stops flagging cannot pass.
>    **Consequence for this document:** every "host oversubscribed, findings suppressed" note in the
>    runs above was produced by the *unsatisfiable* threshold, so it does NOT establish that those
>    runs were actually contended — and any regression those runs would have filed was silently
>    dropped. Re-read such verdicts with that in mind.
>
> **The flip condition is therefore no longer single.** It is now at least: (a) one gate run
> reporting `local_matrix=OK` (§3 row 0, unchanged, su-c531b's row); **(b)** a post-fix
> re-baseline establishing where convergence actually breaks, with `convergencePassed: true` at
> the peer count we intend to claim; **(c)** peer-B federation stall explained and detectable.
>
> ### ✅ (b) HAS NOW BEEN RUN — 2026-08-16T03:5xZ. The answer is NOT a capacity number, and that is the finding.
>
> Full post-fix ladder, same host, `replication.sustained` / `rate:10 count:200`
> (`test-results/p2p-perf/2026-08-16T03-50-04-804Z/` and `.../2026-08-16T03-57-26-753Z/`):
>
> | peers | `convergencePassed` | converged readers | convergence p95 | duration |
> |---|---|---|---|---|
> | 32 | ✅ true | 31 / 31 | 39,469 ms | 57 s |
> | 40 | ✅ true | 39 / 39 | **1,538 ms** | 22 s |
> | **48** | ❌ **false** | 46 / 47 | 104,870 ms | 124 s |
> | **56** | ✅ **true** | 55 / 55 | 18,992 ms | 31 s |
> | 64 | ❌ false | 59 / 63 | 165,811 ms | 185 s |
> | 64 (repeat) | ❌ false | 61 / 63 | 152,020 ms | 172 s |
>
> ⚠⚠ **READ THE 48 AND 56 ROWS TOGETHER: 56 PASSES WHILE 48 FAILS. THE LADDER IS NON-MONOTONIC,
> SO THERE IS NO CAPACITY CEILING HERE TO FIND.** I had expected a threshold and went looking for
> it; the data refuses one. Two independent signals say the same thing:
>
> 1. **Pass/fail is not ordered by peer count** — ✅32 ✅40 ❌48 ✅56 ❌64.
> 2. **Run-to-run variance dominates the peer-count signal outright.** Convergence p95 swings
>    **25×** between *adjacent* configurations (1,538ms at 40 peers vs 39,469ms at 32 peers).
>    A quantity that moves 25× on a variable that is supposed to be the independent one is noise
>    with a trend buried in it, not a capacity curve.
>
> **⚠ THIS RETRACTS A CLAIM I MYSELF WROTE INTO THIS DOCUMENT ~15 MINUTES EARLIER.** On the 32/64
> pair alone I wrote *"on measured evidence this system supports 32 peers, not 256"* and
> *"the break lies between 32 and 64"*. **Both are withdrawn.** Two points looked like a threshold;
> five points show they were two samples from a noisy distribution. I also worried in that same
> text that the 32-peer p95 of 39.5s was an uncomfortable product bar — that concern is likewise
> void, since 40 peers came in at 1.5s. **No supported-mesh-size number is derivable from this
> data, and nobody should quote one — including the "32" I published.**
>
> **What the evidence DOES support, and this is still substantial:**
> - Convergence failures at this scale are **real and reproducible in aggregate** (48 failed; 64
>   failed on both of two independent runs). This is not measurement error.
> - They are **intermittent/probabilistic, not a hard ceiling** — consistent with the other thing
>   the runs show: the set of lagging readers, and its size, **varies between runs** (2 then 4).
>   There is no specific broken peer; my earlier naming of "readers 16 and 38" is also falsified.
> - Therefore the defect is a **flaky convergence failure whose incidence appears to RISE with
>   peer count**, which is a materially different — and harder — defect than a capacity limit.
>
> **What it would take to get a real number:** N repeated runs per configuration, reported as a
> convergence RATE rather than one boolean per config. Every row above is n=1 except 64 (n=2).
> **128 was deliberately NOT run** — ~450MB RSS/peer ⇒ ~58GB against ~65GB free on a shared box
> with live peers; and on this evidence a single 128 sample would not have meant anything anyway.
>
> ### 🛑 I RAN THAT RATE EXPERIMENT, AND IT DISQUALIFIED THE INSTRUMENT — `convergencePassed` IS NOT CURRENTLY TRUSTWORTHY (`EI-20581532536662596`, critical)
>
> Six repeated runs at a **fixed** 48 peers, same host, back to back:
>
> | run | 1 | 2 | 3 | 4 | 5 | 6 |
> |---|---|---|---|---|---|---|
> | duration | 115,895 ms | 55,352 ms | 51,398 ms | 32,359 ms | 25,114 ms | 30,934 ms |
> | verdict | ❌ 46/47 | ❌ 46/47 | ✅ 47/47 | ✅ 47/47 | ✅ 47/47 | ✅ 47/47 |
>
> Identical configuration, mixed outcomes — and **the only two failures are the two slowest runs**,
> with the outcome tracking wall-clock duration monotonically. So I read the code that writes the
> verdict. `scenarios/replication.ts:55-59` awaits the readers **SERIALLY, each with a fresh
> hardcoded 30s budget**, and `child-driver.ts:81-82` returns immediately for an already-fired
> event. Therefore **the deadline is not a property of the run — it is a property of a reader's
> position in the iteration order**: the first-polled reader gets exactly 30s from loop start,
> while the Nth gets 30s *plus* all the time already spent waiting on readers 0…N−1. The same call
> site also declares `catchUpTimeoutMs: 120_000` for those readers, so the parent abandons at 30s
> a child its own config gives 120s. (`replication.ceiling` has 300s on both sides — consistent —
> so `sustained` looks like an edit that changed one number and not the other.)
>
> **This predicts the signature exactly:** across 7 runs at 48 peers, every failure missed by
> **precisely one** reader (46/47 — never 45, never 44). A genuine substrate or capacity failure
> has no reason to always miss by exactly one; a first-polled-reader timeout that then widens
> everyone else's budget does.
>
> **CONSEQUENCE: a red `convergencePassed` currently cannot distinguish (a) the substrate failed
> to replicate from (b) the box was loaded, the run took >30s, and the first-polled reader tripped
> a fixed timer.** This box carries a large agent fleet (host load ~70–76/128 throughout, and I was
> running perf jobs myself). Every convergence red quoted in this document — 48 and both 64s —
> inherits that ambiguity. **Do not treat "the mesh does not converge at 64 peers" as established.**
> Note the irony and take the lesson: this is the SECOND defective verdict found in this one
> measurement (the first was `sloPassed`, D-009) — the replacement verdict I built inherited a
> broken wait loop underneath it.
>
> ✅ **RESOLVED 2026-08-16T05:0xZ (`#D-015`) — and the ambiguity above resolved AGAINST the reds:
> the mesh DOES converge at 64 peers, 63/63.** The wait is now concurrent against one shared
> deadline; the ladder is monotone and green to 64. ⚠ The green is BOUNDED and the bound is
> load-bearing: the fix also unified a budget drift (child declared 120s, parent abandoned at 30s)
> upward to 120s, so the artifact now records `budgetMs` beside a `convergedMs` distribution to
> keep a pass ATTRIBUTABLE. Measured at 64: p50 7,095ms · p95 35,355ms · max **59,946ms** against
> a 120s budget — **the old 30s wait would have failed this run on its own merits.** So both
> defects were real: the order-dependence AND a deadline too short for the mesh size.
> **The lesson generalises past this row: a verdict without its threshold is not a measurement.**
> Two defective verdicts here shared one shape — `sloPassed` measured the wrong thing, and
> `convergencePassed` measured the right thing against an invisible, drifting threshold. Any
> green in this document sourced from a threshold must now carry that threshold with it.
>
> ⚠ **WHAT THIS DOES *NOT* TOUCH, so the correction is not overread:** the swarm-guard root cause
> and fix (D-010/D-011) stand entirely. They rest on a mechanism unit test plus a controlled
> before/after in which the **pre-fix p95 was 601,075 ms — 20× beyond any 30s window** — with 33
> readers lagging, improving to 2–4, alongside a 5.9× duration drop and 41% of propagation events
> that simply never occurred pre-fix. None of that depends on this wait loop. Row 14 stays 🔴 on
> the strength of *that* evidence; what is now unproven is the narrower "fails to converge at 48
> and 64", not the existence of a real scale problem.
>
> ⚠ **How to read a p2p-perf artifact when checking any of this:** cite `convergencePassed`, never
> `sloPassed`. `sloPassed` measures host event-loop responsiveness and read `true` on the pre-fix
> run in which 33 of 63 readers never converged. See the reading-rule row under §2.1.

> ## ⚠⚠ RE-SIGNED AGAIN 2026-08-16T06:4xZ (su-0c703, `WI-39359`, owner-directed AUTO) — VERDICT UNCHANGED (**NO-GO**). A THIRD instrument defect was found, and it bounds the 64-peer result the block above rests on.
>
> **The verdict does not move, and neither of the two standing NO-GO reasons is weakened.** What
> changes is the *scale* evidence — in both directions, which is why this needs its own block
> rather than an edit to the one above.
>
> 🛑 **THE PERF HARNESS WAS MEASURING HYPERSWARM'S DEFAULT, NOT THIS SUBSTRATE.**
> `perf/fixture.ts` and `perf/peer-child.ts` both did `new Hyperswarm({ bootstrap })` with **no
> `maxPeers`**, inheriting the library constant `MAX_PEERS = 64` (`node_modules/hyperswarm/index.js:13`),
> after which hyperswarm refuses connections **silently**. A flat N-peer mesh needs N−1 connections
> per peer by construction, so the rig was pinned near ~65 peers regardless of the ladder. Both
> sites now build through the product path `swarmConstructorOpts()`; `lint:tsc` clean. On this host
> that resolves `maxPeers: 2048` / `maxClientConnections: 1984` — the 64→128 ladder now uses ≤6.2%
> of the connection budget, so no cap binds anywhere in it. Recorded as
> `harden-shared-hive-to-256-peers-2026-06-29#D-017`.
>
> ⚠ **IT BOUNDS THE BLOCK ABOVE — the 64-peer green there ran 63 connections against a 64 cap,
> one slot spare, logging `peer cap pressure: 58/64` 352 times.** Controlled re-measurement,
> identical params, fixed harness (`test-results/p2p-perf/2026-08-16T06-20-39-454Z/001`):
> cap-pressure **352 → 0**; convergence p50 **7,095 → 7,267ms (flat)**, p95 **35,355 → 14,604ms**,
> max **59,946 → 22,074ms**. A tail collapsing 2.7× while the median does not move is a
> **connection-cap** signature, not replication speed.
>
> **Two claims from the block above therefore FLIP, and they flip in OUR FAVOUR — which is exactly
> why I am flagging them rather than quietly enjoying them:**
>
> 1. ⛔→✅ **"It does NOT converge within 30s (measurably false)" is WITHDRAWN.** On the fixed
>    harness all 63 readers converge with a **max of 22.1s** at rate 10 and **21.1s** at rate 100.
>    At 64 peers it *does* converge within 30s.
> 2. ⛔ **"The open question is no longer correctness but SPEED — ~1min to last-reader convergence"
>    is WITHDRAWN.** That ~60s figure was the cap, not the substrate. There is no ~1min speed
>    question at 64 peers to put to the owner.
>
> 🛑 **AND THE PART THAT DOES NOT FLIP — flip condition (b) is now ATTEMPTED AND RED, which is a
> WORSE position than "unmeasured".** The re-measured ladder (64/80/96/128, two writer rates,
> `EXIT=0`, artifacts `.../2026-08-16T06-20-39-454Z/001…008`): **64@10 ✅63/63 · 64@100 ✅63/63 ·
> 80@10 ❌72/79 · 80@100 ✅79/79 · 96@10 ✅95/95 · 96@100 ❌22/95 · 128@10 ❌121/127 · 128@100
> ❌126/127.** 64 is clean at both rates with 5.4× headroom. **Above 64 it is NON-MONOTONIC AGAIN**
> — 80@10 fails while 80@100 and 96@10 pass; 96@100 collapses to 22/95 while the *larger* 128@100
> reaches 126/127.
>
> ⚠ **Do not reach for "instrument noise" a fourth time by reflex.** All three known instrument
> defects are fixed and the cap provably does not bind, so this needs a different explanation.
> Two candidates, **not separated**: (a) **host contention** — a shared dev box running ~93 agents
> at load 67–96 across 128 cores during the run; (b) a **genuine intermittent mesh-formation
> defect above 64 peers**. The 96@100 artifact leans toward (b) being at least partly real: its 22
> converged readers converged at **p50 595ms** while 73 never converged at all — a bimodal
> near-instant-or-never split is a **topology** signature, not the smooth right-shift a loaded host
> produces. **Neither is established; quote neither.**
>
> **NET EFFECT ON THE FLIP CONDITION.** (a) gate `local_matrix=OK` — **unchanged, and still
> owner-walled** (the `aviynw` GitHub token is invalid; the shared-identity workaround is REFUTED
> — `pot_members`' PK `(workspace_id, pot_home_slug, github_user_id)` collapses owner and member
> onto one row, so the probe would compare the owner against itself and **PASS having measured
> nothing**). (b) **run, and RED above 64** — the peer count we can claim is **64**, not more.
> (c) peer-B stall — unchanged. ✅ May be claimed: *the mesh converges at 64 peers, at 10/s and
> 100/s, with every reader inside 22.1s of a 120s budget, on a harness with no known instrument
> defect.* ⛔ May NOT be claimed: **anything at 80 peers or above.** The last honestly-measured
> point is still 64 — now measured much *better*, not further *out*, and 256 remains unevidenced.
>
> ✅ Verification for this block: perf suite **91/91 green across 9 files**; swarm config suites
> **50/50 green**; `lint:tsc` clean, exit 0.

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

> ## 🛑 RE-SIGNED A THIRD TIME 2026-08-16T17:5xZ (su-0c703, `WI-39359`, owner-directed AUTO) — VERDICT UNCHANGED (**NO-GO**). Row 14's ENTIRE EVIDENCE BASE HAS BEEN DELETED FROM DISK, and the rule of record immediately above is what it violates.
>
> **Every artifact path cited in row 14 no longer exists.** All of
> `test-results/p2p-perf/2026-08-16T{02-32-24-570Z, 03-38-08-035Z, 03-50-04-804Z, 03-57-26-753Z,
> 04-55-00-703Z, 06-20-39-454Z/001…008, 09-40-17-138Z}` — the pre/post swarm-guard pair, the six
> fixed-48 repeats, the 64-peer run that settled the convergence question, and the full
> re-measured ladder on the fixed harness — are gone. `test-results/p2p-perf/` now contains
> exactly one subdirectory, `projection-write/`, unrelated to the ladder.
>
> **The absence is measured, not inferred.** Positive control: the same glob
> (`find / -name '*replication.sustained.json'`) still returns June/July artifacts under
> `/mnt/data/offload/reclaim-quarantine-2026-08-11/…`, so the instrument works — it simply finds
> no August run anywhere on this filesystem. `find / -type d -name '2026-08-16T06-20-39-454Z'`
> returns nothing. The offload quarantine's newest p2p-perf run is `2026-08-03`, and it is from a
> different tree.
>
> **This was structural, not bad luck.** `test-results/` is gitignored (`.gitignore:42`
> `**/test-results/`), so these artifacts were never committable and never committed. The only
> retained p2p-perf surface is `packages/operator-core/lib/sync/hyperbee/perf/baselines/tier1.json`
> — and that file was captured **2026-07-26**, before `convergencePassed` existed, and contains
> **zero** occurrences of `convergence`, `convergencePassed` or `budgetMs`. So the surface designed
> to outlive the artifacts retained `loopLagP95Ms` — the SLO this very document's reading rule
> (row "—", below row 14) says "must never be quoted alone as a scale or correctness verdict" —
> and dropped the convergence verdict, which was added expressly to stop that misreading. The
> retained surface kept the number nobody may cite and discarded the one they must.
>
> **What this does and does NOT change.**
> - ⛔ It does **not** retract any measurement. The runs happened and were recorded
>   contemporaneously, in this document, by the agent that ran them.
> - 🛑 It **does** demote every row-14 figure from *re-derivable* to *recorded-only*. Under this
>   document's own rule of record — "never prose" — row 14's ✅ claim ("the mesh converges at 64
>   peers, both writer rates, every reader inside 22.1s against a 120,000ms budget") **no longer
>   cites a live artifact. It cites this paragraph.** Nobody can now re-open those files to check a
>   quoted figure, re-examine the bimodal 96@100 split (22 readers at p50 595ms, 73 never), or
>   diff a future run against them.
> - 🛑 It **removes the baseline for the one measurement row 14 leaves open.** Separating host
>   contention from a genuine >64-peer mesh defect was to be done by re-running 96@100 and 80@10
>   and comparing against the 06-20-39-454Z ladder. That comparison is no longer possible; a
>   re-run can now only be compared against fresh runs of its own.
> - ✅ The **verdict is unchanged: NO-GO**, and neither standing NO-GO reason is weakened. This
>   makes the evidentiary basis of the row's *bounded green* weaker, never the case for shipping
>   stronger.
>
> **Class fix landed with this re-sign** (so the next ladder is not lost the same way):
> `BaselineEntry` in `packages/operator-core/lib/sync/hyperbee/perf/compare.ts` now carries a
> **required-and-nullable** `convergence: ConvergenceStats | null`, populated by both construction
> paths (`baselineFromArtifacts`, and `baselineFromHistory` — which carries the newest observation,
> explicitly labelled, because quantiling a pass/fail verdict would manufacture a number no run
> produced). Required rather than optional on purpose: an optional field is exactly what let it be
> omitted silently the first time. Guarded by
> `perf/baseline-retains-convergence.test.ts` (5 tests), which keeps a **permanent pre-fix control**
> — a deliberately-wrong builder that drops the field — so the retention assertions are provably
> able to fail; plus a calibration case pinning "no mesh formed" to `null` rather than a fabricated
> verdict. 25/25 green with the existing comparator suite; `lint:tsc` `scope=all exit=0 status=clean`;
> required-field strand check clean.
>
> ⚠ **The fix does NOT recover the lost data** — nothing can. It only ensures the NEXT ladder's
> convergence verdict survives on a committed path. Recovering row 14's evidence requires re-running
> the ladder, which needs a quiet host (see the row's own open question).

> ## ✅ UPDATE 2026-08-17T04:4xZ (su-0c703, `WI-39359`, owner-directed AUTO) — THE RETAINED-SURFACE CLAIM ABOVE IS NOW STALE; THE CLASS FIX IS PROVEN END-TO-END; A FOURTH INSTRUMENT DEFECT FELL OUT OF CHECKING IT. **Verdict unchanged (NO-GO), and no §3 blocker moves.**
>
> **1. The stale claim, corrected.** The re-sign block above states that the only retained
> p2p-perf surface, `baselines/tier1.json`, "was captured **2026-07-26** … and contains **zero**
> occurrences of `convergence`, `convergencePassed` or `budgetMs`". Re-measured on the file now on
> disk — sha256 `b68598d386f6a7eb`, `capturedAt` **2026-08-17T03:02:51.421Z**, profile `ci`, 128-cpu
> host — **9 of its 17 entries carry a non-null `convergence` block** with `budgetMs`,
> `convergedMs` percentiles, `convergedReaders/expectedReaders` and `laggingReaders`. The class fix
> is no longer merely landed in code: it has survived a real promotion onto a committed path.
> The other 8 entries are `convergence: null`, which is the **calibration case working, not a gap** —
> they are exactly the four pure-merge microbenchmarks (`merge.decode-throughput`, `merge.full-merge`,
> `merge.idle-tick`, `merge.delta-tick`, two history sizes each), which form no mesh and have no
> readers to judge. Incidentally corroborated on a committed artifact: all 9 carry
> `p95LimitMs: null`, i.e. the latency half of `convergenceVerdict` is unreachable in every real run
> because `convergenceP95LimitMs` has no production caller.
>
> ⛔ **2. What this does NOT do — and the bound IS the point. It does not restore row 14, and it
> brings nothing above 5 peers back into evidence.** The retained convergence entries top out at
> `replication.sustained peers:5` and `replication.ceiling peers:5` (4 readers each), plus
> `churn.reconnect-storm` (8 expected readers). Row 14's subject is **64** peers and its target is
> **256**. The committed surface therefore now carries convergence data **an order of magnitude
> below the last honestly-measured point**, and still cannot be diffed against the deleted
> `06-20-39-454Z` ladder. **Row 14 stays 🟡**, its figures stay *recorded-only*, and separating host
> contention from a genuine >64-peer mesh defect still requires a fresh ladder on a quiet host.
>
> 🛑 **3. A FOURTH INSTRUMENT DEFECT — and it was already committed into that baseline
> (`WI-39359`, fixed here).** `scenarios/churn.ts` never received the `#D-014` (shared deadline) or
> `#D-015` (declared goalpost) fixes; both were applied to `scenarios/replication.ts` and to the
> shared helpers only. Churn kept the pre-fix shape in three places —
> `for (const r of readers) await r.waitFor('caught-up', budget)` — which, because `waitFor` returns
> immediately for an already-fired event, makes a reader's deadline a function of its **position in
> the array** (budget PLUS all time already spent on the readers ahead of it), strictly more lenient
> the later it sits. It also never called `convergenceBudget()` or `readerConverged()`, so its
> artifacts carried `budgetMs: null` + `convergedMs: null`: a bare converged/not boolean with no
> goalpost and no times — **precisely the un-interpretable green `#D-015` exists to prevent**, which
> is how `churn.reconnect-storm 8/8 converged` entered the retained baseline meaning nothing about
> speed. Fixed: all three sites route through `awaitAllChildEvent()` (one shared deadline) and
> declare their budget and per-reader times. Guarded by
> `perf/scenario-convergence-instrumentation.test.ts` (5 tests) — a pure source auditor with a
> **permanent pre-fix control** that must report all three violations, a fixed-shape control that
> must report none, a calibration case pinning "forms no mesh ⇒ out of scope, not a violation", and
> a positive control asserting the audit actually reaches the sources (an empty glob would make
> "no violations" vacuous). It complements `await-all-child-event.test.ts`, which proves the
> *mechanism*; this one proves its *adoption*, the gap that let churn sit unconverted. 5/5 + 55/55
> across the neighbouring perf suites; `lint:tsc` `scope=files exit=0 status=clean`.
>
> ⚠ **SCOPE — this must NOT be read as bounding row 14's ladder.** That ladder ran
> `replication.sustained`, whose sites were converted at the time; **none** of row 14's 64/80/96/128
> figures came from `churn.*`. What this defect bounds is the two churn entries in the retained
> baseline and any future churn convergence verdict — nothing else. The baseline is **not**
> re-promoted here: a good baseline is not overwritten to demonstrate a fix.
>
> ✅ **4. §3 re-derived: no blocker moves.** Rows 0 (`aviynw` token), A (C-001 from-repo consent
> cut), B (dark gate timer), 1 (WI-6680 pull-chain seeding), 2 (hive-git live legs), 3 (gate
> coverage gaps) and 4 (code-signing certs) were **none of them gated on convergence data**. Each
> was re-read against the restored surface and is unchanged. Recording that plainly is the finding:
> the retained baseline answers a regression-guard question, not a release-blocker question.

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
| 3 | Coord control-plane federation + trust boundary | 🟢 | ⚠ **EVIDENCE RE-BASED 2026-09-02 (`WI-42226`/P-009, plan `p2p-coordination-public-release-2026-08-26`). The 🟢 STANDS — but not on the evidence this row used to cite, and the change is not cosmetic.** ⟨prior basis, retained as history⟩ `scn.coord_bidir-220032.log` + `scn.coord_controlplane-220032.log` — "harness-scoped msg/escalation/handoff federate; raw presence/watermark/await stay local". **That basis is insufficient on its own.** That plan's `#D-002` (binding, from a code-truth read of `papercusp-desktop/bin/lib/scenarios/00-base.sh` `scn_coord_bidir` and `papercusp-desktop/bin/deb-hetzner-coord-controlplane.sh` `_ctrl_coord_probe`) establishes that those two scenarios prove ONLY that a harness-scoped `coord_event_log` row crosses both directions as `origin='remote'`. They never call `coord:send` from a real agent, resolve a remote recipient, prove recipient inbox/feed visibility, thread a reply via `related_msg_id`, exercise wake-on-reply, or deliver a real conversation/report back to the origin. **So this row's original 🟢 was TRANSPORT-LEVEL and quietly overstated its own stated bar ("control-plane federation + trust boundary").** ⟨current basis⟩ P-008's coordination-only live witness, **17/17 GREEN on the REAL two-machine rig** — tower `main-server-Precision-7865-Tower` ↔ `Avis-iMac.local`, 2026-09-02 18:39–19:53Z, `WI-42225`: **CC-1..CC-5** (`papercusp-desktop/bin/vm-rig/coord-controlplane.sh`; CC-3 is `#D-029`'s named acceptance canary and flipped green at 18:43Z), **CR-1..CR-4** (directed reply/report back to origin, conversation visibility ×2, trust negative), **CD-0..CD-7** (`papercusp-desktop/bin/vm-rig/coord-p008-custody.sh` — reconnect / catch-up / restart). Those legs are exactly the gaps `#D-002` named, which is why the row may now carry its own bar. ⚠ **Do not quote this row without the coordination-slice signature that follows §2.5** — the lane carries an OPEN observability residual that this row's correctness scope does not cover, and reading row 3 alone will overstate the lane. |
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
| 14 | **Mesh scale — replication capacity at peer count (the 256-peer target)** | 🟡 | **ADDED 2026-08-16T03:5xZ (su-0c703, WI-39359). This criterion had NO ROW in this document until now, which is itself the finding: the scale claim was never on the signed table.** ⚠⚠ **Every measurement of this system above ~32 peers, ever taken, is VOID as a statement about replication capacity** — all of them ran through a DoS guard that was banning the mesh. Root cause (fixed, `EI-20578573707248054`, authority `committed`): `swarm-guard.ts` keyed its connection-rate bucket `ip ?? keyHex` — **IP first** — and a trip banned the **IP**, so peers behind one egress IP shared ONE 30-conns/10s budget and a single burst evicted every co-located neighbour for `DEFAULT_BAN_TTL_MS` = 600,000ms. A flat N-peer mesh makes ~N−1 inbound connections *by construction*: fine at 16, marginal at 32, **2× over budget at 64**. So the 256-peer target was unreachable **by configuration**, independent of substrate quality. Fix = separate per-KEY and per-IP buckets; recurrence guard `packages/operator-core/lib/sync/hyperbee/__tests__/swarm-guard-colocated-peers.test.ts` (carries a permanent control reproducing the pre-fix behaviour); 97 tests green / 5 swarm suites; `lint:tsc` clean. **THE ROW IS 🔴 ANYWAY, AND THAT IS THE POINT.** Controlled before/after, identical params (`peers:64 rate:10 count:200`), same host, ~1h apart: duration 1,023,652ms → 172,122ms (5.9×), `appendToVisible` p95 601,075ms → 152,020ms, converged readers 30/63 → **61/63**. But the post-fix run is `sloPassed: true` **and `convergencePassed: false`** — readers 16 and 38 never applied all ops, convergence p95 still **152s**. 64-peer operation is therefore **not release-ready on measured evidence**, and 256 is far beyond the last honestly-measured point. Residual filed as `WI-39374` (different mechanism — it matches no guard constant). Artifacts, both on disk: `test-results/p2p-perf/2026-08-16T02-32-24-570Z/005-replication.sustained.json` (pre) and `test-results/p2p-perf/2026-08-16T03-38-08-035Z/001-replication.sustained.json` (post). Decisions `harden-shared-hive-to-256-peers-2026-06-29#D-010` (correcting that plan's own D-008), `#D-011` and `#D-012` — ⚠ note those are that plan's decision ids, **not** this document's D-008 in §6. ✅ **FULL LADDER RUN 2026-08-16T03:5xZ — and it refuses to yield a capacity number, which IS the finding: ✅32 ✅40 ❌48 ✅56 ❌64. NON-MONOTONIC — 56 passes while 48 fails.** Convergence p95 swings 25× between adjacent configs (1,538ms at 40 peers vs 39,469ms at 32), so run-to-run variance dominates the peer-count signal and no supported-mesh-size figure is derivable. ⚠ **This RETRACTS my own earlier text in this row and in the verdict block asserting "supports 32 peers, not 256" and "the break lies between 32 and 64" — both withdrawn; they were two samples from a noisy distribution read as a threshold.** What DOES stand: the failures are real and reproducible in aggregate (48 failed; 64 failed on both of 2 independent runs), the lagging reader set and its size VARY between runs (so my "readers 16 and 38" naming is also falsified — there is no specific broken peer), and the defect is therefore an **intermittent/probabilistic convergence failure whose incidence appears to rise with peer count** — harder than a capacity limit, not easier. 🛑 **AND THEN THE INSTRUMENT ITSELF FAILED REVIEW — see `EI-20581532536662596` (critical) and the verdict block. Six repeats at a FIXED 48 peers went ❌❌✅✅✅✅, and the only two failures were the two SLOWEST runs.** Reading the code that writes the verdict: `scenarios/replication.ts:55-59` awaits readers **serially with a fresh hardcoded 30s budget each** while `child-driver.ts:81-82` returns instantly for an already-fired event — so the first-polled reader gets 30s and the Nth gets 30s *plus* all preceding wait time, making the deadline a function of ITERATION ORDER, not of the run. (The same call site declares `catchUpTimeoutMs: 120_000` for those readers — the parent abandons at 30s a child its own config gives 120s.) This predicts the signature exactly: all 7 failing runs at 48 peers missed by **precisely one** reader (46/47, never 45). **So a red `convergencePassed` cannot currently distinguish "substrate failed" from "box was loaded and a fixed timer tripped" — every convergence red in this document inherits that ambiguity and must not be quoted as established.** ⚠ This does NOT touch D-010/D-011: the pre-fix p95 of 601,075ms is 20× beyond any 30s window, and the 5.9× duration drop plus the 41% of propagation events that never occurred pre-fix are independent of this wait loop. The row stays 🔴 on THAT evidence. Artifacts: `test-results/p2p-perf/2026-08-16T03-50-04-804Z/`, `.../03-57-26-753Z/`, plus six fixed-48 repeats from 04:04Z. ✅✅ **RESOLVED 2026-08-16T05:0xZ — THE INSTRUMENT WAS THE DEFECT, AND THIS ROW DROPS FROM 🔴 TO 🟡 (plan `#D-015`).** The convergence verdict is fixed (concurrent wait, ONE shared deadline; `EI-20581532536662596`, 68 tests green incl. a permanent pre-fix control). On the fixed instrument the ladder is **monotone and fully green: ✅32(31/31) ✅40(39/39) ✅48(47/47) ✅56(55/55) ✅64(63/63)**, `LADDER_EXIT=0`. ⚠⚠ **EVERY ❌ AND EVERY RETRACTION ABOVE IN THIS CELL IS THEREFORE SUPERSEDED** — the non-monotonic ladder, the "intermittent/probabilistic convergence failure", "readers 16 and 38", "64 peers STILL fails": all instrument artifacts. Kept above, not deleted, because the retraction chain is the audit trail. 🛑 **BUT THE GREEN IS BOUNDED, AND THE BOUND IS THE POINT: the fix changed TWO things at once** — it made the wait concurrent AND unified a budget drift (child cfg declared `catchUpTimeoutMs: 120_000`, parent abandoned at `30_000`) upward to 120s. An all-green ladder is equally consistent with "the substrate is fine" and "I gave it 4× the time", and a converged/not BINARY cannot separate them — so the artifact now records the goalpost beside the times (`ConvergenceStats.budgetMs` + `convergedMs`). **The measurement that settles it (64 peers, `test-results/p2p-perf/2026-08-16T04-55-00-703Z`): 63/63 converged against a 120,000ms budget; time-to-converge p50 7,095ms · p95 35,355ms · max 59,946ms; headroom 60,054ms; appendToVisible p95 55,678ms.** Both defects were load-bearing — **the old 30s wait would have failed this run outright** (p95 and max both exceed 30s). ✅ May be claimed: *the mesh converges at 64 peers **within 120s***. ⛔ May NOT be claimed: *converges within 30s* (measurably false); *anything about 256* — **the last honestly-measured point is 64**. **WHY 🟡 AND NOT 🟢:** the row's own target is 256 and nothing above 64 has been measured; and at 64 the slowest reader needs ~60s, so the open question has changed from CORRECTNESS to SPEED — whether ~1min to full-mesh convergence is acceptable is an owner/product call, not a measurement. **To reach 🟢 this row needs (a) a stated convergence SLO at a named peer count, and (b) a ladder above 64.** No longer release-blocker #4 as a correctness defect. 🛑🛑 **THIRD INSTRUMENT DEFECT, FOUND 2026-08-16T06:2xZ (su-0c703, WI-39359) — THE LADDER WAS MEASURING HYPERSWARM'S DEFAULT, NOT THIS SUBSTRATE. Every mesh number above predates the fix, and their TAILS are suspect.** `perf/fixture.ts` and `perf/peer-child.ts` both constructed `new Hyperswarm({ bootstrap })` with **no `maxPeers`**, inheriting the library constant `MAX_PEERS = 64` (`node_modules/hyperswarm/index.js:13`) — after which hyperswarm refuses further connections **silently**. A flat N-peer mesh needs N−1 connections per peer *by construction*, so the harness was pinned near ~65 peers no matter what the ladder asked for. Both sites now build through the product path `swarmConstructorOpts()` (`maxPeers` + the WI-6063 `maxClientConnections` inbound reserve); `lint:tsc` clean, exit 0. **On this host that path resolves `maxPeers: 2048` / `maxClientConnections: 1984`, so the whole 64→128 ladder now runs at ≤6.2% of the connection budget and no cap binds anywhere in it.** ⚠ **THIS RETROACTIVELY BOUNDS THE 64-PEER GREEN CELEBRATED IMMEDIATELY ABOVE** — 63 connections against a 64 cap is ONE slot spare, and the children logged `peer cap pressure: 58/64` **352 times** during those very runs. Controlled re-measurement, identical params, fixed harness (`test-results/p2p-perf/2026-08-16T06-20-39-454Z/001-replication.sustained.json`): cap-pressure warnings **352 → 0**; convergence p50 **7,095ms → 7,267ms (flat)**, p95 **35,355ms → 14,604ms**, max **59,946ms → 22,074ms**. **A tail that collapses 2.7× while the median does not move at all is the signature of a CONNECTION CAP, not of replication speed** — so the ~60s slowest reader on which this row rested its "the open question has changed from CORRECTNESS to SPEED" framing was *instrument*, and that framing is **withdrawn**. (The absence of warnings is corroborated, not merely observed: the warning site `swarm.ts:2642 → reportPeerCapPressure` is untouched by the fix and demonstrably fired from this exact child path pre-fix, and it reads `swarm.maxPeers` off the live instance — at 2048 its 90% threshold is 1,844 live connections, which 127 cannot approach.) ✅ **RE-MEASURED LADDER ON THE FIXED HARNESS, 2026-08-16T06:20Z** (`EXIT=0`; artifacts `test-results/p2p-perf/2026-08-16T06-20-39-454Z/001…008`), two writer rates per rung, as `converged/expected, slowest-reader`: **64@10 ✅63/63 22.1s · 64@100 ✅63/63 21.1s · 80@10 ❌72/79 (7 lagging) · 80@100 ✅79/79 33.4s · 96@10 ✅95/95 49.4s · 96@100 ❌22/95 (73 lagging) · 128@10 ❌121/127 (6 lagging) · 128@100 ❌126/127 (1 lagging).** **64 is clean at BOTH rates with 5.4× headroom; above 64 the ladder is NON-MONOTONIC AGAIN** — 80@10 fails while 80@100 and 96@10 pass, and 96@100 collapses to 22/95 while the larger 128@100 reaches 126/127. ⚠ **Why this non-monotonicity must NOT be filed as "more instrument noise" by reflex:** all three known instrument defects are now fixed (`harden-shared-hive-to-256-peers-2026-06-29#D-014` serial deadline, `#D-015` budget drift, and this peer cap — recorded as that plan's `#D-017`; ⚠ **every bare `#D-NNN` in this cell is an id on THAT plan, never this document's own D-NNN in §6/§8 — in particular this document's D-016 in §8 is the `SKIP_FROMREPO` flip and is unrelated to the convergence SLO below**), and the cap is provably not binding (6.2% of budget), so the pattern needs a *different* explanation. Two candidates remain, and I have **not** separated them: (a) **host contention** — this is a shared dev box running ~93 agents at load 67–96 across 128 cores during the run, and a 128-child mesh competes with the entire fleet; (b) a **genuine intermittent mesh-formation defect above 64 peers**. The 96@100 artifact discriminates partly in favour of (b): its 22 converged readers converged at **p50 595ms** while the other 73 never converged at all. A bimodal split — near-instant or never — is a **mesh-formation/topology** signature, not the smooth right-shift that a loaded host produces. ⛔ **Neither candidate is established. Do NOT quote "the substrate breaks above 64", and do NOT quote "it's just a loaded box".** **WHAT THIS ROW NOW SIGNS.** ✅ May be claimed: *the mesh converges at 64 peers, at both 10/s and 100/s writer rates, with every reader inside 22.1s against a 120,000ms budget, on a harness carrying no known instrument defect.* ⛔ May NOT be claimed: anything at 80 peers or above — **the last honestly-measured point is still 64**; it is now measured far BETTER, not further OUT. **THE ROW STAYS 🟡.** Its two stated conditions for 🟢 are unchanged but have both moved: (a) a stated convergence SLO at a named peer count — **now DONE**, `#D-016` (100% of readers, p95 ≤ 60s, max ≤ 120s at 64 peers; tagged `[self-imposed]` under AUTO — **NOT an owner ruling**, and whether ~20s full-mesh convergence is acceptable for the product remains an owner call); (b) a ladder above 64 — **now ATTEMPTED AND RED**, which is a *worse* position than "unmeasured" and is the honest reason this row cannot go green. 📊 **`#D-016`'s margins RESTATED on the fixed harness** — the SLO was declared against pre-fix numbers and understated its own margin: p95 **35,355ms → 14,604ms** against the 60,000ms limit (59% → 24% of budget); max **59,946ms → 22,074ms** against the 120,000ms limit (50% → 18%). **The SLO verdict does not flip — it passed before and passes now — but it passes with ~3× more headroom than the numbers it was written against, at both writer rates.** |
| — | ⚠ **Reading rule for rows 1–14, earned on row 14** | — | **`sloPassed` measures HOST RESPONSIVENESS (event-loop lag), never convergence — it must never be quoted alone as a scale or correctness verdict.** The pre-fix 64-peer run reported `sloPassed: true` while 33 of 63 readers never converged. A second, deliberately separate verdict `convergencePassed` now ships in every p2p-perf artifact for exactly this reason (`EI-20576392705164447`, `harden-shared-hive-to-256-peers-2026-06-29#D-009`) and **caught this on its first live run**. Any future green on this table sourced from a p2p-perf artifact must cite `convergencePassed`, not `sloPassed`. |

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
| 22 | **LIVE-2 end-to-end acceptance drill** (offer→pull→spawn→receipts→revocation, every leg observable from the origin, any silent leg = FAIL, on the 2-machine rig) | 🔴→🟡 | **RUN 2026-08-01 (P-205/WI-5135) — no longer "never run", but NOT a full pass; read the leg-by-leg, not the headline.** Single-box drill `PASS=12 FAIL=0 SKIP=6` (packaged deb, `bin/work-distribution-drill.sh`) **+** the federated-revocation leg proven cross-node by a NEW registered matrix scenario `bin/lib/scenarios/fed-reap.sh` (order 59), run `m1785612213`: `b: grant\|revoked\|remote → session\|reaped → receipt work-offer:reap`, with the ACTIVE-grant baseline passing first so the reap is *attributable*. Against this row's own bar: **offer ✓** · **pull ~** (X11 activation + the WI-3629 seam ship in the packaged bundle, but no live pull was ever exercised — nothing ticks it) · **spawn ✓ EXERCISED 2026-08-08** (superseding this row's ✗ — see the correction under the blocker note below: real 2-machine rig, packaged install, BOTH refused and honored branches, receipts `425b8ab1` / `af20b5e3`; ✅ CORRECTED 2026-08-20 (WI-39950): the historical honored member DID take 4 model-authored turns and 48 tool calls, then stopped per kickoff; the old WI-35786 phantom-member caveat was false. Current code independently fails closed unless a fresh tool-backed first turn is observed) · **receipts ✓** (offer-threaded, single-box *and* cross-node) · **revocation ✓ local AND ✓ federated**. ⚠ Environment: 2 **container frames** on a **private testnet DHT** — *not* two physical machines, *not* the public DHT (sufficient for this leg because `origin='remote'` keys on hyperbee source-log/device provenance, not a physical boundary — but do not quote it as the 2-machine rig; row 35 still owes that). ⚠ Both proofs used a **SEEDED**, not spawned, foreign session — see the blocker note below. Also landed: **D-018** — this drill's SKIP census was six *hardcoded strings* whose reasons had rotted into falsehood (5 of 6 false; one contradicted the drill's own header), so a clean run would have produced a plausible, quotable, WRONG reading; every reason is now DETECTED at runtime from the artifact under test |
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
| 34 | hive-git P2P plane — LIVE legs | 🔴 | **NO-GO; terminal rig acceptance is still in flight** (`p2p-git-live-activation-2026-07-09`, current through plan v358). D-044 closes two frame-level residuals but explicitly does **not** promote the release verdict. Leg A remains open as P-302/WI-3496; the signed finish line remains **P-302 → P-306 → P-308 → P-402 (72-hour soak)**. No partial transfer, single-box drill, or frame fix substitutes for that executed sequence. |
| 35 | Cross-platform witness — Linux tower ↔ mac VM | 🟡 | **Supporting witness refreshed, not release acceptance.** The 2026-08-26 rig evidence established a live peer link, a completed G-8 cold join, zero steady-state churn after the startup transient, and refs replicated after churn stopped. The observation window was about 12 minutes, the primary `papercusp.git` namespace still required bounded live-write diagnosis, and D-044's frame-level closure does not satisfy P-302/P-306/P-308 or the 72-hour P-402 soak. |

> **Git-slice signature — 2026-08-26, WI-42234/P-508: NO-GO.** Rows 34–35 are
> current with plan v358 and D-044. The verdict may move only after executed,
> recorded evidence closes **P-302 → P-306 → P-308 → P-402**; documentation or
> intermediate rig health alone cannot sign GO.

> **Coordination-slice signature — 2026-09-02, `WI-42226`/P-009 (plan
> `p2p-coordination-public-release-2026-08-26`, and `WI-37110`, the owner-directed
> lane): the coordination slice contributes GO on functional correctness, carrying
> ONE named OPEN observability residual. Net for the slice: 🟡, not 🟢.**
>
> **SCOPE — read this first.** This signature covers the **coordination** slice ONLY:
> §2.1 row 3, the `papercusp-presence-gossip` flag row in §7, and the coordination-lane
> input recorded in the 2026-08-16 block. It is scoped by that plan's `#D-005` and by
> two independent owner-typed turns (2026-08-08 assigning this lane; 2026-08-11 scoping
> a *different* agent to "all our p2p features other than the coordination and git
> features"). **It does NOT touch, soften, or contribute to the document's headline
> verdict**, which is NO-GO on non-coordination grounds — rows 34–35 (git), §2.1 row 14
> (mesh scale), W1, and `WI-40537`. Nothing below is a reason to move that verdict, and
> a GO on this slice is not a GO on the feature.
>
> **WHAT IS SIGNED GO.** End-to-end, origin-visible coordination delivery is witnessed
> **17/17 on the real two-machine rig** (`WI-42225`, 18:39–19:53Z: CC-1..CC-5, CR-1..CR-4,
> CD-0..CD-7). This is the first evidence in this document that satisfies `#D-002`'s bar
> rather than the transport-level proxy row 3 previously rested on. Per `#D-029` the
> acceptance canary was CC-3; it flipped green at 18:43Z and the item closed at 19:54Z,
> after — not before — its blocker drained.
>
> **WHAT IS SIGNED OPEN, and why the slice is 🟡.** Inbound coordination federation
> suffered a **~8-hour silent outage on 2026-09-02** (substrate merge on log
> `cb54460d98d8` pinned at position 12048 across ~39 harness cursors; `WI-2141796`).
> It has since drained — independently re-measured for this signature: remote and local
> `coord_event_log` ids fully interleave from 18:00Z onward at 119–125 remote rows/hr,
> agreeing with the two peers who recorded the drain at ~18:35Z. **The outage is over;
> the DETECTOR gap is not.** Eight hours of dead inbound produced no durable EI (the
> standing-cooldown gate reads the most recent matching EI; the frozen guard fired 126×
> in 5h with no repair). `WI-2141796` therefore remains correctly OPEN on the detector,
> not on the outage, with the discriminator tracked as `WI-2142252`.
> ⚠ This is the **second** instance of one class in this document: the 2026-08-16 block
> already records peer machine B federating nothing for 48h with zero alerts
> (`EI-20579195481991931`, host-local stall detection). Two silent multi-hour federation
> stalls, neither self-alarmed. **That pattern — not either individual outage — is the
> coordination slice's open release risk**, and it is why this slice cannot sign 🟢.
>
> **MEASUREMENT HAZARD, recorded so the next signer does not repeat it.**
> `coord_event_log.ts` is a `timestamp with time zone` preserving the **origin's event
> time**, not the apply time; `id` is the only apply-order truth. Grouping remote rows by
> `ts` makes a backfill indistinguishable from real-time application — and makes the true
> stall recorded in `#D-029` read as if it never happened. The discriminator is that
> backfilled rows carry one contiguous id band far above contemporaneous local ids
> (measured here: 18183525–18184640 against local 18043870–18128219 for 11:00–16:00Z).
> Anyone re-checking this row must use `id`, never `ts`.

---

## 3. Release blockers, in order

> **ADDED 2026-08-09 — these two outrank everything numbered below.** They are listed ahead of the
> original list rather than renumbered into it, so the pre-existing numbering stays quotable.

> ⚠ **SUPERSEDED 2026-08-16T03:0xZ (su-c531b, WI-37110) — BOTH of the two rows below are now
> TERMINAL, and a NEW row 0 outranks them.** Verified in PG, not inferred: `WI-37195` = **done**,
> `WI-37144` = **dropped**. Row B's premise ("the gate is DARK, timer stopped") is additionally
> FALSE as of today — the timer is armed and firing (53 runs since 2026-07-27; last 02:47:29Z;
> next 03:39Z). Read row 0 first; A and B are kept verbatim below for quotability only.

**0. CURRENT CORE P2P LIVE EVIDENCE IS BLOCKED BEFORE SCENARIOS — this is the governing in-lane
GO/NO-GO fact.**
   *Re-signed 2026-08-20 by su-416b5 (`WI-39359`). This is an ABSENCE of current live evidence,
   not evidence of a federation defect.*

   Current retained evidence is `/tmp/live-fed-gate-20260820-002304`: sidecar build and bundle
   verification completed; `Papercusp_gate.deb` was repacked; `papercupai` passed the exact
   attestation-write probe with cleanup; and `local-matrix.out` contains one deterministic
   failure, `FATAL(preflight): no gh token for 'aviynw'`. No frame was built, no container was
   provisioned, no cores were evicted, and no scenario ran. A read-only credential re-check at
   signing time agrees: `papercupai` valid, `aviynw` invalid or missing.

   **The one in-lane wall is therefore `aviynw`.** It simultaneously blocks the distinct-account
   local matrix, attestation/live witness, and fresh two-machine evidence. Do not force another
   expensive rig attempt while the preflight is deterministically red, and do not substitute the
   same `papercupai` identity on both frames: that topology collapses the membership identity and
   can false-green. The flip condition is a valid `aviynw` token followed by actual live-leg
   execution and green evidence. Cross-lane ruling:
   `p2p-public-release-remaining-lanes-2026-07-16#D-039`.

   The census and failure chronology below are the **2026-08-16 historical baseline**, retained
   for provenance rather than presented as current counts:

   | | |
   |---|---|
   | gate runs since 2026-07-27 | **53, all RED** |
   | runs where `local_matrix` was REACHED | **3** (2026-08-16 02:47Z, 03:41Z, 04:10Z) — and **0 of them executed a single scenario** |
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

   **Why all three attempts failed — three DIFFERENT unmet preconditions, none of them
   federation.** Updated 2026-08-16T04:3xZ (su-c531b) after driving each one to ground. In no
   run did the rig ever get as far as a federation assertion, so **none of these reds carries
   any information about federation correctness, in either direction.**

   | run | died on | nature |
   |---|---|---|
   | 02:47Z | `FATAL: sidecar node binary missing` — build leg lost a sidecar reader lock to a live `bin/tauri-guarded dev` (pid 1332180, the owner's desktop window) | transient race, now clear |
   | 03:41Z | stale-`.deb` guard (`common.sh` `_warn_if_deb_stale`) | **caused by the attestation wall** — see below |
   | 04:10Z | `FATAL: need a gh token for 'aviynw' (frame b)` | the real, standing blocker |

   **A coupling bug found and FIXED here (`EI-20580419609576585`).** The 03:41Z stale-`.deb`
   death was not bad luck. The gate's §2 `.deb` REPACK — which produces `$GATE_DEB`, which
   `:1520` passes to `local-matrix.sh` as `--deb=` — was gated on `SKIP_MATRIX`, the *same* flag
   the attestation wall sets to skip the two GitHub legs. So the wall **also** starved the
   attestation-INDEPENDENT leg of its artifact, leaving it to fall back to an implicit stale
   bundle and die — silently defeating the very intent of the WI-39359 wall fix credited above.
   Now repacks whenever a consumer leg is due, reusing the gate's own `local_matrix_due()`
   predicate, with a falsifiable recurrence guard in `federation-asserts.selftest.sh`.

   **⚠ CURRENT CORRECTION (2026-08-20).** The earlier `papercupai email_unverified` wall cleared;
   the production probe minted and cleaned up its gist successfully. Both live-evidence paths now
   collapse to the same remaining credential:

   | leg | needs | blocked by |
   |---|---|---|
   | attestation legs | a **mintable gist** + D-030 distinct accounts | **`aviynw` alone** — `papercupai` now passes the write probe |
   | **`local_matrix` (core federation)** | a valid token for each distinct frame identity | **`aviynw` alone** |

   Re-measured 2026-08-20T07:36Z: `papercupai` is valid and its production write probe reports
   `ok:true, cleanedUp:true`; `aviynw` remains invalid or missing. `rig_set_identity`
   (`bin/lib/deb-hetzner-rig.sh:683`) hard-FATALs on an empty token, and frame identities are
   `P_A_USER=papercupai` / `P_B_USER=aviynw` (`deb-hetzner-matrix.sh:141-142`).

   **So the owner ask is ONE command — `gh auth login -h github.com` for `aviynw` — and it is
   sufficient to restore core-federation measurability.** Standing fact:
   `wall:p2p-core-federation-blocked-on-aviynw-gh-token`.

   **RE-VERIFIED 2026-08-16T04:44Z (su-c531b).** Still `papercupai` = 40 chars valid / `aviynw`
   = length 0, "The token in default is invalid". Worth stating because a coord notice at
   04:43Z announced *"GitHub bridge RECOVERED on sidestage"* — that is a **different pot** and
   does **not** clear this wall. Re-run the probe (`gh auth status`) rather than reading any
   similar recovery notice as resolution.

   ✅ **CORROBORATED BY A SECOND, INDEPENDENT ROUTE — and the obvious workaround is a TRAP.**
   *Added 2026-08-16T05:4xZ by su-0c703 (`WI-39359`), re-verified live, not inherited from the
   rows above.* The two preceding "blockers" in this row were both **coupling bugs** that an
   agent could fix (the attestation write-preflight early-exit; the `SKIP_MATRIX` ↔ `.deb`-repack
   starvation, `EI-20580419609576585`). The natural next hypothesis is that this one is too — that
   the frame's GitHub token is incidental to a leg which touches no GitHub. **It is not.** Both
   halves were checked:

   | claim | verdict |
   |---|---|
   | the frame credential is vestigial (nothing reads it) | **FALSE.** `gh` IS installed in the frame image (the Dockerfile heredoc in `local-matrix.sh` installs `gh`), the rig writes `GH_TOKEN` into `/home/pcusp/fed.env`, and `PAPERCUSP_GITHUB_LOGIN` is *unset* on frames — so `gh-token.ts`'s bare `gh auth token` resolves that env token. It is the frame's real GitHub identity. |
   | point both frames at the one valid account (`P_B_USER=papercupai`) and run the leg | ⛔ **DEAD END — and it fails SILENTLY-DEGENERATE, which is worse than failing.** |

   The workaround is refused on a **schema invariant**, not a convention:
   `harness_shared.pot_members` PK = `(workspace_id, pot_home_slug, github_user_id)`, so a pot
   holds **at most one member row per GitHub user id**. The matrix topology is `a`=OWNER /
   `b`=MEMBER and every A↔B assert probes `FRAME_MEMBER_SLUG[a]` against `[b]`. Share one identity
   and both frames collapse onto ONE member row — `oslug == mslug` — so
   `fed_hive_merge_probe a b "$oslug"` probes the owner **against itself** and can report
   **PASS having measured nothing**. That is precisely the false-green class this document exists
   to prevent, arriving disguised as the fix for it.

   **So: two DISTINCT valid GitHub credentials are a STRUCTURAL requirement of the 2-frame
   matrix.** The "ONE command" ask above is confirmed as the only flip — there is no agent-side
   route around it, and nobody should spend another rig run looking for one. Recorded as
   `dead-end:local-matrix-shared-gh-identity-workaround`.

   ⏱ **TALLY AND GATE-STATE REFRESHED 2026-08-16T06:5xZ (su-0c703, `WI-39359`) — the "53, all
   RED" figure at the top of this row is now STALE, and the newest runs are a DIFFERENT
   non-green that must not be misread.** Re-counted from the same file: **58 runs = 53 RED + 3
   FRESH-DOWNGRADE + 1 FRESH-RED + 1 SKIPPED-STORM.** The three most recent (04:43Z, 05:43Z,
   06:38Z) are all `FRESH-DOWNGRADE`, reporting `local_matrix: "?"`.
   ⚠ **A `FRESH-DOWNGRADE` is a deliberate STARVATION BACKOFF, not a failed run, not a
   credential error, and carries NO information about federation** — `live-federation-gate.sh`
   :513-518 skips the window when `last-downgrade` is younger than `GATE_DOWNGRADE_TTL_H`
   (default **3**). The leg reads `"?"` because it is never reached, exactly as on the 51 early
   RED runs — same symbol, different cause. Do **not** count these toward "runs where
   `local_matrix` failed".
   ✅ **The backoff has already expired and needs no intervention:** `last-downgrade` =
   **2026-08-16T03:49:39Z**, +3h ⇒ **~06:49:39Z**, so the next natural fire performs a real run.
   ⛔ Do **not** fire `GATE_FORCE=1` to "unstick" it: the downgrade was caused by host
   starvation (the box was at load 67-96 across 128 cores with ~93 agents), so forcing a run
   into that condition re-starves it — and the run would still terminate at the `aviynw` wall
   above. **The wall itself is re-verified as of 06:5xZ: `aviynw` token length 0, `papercupai`
   40 chars valid.**

   🔒 **P-205 (LIVE-2) IS OWNER-WALLED ON THIS SAME CREDENTIAL — and its own declared blockers
   are already clear**, so nobody should re-audit them. *(su-0c703, `WI-39359`; recorded as
   `p2p-public-release-remaining-lanes-2026-07-16#D-038`.)* Verified: `blockedBy: [P-202]` is
   satisfied — **P-202 = done** (puller activation, WI-5132 passed) and **P-204 = done**
   (executor-spawn leg, WI-5134 passed). One obstacle named in P-205's own note is **stale and
   must not be inherited**: ":3070 still serves 962664ae while checkout/green pin show 1feac8dd"
   — re-measured via `dev:pipeline_position`, deployed `4824a92bf8` = `lastGreenShortSha`
   `4824a92b`, **`deployedBehindGreenPin: 0`**. The deploy skew is RESOLVED. What remains is
   exactly the wall in this row: LIVE-2's `offer→pull→spawn→receipts→revocation` runs on the
   2-frame rig, whose frame `b` identity is `aviynw`. **P-205 therefore cannot be executed or
   closed by an agent** — consistent with its phase label ("owner-gated") and its
   `needs-human` status, which is correct and should stay.

   **A second, larger bug found and FIXED here (`EI-20578660332729593`) — the two non-blocking
   rows above were the same defect, not three separate mishaps.** The 02:47Z sidecar-binary
   death and the 03:41Z stale-`.deb` death, and the 04:10Z gh-token death, are all one class:
   *a cheap, side-effect-free host-side precondition discovered only at its point of use —
   after the frame image is built, containers are provisioned, and 24 exclusive cores are
   evicted off the host fleet.* The first two had each already been patched with their own
   bespoke earlier check; the gh token then failed the same way a third time. `local-matrix.sh`
   now runs a single `preflight_host_preconditions()` **above every state-creating step**,
   covering the sidecar binary, the `.deb` (including the staleness guard) and a `gh auth
   token` for every frame identity the run will register.

   Measured effect: the same box that took 73s and 24 evicted cores to die on the `aviynw`
   token now reports **both** unmet preconditions together in **~1s, having provisioned
   nothing**. Guarded by three property-anchored assertions in `federation-asserts.selftest.sh`
   — the preflight's line number must precede the first state-creating step's, the class
   coverage must hold, and the frame-b identity default must not drift from the gate's — each
   proven falsifiable by mutating an out-of-tree copy. Standing fact:
   `local-matrix-host-preflight-class-fix`.

   > ⚠ **Historical note:** at this point in the 2026-08-16 chronology the census was **3 reached
   > runs / 0 scenarios executed**. The preflight makes *failing* cheap and legible; it does not make
   > the leg *pass*. Only the `aviynw` token does that. Do not read this fix as progress
   > toward a federation verdict.

   A cosmetic-but-misleading defect was fixed alongside it: the stale-`.deb` guard rendered its
   age with integer day division, so every sub-day staleness printed the self-refuting
   *"its mtime is ~0d OLDER than the newest source commit"* — precisely the common case, and
   precisely when the reader most needs the magnitude. It now reports a real delta
   (e.g. `~1h37m`).

   **The same-account workaround is CLOSED — do not retry it (`EI-20582230987234448`).** Running
   both frames on the working `papercupai` identity via `P_B_USER` clears the credential FATAL
   and gets as far as a successful owner publish, then dies at `join-pot` with
   `no_member_joined` because a joiner sharing the owner's identity is not a supported topology.
   There is no same-account route to a verdict; the re-auth is not the cheapest path but the
   only one.

   **Flip condition:** one gate run in which `local_matrix` reports `OK`. **Its blocking
   precondition is now known and singular: `aviynw` must hold a valid `gh` token.** Until then
   further attempts are pure cost — each evicts 24 exclusive cores (104–127) from peers on a
   shared box and cannot reach a scenario. Do NOT force the gate to "try again" in that state.
   Cadence itself is not the problem: `local_matrix_due()` keys off `last-matrix-**green**`, not
   the last run, so a failed attempt does not reset the window and the leg stays DUE — it will
   take the next unforced timer automatically once the credential is restored.

   **✅ THE SEPARATE `papercupai` ATTESTATION WALL IS CLEARED (2026-08-20).** The retained run's
   exact production probe reports `{"user":"papercupai","ok":true,"cleanedUp":true}` — the
   required minted-gist-and-cleanup proof, not a SKIP. Its next line reports only
   `ATTESTATION_WRITE: user=aviynw code=token_missing`. Attestation and `local_matrix` therefore
   share the same sole remaining wall: a valid distinct `aviynw` credential. Standing fact:
   `wall:p2p-core-federation-blocked-on-aviynw-gh-token`.

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
   now CLEARED, so TWO remain.** The `restart_durability` basis is now narrowed by `WI-40388`'s
   signed 2026-08-21T18:29Z run: the 17 failure bundles contain **16 scored restart modes** —
   11 `OWNER-CONTENT`, 5 `NO-RE-EMIT`, and 1 `BASELINE` setup miss excluded from the denominator.
   `OWNER-CONTENT` is the sole current mode. In that signed run, exhaustive failure capture plus
   straight-line control flow proves the no-re-emit assert ran and passed (`drained_at` survived);
   this is bounded to runs that provably executed the assert because the fail bank records
   failures only. `replication_soak` passed 5 kill/restart cycles in both directions with the
   detector quiet and is the load-bearing leg; `restart_settle_barrier` is single-sample
   corroboration only. Neither leg measures the owner's own post-restart origin classification,
   so do not turn either into a user-facing latency or convergence claim. The remaining two
   conditions are therefore (i) `replication_soak` (`WI-5481`, 5/5 runs, load hypothesis falsified
   by frame PSI `avg10=0.00` against host loadavg 42-51) and (ii) the narrowed `restart_durability`
   mode above — both so a re-armed gate is readable rather than permanently noisy; and ~~(iii) **`WI-37464`: a RED gate
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
   > **CORRECTED 2026-08-20 (WI-39950): the historical “phantom member” conclusion was false.**
   > Direct machine-side records show the honored member produced **4 model-authored session turns
   > and 48 tool invocations** (including `coord:orient`), reported that no usable account was
   > available, and then stopped exactly as its kickoff instructed. The missing process five minutes
   > later and the empty directory that motivated the old claim did not prove that no turn occurred.
   >
   > Current code now carries an independent recurrence guard for the real false-success class:
   > `honorSpawnRequestFromProjection` requires a fresh attributed tool invocation before emitting
   > `kind='honored'`; a presence/window without that first-turn proof fails closed with
   > `member_boot_unconfirmed`. What remains unmeasured is a fresh live run of that **negative**
   > macOS login-window case. This correction proves the historical spawn produced a real turn; it
   > does not clear P-205 or change this document’s NO-GO.
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
