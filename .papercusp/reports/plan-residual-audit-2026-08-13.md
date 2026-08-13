# Plan residual review

Generated: **2026-08-13T09:40:35.770Z**  
Tracking: **WI-38420**  
Scope: every plan in `papercusp-workspace`, across all harnesses, including archived plans and scheduled instances.

> `active` means “work now”; `ready` means parked. A residual is any item whose effective status is not `done` or `dropped`. Effective status includes unresolved dependencies, dependency cycles, sticky stored `blocked`, and open engineer-issue blockers.

## Portfolio summary

| Category | Plans | Residual items |
|---|---:|---:|
| Parked ready plans | 60 | 218 |
| Ready plans with live work (lifecycle drift) | 4 | 15 |
| Draft plans with residual items | 38 | 194 |
| Shipped or superseded plans with residual items | 39 | 269 |
| **Total** | **141** | **696** |

### Residual item states

| Effective status | Count | Interpretation |
|---|---:|---|
| `todo` | 416 | Not started or returned to the pool. |
| `wip` | 25 | Marked in progress despite a non-active plan; inspect linked/live work. |
| `blocked` | 232 | Stored block, unresolved dependency, cycle, or open issue blocker. |
| `needs-human` | 23 | Explicitly waiting for human action. |

## Lifecycle drift requiring attention

These plans are `ready` but had live coordination presence in the final 10-minute window:

| Plan | Residuals | Live agents |
|---|---:|---|
| `papercusp/green-checkpoint-speedup-follow-up-2026-08-13` | 6 | `su-ef53baf7-bc74-4dd1-bda9-f05b8424d43f` |
| `papercusp/p2p-public-release-remaining-lanes-2026-07-16` | 1 | `su-12228b46-71c0-46d6-9ff3-3f642b1867e9`, `su-f0630b86-4697-4877-8891-17b7af85ca55` (`p205-physical-202608130555`) |
| `papercusp/voice-public-release-refresh-2026-08-11` | 3 | `su-cb2b4405-151f-48b2-800f-4c50f980cd86` |
| `papercusp/p2p-git-live-activation-2026-07-09` | 5 | `su-686a92b3-385e-4f2d-a12f-2423346965bb` |

## Detailed inventory

### Parked ready plans (60)

<details>
<summary><code>papercusp/drain-admission-integrity-remediation-2026-08-13</code> — DRAIN admission integrity, duplicate cleanup, and net-negative canary — <strong>4 residual</strong> (2 todo, 2 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T09:07:44.357Z |
| Now | AUTO route-self implementation active. P-001 is DONE as WI-38401: canonical DRAIN filing exception landed across generated policy, live registry, base persona, with 137/137 focused tests and explicit final-render verification green. P-002 is claimed as WI-38403. No locks or processes held; unrelated dirty files preserved. |
| Next | Read WI-38403 plus D-001, trace the existing capture/work-item admission and dedupCoverage writers, then implement stable identity, persisted semantic coverage, and fail-closed DRAIN admission through the smallest existing chokepoint. |
| Live presence | None in final 10-minute window |

#### P-005 — `blocked` — urgent

Preserve evidence while terminaling confirmed logical duplicates with structured links; audit references and repair physical twins through a dedicated migration.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Repair the ledger |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — urgent

Run focused and affected/full verification plus a bounded canary drain; accept only with persisted uniqueness evidence, no storage twins, and net-negative bug flow.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Prove behavior |
| `blocked-by` | `P-001`, `P-002`, `P-003`, `P-004`, `P-005` |
| Unresolved blockers | `P-003`, `P-004`, `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — urgent

Add severity-aware queue economics, net-flow monitoring, and a circuit breaker when a drain admits work faster than it terminales work.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Stop amplification |
| `blocked-by` | `P-002` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — urgent

Create a pre-destructive snapshot and dry-run manifest classifying exact duplicates, same-root findings, distinct lookalikes, and physical twin rows without mutating data.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Repair the ledger |
| `blocked-by` | `P-002` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/wi-38376-announce-high-water-2026-08-13</code> — WI-38376 — signed announce high-water liveness repair — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T07:03:27.081Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-003 — `todo` — high

Build the sidecar, run focused/type checks, then rerun the unfiltered 18-scenario 3-frame matrix and resolve WI-38376 from authoritative scenario evidence.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Implementation |
| `blocked-by` | `P-001`, `P-002` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/drain-control-plane-resilience-2026-08-13</code> — Drain Control Plane Resilience — Verified Recovery and Canonical Work — <strong>10 residual</strong> (4 todo, 1 wip, 5 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T06:46:43.412Z |
| Now | APPROVED AND IN EXECUTION. Avi approved start-to-finish implementation on 2026-08-13 and required acceptance grading to launch a fresh dedicated headless non-implementer rather than distract an existing peer. The requirements/design spec triad is complete; P-010 and D-006 encode the grader workflow. WI-38399 is being closed, then Phase 1 begins in dependency order. No implementation claim should skip the lossless-foundations ordering. |
| Next | Close WI-38399 with plan revision 20 evidence; convert and claim P-001; inspect the universal result-door writer and existing overflow-family work before editing. |
| Live presence | None in final 10-minute window |

#### P-001 — `wip` — urgent

Make the universal MCP result door structurally bounded before serialization: direct tools and nested tools:invoke must return valid JSON, apply projection before the transport cap, and provide stable resumable cursors for spilled detail. Extend EI-20244970883634313 and close/reconcile the scorecards, plans, sessions, fleet, and work-item overflow family with contract tests.  — note: → WI-38402

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — Lossless foundations |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — high

Add a queue-admission entropy circuit breaker over canonical clusters and emitters. Detect sudden low-diversity filing bursts, coalesce occurrences without losing evidence, bound scheduler load, and always pass through novel critical findings. Include replay tests using the 2026-08-12 cohort shape and report both raw occurrences and canonical stock.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Canonical queue and escape paths |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — high

Extend fleet:leader-brief into a cross-epoch campaign recorder/cockpit backed only by authoritative writers: membership transitions, speaking/tool-call liveness, claim stock/flow, terminal attribution, canonical occurrence counts, gate/carry/job events, and explicit corrections/retractions. Reuse EI-6803, EI-20191482908659901, WI-7130, and the current leader-brief delta model.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Cross-epoch leader cockpit |
| `blocked-by` | `P-002`, `P-003`, `P-004`, `P-006` |
| Unresolved blockers | `P-002`, `P-003`, `P-004`, `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — urgent

Run one adversarial integration campaign that forces the observed classes: partial 50-member launch, canary failure, carry during a long integration job, duplicate filing storm, claim-spec-excluded critical dependency, oversized direct and nested tool reads, and leader compaction. Verify no silent work loss, false readiness, invalid JSON, duplicate restart, or raw/canonical metric confusion.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Adversarial verification |
| `blocked-by` | `P-001`, `P-002`, `P-003`, `P-004`, `P-005`, `P-006`, `P-007`, `P-010` |
| Unresolved blockers | `P-001`, `P-002`, `P-003`, `P-004`, `P-005`, `P-006`, `P-007`, `P-010` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

After implementation, author the required acceptance rubric from the finished behavior, obtain a non-implementer scorecard with concrete evidence, run a bounded live canary drain, and publish before/after measurements for recovery time, stranded blockers, duplicate admission ratio, result-overflow failures, and leader reconstruction cost.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Adversarial verification |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `blocked` — urgent

Implement a dedicated acceptance-grader launch path in the plan completion system. When an implementing agent reaches acceptance-rubric grading, it must launch a fresh headless non-implementer agent through the existing managed agent-launch/task-ledger seam instead of recruiting an active peer. Pass the frozen plan revision, rubric, decisions, implementation evidence, and exact rerun commands; enforce a distinct grader identity and read-only implementation scope; emit the scorecard through scorecards:emit; expose launch/liveness/failure state; make retries idempotent; and terminate the grader after its verdict. The plan must remain unshippable until this dedicated grader succeeds.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Cross-epoch leader cockpit |
| `blocked-by` | `P-001`, `P-002`, `P-003` |
| Unresolved blockers | `P-001`, `P-002`, `P-003` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — urgent

Add carry-safe attachment for managed long-running jobs. Persist a stable task/run identity in the existing task ledger, expose status/tail/terminal markers through that identity, and let a compaction successor reattach without relying on process-local unified-exec handles. Build on EI-20313008550768243 and prove no duplicate restart after carry.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Lossless foundations |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — urgent

Turn fleet launch and recovery into one verified transaction: preflight capacity, launch one canary, require CLI boot + first successful tool invocation, roll out bounded waves, and surface partial-failure recovery/rollback state. Extend fleet:launch-on-plan, EI-20191406339204204, and EI-8995; heartbeat/join alone must never count as readiness.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Lossless foundations |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

Represent repeated findings as canonical issue clusters plus append-only occurrences/evidence. Centralize dedup across improvements:capture and work_items:create, preserve provenance and recurrence counts, and expose canonical-versus-raw counts in reads. Extend EI-19374777429175961 and the existing duplicates links rather than creating another issue store.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Canonical queue and escape paths |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — high

Add a typed dependency escape lane for critical blockers excluded by a fleet claim spec. The scheduler/leader brief must identify the excluded dependency, name the concrete safe remedy (spec widen, outside-lane placement, or direct leader claim), preserve ownership, and prevent silent DAG deadlock. Start from EI-20313352047106971 and existing scheduler claim-spec surfaces.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Canonical queue and escape paths |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/hlc-contention-free-clock-2026-08-12</code> — Remove transaction-wide HLC clock contention while preserving federation order — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T06:10:44.428Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — urgent

Implement a non-transactional packed-sequence HLC allocator that preserves fixed-width total ordering, recv-advance, drift clamp, persistent node identity, and restart monotonicity; add an integration regression proving an open caller transaction no longer blocks concurrent hlc_now/hlc_recv; run migration guards plus focused and required integration tests.  — note: ← WI-38318 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Implementation and verification |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/quiet-integration-red-repair-2026-08-13</code> — Repair quiet-box integration reds blocking HLC acceptance and the green gate — <strong>8 residual</strong> (5 todo, 3 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T05:57:43.525Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-006 — `blocked` — urgent

Run focused tests for every repaired lane and then the exact six-file operator integration reproduction under PC_HEAVY_COALESCE=0.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Verify |
| `blocked-by` | `P-001`, `P-002`, `P-003`, `P-004`, `P-005` |
| Unresolved blockers | `P-001`, `P-002`, `P-003`, `P-004`, `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — urgent

Run the required full integration suite to an authoritative terminal marker and classify any remaining red from writer evidence.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Verify |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — urgent

Complete the green-checkpoint/deploy/live scheduler:get_next structured-response proof sequence, wake fleet-blocked members, and close WI-38318/WI-38304 plus the held-open scheduler issue with evidence.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Ship |
| `blocked-by` | `P-007` |
| Unresolved blockers | `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — urgent

Fix saved-prompts row mapping/schema drift that returns undefined completed_at and crashes asIsoOrNull.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Repair |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — urgent

Fix feature-lifecycle integration fixture/schema drift so harness_shared.work_items exists and lifecycle updates exercise the current writer.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Repair |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — urgent

Fix blueprint-run integration drift: store-identity isolation plus retired-blueprint warning expectations without weakening the production guard.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Repair |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — urgent

Fix DBOS crash-replay expectation or implementation so terminal pipeline state reflects the current DONE contract.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Repair |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — urgent

Diagnose and durably fix the psu recycle mid-turn carry loss; preserve clean-boundary semantics and add/retain recurrence coverage.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Repair |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/context-injection-retrieval-reach-and-visibility-2026-08-03</code> — Dynamic context injection: close the retrieval-reach gap (work-items are lexical-only), make the legs report what actually ran, and surface pushed context in the HUD — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-12T19:34:48.896Z |
| Now | **ONLY P-019 REMAINS NON-TERMINAL — and it is OWNER-GATED, not unowned work.**  **P-019 — predictor delivered, ruled (D-095), RE-TARGETED in code (D-098, 2026-08-12), and now fully VERIFIED.** `clarityWarrantsEscalation()` fires on `unretrievable` ALONE. D-095 §4 measured `unfocused` — the bucket that used to escalate — as the BEST-reaching of any (5.82/6 admitted, 92.4% full, **0.0% zero-hit**), while the bucket that actually fails is `unretrievable` (21.7% zero-hit, 0.93 admitted). The old predicate armed the expensive tier exactly where retrieval already works. Measured effect: escalation **29.4% → 9.6%** of traffic. Three tests block re-adding `unfocused`; the probe sums THROUGH the predicate instead of keeping its own copy of the rule.  ✅ **The prior ## Now's "ONE OPEN VERIFICATION" is CLOSED — do not re-run it.** `npm run lint:tsc -- --files=…/memory/corpus-query-clarity.ts,…/memory/bench/corpus-query-clarity-cli.ts` returned `exit=0 status=clean` at 2026-08-12T19:08Z. It had been starved at 0.10 cores under box load 220 (not wedged) — the root cause of that starvation is itself fixed now (EI-19480850505352533 + WI-38277: every typecheck entry point routes through the pc-heavy semaphore). Tests 21/21 green; bench CLI clean end-to-end printing 9.6%. No verification debt remains on this plan.  **P-021 — CLOSED, recorded-not-adopted (WI-38251).** Learned sparse retrieval (SPLADE family) stays rejected for this stack under D-061: no paper in that sample deploys on Postgres/pgvector. Its revisit condition ("only if P-017+P-018 underdeliver against the bench") is unmet — P-018 terminal, P-017 shipped (D-097).  `CORPUS_CLARITY_FOCUSED_BITS = 5` stays UNCALIBRATED **and now governs NO SPEND** — with `unfocused` no longer escalating it only re-labels two buckets that both retrieve well. D-095 §5: no knee in the decile curve; do NOT pick a percentile. |
| Next | P-019's only remaining work is the ESCALATION TIER, which is the PARENT plan's P-006 OWNER GATE (`context-injection-audit-2026-07-28`) — not claimable here, and not to be self-answered. Whoever builds it: start from D-095 §4 + D-098, target `unretrievable` (~9.6% of traffic), and decide EXPLICITLY about the high-SCS deciles 7–10 (zero-hit 12–14%) that D-098 deliberately leaves uncovered rather than inheriting silence about them. Do not wire an LLM leg. |
| Live presence | None in final 10-minute window |

#### P-019 — `todo` — normal

CHEAPEST-FIRST CASCADE rather than an always-on rewriter — the design that answers D-046's latency/cost objection instead of refusing it. The Coverage Illusion (2026-05-26) measured that synthetic query distributions imply >90% of queries need LLM augmentation while REAL traffic needs 27.8%; their cascade cut latency 31.8% and avoided the LLM on 72.2% of traffic. Shape for us: statistical path always; escalate only when a query-performance predictor (clarity score — Cronen-Townsend et al. 2002) says the result distribution is unfocused. ⚠ The SAME predictor is the degradation signal P-003 needs, so build it once and use it twice.  — note: ← WI-37504 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase C — ranking mechanics borrowed from the search audit |
| `blocked-by` | `P-018` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-046` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/goal-mode-rubric-v2-2026-08-10</code> — goal-mode-e2e rubric v2 — realign it to the rewritten GOAL contract, and make its trend honest — <strong>1 residual</strong> (1 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-12T16:38:46.312Z |
| Now | AUTO on [owner:Avi 2026-08-12: "put yourself on auto mode and continue where you left off"].  ✅ PHASE 3 IS DONE. BOTH runs graded by two DIFFERENT non-authors: - run #3 EI-20203104876436965 (su-850348fc) — 3 exemplary / 11 pass / 4 partial / 1 fail / 1 unknown + 5 notExercised - run #4 EI-20207296832797611 (su-38b44e43) — 7 exemplary / 10 pass / 4 partial / 1 fail / 3 unknown P-012 done, P-014 CLOSED (D-025): releaseGating stays FALSE. D-022 APPLIED via rubrics:amend — the stale 'rate the goal_id leg unknown' instruction is deleted and replaced with goal-scoped-denominator guidance (verified: stale text absent, new text at offset 1432).  ⚠⚠ THE HEADLINE IS A DEFECT IN MY LAUNCH PATH, NOT IN EITHER SUBJECT. Both runs fail/partial mode-and-subject-integrity because NO agent_modes goal row was ever written. Run #4's grader measured it with NO workspace predicate — the strongest of the three measurements, ruling out a filter hiding the row. My D-017 claimed the opposite and is RETRACTED (D-021); I had read a goal slug out of those rows' REASON text ('implied by goal — owns goal <slug>') and recorded it as a subject binding while subject stayed NULL. D-016's diagnosis STANDS and is BROADER: the launch route never bound #3/#4 either.  SO THE MISSING EVIDENCE CLASS IS A PROPERLY GOAL-MODE-BOUND RUN. Neither sample is one, and grading MORE unbound samples cannot produce it. goals:start is the only atomic door (goals:create can never bind — it is an UPDATE ... WHERE mode='goal').  OPEN: P-011 only — blocked on the deploy edge. deployedSha 7511ab5b unchanged; checkpoint run 27abaa83 started 01:04Z and DOES carry the change. Gate reds are stale-candidate artifacts per the release-fixer's 00:49Z verdict, holder su-e9d45c2c live on WI-38026 — NOT mine, nextAction:null.  FILED, NOT MINE: EI-20205963184983095 — both ACTIVE releaseGating rubrics ~78-81h stale against a 6h threshold, watchdog fired 191x in 30d into a channel nobody actions. |
| Next | P-011 is the only open item: apply rubrics:set-history-reset { rubricRef:'goal-mode-e2e', at:'2026-08-10T23:34:31.149Z' } the moment a green carrying the change reaches :3070 (state:subscribe armed on deploy.3070.sha != 7511ab5b). NEVER a hand-written template_data UPDATE, and never fire release:checkpoint-run while a run is in flight. Separately, the launch-path defect (D-016/D-021) is what now blocks any properly goal-mode-BOUND evidence — that is the next real piece of work on this subject and it is NOT part of this plan. |
| Live presence | None in final 10-minute window |

#### P-011 — `wip` — normal

Annotate or supersede the five v1 scorecards (`EI-19963765382966475`, `EI-19966475532793087`, `EI-19985084976641356`, `EI-19985498786394569`, `EI-19985879345894042`) so v2 trends do not silently blend pre-rewrite gradings of a deleted contract with post-rewrite ones.  — note: P-011(b): testing D-003's premise against durable sources — the scratch criteria-delta.json is GONE.

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 2 — Make the trend honest |
| `blocked-by` | `P-008` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/hud-chat-owner-controls-2026-08-11</code> — HUD chat owner controls — token limit, account pin, and model+effort, requested 2026-07-27 and open since — <strong>3 residual</strong> (2 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-12T04:28:06.096Z |
| Now | ALL THREE CONTROLS BUILT; TWO NOW LIVE-VERIFIED. Corrections to the previous ## Now, which was stale and actively misdirecting: (1) WI-6507 (CTX) is NOT "built but broken" — the missing `compactionLimit` line WAS added and live-verified (SessionChatModal.tsx:1443; discriminating pair 158k/400k both render; over-cap refusal driven end-to-end). Its ONLY owed leg is the live WRITE-SUCCESS branch. su-3571d35d independently drove it at 01:13Z under a different plan (WI-38015) and filed the read-back gap as EI-20207719407463922, since closed by that same line. (2) WI-6510 (MODEL) is done + live-driven; it reads 'open' ONLY because the terminal transition is refused fleet-wide (operator older than migration 797's deployed half). Its evidence has been moved off this ## Now and onto the item. (3) WI-6509 (ACCT) had its FIRST live drive this turn (su-ff7c78bf, rig DISPLAY :93 pid 3291328): the gateway-free REFUSAL branch is verified — all 8 pool rows + Auto + Default render aria-disabled with the reason on the row, where pre-fix each was a clickable no-op returning ok. That drive also found a THIRD defect: the pill LABEL read "ACCT auto" for a --account=default session — the OPPOSITE routing, not merely the "genuinely ambiguous auto" this ## Now previously called it. current() hardcoded value:'auto' and put the truth only in `title`; 26 tests asserted `.title` and none asserted `.value`. Fixed (`value = launched ?? 'unpinned'`) + 2 guard cases; AccountAction 28/28, 136/136 across all 7 chat-action suites. |
| Next | su-ff7c78bf [LIVE] holds P-003/P-004 + WI-6509. Fresh rig booting on DISPLAY :94 (/tmp/ff7c7-rig94.log) because the :93 rig froze its SPA snapshot BEFORE the label fix and can never show it. Two legs remain, both live-drive: (a) re-read the ACCT label on :94 — expect "ACCT default" where :93 showed "ACCT auto"; (b) the WRITE-SUCCESS branch for BOTH ACCT and CTX. MEASURED CONSTRAINT that rules out the obvious cheap subject: AccountAction.ts:202 gates the pill on `readAccountPin(ctx) !== undefined`, and an ENDED session's roster row carries no accountPin — confirmed live against su-b5111af0 (ended, --account=auto), which rendered NO ACCT and NO MODEL pill. So the write-success subject must be a LIVE gateway-routed session: spawn a throwaway pinned to a REAL pool account (never 'default', which correctly refuses) rather than re-pinning a live peer to run a test. Assert the ROSTER read-back the pill renders — NOT a usage-row account_id join, which was non-null in only 0/110, 0/962, 3/1776 rows over three days and would FAIL a correct implementation. |
| Live presence | None in final 10-minute window |

#### P-005 — `blocked` — high

Live-drive all three in the Tauri shell and confirm each one CHANGES BEHAVIOUR, not just state: set it, send a turn, verify the turn actually used the chosen model / account / limit. A control that renders correctly and does nothing is the failure mode here, and it passes every unit test.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — the honest close |
| `blocked-by` | `P-002`, `P-003`, `P-004` |
| Unresolved blockers | `P-003`, `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

WI-6509: ACCOUNT PIN control. Three real values, not a free-text field: a specific pool account (pinned, no failover), `auto` (gateway-routed with failover), or `default` (the system credential, gateway skipped). The UI must make the failover difference legible — that is the whole reason a user would touch it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — the three controls |
| `blocked-by` | `P-001` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

WI-6507: TOKEN LIMIT control. Establish FIRST what the number actually governs (the compaction soft-limit, not a hard cap) and label it accordingly — a control labelled "token limit" that silently means something else is worse than no control.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — the three controls |
| `blocked-by` | `P-001` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/blender-steward-heartbeat-2026-08-11</code> — Blender steward heartbeat — ensure one live GOAL owner — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-12T00:13:28.061Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `PR-954-P-001` [todo] Read the goal, mode registry, live presence, and incumbent loop. If exactly one healthy GOAL holder exists, checkpoint the owner id + livene<br>`PR-955-P-001` [todo] Read the goal, mode registry, live presence, and incumbent loop. If exactly one healthy GOAL holder exists, checkpoint the owner id + livene<br>`PR-956-P-001` [todo] Read the goal, mode registry, live presence, and incumbent loop. If exactly one healthy GOAL holder exists, checkpoint the owner id + livene |

#### P-001 — `todo` — high

Read the goal, mode registry, live presence, and incumbent loop. If exactly one healthy GOAL holder exists, checkpoint the owner id + liveness evidence and finish without spawning. If none exists, launch ONE headless su (default account/model, warm carry), enter `goal` with subject `keep-the-blender-output-loop-useful-bounded-and--f5482b`, then enter `grade` with standing instructions: grade only the Blender health scorecard; the GOAL contract owns post-epoch idea grading, draft disposition, ready-plan decomposition, budget/kill enforcement, and self-paced wake cadence. If multiple fresh holders exist, retain the oldest healthy holder, stop/clear the newer duplicate holders safely, and record the disposition. Verify the surviving owner has a wake source before completing.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — recurring ensure-one run |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/acceptance-rubrics-on-every-plan-2026-08-11</code> — Acceptance rubrics on every plan (rubric kind: standard \| acceptance) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw2@gmail.com |
| Updated | 2026-08-11T23:22:25.972Z |
| Now | P-001..P-007 done (rubric kind schema + store scoping + linkage + completion gate + 4 class-rubric seeds + docs), verified: lint:tsc green, lint:tool-prompts green, flags tsc green, 164 targeted tests green. P-008 pending the full test:affected sweep now live (pid 1786938, log /tmp/papercusp-affected-tests-1786938-39ecc13d.log; push watcher armed by su-c9283). |
| Next | su-c9283: on sweep green flip P-008 done; then once dev:pipeline_position shows the schema live on :3070, rubrics:propose the acceptance rubric FOR this plan (kind acceptance, classRef plan-class-feature-ship) and get a NON-implementer to grade it; then report to Avi. |
| Live presence | None in final 10-minute window |

#### P-008 — `todo` — normal

Tests: per-kind template validation, read scoping (acceptance hidden from library/watchdog/ratification reads), lifecycle archive, completion gate, grader≠implementer refusal

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — prompts, docs, tests |
| `blocked-by` | `P-005` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/goal-mode-2026-08-07</code> — GOAL mode — goal-directed autonomy above the pot/plan/work-item stack — <strong>1 residual</strong> (1 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-10T08:37:30.892Z |
| Now | Phase 4 (the owner-facing GUI) is COMPLETE: P-014..P-022 all done. Every plan item is done EXCEPT P-001 (needs-human) and P-011 (wip, su-04c552b7 — grading a real GOAL run against rubric goal-mode-e2e, ratified ACTIVE 2026-08-09, 17 criteria).  ⚠ THE DEPLOYMENT BLOCKER IS RESOLVED — the previous Now block said the deployed operator carried NONE of goals:propose / goals:attach-project / goals:create { tripwires }. Re-measured 2026-08-10 07:15Z against the release checkout that :3070 actually runs (papercup-release): ALL are present — projects.ts defines attach-project (:44), detach-project (:109) and projects (:144); create.ts carries tripwires; propose.ts exists. The deployed goals:* surface is identical to staging. That was deploy lag, since carried by a deploy. EI-19954766347606371 is commented with the re-measurement; its surviving half is the recurrence guard (nothing resolves tool references inside MODES[].contract against the real registry), not the symptom.  SUCCESSOR PLAN: goal-mode-hardening-2026-08-10 revises what this plan shipped, from an owner design session on 2026-08-10. Where they conflict it supersedes — notably its D-001 renames the "project" vocabulary this plan's D-019/D-020/D-021 established (goal_projects -> goal_pots, goals:attach-project -> goals:attach-pot). Do not build new surfaces against the old names. |
| Next | Close the two residuals only — this plan is otherwise done. (1) P-011: finish the goal-mode-e2e grading run. (2) WI-37416: render the goals:propose confirm card from a REAL session transcript in a Tauri shell — the one P-022 link with no pixel evidence (note verify-tauri-headless shares the LIVE database, so do not click "Create goal" unless you intend a real row). Do NOT re-verify P-016..P-021, do NOT re-run P-022's gates, and do NOT re-attempt the deploy — it landed. New GOAL-mode work belongs on goal-mode-hardening-2026-08-10. |
| Live presence | None in final 10-minute window |

#### P-011 — `wip` — normal

Grading path: the goal agent stands up its success criteria on the existing rubric system (`rubrics:search` FIRST — reuse; ratify a new rubric only on a real gap) and reads `rubrics:trend` for progress. Per D-005 this is the agent's judgment, exercised once here to confirm the rails work.  — note: Unblocked 2026-08-08T21:22Z: the egress reason was wrong (see P-010). Still gated on P-010 via blocked-by, which is the correct derived dependency.

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 3 — prove it before the real goal |
| `blocked-by` | `P-010` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/coordination-spec-adoption-2026-08-03</code> — Coordination spec adoption: give every agent-facing behaviour an enforcement tier — and retire the ones that earned zero calls — <strong>5 residual</strong> (5 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-10T06:01:45.329Z |
| Now | **13 of 14 items DONE.** Phase 4 (P-010..P-014) closed 2026-08-09 by su-b7a7a — WI-37364..37368 all completed with evidence.  Phase 4 delivered: `topics:subscribe` RETIRED; `coord:dispatch` SEEDED onto the live surface (`handoff` signal group) and now emitting a ready pre-filled CALL from `coord:presence` + `plan_items:release` (the seeAlso *mention* it replaces was removed); and the retirement falsifier ARMED as a RATE.  ⚠ **P-010's scope was cut 6 verbs → 1 by D-102**, which corrects D-100. A code audit falsified 5 of its 6 proposed retirements — all from one inference error repeated six times: reading a ZERO CALL-COUNT as an ABSENT FUNCTION without checking who else held the door open. `coord:catch-up` is the sole coord:read-tier door to ~98.4% of audience-addressed messages; `watch:create` is the BASE (state:subscribe imports its handler), not a duplicate; `coord:message-agent` is a live HUMAN UI action; `coord:couple` unions into live presence.ts. Those 4 are KEPT; `coord:handoff` is DEFERRED into dispatch's re-measure. **Do not re-attempt the D-100 six-verb list.**  Verification GREEN: coordination suite 110/110 files (1374 passed), presence.integration 15/15, lint:tool-prompts 55/55 (p99=1491 < 1500), lint:tsc clean, lint:no-retired + retirement scan clean.  ONLY P-007 remains, and it is the owner's. |
| Next | **P-007 is the single open item and it needs Avi** — but D-102 has substantially pre-answered it: the audit behind P-010 showed 5 of the 7 verbs P-007 asks about are load-bearing and must NOT be retired, so the ruling left is narrower than when it was filed (`coord:dispatch` + `coord:handoff` only, and both are now under a pre-committed 30-day measurement that reports on/after 2026-09-08).  ⚠ Two tracked residuals, neither blocking: **WI-37443** — the falsifier is armed but NOT WIRED (`evaluateDispatchAdoption()` has zero callers, so nothing fires on 2026-09-08); **WI-37422** — the retired source file resurrected twice mid-work (byte-identical re-adds ~30min apart, git-sync committing each), contained by a 4-test guard but not root-caused. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-7414` [done] Ship an adoption scorecard that bakes the authoring-path denominator (D-085) into the query itself, so the EI-19300252001829260 class of error cannot recur: separate system writers, `auto:true` lifec…<br>`WI-7415` [done] Build the enforcement-tier census: every agent-facing coordination behaviour x its declared tier x its measured adoption, GENERATED from the tool registry + the scorecard rather than hand-maintained,…<br>`WI-7416` [done] Identify and close the residual ~20-25% of hand-authored agent messages that still carry no sections. The refusal is deployed (verified present in the release checkout, HEAD 13d9c65db6), so these are…<br>`WI-7417` [done] Make fleet leadership self-claiming: `fleet:leader-brief` called by a session that is not the registered leader should either auto-claim leadership or refuse with the reason. Removes the two-calls-pe…<br>`WI-7418` [done] Auto-stamp at the chokepoint every coordination field that is derivable rather than authored — the 100%-by-construction tier (the pattern `machine-authored.ts` already uses for `auto:true`, and the r…<br>`WI-7419` [done] Close the push-vs-poll gap structurally rather than by instruction: when `loop:arm` is called with a goal that names a blocker for which a completion event exists, attach the `events:await` instead o…<br>`WI-7420` [done] OWNER RULING REQUIRED: retire or tier the zero-call verb family (`coord:dispatch`, `coord:handoff`, `coord:message-agent`, `coord:catch-up`, `topics:subscribe`, `watch:create`, `coord:couple`). Zero …<br>`WI-7421` [done] Re-measure `state:read` at the D-007 epoch + 48h (i.e. on/after 2026-08-05T02:24Z) before any verdict on the state plane, per that plan's own D-004. Do not fold its current number into any adoption h…<br>`WI-7422` [done] Make the tier mandatory at the gate, not in prose: a new agent-facing coordination behaviour cannot register without naming its enforcement tier and its adoption floor, and the scorecard alarms when … |

#### P-015 — `todo` — high

Shared refusal helper: every rejection returns the CORRECTED CALL, not just the violated rule. One helper so a new verb inherits it; dev:pg_query (knownColumns) and improvements:capture (did-you-mean + key list) are the in-tree reference implementations. Measured lift: 96-100% next-try recovery vs 51% for a bare refusal. Do this BEFORE per-verb fixes — it lifts all twelve rejecting verbs at once, including undiagnosed ones.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — the rejection surface |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `todo` — high

Auto-correct-and-execute at the tool boundary for RE-ENCODING corrections only, per D-001. Structured `corrected:[{path,sent,ran,rule}]` in the result, prominent, and logged for the decay measurement. Start with coord:send couldNotDetermine/youMayNotKnow (string -> object), which is 343 refusals/wk across 69 agents.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — the rejection surface |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-001` |
| Linked work-items | None |

#### P-017 — `todo` — normal

Per-verb rejection scorecard with a threshold (~10% sustained) that files against the TOOL, not the caller. The aggregate 0.55% hid a 20-38% problem for as long as it existed and will hide the next one. This is also the recurrence guard for the two items above — without it both decay silently the next time a schema tightens.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — the rejection surface |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `todo` — normal

DROP omp:sessions from the reachable catalog (or alias it): 66 calls in 7d, 100% rejected, 10 agents, decommissioned OMP verb. Not one call could ever succeed. Approved [owner:Avi 2026-08-10].

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — the rejection surface |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-019 — `todo` — low

Decay check on the correction log: if a verb's auto-correction rate does not fall, promote the coerced shape to the DECLARED shape and retire the original (D-001 endgame).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — the rejection surface |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-001` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/memory-corpus-hygiene-and-release-distribution-2026-08-03</code> — Memory corpus hygiene + what knowledge ships in public releases — <strong>4 residual</strong> (3 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-10T00:26:18.003Z |
| Now | P-014 RE-DIAGNOSED (D-025). The stale-build 404 that blocked it since 2026-08-04 is FIXED — all five ports (3070/3170/3270/3271/3373) now serve /api/internal/substrate/head-snapshot. But sparse cuts still refuse, for a NEW and PERMANENT reason: bg-host pid 2567270 (:3271) holds the corestore WRITE lock (fd 114u on .../papercusp/hyperbee/CORESTORE) while answering booted:false for that same hive. cut-seed-cli can therefore neither open the store writable (locked, :480-485) nor find a holder to ask (:515-526) — so it refuses every time, correctly, per refuse-never-degrade. Root cause: `booted` comes from getBootedHarness(), an in-process LRU registry; holding the fd-lock is a different fact and nothing keeps the two consistent. MEASURED: a real --sparse cut to a scratch dir returned EXIT=1, "no operator process here reports having booted papercusp-workspace::papercusp (probed 3070, 3170, 3270, 3271, 3373; answered 3070, 3170, 3270, 3271, 3373)". Tracked as EI-19899917753028359 (critical, claimed).  ⚠ RETRACTED: the carried check "404 = still stale; 200 = RESTARTED, take the cut immediately" was UNSOUND. booted:false is HTTP 200 BY DESIGN so a non-holder stays distinguishable from a broken process — read the BODY, never the status code.  The shipped seed is unchanged and 18 days stale: cut 2026-07-21, coreSparseFrom 0, 461,475 blocks, 1.9GB (manifest re-measured today). D-023 sits on top of this and still stands — the default `auto` path REUSES that committed corestore, so fresh_corestore_cut stays 0 and --sparse is never even passed.  Plan sat idle 2026-08-04 → 08-08: the driving loop died on a maxFires dead-man while the session was in AUTO. Re-armed; filed EI-19899671638499010. |
| Next | Resolve EI-19899917753028359: determine WHY bg-host holds a corestore for a harness it has not booted — a leaked/orphaned handle (evicted engine, undisposed drain handle) vs by-design drain ownership. If orphaned, freeing it lets the cut open the store writable itself with NO outage, since nothing is legitimately serving it. Only then re-run the sparse probe (`npx tsx lib/release/cut-seed-cli.ts --out /tmp/p014-sparse-probe --no-git --workspace-id papercusp-workspace --hive papercusp --sparse --json` from apps/operator; read EXIT= from the log, not the notification) and measure coreSparseFrom > 0 before touching D-023's reuse gate. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-8475` [done] Measure the corpus: classify all 32,824 by scope × shape (fragment <60 / fact 60–300 / longform 300+) × transferability tier, and publish the counts as the durable baseline. Run via `code:run` or dir…<br>`WI-8476` [done] Root-cause the fragments BEFORE deleting anything: determine whether any LIVE write path still produces sub-60-char extraction debris, or whether it is all mem0-era residue frozen by the `hybrid-pg` …<br>`WI-8477` [dropped] Reversible purge of the confirmed debris class — `state` transition (archived/forgotten), never a hard delete — plus a recurrence guard that fails when the fragment share of new writes crosses a floo…<br>`WI-8478` [done] De-duplicate and reconcile contradictions across our own pool, reusing the `knowledge_packs:sweep` conflict judge rather than authoring a second one.<br>`WI-8479` [done] Backfill `kind` + `scope` on surviving legacy rows (28,811 carry neither). The taxonomy is the input to every selection step downstream, so this gates Phase 2.<br>`WI-8480` [done] Ship `fleet-lessons`. It materializes to `<workspaces>/shared/knowledge-packs/fleet-lessons` — outside the repo, outside the bundle — so the ONE pack our automated curation loop actually feeds never …<br>`WI-8481` [done] Measure promotion throughput: well-formed organic learnings → staged candidates → adopted pack items. 108 curated items against ~2,809 well-formed suggests the recurrence-escalation loop may be under…<br>`WI-8482` [open] Promotion pass over the cleaned corpus: lift tier-1 product knowledge into `papercusp-default`/`coding`, and tag tier-2 dev-infrastructure items with a contributor `domains` value instead of excludin…<br>`WI-8483` [done] Pack-admission gate: length/kind floor + box-identity scan + dangling-ledger-id check, so no pack item can carry tier-3 residue. Reuse `audit-release-bundle.py`'s identity-literal rule as the single …<br>`WI-8484` [open] OWNER DECISION: seed-corestore policy. 44k engineer issues, 3k coord messages and every plan ship with no pack review, no `applies_to` and no approval gate, while memories must pass three. Options: (…<br>`WI-8485` [done] Close the `seed.dump` hole: `build-desktop-sidecar.sh:2732` pg_dumps an ENTIRE database into the bundle when `PAPERCUSP_SEED_PG_URL` is set — no shareable filter, no personal-memory exclusion — and o…<br>`WI-8486` [done] Teach the release gate to inspect archives. `audit-release-bundle.py --scan-dir` uses `grep -rIlE`, and `-I` skips binary files, so `seed.dump`, `db-seed.tar.gz` and the corestore are invisible to th…<br>`WI-8487` [done] DIAGNOSE the degraded sparse cut (D-009): the shipped manifest carries `coreSparseFrom: 0` on a 461,475-block / 1.9 GB core, meaning a sparse cut was requested and fell back to full history. Determin…<br>`WI-8488` [blocked] FIX the cut so releases ship CURRENT STATE, not history: append a fresh head snapshot (produceLogSnapshot) after the pre-cut drain, force a non-reuse sparse cut, and verify the manifest lands `coreSp…<br>`WI-8489` [done] Add a release-cut guard that FAILS when the seed manifest reports `coreSparseFrom: 0` (or a core length above a size floor) without an explicit acknowledgement env — the current failure is silent, de…<br>`WI-8490` [done] COORD RETENTION (D-010, the mechanism that actually cuts coord from the seed): add a retention sweep that issues `del` ops for federated coord_event_log rows past a horizon, so they tombstone and the…<br>`WI-8491` [done] Verify the retention sweep does not break a cold joiner: a peer restoring from a trimmed seed must still reconstitute correct CURRENT coordination state (open claims, live handoffs, unacked escalatio…<br>`WI-8492` [open] INVESTIGATE per-recipient coord routing (D-011): today an A-to-B message replicates to every peer that admits our log and is filtered by envelope `to[]` at READ time — cost grows as peers x messages … |

#### P-014 — `blocked` — high

FIX the cut so releases ship CURRENT STATE, not history: append a fresh head snapshot (produceLogSnapshot) after the pre-cut drain, force a non-reuse sparse cut, and verify the manifest lands `coreSparseFrom > 0` with the size dropping toward the ~40 MB the tooling advertises. Then verify a restore-from-sparse still reconstitutes full current state on a cold install (the snapshot-aware reader SUBSTRATE_LOG_SNAPSHOT is REQUIRED for a sparse seed — confirm it is on in the shipped build before cutting sparse).  — note: BLOCKED on WI-36770 (bg-host self-recycles ~every 8.5min, starving the outbox drain). D-025's blocker IS cleared and D-026 settles the ruling — this is a NEW, third blocker, measured 2026-08-08.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — The ungated channels |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — normal

Promotion pass over the cleaned corpus: lift tier-1 product knowledge into `papercusp-default`/`coding`, and tag tier-2 dev-infrastructure items with a contributor `domains` value instead of excluding them (per D-003).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Distribution selection (extend the pack system, do not replace it) |
| `blocked-by` | `P-005`, `P-007` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-010 — `todo` — high

OWNER DECISION: seed-corestore policy. 44k engineer issues, 3k coord messages and every plan ship with no pack review, no `applies_to` and no approval gate, while memories must pass three. Options: (a) accept as a deliberately contributor-oriented seed, (b) filter at cut time, (c) split a contributor seed from a product seed.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — The ungated channels |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `todo` — normal

INVESTIGATE per-recipient coord routing (D-011): today an A-to-B message replicates to every peer that admits our log and is filtered by envelope `to[]` at READ time — cost grows as peers x messages with no bound. Scope the two candidate directions (direct-addressed DM transport with only pot-wide events on the shared log; or recipient-scoped sub-logs) and report a recommendation with a cost model. Investigation only — do not build from this item.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — The ungated channels |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-011` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/psu-seed-prompt-mandate-alignment-2026-08-09</code> — Align the psu tool seed with the prompt mandates (and stop it drifting again) — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-09T19:56:15.963Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-005 — `blocked` — normal

Re-measure after the admissions and close the loop on the already-filed EIs. Re-run the fallback-reach query over the 14d following the change: a successful admission drives that tool tools:invoke reaches toward zero, while a row that stays high means the tool is being reached for under a DIFFERENT name (a discovery/naming problem, not a seeding one) and needs its own diagnosis. Then close EI-19500729376783421 and EI-19321552629556165 with the measurement rather than leaving two open items describing a fixed condition.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Seed alignment |
| `blocked-by` | `P-002`, `P-003` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/no-http-anywhere-2026-07-28</code> — Make the app fast — cut the work, never queue the user, and take every platform off HTTP — <strong>3 residual</strong> (1 todo, 2 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-08T20:33:25.088Z |
| Now | **ALL FOUR TRANSPORT DOORS CLOSED** — P-009→P-013 done (fetch + EventSource ROUTED over IPC; XHR D-040 + WebSocket D-042 GUARDED). **P-015/P-016/P-017 DONE** on REAL HARDWARE (D-054).  ✅ **Settled — do NOT reopen:** **P-004/5/6 DROPPED, REFUTED (D-083)** · P-018 dropped (D-069) · P-022 BUILT (D-062/D-063) · P-023 dropped (D-064) · P-021 done (D-066) · P-031 SPLIT (D-068, flip still hardware-blocked) · DATA 0x07 deleted (D-055) · WI-7546 PTY refuted (D-059) · P-030 leg 2 refuted (D-060) · P-029 (D-057) · capped-gate ~0.5–1.0 s (D-058) · D-056 · D-053 · P-014 dropped (D-051).  ⚠️ **WSL2 IS NOT ON HTTP (D-065)** — same IPC frames over loopback TCP (`IpcStream::Tcp`, WI-3395), so `assertIpcCarriesFetch()` SUCCEEDS. D-005's HTTP exception is the socket-**RESOLUTION** path (D-008).  ⚠ **TWENTY-ONE items have inverted on contact.** Discriminators: **grep CALLERS not definitions** · **read the guard that already ships** · never trust a platform claim in a docstring · an absence claim is only as strong as the SCOPE searched · GOAL vs MECHANISM (D-062) · "assert X never happens"→is X the SAFE state? (D-064) · TRUE constraint + WRONG remedy (D-065) · "make X explicit" is likely DONE (D-066) · a cited line list is a SAMPLE (D-068) · a HISTORY warrant→search sibling plans' DECISIONS (D-069) · **mount-time is set by the nearest conditional-mounting ANCESTOR (Radix Dialog/Suspense/route), NEVER by JSX position — prove a hook runs by EXECUTING it (D-084)** · **every payload FIGURE here is stale as a TARGET — re-measure before optimising (D-085)**.  ⚠⚠ **A CITATION IN THIS BLOCK IS NOT EVIDENCE (D-083).** This block asserted "P-004/5/6 off-limits; D-029 + D-027 stand" for days. Conclusion right, citation wrong — D-027/D-029 are *P-008* rulings that never mention those items; the real authority was D-012. **Read the decision before repeating what this block says about it.** |
| Next | **RE-DERIVE before taking anything — verify against `plans:items` + the Decisions list; do not trust this sentence.** It has gone stale inside 7 minutes before, and carried a wrong citation for days (D-083).  **Phases 5, 6, 7 resolved. Phase 1 is now CLOSED too:** P-004/5/6 dropped as refuted by D-012 (D-083) — the gate measured `0 in flight of 24 · 0 queued`, so admission bypass, preemption and queue-capping each measure ZERO.  **Only P-007 and P-008 are open.** - **P-007** (parallelism ceiling) — **HELD LIVE by su-37bf2c28** (WI-6616, PgL2Store wiring; D-082 = GO). Do not take it. Re-read D-006 (retargeted) + D-077→D-082 first. - **P-008** (cut queries-per-screen) — held by su-01f8cbc4 (WI-6617). ⚠ **BOTH decision-named axes are EXHAUSTED:** the `plans.list` subscriber axis (D-084 — every subscriber route-scoped or gated) and windowing on it (D-081); plus D-012's `operatorTurns.page`/`operatorTurns.byConversation` duplicate pair, **already fixed** by P-025 + EI-19372323793235963 (D-085). **No existing decision names a live P-008 target.**  **⇒ P-008's remaining work is a FRESH LIVE MEASUREMENT, not archaeology.** Boot a desktop, take a settle-based `window.__sync_metrics__.snapshot().byQuery` reading (CUMULATIVE per-name `requests`; **never `.queries()`** — a 400-event ring) on one route, then pick the above/below-the-fold split from that. ⚠ `JSON.stringify(q.state.data).length` **undercounts resource-backed queries** (`useSyncResource`, e.g. `usePlanList`, keeps rows in a resource store) — a rig read `plans.list` as 5 KB against the audit's 701,767 B.  **Blocked / off-limits:** P-020 blocked; P-031's flip blocked on macOS+Windows hardware.  **Open EIs from this plan:** EI-19444933126726073 (`createRestBatchHandler` dead code, mounted nowhere) · EI-19443655812346761 (three `endpoint_ipc.rs` classifiers disagree on case/host:port, no test) · EI-19443132149671671 (30 s `IPC_ASSERT_TIMEOUT_MS` expires unsurfaced → permanent capped HTTP) · EI-19441620606574889 (`apps/tui/src/framing.rs` parity claim with NO golden vector) · EI-19425361953094049 (`install_load_failure_recovery` Linux-only). |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-6610` [done] **Find the 40x.** Same query set, same machine, same warm state: against `:3070`<br>`WI-6611` [done] **Count and attribute the hydration wave.** Enumerate the ~106 first-paint<br>`WI-6612` [done] **Observability for both failure modes.** (a) Assert webview HTTP egress == 0 in<br>`WI-6613` [dropped] **Interactive lane that background work can never occupy.** User-initiated reads<br>`WI-6614` [dropped] **Background requests are preemptible.** An in-flight background poll is aborted<br>`WI-6615` [dropped] **Shed superseded polls.** A background poll that a newer tick has already<br>`WI-6616` [open] **Fix the root cause P-001 finds.** Blocked on the measurement, deliberately<br>`WI-6617` [done] **Cut queries-per-screen.** Coarser reads for above-the-fold data, defer<br>`WI-6618` [done] **`fetch(new Request(...))` falls through to native.** `desktop-bootstrap.ts:118`<br>`WI-6619` [done] **XMLHttpRequest is unpatched.** Patch it, or prove nothing reaches `/api` via<br>`WI-6620` [done] **Polyfill installs too late.** 7 `/api/desktop/*` calls go native at 481-606 ms<br>`WI-6621` [done] **Add a client->server data frame.** Today client->server is only `Request` and<br>`WI-6622` [done] **WebSocket shim over IPC**, once P-012 lands.<br>`WI-6623` [dropped] **PTY (terminals) and voice onto the shim.** These are the long-lived<br>`WI-6624` [done] **Diagnose the macOS/Windows blank webview under `papercusp://`.** Found live<br>`WI-6625` [done] **Serve assets from Rust directly.** The handler currently relays via<br>`WI-6626` [done] **Verify on real macOS and Windows hardware**, not by reasoning from a Linux CI<br>`WI-6627` [dropped] **Revive `rest-query-batch` with incremental results.** Stream each result as it<br>`WI-6628` [done] **Select the strategy from an ASSERTED transport capability**, not from a<br>`WI-6629` [blocked] **Remove the `isIpcNotWired` inference.** It contradicts the stated design<br>`WI-6630` [done] **WSL2 becomes an explicit platform capability.** It is the ONE legitimate<br>`WI-6631` [done] **Lint: no native `fetch` / `EventSource` / `WebSocket` / `XMLHttpRequest` in app<br>`WI-6632` [dropped] **Assert `CONNECTION_CAPPED_MAX_IN_FLIGHT` is dead outside WSL2.** It exists |

#### P-020 — `blocked` — normal

**Remove the `isIpcNotWired` inference.** It contradicts the stated design — note: ← WI-6629 blocked ("requireIpc, defaulting ON, killing both fallback paths", 2026-07-28 01:10) and it is inferred from an error string rather than declared.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 7 — Delete the escape hatches |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-031 — `blocked` — normal

**Flip `scheme_default` ON for macOS + Windows, and correct the stale rationale strings.** P-017 verified on REAL HARDWARE (2026-08-03, two Decisions) that both platforms already run the custom-protocol path: macOS/WKWebView mounts and fully renders under `papercusp://localhost`; Windows/WebView2 under `http://papercusp.localhost`. So the defaults at `custom_protocol.rs:88` and the "renders blank" rationales at `:115` (macOS), `:697`, `:701` (Windows) and `:751` are stale. **NOT a rubber-stamp** — P-017 covered ONE OS version per platform (Darwin 23.6.0, Win11 22H2) in GPU-less VMs and did NOT re-run the packaged E2E battery under the override; do that first. Fold in **EI-19425361953094049** (`install_load_failure_recovery` is Linux-only) before flipping: without cross-platform initial-load recovery, any operator boot-race becomes a permanent blank window AND is indistinguishable from a scheme failure — which is precisely the confounder that made the original 2026-07-01 observation wrong. — note: SPLIT per D-068. DONE: the refuted 'renders blank' rationales are corrected in custom_protocol.rs -- 7 sites, comments + assert! messages only, ZERO behaviour change (scheme_default body byte-identical, all assert conditions unchanged, rustfmt hunk count identical to HEAD). P-031's own line list was INCOMPLETE: L53/L62 (the top-of-file enabled() rationale, the most-read statement) and L767 also carried the claim. Also fixed an out-of-scope stale claim at L122 ('endpoint-IPC is unavailable on Windows') -- refuted by WI-3395/D-065. BLOCKED on: (1) EI-19425361953094049 -- install_load_failure_recovery is #[cfg(target_os='linux')] with NO non-Linux stub and all four call sites individually linux-gated, so macOS/Windows have no load-failure recovery; the fix is WKWebView/WebView2 FFI that cannot be compiled or tested from this Linux host. (2) The packaged E2E battery under the override on REAL macOS/Windows hardware, which I do not have. Do NOT flip until both clear.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 5 — Every platform off HTTP |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

**Fix the parallelism ceiling.** RETARGETED by D-006: 24-way concurrency buys only — note: ← WI-6616 released 1.5x (release) to 2.8x (dev/IPC) over serial. Find where the operator serialises — PG pool size, event-loop-bound work inside resolvers, a shared lock, or CPU-bound JSON serialisation of the megabyte payloads — and fix it. Target: a 63-query wave should approach the slowest single query (~245 ms), not 1278 ms. This is the single biggest lever found so far.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Cut the work (the dominant term) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-006` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/gym-real-fitness-signal-2026-07-27</code> — Gym → real fitness signal: stop A/B-ing prompts on a 4-line fake service; judge on real outcomes and put ideas through the gym [owner:Avi 2026-07-27] — <strong>9 residual</strong> (2 todo, 7 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-08T19:55:00.216Z |
| Now | P-001 PAUSED at owner request [owner:Avi 2026-08-02] in a coherent state — typecheck clean, 50/50 gym tests green, nothing half-edited in the tree.  **The corpus is REAL and MEASURED.** All 17 admitted candidates re-measured with zero unmeasured rows; `corpus/papercusp-real-corpus.json` now holds 17 descriptors (32.9KB, was 95KB) with **max spec 1,712 chars — down from 19,536**, pools 6/6/5, 0 D-007 violations. Regenerate via `npx tsx scratchpad/gym-build-corpus.ts`.  **A prior finding was RETRACTED.** The "capability:bash vs interactive execution context differs" blocker was wrong — the environment was sound throughout. The real cause was a measurement guard that checked whether `TEST_FILE_RESULT` was *printed* rather than what it *said*; that string also appears when zero tests execute, so "never ran" and "nothing failed" were indistinguishable and 4 real tasks were silently dropped. Filed EI-19376339983058011.  **Wiring landed** in `autoloop-cycle.ts` via a new shared helper `papercusp-corpus-tasks.ts`, plus two bugs caught while wiring: (a) `.papercusp/blueprint.yaml` is gitignored and the runner clones from the object store, so the `coding-solo` pin would never have reached it — the gym would have silently optimized the RETIRED coding-factory spine while reporting `corpus:'real'` (same class as D-007, one file deeper); now committed beneath every task commit and asserted present. (b) the substrate cloned into `/tmp`, a different device, so the `--local` hardlink clone would have failed at runtime. |
| Next | **RESUME HERE — nothing below is proven beyond typecheck + unit tests.**  1. **Run ONE full cycle end to end.** No cycle has been run; this is the single biggest open risk and the only thing that converts this from "compiles" to "works". 2. **Delete the now-dead `fixedTasks()` at autoloop-cycle.ts:90** — no callers, left deliberately rather than editing further at a pause point. Leaving the synthetic corpus in the file is exactly how it gets re-wired. 3. **Wire `ab-run.ts`.** ⚠ This plan's "sibling `fixedTasks()` at ab-run.ts:73" is WRONG — `grep fixedTasks ab-run.ts` returns nothing. It does write the same `.papercusp/config.json` at ab-run.ts:131, so it carries the SAME blueprint trap fixed above. Verify what it actually uses. 4. **Disclosed, not decided:** `workingStateCheck: 'npm run typecheck'` was carried over verbatim so this change swaps the CORPUS and nothing else. Instant on the toy repo; a repo-wide tsc (~150s) per chunk on the real one. Degrades gracefully, so cost not correctness — but it likely needs per-task scoping.  Unchanged: do NOT re-arm the gym autoloop (D-004 unmet); do NOT wire `real-corpus.ts` (D-006 retired it). Engine loop DISARMED as part of the pause — re-arm on resume. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-6286` [open] Replace `fixedTasks()`'s synthetic substrate with a REAL task corpus: build `gym_tasks` rows from actual shipped Papercusp work-items that carry verifiable outcomes (a merged diff + its tests + compl…<br>`WI-6287` [blocked] Gate promotion on the real-anchor: a challenger may only be crowned champion if it does not regress the real-anchor pool. Today real-anchor is scored-but-excluded from aggregation, so a prompt can wi…<br>`WI-6288` [done] Label every gym artifact with the corpus it was judged on (`taskCorpus: 'synthetic' \| 'real'`) in `gym_scores` + on the Gym tab card, so a champion earned on toy tasks can never again read as a champ…<br>`WI-6289` [blocked] Arm `LEARNING_GYM_TARGETS`: enable the implement-worker row with an explicit budget via the gym control plane (the owner act the seed file has been waiting for), confirm the `PAPERCUSP_IMPROVEMENT_RU…<br>`WI-6290` [blocked] Wire drill ground truth as the judge: the implement-worker's fitness is planted-drill resolve rate + mean planted→resolved time + repo-test regressions, NOT an LLM composite. Assert the judge reads p…<br>`WI-6291` [blocked] Decide and record whether the coding-role prompt gym (worker/director/orchestrator) stays armed once real targets run — it currently spends budget on toy tasks. Options: retire it, re-point it at P-0…<br>`WI-6292` [open] Design the idea-fitness loop and PRESENT IT BEFORE BUILDING (design-shaped work per standing feedback): ideation output → the `cheapExperiment` already captured on each idea (hypothesis / method / fa…<br>`WI-6293` [blocked] Implement idea-fitness execution: run an idea's cheapExperiment as a real bounded job, persist {ideaId, hypothesis, signal, verdict, cost}, and route the verdict into the existing grade→revision→wake…<br>`WI-6294` [blocked] Fix intake starvation: triage routes ~0.6% of ideas to the gym and nothing in 10 days. Instrument why (classifier bias / missing route / unattractive lane), then make idea→gym the DEFAULT for anythin…<br>`WI-6295` [blocked] Close the loop back to ideation: an idea that survives its experiment becomes a ranked, evidence-carrying placement candidate; one that fails carries its falsification so the same idea is not re-prop…<br>`WI-6296` [done] Add a `fitness-signal-is-real` criterion to the release-readiness rubric: it FAILS while the active gym corpus is synthetic, reading the corpus label from P-003. A green release gate must be impossib…<br>`WI-6297` [done] Add a dark-target audit to the standing cert: any registered learning target seeded dark that has never run must be reported every wake, not silently skipped. `LEARNING_GYM_TARGETS` sat dark for week…<br>`WI-6298` [done] Write the agent-insight doc: "a green mechanism gate over a synthetic benchmark is not learning" — the trap, how it survived six scorecards, and the check that catches it. |

#### P-002 — `blocked` — high

Gate promotion on the real-anchor: a challenger may only be crowned champion if it does not regress the real-anchor pool. Today real-anchor is scored-but-excluded from aggregation, so a prompt can win while getting worse at real work.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Make the current loop honest (stop laundering toy results as learning) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — high

Arm `LEARNING_GYM_TARGETS`: enable the implement-worker row with an explicit budget via the gym control plane (the owner act the seed file has been waiting for), confirm the `PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS` prerequisite is configured, and verify one cycle judged on `drillResolveRate` / `drillMttsh` / `regressionsFromTests` end-to-end.  — note: PREMISE CORRECTED by the P-012 audit's first live run: implement-worker is not 'seeded dark', it is UNREGISTERED — there is NO gym_autoloop_config row to enable, because PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS is NOT SET and seed-learning-gym-targets.ts skips registration when that prerequisite is missing ('registration never invents a harness slug'). Correct sequence is now: (1) OWNER/config decision — which harness runs auto-implement (PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS); (2) run the seed to create the row; (3) THEN arm it with a budget. Blocked on (1): choosing the runner harness is a topology decision, not an agent call

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 2 — Arm the real-signal gym that already exists |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — high

Wire drill ground truth as the judge: the implement-worker's fitness is planted-drill resolve rate + mean planted→resolved time + repo-test regressions, NOT an LLM composite. Assert the judge reads persisted drill outcomes rather than model opinion.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Arm the real-signal gym that already exists |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — normal

Decide and record whether the coding-role prompt gym (worker/director/orchestrator) stays armed once real targets run — it currently spends budget on toy tasks. Options: retire it, re-point it at P-001's corpus, or park it dark.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Arm the real-signal gym that already exists |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — high

Implement idea-fitness execution: run an idea's cheapExperiment as a real bounded job, persist {ideaId, hypothesis, signal, verdict, cost}, and route the verdict into the existing grade→revision→wake path so a falsified idea gets revised instead of silently graded.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — The idea-fitness gym the owner actually asked for |
| `blocked-by` | `P-007` |
| Unresolved blockers | `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — high

Fix intake starvation: triage routes ~0.6% of ideas to the gym and nothing in 10 days. Instrument why (classifier bias / missing route / unattractive lane), then make idea→gym the DEFAULT for anything cheaply testable rather than an exception.  — note: FIRST HALF DONE (root cause found, see D-005): 'gym' is UNREACHABLE from triageIdea() — 5 branches, returns only place\|gate; process-prompt (the self-described "gym-A/B-able class") returns gate. Only paths in are a manual Queen override or recurrence-escalation (which also requires the signature to have RECURRED). Not classifier bias — a missing edge. SECOND HALF BLOCKED behind P-007/P-008 per D-005: routing more ideas in today feeds a benchmark P-011 correctly marks RED, yields hint-text not measurement, and would strip the human gate off the compounding class.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — The idea-fitness gym the owner actually asked for |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `blocked` — normal

Close the loop back to ideation: an idea that survives its experiment becomes a ranked, evidence-carrying placement candidate; one that fails carries its falsification so the same idea is not re-proposed.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — The idea-fitness gym the owner actually asked for |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Replace `fixedTasks()`'s synthetic substrate with a REAL task corpus: build `gym_tasks` rows from actual shipped Papercusp work-items that carry verifiable outcomes (a merged diff + its tests + completion evidence), pinned by repoUrl/repoCommit so each task is reproducible. Keep the three-pool split (train / dev-anchor / real-anchor) but populate real-anchor with genuinely-shipped features whose outcome is known — what D-014/P-028 always intended.  — note: ← WI-6286 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make the current loop honest (stop laundering toy results as learning) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-014` |
| Linked work-items | None |

#### P-007 — `todo` — high

Design the idea-fitness loop and PRESENT IT BEFORE BUILDING (design-shaped work per standing feedback): ideation output → the `cheapExperiment` already captured on each idea (hypothesis / method / falsifiableSignal) → execute that experiment in a sandbox → score worthiness → feed the score back as the revision signal that wakes the originator. Must name what "worthiness" is measured in, what a falsified idea costs, and the per-idea spend ceiling.  — note: ← WI-6292 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — The idea-fitness gym the owner actually asked for |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/app-templates-2026-07-04</code> — Templates — composable component+guidance+checks units; agent-composed apps on papercusp — <strong>3 residual</strong> (3 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-03T20:20:30.494Z |
| Now | ROUND 2 COMPLETE + FIX PASS SHIPPED (2026-07-05 ~06:3xZ). Round-1 (opus, desktop Snippets) + round-2 (sonnet:medium, WEBAPP Clippings — per owner directive the bar is a mid-tier agent) both built successfully from the PUBLIC mirror alone; round-2 finished in ~45min with the FULL checks union green incl. boot-e2e spawn-mode against the shipped standalone artifact — the P-029/P-030 disclosed residual (web-host boot-e2e vs a materialized consumer) is now PROVEN. All 13 template-gaps from both rounds are FIXED + resolved (WI-2860..2867, WI-2872..2881): supply chain (kit vendored in mirror + runnable harness + file:-link components), kit code fix (validateTemplateSet allowExternalComposesWith — chosen-subset compositions legal, WI-2881), GUIDE MUSTs (NEXT_MANUAL_SIG_HANDLE=1, native-binary post-build copy, globalThis singleton, two-discovery-files, postgres-js client, lexicon rescope + branding-lexicon prompt corrected both pinned sides). OWNER DIRECTIVE APPLIED: internal reference harnesses (quartermaster/oddsmith/Restart repo pointers) scrubbed from ALL user-facing template + kit content — reference READMEs rewritten around portable artifacts, worked config renamed worked-example.checks-config.json (genericized purchasing-ops domain), catalog/kit provenance anonymized; papercusp-webapp Cupboard listing description republished (stayed approved). Suites: kit 54/54, templates 12 pass/22 skip, tsc clean; mirror e802a48 pushed + bare-clone verified. OPEN QUESTION for owner: /internal/docs (agent-insights corpus served on installs) still names quartermaster widely — scrub is a separate larger sweep, not done. |
| Next | Decide with owner whether a round-3 builder is needed (round-2 sonnet:medium succeeded — remaining gaps were doc-polish; candidate: an agentic-desktop-app build to exercise ops-hives) or move to P-011 thin materializer / P-012 persona rule / P-027 mirror-sync automation; also verify the papercup routine auto-committed today's template/kit edits. |
| Live presence | None in final 10-minute window |

#### P-003 — `todo` — normal

Generalize the Tauri shell + packaged-sidecar component: the thin main.rs host pattern (resource_dir sidecar resolution, operator.json poll, graceful SIGTERM kill, bundled-node PATH — the WI-2669 mechanics, which must be verified first) + app-name-parameterized build-sidecar/assemble-sidecar-deps scripts. v1 form: a documented skeleton dir inside the template (crate extraction deferred — see decisions). Acceptance: quartermaster consumes the generalized scripts; skeleton documented in the component catalog.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Component extraction (extract, don't invent) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-025 — `todo` — low

FAST-FOLLOW template 'adopt-papercusp-design' (aspect, category design) — 'Papercusp Official: Papercusp Design': brand/theming adoption (lexicon packs, brand marks, theme bridge). Owner-ratified as post-public-release fast-follow.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Official template set expansion (owner directive 2026-07-04) |
| `blocked-by` | `P-015` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-026 — `todo` — low

FAST-FOLLOW template 'sidecar-service' (aspect, category shell) — 'Papercusp Official: Sidecar Service': headless Hono service (hono-host + tooldef-http) for non-desktop apps. Owner-ratified as post-public-release fast-follow.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Official template set expansion (owner directive 2026-07-04) |
| `blocked-by` | `P-015` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/db-performance-remediation-2026-07-26</code> — Papercusp Postgres performance remediation — index bloat, wide-JSONB reads, poll amplification — <strong>3 residual</strong> (3 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-03T20:01:33.522Z |
| Now | Measurement fixed, ranking re-based, statistics thesis dead, partial-index class linted, enforced repo-wide, and its zero-match sub-lane now measured and CLOSED. D-027..D-029, D-031..D-036 govern.  SHIPPED 2026-08-03 — pgss orphan reclaim (D-033, P-020, WI-9313): 3,303 orphaned entries from 23 dropped databases reclaimed, 98.7% -> 65.7%. The leak had been corrupting this plan's own instrument (evicting REAL stats at 13.5/day; an evicted+recreated entry's next delta reads as a PHANTOM SPIKE). Durable: daily DBOS sweep 05:20 UTC + migration 756.  SHIPPED 2026-08-03 — partial-index lint enforced for ALL FOUR scanned roots (WI-9434, D-034) via REPO_WIDE_INVARIANT_GUARDS; falsifiability proven by mutation-probe (verdict=caught, tree byte-identical after).  CLOSED 2026-08-03 — the zero-match partial-index sub-lane (D-035). Measured 54 zero-match of 194 partial indexes; this plan had said 28 of 202, so BOTH figures were stale. Realistic drop upside ~40 KB, while 16 of the 54 are provably load-bearing — led by arc_running_idx at 45,219,301 scans, the DB's 8th hottest index, matching ZERO rows. Economically dead AND risky; do not work it.  CORRECTED 2026-08-03 — D-036: track_planning is superuser-context, not postmaster. Lane (2) never needed a database restart, only ALTER SYSTEM + pg_reload_conf. It stays DEMOTED anyway (D-033 killed its motivating claim; track_planning taxes exactly this fleet's concurrency pattern), but the blocker on record was false.  WI-8945 CLOSED BY VALUE: 12 of ~71 partial indexes resolved (-4.2 MB, ~330k writes/tick); residue on EI-19452064467168046. WI-9137 is the one PREDICTED win left, blocked on deploy behind the gate. |
| Next | (1) EXTEND PARTIAL-INDEX ALIGNMENT PAST THE JSONB SLICE (EI-19452064467168046). harness_shared has 194 partial indexes; the lint covers only the 3 whose predicate is a jsonb key-presence test. The rest need an implication model, not a bigger regex — Postgres CAN prove some predicates (x = 5 implies x IS NOT NULL), and for others (WHERE ended_at IS NULL) the clause is NOT semantically free, so naive flagging would induce result-changing "fixes". NOTE: widening the lint's SOURCE_ROOTS now also requires mirroring the new root into PARTIAL_INDEX_SOURCE_ROOTS in scripts/affected-tests.mjs — the generated per-root test case reds if you don't (D-034 working as intended).   DO NOT start this from that item's own "suggested first step" (rank by idx_scan = 0) — D-035 measured it and it is refuted.  CLOSED 2026-08-03 — THE ZERO-MATCH SUB-LANE (D-035). This plan previously carried "the 28 zero-match population needs the D-031 category-4 split" as open work. Measured: 54, not 28 (of 194 partial indexes, not 202), worth 936 KB total; never-scanned drop candidates are 160 KB and the genuinely-vestigial residue ~40 KB. Meanwhile 16 of the 54 are provably load-bearing, led by arc_running_idx at 45,219,301 scans — the 8th most-scanned index in the entire database — matching ZERO rows. Do not work this lane. D-035 also records why idx_scan=0 is not a whole-class detector (12 of the 15 candidates sit on tables of <=66 rows, where the planner prefers a seq scan regardless) and why any single-digit idx_scan is below this instrument's noise floor.  (2) QUERY-BUILDER FRAGMENTATION — DEMOTED. Do NOT justify it by the entry cap (D-033 refutes that at 1.3%). Its remaining question is plan-cache/parse cost, which is UNMEASURED because pg_stat_statements.track_planning is off.   CORRECTED by D-036: enabling it does NOT need a database restart. track_planning is superuser-context (only pg_stat_statements.max is postmaster), so it is ALTER SYSTEM SET ... + SELECT pg_reload_conf() — a reversible 5-second change, not a fleet outage. It is still deliberately OFF: track_planning's documented penalty lands hardest when many concurrent connections update a small number of shared entries, which is exactly this fleet, and D-033 already killed the lane's motivating claim. Revive it only with a stated falsifiable decision waiting on the number, sample a BOUNDED window, then ALTER SYSTEM RESET + reload.   Also note structural variation is largely CORRECT — a query with an extra AND clause deserves its own plan, and collapsing variants via ($N IS NULL OR col = $N) is the catch-all anti-pattern that destroys index usage.  (3) WI-9137 is still WIP and is the one PREDICTED win left: implemented + verified in tree but NOT deployed, so its ~6x is unmeasured. Its fix IS inside the gate's in-flight candidate c7b002096ef1. After deploy, re-run the 25s pgss delta on the '%total_memories%' statement (expect ~0.1/s; pre-fix 0.68/s).  METHOD, per D-028: judge a perf hypothesis by whether the PLAN CHANGES and wall-clock improves, never by whether an estimate got more accurate. Confirm the SQL is still DEPLOYED before targeting it. A surprising number is not a finding until a SECOND independent source agrees. Per D-033: any aggregate over pg_stat_statements that does not partition by (userid, dbid, toplevel) is wrong by construction. Per D-034: "the guard exists and has tests" is NOT "the guard is enforced where it scans". Per D-035: a partial index matching zero rows is NOT evidence it is unused — check idx_scan first. Per D-036: verify a GUC's own context before recording it as needing a restart; sibling GUCs in the same extension differ. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-6117` [done] `REINDEX INDEX CONCURRENTLY` the 9 bloated btrees on `route_invocations`, `tool_invocations`, `test_runs`. Online, no write blocking; run one at a time off-peak. Verify bytes/row drops below 80 after…<br>`WI-6118` [done] Drop the orphan `harness_plans_search_idx_ccnew` (17 MB duplicate GIN), after confirming `harness_plans_search_idx` is valid.<br>`WI-6119` [done] Drop the two largest confirmed-dead indexes (`test_runs_branch_idx` 121 MB, `decision_ledger_ws_posture_idx` 84 MB), then review the remaining 330 unused indexes as a batch. Record each drop so it ca…<br>`WI-6120` [done] Add a recurring `REINDEX CONCURRENTLY` maintenance routine for the high-churn retention tables — **this is the durable fix**; P-001 alone is a one-off and the bloat returns. Declare it as a `tier:dur…<br>`WI-6121` [done] Set per-table freeze tuning (or a manual `VACUUM FREEZE`) on the ~5 tables at 190M+ xid age so anti-wraparound vacuums don't all fire unplanned at once.<br>`WI-6122` [done] Add column projection to `listPlans` (`packages/operator-core/lib/agent-tools/plans/source.ts` ~line 880): stop selecting `items`, `now_state`, `now_next`, `template_data` unless the caller asks. Pro…<br>`WI-6123` [done] Bound the `coord_event_log` body reads — add a `LIMIT` + id-watermark to `SELECT body ... ORDER BY id ASC` (currently unbounded, 27,743 rows/call × 350k calls = 9.7B rows).<br>`WI-6124` [done] Add projection + a default bound to the four `engineer_issues`/`work_items` wide selects that ship full `payload` JSONB for ~2000 rows/call, 2.69M times.<br>`WI-6125` [done] Audit remaining `SELECT *`-shaped reads on wide-JSONB tables for the same pattern, and add a lint/test guard so a new unbounded wide select can't land. Extend the existing `no-heavy-io-on-read-path.t…<br>`WI-6126` [done] The `tool_invocations` error-rollup runs **832k times at 297 ms** (68 CPU-hours). Each of ~49 agent processes recomputes the same fleet-wide aggregate independently. Move it behind the **existing der…<br>`WI-6127` [done] Same treatment for the `oriented` CTE (831k calls) and coord-owner rollup (719k calls).<br>`WI-6128` [done] Register the `WITH calls AS ...` analytics rollups (mean 8.9 s and 38.6 s, up to 2.87B rows/run) as derived-read producers instead of recomputing over raw `tool_invocations`.<br>`WI-6129` [done] Investigate the `COPY session_archive_files` writer at **302 s mean** × 1113 calls (9.3% of DB time) — 2.7 GB of TOAST. Likely wants chunking or off-peak scheduling.<br>`WI-6130` [done] Consider lowering `max_parallel_workers_per_gather` for the polling workload, or making the rollups non-parallel — 5 backends per poll is why 2.4M queries produced 10.4M seq scans.<br>`WI-6131` [done] Route app traffic through the already-running PgBouncer on `:6432` (transaction mode) instead of direct `:5432`. Collapses 104 pools / 307 connections to a bounded server-side pool. Needs a staged cu…<br>`WI-6132` [done] Reduce per-process pool sizing so each agent process stops opening its own admin **and** app pool. |

#### P-018 — `todo` — high

Stop every background-worker host from independently recomputing the full ~20-collector system-health tick every 30s (~22.6 concurrent tickers, measured D-012). Make the tick a single-runner produced snapshot on the D-004 derived-reads substrate and have every other host READ it — NOT an age-gated shared-snapshot check, which is a thundering herd. This is the root cause of BOTH of P-008's surviving wide reads and of ~18 other collectors' per-tick cost. Blast radius: the liveness alarm, lastSystemHealth()'s per-process cache, and refreshHealthPanel's push-on-write merge. See EI-19300220274441392.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Cut poll amplification (extend the existing precompute substrate) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-012`, `D-004` |
| Linked work-items | None |

#### P-019 — `todo` — high

unanswered-directed's remaining THREE scan sites (e2 ~354ms, e3_1 ~168ms, outer e ~122ms) still seq-scan all 75k coord_event_log rows — same jsonb-no-statistics root cause and same materialize-once fix shape as the loose_replies rewrite landed in WI-6853. Tracked as WI-6875; do NOT re-attempt the index route (trialled and rejected), and verify equivalence BEFORE performance.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Stop shipping JSONB nobody reads (the ~50% win) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-020 — `todo` — high

pg_stat_statements leaks entries for DROPPED databases (no DROP DATABASE hook): 3,303/9,791 entries = 33.7% of the cap is dead pg_dump residue across 23 dropped dbs, so the cap is 97.9% full and evicting REAL application stats at 13.5/day — an evicted+recreated entry reads as a phantom spike, corrupting the delta measurements this plan depends on. Durable fix = a recurring reclaim sweep (WI-9313) + migration 756 granting harness_admin EXECUTE on pg_stat_statements_reset. See D-033.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Keep the measurement instrument honest |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-033` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/silent-wrong-answers-2026-08-01</code> — Silent wrong answers: results that look right and are not — <strong>16 residual</strong> (11 todo, 1 wip, 3 blocked, 1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-02T22:54:22.356Z |
| Now | **24 items, 7 done and test-verified** (P-001/002/004/006/007/011/013: 265 tests across 7 files, typecheck clean on 8 touched files). **Wave 2 added 2026-08-02: P-015..P-024 + D-003.**  **READ D-001, D-002 AND D-003 BEFORE TOUCHING THE REST — the corrections are the most important output here.** - **D-001:** P-008/P-009 rest on a query that was wrong. The observation lane ALREADY excludes 11,674 items from claimable (verified twice); real claimable is 1,383 harness-wide / 152 under the drain fleet's spec, not 13,449. P-009 would have mutated ~12,564 rows to remove them from a pool they were already excluded from. Both remain BLOCKED pending re-scoping — deliberately not "done" and not "dropped". - **D-002:** the first cut of P-004 was ITSELF capable of the silent wrong answer this plan is about — a call-site pre-read to report a delta is racy; the delta must come from the mutation. - **D-003 (new, load-bearing):** do NOT build the "fleet mass-death detector". Its trigger event does not occur and its signal (`ended_at`) is coroner-written, so it would fire at every sweep and never once on a real failure. The rejected spec is quoted verbatim in the owner's 2026-08-02 brief and in several transcripts, so it WILL be proposed again.  Wave 2 came from a 3-hour misdiagnosis the same day (WI-7126, closed as a REFUTED PREMISE) that independently re-derived this plan's thesis — which is itself the argument for **P-016**: the plan now documents FOUR separate implementations of one rule (field-reliability.ts, code:run fieldMisses, complete-requires-assumptions, undeclared-arg rejection EI-10883), each wired to a single call site, while new instances keep arriving from other agents in parallel. |
| Next | Start P-015 — apply the already-shipped `packages/operator-core/lib/field-reliability.ts` caveat to `adv_sessions.ended_at` wherever it surfaces (sessions:*, fleet:*), then enumerate the observer-written column class (`exit_code` is the live suspect: NULL for all 9 ghosts and silently unable to answer "how did this end"). Then P-016 to promote the convention with a guard, and P-019 (membership delta) as the highest-value detection item — a roster that cannot report loss FABRICATES a phantom event rather than merely hiding one. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-6686` [done] Compute admittedBreakdown SERVER-SIDE in work_items:claimable + scheduler:get_next — kind x severity of the ADMITTED set, plus a filing-rate skew flag. Composition then ships WITH the count and canno…<br>`WI-6687` [done] Stop nulling severity in the work_items:claimable projection. It currently returns severity:null for rows that are severity='critical' in engineer_issues — the tool a leader is told to use for 'what …<br>`WI-6688` [open] Resolve the severity DUAL-ACCESSOR. On the engineer_issues VIEW severity is a real column; payload->'_ei'->>'severity' (correct for the work_items TABLE) yields NULL for all 13,332 rows, so a critica…<br>`WI-6689` [done] Mutations must report their DELTA. work_items:release returns ok:true on a semantic no-op with no released:false / previousAssignee. Add the delta, then AUDIT every other mutation verb for the same s…<br>`WI-6690` [open] Lint/assert the wrong severity accessor: a payload->'_ei'->>'severity' predicate against engineer_issues is ALWAYS a bug and is mechanically detectable. BLOCKED BY the dual-accessor decision in Phase…<br>`WI-6691` [done] Rename fleet:leader-brief orphaned_in_flight and emit its resolving action inline. The items are unassigned BY DEFINITION, so 'orphan' + the standing 'reclaim orphans' loop instruction both point at …<br>`WI-6692` [done] Launch-time guard: the DUAL of confirmClaimCollapse. fleet:launch-on-plan already refuses a lane matching 0 rows (starvation). Add the opposite — warn/refuse when the matched pool is large AND compos…<br>`WI-6693` [done] NEW INSTANCE (#8, found 19:35Z auditing the WI-6674 fix): documentation asserting a guarantee whose implementation is NOT LIVE. CLAUDE.md was updated to say dev:pg_query 'now emits an always-NULL-acc…<br>`WI-6694` [blocked] Keep observation-grade captures OUT of the claimable pool: route them to the observation lane at FILING time, and exclude nit-severity auto-filed items from the default claim floors. This is the ROOT…<br>`WI-6695` [blocked] One-time reclassify the existing 12,564 nit/minor change items out of claimable, and separately promote the 159 genuinely severe ones (154 major + 5 critical). BLOCKED ON AVI: bulk re-kind to bug, or…<br>`WI-6696` [open] Fix CLAUDE.md's severity guidance — it currently CAUSES the dual-accessor bug by naming the right relation and the wrong accessor in one sentence. Bind accessor to relation explicitly: work_items tab…<br>`WI-6697` [done] Add the two earned rules to the su playbook, flagged as the WEAKEST lever and no substitute for Phases 1-2: (READS) never accept null/zero/empty as a finding — cross-check a DIFFERENT accessor and de…<br>`WI-6698` [blocked] DECISION NEEDED (Avi): the p2p fence is title-WORD matching (p2p\|shared-hive\|federation\|holepunch\|swarm\|dht\|relay\|...). P2p-adjacent items whose titles dodge those words leak in — WI-5168 (cross-mach… |

#### P-016 — `wip` — high

PROMOTE THE CONVENTION — this plan already has FOUR implementations of one rule, each wired to one thing. (1) `field-reliability.ts` — one call site. (2) `code:run`'s `fieldMisses` — reading an absent field is reported, not silently `undefined`; caught two live misreads while this wave was authored, one rendering as `completion: ""` i.e. "shipped with no evidence". (3) `work_items:complete` requiring `assumptions` or literal `"none"`. (4) undeclared-arg rejection (EI-10883) — "returns ok:true while quietly doing something else... indistinguishable from success". State the rule once — A SURFACE MUST NOT RENDER AN ABSENT, UNRELIABLE OR UNANSWERED RESULT AS A REAL ONE — and give it a guard, so instance #5 is caught at review rather than filed after the fact. Same hour, three OTHER agents filed the same shape independently (EI-19375525140589446, EI-19375451000390205, WI-7140): point fixes are not keeping up with discovery.  — note: su-70702: building the D-104 design — (surface,field) registry + coverage test + shrink-only ad-hoc-spelling watermark.

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — Make the wrong answer impossible (structural) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — high

Keep observation-grade captures OUT of the claimable pool: route them to the observation lane at FILING time, and exclude nit-severity auto-filed items from the default claim floors. This is the ROOT CAUSE — the count only misleads because the pool is full of things that are not work. [WI-6675]  — note: NEEDS RE-SCOPING, not implementation — see D-001. The observation-lane exclusion this calls 'the ROOT CAUSE' is ALREADY implemented and working (11,674 items excluded, verified twice 2026-08-01).

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — Fix the pool (root cause) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

One-time reclassify the existing 12,564 nit/minor change items out of claimable, and separately promote the 159 genuinely severe ones (154 major + 5 critical). BLOCKED ON AVI: bulk re-kind to bug, or priority-promote into a kind-agnostic lane? [WI-6675] — note: DO NOT RUN THE BULK RECLASSIFY — premise disproved, see D-001. The 12,564 figure came from a query over the OPEN pool, not the CLAIMABLE pool; those rows are already excluded by observationLaneExclusionSql.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — Fix the pool (root cause) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-020 — `blocked` — high

Build the DEGENERATE-WAKE detector (WI-7129, re-keyed — see the REJECTED mass-death decision). Agents do not get killed; they degenerate into telemetry-only wake loops and quietly run down. Measured on the 8 dead members: final-30-min mix of 254 calls/205 telemetry/3 work, 226/177/6, 216/166/10, 147/116/1 — and all 8 ended on the identical `coord:glance`+`activity:report`+`flags:get` triple within one second, 7.5k-9k calls deep. Nothing catches it because a burning agent is heartbeat-fresh, present and `sessionState:"live"` right up to the moment it stops: it is spending real tokens to report that it is fine. Signal: per agent over a trailing window (~30 min, >=40 calls), telemetry_ratio > ~0.75 AND work_calls <= ~5 — fires at 0.79-0.81 on that cohort well before they stopped. Calibrate against a healthy cohort first. The root-cause fix is EI-19307414464301772; build the detector anyway, the class will recur under another mechanism.  — note: BLOCKED — signal refuted 2026-08-02 21:30Z. Telemetry ratio has ZERO discriminating power (all 46 agents 67-79%; dead cohort lifetime 76-77%, never spiked; dead agents closed 7-11 items in their final 6h). Would fire on ~30 of 46 incl. the top closer. See the detector-separation decision. Needs a NEW signal that demonstrates separation before any code.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 2 — Make the wrong answer loud (detection) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `needs-human` — normal

DECISION NEEDED (Avi): the p2p fence is title-WORD matching (p2p\|shared-hive\|federation\|holepunch\|swarm\|dht\|relay\|...). P2p-adjacent items whose titles dodge those words leak in — WI-5168 (cross-machine repoKey rendezvous), WI-6359 (joiner drops hive announce). Re-fence by tag/semantics, or accept the leak? Owner's lane definition; untouched. — note: ← WI-6698 needs-human

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 4 — Doc and prompt (weakest lever, last, not relied upon) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — urgent

Resolve the severity DUAL-ACCESSOR. On the engineer_issues VIEW severity is a real column; payload->'_ei'->>'severity' (correct for the work_items TABLE) yields NULL for all 13,332 rows, so a critical audit returns zero and reads as 'no criticals'. Pick one: expose _ei.severity in the view's payload so both paths agree, or drop the payload path. Removing the footgun beats documenting it. [WI-6674]

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make the wrong answer impossible (structural) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Lint/assert the wrong severity accessor: a payload->'_ei'->>'severity' predicate against engineer_issues is ALWAYS a bug and is mechanically detectable. BLOCKED BY the dual-accessor decision in Phase 1. [WI-6674]

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Make the wrong answer loud (detection) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — normal

Fix CLAUDE.md's severity guidance — it currently CAUSES the dual-accessor bug by naming the right relation and the wrong accessor in one sentence. Bind accessor to relation explicitly: work_items table => payload->'_ei'->>'severity'; engineer_issues view => severity column. BLOCKED BY the Phase 1 decision.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Doc and prompt (weakest lever, last, not relied upon) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `todo` — high

**A registry-read FAULT must not render as "not registered" (EI-19286551248996972).** Observed live 2026-08-01: `plans:list` returned ok:true with `plans:[]` and `plans:get` returned not_found for `papercusp`, while psql held 960 plans. Four defensible layers compose the wrong answer: (1) `harness-core.ts:371-374` + `:377-383` wrap both registry reads in bare `catch {}` that deliberately fold "unreadable" into "absent", returning a `null` byte-identical to a genuine miss; (2) `plans/source.ts:368` propagates it; (3) `plans/source.ts:412-419` restates that null as an ASSERTION ABOUT THE WORLD — "harness '<x>' is not registered in the harness registry" — whose own advice is to go register it (a WRITE, i.e. actionable in the wrong direction); (4) `plans/list.ts:549` regex-matches that message and swallows it into `unknownHarnesses`, returning ok:true + []. `host-benign-errors.ts:141-159` also marks it benign, so it never raises the error rate — invisible in telemetry too. FIX (structural, not detection): give `resolveWorkspaceForHarnessSlugIn` a discriminated verdict (found \| absent \| unreadable-with-cause) instead of one `null`; let `resolvePlanScope` assert "not registered" ONLY after a read that genuinely SUCCEEDED and returned no row; make list.ts's swallow key off that typed verdict rather than a regex over an error string; drop the fault variant from the benign classifier. Note the general rule this earns: an error-STRING match can never separate a real absence from a fault that renders the same words — the distinction must be typed at the source. Testable without a live DB via the existing injectable seams (`resolvePlanScope`'s `registryFallback`, `fill_workspace_id_from_projects`'s `lookup`): inject a throwing `loadHarnessRegistry` and assert plans:list does NOT answer ok:true/[] for a harness whose rows are present.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make the wrong answer impossible (structural) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `todo` — high

fleet:launch-on-plan returns ok:true after SILENTLY discarding the launch brief (WI-7131). `launchContext` takes a PATH; prose fails ENAMETOOLONG; ten agents then launched with the baseline only and the failure was reported as success. Everything the members needed — priority order, evidence bar, why the prior cohort died — reached nobody. Caught only because the error text happened to survive the truncation door. Fix: resolve/validate launchContext BEFORE spawning and FAIL the launch, or accept prose by writing it to a temp path. Spawning ten agents without their instructions is not a partial success. Note P-007 already added the starvation guard here — this is its dual on the payload rather than the lane.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make the wrong answer impossible (structural) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `todo` — high

A test suite that executes ZERO SQL statements reports green (WI-7132). Tests written against the repo's mocked-pg fake pass on the first run while the query dies on real Postgres with `column "payload" does not exist`. Nothing in the output distinguishes "pinned the transaction shape" from "validated the SQL" — the same epitaph as the retired facts:conflicts suite ("passed identically whether the fleet wrote assumptions or not"). Fix: the mock counts statements and a suite asserting SQL behaviour FAILS at zero executed. Sibling of the zero-file typecheck (`-p .` → TS5057, checked nothing, read as clean) and of P-013.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make the wrong answer impossible (structural) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-019 — `todo` — high

Fleet rosters report present state only, so a fleet that LOST 10 members reads as a healthy 1-member fleet (WI-7130) — and this does not merely hide loss, it FABRICATES a phantom event. A dead member drops out of the roster, so `summary.dead: 0` was literally true and completely misleading; the only alert raised was about the leader sitting idle. A monitor loop calls this tool every wake BY DESIGN, so the one question a monitor most needs — did I lose anyone — is the one its own tool cannot ask. Worse: because loss is discovered late and all at once, BATCHED DISCOVERY IS INDISTINGUISHABLE FROM A BATCHED EVENT. That is what put "mass death" in the leader's head before a single timestamp was read, and it aimed two successive hypotheses at a simultaneous killer that never existed. Fix is a read, not new bookkeeping: `membersLost: N, since: <ts>` from the already-recorded ended_at.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Make the wrong answer loud (detection) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-021 — `todo` — high

No base-rate primitive: every read is a FILTERED read with no denominator, so ordinary variation reads as an anomaly (EI-19375528138828761). Agents reason forward from a cluster without ever testing whether the cluster is remarkable. On 2026-08-02 this produced two wrong answers and a near-miss third: the investigation was dissolved by one flat minute-histogram, and a "24h lifetime cap" (7 chains at 23.8-24.1h, start/stop positively correlated) was refuted by the same table returning chains of 32/66/111/166/193h. Both times the suggestive cluster and its refutation were seconds apart in one relation. Fix, in preference order: (1) denominator-in-result — when a tool returns a filtered slice of a countable population, include the population size and window ("matched 8 of 392 sessions in this window"); (2) a `baseline:compare` verb returning a metric over trailing comparable windows. Not another detector — a habit-forming default.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Make the wrong answer loud (detection) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-022 — `todo` — normal

A wrong time window returns zero rows, which reads as "no evidence" (WI-7133). This box is EDT; every papercusp timestamp is UTC; `journalctl --since` parses LOCAL. A query four hours into the future returned nothing and was briefly taken as confirmation that no kill was logged — actively pushing the investigation FURTHER toward an already-wrong cause. An existing memory covers this trap and surfaced as a hint only AFTER the mistake. Fix: time-bounded log reads normalise/echo the RESOLVED ABSOLUTE window in their result, and a zero-row result states the window it searched, so "nothing there" is distinguishable from "wrong there".

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Make the wrong answer loud (detection) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-023 — `todo` — normal

No tool answers "what cgroup/scope is this agent in" — the question that decides what can kill it (WI-7134). Diagnosis required shelling into /proc, and `pgrep -f <ownerId>` SELF-MATCHED the agent's own command line on three of four lookups, returning the caller's pid as if it were the target's — a silent wrong answer of exactly this plan's shape, and the same family as the documented `pkill -f` self-match trap. Fix: expose the agent's cgroup path / transient scope on an existing presence or process surface (`processes:list` already carries provenance), so "what confines this agent" is a read rather than a shell excursion using a known-defective idiom.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Make the wrong answer loud (detection) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-024 — `todo` — low

Result-door advertises `projection` as applying "to any tool's result", but it is a per-tool arg and undeclared-arg rejection refuses it (WI-7135). It is offered at exactly the moment it is most needed — the reader has just been truncated — and the advice then fails on the next call. Same family as P-013 (documentation asserting a guarantee whose implementation is not live): here the DOC is the surface returning the confident wrong answer. Fix: either accept `projection` generically at the door, or narrow the advertisement to the tools that actually declare it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Doc and prompt (weakest lever, last, not relied upon) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/bash-substitution-reachable-ceiling-2026-08-01</code> — Move bash substitution to ~100% of the reachable population: fix the denominator, measure the ceiling, make compliance free — <strong>11 residual</strong> (8 todo, 3 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-02T22:35:14.076Z |
| Now | **PHASE 2 BUILT: P-020 ✓ P-021 ✓ P-022 ✓ P-007 ✓ P-009 ✓ (P-008 absorbed).** Reachable ceiling 55.6%, not 100% (D-051, D-053). **AUTO-SUBSTITUTION IS DEAD** on three grounds: D-056 · D-057 · D-058.  **THE MEASUREMENT RAN — and it is HALF-IN (D-064).**  **Half 1, byte bound — VERIFIED IN PRODUCTION, closed.** `testing:run` output_size 08-02: 261 calls, max **5,105** ≤ 5,949, **0 over-bound**, median **exactly 197 B**. Pre-bound maxima were 19,451 / 20,569 with 6 and 2 over-bound. The median is 197 on ALL four measured days — unmoved across the transition, which is exactly D-062's own test for "the bound is not clipping ordinary results". WI-7082 works.  **Half 2, compliance — 0.00%, and it is UNTESTED, NOT FALSIFIED.** 2,930 fires (2,324 advise + 606 observe), 47 sessions, 16 rows, 15:48Z→22:33Z: complied TRUE **0**, FALSE 2,922, NULL 8, resolved 2,922. The instrument is sound (99.7% resolved) — this is a real 0.00%, below D-059's ~2%.  ⚠️ **But P-009 NEVER DEPLOYED.** `invoke-envelope.ts` is on origin/staging (5b39f341b4), **ABSENT from origin/main AND from the deployed release checkout** (HEAD 1e0ddc5864). All 2,930 fires were served without an executable envelope. Per D-064: this is a clean PRE-TREATMENT baseline — do NOT read it as falsifying the "make compliance free" premise, and do NOT re-scope Phase 3 on it. It does establish the true floor is an exact 0.00% at n=2,930, not ~2%. |
| Next | BLOCKED ON THE RED GATE, not on any work here. `main` is stuck at 1e0ddc5864 (consecutiveReds 6), so P-009 cannot reach the release checkout. The moment the gate greens and the deploy lands invoke-envelope.ts, re-run ONLY the compliance query (harness_shared.bash_tool_substitution_fires, workspace-scoped: complied TRUE/FALSE/NULL + resolved_at, split at the deploy timestamp) and compare the post-deploy rate against the now-exact 0.00% baseline at n=2,930. The byte-bound half needs NO re-run. Do not widen `REPLAYABLE_VERBS` before a per-family isolation contract replaces `fixturePath` (D-060); `dev:listening_ports` stays NOT promotable at n=9. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-6891` [done] **Fix the atomizer so non-commands stop counting as bash atoms.** `const`/`import`/`return`/`do`/`done`/`if`/`Tests`/`FAIL` are being atomized out of heredoc bodies, embedded node/python scripts, and…<br>`WI-6892` [done] **Re-baseline every number in the previous plan against the corrected corpus.** The 41% baseline, all 21 rows' `baseline_calls`, and the frozen fixtures were all drawn from the contaminated corpus. P…<br>`WI-6893` [done] **Add per-fire registry telemetry: `match_count`, `last_fired_at`, and a fire-event row {row_id, session_id, command, tier, complied}.** Compliance = did that session's next tool call use the named t…<br>`WI-6894` [done] **Census 100% of the corrected bash corpus, not the 6% the registry happens to label.** Cluster every atom by intent; rank by atoms x sessions. Deliverable: a ranked, exhaustive table whose rows sum …<br>`WI-6895` [done] **Classify every census row into one of five dispositions and PUBLISH THE MEASURED CEILING.** (i) covered by a row already; (ii) substitutable, tool exists, no row — cheap; (iii) substitutable, needs…<br>`WI-6896` [done] **Decide the treatment of pipe-filter and compound-command shapes — the single largest ambiguous class.** `grep` (27,706), `head` (17,982), `tail` (8,968), `wc`, `sort`, `cut` are dominated by `\| fil…<br>`WI-6897` [done] **Audit all 17 `advise` rows for callability-at-advice-time.** EI-18856178945306155: the advisory names `capability:read`, but a Claude Code psu session's ambient reader is `Read` (no `tail` param) a…<br>`WI-6898` [done] **Make named substitute tools ambient rather than deferred in psu sessions** (or have the hook auto-load the named tool as part of firing). Removes the round-trip that P-007 shows is suppressing adop…<br>`WI-6899` [done] **Emit EXECUTABLE advisories: the exact tool call with args derived from the matched command, not prose describing it.** `tail -25 /tmp/x.log` should yield a ready `{ file_path: '/tmp/x.log', tail: 2…<br>`WI-6900` [done] **Build the shared caller-specified PROJECTION stage in the endpoint dispatch layer (D-041).** Six operators, closed set, measured from the corpus: grep (+`-A/-B/-C` context), head, tail, count/wc, s…<br>`WI-6901` [done] **Extend the equivalence harness from EXPRESSIBILITY to OUTPUT-DIFF replay — the gate for auto-substitution.** Today it asks 'can this command be expressed through the tool?'; auto-substitution needs…<br>`WI-6902` [done] **Implement transparent auto-substitution (D-042).** The hook rewrites a matched command to its tool call, runs it, reports the swap. Non-negotiable guardrails from D-042: FAIL-OPEN on any parse ambi…<br>`WI-6903` [open] **RTK preflight (D-046) — resolve the two blockers before any wrapper wiring.** (1) Find out why our hook explicitly disables `rtk vitest` (`case "$__in" in *vitest*) exit 0;;`): read whatever added …<br>`WI-6904` [blocked] **Wire `rtk <cmd>` inside the wrapper tools (D-046).** `build:typecheck` -> `rtk tsc`; `capability:git` -> `rtk git`; the D-045 vendored-ripgrep path -> `rtk rg`; `testing:run` -> `rtk vitest` ONLY i…<br>`WI-6905` [open] **Bulk-add registry rows for every census bucket where a suitable tool ALREADY exists.** Cheapest volume in the plan — data rows, no new code, each still gated by the existing equivalence method.<br>`WI-6906` [open] **Build tools for the top-N uncovered substitutable buckets by volume**, reusing the Phase-4 pattern from the previous plan (`testing:run`, `logs:read`, `build:typecheck` were all built this way). N …<br>`WI-6907` [blocked] **Run the existing equivalence audit for every new pair before it enters at `observe`.** The method exists and is proven; per D-001 of the previous plan a pair stays at `observe` until its verdict is…<br>`WI-6908` [open] **Attack job-liveness polling at the source.** The previous plan measured ~2,950 calls (12% of all bash) as one question: "is my job done?" — `ps`/`pgrep`, polling task-output files, and bare `sleep`…<br>`WI-6909` [open] **Quantify `echo`/`cd`/`export` (~42,752 atoms, ~29% of the top-30) and confirm they are permanently excluded from the target.** Much of `echo` is the `echo MY_EXIT=$?` verdict-line idiom this fleet …<br>`WI-6910` [open] **Promote rows `observe` -> `advise` -> `deny` only where per-fire telemetry shows sustained compliance and zero measured false positives.** D-040's ~0 false-positive budget for `deny` stands; D-039'…<br>`WI-6911` [open] **Keep `git-state-read` pinned at `observe` as the CONTROL GROUP.** D-011 held it for its own reasons and D-043 made the hold machine-readable; it has since become scientifically load-bearing — the o…<br>`WI-6912` [open] **Re-run the report against the CORRECTED corpus and publish per-bucket before/after with the control.** Success is stated against the P-005 ceiling ("X% of the substitutable population"), never agai…<br>`WI-6913` [blocked] **Write the agent-insights doc on measuring a substitution programme**, covering the three traps this plan was created by: a contaminated denominator, a coverage ceiling mistaken for a compliance pro… |

#### P-013 — `blocked` — normal

**Run the existing equivalence audit for every new pair before it enters at `observe`.** The method exists and is proven; per D-001 of the previous plan a pair stays at `observe` until its verdict is `equivalent`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Coverage expansion (where the number actually lives) |
| `blocked-by` | `P-011` |
| Unresolved blockers | `P-011` |
| Open issue blockers | — |
| Decisions | `D-001` |
| Linked work-items | None |

#### P-019 — `blocked` — normal

**Write the agent-insights doc on measuring a substitution programme**, covering the three traps this plan was created by: a contaminated denominator, a coverage ceiling mistaken for a compliance problem, and an un-attributable metric with no control group.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Prove it |
| `blocked-by` | `P-018` |
| Unresolved blockers | `P-018` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-024 — `blocked` — high

**Wire `rtk <cmd>` inside the wrapper tools (D-046).** `build:typecheck` -> `rtk tsc`; `capability:git` -> `rtk git`; the D-045 vendored-ripgrep path -> `rtk rg`; `testing:run` -> `rtk vitest` ONLY if the preflight clears it. Verify each wiring with the P-021 output-diff replay harness — a wrapper that loses a failing test name or a tsc error location is a regression however many bytes it saves. This is what converts D-044's tradeoff into a compound: the tool keeps its structure AND stays inside RTK's compression coverage.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Make compliance nearly free |
| `blocked-by` | `P-023` |
| Unresolved blockers | `P-023` |
| Open issue blockers | — |
| Decisions | `D-046`, `D-045`, `D-044` |
| Linked work-items | None |

#### P-011 — `todo` — normal

**Bulk-add registry rows for every census bucket where a suitable tool ALREADY exists.** Cheapest volume in the plan — data rows, no new code, each still gated by the existing equivalence method.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Coverage expansion (where the number actually lives) |
| `blocked-by` | `P-005` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `todo` — normal

**Build tools for the top-N uncovered substitutable buckets by volume**, reusing the Phase-4 pattern from the previous plan (`testing:run`, `logs:read`, `build:typecheck` were all built this way). N is set by where the census curve flattens, not picked in advance.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Coverage expansion (where the number actually lives) |
| `blocked-by` | `P-005` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `todo` — normal

**Attack job-liveness polling at the source.** The previous plan measured ~2,950 calls (12% of all bash) as one question: "is my job done?" — `ps`/`pgrep`, polling task-output files, and bare `sleep`. `sleep` still shows 1,254 unlabelled atoms across 334 sessions. Routing a poll to a tool still leaves a poll; the fix is push (completion events, `events:await`), and the win is denominator reduction.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Eliminate rather than route |
| `blocked-by` | `P-004` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-015 — `todo` — normal

**Quantify `echo`/`cd`/`export` (~42,752 atoms, ~29% of the top-30) and confirm they are permanently excluded from the target.** Much of `echo` is the `echo MY_EXIT=$?` verdict-line idiom this fleet correctly relies on because task notification exit codes lie (fact `background-task-exit-code-notifications-lie`). That is GOOD practice generating bash volume — a strong argument that raw bash share is the wrong headline metric.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Eliminate rather than route |
| `blocked-by` | `P-004` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `todo` — normal

**Promote rows `observe` -> `advise` -> `deny` only where per-fire telemetry shows sustained compliance and zero measured false positives.** D-040's ~0 false-positive budget for `deny` stands; D-039's precedent (a deny must argue CORRECTNESS, not cost) stands.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Escalate tiers on evidence |
| `blocked-by` | `P-003` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-040`, `D-039` |
| Linked work-items | None |

#### P-017 — `todo` — high

**Keep `git-state-read` pinned at `observe` as the CONTROL GROUP.** D-011 held it for its own reasons and D-043 made the hold machine-readable; it has since become scientifically load-bearing — the only covered intent that fires no advisory, and therefore the only way to tell a real advisory effect from workload drift. Do not promote it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Escalate tiers on evidence |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-011`, `D-043` |
| Linked work-items | None |

#### P-018 — `todo` — normal

**Re-run the report against the CORRECTED corpus and publish per-bucket before/after with the control.** Success is stated against the P-005 ceiling ("X% of the substitutable population"), never against raw bash share. Per D-006 of the previous plan, record WHICH per bucket: bash flat ⇒ advisory not landing; bash down but counterpart flat ⇒ agents stopped doing the work, which is a regression, not a win.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Prove it |
| `blocked-by` | `P-005` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-006` |
| Linked work-items | None |

#### P-023 — `todo` — high

**RTK preflight (D-046) — resolve the two blockers before any wrapper wiring.** (1) Find out why our hook explicitly disables `rtk vitest` (`case "$__in" in *vitest*) exit 0;;`): read whatever added it and replay a real vitest run through `rtk vitest`, diffing against raw output. If it mangles output, do NOT wire it into `testing:run` either — record that as a decision. (2) RTK writes a banner to stdout (`[rtk] /!\ No hook installed — run 'rtk init -g'`); establish the suppression/stripping mechanism (env var, flag, or a wrapper-side filter) BEFORE any tool captures rtk output, or the banner contaminates every result.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Make compliance nearly free |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-046` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/fleet-leadership-continuity-and-actuation-2026-08-01</code> — Fix what made leading a fleet expensive: lost work, two conflicting truths, polled leadership, and gauges without levers — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-02T17:02:55.847Z |
| Now | **19 of 20 done.** P-011 (Phase 3's verification item) is the only one open.  **P-011's blocker MOVED 2026-08-02 ~15:47Z: the fix is now LIVE. The prior Now — "not on origin/main, :3070 contains 0 occurrences" — is SUPERSEDED and false.** Verified ~17:05Z in four hops, none of them inferred: (1) `origin/main` = `1e0ddc5864`; (2) release checkout `papercup-release` is at that sha and contains the change; (3) `:3070` = pid 4191737, cwd `papercup-release/apps/operator`, started **15:47:57Z** — after the 15:32:49Z green; (4) deployed source read directly at `packages/operator-core/lib/agent-tools/loop/arm.ts:553` — gated `args.mode === 'monitor'`, emitting `fleet:member-dead · fleet:claim-released · fleet:item-completed · fleet:context-critical` plus the `events:await` call shape. A live `loop:arm { mode:'monitor' }` returned it verbatim at 16:23Z.  **What P-011 now waits on is ELAPSED TIME, not work.** The treatment reaches an agent only when it CALLS `loop:arm`; agents already looping never re-arm and so never see it. Fleet baseline: **251 `loop:arm` calls / 74 distinct agents / 7d ≈ 36/day ≈ 1.5/hr.** In the 75 min since restart: 2 calls, **both from `su-6fa6afdb`, this plan's own author**. Expected non-self exposure ≈1.9, observed 0 — inside Poisson noise, **NOT a negative result**. |
| Next | HOLD P-011 until ≥ ~2026-08-03T16:00Z (24h post-restart ≈ 36 expected exposures), then run the test in TWO ORDERED steps — exposure BEFORE adoption. (1) EXPOSURE: `SELECT count(*), count(DISTINCT coord_owner_id) FROM harness_shared.tool_invocations WHERE tool_name='loop:arm' AND invoked_at > '2026-08-02T15:47:57Z'` — if distinct NON-SELF agents < 10, report "insufficient exposure" and hold; never publish a bare adoption count. (2) ADOPTION: `harness_shared.event_awaits` WHERE `event_key LIKE 'fleet:%'` AND created_at > that same instant, EXCLUDING `subscriber_id='su-6fa6afdb-860d-4812-a575-6a6656e07160'` (exposure #1 is this plan's author; self-awaits are contamination). Do NOT manufacture exposure by arming loops to create data points. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-6701` [done] Surface PRIOR WORK at claim time: when a work-item has any prior holder, attempt, or release, `work_items:claim` / `work_items:get` / `scheduler:get_next` return a banner naming who held it, how long…<br>`WI-6702` [done] Auto-checkpoint IMMEDIATELY BEFORE a compaction boundary, not only at turn-end. This is the item that removes the race rather than managing it — "checkpoint, then compact" is two steps with no interl…<br>`WI-6703` [done] Auto-checkpoint on claim RELEASE whenever the releasing holder has no agent-written checkpoint. The mechanical turn-end snapshot already exists and fired for a sibling item in the same run; it simply…<br>`WI-6704` [done] Regression test: an item that has been worked and released with no checkpoint must be programmatically DISTINGUISHABLE from a never-started item at every read surface an agent uses to decide whether …<br>`WI-6705` [done] Make `plans:set-item-blocked-by` propagate to the linked work-item in the same transaction, BOTH directions: clearing the last edge clears the `plan-lane` externalBlocker and reopens the item; adding…<br>`WI-6706` [done] Make claim release ATOMIC across both surfaces: at a session/compaction boundary, release the work-item claim and the plan-item lane together, or neither. A half-released pair is worse than either be…<br>`WI-6707` [done] Warn at claim time when the item's linked plan lane is held by a DIFFERENT live agent — "this work-item is unassigned BUT its plan lane is claimed by <agent> (live)". Cheap guard that catches the div…<br>`WI-6708` [done] DECIDE (then implement): should there be ONE authoritative claim rather than two mirrored ones? P-005..P-007 are three point-fixes for one architectural duality; if the duality is not load-bearing, c…<br>`WI-6709` [done] Emit fleet transition events the leader actually reacts to — member-dead, claim-released, item-completed, context-critical, idle-with-claimable — catalogued under a `fleet:<slug>:` prefix so a leader…<br>`WI-6710` [done] Re-document leading as event-driven: a composed `events:await` over the Phase-3 event set as the PRIMARY mechanism, with `loop:arm` demoted to a long fallback heartbeat for what is genuinely not even…<br>`WI-6711` [open] Verify the win on a real fleet: a leader using P-009/P-010 should burn materially fewer wakes AND react faster to a released claim than the 180s poll did (~14 wakes, mostly near-noops, up to 3min to …<br>`WI-6712` [done] Add a leader-initiated forced checkpoint (`fleet:require-checkpoint { member, itemId }`) that RETURNS whether it landed, so the leader knows state is safe before advising a compaction rather than hop…<br>`WI-6713` [done] Distinguish DELIVERED from ACTED-ON for directives: `coord:send { wake:'required' }` returning `woken: 1` currently proves only that a session woke. For a safety-critical directive the leader needs t…<br>`WI-6714` [done] Let a leader register a CUSTOM invariant evaluated each brief, rather than only reading the fields the brief was designed to expose. Motivating case: a ~6-line check cross-referencing each member's p…<br>`WI-6715` [done] Render a composed await in `fleet:leader-brief` as ONE entry carrying its own verdict — mode (any/all), required-of-total, the ROOT's effective deadline and timeout behaviour — and never list a root …<br>`WI-6716` [done] Resolve a composed LEAF to its root's effective deadline anywhere liveness is judged, not just in leader-brief. A leaf row with a non-null root_id is not self-describing, so every consumer of `event_…<br>`WI-6717` [done] Make `events:await` REFUSE a work-item status key when the caller is that item's assignee — unsatisfiable by construction, and a precondition check against state already in hand. Enforce at CLAIM tim…<br>`WI-6718` [done] Detect the dormancy shape: a member that finishes a turn with no loop armed and no event park is permanently asleep and invisible in every summary counter. Surface it as a first-class brief verdict, …<br>`WI-6719` [done] `code:run`: strip undefined-valued keys before strict-args validation. Passing a key with an explicitly-undefined value is idiomatic JS for "not provided" and is currently rejected as an unrecognised…<br>`WI-6720` [done] `code:run`: when a validation error ABORTS a script, report which already-ordered writes did NOT execute — the way `okFalseMutations` / `partial: true` already report failed ones. A read's arg typo s… |

#### P-011 — `todo` — normal

Verify the win on a real fleet: a leader using P-009/P-010 should burn materially fewer wakes AND react faster to a released claim than the 180s poll did (~14 wakes, mostly near-noops, up to 3min to notice the last item's claim drop). Measure both, because reducing wakes while worsening latency would be a regression.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Make leading push-based, not polled |
| `blocked-by` | `P-010` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/session-death-claim-release-2026-07-11</code> — Auto-release work-item claims when an agent session/console dies — event-driven primary + scheduled backstop — <strong>3 residual</strong> (3 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-02T02:24:40.848Z |
| Now | NEW [owner:Avi 2026-07-11]. Owner killed a fleet by closing its terminals; the killed members' work-item leases (work_items.taken_by) were NOT released — persisted for the 6-day lease TTL, poisoning items for any successor. Owner directive (verbatim): "shouldn't our system have automatically unclaimed it as soon as I killed them... it shouldn't have to unclaim on a poll, it should be able to be done on a trigger when I close the console by listening to some event... We want a check to happen on a schedule too in case the event isn't fired for some reason, but it's better to get notified as soon as the console/session terminates."  **Root cause (grounded):** (1) the presence reaper detects a dead session on a ~10-min idle poll but does NOT cascade to release that owner's leases; (2) the SessionEnd/Stop hook already FIRES on every psu session (hooks/cc/lifecycle-report.sh) but only posts a cosmetic activity marker; (3) work_items:release WITHOUT force:true returns ok:true while NOT clearing taken_by (should be not_holder); WITH force:true it DOES clear taken_by (verified on WI-4070). Release mechanism already exists — nothing invokes it on death, and non-force lies about success. See EI-9807 + EI-9808. |
| Next | P-001 (reaper cascade — the reliable backstop) → P-002 (event-driven hook — the fast path) → P-003 (honest non-force release). |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-4226` [done] BACKSTOP (schedule): make the presence/session reaper cascade to work-item leases. When the reaper marks a session ended (owner idle past sessionReaperGrace), force-release every work_items row where…<br>`WI-4227` [done] FAST PATH (event): on session terminate, immediately force-release the owner's held items — no 10-min wait. The SessionEnd/Stop hook (hooks/cc/lifecycle-report.sh) already fires on every psu session …<br>`WI-4228` [done] HONEST non-force release (close the silent-success trap, EI-9807): work_items:release/update/claim WITHOUT force, called by a NON-holder, must return not_holder (per the release tool doc) — NOT ok:tr… |

#### P-001 — `todo` — high

BACKSTOP (schedule): make the presence/session reaper cascade to work-item leases. When the reaper marks a session ended (owner idle past sessionReaperGrace), force-release every work_items row where taken_by = that owner (work_items:release { force:true } semantics — the leader/reaper override that already clears taken_by/taken_at, verified on WI-4070). Ship a test: a session goes ended -> its held items become taken_by=null and re-claimable. Reliable safety net catching SIGKILL/SIGHUP deaths the event misses. Files: the reaper (grep sessionReaperGrace / markEnded in packages/operator-core/lib), work_items/release.ts.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Items |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

FAST PATH (event): on session terminate, immediately force-release the owner's held items — no 10-min wait. The SessionEnd/Stop hook (hooks/cc/lifecycle-report.sh) already fires on every psu session and posts to the operator; extend it (or a sibling hook) to POST a "release my claims" call for PAPERCUSP_SID's owner. Verify what fires on raw terminal close (SIGHUP) vs clean exit — if SessionEnd is not guaranteed on console-close, document the gap (backstop P-001 covers it). Add a server verb "release all claims for owner X" if none exists (reuse release force-semantics). Test: SessionEnd -> owner items released within seconds.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Items |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — high

HONEST non-force release (close the silent-success trap, EI-9807): work_items:release/update/claim WITHOUT force, called by a NON-holder, must return not_holder (per the release tool doc) — NOT ok:true. Today they return ok:true while not clearing taken_by, which is how the two-ledger divergence hides. Reconcile work_item_claims (coordination) vs work_items.taken_by (lease): a release that clears one clears both. Test: non-holder non-force release -> not_holder; holder release -> both ledgers cleared.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Items |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/memory-write-latency-2026-07-26</code> — Memory write/read latency: return after the durable journal, cache the recall — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-01T23:27:59.367Z |
| Now | COMPLETE except one owner decision. Both of the plan's original assumptions were tested and both failed — D-001 (write side) and D-003 (read side) carry the evidence. WRITE SIDE FIXED: embed+store was never the cost; the write path was running a full semantic neighbour search on every write to feed a conflict judge that is a no-op in this operator (no ANTHROPIC_API_KEY). P-007 gates the search on a real consumer, P-008 bounds the query at 512 chars so the cost class cannot return, P-009 ships 10 recurrence guards split by class. Verified: 80/80 memory tests green, lint:tsc --mine clean, and end-to-end through the REAL MCP handler on staging :3170 (ok:true; the anti-silence warn fired in the live journal). MEASURED: 9 interleaved A/B pairs at the p50 1,189-char body → median 2,710ms → 1,583ms, 42% faster, saving range −25…1,831ms (shared-sibling embedder contention rivals the effect in a single pair, hence interleaving). The provisional 500ms p95 target is NOT met and should not be chased — only one unavoidable body embedding remains. DROPPED: P-002/P-003/P-004 (aimed at embed+store) and P-005 (4.2% query repeat rate caps a cache at ~4%); the read-side PROBLEM survives as EI-18748795522559631. FILED: EI-18746586784230719 (conflict-check inert), EI-18747066020546067 (the detector hole that hid it — plus lint:env-feature-gates:strict currently exiting 1 on 11 gates), WI-6215 (production after-numbers, pending deploy). |
| Next | Avi to decide P-010 (needs-human): give conflict-check a real gateway-routed key, or retire it — nothing is blocked on it either way, since the write path no longer pays for it. Production confirmation tracked as WI-6215, which waits on the deploy (green gate currently held by 4 unrelated git-sync console.warn failures). |
| Live presence | None in final 10-minute window |

#### P-010 — `needs-human` — high

Park the conflict-check fork for Avi as needs-human — NOT mine or su-2846407f's call, per su-2846407f 2026-07-26. Whether conflict-check gets a real (gateway-routed) key or is retired changes product behaviour and adds a per-write LLM cost. Do NOT wire a key and do NOT delete the feature; the job is only to stop paying for it while it is inert. Attach the measured numbers so the decision is informed: current per-write search cost by body size, the fact it has never executed in this operator, and the post-fix write latency.  — note: Avi's call: give conflict-check a real gateway-routed key, or retire it. Measured numbers in the rationale + D-001/D-002. Nothing blocks on this — the write path no longer pays for it either way.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 5 — Owner decision (needs-human, do not self-approve) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/production-test-readiness-2026-07-06</code> — Production test-readiness: trustworthy signal + green suite (wave 2) — <strong>3 residual</strong> (2 todo, 1 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-26T19:52:52.887Z |
| Now | P-002 and P-012 are complete. P-010 soak is owned by su-8872. P-008/WI-3208 artifact drill is currently live-held at the plan-item layer by su-e1847; I released my scheduler claim after claim_conflict to avoid double-working. A subsequent scheduler pull returned an unrelated agentic-docs-qa item, also released. |
| Next | Fleet leader should narrow/fix this member's scheduler claim spec or let a production-test-readiness item become unclaimed; su-310f5 loop is stopping to avoid spinning on peer-owned/out-of-plan items. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-3199` [passed] Test-ledger hygiene: prune phantom test_runs rows (deleted files, scratch .papercusp/scratch/tdg-*, wrong-tree papercup-checkpoint/papercusp-checkpoint/papercup-staging prefixes) via testing:prune-or…<br>`WI-3200` [passed] Green the REAL eligible reds (non-federation, non-retired): root-cause-first across operator-core integration reds (work-items-view, claim-next-co-location, delegated-tasks, hive-settings-store, admi…<br>`WI-3201` [done] Green the CLI package reds: libs/papercusp/packages/cli/src/*.test.ts (consent, init-blueprint, install-atomic, lockfile, lock-resolve, normalize-schema, operator-cli, plugin-cli, secret-scrubber) — …<br>`WI-3202` [done] Flake triage: testing:flakiness over 14d; fix root causes; quarantine ONLY with auto-filed de-quarantine follow-ups. Evidence: flip-rate table before/after.<br>`WI-3203` [passed] LLM scenario suite triage: 133 errored + 127 failed vs 103 passed (30d). Split errored (runner/infra faults) from failed (behavioral regressions); fix runner faults; file behavioral regressions as ev…<br>`WI-3204` [done] E2E critical-journey coverage in the Tauri shell: audit the 39 playwright specs + registered UI gates vs core user journeys (boot, pot/harness create, work-items flow, tests tab, deploy/admin-git, ch…<br>`WI-3205` [done] Gate verdict + release checklist: after Phases 1-2 land, leader coordinates a fresh green-checkpoint verdict (gate driver su-f0afe), verifies green pin advances + :3070 deploys, and writes a producti…<br>`WI-3206` [done] Wire the Rust/cargo native suite into the recorded signal: ~151 cargo tests exist but the test_runs ledger has ZERO cargo rows (vitest/playwright/shell/node only). Make the native suite run on the sa…<br>`WI-3207` [passed] Backup/restore round-trip drill: prove a real restore works — snapshot a populated workspace (kopia/backup tools), restore into a clean environment, boot, verify plans/work-items/settings intact. The…<br>`WI-3208` [passed] ARTIFACT drill — fresh-install + upgrade: build the real .deb, install on a clean VM/container, verify cold first-boot green (embedded PG boots, ALL migrations apply from empty, sidecar + webview up,…<br>`WI-3209` [passed] Perf/stability soak: assert on the ledger perf columns that already exist (loop_lag_p95_ms, rss_mb) — a bounded soak (>=2h) under agent load with pass/fail thresholds for RSS growth and event-loop la…<br>`WI-3210` [done] Encode the v1 scope in the gate: formally quarantine the p2p/federation test lane (the ~31 sync/hyperbee + shared-hive-loop + substrate reds) out of the v1 green-checkpoint verdict, each with a filed… |

#### P-010 — `wip` — normal

Perf/stability soak: assert on the ledger perf columns that already exist (loop_lag_p95_ms, rss_mb) — a bounded soak (>=2h) under agent load with pass/fail thresholds for RSS growth and event-loop lag, plus a cold-boot-time assertion. Read /internal/docs/performance anti-patterns (A1-A14) first. Evidence: soak report with thresholds. (WI-3209 in progress: fixed test_runs perf-field producers and live-smoked metric-bearing rows; collecting the required >=2h soak window before completion.)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 3 — Signal breadth |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Gate verdict + release checklist: after Phases 1-2 land, leader coordinates a fresh green-checkpoint verdict (gate driver su-f0afe), verifies green pin advances + :3070 deploys, and writes a production-release test checklist to /internal/docs/testing (what must be green; which excluded-red lanes remain and why).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Release gate |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — high

ARTIFACT drill — fresh-install + upgrade: build the real .deb, install on a clean VM/container, verify cold first-boot green (embedded PG boots, ALL migrations apply from empty, sidecar + webview up, no STARTUP VALIDATION errors); then the UPGRADE drill: install over an existing populated data dir, verify migrations apply and data survives. Run with hive auto-wire DISABLED (p2p is v2 — do not join production swarm topics from test frames, cf WI-1423). Evidence: boot logs + before/after data checks.  (WI-3208 claimed by su-e1847 for artifact fresh-install + upgrade drill.) (← WI-3208 released) (← WI-3208 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Signal breadth |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/cup-lexicon-full-rename-2026-07-09</code> — Cup-lexicon full rename — retire all bee/hive naming (backend ids + prompts + docs + site) — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-26T19:52:48.228Z |
| Now | P-009 (DB rename) and P-010 (artifact regen) are both DONE. P-010 landed 5/7 regen items (tool-catalog.json, .nx reset, hive-eval-seed-app→pot-eval-seed-app rename, plans-index.md+doc-projections); 2 items deliberately deferred as separate non-blocking follow-ups: WI-3987 (pre-existing unrelated dist/ build bug, not on live import path) and P-011's own audit-scanner pass (174 tool-catalog.json guidance-prose hive/bee/queen hits). P-011/WI-3467 (full verification: typecheck, test:all:integration, live fleet smoke via Tauri, release-gate+deploy, lexicon audit grep) is now unblocked and dispatched to su-cc18dce3, who already holds its prep checkpoint. Known live risk: git-sync on papercusp is currently stalled (DBOS executor wedge) — HEAD hasn't advanced in ~1h as of 00:10Z; a manual git-sync:run was fired, outcome pending. This affects P-011's deploy step, not the verification steps. |
| Next | su-cc18dce3 executes P-011 (WI-3467); leader monitors, spot-verifies completion claims (don't trust self-report), confirms git-sync recovers before the deploy step lands, then loop:end once P-011 is genuinely done. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-3458` [passed] Prep & baseline: DB snapshot via backup:snapshot_create, record typecheck/test baseline, build codemod scripts from scratchpad/lexicon-audit-2026-07-09 inventory. Map: hive→pot, bee→cup, queen→brain,…<br>`WI-3459` [passed] Slice A — UI display residue (audit §9): QueenTab/SentinelTab/OverwatchTab internals, HiveSteeringTree, LocalHivesControl, QueenHeartbeat, adv panels, palette/toasts/empty-states, 16 server term() ca…<br>`WI-3460` [passed] Slice B — MCP tool renames (supersedes restore-pot P-016): hive:*→pot:* (30), bee:spawn→cup:spawn, sentinel:converse→operator:converse, fleet:bee_mail/selected_bee→cup, deploy:hive→deploy:pot, deploy…<br>`WI-3461` [todo] Slice C — HTTP routes (supersedes restore-pot P-018 slice 1): /api/**/hive*→pot*, /api/discovery/join-hive→join-pot, /settings/hive-customization→pot-customization, /remote-hives→/remote-pots, routes…<br>`WI-3462` [done] Slice D — blueprint + role ids (supersedes restore-pot P-018): blueprints bee→cup, hive-eval→pot-eval, sentinel→operator in BOTH copies (libs/papercusp harness + desktop env-sidecars; red-queen kept)…<br>`WI-3463` [done] Slice E — flags/env/routines/files (audit §5–8): 27 flag keys (keep THE_HIVE, RED_QUEEN), ~60 env vars (PAPERCUSP_HIVE_*, QUEEN_BRIEF, HIVE_HOME…), 7 routine names (hive-watchdog-sweep→pot-watchdog-s…<br>`WI-3464` [done] Slice F — docs + prompts FULL sweep (D-003 RESOLVED owner 2026-07-09: agent prompts + dev docs + user-facing docs ALL rebrand): operator-docs 43 hive-named pages, 28 hive-slugged agent-insights slugs…<br>`WI-3465` [done] Slice H — DB rename LAST (supersedes restore-pot P-017): ~83 SQL ids (hives, hive_members, hive_settings, hive_policy, hive_placements, bee_claim_specs, beekeeper_*, hive_eval_*, cross_hive_*, hive_s…<br>`WI-3466` [done] Regenerate generated artifacts + runtime state: tool-catalog.json, tracked dist/, desktop env-sidecars staging bundle, .nx cache; review .papercusp state rows referencing old names.<br>`WI-3467` [blocked] Full verification (supersedes restore-pot P-019): typecheck + test:all:integration + live fleet smoke (create pot → brain→cup placement → coordination/steering/wake under new names) + re-run release-… |

#### P-011 — `blocked` — high

Full verification (supersedes restore-pot P-019): typecheck + test:all:integration + live fleet smoke (create pot → brain→cup placement → coordination/steering/wake under new names) + re-run release-gate verdict + deploy; re-run audit scanner to confirm zero non-kept old-lexicon hits.  (← WI-3467 released)  (← WI-3467 todo) (Reaffirmed blocked, NOT executed. WI-3467 already carries a full CLEAN completion typecheck/test:all:integration/live-smoke/deploy, all green from 2026-07-11, then was force-reopened same day by su-7a3c4041 with no stated reason and has had ZERO progress since 6 days idle, dispatch to su-cc18dce3 never picked up. A DIFFERENT agent's checkpoint on this same item quotes an explicit owner deferral: [owner:Avi 2026-07-11 "we'll finish it later"]. This plan's own Now block updated today says it's "unblocked and dispatched" but that appears stale/unactioned. Given the conflicting signals + the stakes this step deploys + a currently-known live red gate in the shared tree, did NOT unilaterally re-run the full verify+deploy myself.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Execution |
| `blocked-by` | `P-010` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/autonomous-loop-prod-audit-2026-07-02</code> — Autonomous loop → production: full reliability/perf audit + sonnet-5 trimmed gateway migration (owner directive 2026-07-02) — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-26T13:06:46.582Z |
| Now | P-008 IMPLEMENTED (gates running): TRUE root cause of the working-bee reap = the stale-claims STALLED leg (holder ALIVE but last_progress_at > 10min) — NOT dead-classification, NOT missing grace. work_items:checkpoint did NOT bump last_progress_at, so even the L1e checkpoint discipline could not protect a bee. FIX: setWorkItemCheckpoint now bumps work_items.last_progress_at (best-effort, same write path) — a checkpoint IS progress. Combined with the bee persona checkpoint discipline (shipped today), a checkpointing bee now keeps its claim; truly-silent bees still reap at the stalled window; the 30-min wedge reaper remains the hung-bee backstop. |
| Next | Confirm gates green (bg task) → restart batches P-008 + layer-4 gym retry live → NOV-1 QD-guided ideation → federated Phase 0. Audit plan then COMPLETE on implementation items. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-4623` [done] MODEL SWITCH: queen/bee/scout/overwatch off gpt-5.4/codex-ChatGPT to sonnet-5:high TRIMMED via gateway. Find where gpt-5.4:medium is set (f55f4727 task 7: codex subprocess + chatgpt-sub-cli; scout vi…<br>`WI-4624` [passed] GATEWAY ROUTING: all loop agents through :8788 auto-routing across the Anthropic pool, NO egress IPs. Verify per-role live account usage (accounts:status, gateway:status, dev:rate_governor_status); r…<br>`WI-4625` [passed] AUDIT A — loop-halting SPOFs: bg-host restart drops MCP+wakes ~6min; stale-claim reclaim SIGTERM-143s bees at ~10-11min mid-work (killed first WI-1576 bee — tune vs checkpointing); completion-integri…<br>`WI-4626` [passed] AUDIT B — infra: sidecar leak capture path end-to-end check (2560MB snapshot + 8G scope live); gateway :8788 single-instance outage = loop down (restart policy/healthcheck); PG connection storms unde…<br>`WI-4627` [passed] Implement audit fixes (split into items as found), tests with each, deploy + live-verify on the running loop.<br>`WI-4628` [passed] Bee checkpoint discipline (D-001): bee persona instructs work_items:checkpoint at natural boundaries + before risky/long steps; verify dossier folds checkpoints into a successor bee; consider stale-c…<br>`WI-4629` [passed] D-002 Layer 1: carry-note → carry-journal ring (append, ~15 entries, size-bounded) + queen standing-facts ledger (KV w/ TTL) + brief renderer folds both + persona teaches facts-ledger writes. Fixes l…<br>`WI-4630` [blocked] D-002 Layer 2 pilot (flag-gated, default OFF as staged cutover w/ allowlist justification): warm resumable queen session + managed compaction + queen compaction-strategy + rebirth policy (N hours / b…<br>`WI-4631` [passed] GYM-1 unwedge gym-cycle: root-cause the error streak (autoloop_state gym-cycle:error — papercusp since 06-20, gymloopharness 72 consecutive) — read the recorded last_status verbatim first (runbook ru…<br>`WI-4632` [passed] GYM-2 escalation on chronic routine failure: any autoloop_state consecutive_errors > threshold (e.g. 6) files an observation + wakes overwatch — a 12-day silently-dead cycle is a detector gap (same c…<br>`WI-4633` [done] GYM-3 verify/close outcome wiring: eval-verdict-wire → scout_routed_ideas.outcome flips (gym verdicts), change-feed → plan/improvement outcomes; acceptance = the 9 pending routes resolve or escalate,…<br>`WI-4634` [passed] NOV-1 QD-guided ideation: prime the scout ideator with the gym_qd_archive state — crowded niches (avoid) + empty niches (propose here). Generation is currently blind to the archive; this is the core …<br>`WI-4635` [passed] NOV-2 exogenous stimuli in corpus digest: cross-hive corpora, telemetry anomalies, recent-commit digests, deprecated-draft salvage — external entropy so ideas are not resampled from the same internal…<br>`WI-4636` [passed] NOV-3 throughput + selection: raise scout budget (g=3/tick is 11 ideas ALL-TIME), keep critics/grading as filter (grading works: 8/11 graded); NOV-4 champion escalation: gym champions auto-file impro…<br>`WI-4637` [passed] Inventory every live auto-loop role model/account override plus every model catalog, alias, validator, provider adapter, spawn boundary, UI selector, persisted setting, and test that can accept or re…<br>`WI-4638` [done] Verify the exact GPT-5.6 Lua and Fable native Codex identifiers, reasoning-effort support, backend semantics, and installed-account availability using local Codex metadata and official OpenAI sources.<br>`WI-4639` [passed] Implement the narrow catalog/normalization/provider compatibility changes required for GPT-5.6 Lua and Fable, with regression tests at each changed boundary.<br>`WI-4640` [dropped] Migrate every autonomous-loop role and account-steering path to GPT-5.6 Lua high without changing unrelated interactive defaults, fixtures, benchmarks, or historical pricing snapshots.<br>`WI-4641` [deprecated] Prove a live native-Codex Kettle to Mug to Cup cycle on GPT-5.6 Lua high, including model/effort selection, placement, completion, and a real Overwatch scorecard. |

#### P-010 — `blocked` — normal

D-002 Layer 2 pilot (flag-gated, default OFF as staged cutover w/ allowlist justification): warm resumable queen session + managed compaction + queen compaction-strategy + rebirth policy (N hours / bg-host restart / anomaly). Measure vs fresh-per-turn: tokens/wake, latency, time-to-place, re-derivation count. (← WI-4630 released) (← WI-4630 released) (Sync with WI-4630 blocked, exclusion-hold reason on the item — plan projection lagged the ledger.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — TODO |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/scope-unique-identifiers-2026-07-26</code> — Scope-unique identifiers — resolve P-NNN, F-NNN and plan slugs through globally-unique ids instead of scope-dependent strings — <strong>7 residual</strong> (2 todo, 5 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-26T05:14:23.079Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-003 — `blocked` — high

Expose each plan item's LINKED globally-unique work-item id in plans:items / plans:get output, so any consumer can resolve a plan item without needing plan context. This is the enabling change for option B and for chat ref pills (chat-ref-pills-2026-07-26 P-006 currently has to render un-scopable P-refs as plain text; once this lands it can resolve them properly).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Plan items (owner-chosen option B) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — high

Make plan-item REFERENCES resolve through the linked work-item id wherever they cross a plan boundary (coord messages, hydrated refs, cross-plan tooling). P-NNN stays as the in-plan ordinal for ordering and human reading — do NOT change the displayed format or break the 37 existing validators.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Plan items (owner-chosen option B) |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — high

F-NNN cross-harness collision: FIRST determine whether F- is legacy (mirror-guard.ts suggests it is). If legacy, the fix is retire/migrate to WI- rather than re-identify. Either way, add the EI-8805 regression as a TEST: a checkpoint written for a feature id that exists in two harnesses must not be silently lost — that bug was invisible precisely because it failed quietly.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Feature ids + plan slugs |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — high

Plan slugs: make a slug-only cross-scope lookup FAIL LOUDLY rather than silently resolve into another tenant. Copy the migration-allocator precedent (EI-6843) — a structural guard, not a doc. We currently defend this with an agent-insights page, which only helps agents who happen to read it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Feature ids + plan slugs |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — normal

Add the detector that should have existed: a lint/test failing when a NEW scope-unique id scheme is introduced without either global uniqueness or mandatory scope in its type. Every instance in this plan was found by hand; without this guard the next one is found by hand too, after it silently corrupts something.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Recurrence guard |
| `blocked-by` | `P-002`, `P-004`, `P-005` |
| Unresolved blockers | `P-002`, `P-004`, `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Audit + inventory EVERY identifier scheme in the system with its true uniqueness scope (P-NNN, F-NNN, plan slugs, migration numbers, harness slugs, workspace ids, recipe ids, event keys, gate keys, blueprint ids...). Owner asked "anywhere else this can bite us" — the three known instances came from one afternoon of looking, so assume the list is incomplete. Output: a table of scheme -> uniqueness scope -> whether it crosses that scope in prose/APIs. This GATES the rest: do not fix instance-by-instance before knowing the full set.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Establish the invariant |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Write the identity invariant as a documented rule in /internal/docs (agent-insights): an id that appears in prose, coord messages, or cross-scope APIs MUST be globally unique or carry its scope. Cite EI-8805 (silent checkpoint loss) and EI-6843 (migration collision) as the two proven failure modes.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Establish the invariant |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/desktop-build-speed-2026-07-16</code> — Desktop build speed — warm caches, sccache, gui-only, fast linker, profile tuning (tri-platform) — <strong>3 residual</strong> (2 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw7@gmail.com |
| Updated | 2026-07-20T08:53:28.949Z |
| Now | Levers P-001/2/3/4/5/7/8/10 done; P-006 dropped (D-004); P-009 low-pri/blocked. sccache made OPT-IN default-OFF (D-006/WI-5577 — it was nullifying the incremental warm-rebuild win). Measured: linux compile 143s cold / 4.4s warm (P-002) — linux is NOT the bottleneck; the mac/win QEMU VM legs are. NEW LEVER P-011 (added 2026-07-20, su-a2724, owner-directed AUTO): the Windows VM leg ISCC-packs a DISCARDED GUI installer even on a Server-only cut (~42min wasted/cut) because build-windows-on-vm.sh:987-1000 builds the GUI unconditionally — gating it on "gui" ∈ roles gives ~40-45min off every Windows Server cut. Found during WI-5600 (Windows 0.0.12 dead-build: GUI-only, no Server). P-011 is BLOCKED only until the in-flight WI-5600 build (bg job bvz0mwsjr, ~Server ready 05:00 EDT) stops reading that script — editing it mid-run is unsafe. |
| Next | After bvz0mwsjr completes: publish the 0.0.12 Windows Server (WI-5600), then land P-011 (gate GUI leg on roles) + reverse WI-5559 (Windows builds gui+server by default). P-005 (faster mac build host) remains needs-human — owner capital/infra call (bare-metal Mac vs +VM RAM/vCPU vs cross-compile; options in preflight-gate D-002). |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-5080` [passed] Stop cleaning cargo target dirs by default on all three legs (linux local build, mac VM bin/mac-vm-build.sh, the windows VM build script). Audit each for `rm -rf .../target` / role-target cache-clean…<br>`WI-5081` [passed] Baseline measurement: record cold vs warm rebuild wall-clock per platform (GUI role) and store the numbers on this plan, so every later lever is quantified before/after rather than assumed.<br>`WI-5082` [passed] Confirm + document the steady-state disk budget for keeping both roles' target dirs warm on the mac VM (now 68 GB free after WI-5027) and the windows VM — make sure warm caches will not re-trigger th…<br>`WI-5083` [passed] Add sccache as RUSTC_WRAPPER on all three legs, backed by a persistent local cache dir; wire it into release-local.sh + the VM build scripts so even a clean-checkout build reuses compiled crates.<br>`WI-5084` [done] Verify sccache effectiveness: `sccache --show-stats` hit-rate on a clean-checkout build, and measure the delta vs a no-cache cold build. Keep it only if the hit-rate justifies the setup.<br>`WI-5085` [passed] Default the release/download build to GUI-role-only (PAPERCUSP_BUILD_ROLES=gui) — it is the auto-updatable + download artifact, and the Server role is already excluded from the mac/windows release se…<br>`WI-5086` [passed] Switch the Rust linker to mold (linux) and lld (mac/windows) via .cargo/config.toml; measure the link-time delta (linking is a large slice of Rust release build time).<br>`WI-5087` [passed] Tune the release cargo profile for build speed (strip=true, debug=0, evaluate codegen-units) WITHOUT regressing the shipped binary's runtime performance — measure build-time + binary-size + a runtime…<br>`WI-5088` [blocked] Keep a VM base snapshot with the toolchain deps + a warm cargo cache, so a cold-start full build is rare (especially after a VM reprovision, which resets everything).<br>`WI-5089` [passed] Fold the measured before/after and the keep-caches-warm discipline into the desktop-release-upload-runbook + build docs, so the next agent inherits the fast path instead of rediscovering the cold-bui… |

#### P-009 — `blocked` — low

Keep a VM base snapshot with the toolchain deps + a warm cargo cache, so a cold-start full build is rare (especially after a VM reprovision, which resets everything).  (← WI-5088 todo) (← WI-5088 todo)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 5 — Prewarmed base image + runbook |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — high

Windows VM leg packs a DISCARDED GUI installer even on a Server-only cut — ~42min wasted ISCC on every Windows Server cut. build-windows-on-vm.sh:987-1000 builds+ISCC-packs the GUI UNCONDITIONALLY (the GUI heredoc block is not gated on roles), then the Server (SERVER_BUILD_BLOCK, :797-805). So a Windows cut that only needs the Server (e.g. WI-5600: GUI already published, republishing it is forbidden) still burns ~42min LZMA-compressing a GUI installer that is thrown away. This is DISTINCT from P-006/D-004 (which rejected a gui-only *default* because it would drop the shipped LINUX Server product) — this is the inverse: honor a SERVER-only request on Windows by skipping the GUI pack. FIX: mirror the SERVER_BUILD_BLOCK var pattern — build a GUI_BUILD_BLOCK gated on "gui" ∈ PAPERCUSP_BUILD_ROLES (add `_win_build_gui` parse next to `_win_build_server` at :772-778), so `PAPERCUSP_BUILD_ROLES="server"` skips the GUI cargo+ISCC entirely. Collection (:1111-1127) is already role-agnostic and the spanning check (:1148) handles server-only. Verify with `bash -n`. WIN: ~40-45min off every Windows Server-only cut. BLOCKED until the in-flight WI-5600 build (bvz0mwsjr) stops reading build-windows-on-vm.sh (editing it mid-run is unsafe); land immediately after. Pairs with reversing WI-5559 (Windows should build gui+server by DEFAULT, matching mac D-004's own "don't drop Server" logic — that's the WI-5600 correctness fix). Discovered during WI-5600.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Skip the second role compile where valid |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

#### P-012 — `todo` — high

ISCC installer packaging is the DOMINANT Windows-cut cost (~42min/role) and it's compression-setting-bound, NOT CPU-bound — the Windows VM already has 16 cores/32GB (host: 128c/251GB) but papercusp.iss (src-tauri/windows/inno/papercusp.iss:56-58) uses `Compression=lzma2` (high level) with NO explicit `CompressionThreads`, so it LZMA-max-compresses the ~5.7GB/50k-file bundle largely serially. FIX (alpha, NO users → installer download size is a non-issue): set `Compression=lzma2/fast` (or lzma2/normal) + `CompressionThreads=auto` → expected ~42min → ~12-18min, a ~25min/cut win across ALL platforms' Inno/packaging where applicable. MEASURE before/after per D-003 (don't claim the number without it). NOTE SolidCompression=no is already set (per-file, so the pre-compressed seed isn't re-compressed — good; keep it). Do NOT edit papercusp.iss while a cut is reading it. Discovered answering owner's "why so long / can we add VM resources" (2026-07-20): the honest answer is compression settings, not more cores. Pairs with P-011 (server-only skip) → a future Windows Server cut ~90min → ~30min.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Faster linker + release-profile tuning |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/gateway-cache-plane-shared-prefix-ttl-2026-07-19</code> — Gateway cache plane — blanket 1h TTL rewrite + org-shared boot-prefix caching for same-variant sessions — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | avi@storewolf.com |
| Updated | 2026-07-19T14:50:21.114Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-007 — `todo` — normal

Post-DEPLOY fleet measurement: once the emission is live on :3070, re-run the cache-ratio + write-anatomy scripts (su-57b6247d job tmp). Success = subsequent same-cohort sessions show boot READs near the playbook size (not fresh writes), 5m write share ~0%, fleet ratio climbing. Also confirm `boundarySplit` climbing on the live proxy/gateway `/stats`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — shared boot prefix |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/cold-carry-cross-platform-release-testing-2026-07-19</code> — Cold-carry behavior verification on Linux / Windows / macOS release builds — platform-oddity hunt — <strong>11 residual</strong> (11 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | avi@storewolf.com |
| Updated | 2026-07-19T04:10:56.834Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

Run the carry-primitive unit suites (carry-note, carry-doc, carry-brief, loop/checkpoint, facts truncation) on macOS and Windows runners, not just Linux — inventory and fix whatever fails to even execute (path assumptions in test setup count as findings).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — deterministic carry primitives, cross-OS (no full VM drills needed) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

Property tests for the carry-note round-trip under hostile encodings: render→parse identity with CRLF injection, NFC/NFD Unicode, cp1252-unrepresentable characters in claims/rechecks, embedded " — " em-dash sequences inside claim text.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — deterministic carry primitives, cross-OS (no full VM drills needed) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Static audit of client-side carry/cold-wake code for platform coupling: hardcoded `/` joins, `~` expansion, realpath vs resolve mixing (the deploy-verifier bug class), `%APPDATA%` vs `~/.papercusp` config-dir resolution, signal handlers. Fix + regression tests.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — deterministic carry primitives, cross-OS (no full VM drills needed) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

Full carry drill on the installed .deb in a clean VM: seed a session with walls + checks + facts + an armed loop; force a carry-respawn (low compaction-limit override → `session:request-compaction { autoContinue: true }`); assert the successor received the carry doc with walls/checks VERBATIM, provenance stamps intact, and the loop cold-wake reconstructs from `loop:checkpoint`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Linux release build e2e (existing rig: papercusp-desktop/scripts/linux-test-vm, `vmctl install clean <deb>`) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Crash-consistency leg: kill -9 the CLI mid-checkpoint and power-cycle the VM mid-write; assert no corrupt/truncated carry note and that write-through surfaces (facts, work-item checkpoints) survive.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Linux release build e2e (existing rig: papercusp-desktop/scripts/linux-test-vm, `vmctl install clean <deb>`) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — high

Same drill as P-004 on the installed .app, PLUS the credential leg: the carry-respawned CLI must come back AUTHENTICATED (keychain-suffix trap; `CLAUDE_CODE_OAUTH_TOKEN` path) and consume the carry prompt as its first turn. A logged-out respawn is the P0 failure this phase exists to catch.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — macOS release build (Mac VM: papercup-vm-mac, ssh port 2222) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

macOS filesystem oddities: NFD normalization + case-insensitive APFS on carry file paths and `CLAUDE_CONFIG_DIR` resolution; verify sinceMs/ISO timestamps round-trip across TZ changes.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — macOS release build (Mac VM: papercup-vm-mac, ssh port 2222) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — high

Provision a Windows test rig mirroring linux-test-vm ergonomics (local VM or spare machine; scripted install of x64-setup.exe, ssh/WinRM access, snapshot/restore).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Windows release build (no rig exists today — the long pole) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — high

Windows carry drill: P-004 equivalent PLUS spawn/argv quoting of the carry prompt through the respawn, CRLF handling in carry docs, console codepage rendering of `✓`/`?`/`—` anchors, junction fallback where symlink privilege is absent, and taskkill/Ctrl+C flush semantics.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Windows release build (no rig exists today — the long pole) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — normal

Publish a per-platform acceptance matrix (cold-carry invariant × OS) as a rubric + scorecards; wire "green carry drill on all 3 OSes" into the desktop release checklist so a release can't ship dark on carry behavior.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — matrix, gate, and bugs |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — normal

File every platform oddity found as a work item linked to this plan; fixes land upstream (carry-note/psu-launcher), never as platform forks.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — matrix, gate, and bugs |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/desktop-auto-update-operational-2026-07-09</code> — Desktop auto-update fully operational (manifest fixes → proxy → 2-cut E2E on win/mac/linux VMs) — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-17T15:11:48.362Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-3469` [passed] Investigate token source for packaged installs (onboarding GitHub credential / github_pat), GUI-vs-Server product identity, Linux install format (deb vs AppImage) updater realities<br>`WI-3470` [passed] Fix updates-manifest.ts: semver version normalization from desktop-v tags, inline .sig content, product-aware asset filter, proxied download URLs + tests<br>`WI-3471` [passed] Operator asset-download proxy route (streams GitHub API asset with token); wire product param through main.rs resolve_update_endpoint<br>`WI-3472` [passed] release-local.sh updater-artifact completeness: mac .app.tar.gz.sig, Linux AppImage updater lane, latest.json parity, 2GiB asset-cap guard<br>`WI-3473` [passed] Cut desktop-v0.0.4-alpha (WITH_MAC=1 WITH_WINDOWS=1) carrying fixes + latest staging changes<br>`WI-3474` [done] Install 0.0.4-alpha on Windows/Mac/Linux test VMs; verify chip + manifest wiring live<br>`WI-3475` [blocked] Cut desktop-v0.0.5-alpha delta; verify each VM offers, installs, relaunches on the new version<br>`WI-3476` [done] Wind-down: report, file residual follow-ups, assert durable facts |

#### P-007 — `blocked` — high

Cut desktop-v0.0.5-alpha delta; verify each VM offers, installs, relaunches on the new version  (desktop-v0.0.5-alpha cut running bg b1ub65vdr; then pickup verification on 3 VMs) (attempt-4 cut in flight task byv47cqs9; win reused from b0fbf's signed exe, mac reused, linux rebuilding) (← WI-3475 released) (← WI-3475 released) (Win+Linux live-verified 0.0.6→0.0.7; Mac backend-verified but live chip owner-gated mac VM at login screen, stale kcpassword — owner must log in once.) (← WI-3475 released) (← WI-3475 completed deprecated) (← WI-3475 released) (← WI-3475 released) (← WI-3475 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Operational |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/backend-reliability-100pct-2026-07-03</code> — Backend 100% reliable under fleet load — <strong>2 residual</strong> (2 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-17T14:59:23.026Z |
| Now | su-01386 [AUTO, route A]. P-006/W4 DONE+VERIFIED (D-002/D-003): the DBOS routinesTick freeze is PG-POOL STARVATION (the dimension with no shed guard, vs the event-loop dim already covered by loopPressure). Added pool-pressure.ts (pure classifyPoolPressure + fail-soft acquire+SELECT1 poolPressure probe — D-003 pivot since postgres.js 3.4.9 hides pool queue-depth), a symmetric pool shed+counter in routinesTickImpl right after the loopPressure gate, and a cross-process-safe health fold (InfraHealth.pool via timed pgHealth → warn on critical). tsc-clean (0 errors name my files), 286 system-health+dbos tests green, committed → pipelining to :3070. ALSO root-caused+fixed the lint:tsc auto-ratchet flap (scripts/lint-tsc.mjs bare runs no longer ratchet the baseline down — it was false-reddening the gate fleet-wide on the 223↔224 concurrent-edit shuffle; baseline pinned 224). Earlier done: P-001/P-002/P-005/P-007/P-008/P-009/P-010. Engine loop loop:end'd — no eligible work left. |
| Next | NOTHING for su to auto-do: the only open items are P-003 (W1.1 zero-downtime deploy) + P-004 (W5 event-loop scale-out), both HARD-DEFERRED to an owner-attended session (:3170-only, high-stakes, never auto-flip). Owner: pick one up attended when ready, or close the plan. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-1772` [passed] W2 — DONE + LIVE + TESTED (2026-07-03): process-level uncaughtException/unhandledRejection backstop in inference-gateway/bin.ts + guarded the last unguarded pipe gateway.ts:1926 + crash-injection reg…<br>`WI-1773` [passed] W1.2 — DONE (2026-07-03): resilient proxy (:9071) now the default for bare interactive Claude sessions (~/.claude.json papercusp-su :3070->:9071); spawned bees already proxied via PAPERCUSP_MCP_PROXY…<br>`WI-1774` [todo] W1.1 — Zero-downtime :3070 deploy (THE headline): overlap two SO_REUSEPORT cluster generations (boot new gen on same port, health+MCP probe it, drain old) OR rolling worker recycle via the cluster pr…<br>`WI-1775` [blocked] W5 — THE upstream cause of both MCP slowness (class E) and set-status false-timeouts (class F). :3070 is ALREADY clustered (node:cluster + SO_REUSEPORT + per-worker lag self-restart). Profile per-wor…<br>`WI-1776` [passed] W3 — Root-cause the admission-slot / stuck-stream leak that freezes gateway totalRequests (gw-watchdog WEDGE->restart is a mitigation, not a fix). Audit every stream path frees its slot on abort/idle…<br>`WI-1777` [passed] W4 — Root-cause the DBOS routinesTick freeze (~8x Jul 1-2: event-loop block vs PG-pool starvation) that stalls git-sync + all routines. Keep bghost-watchdog as backstop; add a slot/pool assertion.<br>`WI-1778` [passed] W6 — Downstream of W5. dispatch-stack.ts:598-620 records completed idempotent mutations (plans:set-status x280) as spurious 'timeout' under load ('handler returned but signal had aborted') even thoug…<br>`WI-1779` [passed] W8 — Record connection-level MCP failures proxy-side into a durable ledger keyed by client/owner (deploy-window drops are currently INVISIBLE in tool_invocations, so the real failure rate is under-co…<br>`WI-1780` [passed] W7 — Eject an account with a multi-hour retry-after from rotation until its window resets; verify egress transient-failure handling + confirm the full account pool is loaded (dev:rate_governor_status… |

#### P-003 — `todo` — high

W1.1 — Zero-downtime :3070 deploy (THE headline): overlap two SO_REUSEPORT cluster generations (boot new gen on same port, health+MCP probe it, drain old) OR rolling worker recycle via the cluster primary. Today the deploy does a blunt systemctl restart = ~46s full outage x5-9/hr. HIGH-STAKES (a bug breaks EVERY fleet deploy): build behind a flag, verify on :3170/staging, then flip. Guard: deploy gate runs a REAL tools/call (not just /health) through the proxy and fails the deploy on error.  (← WI-1774 released) (← WI-1774 todo) (← WI-1774 released) — note: ← WI-1774 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Zero-downtime deploy |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

W5 — THE upstream cause of both MCP slowness (class E) and set-status false-timeouts (class F). :3070 is ALREADY clustered (node:cluster + SO_REUSEPORT + per-worker lag self-restart). Profile per-worker on-loop consumers under real load (event-loop-lag gauge + 60s cpu-prof), offload heavy per-hop work (worker_threads), tune worker count. Guard: load-rig (N synthetic agents) with an MCP p95-latency + success-rate SLO — reuse the infra-perf round4 rig (iso staging stack, never live :3070).  (← WI-1775 todo) (← WI-1775 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Event-loop scale-out |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/cupboard-app-distribution-2026-07-14</code> — Cupboard app distribution — an "Apps" tab distributing both standalone products (Tauri apps like Oddsmith) and workspace-bundle apps — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw@gmail.com |
| Updated | 2026-07-17T14:07:30.360Z |
| Now | DRAFT — design proposal awaiting owner approval. NO code written yet (plan-first rule: a plan is not approval to build). This plan realizes [owner:Avi 2026-07-14] "combine both approaches, make a way for standalone products to be distributable in the cupboard even if they are separate apps." Grounded against live code: worker listing-kind CHECK lives in `apps/operator-public/migrations/` (six-kind CHECK at 011; a 7th kind = migration 014, CHECK-rebuild precedent 004/006/008/010/011); standalone-app data source = the Tauri updater manifest `latest.json` produced by `@papercusp/tauri-release-kit` (`{ version, platforms: { <os>: { url, signature } }, notes, pub_date }`); the Cupboard UI is `apps/operator/app/cupboard/CupboardClient.tsx` (reused by the shipping operator-vite frontend via `@/app` alias). |
| Next | OWNER (Avi) — approve the design (esp. D-001..D-004 and the three open questions in D-005), then I build Phase 1. Sequencing note: publishing Oddsmith itself as the first app listing (P-007) depends on Oddsmith's standalone Model-A release being live (kit-as-submodule + signing + release channel — see plan `tauri-release-kit-shared-build-2026-06-25`). |
| Live presence | None in final 10-minute window |

#### P-009 — `todo` — normal

(STRETCH, separate initiative — flagged not-in-scope-v1) Plugin-UI / micro-frontend runtime so a bundle app can render its OWN rich screens inside the papercusp shell (today plugins contribute tools + TUI panes, not arbitrary web surfaces). Large architectural lift; spin out to its own plan if pursued.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Bundle apps (install papercusp-native apps into a workspace) |
| `blocked-by` | `P-008` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/ambient-semantic-push-2026-07-14</code> — Ambient semantic push: the agent's turn stream as a standing vector query (coord-layer awareness) — <strong>2 residual</strong> (1 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw8@gmail.com |
| Updated | 2026-07-17T10:29:38.800Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-010 — `blocked` — normal

Cursor match against agent-insights/runbook docs pushes teaser + handle; ships ONLY after matchers 1–3 demonstrate utilization above the eviction bar  (pure core landed under the owner audit/gap-fill directive 2026-07-14; SHIPPING still gated on the item's blockers)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `blocked` |
| Phase | Phase 5 — Matcher 4: insights/runbook suggestions (last — most Clippy-prone) |
| `blocked-by` | `P-005`, `P-007`, `P-009` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Collision acceptance: seeded drill — two sessions steered onto the same bug must both receive the push before either takes a lock; false-positive rate measured on live fleet traffic; thresholds/hysteresis ratified by a human from the dashboard  (machine legs DONE: seeded drill green both sides pushed same-tick on enter, delivered next wake, before either lock-take; live-traffic shadow FP = 0/70 pairs at both 0.4 and 0.30 thresholds. AWAITING OWNER: ratify enterThreshold shipped 0.4-with-idf never enters for realistic wording at small corpus — packet in D-021 + live FP re-measure after cursor flag flip.) (← WI-4952 open)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Matcher 1: peer-cursor collision detection (ships first — the multi-agent-unique value) |
| `blocked-by` | `P-004` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-021` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/local-concurrent-inference-2026-07-02</code> — Local concurrent inference — llama-server behind the gateway now, vLLM/AWQ lane next (many simultaneous local agents) — <strong>4 residual</strong> (3 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-17T07:39:32.390Z |
| Now | Directive core DONE + LIVE (llama-server behind gateway :8788; OMP cut over; pool vLLM/AWQ-ready by design). Hardening lanes DONE: D-010/P-015 (saturation-shed 429+Retry-After + per-client storm circuit) and P-006 (cert battery, lib/inference-gateway/cert-battery — 4 deterministic probes; ran LIVE → ornith CERTIFIED entry #1, 3/3 critical, mangling 0%). Phase-5 packaging largely landed by the fleet: P-010/P-012/P-013 done (packaging decisions; on-demand llama-binary + vLLM-container provisioning), P-011 done — @papercusp/resumable-download (libs/generic/, WI-1616) built + REUSED by llama-binary.ts; its model-weight-fetch wiring is deferred-N/A until a catalog entry carries a direct weights URL+sha256 (ornith resolves GGUF from ollama's blob store per D-007). Provisioner+cert tests green, typecheck clean. |
| Next | No un-gated, non-colliding work left for THIS session — loop ended 2026-07-02. Remaining: (1) P-014 (make recommend.ts read the hardware matrix as single source of truth) is un-gated but overlaps the LIVE wizard agent WI-1598's recommend.ts surface (which I just edited for cert-status) — leaving it to that agent / awaiting owner steer rather than editing the same file concurrently. (2) P-009 wizard runtime = WI-1598's lane. (3) GATED: P-007 (certify more models) GPU-contention-gated on the single 24GB card; P-008 (real vLLM/AWQ run) owner-gated on the GPU/model decision. Fast-follow WI-1659 filed (cert:run/cert:catalog agent-tool). Re-arm the loop or reassign P-014 to me if the owner wants me driving Phase-5 polish. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-1590` [done] Stand up llama-server on the dev box serving the exact ornith GGUF (resolve the blob from ollama's store), OpenAI-compatible /v1, -np 3–4 parallel slots, per-slot num_ctx 32–48K tuned to fit 24GB alo…<br>`WI-1591` [blocked] Point OMP at the new serving path (provider entry for ornith → gateway route per D-002, interim direct llama-server acceptable behind a TODO) + raise the OMP completion first-token client timeout so …<br>`WI-1592` [passed] Re-run the 2-ornith comms probe (ornith-2agent-comms-probe methodology) on the concurrent llama-server — the acceptance test: both agents live simultaneously, no first-token timeout, handoff produced…<br>`WI-1593` [passed] Design + implement the gateway local-backend pool: registry of backends {id, kind: llama-server\|vllm\|ollama, baseUrl, models[], maxConcurrent, health}, OpenAI-compatible proxy route on the papercusp …<br>`WI-1594` [done] Cut OMP/agent model specs over to the gateway route for local models (ornith spec resolves → gateway → llama-server backend); verify failover behavior (kill llama-server mid-session → clean error sur…<br>`WI-1595` [done] Codify the certification battery: single-agent behavior probe + trimmed-shape verification + 2-agent comms probe + mangling-rate metric as a repeatable, scripted battery over (model, quant, num_ctx, …<br>`WI-1596` [done] Certify 1–2 additional models spanning the hardware matrix (a 7–14B GGUF for smaller GPUs / Mac Metal lane) so the catalog demonstrates the range, not just the flagship.<br>`WI-1597` [blocked] Stand up vLLM serving an AWQ/GPTQ requant of the ornith base (or an alternate certified model if no clean requant exists), register it as a second gateway backend, run the same certification battery,…<br>`WI-1598` [done] Provisioner wizard: first-run hardware detection (GPU vendor/VRAM/OS) → recommend a certified combo from the catalog → download weights + install/configure backend → register in the gateway pool. Des…<br>`WI-1599` [done] Packaging decisions for release: OMP bundled in installer; llama-server binary bundling vs on-demand fetch per platform; vLLM via container/managed install; model downloads with resume + checksum; do… |

#### P-008 — `blocked` — normal

Stand up vLLM serving an AWQ/GPTQ requant of the ornith base (or an alternate certified model if no clean requant exists), register it as a second gateway backend, run the same certification battery, and compare concurrency/throughput vs llama-server on the same card. Success criterion: zero gateway-code changes beyond the registry entry (D-002 proven). (← WI-1597 released)  (Owner-gated: vLLM/AWQ backend needs a GPU/model provisioning decision D-008 held it back for single-24GB-GPU contention. Pool is vLLM-ready by design one registry INSERT.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 4 — vLLM/AWQ lane (validates the D-002 abstraction) |
| `blocked-by` | `P-004` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002`, `D-008` |
| Linked work-items | None |

#### P-002 — `todo` — high

Point OMP at the new serving path (provider entry for ornith → gateway route per D-002, interim direct llama-server acceptable behind a TODO) + raise the OMP completion first-token client timeout so a queued request waits instead of erroring (D-003).  (Interim route LIVE: OMP :11435 schema-proxy upstream repointed 11434→11436 llama-server, end-to-end completion verified; models.json ornith contextWindow fixed 262144→24576 real slot size + dead ollama discovery block removed. REMAINING: gateway route per D-002 Phase 2 + first-token timeout raise may be moot with true parallelism — measure in P-003.) (← WI-1591 released) (Subsumed by P-005 OMP cut over to :8788/v1 gateway route, verified + first-token-timeout raise moot per P-003 zero context-exceeded errors under true parallelism.) (← WI-1591 released) (← WI-1591 released) (← WI-1591 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — llama-server serving + prove concurrency (this week) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002`, `D-003` |
| Linked work-items | None |

#### P-009 — `todo` — normal

Provisioner wizard: first-run hardware detection (GPU vendor/VRAM/OS) → recommend a certified combo from the catalog → download weights + install/configure backend → register in the gateway pool. Desktop UI + headless CLI path.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — provisioner wizard + public-release packaging (D-006) |
| `blocked-by` | `P-006` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `todo` — normal

Publish the hardware support matrix from D-009 (NVIDIA>=24GB / smaller NVIDIA / Mac Metal / CPU / no-GPU-to-cloud) in /internal/docs, and wire the provisioner wizard's hardware-detection → recommendation step to read it as its source of truth rather than hardcoding the table twice.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — provisioner wizard + public-release packaging (D-006) |
| `blocked-by` | `P-010` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-009` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/papercup-physical-rename-phase5-2026-06-20</code> — papercup→papercusp Phase 5: physical rename (repo dir, package, schema, services) — <strong>2 residual</strong> (1 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-17T07:26:15.046Z |
| Now | Brief 11 is ~done in code; only the deploy-staged irreversible TRIO remains, needing ONE owner-run quiescent window. su-fd4faac9 (2026-06-24, autonomous, D-002): P-005 code constants COMPLETE (0 literal PAPERCUP_ROOT/PAPERCUP_HARNESS_SLUG/register-papercup/live-papercup_shared refs in code); fixed the D-001-missed codemod file embedded-postgres-server/src/index.js (papercup_shared→papercusp_shared — REQUIRED before CONTRACT, else fresh embedded installs publish 0 message tables). **P-009 CONTRACT replication gate CLEARED:** 0 pubs/slots/subs, papercup_shared=6 views only, 0 deps, 0 live refs; pg-tunnel :5433 is an SSH REVERSE tunnel (no active logical repl) → DROP SCHEMA is inert. Staged CONTRACT migration (394) + full ordered window runbook in HANDOFF-papercup-rename-window-runbook-2026-06-24.md (repo root). git-sync 'auto-commit papercup' label is ${slug}-derived from the repo-dir → auto-flips on P-007. |
| Next | OWNER: run ONE quiescent window per the handoff — Step A place+apply migration 394 via db:migrate → Step B repo-dir mv+symlink (P-007) → Step C systemd rename, dev-api LAST (P-008). All safe/reversible code already landed; only the irreversible trio remains (NOT auto-executed overnight — owner-gated). |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-327` [deprecated] Rename the repo DIRECTORY papercup→papercusp (highest blast radius: absolute paths, systemd WorkingDirectory, both .env.local files, integration+release+checkpoint trees, git-sync resolveHarnessConte…<br>`WI-328` [dropped] Rename PG schema papercup_shared → papercusp_shared (a migration + ~50 SQL files + Zero publication + every search_path/test-fixture ref). Data-bearing → backup + dry-run first.<br>`WI-329` [done] DS-1 SCHEMA rename papercup_shared→papercusp_shared via EXPAND/CONTRACT (both trees share one DB; a bare rename breaks release-tree dev-api). (1) EXPAND migration: ALTER SCHEMA papercup_shared RENAME…<br>`WI-354` [dropped] Rename systemd services papercup-* → papercusp-* (bg-host, dev-api, staging-api, inference-gateway, pg-tunnel, vm-mac unit files + all references/aliases).<br>`WI-355` [done] Rename code constants: register-papercup.ts→register-papercusp.ts, PAPERCUP_HARNESS_SLUG→PAPERCUSP_HARNESS_SLUG, build PAPERCUP_ROOT→PAPERCUSP_ROOT, seed-learning-singletons.ts 5 legacy refs, + the g…<br>`WI-356` [blocked] Rename monorepo @papercupai/papercup-monorepo + verification gate: grep the tree for zero remaining physical 'papercup' refs (excluding intentional history/migration artifacts); full suite green.<br>`WI-357` [todo] DS-3 SERVICE rename systemd papercup-*→papercusp-* (papercup-bg-host, dev-api, staging-api, inference-gateway, pg-tunnel, vm-mac + their *-watchdog units). For each: create the papercusp-* unit (copy…<br>`WI-380` [done] DS-2 REPO DIR rename papercup→papercusp via SYMLINK BRIDGE (deploy-staged). (1) mv …papercupai-workspace/papercup …/papercusp + ln -s papercusp papercup — non-breaking: every absolute path + running … |

#### P-006 — `blocked` — normal

Rename monorepo @papercupai/papercup-monorepo + verification gate: grep the tree for zero remaining physical 'papercup' refs (excluding intentional history/migration artifacts); full suite green.  (gate blocked-by owner-gated P-008/P-009 window; see D-004) (← WI-356 released) (← WI-356 released) (← WI-356 released) (← WI-356 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — Physical rename |
| `blocked-by` | `P-008`, `P-009` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

#### P-008 — `todo` — normal

DS-3 SERVICE rename systemd papercup-*→papercusp-* (papercup-bg-host, dev-api, staging-api, inference-gateway, pg-tunnel, vm-mac + their *-watchdog units). For each: create the papercusp-* unit (copy content, update Description + any WorkingDirectory/path), `systemctl --user disable` the old + `enable` the new, migrate the watchdog target refs, daemon-reload, restart. Coordinate with DS-2 (the units' WorkingDirectory references the repo dir). Sequence dev-api LAST (its restart bounces the operator API / MCP). Verify: all services active under the new names + healthy (:3070 responds, bg-host routines firing, git-sync committing). (← WI-357 released) (Owner-gated: needs a coordinated quiescent window dev-api/inference-gateway/bg-host restarts bounce the whole live fleet. Not auto-executable. See WI-357 thread + HANDOFF runbook.) (← WI-357 released) (← WI-357 todo) (← WI-357 released) (← WI-357 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Deploy-staged rollout |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/work-item-deps-and-readiness-2026-06-22</code> — Work-item dependency model + maintained readiness (+ owner-gated work-item unification) — the data-model foundation under the scheduler + cache — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw@gmail.com |
| Updated | 2026-07-17T04:29:04.457Z |
| Now | BOTH MANDATE TASKS COMPLETE (autonomous), thoroughly tested. Unification P-010: 374+375, all tiers green, pull-schema synced. Scheduler verified (55 green). The 375 CDC capture is now COMPREHENSIVELY covered — work-items-cdc-capture.integration.test.ts 6/6: feature routing, harness-issue routing + ei wire-shape, operator-no-hive->local, operator-with-hive->home-slug (operator-scope federation VERIFIED not degraded), convergence guard (UPDATE re-federates only on a federated-field change), echo-loop guard. Straggler sweep clean. issues-engineer 8 coord fails = pre-existing runtime bug in the recently-changed engine (NOT the unification), deeply diagnosed + escalated to the coord owner. |
| Next | AUTONOMOUS WORK COMPLETE. Remaining is owner/coord-owner-gated: (1) OWNER decide work_items PK workspace-scoping scheme (sentinel 'operator:'+ws keeping the PK, OR add workspace_id to the PK with FK changes) — latent cross-workspace operator-issue collision; it is a design choice so I did NOT pick one unilaterally. (2) COORD OWNER runtime-debug the issues-engineer coord fan-out (blocks the green gate; out of mandate). (3) green-gated deploy once (1)+(2) land. Optional: delete the now-fully-redundant green-but-obsolete engineer-issues-federation-trigger + substrate-outbox-trigger (375 issue capture is covered by CDC 6/6 + 4 federation round-trips). |
| Live presence | None in final 10-minute window |

#### P-010 — `needs-human` — high

[OWNER-ATTENDED / NEEDS-HUMAN] Unify harness_features_consolidated + engineer_issues into ONE work_items base table (kind discriminator + payload). KEEP F-NNN/EI-NNN ids stable + satellite tables feature-keyed (no destructive re-id -> avoids the DBOS pipeline-id drain). One RLS posture: keep BYPASSRLS + in-query workspace filter (F7 — issues deliberately have no RLS). Migrate federation capture triggers, hyperbee CDC mappers + the 2 projection registrants. HIGH blast radius (federation/RLS/every reader) — owner runs the cutover; the seam means the scheduler/cache don't block on it.  (Unification PHYSICALLY LANDED work_items base table + engineer_issues/harness_features_consolidated views live on dev; the scheduler/claim/readiness/cache all run on it. The two remaining gates are NOT safely completable unattended: 1 DEPLOY to :3070 is BLOCKED on EI-2760 — the issues-engineer fan-out coord-engine regression fanoutForObject A6 resolves subscribers from a different store than callers seed; 8 integration fails block the green-checkpoint for the WHOLE fleet. Root-caused + filed for the coord owner; it's a coord-refactor design call, not a guess-fix, and outside the scheduler/work-items area. 2 PK workspace-scoping: RECOMMEND the sentinel scheme harness_slug 'operator:'+ws for operator issues, D-005's lower-risk option — but the collision is LATENT verified 0 colliding operator issues live, so it is NOT urgent, and re-keying the operator-issue id-space + the engineer_issues view + every reader/federation path is the exact HIGH-BLAST-RADIUS change the plan mark…) (← WI-453 released) (← WI-453 open)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 4 — Work-item unification (OWNER-ATTENDED) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/learning-tab-alignment-2026-07-13</code> — Learning tab → align the UI with how the learning system actually works [owner:Avi 2026-07-13] — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-13T05:07:04.519Z |
| Now | ACTIVE, su-eb9b7 solo [owner:Avi 2026-07-13 route-0 start-to-finish, AUTO]. P-001..P-004 + P-006 DONE, all live-verified in the Tauri webview (P-004 trace: 5 stages, titled grounding chips, toggle round-trip; P-006: question headers + 'Pot scoring'). WI-4497 side-lane CLOSED: blender-release-readiness ACTIVE with first true split provenance (proposedBy=f69a7, ratifiedBy=eb9b7). |
| Next | P-005 (rubrics governance UI) deliberately SEQUENCED AFTER 6cfba's learning→knowledge-packs rename (cupboard-public-release P-001) so it builds on the renamed surface — 6cfba awaits gate plan:learning-tab-alignment-2026-07-13:learning-tab-edits-done, which fires once test:affected confirms no more edits needed. EI-10751 fix already live on :3070, so rubrics:get provenance fields are available whenever P-005 starts. |
| Live presence | None in final 10-minute window |

#### P-005 — `blocked` — normal

Rubrics governance visibility: proposed-vs-active prominence + proposer/ratifier provenance. blocked-by: EI-10751 (Deliberately sequenced AFTER 6cfba's learning→knowledge-packs rename agreed msg mriqrv5m — builds on the renamed surface. Unblocker EI-10751 already live on :3070.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/memory-recall-age-ab-benchmark-2026-07-11</code> — Fair A/B benchmark: memory recall on real corpus/queries — current stack vs AGE-augmented retrieval — <strong>8 residual</strong> (2 todo, 6 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw@gmail.com |
| Updated | 2026-07-12T14:08:56.791Z |
| Now | RESUMED 2026-07-12 (owner retracted the deferral: "resume the age a/b benchmark... figure that out first"). The 2026-07-11 REJECT verdict is ON HOLD: WI-4028 diagnosis found the multi-scope lanes (structural + lane1) compared A and B on UNEQUAL result-set sizes (limit is per-scope: A scored on ~40 hits, B truncated to 10) and the original fusion had the additive score-scale bug. Fixes applied 2026-07-12: fairTopK global top-10 for BOTH systems in bench-run.mts; system-b.mts RRF raw leg now ranks seeds by score (w=0 identity). Fair re-run IN FLIGHT (rerun-fair.sh, bg): gold w=0 validation gate → gold sweep .15/.3/.5/.8 → structural sweep → lane1 @ .15; outputs results/*.rrf*. P-006/P-010/P-011/P-013 reopened wip, claimed su-efc531fb. Gold lane from the old run remains valid evidence of the score-scale bug only. |
| Next | When rerun-fair.sh completes: verify the w=0 identity PASSed, tabulate the .rrf sweep numbers, rewrite REPORT.md, re-issue the verdict against pre-registered D-001, update fact age-ab-benchmark-verdict + memory, close P-010/P-011/P-013 (su-efc531fb). |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — normal

Verify gate: entity-link backfill drained over the ~8.8k existing memories (system B's graph edges come from these links; an empty graph benchmarks nothing)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 0 — gates (external prerequisites) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — normal

Corpus snapshot: freeze memory_canonical (~8.8k rows) + entity rows + harrier vectors into a benchmark schema/dump; record row counts + a content checksum so both systems provably index identical data

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — frozen fixture |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — normal

AGE graph mirror: load the snapshot into an AGE graph (memory + entity nodes; entity-link / supersession / cross-reference edges), reusing the age-spike loader; verify node/edge counts reconcile against the source snapshot

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — frozen fixture |
| `blocked-by` | `P-003` |
| Unresolved blockers | `P-003` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — normal

Build system B retrieval path: identical semantic+BM25 seeds (read the same snapshot vectors) → 1–2-hop AGE expansion → single re-rank; feature-flagged, never on the live write path

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — system B + calibration |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

Equal-budget calibration: tune thresholds/hop-depth for BOTH systems on a held-out split (or neither); freeze both configs + the D-001 rule BEFORE the measured run

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — system B + calibration |
| `blocked-by` | `P-007`, `P-008` |
| Unresolved blockers | `P-007`, `P-008` |
| Open issue blockers | — |
| Decisions | `D-001` |
| Linked work-items | None |

#### P-012 — `blocked` — normal

Operational cost: write-path overhead per memory:remember to keep the graph in sync, disk/RAM delta, backup-size delta — the price system B pays forever, which toy benchmarks skip

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — run, measure, decide |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — normal

Verify gate: harrier embeddings LIVE in production (shared-embedding-sidecar-and-enrichment-2026-07-10 P-015 done: deploy shipped, workspace pref flipped, canary row in memory_vec_harrier, delta re-embed complete)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — gates (external prerequisites) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Blind pooled judging harness: pool both systems' top-k per query, shuffle, Haiku judge scores graded relevance (0–2) without knowing which system returned what (TREC pooling); hand spot-check a 5% sample

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — query sets + ground truth |
| `blocked-by` | `P-005` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/memory-temporal-lite-validity-windows-2026-07-11</code> — Temporal-lite memory: validity windows + supersession on the canonical store (roll-own, Graphiti-schema-inspired) — <strong>3 residual</strong> (3 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-12T14:08:49.557Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-005 — `todo` — normal

Conflict-check upgrade (P-017 integration): when checkConflicts finds a direct contradiction, the refusal envelope now offers the one-call resolution — `{reason:'conflict', resolution_hint: 'pass supersede:<id> to record the new fact as replacing the old one'}` — and remember accepts `supersede:<id>` to invalidate-and-write atomically.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — write-path semantics |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Rendering + recall fold: orient/brief memory folds annotate superseded hits (only shown under include_superseded) with "[SUPERSEDED <date>]"; agent guidance text on when to supersede vs update vs forget.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — read-path semantics |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — normal

Docs: agent-insights page (temporal semantics, point-in-time queries, supersession discipline) + memory tool guidance strings.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — verification + docs |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/gitpulse-build-2026-07-05</code> — gitpulse — self-contained git analytics CLI (fleet build) — <strong>4 residual</strong> (4 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-10T04:23:32.251Z |
| Now | Launching a 4-member Sonnet-5 desktop fleet. Lane D scaffolds first (package.json, tsconfig, src/types.ts), then A/B/C run in parallel against the shared contracts, and Lane D integrates the CLI + e2e last. Leader su-6ebaf monitors in AUTO via an armed loop and reviews diffs. |
| Next | each member claims a lane (A/B/C/D), `coord:declare-intent`, and begins — Lane D posts "scaffold ready" to unblock A/B/C. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

Lane D — SCAFFOLD FIRST, INTEGRATE LAST. Owns package.json, tsconfig.json, src/types.ts, src/cli.ts, src/index.ts, README.md, test/e2e/*, test/fixture-repo builder. FIRST: scaffold package.json (bin `gitpulse`, scripts build/test/dev, dev-deps only: typescript/vitest/@types/node/tsx), strict isolated tsconfig.json, src/types.ts with the shared contracts (Commit/DayBucket/AuthorStat/ChurnFile/RepoStats), and a test/fixture-repo builder helper — then coord:send su-6ebaf 'scaffold ready' to unblock A/B/C. LAST: wire cli.ts (`gitpulse [path] [--since 90d] [--until] [--html <file>] [--json]` → collect→analyze→render), README with usage, and an e2e test that runs the built CLI against the papercup repo and asserts exit 0 + a heatmap + a valid self-contained HTML file. Done: `npm run build && npm test` green.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Build |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

Lane A — git data layer. Owns src/git/*. Implement `collect(repoPath, {since?,until?}): Promise<Commit[]>` — spawn `git log` with a stable machine-readable pretty-format + --numstat, parse into typed Commit[]. Handle merges, binary files (`-` numstat), renames, empty repos, and since/until windows (accept `90d`/`2026-01-01` → git --since). No business logic — faithful extraction only. Done: unit tests (against a temp/fixture repo) assert commit count, author, numstat parsing; binary + merge + rename cases covered. Depends on Lane D's src/types.ts scaffold.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Build |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — high

Lane B — aggregation engine (PURE). Owns src/stats/*. Implement `analyze(commits: Commit[], range): RepoStats` computing every RepoStats field: zero-filled daily buckets across the range (heatmap), per-author totals sorted desc, top-N churn files, current + longest daily-commit streak, weekday + hour histograms. Pure (no I/O). Done: unit tests with synthesized Commit[] fixtures assert each stat, incl. empty-input and a streak spanning a gap. Depends on Lane D's src/types.ts scaffold.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Build |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

Lane C — renderers. Owns src/render/*. Two renderers off RepoStats: (a) renderTerminal(stats): string — ANSI contribution heatmap (weeks × 7 weekdays, 5 intensity levels via block glyphs + 256-color) + aligned author/churn tables; (b) renderHtml(stats): string — a FULLY self-contained HTML report (inline <style>, no external assets): contribution heatmap (one sequential hue, light→dark), stat tiles (commits/authors/insertions+deletions/longest streak), author table, churn list, light+dark via prefers-color-scheme. Done: snapshot tests assert 7 heatmap rows in terminal output and the HTML contains the tiles + one cell per day and no external http/src refs. Depends on Lane D's src/types.ts scaffold.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Build |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>dummy-pot-0707/dummy-readme-lines-0707-2026-07-08</code> — Dummy README lines (WI-3329 E2E) — <strong>2 residual</strong> (2 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-08T02:06:46.786Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

Add a first line under the `## Log` heading in README.md (e.g. `- line one`).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Add a second line under the `## Log` heading in README.md (e.g. `- line two`).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>oddsmith-hive/venue-and-evidence-integration-2026-06-25</code> — Integrate new prediction-market venues + evidence/data sources — <strong>2 residual</strong> (2 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-05T16:13:07.565Z |
| Now | Phase-1 (free/clean) + most Phase-2 read-path venues shipped (Kalshi/Polymarket/Manifold/Limitless/Myriad/SXBet + BLS/BEA/Adjacent/GDELT/Bluesky/PredictIt evidence adapters). Legal gate P-007 cleared 2026-06-29 (all work still PAPER). P-010 Novig + P-011 ProphetX — the two partner-gated CFTC exchange connectors — are now BUILT TO THE CREDENTIAL WALL (D-001): keyless-inert full TradingConnectors mapped to @oddsmith/contracts, 28+29 unit tests + typecheck green, creds-gated live tests, per-package CREDS-NEEDED.md, 'novig'/'prophetx' added to Venue + migration 023. Both stay BLOCKED (not done) — cannot live-verify without keys. |
| Next | OWNER decision: to complete P-010/P-011, obtain partner/MM creds — Novig NOVIG_CLIENT_ID + NOVIG_CLIENT_SECRET (EMM program) and ProphetX PROPHETX_ACCESS_KEY + PROPHETX_SECRET_KEY (partner program); set the env vars and the creds-gated live tests light up. Absent keys, the venue-connector wave is complete to the wall and P-012 Drift + P-013 Metaculus remain the only other deferred (also key/SDK-gated) items. |
| Live presence | None in final 10-minute window |

#### P-010 — `blocked` — high

Novig connector (CFTC DCM sports exchange): full REST+WS+GraphQL order API + real QA sandbox; ~$300M/mo. Requires Novig-issued partner/MM creds. CFTC-blessed.  (Novig BLOCKED: partner/MM-gated OAuth creds required for the API owner must obtain. Skipped per owner 'no keys'.) (← WI-1369 resolved) (SCAFFOLD LANDED to credential wall Lane B, su-d75d4: new @oddsmith/connector-novig — full TradingConnector markets/orderbook/positions/fills/balance + place/cancel mapped to contracts; partner OAuth2 client-credentials token seam keyless-inert; decimal-probability→Micros; composite marketId:outcomeId ticker. 28 unit tests + typecheck green; creds-gated live.test.ts skips w/o keys; CREDS-NEEDED.md. 'novig' added to Venue/VENUES + migration 023 widens venue CHECK. BLOCKED ONLY on owner creds: NOVIG_CLIENT_ID + NOVIG_CLIENT_SECRET Novig partner/MM EMM-API program access.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 2 — CFTC/on-chain venues (gated on legal + budget review) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `blocked` — normal

ProphetX connector (CFTC DCM+DCO sports): full partner trading API + api-ss-sandbox; options-MM-backed. Partner-gated session-token auth. (ProphetX BLOCKED: partner-gated session-token creds required owner must obtain. Skipped per owner 'no keys'.) (SCAFFOLD LANDED to credential wall Lane B, su-d75d4: new @oddsmith/connector-prophetx — TradingConnector discovery/place_wager/cancel_wager/balance mapped to contracts; American-odds↔Micros + ladder snap; session-token auth login+refresh, keyless-inert; composite eventId:lineId ticker. 29 unit tests + typecheck green; creds-gated live.test.ts; CREDS-NEEDED.md. 'prophetx' added to Venue/VENUES + migration 023. Positions/fills + book depth are Pusher-WS documented follow-up. BLOCKED ONLY on owner creds: PROPHETX_ACCESS_KEY + PROPHETX_SECRET_KEY ProphetX partner/MM program access.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 2 — CFTC/on-chain venues (gated on legal + budget review) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/windows-desktop-release-readiness-2026-06-11</code> — Windows desktop release readiness — build, package, E2E-verify, publish — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw6@gmail.com |
| Updated | 2026-07-05T09:00:02.351Z |
| Now | Windows desktop rebuild of the CURRENT staging tip 31d1787 (post pot-rename + seed-bundle wiring), built 2026-07-05 04:35, is VALIDATED HEADLESS-GREEN on the QEMU Win VM (WI-2908): vm-smoke-windows.sh ALL 9 GREEN (operator :17384 health 200 stable, backups+kopia, agent-tools loopback, 0 PG ERROR, psu shim); clean cold-install onboarding (procs=2 no-cascade, WSL papercup-runtime Running, single finalize restart, no lc_messages/PG/120s FATAL); CDP render clean with 0 console errors and pot-rename labels live (Mug/Kettle/Papercup/Pots); no regression vs 0.0.2. Confirmed: operator/PG/backups/agent-tools/psu come up FULLY HEADLESS — only the P2P dogfood-hive JOIN (webview gh-signin) is owner-gated. ALL HEADLESS RELEASE ITEMS ARE GREEN. What remains for PUBLIC release is owner-walls ONLY. |
| Next | OWNER actions (4, all owner-walled): (1) provide an Authenticode code-signing cert (D-004) — the hard gate for public distribution / SmartScreen; (2) P-011: in-VM GitHub sign-in + Anthropic credential + one live agent turn to complete the hive-join + live proof; (3) cut a real seed on the owner box (live epoch keychain); (4) decide gh-signin-optional (a1a71 raised it). Agent headless work is complete — loop ended. |
| Live presence | None in final 10-minute window |

#### P-011 — `needs-human` — normal

Functional smoke checklist in the VM: wizard completion, create pot + harness, one live agent turn (needs an Anthropic credential in-VM — owner to provide/approve), terminal NewWindow via wt.exe, basic UI navigation. Adapt /internal/docs/testing/agent-e2e where the bridge works on Windows; manual + spice screenshots acceptable for v1 where it doesn't. (agent half DONE API smoke, live click-through drove the P-021 fixes, new-UI CDP verification on the shipped build; owner half = sign-in manual path: wsl -d papercup-runtime → claude /login + wizard completion + one live agent turn needs P-019 credential) (Owner queued 2026-06-12: will run the manual sign-in path in the VM soon wsl -d papercup-runtime → claude /login → wizard + one live agent turn. Agent half already done.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 2 — first-run E2E + fix loop (in the VM) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/modes-and-intake-ux-2026-07-05</code> — Modes & intake UX — official modes (definetool + presence), grade mode, smell-triggered feature offers, new-project intake, drain kickoff, work_items:park — <strong>12 residual</strong> (8 todo, 4 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | avi@storewolf.com |
| Updated | 2026-07-05T06:16:15.272Z |
| Now | IMPLEMENTED end-to-end by su-36dab (owner-ratified, AUTO). Shipped: migration 500 (agent_modes + audit, applied+recorded), mode registry/store (axes CORRECTED per owner: only auto\|cold-auto exclusive; ideate/drain/grade = stackable overlays, D-008), mode:list/get/set tools (auto-switch, owner-sticky, peer delivery w/ contract), presence modes[] + orient contract re-injection, work_items:park, both su playbooks (mode index + recognizer offers + new-project intake, no budget Q), grade mode, tutorial + session-modes docs. Tests: modes 12/12, tools-md-sync 54/54, tutorial-pack 16/16, coordination shapes green, live PG smoke green, test:affected 484/485→statusline-fleet stale expectations aligned to the ratified chip format (peer change) → 26/26. P-010 llm-tests dropped (owner). |
| Next | Remaining: the low-priority context-diet deletion follow-up (legacy per-mode prose out of personas once the rail is live + adopted — new item). Rail goes live on the next deploy (green gate recovered); then sessions should start declaring modes via mode:set. |
| Live presence | None in final 10-minute window |

#### P-006 — `blocked` — high

mode:list / mode:get / mode:set defineTools. mode:list = the cheap index (each mode: name + one-line when-to-use). mode:set { mode, agent?, reason } — self OR another agent; reason MANDATORY and delivered to the target as a coord message; effect lands at the target's NEXT turn boundary (injected like a wake directive — never mid-turn); every change writes a mode_changes audit row; rate-limited so two agents cannot mode-war; OWNER-STICKY carve-out (D-003): a peer cannot override an owner-set mode — it becomes a request the owner/target sees. Chat-surface allowedTools wiring + P-011 prompt-weight budget respected.  ()

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Modes as first-class data (owner ideas #5–#7) |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-007 — `blocked` — normal

Presence surfacing: coord:presence + coord:orient agent rows carry `mode`; fleet/status and the presence UI show it. Acceptance: two live sessions can each see the other's mode in one orient round-trip. ()

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Modes as first-class data (owner ideas #5–#7) |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — high

Context diet (owner idea #7): the always-present prompt carries ONLY the mode index (~one line per mode, part of the stripped-mode important set); the FULL mode contract is injected into the session's next wake prompt when mode:set lands (the work-item-checkpoint re-injection pattern). Then DELETE the per-mode paragraphs from the initial prompts — net initial-context SHRINKS. Acceptance: rendered launch context diff shows the reduction; a mode:set demonstrably injects the full contract next wake.  ()

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Modes as first-class data (owner ideas #5–#7) |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

Grade mode (owner idea #5) — first NEW mode shipped on the official rail: entering it, the agent (1) rubrics:search FIRST and reuses an applicable rubric — proposing a new one (through ratification) ONLY on a real gap, to prevent rubric proliferation; (2) arms a loop whose wakes gather evidence → emit a scorecard (improvements:capture w/ rubricRef + per-criterion ratings + evidence) → read rubrics:trend; (3) prefers deterministic evidence (dev:pg_query / counters) over per-wake LLM judgment — the scorecard-pulse lesson: the cheapest grading is compute, not inference; (4) takes cadence + exit criteria from the user at entry. ()

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Modes as first-class data (owner ideas #5–#7) |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

New-project intake prompt (owner idea #2): a section in the su playbooks + operator persona SOURCES (never rendered outputs) triggered whenever the user is EMBARKING on a new project — not only an explicit "create a pot/hive" ask. Questions, in order: (1) "What kind of pot?" — list installed launchable blueprints LIVE via blueprint:catalog (never hardcoded), offer Cupboard search as the alternative; (2) "Want to use an app template?" — list installed templates + the Cupboard Templates section, ALWAYS labeled "(not ready yet — in development)" while the P-011 materializer in app-templates-2026-07-04 remains unshipped; (3) repo: existing / fresh / repo-less; (4) autonomy level: manual / supervised / auto (seeds wake schedule + queen-autonomy defaults); (5) name + one-line goal (seeds hive steering). NO budget/model-tier question (D-002). ≤5 questions total, skip always honored. After edit: tools-md-sync + llm-test su target.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Prompt-side UX (no schema changes; in-session work, token-freeze-safe) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

#### P-002 — `todo` — high

Mode/feature recognizer table (owner idea #3): one smell→offer table in the shared persona base — user ask smells like a mode/feature ⇒ name it, one-line pitch, ask opt-in; "no, just do it" is respected without re-offering. Rows: Auto Mode, Cold Auto, Ideate, Drain (owner's list) + Loops (periodic re-check ≠ auto), scheduled plans/routines (wall-clock recurrence), watches/events:await ("tell me when X"), deliberate/vote ("second opinion / decide between"), work-item redundancy ("N agents independently"), research harness ("research thoroughly"), rubric/scorecard + grade mode ("how is X doing / monitor quality"), fleets ("work in parallel"), plans ("make a plan"), and the P-001 intake (new-project smell). Keep each row ONE line — this table is always-present context; depth stays behind the offer.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Prompt-side UX (no schema changes; in-session work, token-freeze-safe) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Drain-mode kickoff question (owner idea #4): on entering drain mode, query the live queue (work_items:completion_stats + a pile/age breakdown) and ask which pile to drain, with concrete context-derived examples ("9 stale 'Loop iteration' items, 2 canary items — a kind, a harness, oldest-first, or everything?"). One paragraph in the drain-mode prompt section; examples ALWAYS from live data.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Prompt-side UX (no schema changes; in-session work, token-freeze-safe) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

work_items:park { id, checkpoint, reason } composite defineTool: atomically work_items:checkpoint + release the claim + a one-line coord note; item state stays todo (or blocked with reason). Formalizes the observed "parked with a complete resume checkpoint" prose into a named, countable primitive (the neologism-miner pattern: recurring vocabulary → primitive). Includes guidance (when/notWhen: park = deliberate shelving to resume later; NOT done, NOT blocked-on-dependency), unit tests, tools-md-sync green, and a persona vocabulary line ("to shelve work resumable: work_items:park").

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — The park verb (owner idea #0) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — high

Schema: mode as declared state on the coord presence/session row (PG per storage policy; migration via node scripts/next-migration.mjs — atomic allocator, never ls-by-eye) + a mode_changes audit table (who, whom, from→to, reason, ts). PREREQ: read /internal/docs/design + /internal/docs/system/storage-policy before writing the migration.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Modes as first-class data (owner ideas #5–#7) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — normal

Tutorial + docs update for the new mode system (owner amendment #2, 2026-07-05): rewrite tutorial ch2/05-modes.md (add GRADE mode, the axes model — autonomy \| work-source \| overlays, cross-axis stacking, same-axis auto-switch — and that modes are now OFFICIAL: set via mode:set, visible in peer presence, auditable); update the onboarding-tutor.md curriculum ⑨ line; update the /internal/docs agents/session-modes page with the axes table + grade mode + the mode:* tooling. tutorial-pack tests green after.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Modes as first-class data (owner ideas #5–#7) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `todo` — low

Context-diet FOLLOW-UP (the deletion half of P-008): once the mode:set rail is DEPLOYED and sessions actually set mode rows (verify agent_modes has live traffic), delete the legacy per-mode prose from the persona/playbook sources so the initial context shrinks net (the index + orient-injection replace it). Deliberately deferred: removing the prose before the rail is live would leave sessions with no mode semantics at all (orient injects contracts only when a mode row exists).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Modes as first-class data (owner ideas #5–#7) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `todo` — normal

Fleet-first rule (owner directive 2026-07-05 #3): agents reaching for client-native workflows/subagents (Workflow tool, Agent fan-outs, ultracode swarms) to parallelize REAL work must STOP and ask the user whether to launch a FLEET instead (fleet:create → launch-on-plan, claim-spec fed) — fleets are observable/coordinated/durable; native swarms are invisible to the coordination layer. Native subagents stay fine for small bounded reads. Shipped in BOTH su playbooks; tools-md-sync 54/54.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Prompt-side UX (no schema changes; in-session work, token-freeze-safe) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/loop-routines-interval-recurrence-2026-06-20</code> — Interval-recurring routines — engine-managed loops + scale to hundreds — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-04T19:59:32.730Z |
| Now | Phase A (the loop primitive) is BUILT + SHIPPED to staging via briefs B-LOOP-1..5 (commit @7cd17c863; engine re-verified GREEN post the papercup->papercusp rename — B-LOOP-FIN-3). As-built follows the REVISED warm-coord-wake design (scratch loop-plan-revision-2026-06-20.md), which SUPERSEDED this plan's original plan_runs.finished_at model: a loop re-fires a WARM coord wake to a pinned su session N sec after the previous turn settles (not a fresh plan_run). Built: reschedule_interval_sec + target_owner_id (mig 323) + claimDueRoutine infinity-park (B-LOOP-1); completion-rebase (B-LOOP-2); warm-wake fire + cost-cap (B-LOOP-3); atomic work_items:create assign_to (B-LOOP-4); loop:arm/end/status verbs + prompt-sweep (B-LOOP-5 + FIN-1). FIN-2 (warm-loop e2e) in-flight by a peer. Phase B/C (scale to hundreds, P-004/005/006) DEFERRED — demand-gated. NOTE: P-001..P-006 item text is the SUPERSEDED finished_at model; as-built mechanism revised to warm-coord-wake (deliverables map; mechanism differs). |
| Next | Deploy-verify (B-LOOP-FIN-3 task 3): when the deploy gate clears, confirm mig 323 boot-applies + the loop engine + arm/end/status verbs go live on :3070. Committed to staging @7cd17c863, not yet deployed. |
| Live presence | None in final 10-minute window |

#### P-007 — `blocked` — normal

Deploy-verify (B-LOOP-FIN-3 task 3): once the deploy gate clears (currently frozen on reds, fleet-wide), confirm migration 323 boot-applies on the release host + the loop engine + loop:arm/end/status verbs go live on :3070 (the engine is committed to staging @7cd17c863, GREEN, but NOT yet deployed). BLOCKED on the fleet deploy freeze — not this plan's work to unblock. (Brief-14 deploy-verify pass su-85933 2026-06-24: IN-SESSION verification done while the gate stays frozen — loop:arm/status/end all functional my loop active, parked:false, consecutiveErrors:0, firing on the 120s cadence; routines_list shows dozens of active loop-su-* routines firing fleet-wide engine broadly healthy; papercusp-loops flag ON; db:check_drift in_sync migrations boot-apply. Brief-14's own migrations 393/394/400/401 also auto-apply on the same boot, so they ride this deploy. STILL BLOCKED on the fleet freeze: green-checkpoint RED on @papercusp/operator-core ~12h candidate 5cf4f72a, release-fixer dispatched, dead-executor reaper expected to recover — pre-dates this work, release-fixer owns it. The :3070-against-green checklist runs when the gate clears.) (Re-verified 2026-06-29 D-002: engine healthy in-session migration 323 in_sync; loop arm/status/end functional; papercusp-loops ON. Deploy-verify still blocked on the fleet freeze 102 reds/~74h, owned by release-fixer, out of lane. Monitoring loop watches the gate-clear.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — Deploy + live-verify |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/windows-desktop-feature-parity-2026-07-02</code> — Windows desktop feature parity — test surface + fix loop — <strong>3 residual</strong> (3 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-04T10:34:19.951Z |
| Now | MILESTONE + all headlessly-verifiable behavioral verifies DONE on signed 0.0.2 (STAGE2 v7). 28/31 items done. This pass (su-b0fbf, 2026-07-04) live-verified P-004 (Server headless tray, only a -siw window, owns the WSL sidecar :21958), P-008 (close-GUI-window keeps Server+sidecar ALIVE; tray-quit clean-stop code-confirmed main.rs:1639..3278), and ran vm-smoke-windows.sh 9/9 GREEN; flipped the investigated/subsystem tail with per-item evidence (see D-004). P-031 report DONE (D-004 + SHIPPING.md + testing insight §18/§19 + facts:assert; mem0 write still quota-blocked). Green release gate is GREEN (RECOVERED, pin 144d3aee). 3 residuals remain, all attended-or-minor and NOT code blockers: P-023 'Focus this session' button-click E2E, P-030 live-credentialed-agent functional click-through, P-011 wt.exe-absent fallback. WI-1646 (named-pipe IPC) is a separate non-blocking increment (HTTP fallback carries all traffic). |
| Next | Owner (or a credentialed VM run) executes the final attended acceptance = P-030 functional click-through on a fresh VM snapshot: create pot+harness -> one live agent turn -> terminal launch -> coord wake -> P-023 'Focus this session' button-click. P-011 wt-absent fallback + WI-1646 named-pipe IPC are minor follow-ups. Nothing else blocks; the plan is closed to the extent verifiable headlessly. |
| Live presence | None in final 10-minute window |

#### P-011 — `todo` — normal

wt.exe-absent fallback (Windows Terminal not installed): graceful surfaced error, not a silent hang. Verify the fallback impl (native_console.rs spawn_windows_wsl_new_window else-branch) behaves. (RESIDUAL 2026-07-04 minor edge: wt.exe-absent fallback code path present native_console.rs spawn_windows_wsl_new_window else-branch surfaces an error rather than hanging but NOT runtime-verified would need to remove Windows Terminal on the VM. Low priority; fold into P-030 attended pass or a follow-up.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Terminal launching (wt.exe) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-023 — `todo` — high

'Focus this session' operator UI action works on Windows (the button that brings a session's terminal window forward).  (RESIDUAL 2026-07-04: focus MECHANISM verified P-022 done, D-003 Session-1 EnumWindows+SetForegroundWindow + renderer wiring AdvSessionsClient focusRow->invoke typechecked + focus cmd compiled into release build. NOT yet done: the literal 'Focus this session' button-click->foreground E2E. Blocked headlessly: the scheduled-task-relaunched GUI does not persist a debuggable WebView2 CDP :9222 unreachable; first-boot + Start-Process GUIs DO persist, so this is a task-relaunch artifact not a product bug. -> the one attended step in P-030's click-through.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Window focusing (Linux-only today) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-030 — `todo` — high

FINAL GATE: one clean fresh-snapshot install -> boot -> vm-smoke 9/9 + a functional click-through (create pot+harness, one live agent turn, terminal launch, coord wake, focus a session) with zero regressions.  (SMOKE HALF GREEN 2026-07-04: vm-smoke-windows.sh 9/9 on the running installed 0.0.2 ssh, distro, app, operator :21958, health 200, backups+kopia, agent-tools loopback, 0 PG ERROR, psu shim+launcher. RESIDUAL: the functional click-through with ONE LIVE credentialed agent turn create pot+harness -> agent turn -> terminal launch -> coord wake -> focus-session UI-click + strict fresh-VM-snapshot install. Needs VM model creds or owner attendance = the standard release-acceptance step; every underlying mechanism is individually verified.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Fix loop + gate + report |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>oddsmith-hive/oddsmith-gpt-analyst-liveness-honest-cost-2026-07-02</code> — GPT-5.4 analyst swap, honest LLM-cost testing at ~100 forecasts/day, and low-latency live-data expansion — <strong>9 residual</strong> (8 todo, 1 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw8@gmail.com |
| Updated | 2026-07-04T09:59:11.366Z |
| Now | P-010 DONE (WI-2291): offline as-of backtest bin apps/desktop/bin/backtest-asof.ts (npm run backtest-asof). Frozen leak-free grid = resolved forward_forecasts, one decision/market/UTC-day (10,445 rows; --source market-data for strict recorded books — only 3 overlap markets today). Arms under withBacktest guard: market-prior control; baseline-v2 (diagnostic; cohort clock per-row via new nowIso on makeVenueScopedCohortAnchor); GPT opt-in --gpt ≤50, evidence as-of ingest_time≤T, drop-on-fallback (smoke: 3 attempts, 0 contamination, 0 quota). Persisted eval_runs runId=backtest-asof-p010: market Brier 0.182, ECE 0.059, corpus YES-ward entry→close drift +0.008 (t=7.0) = the CLV bias floor arms must be read against. FINDINGS: baseline v2 is a STRUCTURAL observer on this corpus (only 3 promotable cohorts, all [1mo,∞); corpus is [0,1h) crypto → the P-012 v2 arm will never accrue stances from the 5-min stream); GPT arm metadata-starved (5 titled rows of 10.4k; evidence store begins 2026-07-02) → EI-7271 (persist title+close_time on forward_forecasts at decision time). No sidecar restart — P-022 soak clock untouched; fee-truth floor + dedupe seam still pending the next weighed batched deploy. |
| Next | P-015/P-016 WebSocket liveness (Polymarket CLOB WS + RTDS, Kalshi WS, free crypto streams) — also retires the P-012 REST-poll staleness caveat. (su-ac403, next loop stretch.) |
| Live presence | None in final 10-minute window |

#### P-015 — `wip` — high

Liveness upgrade (the 'react fast enough' fix): move venue data from REST polling to WebSocket streams — Polymarket CLOB WS market channel (book/price/trade) + RTDS (free, no-auth crypto/equity, 2-min backfill), Kalshi WS (session-token, 30-min refresh). Reuse existing connectors. NOTE Polymarket CLOB V2 hard-cutover 2026-04-28 — verify our connector is on V2.  (paused — owner redirected su-ac403 to implement flush-to-proceed-stretch-discipline-2026-07-04 papercusp; WS scout state carried on WI-2358 checkpoint, resume after) (su-ac403 auto+ideate, gated loop re-armed on WI-2358 — WS liveness Polymarket CLOB WS + RTDS, Kalshi WS; package code+tests this stretch, deploy batched P-022 soak)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 4 — Low-latency live-data expansion + free sources |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — high

Live forward accrual: auto live-loop produces forward_forecasts tagged research-directional analyst=gpt-5.4; watch the Simulation per-stream scorecard converge toward ~500 effective. (Current state: 2,323 resolved + 40,234 open; research-directional already n=1,665, CLV t-stat 5.71, +$198.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Thorough analyst test |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `todo` — normal

Sample-size gate (D-004 of real-money-readiness): conclusive-positive at CLV t-stat ≥ 1.645 with n ≥ 500 effective (~1,000–1,500 raw given ×2–3 market-day clustering haircut); conclusive no-edge at n ≥ 5,000; quick quality read at ~200–300.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Thorough analyst test |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

#### P-014 — `todo` — normal

Calibration/liquidity-honesty guardrail: verify GPT-5.4 does NOT fabricate edge on liquid tight-spread markets (the check the baseline passed on the MegaETH run); reject/flag overconfident low-evidence forecasts.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Thorough analyst test |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `todo` — high

Free crypto settlement streams (no auth): Binance / Coinbase / CoinCap public WebSockets for real-time crypto threshold-market settlement prices (Polymarket RTDS already fuses Binance+Chainlink).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Low-latency live-data expansion + free sources |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `todo` — normal

Wikimedia SSE EventStream (free, real-time page edits) as a live attention signal, complementing the Wikipedia Pageview base-rate.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Low-latency live-data expansion + free sources |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `todo` — normal

Wire free structured sources not yet used, under bitemporal as-of discipline: api.data.gov (FEC/Federal Register/regulations.gov — the gov/legal niche edge), the-odds-api (free 500/mo sports), Metaculus + Adjacent News + pmxt (free cross-venue consensus), Finnhub free tier (econ calendar + WS).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Low-latency live-data expansion + free sources |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-019 — `todo` — normal

Evaluate PMXT open-source sidecar (Poly+Kalshi+Limitless normalized WS) as a single-transport liveness layer vs per-venue WS; FinFeedAPI for backtest OHLCV history; Bitquery Kafka = ultra-low-latency Polymarket (paid — defer).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Low-latency live-data expansion + free sources |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-020 — `todo` — low

Hold the deliberate NO on X/Reddit/Facebook (paywalled $12k–42k+/yr, wrong ROI for thin markets); Bluesky (wired) + GDELT (wired) + Wikimedia SSE cover real-time social/attention for free.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Low-latency live-data expansion + free sources |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/ornith-eval-escalation-2026-07-04</code> — Ornith Iter-5 — eval-reflex fix (escalating eval-block + prompt guidance) on the open-ended verify task — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-04T08:17:08.019Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

[ornith-fixture][drift-anchor] Verify docs data-sync/named-queries.mdx against packages/operator-core/lib/sync-resolver/index.ts. Every query name the doc lists MUST exist in the resolver REGISTRY object in that file; report IN-SYNC only if every one resolves, else FIX the exact dead references (remove them from the doc) and cite the files you read.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Doc re-verify (safe, docs-only) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/ornith-verify-scaffold-rerun-2026-07-04</code> — Ornith Iter-4 — reproducibility of the verification-scaffolding win (same open-ended task, unchanged prompt) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-04T08:04:45.958Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

[ornith-fixture][drift-anchor] Verify docs data-sync/named-queries.mdx against packages/operator-core/lib/sync-resolver/index.ts. Every query name the doc lists MUST exist in the resolver REGISTRY object in that file; report IN-SYNC only if every one resolves, else FIX the exact dead references (remove them from the doc) and cite the files you read.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Doc re-verify (safe, docs-only) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/ornith-drift-spoonfed-2026-07-04</code> — Ornith drift-fix, spoon-fed — remove named dead refs (comprehension-ceiling probe) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-04T07:37:48.320Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

[spoonfed][drift] The doc `apps/operator-docs/src/content/docs/data-sync/named-queries.mdx` lists three query names that do NOT exist in the resolver registry. The dead references are EXACTLY these three: `projects.all`, `projects.byId`, and `messages.recent`. Your job: remove every mention of these three dead query names from the doc. Specifically: delete the markdown table rows that list `projects.all` / `projects.byId` and `messages.recent`, and remove `messages.recent` from the prose list where it appears. When you are done, NEITHER the string `projects.all` NOR the string `messages.recent` may remain anywhere in the file. Use your file edit tool with exact old/new text for each change. Verify by re-reading the file and confirming those strings are gone, then mark this item done.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Remove named dead refs |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/quartermaster-desktop-2026-07-03</code> — Quartermaster — spreadsheet→research→approval→checkout desktop app — <strong>2 residual</strong> (2 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | avi@storewolf.com |
| Updated | 2026-07-04T06:20:48.370Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-2083` [done] Scaffold new repo `quartermaster` mirroring the oddsmith layout (npm workspaces: apps/desktop, packages/, blueprints/; tsconfig.base, vitest workspace, README, AGENTS.md guardrails); consume shared @…<br>`WI-2084` [done] Tauri (Rust) shell → Node sidecar (Hono host + embedded Postgres; ~/.quartermaster/operator.json + embedded-pg.json discovery, oddsmith pattern) → Vite/React SPA shell adopting the oddsmith design sp…<br>`WI-2085` [passed] DB schema + migrations in embedded PG: sheets (raw import + provenance), items (raw/normalized name, qty_total/in_stock/needed, notes, ambiguity flags, status), candidates, approvals, purchases + pur…<br>`WI-2086` [done] Data sync, oddsmith/papercusp pattern: PG LISTEN/NOTIFY → SSE invalidate/update via @papercusp/sync SSE transport (desktop-primary path) wired into the SPA provider<br>`WI-2087` [done] File ingestion: CSV (papaparse) + XLSX/ODS (SheetJS) upload endpoint → raw sheet persisted with provenance; unit tests with fixture sheets<br>`WI-2088` [done] Google Drive share-link ingestion v1: accept anyone-with-link Sheets/Drive URLs via export endpoint; clear actionable error for private links (OAuth is a fast-follow, out of v1 scope)<br>`WI-2089` [done] LLM normalization pass (column inference Totals/In Stock/Need, item-name canonicalization e.g. 'Cash Drwaer'→'Cash Drawer', qty-to-buy computation, ambiguity flags for rows like 'TV???' / 'tm-6000iv …<br>`WI-2090` [done] @quartermaster/contracts: PurchaseResearchInput { item, qty, notes, constraints } and CandidateSet [{ vendor, url, title, price, shipping, availability, minQty, matchConfidence, rationale, sources }]…<br>`WI-2091` [done] purchase-research harness blueprint (extends research, mirrors bet-analysis): workItem kind purchase-research; director + web-search researcher roles; judge acceptance rubric (item match incl. varian…<br>`WI-2092` [done] quartermaster-ops hive blueprint (extends work): Queen drains the purchase-research backlog via fleet placement (width = many items in parallel, one harness per item)<br>`WI-2093` [done] Sidecar⇄papercusp seam: user-triggered enqueue of one purchase-research work_item per Need>0 item; ingest CandidateSet completions into candidates table; stream research progress into the SPA over SSE<br>`WI-2094` [done] Approval grid: items × candidate cards (price, shipping, confidence, rationale, link preview); approve+qty, reject-with-feedback → re-research, manual URL paste, bulk approve-high-confidence; item li…<br>`WI-2095` [done] Card vault: payment_methods encrypted at rest (AES-256-GCM; key in OS keychain via Tauri, 0600 keyfile fallback); card CRUD UI + per-run card selection; PAN/CVV never logged, never in screenshots, de…<br>`WI-2096` [passed] Checkout driver: group approved candidates by vendor → one VISIBLE headed browser (Playwright, persistent per-vendor profile) per vendor cart on the user's desktop; add-to-cart + checkout fill (shipp…<br>`WI-2097` [passed] Checkout modes setting: 'Auto Purchase' (agent clicks place-order) vs 'Auto Fill' (agent stops at the place-order step, user clicks); spend caps + vendor allowlist enforced in BOTH modes<br>`WI-2098` [done] Purchase capture watcher: browser session stays attached in BOTH modes; detects the confirmation page regardless of who clicked place-order (agent or human); records order number, line items, totals,…<br>`WI-2099` [done] Purchases screen: receipt viewer (details + confirmation screenshots), export CSV; status roll-up onto the original sheet view (Need → Ordered → Received manual tick)<br>`WI-2100` [passed] E2E: Playwright e2e over the SPA with a fixture messy sheet (replica of the owner's screenshot incl. typos/ambiguities) + a local mock vendor store for checkout e2e (real vendors never hit in tests);… |

#### P-010 — `wip` — normal

quartermaster-ops hive blueprint (extends work): Queen drains the purchase-research backlog via fleet placement (width = many items in parallel, one harness per item)  (→ WI-2092)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 2 — Research agent plane |
| `blocked-by` | `P-009` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `wip` — high

Sidecar⇄papercusp seam: user-triggered enqueue of one purchase-research work_item per Need>0 item; ingest CandidateSet completions into candidates table; stream research progress into the SPA over SSE   (→ WI-2093)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 2 — Research agent plane |
| `blocked-by` | `P-009` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>oddsmith-hive/oddsmith-model-directional-honesty-2026-07-03</code> — Model-directional honesty: stance-filtered scoring, per-pricer attribution, de-bias v2 (cohort slopes, NO side, fee bar) — <strong>10 residual</strong> (10 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | avi@storewolf.com |
| Updated | 2026-07-04T03:48:58.355Z |
| Now | SHIPPED + DEPLOYED (2026-07-04 00:07Z, su-ac403, owner-directed start-to-finish). All 10 items done. Live-verified on the running gate: 8,830 deduped decisions -> 4,502 no-stance placeholders excluded (market-prior benchmark only) -> gate n=4,328 STANCE bets, verdict unchanged pilot/$50 clvGate=true (meanCLV +0.0134, t=6.30). model-directional now honestly n=658 (-$203.93 = retired v1 stances' real history). research-directional n=3,670 +$256.23. Shipped: (1) filterStance D-001 (ODDSMITH_MIN_STANCE_EDGE 0.005) on all capital-informing populations, filtered BEFORE dedupe; (2) additive forward:market-prior control card (P-012 A/B used it 2026-07-04: GPT-5.4 ΔBrier +0.045..+0.191 vs prior, D-004 conclusive-positive — see gpt-analyst plan); (3) baseline v2 = cohort-anchored de-bias wired as live-loop baseline AND llm fallback; (4) crypto-gbm + weather-ensemble stamps + forward-recording. FOLLOW-UPS CLOSED 2026-07-04 ~04:00Z (su-ac403): (a) WI-2186 venue FeeModel now bound into baseline v2 frictionFloor — feeModelFrictionFloor() in baseline-analyst.ts (taker 1-ct entry fee at market price in prob units + half-spread; throwing/absent model falls back to flat 0.015), wired in live-loop from connector.feeModel (polymarket schedule-backed model exposed), 13/13 tests, tsc clean, DEPLOY BATCHED (no restart — P-022 soak preserved; boot log 'friction floor: venue FeeModel + half-spread' verifies at next deploy). (b) WI-2166 the NOTIFY "flake" was dedupe cross-talk (two PG suites, one testcontainer DB, constant bridged dedupe key 90s) — dedupeWindowMs seam + 0 in both suites, 10/10 paired runs green. |
| Next | Watch items: (a) crypto-gbm/weather-ensemble forward cards populate as loops emit; (b) baseline v2 stance rate LOW by design (2 promotable cohorts); with fee truth batched-deployed, expect MORE tail-price stances + FEWER mid-price ones on fee-bearing markets. Remaining follow-up: calibration-backtest harness doc comment still says v1 (comment drift only). Next batched sidecar deploy carries: fee-truth friction floor + dedupeWindowMs seam (both inert-or-tested; weigh P-022 soak clock, last reset 2026-07-04 02:54Z). |
| Live presence | None in final 10-minute window |

#### P-001 — `wip` — high

eval stance filter: add filterStance(records, minEdge) to @oddsmith/eval (env ODDSMITH_MIN_STANCE_EDGE, default 0.005) — a forecast with \|modelProb−marketProb\| < minEdge is a market-prior OBSERVATION, not a bet; exclude no-stance rows from every capital-informing scorecard population in evidence-loop-wiring (forward:all aggregate the D-007 gate reads, per-analyst, tradeable, per-stream). Tests pin: placeholder rows out, stance rows in, gate population = stance-only. DISCLOSURE: this changes the gate population (I-025 precedent) — ratified by owner directive 2026-07-03 ('go ahead… implement').  (→ WI-2077)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — Measurement honesty (the artifact fix) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-007` |
| Linked work-items | None |

#### P-002 — `wip` — normal

Additive forward:market-prior benchmark scorecard: the FULL baseline population (incl. zero-stance rows, modelProb≈marketProb) scored as the market-prior control — preserves the P-012 A/B control arm (ΔBrier vs market) that the stance filter removes from the bet cards. Additive only, like forward:llm-tradeable. (→ WI-2078)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — Measurement honesty (the artifact fix) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `wip` — normal

baseline-analyst side reflects stance direction (side = modelProb ≥ marketProb ? 'yes' : 'no' — parity with llm-analyst.ts:420) instead of hardcoded 'yes'; zero-stance placeholder signals keep side 'yes' but are excluded from bet scorecards by the stance filter. (→ WI-2079)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — Measurement honesty (the artifact fix) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `wip` — high

Stamp analyst ids on deterministic pricer Signals: forecast-crypto assembles Signals with analyst:'crypto-gbm', forecast-weather with analyst:'weather-ensemble' (Signal.analyst already exists in contracts, optional). streams.ts pinned tests: both ids map to model-directional (default path).  (→ WI-2080)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 2 — Per-pricer attribution |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `wip` — high

forward-recorder honors per-signal attribution: recordOpenForwardForecasts prefers signal.analyst over the batch opts.analyst label; wire the crypto + weather forecast loops to ALSO record their signals as forward_forecasts (same I-004 dedup guard: minIntervalMs + minDeltaProb) so each pricer accrues its own per-analyst forward card and the model-directional stream finally measures its genuinely-edged components.  (→ WI-2081)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 2 — Per-pricer attribution |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `wip` — high

Cohort-slope tilt replaces the flat Platt 1.15: baseline-analyst takes an injectable venue-scoped cohort table (the existing Becker fit artifacts / cohort-prior seam — REUSE, don't refit); market → (domain, horizon-bin) → fitted calibration slope; recalibrated fair = sigmoid(a + b·logit(marketProb)) from DSR-stable rows only; NO cohort row ⇒ NO tilt (zero-edge signal), not the blind 1.15; horizon gate: no tilt where the fitted slope ≈ 1 (near-close μ≈1 per the μ(τ) canary).  (→ WI-2110)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 3 — De-bias v2 (the model fix) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `wip` — normal

Symmetric NO-side de-bias: NO-favorites (marketProb ≤ 0.5 − minDist) get the same cohort/extremization treatment with side 'no' — removes the structural long-YES bias (the deferred 'until engine NO-side sizing is wired' carve-out is stale: the engine sizes NO, the LLM analyst already emits 1,808 NO forecasts). (→ WI-2111)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 3 — De-bias v2 (the model fix) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `wip` — normal

Fee+spread claim bar: baseline claims a stance only when \|tilt\| clears venue fee + half-spread for that market (injectable fee fn reusing the per-market fee-truth work; half-spread from the book); below the bar ⇒ zero-edge low-confidence signal. Same honesty filter that separates llm-tradeable (trust 0.82) from raw llm. (→ WI-2112)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 3 — De-bias v2 (the model fix) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `wip` — high

Verification: unit tests ship WITH each change (eval filter populations, market-prior card, recorder attribution, baseline v2 incl. NO side + cohort tilt + fee bar); affected package suites + desktop suite + tsc green; workspace build green.  (→ WI-2113)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 4 — Verify + deploy |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `wip` — high

Deploy + live-verify: rebuild edited package dists (sidecar bundles from dist/ — the 2026-06-30 gotcha), build:sidecar, restart papercup-oddsmith-sidecar (DISCLOSED: restart resets the P-022 7-day soak clock in oddsmith-real-money-readiness — accepted cost, ratified by 'start to finish'), then verify /api/evidence-gate: model-directional + per-analyst cards stance-only, forward:market-prior present, pricer analysts begin accruing rows.  (→ WI-2114)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 4 — Verify + deploy |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/voice-unified-sentinel-pipeline-2026-07-01</code> — Voice completion: one Sentinel pipeline (pane brain), EL voice front-end, deep-delegation lane — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw4@gmail.com |
| Updated | 2026-07-03T22:47:53.652Z |
| Now | Phases 1–3 nearly done, ~4h after authoring. DONE: P-001..P-007, P-009, P-011 (one-brain relay + says-pump + converse-fate deletion + deep-delegation lane both entries [voice:delegate_deep tool + <delegate_deep> tag] + routing scenarios sn-D01/D02 + port discovery + flag/credential hygiene). All test gates green: voice-node 146+, llm-testing 40/40, tools-md-sync 50, flags 81. Route note: plan is solo-routed (D-004) but the Queen's orphan-reclaim re-placed several items onto bees (session su claims carry no scheduler heartbeat — her known detector gap); outcome was CONVERGENT (bees completed P-003/P-005/P-006/P-008-in-progress consistently with the in-tree implementation, several genuine improvements). P-008 (macOS mic) in flight with its bee. IN FLIGHT: P-010 (TUI control verbs) via a background subagent. Ambient: green-checkpoint STALLED on papercusp (deploys to :3070 frozen — pre-existing fleet issue, escalated separately); git-sync recovered. |
| Next | su-8b471: prep P-013 (restart :3170 staging operator to load the new voice host + pump, adapt live-operator-voice-e2e.mjs to the pane-brain flow) + P-017 docs; then the owner-present live round-trip (P-012/P-016 — the live E2E types into THE one sentinel dock, so it is coordinated with the owner, not run silently). |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-1424` [passed] EL voice → pane: operator-voice-session routes each final user utterance to POST /operator/sentinel-input (the pane pipeline) instead of answering via ask_operator→sentinel:converse; EL agent persona…<br>`WI-1425` [passed] Pane speech-out via fan-out: voice:say / sentinel_says lines are synthesized server-side (EL TTS in the Herald voice when configured, kokoro fallback) and fanned out via broadcastOpVoice to all attac…<br>`WI-1426` [done] Converse-fate executed: delete the superseded voice-converse-bridge path (setVoiceConverseHandler registration in OperatorConversationProvider + routeVoiceUtteranceToConverse) and the now-dead ask_op…<br>`WI-1427` [done] Tests for the unified path: voice-sentinel-bridge.ts unit tests (currently zero); synth-injection integration test (template: operator-voice-synthetic-audio.test.ts); SentinelVoiceBar component test;…<br>`WI-1428` [passed] <delegate_deep summary="..." brief="..."> output tag: add to sentinel persona (three-way rubric: answer directly / delegate_deep for hard thinking / handoff_to_queen for buildable work) + parse in op…<br>`WI-1429` [done] sentinel-deep-watch (mirror of operator-sentinel-handoff-watch): on delegate_deep, mint a research-task work_item + fleet:spawn an EPHEMERAL background su (deep tier, brief = question + recent conver…<br>`WI-1430` [passed] Delegation observability + routing quality: Sentinel can answer "how's that analysis going" by reading its open delegation work_items; LLM scenarios covering answer-vs-delegate_deep-vs-handoff_to_que…<br>`WI-1431` [done] macOS mic plumbing: NSMicrophoneUsageDescription (Info.plist), com.apple.security.device.audio-input entitlement in entitlements.plist, and a macOS getUserMedia grant path (WKWebView equivalent of th…<br>`WI-1432` [passed] Port-discovery unification: desktop-operator-voice-client.ts resolves the voice WS via /api/desktop/voice-config (parity with the channel client's resolve-voice-ws-url) instead of hardcoding ws://127…<br>`WI-1433` [passed] TUI: bind the dormant operator-voice-bus control verbs (control_mute/control_ptt/control_force_host/control_set_mode) to keybindings + voice UI affordances; delete the legacy dormant WsInitPayload/el…<br>`WI-1434` [passed] Voice/sentinel flag hygiene: make SENTINEL, SENTINEL_PROACTIVE, VOICE_CHANNELS, VIDEO_CHANNELS defaults DELIBERATE (they run ON via derived defaults while their comments claim OFF); fix the stale com…<br>`WI-1435` [done] Linux desktop agent-e2e (tauri-agent-tools in the Tauri shell): typed text → pane → spoken; voice → pane → spoken (same answer path); instant-ack then answer; barge-in cuts playout; mute/deafen + /se…<br>`WI-1436` [passed] TUI verification: update live-operator-voice-e2e.mjs for the pane-brain routing + re-run; audio-loopback-smoke.sh re-run; verify V-session attach speaks pane answers<br>`WI-1437` [done] macOS VM voice round-trip (mic permission prompt → capture → pane → spoken reply)<br>`WI-1438` [done] Run the sentinel LLM rubric suite live (npm --prefix apps/operator run llm-test -- --target sentinel) with a distinct judge model — the old 429 blocker is gone (gateway)<br>`WI-1439` [needs-human] Owner human acceptance at the mic: desktop round-trip + TUI `v` PTT and `V` session (the never-done human-acceptance items)<br>`WI-1440` [done] Rewrite the stale voice docs to the real architecture (VOICE-MODE-V4.md points at deleted lib/voice-* paths, doesn't know Deepgram/wake-word engines/voice-node): update spec/voice-mode-v4.mdx + autho…<br>`WI-1441` [passed] Dead-surface sweep: remove leftover drain-poll code, superseded converse remnants, any orphaned voice code found during P1–P3; re-run knip/lints |

#### P-016 — `todo` — normal

Owner human acceptance at the mic: desktop round-trip + TUI `v` PTT and `V` session (the never-done human-acceptance items)  (← WI-1439 released) (← WI-1439 todo) (← WI-1439 todo) (← WI-1439 todo) (← WI-1439 todo) (← WI-1439 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Live E2E verification (acceptance bar) |
| `blocked-by` | `P-012`, `P-013` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/p2p-work-distribution-2026-07-02</code> — P2P work distribution: opt-in, pull-based hand-off across hive peers (one substrate for SU + queen-bee) — <strong>2 residual</strong> (2 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-03T21:38:27.279Z |
| Now | ACCOUNT axis (P-201 /res) DONE + live-verified (assign/setPct/unassign → persist → reload, real PG; jsonb fix confirmed). Fleet p2p-hive-git lane COMPLETE (P-103/301/302/303 terminal). LIVE legs (drillable now, verified by cc992's P-007 LIVE-2 drill work-distribution-drill.sh): grant-set→local-reaper→refusal-receipts→trace, fleet-directory hyperbee projection (mig476), settings-set, allotment-set (mig473, P-201), foreign-workspaces registry+guard+git-sync (mig467/470). The remaining WORK-DISTRIBUTION e2e wiring is now FORMALIZED as tracked items (2026-07-03): WI-1936 puller activation [seq1, gated on claim-path soak], WI-1935 offer-store publish leg P-102 [seq2], WI-1938 metering-ledger table [seq3], WI-1937 offer-executor SPAWN leg [seq4, BLOCKED — OWNER-AUTHORITY-GATED on the P-105 foreign-work sandbox + owner sign-off], WI-1939 push-nudge [P-305], WI-1940 federated-reap projection hook. cc992's drill files SKIP-with-reason per leg and greens WI-by-WI as they light up. GPU axis of /res still owner-gated (owner's option a/b; leader recommends b). |
| Next | Owner: (1) the /res GPU-contribution a/b decision (recommend b = local inference server), and (2) sign-off on the foreign-work trust model to unblock WI-1937 executor spawn leg (needs P-105 sandbox first). Non-gated wiring (puller flip → publish → metering: WI-1936→1935→1938) is available for the next p2p-wiring phase. su-35c3bac0 parked (AUTO 900s), triaging cc992's drill findings as they land. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-1728` [done] Settings surface: left-nav P2P/Peers page, workspace-DEFAULT + current-workspace OVERRIDE (queen/overwatch pattern). Sections: Identity & devices (attestation state per device — missing/stale = RED b…<br>`WI-1730` [blocked] Attestation-flow dependency: GATED ON LIVE-1/WI-1585 live verification (D2-D6). Acceptance: second-device attestation + membership seeding proven on the 2-machine rig; refused-op counters exist. Bake…<br>`WI-1731` [passed] (NEW — H15/X15) Rollout tiers + feature flag: tier 1 = SAME-OWNER machines only (our tower+iMac rig); tier 2 = cross-user capped at Delegate — GATED ON the X1 loopback boundary landing in P-105 (not …<br>`WI-1732` [done] Fleet directory (D-006): federated record {slug, title, description, owner (numeric gh user-id; login display-only per X9), publisher set, billing default, tags} — hive-browsable card. Exactly ONE ow…<br>`WI-1733` [passed] Signed work offers / authorship chain: offers device-signed (gate-verdict P-044 shape); receiver verifies device-sig -> device attested to gh user (WI-1585 flow) -> user in owner-signed publisher set…<br>`WI-1734` [done] Standing puller: opt-in = a supervisor-owned standing claim-spec (P-016 machinery) filtered to opted-in fleets; respects P-002 windows + caps. Baked: C1->C4 — the PUBLISHER stamps the assignment on t…<br>`WI-1735` [passed] Local-authority spawn (D-001): a claimed offer is launched by the HOST supervisor — never the remote peer. Requester steers via the coord plane (send/receipts/wake). Baked: C2 — v1 foreign-session ca…<br>`WI-1736` [blocked] Foreign-work isolation — the sandbox spec. GIT: foreign workspaces get a FULL CLONE (own object database) on a quota volume — X4: a git worktree shares the ODB via commondir, so a quota on the checko…<br>`WI-1737` [done] Revocation reaping: revoking a peer/publisher (or revoked_pubkeys entry) reaps in-flight foreign sessions + cancels unclaimed offers. Baked: C6 — enforcement reads bypass caches. H7+X6 — the dangerou…<br>`WI-1738` [passed] Budget envelope: every offer carries {budget envelope, billed-to, model-class, isolation reqs, priority}; host clamps to local caps (local always wins); exhaustion = graceful wind-down + loud receipt…<br>`WI-1739` [passed] (NEW — C9/X3) Results channel — DESIGN DECISION REQUIRED, then build: the deliverable path for foreign work. X3: a top-level refs/foreign/<fleet>/ family lives OUTSIDE every device namespace — sigref…<br>`WI-1740` [done] Two-axis allotment records per (host, fleet): remote axis normalized to DOLLARS or model-class weights (H14 — 100k Haiku != 100k Fable; token-denominated allotments are ambiguous contracts) + local a…<br>`WI-1741` [done] Host-gateway claim authority (D-007): claimable iff min(allotment-remaining, live headroom) > 0, per axis. Remote headroom = account balance/rate limits (existing logic); local headroom = local gatew…<br>`WI-1742` [done] Inference leases: short-lived reservations for burst planning — remote {X tokens for fleet F, T min} and local {slots + optional model-residency pin}. Auto-expiring; claim-time revalidation stays aut…<br>`WI-1743` [done] Billing matrix (D-009 — NO relay/proxy in v1) with the X7 PER-MODE AUTHORITY TABLE: (a) host-pays + allotments = default — host-SIGNED usage receipts authoritative (host spent its own money; M8). (b)…<br>`WI-1744` [done] Metering + contribution ledger: per-(host,fleet) spend counters both axes; local axis meters GPU-seconds/tokens served (donation visibility; no economy in v1). Baked: M22 — reciprocity/contribution m…<br>`WI-1745` [done] Fleet capacity view: owner-side assigner queries the aggregate of member hosts' advertised {slots, allotment-remaining per axis, active leases}. Advisory; pull remains authoritative. Baked: m13 — fle…<br>`WI-1746` [passed] Model-class on offers: {frontier-remote \| local-small \| any} + latency tolerance; bulk/background work routes to donated GPUs, frontier reasoning to remote allotments. DEPENDS ON local-concurrent-inf…<br>`WI-1747` [done] Federate the fleet registry (agent_fleets + membership) so fleets span machines; port the 2026-07-02 multi-fleet-leadership registry-union fix (audience-host.ts) to the federated view.<br>`WI-1748` [done] Cross-machine leader election: HRW rendezvous + lease stickiness (P-021 primitive) for leader failover; changes announce on the coord plane; epochs align with C4 roster epochs.<br>`WI-1749` [done] Push-as-nudge: optimistic wake (offer available — run your puller) via the wake bridge; latency only, never correctness; M9 rate-caps apply.<br>`WI-1750` [passed] Pool/broker gateways (D-010, v2): hosts sign GRANTS to a pool {cap + constraints}; pool signs ASSIGNMENTS {fleet F draws Y from host H}; host verifies BOTH sigs at claim and enforces constraints loca…<br>`WI-1751` [dropped] LIVE-2 end-to-end acceptance drill on the 2-machine rig — every leg observable from the origin, any silent leg = FAIL: grant Delegate -> create fleet + publishers -> publish signed offer A -> B pulls…<br>`WI-1752` [done] (NEW — M18) Simulation harness, green BEFORE LIVE-2: property-test publisher-stamped assignment, steal/reassignment (incl. X12 weighting), priorities, fairness, and budgets with N virtual hosts — no … |

#### P-003 — `todo` — normal

Attestation-flow dependency: GATED ON LIVE-1/WI-1585 live verification (D2-D6). Acceptance: second-device attestation + membership seeding proven on the 2-machine rig; refused-op counters exist. Baked: m25 rotation flow (re-anchor, never revoke). X11 — LIVE-1 prerequisites GAIN a single-machine claim-path soak/health gate: work_items:claim_next is flaky TODAY (EI-6797 PG lock contention, live evidence); cross-machine arbitration (C4) must not be built on an unverified local claim primitive. (← WI-1730 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — foundations (grants, visibility, loud refusals) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-105 — `todo` — normal

Foreign-work isolation — the sandbox spec. GIT: foreign workspaces get a FULL CLONE (own object database) on a quota volume — X4: a git worktree shares the ODB via commondir, so a quota on the checkout alone is void and a foreign `git add` of a huge blob would poison the shared, federated repo; alternative: isolated GIT_OBJECT_DIRECTORY; results publish by PUSH with a size/blob-cap at the results-channel admission (P-108). COMPUTE: C10 — cgroups/ulimits enforce CPU/RAM/disk/bandwidth caps mechanically (allotments are inference-myopic; a zero-token build job can eat the machine). NETWORK: C11 — per-fleet egress allowlist + logging (host's IP = host's liability; explicitly NOT origin-proxying). LOOPBACK BOUNDARY (X1 — v1-blocking for tier 2): the gateway (:8788, pooled credentials), PG (:5432), and operator API (:3070/:3170) are reachable from any foreign shell, bypassing EVERY economic control; required: per-foreign-session gateway credentials with the gateway refusing unattributed loopback calls (storm-circuit client-identification is the starting point), PG credential isolation (foreign sessions never inherit DATABASE_URL / getHarnessAdminUrl), port-filter or netns for the sandbox tier. PLUS (leader strengthening, D-015): ON-DISK CREDENTIAL isolation — a foreign session running as the host OS user can read ~/.papercusp/superuser-token, embedded-pg.json, gateway key material; the sandbox tier therefore needs a dedicated OS user or userns, not just port rules. Until the loopback boundary exists, tier 1 (P-005, same-owner) is the ONLY safe tier. X13 — enforced kill after wind-down grace. Poison-SCREENING stays post-v1 (isolation is blast-radius control, not detection).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — fleet channels + work-offer/pull (the distribution core) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-015` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/fuzzy-tool-name-resolution-2026-07-02</code> — Fuzzy tool-name resolution — recover mangled tool calls globally, safely (threshold + unique-match) — <strong>12 residual</strong> (12 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-02T16:40:15.105Z |
| Now | DESIGNED, not built (draft) — owner asked for a proper plan before any code. Global fuzzy tool-name resolver to recover mangled/near-miss tool names across ALL transports (Claude MCP / OMP / Codex / in-process / tools:invoke), gated by distance-threshold + unique-match (owner directive). Design in D-001..D-009. Grounded seams: resolver hooks `getByMcpName` (libs/generic/tooldef/src/tool-projection.ts:1186) — the single canonical MCP-name lookup all transports funnel through; +2 non-MCP lookups (capabilities/invoke.ts:74, tools:invoke). Tier classifier `tierFor` (capability-tiers.ts) powers the write-gate. Safety is grounded in MEASURED data: 5% of the 619-name catalog is within edit-distance≤2 of another, concentrated in get/set read↔write pairs → handled by canonicalize-first + structured group/verb match + threshold/uniqueness/margin + write-tier asymmetry + annotate-never-silent. |
| Next | Owner reviews the plan (WHAT/HOW nod) — in particular D-007 (keep the write-tier gate? recommended) and the candidate-scope choice (D-009). NO code until approved. On approval: plans:start, then Phase 1 (calibrate T,M on real+adversarial corpora) → Phase 2 (build resolver in tooldef + wire getByMcpName + flag + tests) → Phase 3 (live-verify on an ornith session + ship flag ON). |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

Build the golden mangle corpus: extract REAL mangles from session-9662 (the 4 literal `tool not found` + scan its 125 isError results for name-mangled calls) + synthesize mangles of the ~19 spine names (separator/prefix/case/typo variants). Each case = (rawInput -> intendedTool).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Calibration corpus + thresholds (data before code) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

Build the ADVERSARIAL corpus (must NOT auto-resolve): the measured ambiguous pairs — autonomy_get/set, backup_settings_get/set, config_tiers-get/set, hive_get_steering/set_steering, capability_edit/git — plus a mangle equidistant between two valid names. These are the false-resolve guards.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Calibration corpus + thresholds (data before code) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — high

Sweep threshold T (normalized edit-distance) + margin M against both corpora; pick the (T,M) that recovers the MOST golden mangles at ZERO false-resolves on the adversarial set. Freeze T,M as tooldef constants with the sweep result recorded in a decision.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Calibration corpus + thresholds (data before code) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

Core resolver `libs/generic/tooldef/src/resolve-name.ts`: pure `resolveToolName(input, candidates, { tierOf, threshold, margin }) -> { match?, ambiguous?, alternatives[], via: 'canonical'\|'fuzzy' }`. Stage 1 canonicalize->exact; stage 2 structured group/verb fuzzy with the gate (D-004..D-006); write-tier asymmetry (D-007). Ships with its unit table (golden resolve, adversarial stay-ambiguous, high-tier no-fuzzy).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Build (resolver + wiring + flag + tests) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004`, `D-006`, `D-007` |
| Linked work-items | None |

#### P-005 — `todo` — normal

Wire into `getByMcpName` (tool-projection.ts:1186): exact hit unchanged; on MISS call resolveToolName against the caller's resolvable candidate set (D-009); return the resolved def tagged so the seam can annotate. Cover the 2 non-MCP lookups — `capabilities/invoke.ts:74` + `tools:invoke` — by routing them through the same resolver.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Build (resolver + wiring + flag + tests) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-009` |
| Linked work-items | None |

#### P-006 — `todo` — normal

Add FLAGS entry `papercusp-tool-name-fuzzy-resolve` (default ON per finished-work-ships-on) + gate the resolver call so it is a runtime kill-switch. Not in KNOWN_DARK_FLAGS (it ships on).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Build (resolver + wiring + flag + tests) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Result annotation + telemetry (D-008): a fuzzy-resolved call's result carries `note: interpreted "<in>" as "<out>"`; emit a telemetry row (in,out,distance,transport,model,tier). Add the property test (no input within T of ≥2 candidates ever resolves) + one integration test through the MCP handler seam. Run `npm run test:affected`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Build (resolver + wiring + flag + tests) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-008` |
| Linked work-items | None |

#### P-008 — `todo` — normal

Live verify on the deployed stack: re-run an ornith (weak-OMP) trimmed session; confirm previously-mangled calls now resolve (with the annotation) + telemetry rows appear + the adversarial names still return ambiguous (no false-resolve). Force-deploy if the change must be live to exercise it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Verify live + ship |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — normal

Confirm the flag is ON + the green gate is green; report the calibrated (T,M) + the seam; memory:remember the resolver seam (getByMcpName) + the frozen thresholds so future agents don't re-derive.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Verify live + ship |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — high

Verify the 5 landed off-ramp edits: run tools-md-sync (find.ts guidance changed), then live-verify ONE ornith session bootstraps discovery via tools:find→tools:invoke with zero search_tool_bm25 reliance (launch on the concurrent llama-server once local-concurrent-inference P-001 lands — one ollama serializes).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Off-ramp closure + discovery unification (folded 2026-07-02, D-012) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — high

Implement the bm25→tools:find intercept/alias at the OMP seam (coord-hook / :9071 proxy): a native search_tool_bm25 call is transparently served by our tools:find so the off-ramp becomes an on-ramp (D-012). Share the alias-table mechanism with D-010.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Off-ramp closure + discovery unification (folded 2026-07-02, D-012) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-012`, `D-010` |
| Linked work-items | None |

#### P-012 — `todo` — normal

Structural discovery stance: decide + document ENABLE_TOOL_SEARCH / OMP discoveryMode policy for trimmed sessions — keep discovery ON (context saving) with the intercept (P-011) making native tool-search harmless, vs disabling it. Record as a decision with the live-verify evidence.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Off-ramp closure + discovery unification (folded 2026-07-02, D-012) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/presence-coord-unification-2026-07-01</code> — Unify presence / assignment / coord — one navigable model + discoverable history — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-07-01T19:39:45.785Z |
| Now | Phase 1 + Phase 2 + Phase 3 have LANDED. DONE: P-001 coord:roster (WI-1344), P-002 canonical append-only membership fact (WI-1345, mig 430), P-003 blessed coord:catch-up + audience-stamp death-survival (WI-1346 — added the coord:catch-up READ-path death-survival tests in catch-up.test.ts complementing the fact-level integration test; confirmed the blessed-read wiring via the P-005 seeAlso adopters + coord:roster + P-006 doc; also greened a pre-existing catch-up.test.ts mock-drift red), P-005 guidance.seeAlso cross-link framework + presence/fleet adopters (WI-1348), P-006 doc, P-007 include_stale, P-008 backfill, P-009 catch-up CI guard, P-011 (superseded by P-002). REMAINING: P-004 (retention reaper TTL + adv_sessions.launch_argv — depends on the reaper + launch_argv WIs), P-010 (rollout, gated on green-checkpoint/git-sync recovering). RETENTION SAFETY (D-004) met by the append-only log. |
| Next | P-004 (retention reaper TTL + adv_sessions.launch_argv) is the last Phase-2 item; then P-010 rollout (checkpoint-run → deploy → verify :3070 + remediate in-flight agents) once the green-checkpoint/git-sync pipeline is healthy. P-005 + P-003 landed on staging (tooldef + operator-core), local-vitest-verified; they reach :3070 via P-010. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-1344` [done] coord:roster { scope, view } — ONE read door with an explicit lens: view=live (in-a-turn), members (fleet/hive membership), claims (who-on-what-item), history (who-was-ever-here). Same underlying mod…<br>`WI-1345` [done] Canonical membership = an APPEND-ONLY coord audience fact ("agent X joined fleet/hive Y at T"). coord_presence.fleet_slug + fleet_assignment.fleet_slug become PROJECTIONS of it, never independently m…<br>`WI-1346` [done] Make coord:catch-up { audience:@fleet:/@topic:/@plan: } the blessed history read + guarantee audience stamps persist after agent death. (Depends on the coord:catch-up crash fix WI.)<br>`WI-1347` [done] Consistent retention: a reaper evicts ended/stale coord_presence rows on a TTL; long-term history lives ONLY in the append-only coord log + adv_sessions (with launch_argv populated). No de-associated…<br>`WI-1348` [passed] Cross-link tool OUTPUTS: fleet:status/coord:presence/coord:roster each print a pointer to the adjacent lens + the history read ("N ended — coord:catch-up @fleet:X for who-was-ever-here"; "showing liv…<br>`WI-1349` [done] Write an anchored agent-insights MDX: "Finding who is on what, and who was ever here" — the state-vs-history split, the coord:roster views, the @fleet audience history read. Surface it in coord:orien…<br>`WI-1350` [passed] Remove the include_stale footgun from the read path: default = summary (counts by sessionState) + live/parked rows; targeted owner:<id> lookup for a specific ended agent; never a global stale dump. (… |

#### P-010 — `todo` — high

Rollout of the point-fix + framework changes (they modify ALREADY-DEPLOYED code): sequence WIs through git-sync -> release:checkpoint-run (green the gate) -> release:deploy -> verify on :3070. Ensure the CANONICAL psu-launcher/bootstrap-su + the pui TUI get the fixes (launches currently run from MIXED trees — papercusp vs papercusp-staging). Remediate the 14 in-flight fleet agents launched on OLD code (fleet_slug=null + no AUTO mode) via coord nudges or post-deploy relaunch. Treat defineTool guidance.seeAlso as a framework-wide change — stage + verify carefully.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Rollout of already-deployed-code changes |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/verify-default-on-unverified-flags-2026-06-29</code> — Verify the default-ON-but-unverified flags (owner: keep ON, test them all) — <strong>3 residual</strong> (3 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw@gmail.com |
| Updated | 2026-07-01T08:24:21.358Z |
| Now | All 7 default-ON flags verified by su-8dc60 (2026-06-29, owner asleep / AUTO). All 7 confirmed ON in PostHog; all declared default-OFF/dark in code (owner deliberately flipped them ON to test). RESULTS: P-002 idle-session-reaper PASS (D-001 — dead reaped/live untouched, 40/40 tests, 0 erroneous reaps over ON window). P-001 idle-session-reaper-terminate (D-002) — selection+safety VERIFIED (live routine runs dry_run:FALSE hourly, target set always 0, never over-terminates; resume + lock-release code-correct); GAP: destructive round-trip never fired live (target always 0), forcing a real SIGKILL is owner-gated. P-003 authority-rpc-signed PASS (D-003 — LIVE :3070 rejected an unsigned envelope as 'unauthenticated', 47/47 tests). P-004 protomux / P-005 eviction-probe / P-006 log-snapshot (D-004/5/6) — single-box SAFETY verified (no-op / no-false-eviction / fold-correctness 38/38 tests), so ON is HARMLESS here; cross-machine legs BLOCKED on the 2-machine rig (the only real federated peer, Avis-iMac, is offline). P-007 substrate-sidecar PASS (D-007 — runs IN the live sidecar pid 2362608, federation peer_connected works, NO in-process fallback; the brief's expected RocksDB-lock-fallback did NOT manifest — Option-B IPC avoids the double-open). KEEP ALL 7 ON. |
| Next | Owner-gated remainders (none autonomously doable): (1) bring Avis-iMac (or any 2nd peer) online for the 2-machine rig to close P-004/P-005/P-006 cross-machine legs; (2) optionally capture the first real idle-terminate's resume in journald to empirically close P-001; (3) substrate-sidecar latency A/B + the benign MaxListeners(>10) cleanup. Two minor findings filed as improvements (test-isolation flake in file-lock-routing-hive.test.ts; sidecar Hyperswarm MaxListeners warning). |
| Live presence | None in final 10-minute window |

#### P-004 — `blocked` — high

papercusp-authority-rpc-protomux (CROSS-MACHINE — needs the 2-machine rig). ON effect: routes remote lock-authority RPCs over the per-harness Hyperswarm protomux channel so NAT'd desktop peers (no reachable :3070 URL) are served. Gated on: the owner 2-machine serialization proof (P-003). VERIFY on REAL separate machines: a NAT'd peer's file-lock acquire routes to the elected authority over the swarm channel and SERIALIZES correctly (two peers contending one file → exactly one holder). Single-box = no-op (short-circuits local), so note it cannot be proven in-process. PASS = cross-machine serialization holds over protomux. Risk if wrong: fail-open → concurrent double-grants (git-merge backstop only).  (Single-box SAFE/no-op VERIFIED D-004 — ON harmless here. Cross-machine serialization BLOCKED on 2-machine rig iMac peer offline.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Verify each default-ON flag |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

#### P-005 — `blocked` — high

papercusp-authority-eviction-probe (CROSS-MACHINE — needs the 2-machine rig). ON effect: φ-accrual + SWIM detector evicts a CRASHED authority promptly (a reachable relay confirms it dead) instead of waiting the 90s staleness window. Gated on: the same 2-machine proof. VERIFY on real machines: kill the sitting authority → survivors re-elect the successor within the probe window (not 90s); AND confirm it NEVER evicts on local blindness (single box / no transport = strict no-op, fail-open preserved). PASS = prompt eviction on real death + no false eviction on blindness. Risk if wrong: authority flapping / premature eviction.  (No-false-eviction-on-blindness VERIFIED D-005 — ON harmless here. Prompt-eviction-on-real-death BLOCKED on 2-machine rig.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Verify each default-ON flag |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

#### P-006 — `blocked` — high

papercusp-substrate-log-snapshot (CROSS-MACHINE wire behavior — needs real peers). ON effect: appends periodic snapshot ops + seeds a new joiner's merge cursor at the latest snapshot so it folds from there instead of full history. Gated on: real-wire sparse-fetch + cross-machine convergence (P-008). VERIFY: (1) a NEW joiner sparse-fetches from the snapshot index and converges WITHOUT folding full history; (2) cross-machine convergence holds with snapshots present; (3) NOTE explicitly: it does NOT reclaim disk (the clear()-prefix-GC is a SEPARATE follow-up — do not expect disk to shrink). PASS = joiner folds-from-snapshot + converges. Risk if wrong: a joiner that can't sparse-fetch falls back to fold-from-0 (slow, but correct).  (Mechanism+fold-correctness PROVEN single-box, 38/38 tests D-006. Real-wire sparse-fetch saving BLOCKED on 2-machine rig.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Verify each default-ON flag |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-006` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/tauri-release-kit-shared-build-2026-06-25</code> — Shared cross-platform desktop build kit (@papercusp/tauri-release-kit) for papercusp + oddsmith — <strong>2 residual</strong> (2 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw2@gmail.com |
| Updated | 2026-07-01T08:24:21.250Z |
| Now | COMPLETE. All items P-001..P-011 done (owner authorized the gated items). @papercusp/tauri-release-kit is a standalone private repo (Papercusp/tauri-release-kit) vendored as a submodule by BOTH papercup (libs/generic/tauri-release-kit) and oddsmith (libs/tauri-release-kit). 61 vitest tests green; in BORROWABLE.md + test:affected. papercusp drives it via papercusp-desktop/bin/release.ts (additive, alongside release-local.sh); oddsmith — previously NO release pipeline — drives it via apps/desktop/bin/release.ts (verified: submodule + workspace + dep + npm install + --plan + tsc). P-010 ran a REAL Linux build that proved the kit end-to-end and caught+fixed 2 real bugs (cargo target-dir resolution for the ~/.cargo-target redirect; files-only+version-scoped collection) — in the kit AND release-local.sh (EI-3782). Only low-pri P-012 remains (kit mac/win driver parity before retiring release-local.sh into a wrapper — deliberately deferred to avoid regressing the proven mac/win legs). |
| Next | Nothing required. Optional/low-pri: P-012 (EI-3782) — kit mac/win parity + release-local.sh→thin-wrapper, needs live mac/win VM verification. |
| Live presence | None in final 10-minute window |

#### P-012 — `todo` — low

FOLLOW-UP (deferred, non-blocking; EI-3782): bring the kit's mac/windows drivers to parity with release-local.sh's WITH_MAC/WITH_WINDOWS legs before making release-local.sh a thin wrapper. Gaps: mac updater artifact is .app.tar.gz served for BOTH darwin arches (needs a kit model change — one artifact → multiple platformKeys), PAPERCUP_DOGFOOD_REPO_REF, full-tree rsync, audit-bundle the dmg. Needs live mac/win VM verification. Until then release-local.sh stays the cut tool (its target-dir bug is already fixed). A wholesale wrapper now would regress mac/win — deliberately NOT done.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Oddsmith adoption |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `todo` — low

FOLLOW-UP (deferred, non-blocking; EI-3782): bring the kit's mac/windows drivers to parity with release-local.sh's WITH_MAC/WITH_WINDOWS legs before making release-local.sh a thin wrapper. Gaps: mac updater artifact is .app.tar.gz served for BOTH darwin arches (needs a kit model change — one artifact → multiple platformKeys), PAPERCUP_DOGFOOD_REPO_REF, full-tree rsync, audit-bundle the dmg. Needs live mac/win VM verification. Until then release-local.sh stays the cut tool (its target-dir bug is already fixed). A wholesale wrapper now would regress mac/win — deliberately NOT done.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Oddsmith adoption |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/harness-to-hive-rename-2026-06-29</code> — Rename: harness → hive, parent "Hive" → meta-hive (concept + code; DB identifiers stay internal) — <strong>4 residual</strong> (4 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | aviynw@gmail.com |
| Updated | 2026-06-29T19:26:20.287Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

Rename the concept everywhere humans read it: docs/MDX, UI labels, the Hive/Swarm/Colony lexicon (harness→hive, Hive→meta-hive; Swarm + Colony unchanged), persona/playbook text, and the coord legend. Fully reversible; delivers most of the clarity benefit before any code changes.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Docs, lexicon & UI (zero runtime risk) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Rename TS domain symbols: HarnessRecord→HiveRecord, resolveHarness→resolveHive, harnessRegistry→hiveRegistry, etc. EXCEPTION: leave symbols that directly mirror the DB column harness_slug at the SQL edge as-is (minimize the translation surface). Type-checked, mechanical.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — TS domain symbols |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Flip the kind discriminator in lockstep: kind:'harness'→'hive' (plain unit) AND kind:'hive'→'meta-hive' (federation-root home) together. Includes the tiny stored-value data migration (2 values) — see decision on include vs defer.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — kind discriminator |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

Coordinated 3-way swap, applied together to avoid collision: harness:*→hive:* AND existing hive:*→metahive:* (namespace token 'metahive', no hyphen → tool name metahive_create). Grep + update ALL callers: recipes, saved_prompts, ~/.claude hooks, persona/coord legend, docs examples. No deprecation aliases (alpha rule) — every caller flips in this change.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Tool-namespace cutover (wire contract — do last, atomic) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

### Ready plans with live work (lifecycle drift) (4)

<details>
<summary><code>papercusp/green-checkpoint-speedup-follow-up-2026-08-13</code> — Green-checkpoint speedup follow-up — <strong>6 residual</strong> (1 todo, 5 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T09:35:22.943Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | `su-ef53baf7-bc74-4dd1-bda9-f05b8424d43f`: Implement P-001 early changed-file preflight with regression coverage, then advance the green-checkpoint speedup follow-up in dependency order |

#### P-002 — `blocked` — high

Replace serial affected-test task execution with a longest-first scheduler constrained by one explicit global worker/fork and memory budget; preserve the existing per-task commands, deterministic reporting, failure semantics, and resource-gate rails; add regression tests proving concurrency never exceeds the configured budget.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Implementation |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — high

Reuse passing task verdicts across auto-refired checkpoint candidates when and only when command, environment, gate configuration, and task dependency-closure hash are unchanged; persist the cache atomically, invalidate conservatively, expose hit/miss reasons, and add end-to-end invalidation tests.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Implementation |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — high

Extend the proven pure/stateful lane classifier and fork-reuse split to @papercusp/web, preserving the stateful lane's isolation and coverage; benchmark the same forced selection against the serial baseline and keep the split only if the measured wall-time and correctness bar are met.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Implementation |
| `blocked-by` | `P-003` |
| Unresolved blockers | `P-003` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — high

Instrument every post-suite leg with stable per-leg wall timings and outcome records, identify independent low-memory checks from evidence, then run only those checks in a fixed-budget parallel group while preserving required ordering and fail-fast/final-assurance behavior; test both timing output and dependency ordering.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Implementation |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — high

Add an explicit reserved-capacity execution mode for green-checkpoint using the existing resource-control/config surfaces rather than raising the shared-host fork cap; include operator-visible configuration/diagnostics and tests proving shared-host defaults remain bounded, then run focused and full verification and close the plan with measured before/after evidence.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase — Implementation |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Add an early changed-file preflight before the full affected-test sweep: run the cheapest deterministic changed-file typecheck/lint checks that can reject a doomed candidate, retain the full post-suite checks for final assurance, emit explicit timings/outcomes, and cover ordering plus fail-fast behavior in the existing green-checkpoint test framework.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Implementation |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/p2p-public-release-remaining-lanes-2026-07-16</code> — Shared-hive p2p → public release: remaining non-git, non-coordination lanes (data-plane convergence, work-distribution activation, attestation, mem0 witness, packaging + GO/NO-GO) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T09:27:29.098Z |
| Now | **RELEASE-BLOCKER #3 (gate coverage) IS CLOSED — the GO/NO-GO is CONDITIONAL-GO on THREE rows, was four.** RELEASE-READINESS.md rewritten accordingly (verdict + §3 + §5 + row 31).  Two things landed, both live-evidenced: 1. **The gate went GREEN** — `content-matrix=PASS from-repo=PASS from-repo-witness=PASS local-matrix=SKIPPED build=OK` (run 20260801-143855, 2026-08-01T15:01:14Z). First from-repo-witness green since D-016 un-skipped it; `WITNESS OVERALL: PASS` proves AK-ban EN-4 drop + unban teeth + the device-filtered C-001 re-key cut (K1/K2/K3) + the content cut (K4b) on the packaged binary. 2. **membership_churn EXECUTED FOR THE FIRST TIME IN ITS HISTORY AND PASSED** — `roster a=2 b=2 c=2; backfill=hello-world\|remote; C→A/C→B ok` (3-frame rig, triage stamp 151402). SCOPE, carried deliberately: this proves the LEG, not full-matrix coverage (16/18 scenarios were --only-skipped) and it did NOT write the gate's `last-matrix-verdict`.  Gate hardening also landed: the red-filing boilerplate no longer calls a from-repo-witness RED "EXPECTED" (that text rode into filed tickets — WI-6540 carries it), and `file_ei`'s outcome is no longer ignored (an unconfirmed filing used to stamp a red "already tracked" and suppress re-filing; the 2026-07-31 RED has no work-item as a result). Both `bash -n` clean.  **OWNERSHIP CHANGED 2026-08-01T23:37Z — see D-019.** The prior holder/leader su-7c8677a2 is `ended` + `resumable:false`. su-e02f5c3d took `p2p-release` leadership and reclaimed P-205 (which was `pooled`/`holder:null` all along — the hold existed only in this block's prose). |
| Next | P-205 (LIVE-2 drill) is now held by **su-e02f5c3d** — claimed 23:37Z, uncontested (`pooled`, no live claim), work-item WI-5135 resumed; the prior "HELD by su-7c8677a2 — live … Do NOT take it" text was stale on both premises and is superseded by **D-019** (which also states the general rule: a prose hold is a lead, not a verdict — resolve the holder's current `sessionState` and the item's current `plan_items:status` before honoring it). Next concrete action on this lane: the gate's own local-matrix window opens ~2026-08-02T02:00Z (`last-matrix-verdict`=1785117639 + MATRIX_TTL_H=144h, with a MATRIX_STALE_H=192h detector behind it) and will produce the standing 18-scenario verdict INCLUDING membership_churn — do **not** force an out-of-window rig run against it; sequence WI-3965 (the aviynw↔papercupai multi-account leg, also held by su-e02f5c3d) AFTER that window, since it needs the 2-machine rig and both accounts live. Unchanged for anyone else: blocker #2 (hive-git live legs) belongs to plan `p2p-git-live-activation-2026-07-09` — do not duplicate its diagnosis; blocker #4 (code-signing certs) is owner-supplied and unclearable by any agent. |
| Live presence | `su-12228b46-71c0-46d6-9ff3-3f642b1867e9`: Resume WI-37110 P2P coordination release-readiness after compaction; first unblock verified git-sync push failure<br>`su-f0630b86-4697-4877-8891-17b7af85ca55`: Resume EI-20329530284626235: repair git-sync submodule URL drift after confirming resource/checkpoint state |
| Plan-level linked work | `WI-5128` [done] WI-1964: mac-VM shows 673 work items vs 2229 on tower — root-cause the work-item federation incompleteness (backfill vs filter vs apply-stage), fix durably, and extend the table/column completeness g…<br>`WI-5129` [done] Moderation witness LIVE run (WI-283 is built-but-NEVER-executed; ledger row 19): run both legs (takedown federation + report federation, MODERATION_PROBE=1 rider) on a CURRENT build on a quiet box; r…<br>`WI-5130` [done] mem0 LIVE witness (mem0 plan P-009, WI-3546 method): shareable-flagged memory federates + projects `origin=remote` on the peer; non-shareable NEVER leaks; egress stays dark-by-default per owner desig…<br>`WI-5131` [passed] OWNER DECISION (the fork everything below inherits): public-release posture for foreign-work EXECUTION — (a) ship v1 with offers/directory/pull visible but the executor-spawn leg dark (P-105 sandbox …<br>`WI-5132` [done] Puller activation (WI-1936): flip the standing supervisor-owned puller live after the claim-path soak; live-verify M11 grant-confers-no-allotment, allotment round-trip, loud-refusal receipts on real …<br>`WI-5133` [done] Push-nudge wiring (WI-1939, deferred-to-rig): wire the pure push-nudge module — latency-only, never correctness; verify no wake-flood (rate cap holds).<br>`WI-5134` [done] Executor-spawn leg (WI-1937) per the P-201 decision: if (b), wire spawn through the P-105 sandbox with revocation-reaping re-verified; if (a), document-dark with a registered flag posture + loud refu…<br>`WI-5135` [open] LIVE-2 end-to-end acceptance drill (WI-3545 / P-305 spec; = readiness-plan P-007): offer→pull→spawn→receipts→revocation, every leg observable from the origin, any silent leg = FAIL; run on the 2-mach…<br>`WI-5136` [done] Attestation flow LIVE verification (WI-1730, ledger row 18): second-device attestation, membership seeding, adversarial probes (unattested device, wrong gh user-id) MUST increment refused-op counters…<br>`WI-5137` [done] Standing local release gate FIRST GREEN (ledger row 22): run the armed hourly gate (P-013 machinery, proven-to-fire) against a post-P-401 artifact in a quiet slot; keep the green-TTL current. "Gate a…<br>`WI-5138` [done] Owner-walls package for ship (assemble asks + verify each once supplied): code-signing certs (Windows Authenticode + Apple Developer ID — mac app currently `spctl` REJECTED, Gatekeeper blocks install…<br>`WI-5139` [done] FINAL signed GO/NO-GO resynthesis of `shared-pot-release-testing/RELEASE-READINESS.md` (= readiness-plan P-014): every row green-with-evidence or explicitly owner-waived — folds in the git lane's can…<br>`WI-5763` [done] WI-5672 ROOT CAUSE — the FIRST cold restart after a fresh join fails to re-establish replication within 90s, while LATER restarts recover in ~3s. Newly characterized 2026-07-25 (su-055ae): a targeted…<br>`WI-5764` [done] WI-5441 — item-assignments boot-window federation hole: rows written in a narrow window at boot silently NEVER federate, permanently, with no error. A real DATA-LOSS class and a public-release blocke…<br>`WI-5765` [done] Wire superviseForeignSessions into production (split from P-406 per D-004): the H12/H13 foreign-session liveness + orphan-origin wind-down sweep exists but is unscheduled, and its documented producti…<br>`WI-5766` [done] ATTESTATION + TRUST CLOSURE RE-VERIFY (P-301 is marked done — confirm that evidence actually holds, then extend): second-device attestation on a real second frame, membership seeding, and ADVERSARIAL…<br>`WI-5767` [dropped] GATE FIRST-GREEN CLOSURE (critical path; owns P-402's last mile): the ONLY remaining local-matrix failures are content_bidir / planpart_bidir / coord_bidir / concurrent_lww, and they are HOST-CONTENT…<br>`WI-5768` [done] SCENARIO-ASSERT INTEGRITY AUDIT (generalizes the WI-5715 class — high leverage). WI-5715 held this release gate red for its ENTIRE history via an assert that could never pass (unscoped in time AND ha…<br>`WI-5769` [done] PACKAGING + RELEASE-READINESS SWEEP (non-rig, parallel-safe): verify Apple-Silicon arm64 build parity actually builds and boots; confirm the P-401 bundled-artifact freshness guard still holds (the st…<br>`WI-5771` [done] WI-5639 REPLICATION-REPAIR HOLE (LEADER-OWNED — do NOT claim). The 'was replicating -> peer restarted -> replicator detached -> swarm sockets still live' state had NO repair path: zombie axis gated o…<br>`WI-5772` [done] EI-18645423267952485 — restart_settle_barrier reports PASS "order 80 didn't run this session" when restart_durability RAN and FAILED. It skips on empty canary vars and misattributes that to 'did not …<br>`WI-5773` [done] WI-5726 — live-federation-gate has no single-instance lock: the hourly timer and a manual GATE_FORCE run collide on the single-tenant rig. This corrupts other lanes' evidence, so it is high-leverage …<br>`WI-5774` [done] WI-5762 — replication-stall-ei re-files duplicate EIs for a standing replication stall (open-only dedup; 57 duplicates observed). Fix the dedup key so a standing condition owns ONE EI.<br>`WI-5775` [done] WI-971 / WI-5628 — from-repo gate leg RED: outbox drain never wired for joined/created hive harnesses. A from-repo RED is EXPECTED until this lands; a content-matrix / local-matrix / build RED is a N…<br>`WI-5776` [done] EI-18287199424883131 — federation outbox stall: papercusp outbox undrained ~2.3Ms with 19973 rows. Currently 'blocked' — re-triage against current state; may share a cause with the from-repo drain ga…<br>`WI-5777` [done] WI-5719 — papercup-isolated-dht liveness probe FAILED (bootstrap unreachable/wedged). Substrate-level: a wedged bootstrap silently degrades every federation path.<br>`WI-5778` [done] FRAME LOG FORENSICS: /home/pcusp/serve.log has NO TIMESTAMPS on most lines, so cycle-to-line correlation needs fragile boot-marker bucketing (cost real hours on WI-5639/WI-5665). Add a timestamp pref… |

#### P-205 — `todo` — high

LIVE-2 end-to-end acceptance drill (WI-3545 / P-305 spec; = readiness-plan P-007): offer→pull→spawn→receipts→revocation, every leg observable from the origin, any silent leg = FAIL; run on the 2-machine rig. Needs rig green (git lane) + P-202 (and P-204 if posture (b)).   — note: ← WI-5135 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Work-distribution activation (absorbs p2p-rest-lanes P-007/P-008; owner-gated) |
| `blocked-by` | `P-202` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/voice-public-release-refresh-2026-08-11</code> — Voice features — public-release readiness refresh — <strong>3 residual</strong> (1 todo, 1 wip, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-13T09:02:50.910Z |
| Now | Fresh public-release pass started 2026-08-11 in owner-directed AUTO mode. Prior desktop, mobile, TUI, cloud-agent, and channel voice work exists, but the last broad GO and rubric evidence are from mid-July. Current source already supersedes at least one still-open ledger item, so this plan re-verifies the product and reconciles the record. |
| Next | Complete P-001 from current source and canonical state, then drive every dependent verification/fix item to terminal and publish a fresh rubric-backed ship verdict. |
| Live presence | `su-cb2b4405-151f-48b2-800f-4c50f980cd86`: Resume voice public-release readiness; repair sanctioned git-sync durability blocker, then finish P-004/P-005/P-006 |

#### P-004 — `wip` — high

Verify mobile LISTEN mode selection and streaming semantics, retained ElevenLabs compatibility, P2P channel join/mute/audio state, and TUI voice wiring using live or hermetic release-representative paths.   — note: Claimed for current cross-surface mobile/P2P/TUI release verification under owner-directed AUTO.

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 3 — Live product verification |
| `blocked-by` | `P-002` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — urgent

Produce a fresh `desktop-voice-release-readiness` scorecard plus cross-surface voice verdict, verify the shared green checkpoint/pipeline, close or clearly disposition residuals, and mark this plan shipped only with reproducible evidence.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Hardening and release verdict |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — urgent

Resolve every release-relevant defect found by P-002 through P-004, add recurrence coverage, and re-run affected gates until green; explicitly reconcile stale open voice items proven fixed.  P-004

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Hardening and release verdict |
| `blocked-by` | `P-003` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/p2p-git-live-activation-2026-07-09</code> — P2P git (hive-git) live activation: wire the replication plane, prove it on the 2-machine rig, run a real bridged hive — <strong>5 residual</strong> (2 wip, 3 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `ready` |
| Owner | — |
| Updated | 2026-08-09T03:16:54.669Z |
| Now | LIVE-LEG PUSH (2026-07-27 04:30Z, su-a8ea9a, WI-6276).  ⚠ CORRECTION: the prior Now said "P-404 explicitly requires the owner (surface, do not self-ratify)". That contradicts this plan's own Decision D-001 (owner Avi 2026-07-10), which states in terms: "This resolves the human-decision half of P-404." Only oddsmith's migration is unaddressed. Do NOT re-surface default-mode as an open owner fork; execution is gated on P-402 soak-green, a different gate from owner consent. This prose-vs-Decision drift was carried forward twice by agents reading ##Now instead of ##Decisions.  RIG (172.31.44.2, pid 76101, booted 04:14Z): health ok, fatal=0, oom=0, relation-errors=0. The "Jul-17 vintage / db-sql 614" caveat is STALE — the bundle was rebuilt from the current tree TODAY (migration 683).  EI-18765930091826096 (channel degrades until it serves nothing; only a restart clears it) is FIXED + DEPLOYED to the rig — a session lifecycle leak, not a transport fault. Verified in the RUNNING bundle by identifier grep against a known-present control. WI-6272 adds the DETECTOR whose absence made it take days: pot-git sessions had NO observable surface on a live peer.  WHY LIVE LEGS AREN'T SELF-PROVING: the rig is WARM, so G-8 bootstrap short-circuits every tick. runBootstrapLeg resolves ONE repo per registry entry; rig's real registry (harness_shared.harness_registry in PG — workspaces registry.json is vestigial, 0 projects) has 3 entries: hello-world -> hello-world-3-pot/gh-1296269 and papercusp -> papercusp/papercusp already hold peer namespaces; hello-world-3-pot resolves no potHomeSlug and early-returns. git-sync IS firing (10-min cadence) with nothing to do. The rig's ENTIRE log shows pot-git serves 100% REFUSED (8/8) — never one successful fetch, so any "clean" reading is a FALSE GREEN.  IN FLIGHT: gh-1296269 backed up (/tmp/gh-1296269-preclean.tgz) and removed 04:30:27Z to create a genuine cold condition; the 04:39Z tick must run bootstrapFromPeer over the real bridge/DHT. |
| Next | Read the rig's 04:39Z git-sync tick: confirm bootstrapFromPeer ran, a non-REFUSED pot-git serve appears (baseline 8 serves / 8 refused), and gh-1296269.git is re-seeded with peer namespaces. WI-6272's detector should stay SILENT on a 496K repo (converges on rung 1) — a 'sessions HIGH' warn would itself be a finding. If the tick does not bootstrap, instrument the leg's three silent gates rather than guessing. THEN consider the papercusp/papercusp.git (3.5GB) cold join — the only store big enough to force a multi-rung ladder with abandonable rungs, i.e. the sole live reproduction of the leak condition. Do not conflate "the cold join works" with "the leak is fixed under a failing ladder". Also: hive-git-drill.sh LEG A merely runs bootstrap.integration.test.ts, and two-instance-hive-from-repo-smoke.sh joins via GitHub clone_repo — so P-403 still has no driver. |
| Live presence | `su-686a92b3-385e-4f2d-a12f-2423346965bb`: Resume P-505 live replication/restart evidence after compaction; verify tower and Mac substrate state without duplicating active checkpoint candidate ffc6da53 |
| Plan-level linked work | `WI-3485` [done] Record baselines in ##Now and re-verify done-ness: hive-git unit (181/181) + integration (154/154) suites re-run at HEAD; tsc slice over lib/sync/hive-git + git-sync; spot-audit 3 Phase-7 G-items' co…<br>`WI-3486` [done] Root-cause + durably fix the 2026-07-08/09 git-sync stall wave (watchdog rows on ~10 harnesses; open kin WI-1415 DBOS routineFire stall, WI-3402 bg-host CPU starvation). Member commit loops are the p…<br>`WI-3487` [done] LIVE rig readiness: tower + iMac VM (runbook `docs/plans/LIVE-1-rig-runbook-2026-07-02.md`); verify swarm connects AND scope-core replication SUSTAINS (the 07-03 churn signature: connects form, same …<br>`WI-3488` [done] Cross-machine fed replication green both directions (fed_event emitted on one machine lands in the peer's coord:feed and fires its await; probes /tmp/p059-e1c.sh + /tmp/p059-rev2.sh). SUPPORT the WI-…<br>`WI-3489` [done] In-process regression rig: reuse the WI-2716 two-peer federation seed rig to reproduce the replication-sustain fault locally (suspected class: VM core-key regen on app restart orphaning replication s…<br>`WI-3490` [done] Serve plane: wire `serveUploadPack` onto the hive-swarm connection (the `papercusp/hive-git` Protomux channel) behind the landed scope-serve-gate (`authorizeScopeRepoServe`, fail-closed, per-fetch me…<br>`WI-3491` [done] Announce→fetch driver: on member commit (git-sync tick, non-legacy mode) publish sigrefs + emit the ref-announce federated event; on receiving a peer's announce, verify sigrefs-lite (G-4, rollback-pr…<br>`WI-3492` [done] Integrator runtime: the lock-authority lease holder runs the integrator tick (merge member namespace heads → publish canonical staging in its namespace + signed staging-advance announcement with epoc…<br>`WI-3493` [done] Worktree-bridge driver: on staging-advance event, advance the local worktree ff-only (G-7c — never reset --hard; refuse when dirty∩incoming ≠ ∅; honor live file locks G-7b).<br>`WI-3494` [done] Wiring completeness pass: G-8 cold-clone bootstrap reachable for a joiner; G-9 gc scheduled (tier:ephemeral blueprint schedule, not a bare interval); G-10 secrets guard + oversized-blob guard on the …<br>`WI-3495` [done] Drill scaffold: repeatable `hive-git-drill.sh` (mirror cc992's work-distribution-drill.sh — per-leg SKIP-with-reason, every leg observable from the origin machine), run tower↔VM against a THROWAWAY t…<br>`WI-3496` [blocked] Leg A storage + join: both machines hold the (hive, repo) bare store with correct namespace layout (G-1/G-1b); VM cold-joins via G-8 bootstrap from the tower peer; shared ODB, single-writer namespace…<br>`WI-3497` [done] Leg B replication: commit on tower → sigrefs + announce → VM auto-fetches the namespace over the hive-git channel (native v2 pack negotiation, not bundles); record latency + object counts; reverse di…<br>`WI-3498` [done] Leg C trust: sigrefs verification on fetch; TAMPER drill — relay peer serves a lying head for a third device's namespace → fetch REFUSED loudly (receipt/counter); non-member fetch refused by the scop…<br>`WI-3499` [done] Leg D integration: integrator computes + publishes canonical staging; the OTHER machine's worktree advances ff-only without touching locked/dirty files; a non-steer member's head lands in the integra…<br>`WI-3500` [blocked] Leg E GitHub bridge live: flip the TEST hive `hiveGit.mode='bridged'` → members go commit-only (verify the git-sync stall watchdog does NOT false-alarm on commit-only members), bridge writer alone pu…<br>`WI-3501` [done] Leg F lifecycle: G-9 gc respects keep-work/last-N/departed-member archival on real repos; G-10 secrets guard blocks a planted credential from publication; oversized-blob boundary holds.<br>`WI-3502` [done] Leg G chaos: kill the integrator machine mid-advance → lease failover + epoch fence rejects the stale advance; PG blip on a bridged hive → double-push window resolves as a noisy FF/CAS reject (verify…<br>`WI-3503` [done] Canary activation: flip a real hive to `hiveGit.mode='bridged'` (default candidate: shared-hive-test; disclose if different), /admin/git renders mode + bridge pill, fleet announced. Rollback lever do…<br>`WI-3504` [blocked] 72h soak: divergence verdicts quiet, zero watchdog false alarms, member commit loops healthy, fork stays current via bridge egress; daily burn-down note in ##Now.<br>`WI-3505` [done] Cold-join a fresh third instance to the canary hive via G-8 bootstrap — proves the joiner path on a real hive, not just the drill hive.<br>`WI-3506` [blocked] Owner decision: default `hiveGit.mode` posture for NEW shared coding hives (keep legacy-default + per-hive opt-in vs bridged-by-default once the soak is green), and whether oddsmith (the live release…<br>`WI-3507` [done] Ops runbook (agent-insights doc): mode flip + rollback, integrator lease + epoch semantics, divergence triage, sigrefs failure modes, drill re-run instructions, watchdog interplay under commit-only m…<br>`WI-3508` [done] Regression rails: hive-git integration suite included in the affected-test walker + green gate; drill runnable on demand from the repo; any quarantined test carries an accountable de-quarantine follo…<br>`WI-3509` [todo] Close-out: update `cross-machine-coord-parity` (P-059 linkage) + `github-bridge-hive-egress` ##Now to point here; facts:assert the durable conclusions (which hives run which mode, drill location, rol… |

#### P-402 — `wip` — normal

72h soak: divergence verdicts quiet, zero watchdog false alarms, member commit loops healthy, fork stays current via bridge egress; daily burn-down note in ##Now.  (← WI-3504 released) — note: UNBLOCKED — WI-5395 fixed+live-proven; soak clock restarted 2026-07-19 00:40Z covering BOTH the bridged canary AND the real bridged papercusp hive (real traffic = the fleet's own git-sync commits every 3 min)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 4 — Canary activation + soak (first real hive) |
| `blocked-by` | `P-401` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-505 — `wip` — high

Wire the G-0 epoch grant for production failover (the integrator leg's own "needs the G-0 grant wired in before Phase 3's drill" note + the WI-3497 drop-forever class): (a) integrator leg derives its publish epoch via handoff-token adoption (token.epoch+1, seeded base) with the P-038 crash path (bridge watermark > own integrator watermark ⇒ takeover ⇒ epoch+1, base = max observed staging) and publishes a continuously-refreshed handoff token after every advance; (b) worktree-bridge leg derives maxGrantedEpoch from verified handoff tokens (not its own stale integrator epoch); (c) retryable rejections (unknown-sha, ungranted-epoch) STOP the batch and hold the fed-event cursor (age-bounded) instead of being dropped forever; (d) deploy tower bg-host + mac serve, then re-run the physical freeze-failover drill live.  — note: su-71c69 building now [owner:Avi 2026-07-18 production-release directive]. Design per existing in-repo specs (G-0/P-033/P-037/P-038, D-011, staging-advance.ts docs) — no new invented shapes: continuous-will handoff token; crash-takeover epoch = max(foreign evidence)+1; receiver cap = max(own epoch, verified tokens' nextEpoch); retryable-rejection cursor hold mirrors the existing fetch-failed stop contract.

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 4 — Canary activation + soak (first real hive) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-302 — `blocked` — normal

Leg A storage + join: both machines hold the (hive, repo) bare store with correct namespace layout (G-1/G-1b); VM cold-joins via G-8 bootstrap from the tower peer; shared ODB, single-writer namespaces verified.  (su-d044a claiming — live storage+cold-join drill vs tower↔iMac VM rig) (re-claim refresh post-compaction; bg-host P0 resolved 4c5f0, resuming live rig verification) (re-claim after compaction; awaiting su-4c5f0956's build-linux-local.sh Server .deb rebuild before live drill leg A) (← WI-3496 released) (Paused per owner directive 2026-07-11 token conservation; p2p/shared-hive deferred to post-next-release. Was blocked on WI-4070, now root-caused to peer-dial-registry.ts channel-onclose not DHT/dial. See WI-3496 checkpoint for resume path.) (Resumed post-unpause [owner:Avi 2026-07-11]. Still gated on WI-4070; corroborating tower-side psql.) (← WI-3496 released) (Wound down per owner directive 2026-07-11 09:03 EDT "wind down, we'll continue later" — resumable. Still gated on WI-4070 peer-dial-registry.ts channel-onclose. See WI-3496 checkpoint for full resume path.) (← WI-3496 todo) (← WI-3496 todo) (← WI-3496 completed passed) — note: ← WI-3496 blocked

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — Live 2-machine hive-git drill (LIVE-G gate — in-process green != live green) |
| `blocked-by` | `P-301` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-306 — `blocked` — normal

Leg E GitHub bridge live: flip the TEST hive `hiveGit.mode='bridged'` → members go commit-only (verify the git-sync stall watchdog does NOT false-alarm on commit-only members), bridge writer alone pushes the fork; ingress→admission watermark→FF egress of refs/hive/staging; divergence drill (force the fork ahead → 'github-bridge' escalation verdict).  (Reconciled post-compaction: leader HOLD stands, refreshing claim.) (← WI-3500 released) (← WI-3500 todo) (← WI-3500 released) (← WI-3500 released) — note: ← WI-3500 blocked

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — Live 2-machine hive-git drill (LIVE-G gate — in-process green != live green) |
| `blocked-by` | `P-301` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-404 — `blocked` — normal

Owner decision: default `hiveGit.mode` posture for NEW shared coding hives (keep legacy-default + per-hive opt-in vs bridged-by-default once the soak is green), and whether oddsmith (the live release-gate canary) migrates to bridged.  (← WI-3506 released)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — Hardening, ops, close-out |
| `blocked-by` | `P-402` |
| Unresolved blockers | `P-402` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

### Draft plans with residual items (38)

<details>
<summary><code>papercusp/claim-spec-aware-drain-analytics-2026-08-12</code> — Claim-spec-aware drain analytics without SQL fallback — <strong>8 residual</strong> (1 todo, 7 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-12T17:19:59.950Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — high

Build a shared server-side aggregate query path that evaluates the complete scoped population in one consistent snapshot. Exact aggregate counts must not depend on listWorkItems or WORK_ITEMS_MAX_LIMIT; bounded item samples remain a separate concern.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Contract and query core |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — high

Extend work_items:burn_down with claim-spec-aware scope plus explicit start/end or cohort cutoff inputs. Return the resolved spec source and revision, state rules, temporal basis, baseline stock, current stock, opened, closed, and net change.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — First-class tool surface |
| `blocked-by` | `P-001`, `P-002` |
| Unresolved blockers | `P-001`, `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — high

Add creator and closer partitions, completion-authority and verification breakdowns, structured duplicate-link counts, and evidenced code-change/no-change classes where the ledger supports them. Label structured duplicates as a lower bound; never equate filing state with bug validity.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — First-class tool surface |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — high

Separate semantic completeness from presentation size: exact aggregate sections expose censusComplete/sourceRows or a precise lower-bound reason, while item examples use cursor pagination and independent sampleTruncated metadata. Reserve transport spill/preview metadata for serialized-result truncation.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — First-class tool surface |
| `blocked-by` | `P-003`, `P-004` |
| Unresolved blockers | `P-003`, `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — high

Add canonical tests covering more than 2,000 matching rows, claim-spec parity, created-versus-closed timestamp windows, frozen cohorts, fleet-ever-member attribution, structured duplicate links, completion authority, snapshot consistency, and compatibility of existing callers.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Verification and adoption |
| `blocked-by` | `P-003`, `P-004`, `P-005` |
| Unresolved blockers | `P-003`, `P-004`, `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — normal

Update tool descriptions and drain-leader guidance so agents choose work_items:claimable for live eligibility and work_items:burn_down for historical stock/flow, and can distinguish census truncation from transport spill without reading the writer.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Verification and adoption |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — high

Dogfood one burn_down call against the preserved 2026-08-12 SQL measurements, explain any time-snapshot differences, confirm bounded query cost, and prove the original questions—whether the drain is growing the queue and how much is duplicate or evidenced—no longer require SQL.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Verification and adoption |
| `blocked-by` | `P-006`, `P-007` |
| Unresolved blockers | `P-006`, `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Define the burn-down contract: claim-spec id/revision and historical window or frozen cutoff; baseline/current stock; opened/terminal flow; creator/closer attribution; structured duplicate and completion-evidence classes; and per-section provenance/completeness. Reuse the existing scheduler claim-spec compiler, claimability semantics, fleet membership ledger, and work-item lifecycle writers.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Contract and query core |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/agent-managed-compaction-2026-07-01</code> — Agent-managed compaction — self-set soft limits (DB-tracked), projected instructions, watchdog backstop — <strong>11 residual</strong> (11 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw8@gmail.com |
| Updated | 2026-08-12T05:28:04.745Z |
| Now | Owner-directed 2026-07-04 (implement start-to-finish). su-60160 has LANDED FOUR items this session (all code + unit tests green + operator-core typecheck clean + no broken consumers; ride the next green pin): **P-016** estimator cohort-independence (the root null-estimate fix), **P-012** watchdog FORCE-COMPACT rung (default-ON flag COMPACTION_WATCHDOG_FORCE_COMPACT), **P-014** CC autoCompactWindow in psu-launcher.mjs (binary-verified fire math — D-010), **P-017** watchdog live-config reach (lowers stale-above-cap limits to the current shaped default and cascades into force-compact — the '7 live members stuck at 500k' gap). Escalation ladder complete AND self-healing on a policy change: cohort-independent estimate (P-016) → per-turn reminder ≥85% → watchdog force at 100% (P-012) → CC mechanical at 120% (P-014), with running sessions re-limited within one sweep (P-017). config:tiers-set (300k member / 400k leader) already live for new launches. |
| Next | su-60160 continuing (owner directive): REMAINING = P-018 (boot self-assert critical config + max-age fleet-member recycle) + the two D-009 awareness layers P-013 (banded gauge at the agent-mcp result-wrapper/applyPayloadTier seam, reading cached coord_presence.context_tokens) + P-015 (Claude Code PostToolUse hook for the zero-MCP-call heads-down case). Then a live [1m]-launch smoke of P-014 when an account slot is affordable (pool at 7d caps, WI-2376). Compacting at 88% now (autoContinue) — resume from the loop carry-note. Don't re-fire the green gate (windows-parity lane owns it; pin 144d3aee). |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

Confirm on installed Claude Code: `# Compact Instructions` in **root/user** CLAUDE.md honored for auto-compact + `/compact`; `@import` resolves; whether inline `/compact <focus>` composes-with or replaces the CLAUDE.md section (assume replaces); psu-launched Claude uses Claude's built-in auto-compact default (repo sets no `autoCompact*` keys).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Verify Claude wiring |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

Author `papercusp-compaction.base.md` + per-target overlays with a `PAPERCUSP-COMPACTION:CLIENT-OVERLAY` marker. Seed items (1)–(9), including the self-management protocol and the pointers-not-copies section grounded in the safe/at-risk table.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Canonical source + seeded content (Strand A) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — high

Extend the existing splice projector (`splice-tooling-overlay.ts` + `papercusp-files.ts` + `install-standalone-mcp.sh`) to emit the compaction targets from base+overlay. No second projector.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Projection into the controllable summarizers |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

Operator converse brain: feed `buildCompactionPrompt` (`operator-conversation-compaction.ts:86`) from the rendered canonical text, preserving the incremental fold, `MAX_SUMMARY_CHARS`, and the injectable-`SummarizeFn` test seam.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Projection into the controllable summarizers |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — high

Claude floor: render canonical → stable file (`~/.papercusp/compaction-strategy.md`); add a fixed `# Compact Instructions\n@<path>` stanza to root/user CLAUDE.md (never nested; never `~/.claude/AGENTS.md`).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Projection into the controllable summarizers |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — high

`set_compaction_limit` endpoint + DB persistence on the session record; default per model/harness; clamp `limit × 1.25 ≤ model_window − margin` and under built-in auto-compact; read-back on status/roster.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Agent-managed control plane (the core) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — high

Per-turn usage-signal injection: estimator (OMP token meter; Claude/Codex char/4 over JSONL) + inject `context: N/limit (X%)` each turn via the coord-injection pattern. This is the linchpin that lets the agent self-regulate.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Agent-managed control plane (the core) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — high

`session:request_compaction` agent tool → harness executor: Claude PTY-inject `/compact <canonical>` post-turn (idle-gated on `parked`, backend-aware CR-split); operator brain programmatic; OMP native. Post-exec verification.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Agent-managed control plane (the core) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — normal

Extend the watchdog loop (`adv-roster`/`fleet-roster` iteration, gate on `deriveSessionState`) to read DB limit + estimated usage and escalate non-compliant agents: nudge → force-compact → alert. Backstop only; agent is primary. Hysteresis to avoid thrash.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Watchdog backstop (may spin out) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — high

`gen:compaction` re-render in the prompt-projection lifecycle; do-not-hand-edit banner; drift-check test (mirror `gen:borrowable:check` + MEMORY.md SessionStart regeneration).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Regeneration + drift guard |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — normal

vitest + typecheck green: splice targets; operator-brain-from-canonical; Claude `@import` resolves; `set_compaction_limit` clamp/default/persist; usage-signal estimator + injection; `request_compaction` executor idle-gating + CR-split + verification; watchdog thresholds/hysteresis; drift guard. Sweep stale prose.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Tests + rollout |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/fleet-deltas-leader-primitives-2026-07-10</code> — Fleet-system leader primitives: reply deadlines, checkpoint integrity, leader-hold, DELTA-NATIVE orient (server-side read cursors), context pressure, predicate watches — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-12T04:26:04.624Z |
| Now | All SIX implementation items DONE and type-clean (P-001 agent-facing since_ts deleted from coord:inbox + coord:plan-events with consumers migrated; P-002 EI-9389 settle relocated server-side, which EXTENDS coverage to all CLIs rather than preserving it; P-003 coord:watermark-set retired, residue swept incl. the submodule's Overwatch MCP kit; P-004 turn-start orientation fold; P-005/P-006 measurement). Nothing left to BUILD.  ACCEPTANCE RUBRIC: RE-AUTHORED and VERIFIED GATE-VISIBLE (04:2xZ) — status=active, kind=acceptance, subjectPlan set, classRef=plan-class-feature-ship, 5 criteria with method+driftMarkers preserved byte-for-byte. This did NOT need the deploy: D-015's precondition was wrong and is corrected by D-016 — the requirement is a CURRENT-CODE DOOR, and :3170 staging is one.  ⚠ DO NOT GRADE IT YET, and the reason is NOT the old one. evaluatePlanAcceptanceGate accepts any COMPLETE, independent, non-synthesized scorecard and never inspects rating VALUES — so an all-'unknown' grading opens the gate. Criterion 5 (orientation-adoption-improves) is by design not measurable until the P-004 fold is live on :3070 PLUS a comparable post-deploy window. Grading now would ship this plan with its central thesis unverified. Filed as EI-20219715294870013; guard note on WI-38066.  BLOCKER: the shared green gate (9 consecutive reds, ~20h). Root cause FOUND + FIXED by me — a prompt-weight budget breach, blender:grade-idea 1512 vs the 1500 cap, trimmed and verified 7/7 green. NOT tool-catalog drift (that theory retracted). Fix is committed at staging HEAD; the in-flight candidate a16e2c6b predates it, so expect one more red. |
| Next | Wait for the candidate cut AFTER commit 54bc2039d2 (which carries the budget fix) to go green — do NOT fire a manual release:checkpoint-run into an in-flight run; then on green + :3070 deploy, run WI-38042's P-006 re-measurement (D-010/D-011 baseline: orient_per_1k_calls 2.83, pct_oriented 48.9%; SUCCESS = rate FALLS while coverage RISES), and only THEN have a non-implementer grade the rubric. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-3772` [done] Delta rollout survey: rank orient full-mode folds (plan-events, claimable, facts, fleet catch-up, inbox summary) + coord:catch-up + roster by per-wake token cost; convert top surfaces to cursor delta…<br>`WI-3773` [done] Member context-pressure: heartbeat carries coarse bucket (ok\|high\|critical) into presence + fleet health + P-004 monitor delta; tests<br>`WI-3774` [done] Predicate watches: watch:create { predicate: {tool, args, path, op, value}, intervalSec } — engine-side poll+diff under the CALLER role envelope, wake on threshold cross, audited + fleet-visible; tes…<br>`WI-3775` [passed] Close-out: all flags default-ON, tools-md-sync + budget green, the 7 improvement threads updated with what landed where, owner report incl. delta-rollout token measurements<br>`WI-3776` [done] SYNC_RESOURCE_DELTA cutover (from P-010/D-003): run the attended running-desktop verify MYSELF via the Tauri agent-e2e rig (plans admin open, invalidate-driven re-fetch returns rows-delta, checksum g… |

#### P-006 — `blocked` — high

Verification. Unit tests beside each converted tool (vitest, per the four-frameworks rule). Re-run the adoption measurement from D-004 after the fold ships — coord_owner_id-grouped, NOT spawn_id (per-call here) — and confirm the orient-call rate FALLS while orientation coverage RISES; a fall in both would mean agents are simply less oriented, which is the failure this must not produce. Also re-check dev:orient_dedup_rate: the redundant-recall metric should drop, since the fold removes the reason to hand-fan the subsumed primitives.  — note: ← WI-38051 blocked

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase — D-004 rollout (2026-08-11): finish server-side custody, and stop asking for the read at all |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/context-trimming-tiers-2026-07-01</code> — Context trimming for short-window agents — compaction limits in model tiers, payload tiers (trimmed/standard/full), psu context dedup — <strong>5 residual</strong> (5 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-12T02:55:53.917Z |
| Now | P-030 DONE (D-010: infra green on ornith/OMP xhigh — spine delivery, MCP connect w/ OMP_MCP_TIMEOUT_MS=120000, discovery round-trip, zero 400s; weak-model behavioral gaps documented; probe stopped). P-031 done (D-008/D-009). Green-checkpoint run #2 in flight (unit papercup-green-checkpoint-manual-1fxzuva, started 06:44:43, candidate 7c02acb7 carries sanitizer c63fc1bf + launcher c453c529; verdict ~07:25). P-029 wip: verify items (b) shaped payloads, (c) context N/500k, (d) member task progress, (e) self-compaction. P-027 low (7d re-measure). |
| Next | Green run #2 → deploy to :3070 (then drop PAPERCUSP_OMP_TOOLS_EXCLUDE from omp launch recipes — sanitizer makes it moot) → finish P-029 verify. |
| Live presence | None in final 10-minute window |

#### P-027 — `todo` — low

Post-deploy re-measure (needs ~a week of live trimmed-session traffic): re-run the 7d telemetry (sum(output_size) by tool, transport=mcp, split by ctx_tier sessions), sweep the [payload-tier] ratchet warnings as the next shaper worklist, and record the after-numbers against D-013's baseline

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Trimmed shapers for all frequently-called defineTools |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-013` |
| Linked work-items | None |

#### P-032 — `todo` — high

MCP-server slimming for weak/trimmed sessions: drop playwright-chromium, github, cloudflare-docs (keep context7 optional) from trimmed/weak worker MCP configs in the psu-launcher generation; --with-browser opts back in. One change hitting the ~4-min boot latency, session_start hook-timeout pressure, tool-name mangling surface, and SSE reconnect storms.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Weak-session reliability (folded 2026-07-02) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-033 — `todo` — high

OMP coord-hook session_start hardening: the 30000ms "Extension handler timed out" under load — async-ify/fire-and-forget the slow session_start work + raise the extension-handler timeout (the OMP_MCP_TIMEOUT_MS=120000 pattern). A timed-out hook boots the session in a degraded coord state.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Weak-session reliability (folded 2026-07-02) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-034 — `todo` — normal

Boot-race gate: gate a trimmed session's turn-1 on MCP handshake completion so early tools:find/ToolSearch calls don't miss ("Some MCP servers are still booting").

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Weak-session reliability (folded 2026-07-02) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-035 — `todo` — normal

Trimmed-shaper coverage: enumerate + shape the remaining fat unshaped reads — known gaps work_items:list and the search:* reads; reconcile against the corrected shaper-gap list from the 2-ornith comms probe JOINT-FINDINGS broadcast (msg mr3n3b7b, 2026-07-02 15:08Z) before starting.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Weak-session reliability (folded 2026-07-02) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/luna-audit-fixes-2026-08-12</code> — Luna-audit follow-ups: dropped-reason enforcement, stale-runtime self-diagnosis, capture dedup refusal — <strong>3 residual</strong> (3 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-12T01:11:32.651Z |
| Now | All three items implemented. P-002 (stale-runtime writer) DONE + VERIFIED: migration 799 armed, integration suite 10/10 — it was 4-failed/6-passed before, a pre-existing red (2 failures predating this work) caused by 797 being re-parked after it had been applied live. P-003 and P-001 code complete: 7 unit suites, 260/260 green. Per D-002 the owner-approved similarity-refusal for P-003 was FALSIFIED by measurement and replaced with a recalibration (SOFT 0.85→0.90, which had been firing on 63% of filings) plus a title co-signal refusal; per D-001 P-001 is NOT a dropped-reason gate but a dev:pg_query advisory for the single-surface evidence read that made the audit itself publish a wrong finding. |
| Next | su-62c92bb9: confirm lint:tsc is clean on the six changed files, then report the three fixes and the two falsifications to the owner. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

Dropped-reason enforcement: a terminal `dropped` write must carry a reason on the ROW (terminal_reason), enforced like `done` requires completion evidence. Root-cause first (EI-20203674337042683). Hypothesis to falsify: `dropped` is not in the terminal-state set the completion guard checks.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Audit follow-ups |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

Stale-runtime terminal-writer self-diagnosis: the migration-797 close-refusal must distinguish "invariant violated" from "this running process predates the fix — restart to pick it up" (per-host per D-014; do NOT revert the guard). Live repro: WI-38045 stuck wip in this session.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Audit follow-ups |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-014` |
| Linked work-items | None |

#### P-003 — `todo` — high

Filing-time dedup enforcement in improvements:capture. CALIBRATION CONSTRAINT: my own audit filing sat at 0.85-0.86 against four genuinely-distinct items, so a naive 0.85 refusal threshold is wrong. Measure against the 18 real dup closes before picking the rule.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Audit follow-ups |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/self-improvement-demo-video-2026-07-12</code> — Self-improvement demo video (final cut): Opus grades Sonnet live → rubric/scorecard/blender/mug in the GUI → Sonnet-5 fleet drains the queue — <strong>16 residual</strong> (10 todo, 6 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-09T16:37:02.748Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-4260` [done] Script v1: refine this storyboard into a per-scene shot list + draft narration beats, accurate to the CURRENT system (verify every claim against live behavior; no stale v1 terminology)<br>`WI-4261` [done] GUI rehearsal sweep: click through EVERY GUI surface the storyboard names and verify it shows what the narration claims — Rubrics panel + su-agent-behavior detail; scorecard FULL-detail view (all 21 …<br>`WI-4262` [passed] Fixture seeds: choose the gradee delivery (a real, bounded, camera-friendly task for the Sonnet agent), author the grade-run plan (v1 pattern: agent-behavior-grade-run), and stock the drain backlog w…<br>`WI-4263` [done] Rig prep: re-verify sandbox-desktop capture path end-to-end; terminal layouts for 2-up and fleet tiling; browser profile for GUI capture; confirm psu model/effort specs for opus grader + sonnet:5 mem…<br>`WI-4264` [done] Compaction rehearsal: verify auto-compaction reliably fires within the drain window on ≥1 member (knobs: context budget / task length / seeded long context) AND that the post-compaction re-orientatio…<br>`WI-4265` [done] Blender→Mug→queue path rehearsal: verify a scorecard-grounded blender ideation pass can be triggered on demand, the idea visibly reaches the Mug surface, and it materializes as a work item/plan in th…<br>`WI-4266` [blocked] Capture A (grade act): psu launch of Opus grader → Opus launches visible Sonnet-5 gradee → Sonnet executes the delivery → Opus enters GRADE mode, grades against su-agent-behavior, files scorecard — b…<br>`WI-4267` [passed] Capture B (GUI walkthrough): rubric → full scorecard → blender Ideas → Mug handoff → work item/plan in queue — continuous cursor-guided browser capture<br>`WI-4268` [done] Capture C (drain act): Opus leader raises Sonnet-5 desktop fleet → DRAIN mode → burn-down; capture on-camera: a lock block with holder intent, agents-dropdown session drill-in (turns + Resume/Fork/Fo…<br>`WI-4269` [done] Assembly: per-segment cuts, speed ramps, title/section/close cards, chapter markers; lock the cut<br>`WI-4270` [done] Narration: final post-hoc per-segment script (lockstep to the locked cut), TTS render (kokoro default / ElevenLabs pending owner+billing), audio mix<br>`WI-4271` [blocked] Owner review + publish: review pass, revisions, gen-gallery METADATA entry, regenerate + deploy gallery |

#### P-006 — `blocked` — normal

Blender→Mug→queue path rehearsal: verify a scorecard-grounded blender ideation pass can be triggered on demand, the idea visibly reaches the Mug surface, and it materializes as a work item/plan in the GUI. Known  mug auto-loop flow has a standing "not fully working yet" caveat — verify live, fix or file bugs, and scope the shot to what genuinely works

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Pre-production |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — normal

Capture A (grade act): psu launch of Opus grader → Opus launches visible Sonnet-5 gradee → Sonnet executes the delivery → Opus enters GRADE mode, grades against su-agent-behavior, files scorecard — both terminals on screen throughout

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Capture |
| `blocked-by` | `P-003`, `P-004` |
| Unresolved blockers | `P-003`, `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — normal

Capture B (GUI walkthrough): rubric → full scorecard → blender Ideas → Mug handoff → work item/plan in queue — continuous cursor-guided browser capture

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Capture |
| `blocked-by` | `P-006`, `P-007` |
| Unresolved blockers | `P-006`, `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

Capture C (drain act): Opus leader raises Sonnet-5 desktop fleet → DRAIN mode → burn-down; capture on-camera: a lock block with holder intent, agents-dropdown session drill-in (turns + Resume/Fork/Focus), Git tab, auto-compaction firing + post-compaction re-orientation

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Capture |
| `blocked-by` | `P-005`, `P-008` |
| Unresolved blockers | `P-005`, `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `blocked` — normal

Narration: final post-hoc per-segment script (lockstep to the locked cut), TTS render (kokoro default / ElevenLabs pending owner+billing), audio mix

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Post-production |
| `blocked-by` | `P-010` |
| Unresolved blockers | `P-010` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `blocked` — normal

Owner review + publish: review pass, revisions, gen-gallery METADATA entry, regenerate + deploy gallery  — note: ← WI-4271 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Post-production |
| `blocked-by` | `P-011` |
| Unresolved blockers | `P-011` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Script v1: refine this storyboard into a per-scene shot list + draft narration beats, accurate to the CURRENT system (verify every claim against live behavior; no stale v1 terminology)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Pre-production |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

GUI rehearsal sweep: click through EVERY GUI surface the storyboard names and verify it shows what the narration claims — Rubrics panel + su-agent-behavior detail; scorecard FULL-detail view (all 21 criteria + evidence legible on camera); Ideas view with scorecard-grounded ideas; the Mug-handoff surface; Working-tab queue; Create-tab plan view; Git tab buttons; agents-running dropdown session drill-in with Resume/Fork/Focus window. File a work item for every gap found (small UI fixes allowed pre-capture)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Pre-production |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Fixture seeds: choose the gradee delivery (a real, bounded, camera-friendly task for the Sonnet agent), author the grade-run plan (v1 pattern: agent-behavior-grade-run), and stock the drain backlog with enough REAL bounded items for a ~4-member fleet (~10–20 min of on-camera burn-down)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Pre-production |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

Rig prep: re-verify sandbox-desktop capture path end-to-end; terminal layouts for 2-up and fleet tiling; browser profile for GUI capture; confirm psu model/effort specs for opus grader + sonnet:5 members

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Pre-production |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Compaction rehearsal: verify auto-compaction reliably fires within the drain window on ≥1 member (knobs: context budget / task length / seeded long context) AND that the post-compaction re-orientation is visible + legible on camera; document the trigger recipe

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Pre-production |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — normal

Assembly: per-segment cuts, speed ramps, title/section/close cards, chapter markers; lock the cut

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Post-production |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `todo` — normal

V2 explainer segment (D-011) [owner:Avi 2026-07-12]: how the work-distribution system works — plan items + blocked-by edges form the DAG; promotion mints work items carrying the edges; fleet leader steers claim specs/lanes; members self-select via scheduler:get_next (atomic SKIP-LOCKED claim of the next READY item); completions advance the frontier until drained. Visuals: DAG diagram + fleet:assignments includeDag view + capture-C drain footage callbacks. Deferred to v2 per owner; does not gate v1 assembly.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — v2 backlog (next version) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-011` |
| Linked work-items | None |

#### P-014 — `todo` — high

Intro segment for draft 2: SU-agents-vs-auto-loop cards + narration per D-015 (assembly/INTRO-SCRIPT.md — 5-mode list verified against mode:list)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Draft 2 |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-015` |
| Linked work-items | None |

#### P-015 — `todo` — low

DEFERRED [owner:Avi 2026-07-12, D-015]: capture the AUTO LOOP running, including the zellij pane — deferred until the auto loop is reliable; not in draft-2 scope. Revisit after draft-2 ships.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Draft 2 |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-015` |
| Linked work-items | None |

#### P-020 — `todo` — high

FINAL clean reshoot + final cut using the draft-3 template (assemble3.py/mix-narration3.py are the recipes). Preconditions [owner:Avi 2026-07-12]: a full working run without launch errors — EI-10388 (omp trimmed-context, being fixed by fleet demo-shoot-bugs P-001) resolved or ornith dropped from the cast; sonnet spec + onboarding-wedge launch bugs (WI-4414/WI-4431) fixed or worked around; reshoot should also capture the real git view for the git-sync beat (replacing the explainer card).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Final cut (D-013 review notes) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/context-injection-audit-2026-07-28</code> — Automatic context-injection audit — the recall query represents the human rather than the turn, and the telemetry conflated two score scales (D-001 retracts this plan's original "precision floor is absent on every push path" headline) — <strong>2 residual</strong> (2 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-09T06:06:20.575Z |
| Now | OWNER MANDATE 2026-08-01 (D-032): finish EVERY open item — bar is "we can confidently say the dynamic context injection system is ready for a public release". P-023/P-025 are non-work by construction.  ⛔ **THE PLAN IS NOW BLOCKED ENTIRELY ON THE OWNER.** 48 of 50 items are done. The only two that are not: - **P-006 (blocked, high)** — OWNER-GATED, open since 2026-08-02 06:03Z, zero posts: `conv-msbe9am5-0000-de837aaa576749e68ff753b88c1a8b95`. The owner chose "last 3 HUMAN turns only"; it was BUILT, TESTED and deliberately LEFT UNWIRED because live measurement (real corpus, reproduced twice) shows it makes retrieval WORSE — human-only filtering swaps machine boilerplate for HUMAN boilerplate ("continue where you left off": 67× in 3 days). Ruling D-047. Four options; (b) tail as its own retrieval leg + union is the recommendation. - **P-007 (todo)** — the A/B of P-006's query construction, blocked behind it by construction. Do NOT wire either.  ✅ BOTH previously-measured release blockers are CLOSED. (1) P-018 / WI-6857 — GREEN 2026-08-03 00:56Z: **1 of 7, batch ONE, identical on 3 fresh-owner passes** live on :3170. 1 of 7 IS the pass (criterion: "batch 1 or 2 without the query naming the id"); batches 2-7 are the separate WI-7237. Root cause was TWO independent cuts, neither the query — which is why three single-variable experiments each measured 0/7 correctly and concluded wrongly. Fixed under **D-060**: CUT 1 caps 3/900→6/1800; CUT 2 `clampToBudget` cut the WHOLE composed block at 350, deleting the pointer section — now clamps the mem0 half only. Before→after: 398-403 chars / no pointers / 0 of 7 → 1109-2255 / pointers on all 7 / 1 of 7. (2) P-050 — the harrier@1024 floor re-sweep, landed via WI-7172. P-004+P-005 also done.  ⚠ NO RELEASE CLAIM made; none until P-006 is answered and P-007 measured. |
| Next | ANSWER P-006 — the owner's call, and the only thing left. Read `conversations:get { id: 'conv-msbe9am5-0000-de837aaa576749e68ff753b88c1a8b95' }` and pick (a) drop procedural turns from the tail, (b) run the tail as its own retrieval leg + union [recommended], (c) model-based intent extraction [rejected in D-046 on latency/cost], or (d) ship as-is and accept the regression. Then implement that option on `lib/memory/human-turn-tail.ts`, re-run the live acceptance BEFORE wiring, and do P-007's A/B against `memory/bench/`. Agents: do not self-answer this and do not wire either item. |
| Live presence | None in final 10-minute window |

#### P-006 — `blocked` — high

Replace `queryContext: prompt.slice(0, PROMPT_QUERY_CLAMP)` (`injection.ts:94` via `turn-start-memory.ts`) with the prompt PLUS a bounded tail of the conversation. Rationale: with P-004 alone, the 23-char failure still fails — the query becomes the literal string "why is it fucking sllwo", which does not match the stored memory. The real signal ("session history loading slow in the agents dropdown") is already on the wire and is being discarded. OPEN DESIGN QUESTION for owner: how much tail (last exchange / last 2 / a token budget), and whether to extract an intent rather than concatenate.  — note: ← WI-6937 blocked

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — make the query represent the turn |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — normal

A/B the P-006 query construction against the existing `memory/bench/` harness before shipping — the bench and the precision monitor already exist and should judge this change rather than intuition.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — make the query represent the turn |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/restore-pot-lexicon-public-release-2026-07-04</code> — Restore the Pot (Papercup) lexicon for public release + gate the swarm switcher behind the Testing flag — <strong>4 residual</strong> (4 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-04T00:17:26.420Z |
| Now | PHASES 1, 2 & 4 (icons) COMPLETE + verified green (route A, su-9d427; owner map D-006: hive→pot, queen→brain, bee→cup, sentinel→operator). PHASE 1/2 DONE: P-001 classic pot→Pot · P-002 THE_HIVE default OFF (parked) · P-003 keyless roles kept · P-004 switcher TESTING-gated · contributor→Cup. PHASE 4 ICONS DONE (this session): P-010 base Tauri app icon reskinned Swarm-mark→CUP (_source.svg + regenned png/ico/icns/@2x/_master via `npx tauri icon`; the-hive/ subdir left as swarm) · P-011 default cup favicon added to operator-vite (public/brand/papercup/favicon.svg + <link rel=icon>; SPA had none) + confirmed logo marks/HiveThemeBridge already flag-gated (default=cup, bee only when THE_HIVE on) · BONUS: terminal+GUI worker glyph 🐝→☕ (TUI agent_pane_kind/wake_board/fleet/app/layout incl '☕ colony' — pui 565 pass; GUI AgentsRunningPill/primitives→AdvAgentsPanel/SwarmTab/res — 41+50 pass). HiveVisualIdentity hand-drawn bees render ONLY behind flag+dev — no default bee leaks. Small deferrals (non-default): statusline-fleet 🐝 (decoupled CLI), tutorial-runner CHAPTER_EMOJI 3, docs .md 🐝 → fold into P-012. NOTE: dev workspace may still hold a runtime THE_HIVE=ON override; CODE default is OFF (correct for public); clear the live override in P-014. |
| Next | Phase 3 hardcoded-callsite sweep next: P-005 left-sidebar nav tabs (HivesTab/QueenTab/SentinelTab/SwarmTab/OverwatchTab) → route labels through useLexicon FIRST, then P-006 adv panels, P-007 palette/toasts/empty-states, P-008 the 16 server term() callsites, P-009 desktop shell labels. Then Phase 6 = the LARGE breaking backend full-rename in slices (tool names → routes → blueprint/role ids → DB cols last), prompts+docs same cutover. Owner may still re-map brain→other (queen-name Q answered Brain; nothing shipped) — watch inbox.   - **P-001** `done` Fix the `classic` pack to be the true POT lexicon. In libs/generic/lexicon/src/packs.ts revert CLASSIC_TERMS.pot Hive/Hives → Pot/Pots (the 2026-06-16 owner override that promoted pot→Hive into the baseline is what makes flag-off still say “Hive”). Review every other CLASSIC term to confirm it is the intended public Papercup label per D-001. Update the tests that assert classic.pot===‘Hive’ (apps/operator-vite/src/lib/useLexicon.test.tsx lines 49-50, AdminShell.lexicon.test.tsx, and any snapshot). THIS IS THE KEYSTONE — nothing else about ‘switch back to pot’ is real until this lands. importance: urgent |
| Live presence | None in final 10-minute window |

#### P-013 — `todo` — normal

DECISION-GATED (D-004): the marketing site. apps/the-swarm-site (deploys to theswarm.dev, Cloudflare Pages project ‘the-swarm’) is an entirely Swarm-branded public surface. Decide whether public release keeps ‘The Swarm’ marketing (brand split with a Papercup app) or rebrands the site to Papercup. Out of app scope; owner call. Blocked on D-004.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Docs, marketing, verify |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

#### P-016 — `todo` — high

Rename MCP tool namespaces: ~32 hive:* + 12 bee:* + 6 scout:* + overwatch:* + queen + sentinel:* tools (defineTool name:). HIGH BLAST RADIUS — every agent prompt, recipe, the Rust pui, external MCP clients, docs, and tests call these by name; a rename is a fleet-wide coordinated cutover (running agents break mid-flight if not sequenced). Alpha norm = hard cutover, no back-compat aliases — confirm. Update the tool registry, all callsites, guidance, and the tools-md-sync test.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Backend identifier rename (owner add-on 2026-07-04; BREAKING, reverses D-001) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `todo` — high

Rename DB identifiers (only if D-005 depth includes DB): ~83 distinct hive_/bee_/scout_/swarm_ SQL identifiers (hive_slug ×78, hive_members, hive_settings, bee_claim_specs, scout_routed_ideas…) across the schema. Requires migrations (via the atomic allocator + db:migrate runner, NOT raw psql) + every query/ORM callsite + pull-schema. Highest-risk, least-reversible slice — sequence last, behind a green gate.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Backend identifier rename (owner add-on 2026-07-04; BREAKING, reverses D-001) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

#### P-019 — `todo` — high

Backend-rename verification: full type-check + test:all:integration (schema edits need it) + a live fleet smoke (spawn a hive/pot, run queen→bee placement, confirm coordination/steering/wake still resolve under the new names). Update agent prompts + docs in the SAME cutover so the fleet keeps working.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Backend identifier rename (owner add-on 2026-07-04; BREAKING, reverses D-001) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/mathmaps-egress-probe-scratch-2026-08-02</code> — SCRATCH — P-006 speech-rule-engine mathmaps egress probe (archive after verification) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` · archived |
| Owner | — |
| Updated | 2026-08-02T19:32:16.078Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

Render this plan and confirm zero jsdelivr / mathmaps / MathJax requests.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — probe |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/plantuml-egress-probe-scratch-2026-08-02</code> — SCRATCH — P-002 plantuml egress probe (delete after verification) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` · archived |
| Owner | — |
| Updated | 2026-08-02T19:21:13.275Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

Render this plan in /admin/plans and confirm zero requests to plantuml.com.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — probe |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/data-scoping-audit-2026-06-22</code> — Data scoping audit: capability=global, work/usage=hive, plus the workspace/multi-tenant tier — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-08-01T18:36:40.552Z |
| Now | Brief 4 (su-3001c, AUTO) dispositioned every P-003–P-009 (see D-014). DONE: P-006 (verified — mig 398 live, recall flag ON, 5/5 green), P-005 (LANDED — mig 420 + appendPlanRunTurn writer-populate; plan_run_turns.harness_slug mirrors parent for RLS/federation symmetry; additive nullable, reader-dormant, table empty live). DROPPED: P-003 (flawed premise, live-data-confirmed — item_id is escalation/completion/progress ids, 0/675 join work_items; learning EI-4874). DEFERRED w/ explicit preconditions (D-014): P-009-contract + P-008 are gate-green deploy-coupled; P-007 is owner-attended coord substrate ('default' NOT migrated — coord_links ~4702 etc.; the resolver still PRODUCES 'default'; a live re-stamp risks a CDC/federation storm); P-004 has no write-site hive source + no reader (a dead column). B3 DONE 2026-07-27 (su-055aef7f, under D-015): lint:no-workspace-default 11 → 0 across the coord-plane bootstrap/mirror DDL; 2 sites keep the default behind an `allow-workspace-default` marker with stated reasons; all 130 production INSERT sites already pass workspace_id (the 40 omitters are test fixtures), so the mirrors are now STRICTER than prod — the safe direction. The live DEFAULT-drop stays with B5. ⚠ CORRECTED 2026-07-27 — THIS LINE PREVIOUSLY QUOTED A DEAD INSTRUMENT: it read 'Lint guards active (lint:scope-defaults 6 / lint:no-workspace-default 16) and block regression.' lint:scope-defaults had NOT been running at all — its git grep scanned the GENERATED docs mirror (173,074,426 bytes) against a 64MB maxBuffer, so execFileSync threw ENOBUFS and it reported NOTHING while the plan asserted it was active. Fixed with source-only :(exclude) pathspecs + an explicit ENOBUFS branch that prints 'SCAN DID NOT RUN — this is NOT a clean result' and exits 2, because the failure mode was precisely that a dead detector reads as a quiet one. TRUE COUNT: 27 in 23 files, not 6 (EI-18814750662741575; fact lint-scope-defaults-was-dead-true-count-27). See D-015 §5. |
| Next | (1) Clear the 27 real lint:scope-defaults sites across 23 files — newly VISIBLE, not newly introduced; the guard was blind, so treat this as a backlog uncovered, never as a regression to blame. (2) Owner/at gate-green: P-009 contract — ALTER workspace_id GENERATED→plain + switch the 3 telemetry writers + DROP COLUMN workspace, in deploy lockstep; (3) P-008 — the 7 operator-activity tables, columns+writers+reader together; (4) P-007 attended — resolver-require + caller audit + the trigger-disabled 'default' re-stamp (D-015 §2 BINDS this: no backfill may re-stamp session_turns/tool_usage_rollup). P-004: re-open only when a reader AND a write-site hive source both exist. |
| Live presence | None in final 10-minute window |

#### P-007 — `needs-human` — high

Drop workspace_id DEFAULT 'default' on the 28 affected tables; require workspace as an explicit arg threaded from the caller (agent context has workspaceId). Add lint:no-workspace-default to prevent regressions.  (← WI-684 released) (← WI-684 open) (← WI-684 released) (← WI-684 released) — note: B1/B2/B3/B4/B6 all resolved (B2/B3 landed+verified, B1 closed by D-015, B4 measured no-op, B6 pre-existing). Only B5 remains, owner-attended per D-014, split-question sent to fleet leader 2026-07-27 unanswered 5d. See WI-684 comment thread.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 4 — Require workspace (multi-tenant) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/websearch-xhigh-effort-proxy-repair-2026-07-28</code> — Repair the xhigh-effort WebSearch 400 in the cache proxy (WebSearch's sub-request disables thinking but forwards session effort) — <strong>6 residual</strong> (2 todo, 4 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-28T09:08:15.569Z |
| Now | FILED, NOT STARTED — owner asked for the plan only, implementation deliberately deferred [owner 2026-07-28]. Root cause is proven from Claude Code 2.1.220's own source, not inferred. Already filed as EI-18753696723750409; a documented WebFetch workaround exists in the meantime (arXiv API / html.duckduckgo.com — see memory `86e0528b`). |
| Next | Nothing in flight. When picked up, start at P-001 — the whole repair is one conditional in the existing cache-policy rewrite. |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — normal

Unit-test the rule in `cache-policy.test.ts`: xhigh+disabled → high; max+disabled → high; xhigh+adaptive → UNCHANGED (the critical negative — this must not touch normal traffic); no `output_config` → unchanged; no `thinking` key → unchanged.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — the repair |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — normal

Decide whether the inference gateway needs the same rule for gateway-pinned sessions, which bypass `:9073` entirely. Measure first — if no fleet session runs xhigh through the gateway, record that and skip rather than duplicating policy.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — the repair |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — normal

Verify live: with the session at `effort xhigh`, run a real WebSearch and confirm it returns results. Restarting `papercup-cache-proxy.service` is the activation lever — this does NOT ride the `:3070` deploy.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — verify + report |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — normal

Add a removal trigger: when an upstream fix lands, delete the rule rather than leaving a permanent silent rewrite of other people's requests. Re-check on Claude Code upgrades by grepping the new binary for `querySource:"web_search_tool"` + `effortValue`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — verify + report |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Add the effort/thinking-contradiction rule to the cache-policy body rewrite (`packages/operator-core/lib/inference-gateway/cache-policy.ts`): when `thinking.type === 'disabled'` AND `output_config.effort` is `xhigh` or `max`, lower effort to `high`. Prefer lowering over deleting so the sub-request keeps a deliberate level rather than falling back to a model default. Rewrite ONLY on that exact contradiction — never touch effort on a thinking-enabled request.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — the repair |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Report upstream to Anthropic: the `web_search_tool` path should omit `effortValue` exactly as the other six thinking-disabled paths do. Worth filing regardless of the local repair, since the local one only covers this box.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — verify + report |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/bash-to-tool-substitution-2026-07-26</code> — Bash to tool substitution: prove equivalence, enforce existing tools, add the missing ones — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-27T13:25:57.710Z |
| Now | **P-020 DONE — 17 rows LIVE at `advise`. P-029 is the only plan item left, and it is time-gated to ≈2026-08-03.**  P-020's method was unrunnable — D-042: **`observe` emits nothing** (both hooks act only on advise/deny; `false_positive_count` was pinned at 0 by construction). So evidence was MEASURED: **0/12 false positives, 16/17 positives, `npm ci` still denied** — the positive control, without which an all-clear is indistinguishable from the D-041 fail-open.  **I broke D-011 and fixed it — D-043.** Selecting on `equivalence_verdict` alone swept in `git-state-read`, pinned at `observe`, firing the registry's largest advisory (~2,500/week) until I caught it on my own `git rev-parse`. The hold was not unread but **unreadable by code** — prose vs Postgres. Now data (`holdAtObserve`), and `promoteEarnedRows` DEMOTES a drifted held row.  **The file-read family is now sound across its whole population (2026-07-27T12:50Z).** A trailing `\/` on head/tail — never in the stated intent — had been MASKING three junk classes AND, in all four rows, claimed-but-unexpressible atoms no verdict had ever seen: head 4/191, tail 11/1879, cat 43/1505, sed 3/3730 → now 0. All four now share one `SINGLE_FILE_OPERAND`; verified LIVE 20/20.  **Lesson (fact `substitution-pattern-change-requires-fixture-redraw`): a frozen fixture is evidence only for the pattern that DREW it — score the POPULATION, not the fixture.** Same family as D-041/D-042. |
| Next | P-029 — re-run the P-002 report ~7 days after advise landed (≈2026-08-03); publish the per-bucket before/after vs the frozen baseline. D-006: record WHICH per bucket (bash flat ⇒ advisory not landing; bash down but counterpart flat ⇒ agents stopped doing the work — a regression, not a win). Headline bucket: `file-range-read` (1,389 atoms / 192 sessions at 0.4%).  ⚠ CAVEAT (fact `p029-baseline-file-read-patterns-changed-mid-window`): all four file-read patterns changed at 2026-07-27T12:50Z, ~4.5h into the advise window — claimed population moved head 193→213, tail 2068→2089, cat 2172→2074, sed 3789→3784. Compare against the RE-DRAWN fixtures (evidenceRef contains "re-drawn for EI-18799531134810488"), not the old frozen baselines, or the before/after compares two different populations.  Open, none blocking: D-011's release condition for `git-state-read` (open BY DESIGN — do not "fix" it by promoting the row) · EI-18802228732541554 (make `buildFixture` scrub the dash-munged home path deterministically). CLOSED 2026-07-27: EI-18799531134810488 (file-read patterns), EI-18800669297694465 (shell-write guard prose-as-path), EI-18802204276510164 (lint:tsc new-file remedy — now branches on `--files`; 5 tests + live probe both modes). |
| Live presence | None in final 10-minute window |

#### P-029 — `todo` — high

**Re-run the P-002 report 7 days after `tier=advise` lands and publish before/after.** Success criteria, per bucket, not in aggregate: Bash share of tool_use blocks down materially from the 41% baseline; each Category-1 bucket's tool counterpart up from its ~1% floor; each Category-2 gap's bash volume down after its tool ships. A bucket that does NOT move is a signal the tool is not actually equivalent (send it back to Phase 1) or the advisory text is not landing (rewrite it) — record which, per bucket. Do not declare the plan shipped on the aggregate number alone.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Prove the number moved |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/cut-tool-invocations-analytical-load-2026-07-26</code> — Cut the tool_invocations analytical load (19.34% of all DB time) with caching, scoping and an index — explicitly NOT a columnar migration — <strong>6 residual</strong> (2 todo, 4 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-27T00:43:22.944Z |
| Now | DRAFT, AWAITING OWNER REVIEW. Nothing implemented. Filed from EI-18754139434413158, which measured `tool_invocations` queries at **200.6 hours / 19.34% of ALL database time / 4,166,243 calls**. Every number in this plan is measured on the live DB (pg_stat_statements + pg_stat_user_tables + EXPLAIN ANALYZE), not estimated. The columnar/Arrow route is deliberately excluded per D-001. |
| Next | Owner reviews. The one item needing an owner decision before it can be built is P-003 (D-002 — whether these metrics are global or per-workspace), because it changes reported numbers. |
| Live presence | None in final 10-minute window |

#### P-003 — `blocked` — high

**Resolve D-002, then scope the four readers by `workspace_id` if that is the ruling.** This is the item that needs the owner: today a per-workspace health panel reports GLOBAL tool traffic, which is either a latent correctness bug or an intentional fleet-wide metric. If scoped, the existing `tool_invocations_telemetry_idx (workspace_id, harness_slug, invoked_at DESC)` already serves it and the scan collapses further. DO NOT build before D-002 is decided — it changes reported numbers.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — fix the scan shape (needs a decision first) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

#### P-004 — `blocked` — normal

**Narrow the rows: move `args_json` + `metadata_json` out of the hot heap.** Main heap is 1,483 MB against only 101 MB of TOAST, i.e. the big jsonb is stored INLINE (values under the ~2KB toast threshold). Sampled at 10%, those two columns extrapolate to ~960 MB of the heap while the four columns these aggregates actually read total ~82 MB — so every seq scan drags ~18x the bytes it uses. Options in preference order: (a) `ALTER TABLE ... SET STORAGE EXTERNAL` on both columns so they toast out of the heap, measure, and keep only if it wins; (b) vertical-split into a side table keyed by id. This is the "columnar insight" obtained WITHOUT an extension. Measure before AND after — do not assume.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — fix the scan shape (needs a decision first) |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — normal

**Retention for `system_health_ticks`.** 512,972 rows / 268 MB, of which **206,853 are older than 7 days** — nothing is reaping them. Add a retention sweep consistent with how the panel actually reads the table (it serves recent health, not history). Check for an existing reaper/routine to extend before adding one.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — retention and proof |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — high

**Re-measure and record the real before/after.** Take a `pg_stat_statements_reset()`-anchored baseline BEFORE Phase 1 lands, then re-measure over a comparable window and record actual percentages on this plan. ACCEPTANCE: the `tool_invocations` share of total DB time falls from the measured 19.34% to a stated number. Two traps this plan inherits from the Arrow work: a warm cache makes arms incomparable, and a plausibility check on the result (row counts, buffer counts) must pass BEFORE trusting any timing.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — retention and proof |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

**Memoize the four readers through the EXISTING `cachedRead` helper** (`lib/cache/cached-read.ts` — workspace-scoped, tag-invalidated, kill-switch-honouring; reuse it, do not roll a new cache). Put the cache in the READER modules, not in `compute.ts`: `readLimitFailureRate` has 3 non-test call sites, `readCodeRunAdoption` 3, `readOrientDedupRate` 2, `readEmptyResultRate` 1 — caching at the caller would leave the others uncached. `softTtlMs` should be minutes, sized to the WINDOW not the tick: a 7-day window served from a 5-minute cache is indistinguishable in signal. ACCEPTANCE: pg_stat_statements `calls` for all four drops by >=90% over an equivalent wall-clock window.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — stop the redundant work (no behaviour change) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

**Add the missing composite index `(tool_name, invoked_at)` on `harness_shared.tool_invocations`.** Allocate the number with `node scripts/next-migration.mjs` — never `ls sql/ \| tail` (EI-6843). Use CREATE INDEX CONCURRENTLY (1.3M rows, live table, and this box runs a busy fleet). ACCEPTANCE: the empty-result-rate EXPLAIN ANALYZE stops showing `Parallel Seq Scan` and `Buffers: shared hit` drops from ~189,870 to the low thousands. Re-run the exact EXPLAIN in EI-18754139434413158 as the before/after.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — stop the redundant work (no behaviour change) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/knowledge-packs-2026-07-11</code> — Knowledge Packs — rename, de-Retain, multi-kind content, domain bundles — <strong>18 residual</strong> (3 todo, 12 blocked, 3 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-26T22:30:26.460Z |
| Now | PARKED AS DRAFT (owner 2026-07-12: "leave it as draft, we'll work on this later"). All conversation insights folded through v4. The memory-delivery work (formerly Phase 6 here) was SPLIT OUT to the ACTIVE plan **`memory-delivery-unification-2026-07-12`** and is being executed now; nothing else in this plan is in flight. su-0efdd444 owns the P-007 Retain excision inside their visual-grammar pass (confirmed via coord 2026-07-12) — that lands independently of this plan's parking.  **Next (when the owner resumes):** owner verdicts on P-012 (promote recipes/rubrics/discovery into pack kinds — su-5d676 votes all three) and Phase 5 (P-016 legibility / P-017 default-pack split / P-018 promote-to-insight); then Phase 1 rename. |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — normal

Rename the HTTP surface `/api/learning-packs/*` → `/api/knowledge-packs/*` (install, upgrade, uninstall, set-enabled, fetch-from-comb, candidate-decide) and every caller (LearningTab packPost, cupboard detail page, creation flows).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Rename: learning packs → knowledge packs |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — normal

Storage + config renames: `learning_pack_candidates` table (migration via `scripts/next-migration.mjs`), pot setting key `learning-packs:disabled`, `FLAGS.LEARNING_PACKS` key (stored-override migration, not aliased), blueprint `learning.pack` → `knowledge.pack` (accept old key on read), installed root `~/.papercusp/learning-packs/` → `~/.papercusp/knowledge-packs/` (migrate-on-boot move), builtin dir `harness/learnings/` → `harness/knowledge-packs/`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Rename: learning packs → knowledge packs |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — normal

Boundary compat: Comb listing kind `learning-pack` → `knowledge-pack` with old wire value still parsing (same pattern as pack→tool-pack); repo export/install convention `learning-packs/<id>/` → `knowledge-packs/<id>/` with install-from-repo accepting both dirs.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Rename: learning packs → knowledge packs |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — normal

Rename UI copy + sync resolvers (`learningPacks.list` → `knowledgePacks.list`), docs page `system/learning-packs.mdx` → `system/knowledge-packs.mdx` (redirect/alias stub), update agent-insights/docs references.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Rename: learning packs → knowledge packs |
| `blocked-by` | `P-002`, `P-003`, `P-004` |
| Unresolved blockers | `P-002`, `P-003`, `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — normal

Remove ALL pack UI from the Retain view — OWNED BY su-0efdd444 inside their visual-grammar pass (confirmed via coord 2026-07-12); may land BEFORE this plan resumes. My side when resuming: verify their excision + add the "manage in Cupboard → Knowledge packs" link line.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Surfaces: packs out of Retain, first-class in the Cupboard (owner 2026-07-12) |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

Install targets per kind: memories → `hive:<slug>` mem0 via existing conflict review; insights → the pot home harness docs `agent-insights/` section, provenance-stamped frontmatter (`pack_id/pack_version/pack_item_id` + content hash); docs → `docs/knowledge/<pack-id>/`; guidelines → the pot promptOverride splice (capped ≤2k chars per pack; MUTE un-splices — same injection-time-filter pattern as memory mute). Installed insights ride the existing insights-index prelude + docs:search with zero new delivery machinery.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Multi-kind pack format (the expansion) |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `blocked` — normal

Uninstall/upgrade for file kinds: provenance-driven, pristine-hash comparison (memoryTextOf generalized), edited files kept by default; slug-collision handling in the conflict review.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Multi-kind pack format (the expansion) |
| `blocked-by` | `P-009` |
| Unresolved blockers | `P-009` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `blocked` — normal

Export v2: `knowledge_packs:export` gains insights/docs/guidelines export (organic only by default); publish path unchanged (instruction-carrying kinds keep the PENDING moderation gate).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Multi-kind pack format (the expansion) |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `blocked` — normal

Candidate kinds v2.1 — OWNER VERDICT PENDING (su-5d676 votes all three, discovery first): `recipes/` (proven code:run scripts seeded into the pot's recipe store), `rubrics/` (domain quality rubrics seeded into rubrics:*), `discovery/` (structured convention-discovery checklist enqueued as first-wake work items that record bindings as organic memories — formalizes D-002's discovery doctrine).

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `blocked` |
| Phase | Phase 3 — Multi-kind pack format (the expansion) |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

#### P-013 — `blocked` — normal

Manifest `refs`: optional `{ toolPacks: [], templates: [], blueprints: [] }` — pointers, never embedded content; install surfaces them as offered follow-up installs (each through its own consent/moderation path).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Domain bundles + template relation |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `blocked` — normal

Template ↔ pack linkage: template manifest gains optional `knowledgePack` ref; `templates:new-app` + pot creation from a template auto-stage + offer the companion pack (through the normal conflict review, never silent). Ship one real example: a `papercusp-webapp` knowledge pack.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Domain bundles + template relation |
| `blocked-by` | `P-013` |
| Unresolved blockers | `P-013` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-015 — `blocked` — normal

Author one real domain-bundle exemplar end-to-end (e.g. a `rust` knowledge pack: discovery checklist + discovery-rule memories + 3-5 insights + a docs page + a guidelines section + a toolPack ref) and validate install/uninstall/upgrade against it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Domain bundles + template relation |
| `blocked-by` | `P-014` |
| Unresolved blockers | `P-014` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `needs-human` — normal

Memory legibility: Settings→Memory lists `hive:` pools (one section per pot) + scope explainer strip on both surfaces, cross-links each way. (Small; su-5d676 would fold in regardless.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 5 — Proposed follow-ups (pending owner verdict) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `needs-human` — normal

Split `papercusp-default`: its always-on behavior norms become a `guidelines/` section (deterministic delivery via P-009) — or move to the blueprint layer where fleet-universal; the pack keeps only discovery rules + anchorable facts as memories. Slims injection budget. Affects NEW pots only; existing pools untouched.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 5 — Proposed follow-ups (pending owner verdict) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `needs-human` — normal

Memory↔insight seam: `memory:promote-to-insight` (MDX skeleton from a row, row becomes a one-line stub anchored to the slug); `memory_anchors` gains an insight-slug anchor kind so a retired insight flags its stubs.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 5 — Proposed follow-ups (pending owner verdict) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Rename the core module + verb group: `lib/learning-packs/` → `lib/knowledge-packs/`; `learning_packs:*` (10 verbs) → `knowledge_packs:*`; update `agent-tools/index.ts`, guidance text, tools-md-sync green.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Rename: learning packs → knowledge packs |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — high

Build the Cupboard **Knowledge Packs** surface as a first-class tab section (pattern: `ToolsSection`): marketplace browse (existing facet) PLUS installed-packs management — per-pot installed list with version/enabled state, install-into-pot with the conflict-review cards, mute/unmute, uninstall, upgrade, and the fleet→pack candidates queue (owner adopt/dismiss). The detail-page Install keeps staging, then offers install-into-pot RIGHT THERE (no more "go to the Learning tab" toast).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Surfaces: packs out of Retain, first-class in the Cupboard (owner 2026-07-12) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — high

pack-format v2: `manifest.yaml` + content dirs `memories/` (today's items), `insights/` (agent-insight MDX runbooks), `docs/` (reference MDX), `guidelines/` (capped always-on prompt-overlay section, D-006). A v1 flat pack keeps parsing as memories-only. Pure parser + validator with tests.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Multi-kind pack format (the expansion) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-006` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/scorecard-blender-pipeline-fixes-2026-07-11</code> — Scorecard→Blender pipeline: reliability + ledger + grading-loop + hygiene fixes (owner-directed 2026-07-11) — <strong>2 residual</strong> (1 todo, 1 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-26T22:30:19.674Z |
| Now | P-002 partially done (bg-host restarted 23:50, watchdog verify pending). P-001/P-003/P-004 queued, su-01ad3 executing. |
| Next | Verify watchdog + scout tick on fresh code → P-001 cycle reliability → P-003 ledger gap → P-004 hygiene. P-005 awaits owner design ruling. |
| Live presence | None in final 10-minute window |

#### P-004 — `wip` — normal

Hygiene: invariants.ts digestRefSet → reuse 7-lane flattenDigest (test-model drift); delete 5 dead inactive scout-cycle routine rows; su-ideation-health rubric → ratify or retire; property tests updated (hygiene done 7-lane refset, 33 dead routines purged; remainder: ratify-or-retire su-ideation-health rubric)

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase — Fixes |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — high

BLOCKED on owner design ruling (see decision): rubric-seeded ideation leg + grader-suggestion seeds + per-lane grounding metric/alarm

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Fixes |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/agent-context-quality-2026-07-26</code> — Agent context quality: curate the playbook, precompute the briefs, measure the difference — <strong>8 residual</strong> (1 todo, 7 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-26T21:43:59.968Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — high

Extend the existing prompt-weight budget from tools to the PLAYBOOK. Hard cap on injected playbook tokens plus a per-section `REVIEW_BY` expiry, modelled directly on `DARK_FLAGS_REVIEW_BY` and the shrink-only watermark pattern in `libs/flags/src/types.ts`. Adding a section must be paid for by retiring one or by an explicit owner-signed budget raise — net-zero by default, exactly as the dark-flag allowlist works today. Enforced in CI like `tools-md-sync`, not by convention.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Curate the playbook |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — high

Typed delta schema + deterministic Curator for playbook edits. A delta is `{ target, anchor, operation: add\|revise\|retire, body, provenance, evidenceRef }`. The Curator merges deltas by anchor with NO model in the merge path — this determinism is ACE's load-bearing property and what prevents context collapse. Wholesale rewriting of a playbook section becomes a lint error. `provenance` reuses the tagging vocabulary already defined in `compaction-strategy.md` (`[owner:<name> <date>]` / `[self-imposed]` / `[peer:<sid>]` / `[inferred]`), so an agent-authored delta can never be promoted to an owner directive by a later re-read.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Curate the playbook |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — high

Reflector: mine execution feedback into CANDIDATE deltas. Sources all already exist — work-item completion evidence, `improvements:capture` observation lane, gate verdicts, EI filings, coord escalations. Output is typed deltas for the Curator, never prose. Runs on the existing routine/loop infrastructure (this is the sleep-time-compute pattern: offline work between wakes, where per the paper the payoff scales with query predictability — and agent-wake queries are highly predictable). Candidate deltas are proposals; P-002's budget is the gate that forces a retirement to pay for each addition.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Curate the playbook |
| `blocked-by` | `P-003` |
| Unresolved blockers | `P-003` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — normal

Apply the transform-and-retain principle to low-quality observations. SwallowCode's ablation is unambiguous: filtering bought 1-2 points, REWRITING bought 14. Today a weak `improvements:capture` observation is filed as-is or not at all. The Reflector should rewrite salvageable observations into well-formed deltas rather than discarding them. Cheap to add once P-004 exists; do not build it as a separate pipeline.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Curate the playbook |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — normal

Per-subsystem briefs, precomputed offline and injected at claim time on the SAME rail that already inlines `planDecisions` into `scheduler:get_next` / `work_items:claim`. Refreshed on commit to the relevant paths, so staleness is bounded by construction. This is the Cartridges goal — stop paying to re-derive the codebase on every wake — reached with text and existing infrastructure instead of a KV-cache artifact we cannot install into a served model. Must respect P-002's budget: a brief that does not earn its tokens is retired.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Precompute what agents re-derive |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — high

Fix memory recall precision before considering any new memory store. Observed live in this session: the turn-start injection reported "memory budget is full" while serving hits explicitly marked safe to ignore (a decommissioned EI-25 verification probe, a superseded hyperswarm correction) against an unrelated task. The defect is retrieval precision and the absence of retirement, not missing capacity. Scope recall by task and harness, gate on relevance, and retire entries whose own body says they are obsolete. Explicitly NOT a vendor migration.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Precompute what agents re-derive |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — normal

A/B `opusplan` (Opus plans, Sonnet implements) on fleet launches and measure against P-001's signals. First-party, zero build cost, one config change. The only survivor of the planner/implementer branch. Vendor-reported ~11% cost reduction with NO published quality benchmark, so treat cost as the hypothesis and resolve rate as the guardrail. If it does not move a P-001 signal in two weeks, drop it and record that.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Cheap experiment, fully optional |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Baseline instrumentation for the four signals this plan claims to move: (a) total playbook tokens injected per agent turn, split by source (root CLAUDE.md / persona / agent-insights / memory recall / facts); (b) work-item reopen rate after a `done` completion; (c) EI recurrence rate per failure class — how often the same class is re-filed after a guard was added; (d) green-checkpoint red duration. Land these as a queryable view, not a one-off script.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Measure |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/shared-hive-cross-machine-scale-10k-2026-06-29</code> — Scale shared-hive cross-machine coordination to 10,000 hives — <strong>11 residual</strong> (11 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw@gmail.com |
| Updated | 2026-07-26T16:28:06.400Z |
| Now | PHASE 0 and PHASE 1 ARE NOW COMPLETE. P-009 closed 2026-07-26 (rev 54), the last Phase-1 item — all three of its parts verified individually: the 256-peer ceiling was already built under harden-shared-hive-to-256-peers (resolveDefaultMaxPeers, host-derived, floor 256, PAPERCUSP_SWARM_MAX_PEERS override); the PG-pool half landed as WI-6060; per-topic swarm fairness landed as WI-6063.  ⚠ TRAP THIS PLAN KEEPS SETTING (EI-18713141708830049): several items NAME work that is ALREADY BUILT. P-009 named three things, two of which were done before anyone picked it up — which is why it sat `partial` for so long. VERIFY BY LIVE PROBE before implementing any remaining item; do not trust the item text.  Two root causes worth carrying forward, both corrected by probing rather than reading config: (a) PG saturation was NOT PgBouncer — pgbouncer measured healthy (253 clients → 136 backends, cl_waiting=0, maxwait=0). It was postgres-js defaulting idle_timeout to 0 (= never close) in ~13 hand-rolled pools that bypass buildClient. A guard test now fails the build if a pool spreading either shared connection-option helper leaves idle_timeout implicit. (b) Swarm fairness could NOT be built on hyperswarm's peerInfo.topics — that is populated only on the client/lookup path, so INBOUND peers carry an empty topic list and any count on it under-reads inbound-heavy topics. It uses contentPeerCountForTopic instead (announce-channel pairing is symmetric), engages only above 85% budget pressure, and never evicts an established peer.  Still open and unrelated to this plan: WI-6062 (an UNLABELED postgres.js pool holding 5 connections idle for 6.65 days). |
| Next | Start Phase 2 — active-set federation, which the plan itself calls the PRIMARY lever: P-010 (activate-on-demand — join topic + boot the substrate engine ONLY for hives in the active set), then P-011 (evict-when-idle, the unbuilt WI-662 slice) and P-012 (a lightweight always-on wake signal so an idle/evicted member can be reactivated without holding its engine). Probe each for already-built pieces before implementing. |
| Live presence | None in final 10-minute window |

#### P-011 — `todo` — urgent

Evict-when-idle: extend the eviction policy to shared-but-idle hives (the unbuilt WI-662 slice) — persist substrate to disk, rehydrate on activation. With Phase 1+2, concurrent footprint ≈ tens of active hives regardless of 10k total membership.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Active-set federation (the primary lever) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `todo` — high

Lightweight always-on 'hive X has activity' wake signal so an idle/evicted member is activated WITHOUT holding its engine live. Depends on the Phase 3 relay tier.  — note: CARRIES P-010'S FINAL FLIP, BUT IS ITSELF DEPENDENCY-SPLIT — read before picking up. (1) P-010's mechanism is built+tested (WI-6067); it defers only NON-federating harnesses because BootAllOpts.deferFederatingHarnesses defaults false; flipping it true needs a remote wake trigger and a policy test already pins the flip. (2) THIS ITEM'S OWN TEXT says "Depends on the Phase 3 relay tier", and P-013 says the relay nodes "deliver the idle-member wake signal" — so the full store-and-forward case (wake a member that was OFFLINE when the write happened) is genuinely blocked on P-013. (3) CORRECTION to my previous note: the global hive DIRECTORY topic is NOT a safe substitute — it only reaches members that are concurrently online (no store-and-forward), and private/unpublished hives deliberately stay dark on the directory, so broadcasting "hive X has activity" there would leak private-hive metadata to non-members. (4) THE UNBLOCKED SUB-SLICE, discovered 2026-07-26: substrate-eviction-policy.ts'…

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Active-set federation (the primary lever) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `todo` — high

Stand up content-blind relay/superpeer nodes (reuse the always-on cloud Swarms): maintain hive availability, deliver the idle-member wake signal, and relay substrate sync for offline-peer catch-up. Content stays E2E (epoch keys) so the relay never sees plaintext.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Rendezvous/relay tier |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `todo` — normal

Desktops connect to a few relays instead of full-meshing thousands of DHT topics; retain DIRECT P2P for active hives (relay is for discovery, idle wake, and offline catch-up only).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Rendezvous/relay tier |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-015 — `todo` — high

Log compaction/checkpointing: turn ON and extend the snapshot mechanism to RECLAIM disk (Autobase checkpoint + Hypercore truncate-to-snapshot) so append-only logs don't grow forever. New joiners fold from the snapshot, not genesis.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Bounded data plane (kill unbounded growth) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `todo` — normal

substrate_outbox: enforce retention + add the missing index; shard or move to a per-active-set queue to prevent the 102GB recurrence. Scope presence: announce/read per ACTIVE hive instead of replicating M×H rows to every peer.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Bounded data plane (kill unbounded growth) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `todo` — normal

Sidecar CPU/RSS offload: resolve the Corestore RocksDB single-process file-lock blocker (separate storage path / true out-of-process design) OR formally drop the sidecar approach in favor of active-set eviction doing the RSS bounding.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Bounded data plane (kill unbounded growth) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `todo` — high

10k-hive scale simulation (synthetic membership) on one box: prove concurrent CPU/connection/RSS footprint tracks the ACTIVE set, not total membership. This is the local proof that the re-architecture hit the target.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Validate at scale |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-019 — `todo` — normal

Re-run the live 2-machine federation witnesses (owner-gated Hetzner) on the new active-set + relay path; confirm active-hive append→visible p95 stays ~1s and nothing regressed.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Validate at scale |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-022 — `todo` — urgent

SHARDED / HIERARCHICAL lock+claim  single per-hive argmin authority (lock-authority.ts; work-item-claim-authority-swarm.ts:37) is both the throughput ceiling (all acquires funnel to one node, each an unpruned O(M) presence scan) and a fail-open SPOF (double-grants under contention). Partition the lock keyspace across multiple arbiters (e.g. by path/domain hash) so no single node serializes the whole hive; keep deterministic election per shard.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Rendezvous/relay tier |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-023 — `todo` — urgent

RELAY/SUPERNODE replication topology so >256 simultaneously-active peers can participate in ONE hive WITHOUT the flat O(M²) full mesh (today's 256-peer process-global cap means the mesh literally cannot form past ~256). Peers replicate via a tier of supernodes/relays (reuse always-on cloud Swarms) instead of all-to-all; content stays E2E (epoch keys) so relays are content-blind. This is the change that lifts the hard ~256 ceiling to thousands.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Rendezvous/relay tier |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/deterministic-blueprints-migration-2026-06-13</code> — Deterministic blueprints — migrate the bespoke work-loops into shareable blueprints — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw2@gmail.com |
| Updated | 2026-07-26T10:30:16.554Z |
| Now | P-001 + P-143 + P-144 all DONE. Phase 0's last open item P-001 (brief 6) is closed: scoped the spine-executor + blueprint-validator + DBOS pipeline-runner against live code (D-028). The deterministic step KIND was already fully landed (P-010/011/012/140/141 — steps+gate spine, the blueprint-steps/ CoordOp registry, runProgramCore→step-program→coordProgramWorkflow, TCB pins). Brief 6 closed the real gap that scoping surfaced: the validator's op-liveness unknown-op check was DEAD (gated behind opts.knownOps, which no admission path passed) and the "spine roles are live AGENT roles" premise was never enforced. Now blueprintRegistrySets() (operator-core) bridges the coord-op registry + live agent roles across the D-001/D-004 boundary and is wired at the 3 blueprint admission chokepoints (_resolve authoring, install-blueprint-core marketplace install, project-to-pg PG projection), plus a symmetric warning-only knownRoles refinement; an unknown op now fails at author/load/install time, not as a runtime requireCoordOp throw. Lib 21/21 + operator-core 68/68 targeted green; a new regression guard loads EVERY built-in blueprint under the live registries (proves none names an unregistered op); test:affected all 352 test files pass; every changed file 0 tsc errors. Insight: agent-insights/blueprint-op-liveness-validation. |
| Next | Only P-142 remains: worker-chunk-loop → operator-hosted durable program sub-blueprint — STILL owner-gated (D-015/D-017/D-019), a staged multi-week re-architecture on the coding HOT PATH, not an unattended item. (Brief 5 built the dark, default-OFF worker:chunk-loop op + sub-blueprint scaffolding; enabling it is a separate owner-watched effort.) |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-341` [blocked] worker-chunk-loop → durable program sub-blueprint (D-015). STAGE (a) DONE: runChunkLoopCore extracted (behavior-neutral, 29 + 156 tests green). Stages (b)-(e) owner-gated: the chunk loop is ALREADY t… |

#### P-142 — `todo` — normal

worker-chunk-loop → durable program sub-blueprint (D-015). STAGE (a) DONE: runChunkLoopCore extracted (behavior-neutral, 29 + 156 tests green). Stages (b)-(e) owner-gated: the chunk loop is ALREADY the coding blueprint's `worker` role body (runs in the invoke-once subprocess; LLM callbacks need the subprocess InvokeContext). A per-chunk-DBOS-step program is a cross-boundary durability RE-ARCHITECTURE (operator↔subprocess topology change), not a blueprint-integration gap — needs the staged dark-launch + production monitoring. (← WI-341 released) (← WI-341 released) (← WI-341 todo)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — owner-authorized follow-ups |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-015` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/worker-chunk-loop-operator-hosted-2026-06-14</code> — Worker chunk-loop → operator-hosted deterministic op (P-142 staged re-architecture) — <strong>3 residual</strong> (2 todo, 1 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw2@gmail.com |
| Updated | 2026-07-26T10:30:16.511Z |
| Now | Flag default-ON; routing = two-gate guard (flag + per-harness `workerChunkLoop` knob, set on ZERO harnesses). BRIEF-15 OVERNIGHT (su-cb5de, AUTO, 2026-06-24) — the de-blocking engineering is BUILT + tested: ✅ P-020 metrics surface — migration 397 `worker_chunk_loop_outcomes` (lock-safe re-apply) + recordWorkerChunkOutcome at the single convergence point (both paths, keyed by executionPath) + summarizeWorkerChunkOutcomes (completion-rate + outcome-distribution + op−subprocess delta) + `dev:worker_chunk_loop_metrics` read tool. ✅ P-021 ramp-gate — pure `decideRampAdvance` (advance/hold/rollback at parity thresholds + an op-specific planning_failed-spike guard for the D-005 ctx risk), surfaced via the dev tool's `rampStep` arg. 18 new unit + 35+52 regression + 50 tools-md-sync GREEN. The metrics surface is the "ramped ON metrics" keystone the DoD needs. REMAINING is owner-attended only (see D-007): the dark-launch feature-RUN (needs a non-critical coding harness — none live) + the per-step %-advances. The dev tool/metrics need a deploy to go live on :3070 (not yet deployed). |
| Next | OWNER-ATTENDED: (1) stand up / pick a non-critical coding harness, set its `workerChunkLoop:true`, deploy the Brief-15 wiring, dispatch one real feature → op-path samples land in worker_chunk_loop_outcomes; (2) watch `dev:worker_chunk_loop_metrics`, approve each ramp step on its advance recommendation. Autonomously next: plan-impl P-014 Benchmark-trend Tauri verify + the dark-launch knob-set readiness. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-369` [passed] Wire the monitoring metrics (P-020); watch them on the dark harnesses ≥1 week.<br>`WI-370` [done] Metrics: feature COMPLETION RATE, outcome distribution<br>`WI-371` [blocked] Ramp the `workerMode` cohort 25% → 50% → 100%, one step at a time, each held until<br>`WI-372` [blocked] After ≥2 weeks at 100% with healthy metrics, retire the subprocess chunk-loop |

#### P-010 — `wip` — normal

Enable `workerMode` on 1-2 NON-critical harnesses only; run real features and diff (su-a509b: owner greenlit wire+dark-launch on 1 non-critical harness. Doing Brief-15 wiring first, then the flag flip.) (READINESS COMPLETE su-cb5de, 2026-06-24, RUN owner-attended. Verified end-to-end wiring: routing fork orchestrator-runner useWorkerChunkLoopOp = role===worker && flag && configGetcfg,'workerChunkLoop',false ✓; metrics persistence at the single runWorkerChunkLoop convergence point P-020 ✓; ramp-gate recommender P-021 ✓. The knob is SETTABLE via the EXISTING instance-config path no new tool — reuse-first: set workerChunkLoop:true in the harness's instance config Blueprint Settings panel → POST /api/harness/:slug/spec; splitConfigJson routes it into configOverrides, instanceEntryToConfig spreads it back, configGet reads it. RUN still needs: a a non-critical CODING harness none live — sb-devboard/oddsmith are registry-only, and b the Brief-15 wiring DEPLOYED to the operator running it dev tool + metrics not yet on :3070. Both owner-attended.) outcomes vs the subprocess path (same chunks planned, files touched, commits, validator pass-rate). Behavior-equivalent before any ramp.

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — Dark-launch + behavior parity (owner-watched) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-021 — `todo` — normal

Ramp the `workerMode` cohort 25% → 50% → 100%, one step at a time, each held until (MECHANISM BUILT su-cb5de, 2026-06-24: decideRampAdvance worker-chunk-ramp.ts — pure advance/hold/rollback recommender over the P-020 metrics at parity thresholds completion-rate parity/regression + an op-specific planning_failed-spike guard = the D-005 ctx-build detector; 7 unit tests; surfaced via dev:worker_chunk_loop_metrics rampStep arg. Actual cohort %-advance stays owner-gated per step AND is blocked on the owner-attended dark-launch first producing op-path samples no live non-critical coding harness exists.) (← WI-371 released) (← WI-371 released) metrics confirm parity for a sustained window. Owner approves each step; roll back on regression.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Ramp with monitoring (owner-gated per step) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

#### P-030 — `todo` — normal

After ≥2 weeks at 100% with healthy metrics, retire the subprocess chunk-loop (← WI-372 released) (← WI-372 released) branch (`invoke-once.ts shouldUseWorkerChunkLoop` + `run-worker-chunk-loop.ts`). Keep `runChunkLoopCore` + `scratch-env` + `worker-chunk-loop.ts` (the op uses them). Remove the `workerMode` flag (now the only path) per the flag-retirement convention.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Retire the subprocess path |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/p2p-federation-work-item-classification-2026-07-26</code> — First-class p2p/federation classification on work-items (EI-11282 design draft) — <strong>5 residual</strong> (5 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-26T09:39:06.814Z |
| Now | Design draft only — nothing implemented yet. Confirmed via tool inspection: work-items already have a `topics` field (work_items:create accepts `topics: string[]`; work_items:get returns a `topics` array — e.g. EI-9393 carried `["papercusp-improvement","improvement-source:Scout"]`). There is **no** separate `tags` column on `harness_shared.engineer_issues` (checked directly) and **no post-creation tagging tool was discoverable** via ToolSearch("topics")/ToolSearch("tag") in this session — that's the actual gap, not the classification concept itself. |
| Next | P-001 first (confirm/build the missing write-path for topics on an EXISTING item — this blocks everything else). Then P-002 (backfill), P-003 (claim-spec predicate), P-004 (file-time inference). |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

Determine the actual write-path for topics on an EXISTING (already-created) work-item — grep `packages/operator-core/lib/agent-tools` for wherever `topics` is read/written (the create-time path is known; the update path is not yet confirmed to exist). If no such path exists, add one (a small, low-risk addition — e.g. `work_items:tag { id, add?, remove? }` or a `topics` field on `work_items:update`) rather than inventing a second classification column.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make topic-tagging usable for classification (blocking) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Adopt the convention: topic slugs `p2p` and `federation` are the canonical subsystem tags for this cluster (reuse the existing topic slug format seen on EI-9393, e.g. `papercusp-improvement`, `improvement-source:Scout` — colon-namespaced slugs are already idiomatic here).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make topic-tagging usable for classification (blocking) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Backfill-tag the existing federation/p2p cluster once P-001 lands: re-derive the title-glob query from EI-11282's body (`*p2p*/*P2P*/*federat*/*hive*/*hypercore*/*corestore*/*swarm*/*holepunch*/*content-matrix*` over open bugs, plus the WI-2xxx/3xxx/4xxx federation family) and apply the `p2p`/`federation` topic to every match. Verify count before/after against the 16-known-ids figure in EI-11282.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make topic-tagging usable for classification (blocking) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

Add topic-based claim-spec predicate support so a fleet leader can write `{ not: { field:'topics', op:'contains', value:'p2p' } }` instead of a title glob — confirm `scheduler:set_claim_spec`'s spec schema already supports a `topics`/array-contains predicate shape; if not, that's the actual schema change this whole effort is really asking for.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make topic-tagging usable for classification (blocking) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

(stretch, not blocking) File-time inference: when `improvements:capture` / `work_items:create` files a new bug/change whose title matches the known p2p/federation keyword set, auto-suggest (not force) the `p2p` topic — closes the loop so future items don't need backfilling.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Make topic-tagging usable for classification (blocking) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/inbox-pane-active-scope-dates-filters-2026-07-19</code> — Inbox pane: scope to truly-active items, add dates + filtering/search, and stop raw &lt;ask&gt; in the TUI — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-19T15:04:30.681Z |
| Now | SHIPPED (14/15 items done) — implemented autonomously under AUTO mode per owner directive [owner:Avi 2026-07-19]. All 4 asks done: (1) Inbox scoped to truly-active items via scopeInboxItems (drops the non-decision plan-item backlog + recency-bounds stale activity; keeps decisions/alerts) — this is the 328 fix; (2) occurredAt added to AttentionItem, populated at the reader from each source's real timestamp (m.ts, e.ts, work_items.updated_ts, report createdAt, standing lastSeenAt, gate opened_at, improvement updatedAt, conversation updated_ts, owner-wall derived), rendered as a relative date + abs tooltip; (3) search (?opcq) + data-driven kind facets (?opck) behind a QueueFilterBar-style Filter + design polish; (4) ask-gate-mirror.sh bounce reworded to steer agents to the native AskUserQuestion tool, NOT a raw <ask> tag (the raw-XML-in-TUI root cause). Verified: 50 unit tests pass, operator-core + apps/operator typecheck clean on all changed files (1 pre-existing plans-api baseline error unrelated), all timestamp field names source-verified. AUTO decisions: D-1 refined (kept blocked/needs-human work-item alerts for drill-in compat); D-2 = option (b). |
| Next | P-104 only remaining: run the live in-Tauri visual/count check (launch papercusp-desktop → Inbox tab → confirm All count drops from ~328 to the scoped set + dates/search/facets render). Owner (Avi) or next session. |
| Live presence | None in final 10-minute window |

#### P-104 — `todo` — normal

Verify in the Tauri shell: the `all` count drops from ~328 to the genuinely-active set; badge + chip counts match the visible list.  — note: DEFERRED live check — code complete + unit-tested + typecheck-clean; the in-Tauri visual/count confirmation (real 328→scoped number, CSS polish) was not run this session (context budget; owner asleep). Recommended quick follow-up: launch papercusp-desktop, open the Inbox tab, confirm the All count drops and dates/search/facets render.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Scope the Inbox to truly-active items (fixes the 328) |
| `blocked-by` | `P-102` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/tool-arg-referential-integrity-2026-07-19</code> — Tool-arg referential integrity — entity-reference args are unvalidated free text across the whole tool surface — <strong>5 residual</strong> (1 todo, 1 wip, 3 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw3@gmail.com |
| Updated | 2026-07-19T14:35:08.663Z |
| Now | COURSE-CORRECTION (2026-07-19, code-verified): the ISSUE claim path (work-items.ts:3238, get-next tier 3) ALREADY UNIONS harness_slug = caller OR operator:<ws> (EI-5919/WI-1406/mig382), so operator-scope issues were ALREADY fleet-claimable — the "structurally unclaimable" premise holds only for the FEATURE floor (claimFloorsWhereSql:2221), NOT issues. Migrations 630 (4,846 bugs) + 631 (5,450 change/task) still correctly CONSOLIDATED 'operator:papercusp-workspace' → 'papercusp' (Option B identity/hygiene; backups bak_20260719_*), but the "162→473 released" was a measurement artifact. P-008 going-forward trigger-rewrite is DROPPED as auto-work: it's unneeded for drainability AND has no clean form — there is NO workspace→home-pot mapping (papercusp-workspace = 122 pots), so mapping workspace-level operator-scope issues to a pot is a genuine OWNER design fork, not derivable. Phase 1 P-001/P-002/P-003 done; P-004 wip (live enum wired; list_changed low-value). |
| Next | OWNER DECISION on the operator-scope fork: workspace-level issues (federation-stall/test-failure monitors, operator-scope agents) are genuinely not-a-single-pot — keep the 'operator:<ws>' scope (already claimable via the issue-tier union; accept it isn't a pot ref), OR add a per-workspace "operator-issue home pot" config to retype them. Until decided, do NOT rewrite the global derivation trigger. Meanwhile pivot plan work to per-member-declarative-launch-specs P-002 (members:MemberSpec[]) + work-item-status-full-unify, which are unblocked and not premised on this. |
| Live presence | None in final 10-minute window |

#### P-004 — `wip` — normal

Host resolvers for the 11 kinds, each backed by a cached set with write-invalidation (pots/harnesses/fleets/roles/accounts), plus a batched existence query for `workItem`. Publish the small sets as live `enum`s in `tools/list` + fire `notifications/tools/list_changed` on change.  — note: Resolvers for pot+harness landed (cached Set, TTL 30s + invalidateEntityCache, nearest-match suggestions, batched; load failure PROPAGATES so the step fails open rather than caching an empty set) + registered at agent-mcp load. Soft violations now emit a visible warning. REMAINING: convert args to entityRef, live tools/list enum + notifications/tools/list_changed.

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — The type + the enforcement seam |
| `blocked-by` | `P-002` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — normal

Classify the 234 invented slugs: mechanical remaps (`operator:papercusp-workspace` → `papercusp`), genuinely-missing pots that should be CREATED (`oddsmith`, `papercup`, `red-queen-sandbox`?), and sentinels needing a semantic decision (`*`, `@singleton`). Bring the residue to the owner — do NOT invent mappings.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Pot integrity + the backfill |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — high

The migration: one transaction, `bak_` tables first (mirroring `unify-default-workspace-backlog-2026-07-17`). MUST handle the **12 measured PK collisions** where a `feature_id` exists under BOTH `operator:papercusp-workspace` and `papercusp` — re-key, never drop — and rewrite every dependent reference (links, threads, posts, subs, topics, claims) keyed on the old `(harness_slug, feature_id)`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Pot integrity + the backfill |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — high

Add the DB foreign key + NOT NULL so no invented slug can ever land again. Enforcement BEFORE backfill would break live writers; backfill before enforcement just refills the swamp — so this lands in the same transaction window as P-007.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Pot integrity + the backfill |
| `blocked-by` | `P-007` |
| Unresolved blockers | `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — high

OWNER DECISION (gates P-006..P-008): does `pot` become a NEW fk column on work_items, or is `harness_slug` itself retyped/renamed to a validated pot ref? Note `project_id` already exists and is NULL on ALL 22,546 rows — a previous attempt at exactly this that died unused, and a third dead field is the failure mode to avoid. Also decide the sentinels: what `*` (607 items) and `@singleton` (207) mean under a required-pot regime.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Pot integrity + the backfill |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/plan-driver-reservation-2026-07-18</code> — Plan-level solo-driver reservation surfaced in the claimable backlog (EI-11091) — <strong>9 residual</strong> (9 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-18T11:35:28.459Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

Migration: add nullable `driver` TEXT column to `harness_shared.harness_plans` (via `node scripts/next-migration.mjs --name add-plan-driver-column --intent "EI-11091 solo-driver reservation"` — NEVER hand-pick the migration number) mirroring the existing `owner` column exactly (same nullability, same indexing posture — `owner` currently has no dedicated index per this research; confirm before adding one, only add an index if P-002/P-003's read pattern needs it).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Index `driver` alongside `owner` (schema + derive-index; additive, backward-compatible) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Wire the derive-index pipeline: add `driver: fm.driver ?? null` to `PlanIndex` (`deriveIndexFromContent`, source.ts ~L1234) and `driver` to `PlanRow`/`PlanIndexRow`, `rowFromDb` (~L233), the `listPlanRows`/`listPlanIndexRows` SQL SELECT column lists (both the primary + the column-missing-fallback query paths — source.ts has two near-duplicate SELECT lists per function, don't miss the fallback), and the INSERT/UPDATE that persists a derived `PlanIndex` into `harness_plans` columns (find via the `owner` column's write-side — grep `owner = ` / `owner:` in the same file's write path). `driver` stays a RESERVED key rejected by `plans:set-frontmatter-field` once this lands (mirrors `owner`/`initiative` — add to `RESERVED_FRONTMATTER_KEYS`) — declare it through a dedicated `plans:set-driver { slug, driver: <ownerId \| null> }` verb (thin wrapper on `setFrontmatterScalar`, same shape as `plans:set-initiative`) instead, so the write path stays structured/revisioned like every other indexed field.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Index `driver` alongside `owner` (schema + derive-index; additive, backward-compatible) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Surface `driver` in `plans:list` output (list-shape.ts + list.ts row-building, same place `owner` is surfaced) and `plans:get` meta/sections/full modes (should already round-trip via raw frontmatter parse — verify, don't assume).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Index `driver` alongside `owner` (schema + derive-index; additive, backward-compatible) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

Tests: migration idempotency, derive-index round-trip (write `driver` via the new verb → `plans:list`/`plans:get` reflects it without a full-document fetch), `RESERVED_FRONTMATTER_KEYS` rejection test for `driver` (mirrors the existing `owner` rejection test in set-frontmatter-field.test.ts).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Index `driver` alongside `owner` (schema + derive-index; additive, backward-compatible) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

`coord:orient`'s claimable assembly (orient.ts ~L510-522): after fetching the claimable page, collect DISTINCT `source_plan_slug` values (bounded by `claimableLimit`, cheap), batch-fetch their `driver` via ONE `listPlanIndexRows`-shaped query (or a small `IN (...)` lookup — never per-slug round-trips), and annotate matching items with `reservedBy: <driverOwnerId>` (leave the item IN the list — soft/advisory, never filtered out; the reader coordinates with the driver, exactly like a `claim_conflict` today).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Soft `reservedBy` annotation on the claimable surfaces (advisory, not a lock) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — normal

Staleness: a driver is only a live reservation while their session is actually live — resolve via the SAME oracle `coord:presence`/`sessionState` already uses (`presence-derivation-unification-2026-07-17` — do not hand-roll a second liveness check). Compute at READ TIME (no cron/cleanup job needed): a `driver` whose `sessionState` is not `live` is simply not annotated as reserved — this auto-clears the moment the driver's session ends/goes stale, with zero explicit unset step. (A plan's `driver` field can also be explicitly cleared via `plans:set-driver { slug, driver: null }` when a solo run finishes normally.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Soft `reservedBy` annotation on the claimable surfaces (advisory, not a lock) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Propagate the SAME annotation into `work_items:claim_next`'s candidate output and `scheduler:get_next`'s miss/candidate diagnostics (both read the same claimable shape — confirm whether they can share P-005's helper or need their own bounded batch lookup).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Soft `reservedBy` annotation on the claimable surfaces (advisory, not a lock) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — normal

Propagate into `plans:items` (`actionable:true` cross-plan query) — same `reservedBy` annotation per item, sourced from the item's own plan's `driver`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Soft `reservedBy` annotation on the claimable surfaces (advisory, not a lock) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — normal

Tests: an item whose plan has a LIVE driver is annotated; a STALE/dead driver is not; the annotation never removes the item from the claimable list (still technically claimable — soft advisory only, per the "not a lock" decision below).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Soft `reservedBy` annotation on the claimable surfaces (advisory, not a lock) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/on-desktop-direct-lan-voice-2026-07-14</code> — On-desktop, direct-LAN mobile voice (replace ElevenLabs with the desktop's free local STT/brain/TTS) — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw8@gmail.com |
| Updated | 2026-07-17T04:31:52.882Z |
| Now | ALL PHASES DONE (su-e2cc78d8, 2026-07-14). Desktop: /device/voice/turn SSE (whisper→papercup brain→per-sentence kokoro) + warmup + mobileVoiceMode + mode-dispatched session-init with EL byte-compatible (D-010) + baseUrls advertise (P-005, device-base-urls.ts). Phones: desktop-local PTT pipeline BESIDE io.elevenlabs on Android (DesktopVoiceSession.kt) + iOS (DesktopVoiceSession.swift), route probe mesh→lan→tunnel with settings display (P-006), both apps rebuilt green. Live verify on :3170 PASSED: transcript 0.59s, brain TTFT 21.9s (dominant — observation filed for a voice-slim brain profile; cost $0.65/turn), first audio +0.56s, 2 ordered valid WAVs, markup never spoken. P-011 (full-duplex Option B) deferred by design — evaluate only if PTT feel is insufficient. |
| Next | OWNER residue: re-pair a real phone (/settings/mobile) and speak a turn end-to-end (desktop-local mode engages when EL is off/unconfigured; EL still wins when configured + mobileVoiceMode=auto). Desktop code rides git-sync→green→deploy to :3070. |
| Live presence | None in final 10-minute window |

#### P-011 — `blocked` — normal

Evaluate Option B (continuous mic streaming, server VAD, barge-in, echo cancellation) only if A's feel is insufficient after P-010; consider attaching the phone as a client of the existing operator voice bus (`operator-voice-bus` / `operator-voice-session`) rather than a new protocol.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 5 — (Deferred) full-duplex follow-on |
| `blocked-by` | `P-010` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/mobile-apps-revival-v2-2026-07-13</code> — Mobile apps revival v2 (papercup-rust-mobile Android + iOS) — monitoring-first — <strong>5 residual</strong> (2 todo, 1 blocked, 2 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw@gmail.com |
| Updated | 2026-07-13T20:40:39.976Z |
| Now | AUTO mode, su-e2cc78d8 solo per owner Avi. ALL autonomously-completable work DONE + TESTED. Core revival: the apps largely already worked (P-002 misdiagnosis — public device API verified end-to-end). Fixed the one real server bug (P-005 FCM in-process mint + APNs HTTP/2, dormant). Hardened device-JWT durability (P-001). Phase B monitoring backend shipped: new lib/device-monitoring.ts producers (fail-soft, dep-injected) + GET /device/monitoring route (P-008 fleets/pots, P-009 release gate, P-010 connection health) + P-007 systemAlerts (red-gate + pool-exhaustion) on /device/attention. 47/47 device tests green; operator-core typecheck clean for new files. P-003 Android debug APK built clean (121MB). P-013 branding: 8 user-facing Papercup→Papercusp strings fixed (6 uncommitted edits in papercup-rust-mobile working tree — separate repo, needs manual commit). Runbook: agent-insights/mobile-apps-monitoring-first.mdx. OWNER-GATED (needs-human, surfaced with actionable notes): P-004 iOS build (Mac VM credential + Apple enrollment), P-006 APNs Apple Developer enrollment, P-014 owner re-pair + on-device push verify + prune stale rows + graduate onboarding flag. OPTIONAL (D-003 owner-scope, deferred): P-011 one-tap ack, P-012 daily digest push — both have mobile-app UI unverifiable without the owner's device. |
| Next | Owner decisions: (1) manually commit the 6 papercup-rust-mobile branding edits; (2) act on the needs-human tail (Apple enrollment for iOS push, re-pair phones to verify on-device); (3) greenlight optional P-011/P-012 if wanted. No further autonomous work remains. |
| Live presence | None in final 10-minute window |

#### P-006 — `blocked` — normal

APNs per D-001 (owner-gated): if enrolled — .p8 key + in-process JWT signing (same fix class as P-005), live push verified on the owner's iPhone; if deferred — record the deferral and skip.  (APNs in-process ES256/HTTP2 send path is BUILT + tested + dormant skips cleanly with no creds. OWNER hard-stop: enroll in Apple Developer Program, create a .p8 APNs auth key, drop it on the box + set APNS_KEY_PATH/APNS_KEY_ID/APNS_TEAM_ID in apps/operator/.env.local. Then iOS push goes live with zero code change same mint class as the working FCM path.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `blocked` |
| Phase | Phase A — make it hold together (critical path to "working again") |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | `D-001` |
| Linked work-items | None |

#### P-004 — `needs-human` — normal

iOS revival: verify Mac VM boots (early!), build via VM (`make build-ios`), run tools/run-ios-e2e.sh 3-phase suite vs staging, fix drift.  (iOS SOURCE ready branding done; APNs send path built-to-ready + dormant. BLOCKED autonomously: Mac VM SSH keyless auth failed — need the VM credential + Apple enrollment P-006 for push. OWNER: provide Mac VM access or run `make build-ios` on the VM ssh -p 2222, ~/.papercusp/build-vms.env, then tools/run-ios-e2e.sh.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase A — make it hold together (critical path to "working again") |
| `blocked-by` | `P-001` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `needs-human` — normal

Hygiene + sign-off: prune the 140 stale device rows (keep audit trail), owner re-pairs both phones via /settings/mobile, full E2E green on both platforms, update BUILD.md + an agent-insights runbook for the mobile build/test path. (Runbook DONE agent-insights/mobile-apps-monitoring-first.mdx. OWNER-gated remainder: 1 re-pair both phones via desktop /settings/mobile + confirm a push actually lands on-device; 2 prune the ~140 stale device rows bundled with re-pair, keeps audit trail; 3 update papercup-rust-mobile BUILD.md; 4 once verified, graduate the mobile-pairing item out of ONBOARDING_PREVIEW_FEATURES.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase C — polish + handover |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — normal

(optional, D-005) One-tap acknowledge/dismiss on inbox items — read-only monitoring otherwise preserved; no approve/execute/claim affordances.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase B — make it worth glancing at (monitoring modernization, per D-003) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

#### P-012 — `todo` — normal

Daily digest push: one morning summary push from the state-of-pot digest (opt-in in app settings).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase B — make it worth glancing at (monitoring modernization, per D-003) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/papercusp-com-redesign-2026-07-12</code> — papercusp.com redesign + relaunch — self-improvement positioning — <strong>8 residual</strong> (5 todo, 3 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-13T05:03:00.156Z |
| Now | SHIPPED. papercusp.com is LIVE with the full redesign (deployed to Cloudflare Pages branch main 2026-07-13, verified serving new title/hero/showcase/Extend/business, old copy gone). All plan items P-010..P-023 DONE except P-021 (BLOCKED — 3 fleet screenshots I can't capture from here). File /home/marsh-office/papercusp-site/src/page.html. Pipeline unchanged (./build.sh + wrangler deploy out --branch review\|main; token ~/.cloudflare-pages-token NEVER print). Latest hero: 'What will you let them / [centered] build for you? / [centered] Install PaperCusp / give your projects LIFE.' (no 'and'), 3-step .flow pipeline sub, SU-agent qblock, logo in 'Because PaperCusp was built by PaperCusp'. Paper card = inline-block line-height:.78 tight (large approved); body logos looser via p .lp-paper. |
| Next | Overhaul shipped. OPEN follow-ups to flag to owner: (1) P-021 3 fleet screenshots + the business market-research-desk shot are labeled placeholders — need real captures; (2) access form email backend is still placeholder mailto — pick a real backend (recommend Cloudflare Pages Function → Discord webhook); (3) recommend owner REVOKE the Cloudflare deploy token now the overhaul is done. Otherwise: keep applying any further owner design tweaks (deploy review→main once verified). |
| Live presence | None in final 10-minute window |

#### P-007 — `blocked` — normal

Deploy to papercusp.com CANONICAL via the `papercusp-com` Pages project + token; bind custom domain; verify serving.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Deploy |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — normal

301 papercuspai.com → papercusp.com (Single Redirect rule) — ONLY after canonical verified serving.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Deploy |
| `blocked-by` | `P-007` |
| Unresolved blockers | `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

Post-launch: recommend owner revoke the deploy token; confirm both domains resolve correctly.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Deploy |
| `blocked-by` | `P-008` |
| Unresolved blockers | `P-008` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Owner reviews the Artifact mockup + this plan; capture notes/revisions.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Design and content |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

Finalize copy: hero, loop section, each screenshot caption, video framing, private-access CTA + contact mechanism (email/form — confirm with owner).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Design and content |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Provision R2 bucket + custom domain (e.g. static.papercusp.com), upload the final video master, wire the embed.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Build |
| `blocked-by` | `P-004` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — normal

Local review pass — verify mockup→build fidelity, responsive, both themes, video plays + text legible.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Build |
| `blocked-by` | `P-004` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-021 — `todo` — high

Fleet tab image swaps: agents-running dropdown, populated conversation pane, filelock-with-intent (BLOCKED on 3 screenshots — labeled placeholders)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Data-driven build (AUTO 2026-07-12) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/fix-templates-new-app-compound-toon-2026-07-08</code> — Fix templates:new-app 422 (compound-tool in-process TOON regression) + plan-capable template harness + E2E verify — <strong>5 residual</strong> (5 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-08T22:05:14.458Z |
| Now | AUTO mode (owner asleep). Root cause CONFIRMED + reproduced on dev: inProcessCall passes outer transport:mcp into the in-process re-dispatch -> inner harness:create result TOON-encoded -> unwrap misreads success -> bogus 422 -> overlay skipped. |
| Next | Execute P-001 (root fix in _compound-dispatch.ts + harden unwrap + regression tests), then P-002..P-005 start-to-finish. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

P-001 Root fix + harden unwrap + regression tests: stamp transport:in_process on inProcessCall re-dispatch (_compound-dispatch.ts); make unwrap() TOON-tolerant (decode, not raw string); add vitest regression tests. Fixes all 5 compound tools.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Fix + tests |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

P-002 Secondary: make a freshly-materialized template harness plan-capable. Investigate why plans would not attach to a standalone coding harness; make templates:new-app produce a plan-capable harness (likely materialize into/as a hive). Add test.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Fix + tests |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — high

P-003 Deploy the fix live (force-deploy :3070 or restart :3170) + verify E2E MYSELF: run templates:new-app end-to-end, confirm overlay lands + ok:true + a builder can plan.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Verify + E2E |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

P-004 Spawn a Sonnet-5 MEDIUM-effort agent; give it a user-style create-X-from-a-template task; observe it behaves well (understands the system, no unnecessary calls, system behaves as intended). Capture the transcript.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Verify + E2E |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

P-005 Cleanup throwaway harnesses (tmpl-repro-1 etc.); assert facts + memory; complete WI-3397; full owner report.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Close-out |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/persisted-sync-cache-2026-07-07</code> — App-wide persisted sync cache — reload hydrates ALL query data instantly from IndexedDB (stale-while-revalidate) — <strong>6 residual</strong> (2 todo, 4 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-07T14:12:17.274Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — normal

New libs/generic/sync/src/persist/cachePersister.ts: IndexedDB-backed persister factory — storage key papercusp-sync-cache:<server>:<userId\|anon>, ~2s throttled writes, maxAge 24h, buster stamp, dehydrate successful queries only

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Implementation |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — normal

Swap QueryClientProvider → PersistQueryClientProvider in SSEAdapter.tsx + PollingAdapter.tsx so queries gate on restore completing (no cache-vs-fetch race)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Implementation |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — normal

SyncProvider prop persistedCache?: boolean \| { buster?; maxAgeMs? } (default ON, opt-out); operator-vite __root.tsx passes its build version as the buster

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Implementation |
| `blocked-by` | `P-003` |
| Unresolved blockers | `P-003` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — normal

Tests (vitest): persister dehydrate→restore round-trip instant data / buster mismatch discards / maxAge expiry; adapter renders restored data then background-revalidates; QueenTab loading gate never shows the unpaused default

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Implementation |
| `blocked-by` | `P-002`, `P-003`, `P-005` |
| Unresolved blockers | `P-002`, `P-003`, `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — normal

Deps: add @tanstack/react-query-persist-client + @tanstack/query-async-storage-persister (v5 family matching ^5.75) + idb-keyval to libs/generic/sync via npm

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Implementation |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — high

QueenTab.tsx honest first-load: loading skeleton while the steering query is in flight with no data — the fake "Pause indefinitely" (DEFAULT_STEERING) flash becomes unrenderable

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Implementation |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/su-papercusp-way-gate-2026-07-06</code> — Papercusp-way routing gate — intent→mechanism routing in the SU base persona — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-07T01:30:52.906Z |
| Now | P-001..P-006 are done. P-007 is blocked/deferred: finished behavior-probe runs were already graded, and the remaining notes-app/fresh-spawn token-spend probe is owner-paused and should not be relaunched without owner OK. |
| Next | Do not schedule new behavior-probe/token-spend work unless the owner explicitly clears the pause; keep P-007 blocked/deferred. |
| Live presence | None in final 10-minute window |

#### P-007 — `blocked` — normal

OWNER-GATED (token spend): one cheap fresh-spawn probe ("schedule X daily" + "here's an API key") to confirm live routing. Do NOT start without explicit owner OK.  (Owner directive part 3 supersedes the owner-gate: full probe program launched — fleet behavior-probe, 2× sonnet:medium members on plan owner-ask-batch-2026-07-06 4 verbatim user-style asks covering schedule/credential/watch/create-app gate rows. Grading per run against ACTIVE rubric su-agent-behavior via improvements:capture. D-002 resolved by the same directive.) (probe paused after grading finished runs; remaining notes-app probe deferred) (← WI-3266 completed) (Correcting linked-WI terminal side effect: remaining notes-app/fresh-spawn token-spend probe is owner-paused/deferred, not done.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 4 — behavior validation (owner-gated, deferred) |
| `blocked-by` | `P-005` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/greenfield-warrantywatch-2026-07-05</code> — Greenfield template-validation build #4 — WarrantyWatch (hardened prompt system) — <strong>4 residual</strong> (1 todo, 2 blocked, 1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-07T00:45:18.251Z |
| Now | PAUSED by owner (token conservation) mid-P-004. Builder evidence to halt: P-001..P-003 done + committed + live-verified (milestone coord:send received — B1 ✓), P-004 partial (contracts 16/16 tests), all 17 decisions answered (B2 ✓), 5 incremental commits. Workspace + commits preserved at ~/papercupai-workspace/greenfield-warrantywatch. |
| Next | Owner-gated: relaunch ONE builder on P-004..P-006 (fleet:launch-on-plan, plan+items exist), then leader P-007 verification. Do not respawn without owner OK. |
| Live presence | None in final 10-minute window |

#### P-005 — `blocked` — normal

Checks: wire TEMPLATE_CHECKS_CONFIG; run the DERIVED templates-ref/checks-union.json entries until green — NEVER hand-author a union.  (← WI-3253 completed) (Corrected after WI-3253 close: owner-gated, blocked on P-004 relaunch; not done.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Build "WarrantyWatch" |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — normal

Ship: coord:send milestone after EACH item + final report; work_items:checkpoint after every milestone; commit as you go (round-3 zero-commit lesson).  (← WI-3254 completed) (Corrected after WI-3254 close: owner-gated shipping step; blocked until P-004/P-005 relaunch resumes.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 1 — Build "WarrantyWatch" |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `needs-human` — normal

Judgment plane per papercusp-ops-hives GUIDE: specialize contracts/candidate-set.ts into @warrantywatch/contracts (strict zod, ONE parse gate, rejects emit events); work-item kind warranty-claim-research; confinement pinned per role.  (← WI-3252 completed) (Corrected after WI-3252 close: plan Now says P-004 is partial and owner-gated, not done.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 1 — Build "WarrantyWatch" |
| `blocked-by` | `P-003` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Leader: supervise; score B1..B6; independently re-run the check union; musts spot-audit; harvest friction as template-gap WIs; verdict to owner.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Leader verification |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/su-cold-auto-mode-2026-07-03</code> — Cold-auto mode for SU agents (opt-in) — fresh-context loop wakes + periodic recycle; warm auto stays the default — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw6@gmail.com |
| Updated | 2026-07-06T21:48:48.907Z |
| Now | COLD-AUTO NOW FUNCTIONAL END-TO-END (P-001..P-008 + the P-002 PRODUCER, WI-1829, landed 2026-07-03 su-94b69). The enabled→functional gap is CLOSED. The producer = 3 pieces: (1) NEW tool loop:checkpoint (agent-tools/loop/checkpoint.ts) — the loop analog of work_items:checkpoint and the FIRST-and-only setLoopCarryNote caller; structured {did,left,insight,next}→renderCarryNote OR raw {note}; writes loopScope(harness, ownerId) where ownerId=caller resolveAgentIdentity().ownerId, which MATCHES the wake-executor read (ownerId=d.subscriberId); ownerId/harness overrides mirror loop:arm/end/status; registered in agent-tools/index.ts. (2) buildLoopWakePrompt COLD-AWARE (harness/routines/loop.ts) — a carry:'cold' loop's kickoff appends COLD_LOOP_WAKE_ADDENDUM so the PRE-ANCHOR warm-fallback wakes bootstrap the first carry-note via loop:checkpoint. (3) renderColdWakeInjection (su-cold-loop.ts) wraps decision.carryNote at the wake-executor cold inject site — frames the note as working state AND re-issues the loop:checkpoint mandate, sustaining the anchor across cold wakes. FLOW: arm cold → 1st fire warm-fallback (P-006 no-anchor guard) injects the cold-aware kickoff → agent writes its first checkpoint → subsequent fires go COLD (reset, recycle every wakeCount%8==0) injecting note+mandate → agent continues + re-checkpoints. Warm loops BYTE-IDENTICAL (addendum only on carry:'cold'; injection only on the cold path). TESTS: +9 loop:checkpoint tool, +6 renderColdWakeInjection, +2 buildLoopWakePrompt cold/warm, wake-executor cold-inject assertion updated to the wrapped text; 157 green across the 5 touched files + arm(6); tsc 223<224 (ZERO errors added); tools-md-sync 50 green. Flag papercusp-su-cold-auto still default-ON, coldAutoEnabled wired at engine.ts. |
| Next | Everything SHIPPABLE is DONE + flag-ON. Phase 4 P-009 — MEASURE cold vs warm on a REAL cold loop — remains OWNER-GATED: the owner explicitly won't arm cold yet, so do NOT arm a carry:'cold' loop or trigger the measurement without owner confirmation. Fast-follow (unblocked, low priority): the DAG handler integration test (needs a fresh fleet+plan+coverage PG harness). mem0: 78ab27a0/7a4e7572/edc2b685 (mechanism/flag) + 20d885a9 (producer). If the owner later says 'go cold', arm ONE su loop carry:'cold' as the P-009 measurement subject and compare transcript growth / cost vs a warm control. |
| Live presence | None in final 10-minute window |

#### P-009 — `todo` — high

Measure cold vs warm on a REAL su AUTO loop before changing any default: per-wake token cost, wall-clock latency (incl. the MCP-reconnect cost on a recycle), and task quality/continuity (does the cold loop keep the thread across wakes, or lose it?). GATE: only after cold-auto demonstrably matches/beats warm on a representative loop do we (a) offer it to fleets and (b) consider changing defaults. Until then warm stays the default everywhere and fleets stay warm. Reuse the bee-fresh-context-delta measurement approach.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Test + measure before ANY default change |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/presence-tool-hardening-2026-07-03</code> — coord:presence + coord:orient hardening — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-03T03:59:02.978Z |
| Now | IMPLEMENTED (su-9ac1b, AUTO mode, 2026-07-03). Code-complete + unit-tested (49 tests green across presence + host suites; my files typecheck-clean). Outcomes vs original scope: P-006 (coord:presence since:<etag> unchanged-read) SHIPPED — computeRosterEtag over deltaEligibleProjection (excludes liveness), ~100B {unchanged:true} on match. P-004 (placeholder intent -> null in toStableRosterRow, constant deduped) SHIPPED. P-007 (guidance) SHIPPED. P-008/P-009 filed (WI-1722 plans:attention ~97GB/day; WI-1723 statusline glance cadence). Reclassified after reading code: P-001 already-shipped (orient tier-shaper exists, context-trimming P-012; 37.9KB is full-tier by design), P-003 misdiagnosis (claim join correct), P-005 not-a-bug (agents:0 correctly self-scoped) — see D-006. Separately: WI-1711 (MCP keep-alive-race transport bug) root-caused + fixed (keepAliveTimeout default-on 61s) + 20 tests. All edits in canonical staging tree; git-sync committing; pipeline will carry to :3070. |
| Next | P-010 LIVE-VERIFY after the pipeline deploys to :3070: (1) boot log shows keepAliveTimeout:61000; MCP POST resets stop. (2) coord:presence returns etag; since:<etag> returns ~100B unchanged; changed roster returns full. (3) placeholder-intent rows show intent:null. No further code work — verification is deploy-gated. |
| Live presence | None in final 10-minute window |

#### P-010 — `todo` — normal

LIVE-VERIFY on :3070 after the pipeline deploys these changes (packages/operator-core coord tools + apps/operator/bin transport fix): (1) boot log prints '[hono-host] applied inbound server timeouts (ms): { keepAliveTimeout: 61000, headersTimeout: 65000 }' and the between-call MCP POST resets stop (WI-1711); (2) coord:presence returns an `etag`, and a second call with since:<etag> returns ~100B {unchanged:true}; a call after a real roster change returns the full payload; (3) roster rows that previously showed the '(active — see coord:presence…)' placeholder now show intent:null. Consolidates the old P-002 (orient verify, dropped as moot).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Shape the bootstrap read (coord:orient) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/weak-model-tool-tier-2026-07-01</code> — Lite tool tier for weak/local models — trim + named-JSON + lite-schema + grammar + examples, gated by model tier — <strong>7 residual</strong> (7 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-07-02T10:57:36.228Z |
| Now | Phase 0 P-001/P-002 shipped. CORRECTION (2026-07-02, trim-live-test leader): the OMP delivery mechanism EXISTS and is LIVE-VERIFIED — psu-launcher writeOmpSessionConfigDir seeds a ~19-tool spine via a rewritten per-session mcp.json (?tools= allowlist, discovery OFF) for EVERY psu omp launch (commit c453c529; verified on ornith session 9662: trimmed catalog delivered, tools:find → list_changed → tools:invoke round-trip green, zero HTTP 400s). The earlier "P-008/P-009 blocked — catalog not reaching OMP" note came from a validation probe whose OWN session was trimmed — disregard it. Remaining P-008 scope: only the server-side launch path (buildSuLaunchSpec / launch-su route) + model-tier threading; psu-side delivery is DONE. P-009 (in-session model-switch lock) still open. P-003..P-006 Phase 1 todo. |
| Next | Re-scope P-008 to the server-side launch route (psu-side delivery shipped); then P-009 model-switch lock; then Phase 1 (P-003..P-006). |
| Live presence | None in final 10-minute window |

#### P-003 — `todo` — high

(#3 lite-schema) Per-tier schema projection applied SERVER-SIDE when tier=weak: one-line descriptions (strip the multi-paragraph ones), flatten nested objects, collapse anyOf/oneOf unions to their simplest safe branch, drop deep optional nesting. Generalize tool-schema-sanitize.ts (the bool-fix) into a tiered `liteSchema(schema)`. Target: ~halve per-tool token cost on top of the trim.  (Phase 1 + 2 validation remains. Per D-003: ship Phase 0 first; P-008/P-009 Phase 0 is the blocker for weak-tier delivery, then P-003..P-006 then P-007 validation. Validation agent confirmed P-001/P-002 ship ✅; P-008/P-009 blocking confirmed ✅) (Phase 1 validation remaining. P-007 catalog-state probe complete: P-001/P-002 confirm ✅ shipped; P-008/P-009 blocker confirmed via live OMP/ornith probe trim not firing. P-003–P-006 / P-007 blocked on P-008/P-009 completion per D-003: ship Phase 0 first.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Lite treatments (each reads the model tier) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-004 — `todo` — high

(#2 named-JSON) In prompt-assembly, when tier=weak, render STANDARD named-JSON tool-call instructions and DROP the positional-CSV/"toon" wire-schema convention from the su prompt. Weak 30B models were trained on named-JSON; the CSV convention is bespoke and unlearnable for them. Frontier tier keeps the token-saving CSV.  (Phase 1 + 2 validation remains. Per D-003: ship Phase 0 first; P-008/P-009 Phase 0 is the blocker for weak-tier delivery, then P-003..P-006 then P-007 validation. Validation agent confirmed P-001/P-002 ship ✅; P-008/P-009 blocking confirmed ✅) (Phase 1 validation remaining. P-007 catalog-state probe complete: P-001/P-002 confirm ✅ shipped; P-008/P-009 blocker confirmed via live OMP/ornith probe trim not firing. P-003–P-006 / P-007 blocked on P-008/P-009 completion per D-003: ship Phase 0 first.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Lite treatments (each reads the model tier) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-005 — `todo` — normal

(#6 examples) Inject 2–3 concrete CORRECT tool-call examples into the weak-tier system prompt. 30B models pattern-match far better than they follow prose rules; anchor the exact call shape they should emit. (Phase 1 + 2 validation remains. Per D-003: ship Phase 0 first; P-008/P-009 Phase 0 is the blocker for weak-tier delivery, then P-003..P-006 then P-007 validation. Validation agent confirmed P-001/P-002 ship ✅; P-008/P-009 blocking confirmed ✅) (Phase 1 validation remaining. P-007 catalog-state probe complete: P-001/P-002 confirm ✅ shipped; P-008/P-009 blocker confirmed via live OMP/ornith probe trim not firing. P-003–P-006 / P-007 blocked on P-008/P-009 completion per D-003: ship Phase 0 first.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Lite treatments (each reads the model tier) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-006 — `todo` — normal

(#4 grammar) For Ollama weak-tier, pass a JSON-schema/grammar constraint (Ollama `format` / structured-output) so the model STRUCTURALLY cannot emit an invalid tool call — kills the `<function=…>` garbage-emit failure mode. Determine whether this rides OMP's request path or needs an OMP-side change; if OMP-side, file it upstream / as an OMP wrapper. (Phase 1 + 2 validation remains. Per D-003: ship Phase 0 first; P-008/P-009 Phase 0 is the blocker for weak-tier delivery, then P-003..P-006 then P-007 validation. Validation agent confirmed P-001/P-002 ship ✅; P-008/P-009 blocking confirmed ✅) (Phase 1 validation remaining. P-007 catalog-state probe complete: P-001/P-002 confirm ✅ shipped; P-008/P-009 blocker confirmed via live OMP/ornith probe trim not firing. P-003–P-006 / P-007 blocked on P-008/P-009 completion per D-003: ship Phase 0 first.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Lite treatments (each reads the model tier) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-007 — `todo` — high

(validation) Faithful A/B: same weak model (ornith-35b) against the REAL papercusp-su MCP (NOT the :8888 hindsight stub my ad-hoc `omp -p` tests hit), full vs lite tier, on a fixed task battery. Measure tool-call SUCCESS RATE + tokens + latency. Gate each lever on a measured win.  (Phase 1 + 2 validation remains. Per D-003: ship Phase 0 first; P-008/P-009 Phase 0 is the blocker for weak-tier delivery, then P-003..P-006 then P-007 validation. Validation agent confirmed P-001/P-002 ship ✅; P-008/P-009 blocking confirmed ✅) (Phase 1 validation remaining. P-007 catalog-state probe complete: P-001/P-002 confirm ✅ shipped; P-008/P-009 blocker confirmed via live OMP/ornith probe trim not firing. P-003–P-006 / P-007 blocked on P-008/P-009 completion per D-003: ship Phase 0 first.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Validation |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-008 — `todo` — high

psu OMP model selection → thread the chosen model into buildSuLaunchSpec: add `model` to BuildSuLaunchSpecInput; the psu-launcher / launch-su route passes the `--model`, so modelCapabilityTier(model) drives the `?tools=` trim baked into the generated .mcp.json (per D-004). This is the concrete 'hook into OMP's model selection'.  (thread model → buildLaunchSpec is mechanical Codex trim, but the OMP delivery half is blocked per D-006; needs a live-verified OMP config-dir approach) (blocked on OMP config resolution D-004/D-006; validation confirms the catalog trim never reaches OMP — D-006's blocking hypothesis is verified by live probe) (Validation agent confirms blocked: catalog trim not firing for OMP sessions; confirmed by live probe on ornith/OMP session — tool set not trimmed P-001/P-002 shipped but blocked by OMP delivery gap, per D-005/D-006. Next = resolve P-008 psu → OMP mcp.json delivery + in-session lock.) (Un-blocking: the "blocked — trim not reaching OMP" verdict came from a probe whose own session WAS trimmed see D-007. psu-side delivery is shipped + live-verified psu-launcher c453c529; remaining P-008 scope is the server-side launch path buildSuLaunchSpec/launch-su threading, P-009 the model-switch lock — both plain todo, nothing blocking.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — The model-tier gate (foundation; the "weak-models-only" mechanism) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004`, `D-006`, `D-005`, `D-007` |
| Linked work-items | None |

#### P-009 — `todo` — high

Lock OMP's in-session model switch so a session can't drift from its launch model (stale trimmed catalog). Investigate an OMP config/flag to disable the model switcher; if none, pin modelRoles in the psu-written OMP config + guard. Per D-004.  (OMP in-session model-switch lock — blocked on the same OMP config-resolution question D-006) (blocked on OMP config resolution D-004/D-006; validation confirms the catalog trim never reaches OMP — D-006's blocking hypothesis is verified by live probe) (Validation agent confirms blocked: catalog trim not firing for OMP sessions; confirmed by live probe on ornith/OMP session — tool set not trimmed P-001/P-002 shipped but blocked by OMP delivery gap, per D-005/D-006. Next = resolve P-008 psu → OMP mcp.json delivery + in-session lock.) (Un-blocking: the "blocked — trim not reaching OMP" verdict came from a probe whose own session WAS trimmed see D-007. psu-side delivery is shipped + live-verified psu-launcher c453c529; remaining P-008 scope is the server-side launch path buildSuLaunchSpec/launch-su threading, P-009 the model-switch lock — both plain todo, nothing blocking.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — The model-tier gate (foundation; the "weak-models-only" mechanism) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004`, `D-006`, `D-005`, `D-007` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/dummy-demo-palindrome-2026-06-30</code> — Dummy demo: palindrome utility (plan→work-item→implement flow exercise) — <strong>3 residual</strong> (1 todo, 2 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-06-30T10:05:50.004Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — low

Add scratch/dummy-plan-demo/palindrome.test.mjs (node:test + node:assert) covering: simple positives ('racecar'), negatives ('hello'), mixed-case + punctuation ('A man, a plan, a canal: Panama'), empty string, and single char.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Implement |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — low

Verify: run `node --test scratch/dummy-plan-demo/palindrome.test.mjs` and confirm the suite passes green.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Implement |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — low

Create scratch/dummy-plan-demo/palindrome.mjs exporting isPalindrome(s): normalize to lowercase, strip non-alphanumerics, return true if the result equals its reverse. Empty/whitespace-only input counts as a palindrome.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Implement |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/prediction-market-auto-bettor-2026-06-23</code> — Prediction-Market Auto-Bettor (Kalshi + Polymarket) — <strong>20 residual</strong> (20 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw8@gmail.com |
| Updated | 2026-06-23T20:03:50.090Z |
| Now | SUPERVISION ACTIVE: su-7ad99 on a 2-min engine loop driving all 12 oddsmith briefs to done+green. Live board: oddsmith repo docs/briefs/STATUS.md. Pass @20:00Z — ✅ B2 db, B3 contracts+config, B9 backtest DONE; 🔨 B1 skeleton, B4 kalshi-read, B5 kalshi-orders, B8 risk, B12 dashboard WIP; ⬜ B6 ingestion, B7 OMS, B10 MM, B11 arb NOT STARTED. B3 landing cleared the earlier npm-install blocker. Shared blocker EI-2946 (per-pkg vitest config) nudged to B1 owner. Hive healthy (agents parked/live, no orphaned/stalled claims). Note: B1 owner su-aec0c not in active roster while WI-615..627 still open → may need relaunch. |
| Next | Owner action: dispatch B7 (OMS, fully unblocked) + B6 (ingestion) now; verify/relaunch B1 (foundational, owner may have ended); B10/B11 unblock as B4/B7/B8 land. Supervisor loop re-checks every ~2min: updates STATUS.md, unblocks, drives to all-12-done then loop:end. |
| Live presence | None in final 10-minute window |

#### P-004 — `todo` — high

Trading Postgres schema via migration + introspect: bots, orders, fills, positions, market_data, pnl_snapshot, trade_audit (PG triggers → sync invalidation).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Scaffold |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Feature flags: TRADING_PAPER_MODE (default ON), KALSHI_LIVE_TRADING (default OFF, owner-authority), KILL_SWITCH; gate every order path from day one.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Scaffold |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — normal

Secrets: KALSHI_API_KEY (RSA-PSS keypair) storage via the credential pattern; paper-key vs live-key separation.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Scaffold |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — high

Kalshi REST connector (read-only): auth (RSA-PSS signing), markets, orderbook, positions, fills; exponential backoff on 429; clean ingestion seam (swappable to WS/Polymarket later).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Platform spine |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — high

Market-data ingestion routine via loop:arm → upsert market_data at a poll cadence within Kalshi's token-bucket limits.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Platform spine |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — normal

Sync-resolver queries + table→query-name entries for markets / positions / orders / pnl.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Platform spine |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — normal

Trading dashboard panel (dock/panel-registry + nuqs + useSyncQuery): live markets, positions, P&L, manual kill-switch.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Platform spine |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — low

Distil the research + infra audit into an agent-insights doc anchored to the connector/risk code.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Platform spine |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `todo` — high

Order Management System: lifecycle state machine (open→partial→filled/cancelled), idempotent placement (UUID client-order-id), position aggregation, realized/unrealized P&L.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — OMS + risk + paper exec + backtester |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `todo` — high

Risk engine: fractional (¼–½) Kelly sizing, per-trade / per-event / total exposure caps, drawdown + daily-loss kill-switch, stale-data refusal, correlation caps.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — OMS + risk + paper exec + backtester |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `todo` — high

Backtester: historical data sourcing (3rd-party Kalshi depth e.g. KalshiBackTest/Lychee — Kalshi API lacks orderbook history), orderbook-walk fill model + slippage/fees, walk-forward + purged CV, shadow→live toggle.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — OMS + risk + paper exec + backtester |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-015 — `todo` — high

Paper-execution path wired end-to-end (no real orders): strategy → risk gate → simulated fill → P&L → dashboard.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — OMS + risk + paper exec + backtester |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `todo` — high

Strategy: maker market-making on a single slow Kalshi market (paper), inventory + spread management, maker-only.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — First live edge |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `todo` — normal

Strategy: internal/Dutch-book arbitrage scanner over Kalshi multi-outcome markets (paper).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — First live edge |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `todo` — high

Promote MM/arb paper→tiny real money (≤$50/position) after ≥2 weeks paper + guardrail sign-off; owner ratifies KALSHI_LIVE_TRADING flip.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — First live edge |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-019 — `todo` — normal

LLM ensemble analyst via inference gateway: diverse multi-model + retrieval-augmented + extremization + crowd-adjust → calibrated probability + rationale (never sizes).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — The brain (research track) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-020 — `todo` — normal

ML model: LightGBM + post-hoc calibration (isotonic/Platt) on sports first; monitor Brier/log-loss/reliability.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — The brain (research track) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-021 — `todo` — normal

Forecaster eval harness (rubrics + judge + eval-battery + Brier/log-loss backtest) that GATES promotion; only go live if it beats market on backtest + paper.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — The brain (research track) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-022 — `todo` — low

Polymarket-US connector (KYC, EIP-712 wallet/USDC/nonce/gasless) — maker economics; never International from US.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Scale |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-023 — `todo` — low

Cross-venue arbitrage if sub-100ms infra is justified; WS ingestion adapter if fast-market MM warrants it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Scale |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/lane-7-draft-pr-proposal-smoke-2026-06-18</code> — Lane 7 draft-PR proposal smoke — <strong>2 residual</strong> (2 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | — |
| Updated | 2026-06-18T15:42:17.845Z |
| Now | Proposal created via apply-plan-block to test the draft-PR proposal→review→promote path. |
| Next | Review and promote into features. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

First proposed item

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Proposal |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Second proposed item

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Proposal |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/coord-system-e2e-testing-2026-06-10</code> — End-to-end testing of the agent coordination system (coord + locks + federation) — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `draft` |
| Owner | aviynw6@gmail.com |
| Updated | 2026-06-12T07:27:37.466Z |
| Now | 12/13 done (2026-06-12, su-f3fbd close-out). P-011 CLOSED: scored run of su-S11-lock-contention-protocol landed via LLM_TEST_BACKEND=claude-code — the real 429 escape per the llm-429-check-the-transport-not-the-account insight (AGENT_BACKEND alone only picks the stateless credential; the plan's earlier unblock recipe was the wrong knob class). Result: both ERROR gates green (protocol response + no bypass); judge groundedness red — the SUT narrated a fictional peer reply after coord:send, self-corrected at turn 3 (real playbook finding, filed EI-367 with the candidate playbook line; su-S11 is the regression gate). Matrix: new Layer-C protocol-use section added (D-004). Drive-by: llmCall now folds subprocess stderr into the thrown error (the first run died as an undiagnosable 'claude-code exited 1') + 2 unit tests. Sole remaining item P-010 (two-box verb sweep) is needs-human by design: box B = the owner's main-server-Precision-7865 (live + announcing in coord:presence), runbook ready at artifact briefs/brief12-owner-runbooks-2026-06-10.md §3, ~30-45 min owner-driven, $0. |
| Next | Owner: run the P-010 two-box verb sweep per runbook §3 (briefs/brief12-owner-runbooks-2026-06-10.md) — 30-45 min driving main-server as box B; everything else in the plan is done. |
| Live presence | None in final 10-minute window |

#### P-010 — `needs-human` — normal

Two-box variant: run P-005's verb sweep + P-008/P-009 rungs across two physical machines per the `vm-federation-separate-machine-proof` pattern. Gated/owner-run. (su-8f376 2026-06-10: prepared to the gate — runbook §3 in artifact briefs/brief12-owner-runbooks-2026-06-10.md box B = main-server federated peer, $0, owner-run. Ask: 30-45 min driving main-server as box B.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 3 — Layer C: real-agent protocol use |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

### Shipped or superseded plans with residual items (39)

<details>
<summary><code>papercusp/claude-md-projection-from-pg-2026-08-10</code> — CLAUDE.md/AGENTS.md: project from PG invariant rows, migrate long-form detail to agent-insights, stop hand-authoring — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-08-12T23:01:03.184Z |
| Now | SHIPPED, and P-009's non-destructive half is now BUILT. [owner:Avi 2026-08-12] picked "(a1) build the materialization now, hold (a2) untracking".  P-009 (a1) DELIVERED — commits 398242e05b (superproject) + ce7730d2 (libs/papercusp submodule). Postgres now reproduces the authored corpus BYTE-FOR-BYTE with nothing untracked: materialized into an empty dir and diffed against the committed tree — 0 files differ, 0 resurrections, 6 extras that are exactly the 5 GENERATOR_OWNED_DOCS + the .papercusp dot-dir, independently reproducing the 880 = 874 + 5 + 1 accounting.  BUILDING IT FOUND A BLOCKER NOBODY HAD SCOPED: harness_docs had NO live/retired column. File presence WAS the liveness oracle ("orphan rows — deleted docs" was an inference from absence), and `status` cannot substitute — measured, a deleted doc sat at status=fresh while a live and a dead doc both sat at status=review. So P-009 would have silently resurrected 54 deleted docs. Worse, the ordering is forced: the working tree is the ONLY oracle and (a2) DESTROYS it, so liveness had to be captured into PG BEFORE untracking. Migration 814 (retired_at + retired_reason, applied, fence 342) plus a one-time --retire-orphans backfill did exactly that: 874 live, 54 retired, selectively reversible via its distinctive reason string.  Also landed: --materialize [--out=DIR]; npm entrypoints (gen:authored-docs:materialize / :retire-orphans, apps/operator-docs build:from-pg); 44/44 tests on the extracted pure retireOrphansRefusal() asserting BOTH directions; typecheck clean; corpus 874 identical exit 0; reachability gate exit 0.  GUARD DEBT (WI-38239): gen:claude-md-manifest:check RETIRED (watermark 21→20) — a real-tree run proved its own "deepen to a real-tree assertion" prescription impossible. All 5 remaining runnable orphans then measured: 2 RED, 1 that cannot fail, only 2 wireable. |
| Next | (a2) IS OWNER-HELD — do NOT untrack anything (880 files still tracked; content.config.ts:138 still docsLoader()). When the owner calls for it: flip the docs build to `build:from-pg`, untrack the corpus, retire gen:authored-docs:check WITH it (it mitigates a problem (a2) deletes), and FIRST confirm backup:snapshot_create covers harness_docs content — git stops being the DR path for doc prose. ⚠ an ephemeral build needs BOTH --materialize AND gen:doc-projections, or the site ships without the 5 reference pages. Meanwhile the next unit is WI-38239: wire the two MEASURED-GREEN guards (gen:compaction:check, gen:knowledge-packs:check, watermark 20→18), re-measuring first; gen:fleet-lessons:check and gen:openapi:check need a REPAIR before wiring; gen:doc-projections:check needs a gating mode or retirement since it exits 0 while printing drift. |
| Live presence | None in final 10-minute window |

#### P-009 — `todo` — normal

Switch the docs-site build off tracked files: either a custom PG Content Layer loader (astro 6.3.6 supports it) or ephemeral materialization into a temp dir at build time. Nothing committed (D-004).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — The remaining 672 docs |
| `blocked-by` | `P-008` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/owl-field-guide-site-2026-08-10</code> — North American Owls field guide — runnable website — <strong>6 residual</strong> (5 todo, 1 wip)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | — |
| Updated | 2026-08-11T19:38:34.044Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-002 — `wip` — urgent

Sourcing pass: gather per-species facts (scientific name, length/wingspan/mass, range, habitat, voice, diet, nesting, IUCN status, ID notes) for 12-16 species from Cornell All About Birds / Audubon / IUCN, recording a source URL per species

| Attribute | Detail |
|---|---|
| Stored → effective | `wip` → `wip` |
| Phase | Phase 1 — Ship the guide |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — high

Encode the sourced content as structured data (species JSON) with a citation list per species; no field left to invention - omit or mark uncertain instead

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Ship the guide |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

Build the site: index page listing all species + a detail view per species, hash-routed, self-contained, responsive, legible

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Ship the guide |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — high

Accuracy audit: re-check every numeric/status claim in the built data against its cited source; fix or drop mismatches

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Ship the guide |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — urgent

Publish to a real URL and VERIFY by loading it in a browser: index renders, navigate to >=3 detail pages, links work

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Ship the guide |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Report: URL + run command, species count, sourcing method, and actual spend against the 500-cent ceiling; update the goal tripwires

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Ship the guide |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/focus-timer-web-spike-2026-08-09</code> — Focus timer web spike — pomodoro-style session timer with local persistence — <strong>5 residual</strong> (2 todo, 3 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | — |
| Updated | 2026-08-09T08:24:09.294Z |
| Now | Sketch only — nothing built. Idea is a small self-contained pomodoro-style focus timer that runs in the browser and remembers your sessions between visits, so the streak survives a tab close. |
| Next | Decide whether this stands alone or folds into a wider set of small focus tools sharing one UI layer. |
| Live presence | None in final 10-minute window |

#### P-003 — `blocked` — normal

Sketch the timer states (idle / running / paused / done) and what the UI shows for each.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — decide the shape |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — normal

Build the timer itself against the decision in P-001.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — build |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — normal

Make it reachable by someone other than us — decide where it is hosted.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — build |
| `blocked-by` | `P-004` |
| Unresolved blockers | `P-004` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Settle whether the timer is standalone or the first of several small tools sharing one UI package and one persistence layer.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — decide the shape |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Pick the persistence approach and prove a session survives a refresh and a tab close.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — decide the shape |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/cupboard-full-dogfood-2026-07-10</code> — Fully dogfood the Cupboard: refresh stale blueprint listings, bring templates + plugins to standard-path parity (author=papercupai) — <strong>4 residual</strong> (1 todo, 1 blocked, 2 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw7@gmail.com |
| Updated | 2026-08-09T02:53:47.686Z |
| Now | P-001+P-003 DONE. Guardrails DONE (P-005 manifest-gate + P-002 visibility-gate, tsc-clean, in tree A). Owner Avi engaged 2026-07-10 ~16:10 EDT and gave 3 calls. P-005 EI-387 repo fix DONE+SHIPPED: pushed valid papercusp.json (@papercupai/papercusp-worker 0.1.0, kind plugin) to Papercusp/papercusp-worker@main commit 73301bd — the Claude-hooks plugin now satisfies the installer's locatePlugin ({name,version}); live-install verification folds into P-006. P-004 deploy AUTHORIZED by Avi but BLOCKED on Cloudflare creds (wrangler=Not logged in, no CLOUDFLARE_API_TOKEN); worker deploy-ready (template in LISTING_KINDS); live cupboard endpoints 404 ⇒ deployed worker stale. P-002 publish: Avi asked to see the full list first — 47 blueprints classified at artifact a2d7f08b-b302-42fa-8156-fdd561f60451 (rec-public 8 = coding,work,research,review,migration,deliberate,vote,gym; 9 borderline; 30 internal); AWAITING his set pick. DISCLOSURE: canonical tree currently UNBUILDABLE (peer lib/hive→lib/pot rename, git-sync primary down) — doesn't block above; P-002 submodule edits won't sweep until it clears. |
| Next | Await Avi's two inputs: (1) the public blueprint set → then mark visibility:public + schema.ts decl in libs/papercusp submodule + POST /api/cupboard/publish-blueprint author=papercupai + retire bee/hive/sentinel; (2) Cloudflare creds → then wrangler deploy + republish 11 templates. Then P-006 fresh-home proof. Loop armed 600s; settle until he replies, do NOT re-escalate. |
| Live presence | None in final 10-minute window |

#### P-006 — `blocked` — high

Fresh-home acceptance: a clean install resolves every official kind (blueprint, template, plugin) via the standard path with provenance = installed/resolved-from-cupboard, bundle intact as the floor, `/api/cupboard/tools` installable>0 for the fixed plugin. Capture as acceptance evidence + a dogfood runbook doc.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — End-to-end dogfood proof |
| `blocked-by` | `P-002`, `P-003`, `P-004`, `P-005` |
| Unresolved blockers | `P-002`, `P-004`, `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `needs-human` — high

Re-publish the current official blueprint set under their post-lexicon-rename ids via the existing `POST /api/cupboard/publish-blueprint` path (author=papercupai, through the review gate), and retire/supersede the stale pre-rename listings (bee/hive/sentinel). Net: the cupboard's blueprint listings match the live catalog.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 2 — Refresh drifted blueprint listings (reuse the shipped standard path) |
| `blocked-by` | `P-001` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `needs-human` — normal

Fix EI-387: give the papercusp-worker plugin repo a valid `papercusp.json` so its listing installs, and add a publish-time manifest check so a broken plugin can't be listed again. Publish any other official tool-plugins Papercusp ships.   (publish-time manifest gate EI-387: kind=plugin publish 422s an un-installable repo; 33 tests pass, tsc-clean) (Manifest-check GUARDRAIL done+verified fact cupboard-p005-publish-manifest-gate-done; 33 tests, tsc-clean. Reverting done→needs-human: item ALSO bundles outward-facing EI-387 repo remediation on Papercusp/papercusp-worker add papercusp.json to make installable OR retire if it's infra not a user plugin — a P-002-class curation call + publishing other official plugins — owner-gated.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 4 — Fix the plugin gap |
| `blocked-by` | `P-001` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

(Re-)publish the 11 official templates via that path as author=papercupai so the listings are backed by the standard publish flow, not a one-off seed.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Bring templates to standard-path parity |
| `blocked-by` | `P-003` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/opencode-omp-borrow-finish-2026-08-08</code> — Finish the opencode/OMP borrow: land the 5 live items, record the 4 dead ones so nobody re-opens them — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-08-08T23:54:28.064Z |
| Now | COMPLETE — all twelve items terminal. The approved set (1-6) closed earlier; the three never-approved Tier-3 items finished this session under AUTO. P-012 (item 14) stays deliberately PARKED.  • **P-007 / item 8 — REJECTED, D-020.** Head-keep is correct in all three `capInjectionText` populations and would make two WORSE: `result-door` is deliberately priority-ordered head-first (that IS the WI-5656 fix, pinned by orient-recovery-door-priority.test.ts) and `ambient-push` sorts most-urgent-first, so eliding the middle cuts mid-priority content and keeps the lowest-priority tail. Rule: elision only pays where the tail is BOTH load-bearing AND unrecoverable — here never both, so the lever is REORDERING. • **Byproduct WI-36683:** the one `lossless`-registered door's reason was FALSE twice over (door-cut pushes do NOT re-deliver — recordDelivered at :236 precedes the cut at :286). Corrected + a bound test with a non-vacuity control. Survives on a MEASURED 68-char margin in 4000 that is NOT structural → **WI-36688** filed. • **P-008 / item 13 — DONE, WI-36726.** Anti-trust clause landed in `renderCompletion` (what the PARENT reads): zero prompt weight, CONDITIONAL so it never becomes skippable boilerplate. No `tests` and no `verifiedHow` ⇒ UNVERIFIED in the headline + terse body clause. Fixed a real D-006 breach en route (dropped `verifiedHow` AND `filesChanged`; the invariant test passed VACUOUSLY because its fixture set neither). Replaced a contract-pinning test, flagged in-code. • **P-009 / item 2 remainder — REJECTED, D-021, WI-36767.** Premise void: there is NO per-tool cap (resultEach resolves per RECIPIENT SESSION), so a static description naming it would be WRONG, not just costly. Cost agrees: 724 tools, p99 1491 / max 1498 vs 1500; +120 chars everywhere breaches budget on 66, HARD CAP on 14. The P-011 gate now reports HEADROOM every run.  Verified: 35/35, 229/229, 55/55, 5/5; lint:tsc clean; docs green (844 pages). Addendum table updated — 13 of 14 settled. |
| Next | Nothing outstanding — this plan can be marked shipped.  One follow-up FILED, not silently deferred: **WI-36688** (open, unclaimed) — make the ambient-push door lossless BY CONSTRUCTION instead of by a 68-char bound: compose the block against the door budget and recordDelivered only the pushes that actually fit, so the ones that did not genuinely re-deliver (what the registry reason claimed all along). The bound test guards the gap meanwhile and reds with an explanatory message if the margin goes.  P-012 (item 14, snapcompact) stays PARKED — do not build; we hold an independent negative (OMP's image-archival compaction caused ornith-35b's context overflow 2026-07-13). |
| Live presence | None in final 10-minute window |

#### P-012 — `blocked` — normal

**Item 14 — `snapcompact`.** Parked on purpose, not stalled. Tier 4 / experiment-only, and we already hold a negative: omp's image-archival compaction was the root cause of ornith-35b's context overflow on 2026-07-13 (text-only model cannot read a bitmap back). Re-open only with an owner ask and a throwaway harness

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 5 — Rules, checks, and the parked experiment |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/agent-context-firewall-and-output-spill-2026-08-02</code> — Agent context firewall + output spill: measure the token-reduction mechanisms opencode and OMP have that we may lack — and kill the ones we already cover — <strong>1 residual</strong> (1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-08-03T02:30:31.984Z |
| Now | **PLAN COMPLETE** — every item is terminal or owner-deferred. Route 0 (self) under AUTO by owner direction 2026-08-02.  DONE: P-001 (D-003) · P-002 (D-011+D-012) · P-003 (D-013) · P-004 (D-014) · P-008 (D-006) · P-009 (D-007) · P-010 (D-008) · P-011 (D-016) · P-012 · P-013 (D-005, P-014 DROPPED) · P-015 (D-009) · D-012 shipped (D-015/WI-7252). DEFERRED by owner (D-004): P-005/6/7. Deferred with its seam named (D-015): D-012 leg 3, a route-aware footer.  **The result, in one line: four strikes and one small win — because the tokens are not where this plan assumed.** D-014 measured the whole window: `tool_result` 61.4% · `tool_use` 25.3% · `text` 7.1% · `thinking` 6.3%. D-017 then measured the argument side too, and the verdict hardened: **native `Read`/`Bash`/`Edit`/`Write` are 51.7% of ALL context**, across both directions. Those are CLIENT-SIDE — no door, tier, projection or spill touches them. NON-GAPS confirmed: D-005, D-006, D-011, D-013. The one shipped saving is the payload-aware door footer (D-015/D-016, −12.4% of footer bytes).  ⚠ D-016 RETRACTS a cost claim in D-015 — cite D-016, not D-015, for footer size. ⚠ D-017 RETRACTS this block's former claim that `work_items:checkpoint`/`coord:send` are the largest `tool_use` payloads — they rank 5th and 7th. ⚠ Never measure context from `harness_shared.session_turn_parts` (2,000-char cap; understates tool_result ~10×). Use `scripts/measure-context-token-baseline.mjs`, which since WI-7261 ranks BOTH directions (`topToolsByUseChars`). |
| Next | Nothing is claimable on this plan. What it hands forward, corrected by D-017 — verified `tool_use` ranking: `Bash` 19.5% · `Edit` 17.5% · `loop:checkpoint` 15.4% · `Write` 10.0%, with the previously-named `work_items:checkpoint` (4.6%) and `coord:send` (4.4%) at 5th and 7th. The one OWNED lever: `loop:checkpoint` is the largest papercusp-side consumer of context in the corpus — 7.95M chars/6d, 6,275 per call over 1,267 calls, more than `work_items:checkpoint` and `coord:send` combined — and nobody has asked whether a 6.3KB carry-note is the right size. That is a measurement, not yet a diagnosis. Also open: a true post-deploy before/after on the footer change once WI-7252 reaches `:3070` (re-run the script, diff `doorFooters` + `byKind` against D-014). |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-6879` [done] **Record the subagent correction as this plan's first decision, verified in-session.** The conversation's framing names `Task` as an available primitive; it is denied for every psu launch by owner ma…<br>`WI-6880` [done] **Re-derive every cell of the inventory table against the LIVE sources with `file:line` citations, and strike what does not survive.** opencode and OMP are both installed on this box. Two verbatim op…<br>`WI-6881` [done] **Measure whether result-door spill is PAGED or ABANDONED.** The door already spills to scratch and returns a path + URI, so spill-and-reference may be closed — but only if agents actually read the s…<br>`WI-6882` [done] **Establish the baseline this plan is judged on: tokens-into-context per session, decomposed by source.** Sibling D-044 retired bash-share as a metric. Without a tokens-into-context baseline, every i…<br>`WI-6883` [done] **Measure whether a fleet/cup fan-out is a context firewall AT ALL here, economically.** A subagent discards its transcript and returns a summary for near-zero marginal infrastructure. A fleet member…<br>`WI-6884` [blocked] **Only if P-005 clears: draft the fan-out mandate, naming the mechanism that actually exists.** Where the parent should delegate (broad non-needle exploration) versus never (a needle lookup, anything…<br>`WI-6885` [done] **If P-005 does NOT clear, record why as a decision and close the fan-out line.** The measured reason a firewall does not pay here is more valuable than a mandate nobody follows, and prevents the nex…<br>`WI-6886` [done] **Check whether wide-line blowups actually occur before porting OMP's 512-column cap.** A token budget does not bound column width, so one very wide line can eat a budget a column cap would make harm…<br>`WI-6887` [done] **Audit whether truncation is machine-readable or only prose — starting from the prior art, which may already close it.** opencode sets explicit `truncated`/`timeout` flags; our result-door announces…<br>`WI-6888` [done] **Recurrence guard for P-009: a test asserting every truncating path sets the structured flag, not just the prose.** A guard, not a fix — the class returns the moment a new truncation site is added w…<br>`WI-6889` [done] **Re-measure P-004's tokens-into-context baseline after whatever shipped, and publish before/after per source.** If nothing shipped because every gap measured closed, publish THAT — a verified non-ga…<br>`WI-6890` [done] **Fold the surviving findings back into the sibling plan or an agent-insights doc, whichever the evidence fits.** Do not leave the result only in this plan's decisions: the failure this plan corrects… |

#### P-006 — `blocked` — normal

**Only if P-005 clears: draft the fan-out mandate, naming the mechanism that actually exists.** Where the parent should delegate (broad non-needle exploration) versus never (a needle lookup, anything needing the parent's own context). Prompt-layer edits go to the SOURCE, never a rendered output, and must pass `apps/operator/lib/prompt-denied-tool-recommendations.test.ts`.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 2 — Fan-out as a context firewall: measure the economics before proposing any mandate |
| `blocked-by` | `P-005` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/p2p-part-merge-proof-2026-07-18</code> — Two-machine per-part plan-federation merge proof (the real P-008) — tower + Avis-iMac concurrent different-part edits — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-08-03T01:31:44.757Z |
| Now | TOWER-EVIDENCE 2026-07-18T04:21Z (concurrent-window marker 04:43Z): this ## Now is tower-authored (su-18f2f) under papercusp-plan-part-federation ON on both machines (tower flags:get=true; mac operator_flag_overrides=true 04:19Z). The mac-side P-003 flip is being written on Avis-iMac's operator in this same minute — two different-part edits, two machines, one flag-ON window. If both survive on both machines with identical md5(content), the per-part merge held (whole-blob projection stayed bootstrap-only; recompose was sole writer). Round 1 (P-001, 03:49Z) ran flag-OFF (whole-blob vintage). Leg A verdict: spawnreq-acc5e8c0cf5489bd honored; member psu ran --account=default off sonnet:medium:AUTO seat (Gate 4.6 confirmed). Member su-fbdc1 LLM account rate-limited until 05:50Z — P-003 executed via the mac operator /api/mcp superuser door by the tower leader (machine-origin preserved; substitution disclosed in D-001). |
| Next | Tower leader: run convergence forensics (both edits on both machines, md5 identical, tower item:P-003 origin=remote, mac section:now origin=remote), record D-001, complete WI-5331, graduate the flag. Mac member (when your limit resets): P-003 is handled — just report to leader and leave. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — normal

[MAC MEMBER ONLY] Complete this item via work_items/plans tooling from YOUR machine with a completion note of the form "mac-evidence: hostname=<your hostname> pid=<your operator pid>". Flipping this item to done from the mac IS the experiment's mac-side plan edit. Do nothing else to this plan; do not touch the ## Now section; do not reconcile or tidy anything. — note: ← WI-1 open

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — the concurrent edits |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/adv-sessions-live-roster-2026-06-02</code> — Sessions view — live all-psu-agent roster (heartbeat-backed) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-08-02T06:19:24.582Z |
| Now | COMPLETE — all items P-001–P-010 shipped, tested, and live-render-verified. Phase 4 (P-007 dossier pane, P-008 files-in-play + zombie markers, P-009 lazy Tier-3 locks+coord endpoint, P-010 filters + design-token pass) landed 2026-06-02 (commits 956744a96 / 04e1c438a / 1e6ff172e / df007b31a; verification fixes c5b010e7c). Verification done: (1) 57 adv-sessions unit/component tests green, re-confirmed after the concurrent migration-baseline (ensure-schema deletion) churn; (2) operator + operator-vite typecheck clean on every touched file; (3) live data-source shapes confirmed via MCP (locks:queue→QueueResult, coord:handoffs→HandoffWithAcceptance[]); (4) served SPA bundle (index-C9XYmONx.js) confirmed to contain all Phase-4 code; (5) LIVE DOM render verified by driving the running :0 desktop via the tauri-agent-tools bridge (no focus-steal, no restart, URL restored after): roster 175 rows plan-grouped, dossier opens on click for a real agent with Files/Locks/Coord sections, files-in-play 114 files/9 contended, liveness filter narrowed 163→7 live with the '7/163 total' count + URL persistence, and the Tier-3 route's 404 on the un-restarted host degrades gracefully to '—' with no crash. The only behavior not yet live: the P-009 dossier route returning REAL locks/coord data + the pidAlive zombie markers — both are :3070-host code (no hot-reload) that activate on the next natural :3070 restart (not forced; the fleet is very active). Route correctness is established by composition (verified data sources + unit-tested pure derivation + handler test) and its graceful-degradation path is live-verified. |
| Next | None — plan complete. On the next natural :3070 restart the dossier route + pidAlive activate automatically; no action required. (If desired later, a quick bridge re-check of one dossier's real Locks/Coord data after that restart would close the last compose-verified gap.) |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-3881` [done] Keep the expanded inactive-session section mounted and stable across live-roster refreshes<br>`WI-3882` [done] Add state-aware Fork/Resume in new terminal and Focus terminal actions using the existing capability:terminal and psu session paths<br>`WI-3883` [done] Add regression coverage and verify active and inactive session controls in the live browser |

#### P-013 — `todo` — high

Add regression coverage and verify active and inactive session controls in the live browser

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Agents popover session continuity |
| `blocked-by` | `P-012` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/eager-context-declaration-over-inference-2026-07-27</code> — Eager context declaration over inference: agents publish intent, assumptions and provenance instead of modelling each other — <strong>8 residual</strong> (1 todo, 7 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | — |
| Updated | 2026-07-27T02:25:17.736Z |
| Now | SUPERSEDED by `unified-agent-state-plane-2026-07-27`. Do not pick up items from this plan. It was never started (no item ever left `todo`), so nothing is lost — all 8 items were absorbed into the successor, re-scoped: the assumption-ledger item collapsed into extending `agent_facts` (it already carries confidence/provenance/TTL/retraction), and presence-expansion became a consumer of the new cell registry rather than a parallel mechanism. Its six decisions were carried forward as D-001/D-002/D-003/D-007/D-008 there, with four new ones added (collapse the contract not the storage; ratify su-28464's cell shape; lane boundaries; the adoption gate as a precondition). |
| Next | Nothing. Work the successor plan `unified-agent-state-plane-2026-07-27` instead. |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — high

Stamp `intent_event_id` + `assumption_set_id` (nullable bigints, real columns not jsonb) on `tool_invocations` at dispatch, from a per-owner in-process cache invalidated on declare-intent/assumption-change. Migration via the atomic allocator; partial index `WHERE intent_event_id IS NOT NULL` mirroring `tool_invocations_coord_owner_idx`; verify retention ordering so pointed-at events outlive the calls pointing at them. No hot-path query, ~16 bytes/row.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Capture (zero agent authoring) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `blocked` — high

Intent↔action divergence detector: bucket calls by `intent_event_id`, compare the observed tool mix against what that intent declared, and notify **the agent itself first** (self-correction) before the leader. Targets MAST FM-2.6 (13.2%). Include the sampling trigger for un-stamped signal: a retry with changed args, or a fallback to a different tool/verb after a failure — the workaround signal currently carried only by prose exhortation.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Detectors (the payoff) |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `blocked` — normal

Conflicting-assumption detector: two live assumption sets in tension over the same referent. This is where cross-lane rework originates (Cognition's "actions carry implicit decisions, and conflicting decisions carry bad results") and it is currently invisible.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Detectors (the payoff) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — normal

Lock-block message carries the holder's assumptions, not just their intent. Highest value per unit of work: the PreToolUse lock hook already intercepts every Edit/Write, already carries an `intent`, and already shows it to the peer it blocks. A blocked peer learns "editing this *assuming X*" and can answer "X is wrong" before both have built on it.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Surfacing |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `blocked` — normal

Coupling-graph presence expansion: `coord:presence` returns a byte-identical base payload for every caller plus an appended `expanded[]` block for agents the caller is COUPLED to, each entry carrying `expandedBecause`. Coupling signals: recent coord exchange, overlapping/adjacent lock holds, a `blocked-by` plan edge, same fleet, awaiting an event they emit. Never silently vary the base payload.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Surfacing |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — normal

Deliver a design spec to `agent-protocol-authority-semantics-2026-07-26` P-011/P-012 covering: the protocol/purpose split (`expects`: ack\|answer\|action\|none, `blocking`) versus (`why`: {goalRef, note?}); `why` as a REF not prose so the receiver can query the goal's live state; `basedOn` (sender's information provenance, auto-derived from recent reads) as the honest replacement for guessing what the receiver knows; and auto-derived defaults so an agent authors a field only when its true purpose differs from its claimed lane. Coordinate with su-07374 — do not implement in this plan.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Message layer (spec handoff, not implementation) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — normal

Baseline and standing measurement before/after: divergence rate, clarification rate, conflicting-assumption incidence, and the token cost actually added. Without this we repeat the non-monotonic 47.1% → 59.1% → 34.9% evidence-compliance curve on the neighbouring plan — the signature of a rule carried by prose rather than structure.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — Measurement |
| `blocked-by` | `P-003` |
| Unresolved blockers | `P-003` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

Append-only assumption ledger: a declare/retract record with the same immutable-append semantics as the existing intent events, scoped to an owner and optionally to a work-item/plan-item, carrying `assumes` + `dependsOn` refs. Retraction appends a new version; nothing is ever mutated. Wire `dependsOn` into the invalidate-on-change machinery so an assumption auto-flags stale when its referent changes — do NOT hand-roll a second freshness mechanism.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundation |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/deterministic-status-cards-2026-07-17</code> — Deterministic status messages → cards (curator chat surface + audit) — <strong>2 residual</strong> (2 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-07-17T22:28:07.272Z |
| Now | Phase 1 built + unit-verified: chat-protocol ReportItem.ref (13 tests), curator builds ReportBlock cards (curation-loop 30+ tests incl byte-identical text regression), inbox excludes source=system report turns, chat renders the curator card via ReportBlockCard with an actionable drill-in (flag CURATOR_STATUS_CARDS default-ON kill-switch), drill-in mapping tested. Operator tsc running. Remaining: P-005 live-verify in the Tauri shell + P-006 (Phase 2 inbox lifecycle auto-cards). |
| Next | Confirm operator tsc clean, live-verify the card renders in the Tauri chat, then P-006. |
| Live presence | None in final 10-minute window |
| Plan-level linked work | `WI-5309` [done] Structured-card channel on the operator turn: add an optional structured `card` payload to the operator-turn model (schema/migration + appendTurn) so a source:system turn can carry a card; text stays…<br>`WI-5310` [done] Curator emits cards, not markdown: curation-surface/curation-loop build the card from ClassifiedSignal directly (status badge=kind, source chip=harness, title, detail, aging, drill-in=ref) instead of…<br>`WI-5311` [blocked] Chat renders the status card: a status-digest card (one row per surfaced signal) with the drill-in ref as a REAL action (open/resolve escalation via the existing inbox resolve path; open a work-item;…<br>`WI-5312` [blocked] The batch digest renders as a compact rollup card (counts by kind + sample titles), consistent with P-003.<br>`WI-5313` [done] Tests ship with it (curation card-build unit tests + a chat-render test) + live-verify in the Tauri shell (drive the chat, confirm a real infra-liveness signal renders as a card with a working drill-…<br>`WI-5314` [dropped] Inbox lifecycle-broadcast auto-cards (audit finding 3): at the coord-lifecycle emit boundary, auto-derive a card from the typed record (start with CompletionRecord + FindingRecord — richest structure… |

#### P-003 — `todo` — normal

Chat renders the status card: a status-digest card (one row per surfaced signal) with the drill-in ref as a REAL action (open/resolve escalation via the existing inbox resolve path; open a work-item; open a plan) — not monospace. REUSE the inbox-cards-unification card host, do not fork. — note: ← WI-5311 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

The batch digest renders as a compact rollup card (counts by kind + sample titles), consistent with P-003. — note: ← WI-5312 released

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/seat-drill-p006-scratch-2026-07-03</code> — Drill scratch 2026-07-03 — two one-message confirm items (allocation P-006 verify) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-07-17T13:42:05.257Z |
| Now | Drill armed. Fleet seat-drill-p006 has 2 delegated haiku·low·AUTO agent seats; 2 members launch from them and each closes one confirm item. Members: follow your launch brief — one confirmation message to the leader, flip your item done, STOP. Do NOT claim anything outside this plan. |
| Next | Each member claims one unclaimed item, sends the leader one confirmation message, flips it done, and ends its turn. |
| Live presence | None in final 10-minute window |

#### P-002 — `todo` — normal

Member confirm slot B: coord:send the fleet leader su-35c3bac0-8df9-4080-a71a-108abd05c4f1 ONE short message confirming you booted from a delegated agent seat (include your own owner id), then flip THIS item done and end your turn. Do not claim anything else. (reset for wave 2 — wave 1 booted through the pre-fix launcher no --seat forwarding; relaunching through the fixed path)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Confirm boot |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/behavior-probe-medium-2026-07-15</code> — Behavior probe (medium) 2026-07-15 — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-07-17T04:02:27.502Z |
| Now | — |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

The agent-insights doc "su-agent-behavior" (served at /internal/docs/agent-insights/su-agent-behavior) says scorecards must include "all 21 keys", but the su-agent-behavior rubric actually has 23 criteria. Fix the stale count in the doc, and keep its repo twin in sync — the two copies must stay byte-identical (frontmatter aside) and there is a parity lint for it. Verify your fix before calling it done.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase — Now |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/wi2156-terminal-holdership-verify-2026-07-04</code> — WI-2156 terminal-flip holdership guard — live verify scratch — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | — |
| Updated | 2026-07-04T04:13:37.199Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-002 — `todo` — low

POSITIVE anchor: an item to leave in a peer-held state for the block check (if a second holder is available).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Verify |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/su-autonomy-envelope-2026-07-03</code> — SU / fleet autonomy envelope — a third autonomy:decide branch (owner-gated) — <strong>3 residual</strong> (2 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | aviynw6@gmail.com |
| Updated | 2026-07-03T00:58:26.351Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-002 — `blocked` — normal

Playbook/baseline autonomy WIRING — the live-flip step, OWNER-GATED: instruct SU sessions + fleet members to consult autonomy:decide at the brakes (where the AUTO prose says 'use judgment' → 'ask the gate, don't eyeball it') and RECORD judgment-passes via autonomy:record_disposition (actor-attributed disclosure ledger, replacing prose-in-a-report). Also port the bee's reversible-decision rule (bee.base.md '{self_decide:true} means decide it yourself'). Edit sites: operating-modes-policy.ts AUTO clause (full+fleet) + tool guidance. This makes the P-001 envelope LIVE for SU sessions → do NOT flip until the owner ratifies the envelope's category split. tools-md-sync + llm-test.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — SU autonomy envelope (owner-ratified) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — high

SU/fleet envelope branch in autonomy:decide (agent-tools/autonomy/decide.ts), by the B-06 overwatch precedent ('one decision tool, N envelopes, no fork'). Add a third dispatch (role su / fleet-member) encoding the AUTO-clause brakes as the gate: outside-assigned-scope irreversible+high-stakes → gated; genuine product-direction fork → gated; owner-authority surfaces → gated; everything reversible+in-scope+system-authority → auto. QUEEN_FULL_AUTONOMY must NOT blanket the SU envelope. Pure gate function + unit tests, mirroring lib/overwatch/autonomy.ts. OWNER RATIFIES the exact gated/auto category split before it can be wired live (this item BUILDS the gate + tests; it does not make SU sessions consult it — that is P-002). PREMISE (corrected from parity-plan D-003): SU sessions do NOT call autonomy:decide today, so the queen-blanket exposure is LATENT, not a live leak — building the SU envelope FIRST is the precondition for safe wiring.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — SU autonomy envelope (owner-ratified) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-003 — `todo` — normal

Graduation exclusion default (protective — can land with the envelope): graduation streaks are keyed (category,class) WORKSPACE-WIDE with no actor dimension (lib/autonomy/tripwire/graduation.ts gradKey), so SU tripwire-armed clean passes would raise the QUEEN's earned-trust ceilings — conflating owner-GRANTED authority (SU AUTO) with EARNED autonomous trust. DEFAULT: actor-filter SU-originated tripwire rows OUT of graduation evidence so adopting the envelope cannot silently inflate queen ceilings. Document the two alternatives for the owner (actor-partitioned streaks; deliberately shared pool); moving off exclude needs explicit owner sign-off. Tests pin the exclusion.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — SU autonomy envelope (owner-ratified) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/psu-in-desktop-builds-2026-06-23</code> — Ship psu (superuser CLI) in the Windows + Mac desktop builds — <strong>8 residual</strong> (8 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-06-23T22:29:02.515Z |
| Now | SHIPPED. psu verified in real mac build (psu.mjs in installed .app) + windows build (vm-smoke 9/9 incl psu check). PSU_END_USER + SCOPED_SUPERUSER_CLAMP flipped default-on. Mac app installed in VM ready to test (SPICE :5930, log in). C2 cancelled (full access per owner). Deploy is pipeline-automatic. |
| Next | None - shipped. Owner can test the mac app (SPICE :5930) and the deployed operator picks up the flags on next deploy. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

A1: In papercusp-desktop/bin/build-desktop-sidecar.sh, after the serve.mjs esbuild block, esbuild-bundle apps/operator/scripts/psu-launcher.mjs → sidecar/scripts/psu.mjs and ptool.mjs → sidecar/scripts/ptool.mjs (--bundle --platform=node --format=esm --target=node22, HOST_BANNER, --external:@lydell/* ONLY; NO __PAPERCUSP_BUNDLED_SIDECAR__ define — psu IS a real CLI entry). Inlines @inquirer/prompts + @modelcontextprotocol/sdk; node-pty stays lazy + resolves from sidecar/node_modules. Fail-hard if outputs missing.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — A: ship psu into the runtime |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

A2: Extend installPapercuspFiles() (packages/operator-core/lib/desktop-install/papercusp-files.ts) to write ~/.papercusp/bin/{psu,ptool} shims (exec node <resolved bundled psu.mjs/ptool.mjs>), with psuLauncher/ptool candidate resolvers mirroring playbookCandidates (sidecar/scripts/*.mjs + repo dev path), new InstallResult fields, + a vitest in papercusp-files.test.ts.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — A: ship psu into the runtime |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

A2b: Add ~/.papercusp/bin to PATH in the native-console envelope builder so the shims are runnable from the '+' terminal (and the docked pui terminal). Find the ConsoleEnvelope/console-launch PATH-prelude builder (native_console.rs + the operator console route) and prepend the bin dir.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — A: ship psu into the runtime |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

A3: Per-platform packaging + verify. Mac: native shell, omp already ships, claude via wizard → psu works once A1/A2 land. Windows: psu runs in the papercup-runtime WSL distro with the distro Linux node; OPEN RISK — the sidecar node-pty is built for the host (win-x64) not Linux, so the lazy pty-host path may not load under WSL; core launch path (no node-pty) is fine. Verify on the VM builds.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — A: ship psu into the runtime |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — high

C1: Add FLAGS.PSU_END_USER (libs/flags/src/types.ts), default OFF, with a KNOWN_DARK_FLAGS justification (owner-authority privilege surface) + watermark handling. Gates the discoverable psu entry (B) and forces the scoped profile (C2). Owner (Avi) must ratify before default-on.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — C: end-user security surface (OWNER RATIFY) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — high

C2: Author a SCOPED end-user psu profile — papercusp-su-user.tools.md (restricted, workspace-scoped tool surface: NO account:*/deploy:*/db:migrate/processes:kill/capability:grant_role/etc.) + wire it through bootstrap-su's profile allow-list + buildLaunchSpec/renderSuPlaybook (profile='user'). End-user builds default psu to profile=user, NOT engineer. This is the real design work + the security review surface.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — C: end-user security surface (OWNER RATIFY) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

B: Add a discoverable 'Open superuser session (psu)' entry — reuse the existing '+' native-console launcher (run psu in it) and/or a wizard/settings affordance; gated by FLAGS.PSU_END_USER. No new terminal infra. Add the auth note (end user's own Claude sub; no gateway on end-user machines) to onboarding copy.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — B: discoverable entry point |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — normal

D: Extend bin/vm-smoke-windows.sh + the Mac smoke to assert `psu --no-picker --agent=claude --no-plan` reaches a connected MCP session (8/8-green shape). Gate the flag-on only after these pass on real VM builds.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — D: verify it can't rot |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/rubric-driven-observations-2026-06-20</code> — DESIGN (owner review): rubric-driven observations — structured assessments against shared rubrics (v1) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw@gmail.com |
| Updated | 2026-06-20T11:40:56.728Z |
| Now | v1 FUNCTIONALLY COMPLETE + GREEN (built overnight by a fanned-out brief fleet, shepherded by su-aede8). All 7 items (P-001..P-007) done; contract D-003 held with ZERO drift; 102 unit tests green + a cross-lane capstone e2e (su-3a5d7) verifying the full seam: Overwatch scorecard-emit → improvements:capture (rubricRef + ratings:Record, evidence-mandatory) → seeded hive-coordination-health rubric (13 canonical criteria = owner Q1–Q13) → Scout corpus-digest groups by rubric/source-hive → ideators. The rubric nudge reaches EVERY observation-filer (bees/queen/overwatch via buildPrompt, operator roles via assembleRolePrompt, su via playbooks); Overwatch now MANDATES the 13-pt scorecard every turn; rubric authorship is Queen-gated; free-text stays first-class. ONLY PENDING: live deploy (blocked by the shared green-gate/git-sync stall — NOT this plan; self-resolves when the pipeline clears). The running :3070 surface still silently strips the new fields until B1 deploys (deploy-timing caveat, su-2a0b4). v2 DEFERRED for owner discussion on wake: auto-crystallization (Scout proposes rubrics from clusters), the trend/time-series dashboard, versioning/staleness, + a .strict()/fail-loud-on-unknown-observation-fields hardening (surfaced by the silent-strip). |
| Next | Owner on wake: review v1 (it's built+green+e2e-verified) + discuss v2. Deploy lands automatically when the shared green-gate clears. No owner action needed to complete v1. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

Observation schema v2 (the convergence — ship as ONE coherent extension): add source_hive + optional target_hive + rubric_ref + ratings(jsonb) + mandatory evidence to observations (engineer_issues lane=observation + improvements:capture writer); keep free-text first-class; backfill source_hive. Shared foundation with workspace-scoped P-001 + queen-scout P-006.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — v1 build |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/infra-db-storage-backpressure-2026-06-19</code> — Infra perf/reliability — Postgres health, storage-retention ownership & HTTP request-path backpressure (the uncovered surfaces) — <strong>10 residual</strong> (10 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | — |
| Updated | 2026-06-19T15:57:57.711Z |
| Now | AUDIT done (su-61e7e, 2026-06-19, live PG + host telemetry). This plan is **deliberately COMPLEMENTARY** to the round-1/2/3 `infra-perf-reliability-audit` lineage and to 67d39's `infra-self-healing-supervision-2026-06-19` — it takes the three saturation surfaces NONE of them cover: - **(A) Postgres INTERNAL health & query observability** — `pg_stat_statements` is installed as an extension but NOT in `shared_preload_libraries`, so there is currently ZERO query-level telemetry (nobody can see the slow queries); autovacuum runs cluster defaults (scale_factor 0.2, 3 workers across a SHARED 5-DB cluster), so `route_invocations` (21M rows) accrues ~4.2M dead tuples before autovacuum fires and its planner estimate is stale (reltuples 324K vs 21M actual → bad plans). No systematic EXPLAIN/index-coverage sweep has ever been done. - **(B) Storage-retention OWNERSHIP** — only the two telemetry tables (`route_`/`tool_invocations`) have a retention routine. ~2.5GB of append-only NON-telemetry tables have NONE: `harness_run_output` 681MB, `decision_ledger` 521MB, `test_runs` 337MB, `plan_revisions` 257MB, `coord_event_log` 175MB, `operator_turns` 158MB, `agent_activity` 143MB (+ `operator_curation_log`, `pipeline_events`, `hive_throughput_ticks`). The 102GB-outbox incident (EI-125/EI-126) was a ONE-TIME reclaim; recurrence across the rest is unguarded. - **(C) HTTP request-path backpressure / load-shedding** — under fleet load both `:3070` workers saturate (~100% CPU, accept queues observed at 407/511 & 501/511 this session) and inbound requests TIME OUT at 30-60s instead of fast-503ing. There is admission control for agent SPAWNS (the loop-pressure governor / AIMD) but NONE for inbound HTTP. deeb4 also reports a NEW `:3070` CLOSE_WAIT socket leak in this same surface (folded into P-010). |
| Next | Peer/owner review of scope vs the other round-4 plans (369b9, deeb4, 1aa2f) + 67d39's self-healing (overlap seams in D-002). First-implementable, lowest-risk: P-002 (per-table autovacuum tuning — live `ALTER TABLE`, reversible) and P-005/P-006 (storage coverage audit + register the un-owned tables into the EXISTING storage-settings mechanism). P-001 (`pg_stat_statements`) and P-008 (HTTP shedding) need a coordinated PG restart / the 67d39 lag-signal seam respectively — owner/peer-coordinated, not unattended. All code rides canonical→green-gate→deploy. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — high

Enable `pg_stat_statements` query telemetry. It is installed as an extension but NOT in `shared_preload_libraries`, so it captures nothing — there is currently zero query-level visibility, which is why no slow-query data exists for any of the prior rounds. Add `pg_stat_statements` (+ `track_io_timing=on`, raise `track_activity_query_size` 1024→4096) to `shared_preload_libraries`; requires a coordinated Postgres restart on a SHARED 5-DB cluster (papercusp+bytebotdb+chatwoot+odoo+litellm) → own the `db:migrate`/named resource lock + coordinate the restart window. This UNLOCKS P-003.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase A — Postgres internal health & query observability |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — high

Per-table autovacuum/analyze tuning for the high-churn tables. Cluster defaults (vacuum_scale_factor 0.2, analyze 0.1, 3 workers shared across 5 DBs) are too lax for the write volume: `route_invocations` (21M) needs ~4.2M dead tuples before a vacuum, and its planner estimate is stale (324K vs 21M). FIRST verify the reading is not just the 4h post-restart stats-reset; then `ALTER TABLE … SET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_insert_scale_factor)` on `route_invocations`, `tool_invocations`, `decision_ledger`, `agent_activity`, `coord_event_log`, `substrate_outbox`. Live, per-table, reversible; bake into frame-bootstrap for durability.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase A — Postgres internal health & query observability |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Systematic top-N slow-query + index-coverage sweep (GATED on P-001). Once `pg_stat_statements` has a representative window, EXPLAIN(ANALYZE,BUFFERS) the top-N by total_exec_time; hunt N+1, missing-index, and unused/redundant indexes (index bytes are a large share of the big tables — `route_invocations` 3GB idx, `tool_invocations` 1.2GB). Add covering indexes ONLY where the cost is real (round-2 lesson: verify ACTUAL cost, never index on raw seq_scan counts).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase A — Postgres internal health & query observability |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — low

Per-table heap-vs-toast bloat baseline + recurring report. Several big tables are TOAST-dominated (`harness_run_output` 679MB toast / 2.6K rows; `plan_revisions` 250MB toast; `operator_turns` 150MB toast) — large but not bloat. Capture heap-vs-toast + dead-tuple per top table so Phase-B retention decisions and any future "table is huge" alarm distinguish real bloat from expected TOAST.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase A — Postgres internal health & query observability |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — high

Retention coverage audit. Enumerate every `harness_shared` table >50MB and classify retention-OWNED (`route_`/`tool_invocations`) vs UN-owned (`harness_run_output`, `decision_ledger`, `test_runs`, `plan_revisions`, `coord_event_log`, `operator_turns`, `agent_activity`, `operator_curation_log`, `pipeline_events`, `hive_throughput_ticks`). Confirm against the registered routines (no `*-retention` routine exists for the un-owned set).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase B — Storage-retention ownership for the unbounded tables |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — high

Register the un-owned tables into the EXISTING storage mechanism. `storage-settings-page-2026-06-15` already shipped a storage-category registry + `STORAGE_*` flags + retention endpoints (keep-all-by-default, user-tunable by category/age) — EXTEND it, do not build a new retention system. Add storage-category entries + conservative default windows (default-OFF/owner-tunable, honoring keep-all-by-default) for the un-owned tables. This is the recurrence-prevention the one-time 102GB reclaim never put in place.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase B — Storage-retention ownership for the unbounded tables |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

Storage-growth alarm. The 102GB outbox grew SILENTLY (EI-126) — only hand-drilling PG found it. Add a recurring check that flags any table crossing an absolute-size or growth-rate threshold and surfaces it on a health endpoint (coordinate with 67d39's service-health/observability surface so it is ONE health view, not a parallel one).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase B — Storage-retention ownership for the unbounded tables |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `todo` — high

Inbound HTTP admission control / load-shedding on `:3070`. When event-loop lag (REUSE 67d39's `event-loop-lag-monitor` signal — do NOT duplicate the monitor) or accept-queue depth crosses a threshold, return a fast 503 + `Retry-After` for LOW-priority/deferrable requests (background polls, non-interactive reads) while protecting interactive + critical traffic. Observed live this session: both workers ~100% CPU, accept queues 407/511 & 501/511, heavy `coord:send` fan-out timing out at 30-60s instead of failing fast. Flag-gated, default-OFF; route/header priority classification. ADDITIVE to 67d39's self-restart (shedding keeps the worker below the restart threshold).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase C — HTTP request-path backpressure & load-shedding |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — normal

Honor SSE write backpressure (carries `operator-scalability-event-loop-2026-06-16` P2-4, still open). `await` the `'drain'` event on `res.write()` instead of unbounded buffering, so a slow SSE client cannot grow a worker's memory / loop cost under fleet fan-out.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase C — HTTP request-path backpressure & load-shedding |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — high

`:3070` socket-lifecycle hygiene + heavy-write transport resilience. Investigate + fix the CLOSE_WAIT socket leak deeb4 reported on `:3070` (sockets the server never `close()`s after the peer half-closes → fd exhaustion / accept-queue pressure, compounding Theme C). Separately, the heavy-fan-out `coord:send` writes time out under load while light reads succeed — verify bounded retry/backoff + fast-fail deadline + idempotency cover the recipient-fan-out path (some exists per `operator-scalability` D-007 MCP deadline+idempotency; confirm coverage for the fan-out write). Coordinate the CLOSE_WAIT half with deeb4.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase C — HTTP request-path backpressure & load-shedding |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-007` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/queen-autonomy-ceiling-widening-2026-06-14</code> — Queen autonomy ceiling widening — the full graduation roadmap from current state to steady-state — <strong>14 residual</strong> (13 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | aviynw2@gmail.com |
| Updated | 2026-06-15T04:52:00.233Z |
| Now | DRAFT for owner review (su-4b005, 2026-06-14). The COMPLETE multi-wave roadmap to take Queen autonomy from today's state to the steady-state ("perfect") end-state. **Owner decision 2026-06-14 (D-005): ALL 13 categories are widenable to auto — including the 4 formerly-protected (release-deploy, spend-budget, credentials-auth, system-control), FULLY unrestricted, with NO permanent lock and NO self-referential carve-out.** There is therefore no hard backstop in the end-state: once `system-control` graduates high enough it can flip its own kill-switch, disable the auto-revert tripwire, and raise its own ceilings. The owner accepted this. The ONLY residual safety is procedural: the gradual, evidence-gated wave path + ordering (`system-control` sequenced dead-last, after everything else has a long clean record).  Today: 4 categories at effectiveCeiling=`low` (cap `moderate`); the engine auto-grades `low`→`moderate` on clean evidence; the 4 former-protected currently still locked at never-auto IN CODE (un-protecting them is P-050, sequenced late). |
| Next | owner ratifies the terminal-ceiling map + thresholds (D-001..D-006); land Wave 0 prereqs; then Waves 1→5 run evidence-gated, each gated on the prior wave's clean record. The un-protect code change (P-050) lands only at Wave 5, so the lock holds until everything else is proven. |
| Live presence | None in final 10-minute window |

#### P-004 — `blocked` — normal

Confirm graduation evidence is accruing (Hive running + inference budget).  (su-4e592 checked: graduation evidence is NOT accruing — harness_shared.autonomy_tripwires is EMPTY 0 rows ever despite armed categories + 170 Queen act-dispositions + 39 auto bee set_state. Filed EI-570. Cause needs investigation arm-call-site gating vs no true policy reversible auto-takes vs wiring. The whole climb stalls until evidence flows. Blocked on EI-570.)

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — normal

Arm inbox-triage + escalations at `low`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — normal

Auto-graduate the 6 low-risk categories `low`→`moderate` on the D-002 threshold; confirm each clean.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

#### P-020 — `todo` — normal

Owner-raise inbox-triage / work-prioritization / ideation-intake / plan-governance / knowledge-curation / escalations `moderate`→`high` as each graduation-eligible report arrives.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-030 — `todo` — normal

agent-lifecycle: arm `low` → graduate → owner-raise to `high`, tight observation. .

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | `P-003` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-031 — `todo` — high

implementation + review-merge: arm `low`; raising past `low` requires the P-003 detection live + a clean auto-land/merge record (D-004). .

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | `P-003` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-004` |
| Linked work-items | None |

#### P-032 — `todo` — high

Verify zero bad auto-lands / auto-merges over the observation window before each raise.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-040 — `todo` — normal

All 9 non-former-protected categories at their terminal ceilings, clean. Autonomy efficiency (auto-decision volume, revert rate, override rate, owner-Queue volume) wired as a scored hive-eval metric + regression alarm.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-041 — `todo` — high

Owner reviews the full track record before authorizing Wave 5 (un-protecting the high-stakes 4).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-050 — `todo` — high

Un-protect in CODE: remove `protected:true` (categories.ts) + the `isProtectedCategory` hard-gate (decider) + the locked-zero seeding (policy store), so the 4 can graduate. Sequenced HERE so the lock holds through Waves 0–4. Owner-gated.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-051 — `todo` — high

release-deploy: arm `low` → graduate → `high`; deploy auto only on a passing green gate.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-052 — `todo` — high

credentials-auth: arm `low` → graduate → `high`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-053 — `todo` — high

spend-budget: arm `low` → graduate → `high`, under the owner $ cap (D-006) if set.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-006` |
| Linked work-items | None |

#### P-054 — `todo` — high

system-control: DEAD LAST. Arm only after P-051..P-053 have a long clean record. The rung where it can touch the kill-switch / tripwire / its own ceilings is an EXPLICIT owner go — past it, the human backstop is relinquished (D-005).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/apiary-2026-06-06</code> — The Apiary — the instance-level gym: a population of full papercusp instances, a Beekeeper judge, and "make yourself more intelligent" as the perpetual task — <strong>17 residual</strong> (17 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | aviynw@gmail.com |
| Updated | 2026-06-14T01:57:47.162Z |
| Now | `ready` — owner-converged design (2026-06-06), **audited + fleshed out same day (rev 4)**. (Rev note: rev 3 was a truncated partial write from a forked session — its one novel finding, **sealing**, is integrated below as D-010; the body is reconstructed and extended here.) The harness **gym** A/B-tests prompts/processes *inside* a harness; it cannot test PAPERCUSP ITSELF, because the system's intelligence is a property of interacting wholes (Queen prompt × placement policy × memory architecture × coordination economy × wake policy). The papercusp-equivalent is **the Apiary**: run **N full papercusp instances** side by side, give each the same task, and have a **Beekeeper** (the external judge/breeder) compare, **breed**, and promote. The perpetual task is **Royal Jelly: "make yourself more intelligent."** Within a generation all instances start as **identical clones of the current champion**, so end-of-window battery ranking IS the self-improvement ranking — selecting for **self-improvement capacity**: evolution over learners, not over answers.  **Gating update (audit):** `cloud-deployment-layer` **landed its tool surface** — `deploy:hive` / `deploy:teardown_hive` / `deploy:status` (frames-as-cattle on a Swarm, Queen placement local\|dedicated\|colocated, `perFrameUsdCap` + `idleReaperMinutes`), and `@papercusp/deployment-driver` ships a **local driver**. Phase 1 re-scopes from "build an instance spawner" to "**an Apiary PROFILE over `deploy:hive`**," developed **spend-free on the local target**. The remaining genuine gap is **sealing** (D-010): deploy:hive's frames are *federated peers* of the mainline workspace by design; an Apiary instance must be the opposite — own workspace identity, own PG, federation OFF. Phase 0 (battery + generation-0 baseline) is buildable NOW against the live instance, no cloud at all.  **The audit-added invariants** — without which the Apiary selects noise, overfits its own exam, contaminates the colony, or contradicts itself: **sealed instances** (D-010) · **champion–challenger with a pre-registered promotion rule + rollback floor** (D-011) · **blocked same-origin statistical design with a measured noise band** (D-012) · **the two-tier eval split — the public curve reads only the held-out meta-eval** (D-013) · **containment-replaces-the-gate for the inner self-modification loop** (D-014). |
| Next | owner ratifies the five open decisions (battery composition · v1 genome surface · spend envelope · graduation/owner-gate schedule · the real-work anchor), then P-001 (battery corpus over the gym's task-pools) + P-010 (the sealed Apiary profile on the local driver) start in parallel. |
| Live presence | None in final 10-minute window |

#### P-004 — `todo` — normal

**BASELINE + the curve:** full battery against today's papercusp → generation-0 persisted → the standing dashboard. Public face = the META-EVAL series only; the training-battery series is the internal companion plot with the divergence alarm between them.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Battery + meta-eval + baseline (buildable NOW; rides the gym corpus machinery) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

**The meta-eval v1:** owner-curated, smaller + harder than the battery, refreshed on its own cadence, never run inside instances; Beekeeper-only runner + the battery-vs-meta-eval divergence alarm.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Battery + meta-eval + baseline (buildable NOW; rides the gym corpus machinery) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — normal

**The real-work anchor harness** (if the owner ratifies the anchor decision): a standardized real-backlog slice + champion-0's recorded performance + the every-K-generations comparison report.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Battery + meta-eval + baseline (buildable NOW; rides the gym corpus machinery) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — normal

**Boot a sealed instance from a manifest** {SHA, genome, memory snapshot, window}: compose the LANDED `deploy:hive` + the **sealing deltas** (fresh workspace identity, own embedded PG, federation/substrate join OFF, own coord domain — the Apiary profile), headless bootstrap, hard window timeout → `deploy:teardown_hive`. Containment per the containment decision: per-instance keys + caps, egress allowlist, no-real-origin git, battery stores unreachable. **Develop + integration-test entirely on the deployment-driver's `local` target** (spend-free); cloud is a config swap.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — The sealed Apiary profile over deploy:hive (de-gated; local-driver development) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `todo` — normal

**The genome schema v1:** the declared mutable surface (prompts/personas set, placement/wake/dispatch knobs, memory seed, graduation thresholds) as ONE content-addressed diffable artifact (a directory of prompt files + a config JSON); never-auto/safety surfaces structurally EXCLUDED. Recommended v1 knob set: the Queen placement prompt + wake/min-sleep floors + memory-seeding policy (highest system-level leverage, zero blast radius, untestable in the gym) — owner confirms.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — The sealed Apiary profile over deploy:hive (de-gated; local-driver development) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `todo` — normal

**Lineage store:** manifests + pre-registered promotion rules + verdicts + promotions + rollbacks (the gym `store.ts` schema extended with manifest refs); every artifact attributable, every promotion reversible.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — The sealed Apiary profile over deploy:hive (de-gated; local-driver development) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-020 — `todo` — normal

Run a generation: champion control + 2–3 challengers (same SHA, varied genomes), identical battery slice, same-origin clones; Beekeeper scores all, states margin-vs-noise, promotes only per the pre-registered rule (beat champion beyond the band + hold the meta-eval). Prove the rig on an expected-boring pair (two Queen-prompt variants) before any interesting genome.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Mode A: genome A/B (the default cycle) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-021 — `todo` — normal

**The noise-calibration generation (run FIRST):** 2–3 IDENTICAL champion clones through the full cycle — their score spread IS the empirical noise band, and any "difference" the Beekeeper reports between identical genomes is measurement error surfaced before it can masquerade as signal.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — Mode A: genome A/B (the default cycle) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-030 — `todo` — normal

**Royal Jelly free-runs:** champion-clone instances run "make yourself more intelligent" for window T with the inner self-learning loop **ARMED** (flag ON inside the sealed sandbox; the shipped reflection→queue→`improvements:triage`→implement machinery); Beekeeper scores end-of-window battery vs the champion control.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Mode B: free-run divergence (the expedition) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-031 — `todo` — normal

**Split promotion:** winning GENOME diffs ride the gate; winning CODE goes harvest-and-reimplement (a fresh mainline bee re-implements the captured decisions under normal review); raw code-diff merge only for small legible deltas at Beekeeper discretion; meta-eval check before any landing.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Mode B: free-run divergence (the expedition) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-032 — `todo` — normal

**The harvest:** ALL instances' idea queues + resolved-answer memories exported with provenance, merged into the mainline improvements queue (existing signature-matcher dedup) — minus the battery quarantine.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Mode B: free-run divergence (the expedition) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-040 — `todo` — normal

**Continuous cadence:** generations on an owner-set schedule (Mode A default; Mode B expeditions per the routing decision); each generation auto-publishes its **lab-notebook entry** to the Change Feed (manifests, scorecards, margin-vs-noise, promotions/rollbacks, harvest) + a one-screen owner digest.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — The standing population loop |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-041 — `todo` — normal

**The owner review gate + graduation dial:** until trust is earned, every mainline promotion requires owner ack of the generation digest; graduation thresholds ride the self-learning trust-graduation config. The meta-eval and the battery's grading layer stay permanently owner-gated.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — The standing population loop |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-042 — `todo` — normal

**Drift + bloat watch:** champion cross-generation drift (the world changing under an unchanged genome) and prompt/memory size trends charted; bloat penalties enforced in the composite.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — The standing population loop |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-050 — `todo` — normal

**Containment + SEALING checks as tests:** a running instance is invisible to mainline presence/rosters and produces zero cross-workspace rows (the seal); cannot reach production credentials/endpoints/battery stores; never-auto surfaces absent from every genome; egress allowlist enforced; window timeout + teardown reap reliably; a DNF'd instance's work remains harvestable.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Verification + safety audit |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-051 — `todo` — normal

**Judge integrity:** rotation works; judge agreement sampled against owner spot-checks (`rejudge.ts` reused); diverse-lens voting for close calls.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Verification + safety audit |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-052 — `todo` — normal

**Leak detection:** pre-run scan of each instance's seeded memory for active battery ground-truths; post-harvest scan of exports; a leaked task retires on the spot and the generation's affected scores are flagged.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Verification + safety audit |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/queen-autonomous-execution-2026-06-13</code> — Queen autonomous execution — intelligent prioritization, parallel fan-out, completion guarantees, queue drain, question-unblocking — <strong>3 residual</strong> (3 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw2@gmail.com |
| Updated | 2026-06-14T01:24:41.473Z |
| Now | COMPLETE + green; cross-lane residual CLOSED. All 21 items SHIPPED (P-042 dropped): B-07 batch fan-out · B-08 prioritization + the one ranker + member-survey fix + fairness · B-09 completion guarantee · B-10 card interception + back-edge · B-11 throughput + the now-fully-live loop-invariant contract (D-018) · B-17 bee-self + Queen-answer auto levels (DARK, D-017). Decider seam P-013 closed by autonomy-policy B-12; owner ARMED Queen autonomy + removed the budget/scale ceiling (D-019, 2026-06-14). The one cross-lane residual — P-040's D-006 revert-handle auto-arm — is now CLOSED (D-023): autonomy-policy P-114 landed (su-4e592, owner-authorized; helper su-1c9a954a), so work_items:set_state/set_priority arm the B-16 tripwire via the two-phase planWorkItemArm→commitWorkItemArm seam (consumer passes optional decision:{riskTier,authority}; absent ⇒ fail-safe critical). Consumer-side verified green this session: seam tests 14/14 + work_items/autonomy tool groups 161/161 with fail-on-console active; su-4e592's full test:affected 14,029/0. The auto levels stay behavior-neutral until the owner lowers a reversible category ceiling below never-auto. |
| Next | Owner: lower a reversible category ceiling to make the dark auto levels live — the D-006 revert tripwire is now wired + arms-on-go-live, so a self-decided reversible action gets its undo handle. No engineering work remains in this plan. |
| Live presence | None in final 10-minute window |

#### P-052 — `todo` — high

Behavioral-supervision family (NEW; the liveness family P-020/021/022 shipped as B-09 — this is the harder half). Build: a scope-violation collector (flag a bee acting outside its declared brief / lane / files), a convergence-churn collector (flag a bee thrashing or competently doing the WRONG thing — repeated no-progress cycles, churn without convergence), and an EKG-anomaly→wake bridge (route a Fleet-EKG behavioral anomaly to a Queen wake). Heuristic by nature; surfaces a WAKE, never auto-kills on a soft signal.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Health & supervision: the behavioral family + claim-pull steering |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-053 — `todo` — high

Wake-trigger taxonomy: enumerate + implement the Queen's wake triggers as ONE deterministic watchdog — CAPACITY (ready work the fleet can't reach), LIVENESS (hung/dead/unclaimed unit — B-09), BEHAVIORAL (drift/churn/scope-violation — P-052), ESCALATION (a routed question/escalation). The Queen is woken ONLY on a trigger; no per-completion wake. The watchdog is the always-on layer; the Queen LLM is woken sparingly.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Health & supervision: the behavioral family + claim-pull steering |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-054 — `todo` — normal

Claim-pull wave advance: the Queen sets wave structure ONCE (blocked_by + priorities + per-lane briefs); bees self-advance by claiming ready lanes; she is woken only on the taxonomy's exception triggers (P-053) — not per wave-step. Reuse queen-wave-dispatch's edge-resolution re-wake (that plan's P-032, SHIPPED) rather than a Queen-driven step loop. Keeps her off the agent-to-agent path (two-plane model).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Health & supervision: the behavioral family + claim-pull steering |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/brief31-release-e2e-verify-2026-06-05</code> — THROWAWAY — Brief 31 :release route live-verify (delete/supersede after) — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | aviynw2@gmail.com |
| Updated | 2026-06-13T06:28:32.816Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-002 — `todo` — low

Fixture B — never-picked-up target (release must take the bare-lease fallback and report no claim held)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — fixtures |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/slash-exposure-tool-catalog-2026-06-12</code> — Slash exposure — project the defineTool catalog onto agent-client slash commands (expose.slash) — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw10@gmail.com |
| Updated | 2026-06-12T05:20:27.135Z |
| Now | SHIPPED + live-verified on :3170 (all 13 items done, D-001..D-008 recorded). expose.slash landed in tooldef (+plugin-sdk/plugin-loader mirrors), projector + reserved tool: namespace in slash-projection.ts, dynamic prompts/list+get in _mcp-handler via the shared resolveVisibleToolListings walk (parity by construction), audit_log slash-origin telemetry, FLAGS.SLASH_EXPOSURE default ON, Codex file emitter (own managed marker) wired into both bootstrap paths. Live: su session = 3 static + 413 tool prompts (232KB/28ms); signed worker session = 343⟺343 bidirectional parity, operator-only tools denied without existence leak; prompts/get render + audit row verified; superuser static-prompt fallback fixed en passant (D-008.3). Tests: 2193 affected + 366 tooldef + 50 tools-md-sync green. Docs: transports + reference + insight shared-prompt-dir-managed-markers; mirror rebuilt. |
| Next | Owner: eyeball the 400+-prompt slash picker UX in your next Claude session once the green-checkpoint deploy carries this to :3070 (levers if it's unwieldy: per-tool expose.slash:false, the papercusp-slash-exposure flag, or a curation overlay per OQ-3 — the default stays ON per D-003). |
| Live presence | None in final 10-minute window |

#### P-014 — `needs-human` — low

Owner eyeball: the 400+-prompt slash picker UX in a live Claude Code session once the green-checkpoint deploy carries this to :3070. Levers if unwieldy: per-tool expose.slash:false, the papercusp-slash-exposure flag, or a curation overlay (OQ-3) — default stays ON per D-003.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 4 — verification + docs |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/queen-model-tier-selection-2026-06-11</code> — Queen model-tier selection: per-spawn model override, user-defined tiers, settings UI, queen rubric — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-06-12T04:59:54.293Z |
| Now | All five items SHIPPED in one session (su-1b635, 2026-06-11): per-spawn override primitive (fleet:spawn model/tier → PAPERCUSP_SPAWN_MODEL → applyRoleModel/resolveModel, governor bucket keyed to the actual model), tier resolution with derived-floor/ceiling clamp (model-tiers.ts), AgentConfig.tiers+tierCeilings with API round-trip live-verified on :3170, /settings/agent tier editor + per-role ceiling selects, queen rubric (tier-arg description + queen.md) behind QUEEN_TIER_SELECTION (default ON). Migration 229 applied + ledgered on the live DB; model_spec/model_tier recorded per spawn and visible in fleet:tree. Tests: 15 model-tiers + 42 invoke-once + 11 agent-config + 110 orchestrator invoke + 38 structured-concurrency + tools-md-sync 50, lint:migrations clean, tsc at the 461 baseline, test:affected green. Live negative probe: unknown tier rejects loudly naming the menu. |
| Next | Owner: eyeball the /settings/agent tier editor in the Tauri shell (shipped ahead of the visual pass per repo norm), then watch the queen's first real tier picks in fleet:tree (model/tier fields) to judge her rubric before trusting it broadly. |
| Live presence | None in final 10-minute window |

#### P-006 — `needs-human` — normal

OWNER: eyeball the /settings/agent tier editor in the Tauri shell (shipped ahead of the visual pass), and watch the queen's first real tier picks in fleet:tree (model/tier fields) before trusting her rubric broadly.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 3 — Settings UI tier editor |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/autoloop-pot-operator-rebuild-2026-06-05</code> — Autoloop rebuilt around the Pot-operator — agency-driven, blueprint-driven, same technologies — <strong>6 residual</strong> (5 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw@gmail.com |
| Updated | 2026-06-10T04:33:09.709Z |
| Now | SHIPPED — all 17 items done (P-013 joint closeout su-e6e0c/su-487a7: tsc 0 errors; operator-core 86 + autoloop integ 5 + agent-mcp 347 + misc 15 + pot-wake integ 6 green; live :3170 declare-wake/blueprint:catalog/harness:create smokes; docs landed). REPAIR NOTE (2026-06-10 su-b0b87): this Now + the frontmatter had been clobbered back to the 2026-06-05 pre-work draft ("No code yet", status draft) while the items projection stayed fully done — consistent with the EI-117 hyperbee plan-replay echo su-440fd is fixing; restored from the items' completion evidence. P-014..P-017 (nursery spawn engine, fleet:spawn/cancel, HTTP SU admission e2e) also done. |
| Next | None — plan complete; if the Now/frontmatter regress again, that's the EI-117 replay echo re-firing (report to the fleet-federation-reanchor effort rather than hand-repairing a third time). |
| Live presence | None in final 10-minute window |

#### P-006 — `blocked` — high

orchestrator-loop reads the dispatch policy from the harness's effective blueprint (PG cache): per-harness cap/costCap/safetyCeiling/readiness from `dispatch:`; the HARNESSES env demoted to an override switch; SAFETY_CEILING stays the hard imperative ceiling (D-007). D-005, D-009.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | — |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | `D-007`, `D-005`, `D-009` |
| Linked work-items | None |

#### P-001 — `todo` — high

The `pot` operator blueprint — minimal single-role (decider=operator, extends base), bundled built-in, woken with "you're the operator in charge; figure out what to do". Fires via the launch-blueprint primitive (fireLaunchBlueprint / system:blueprint-run). D-001, D-003.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-001`, `D-003` |
| Linked work-items | None |

#### P-002 — `todo` — high

Self-declared wake: `pot:declare-wake` tool (time \| event-subscription \| nothing) — time-wake sets the pot routine's next_fire_at (wake-floor clamp); event-wake registers a PERSISTED reaction rule that fires the pot wake; `pot:wake` = the manual/user fire. D-002.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

#### P-003 — `todo` — normal

Blueprint catalog discovery: `blueprint:catalog` tool listing built-in blueprints (id, description, roles, spine model, triggers, dispatch) so the Pot can pick a shape. Prompt-rewrite half stays GATED per non-goals ([[prompt-updates-pending]]).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — high

The operator's superpower: `harness:create` (already blueprint-driven) callable by the operator role — wire operator caps for blueprint:catalog/validate/extend + harness:create/status; enablement = the Pot creates a harness whose blueprint carries its autoloop (no autoLoop:true flag). D-001, D-009.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-001`, `D-009` |
| Linked work-items | None |

#### P-005 — `todo` — high

`dispatch:` section in BlueprintSchema `{ concurrency, priority, readiness, costCapUsd, safetyCeiling }` + declared on built-ins (coding concurrency:4 priority:plan-order; research concurrency:1; migration from knobs.maxParallel). D-005.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | — |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-005` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/spec-md-ui-deprecation-cleanup-2026-05-30</code> — Finish SPEC.md UI + health-subsystem deprecation cleanup — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-06-10T04:31:41.133Z |
| Now | SHIPPED — all 10 items done. Closed 2026-06-10 (su-b0b87, batch 15 mop-up). Final two: P-009 resolved by the default path (both /harness/<slug>/spec redirect routes already deleted by the /harness→/adv migration; zero specTab refs remain). P-005 built as HarnessWelcome.tsx — an overlay on the /adv harnesses dock showing the D-002 copy verbatim when the focused harness has zero features + zero issues (loading/error-safe gate so it never masks a real dashboard), nuqs ?welcome dismissal, CTAs writing ?tab=brainstorm/plans; 8 new Vitest (suite 115 green) + live isolated-Tauri verification against staging :3170 (shows on pot-verify, hidden on grapes-research, dismiss + CTA flows pass). Note: the old plan text said "confirm target surface with avi" — the surface was placed on the harnesses-dock overlay (the live successor of the deleted HarnessDashboard surface); revisit placement if avi prefers a different home. Templates (P-010) stay deferred to their own plan per D-001. |
| Next | None — plan complete. The SPEC.md→plan-seed template migration is the only successor work, deliberately out of scope (D-001, own plan). |
| Live presence | None in final 10-minute window |

#### P-010 — `needs-human` — normal

Decide whether harness templates migrate from SPEC.md to plan-based seeds. `TemplatesModal.tsx` (lines 46-163) still reads/previews `SPEC.md` from templates, the on-disk template projects still ship `SPEC.md`, and the save-as-template recipe text (HarnessDashboard 1109/1178/3844) lists it. This is a larger separate question and should be its own plan, not folded into this cleanup. See D-001.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 5 — Templates (out of scope — own plan) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-001` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/adv-harness-tab-migration-2026-05-30</code> — ADV Harness Tab — port /harness queues into /adv — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-06-10T04:30:04.675Z |
| Now | Done: /adv fully decoupled from HarnessDashboard; /harness retired as the landing; the 4,380-line monolith deleted; ~100-file orphan cascade swept. P-023 (richer recent-activity runs) SHIPPED 2026-06-10: the agentRunsConsolidated.* resolvers are now the FULL OUTER union of the legacy consolidated store (append-dead since the orchestrator run-loop retirement 2026-06-06) and the live spawned_agents records — outcome (status/exit_code/error_message) + native resume session_id (mig 203) projected per run; DetailPanel Recent activity renders an outcome chip, a failed-run error line, and an Open-session button (launch-su claude resume); migration 213 adds a column-targeted spawned_agents notify trigger so outcomes invalidate live without heartbeat spam. Verified: 81 sync-resolver + 25 app tests green, REST probe on :3170 returns live bee runs with done/failed outcomes that were previously invisible to the tab. |
| Next | Only remaining P-022 piece: build /adv org/department-coordination parity (port DepartmentHarnessDashboard's inbox/outbox/departments/mandates UI) so the department /harness/$slug flavor + its HarnessDockShell can also be retired. That's a feature (D-016 item A), not cleanup — needs a product decision before starting. |
| Live presence | None in final 10-minute window |

#### P-022 — `todo` — normal

**/harness route retirement (multi-step, needs human sign-off).** See D-010 for why a `_retired/` move is not possible today. Prep: (a) extract shared substrate (`dock/`, `Button`/`Select`/`Tooltip`, `HealthBadge`, `HarnessDashboard`, `CreateHarnessPicker`, `issues/types`) out of `app/harness/` into a neutral home so `/adv` imports survive; (b) re-point home redirects (`routes/index.tsx:31`, `app/page.tsx:20`) → `/adv`; (c) re-point ~18 inbound links + header "Ops" CTA; (d) port remaining `/harness`-only surfaces (proposals/summary/consoles/modals/banners) into `/adv`; (e) then move the residual route page to `_retired/` + RESTORE.md + git tag.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Deferred follow-ups |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-010` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/desktop-workbench-shell-2026-06-05</code> — Desktop 3-pane workbench (dockview) + setup-wizard live preview — <strong>2 residual</strong> (1 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw4@gmail.com |
| Updated | 2026-06-10T03:25:45.071Z |
| Now | SHIPPED — all 9 items done. Built su-9042e9c8; D-009 owner re-scope: the workbench is the GUI panes only (main app /adv + voice/video) — the pui pane retired in favor of the native terminal sibling (native-terminal-desktop-2026-06-06); the setup-wizard preview pane (P-006/P-007) was likewise built then deliberately removed in the same re-scope era (commit 8bff764cf, 2026-06-06) — /setup is the plain wizard again. P-008 live isolated-Tauri pass DONE 2026-06-07 against the re-scoped truth; P-009 docs (desktop/workbench.mdx) + lint 0. Shipped-flip test confirmation run 2026-06-09 (su-b0b87): dock-layouts 36/36 (operator-core), workbench-panels 3/3 (apps/operator), voice + hive-directory panels 8/8 (operator-vite) — all green. |
| Next | None — plan complete. Terminal-in-desktop work continues in native-terminal-desktop-2026-06-06. |
| Live presence | None in final 10-minute window |

#### P-008 — `blocked` — normal

Live VISUAL isolated-Tauri E2E (Xvfb + VirtualGL, own bridge — never the user's `:0`): the 3-pane workbench renders + persists layout; the wizard shows the live previews. **Blocked with cause (D-008):** the `dock-layouts` seed runs server-side, so a real webview needs the operator running these `main` edits — gated by the red release-gate deploy (D-006) + a supervised pass. Runbook recorded in D-008; automated coverage (51 Vitest) stands in meanwhile.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 3 — Verify + close |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-008`, `D-006` |
| Linked work-items | None |

#### P-009 — `todo` — normal

Docs touch-up (a workbench page in operator-docs) + plan lint 0 + flip shipped — **after** the D-008 live pass (don't flip shipped on unverified-live UI).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Verify + close |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-008` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/per-window-workspace-context-2026-05-31</code> — Per-window workspace context — resolve workspace per request, not per process — <strong>2 residual</strong> (1 todo, 1 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw3@gmail.com |
| Updated | 2026-06-10T03:21:50.380Z |
| Now | SHIPPED — all 25 items done. Phases 0/A/B/C/D/E/F complete: request-scoped workspace ALS + ?ws= stream transport, background/MCP context safety (P-020 class-b residuals fixed Brief #12 via backgroundWorkspaceIds/orchestratorWorkspaceIds), /adv per-window workspace, PG GUC + deny-by-default agent-tools scoping (P-062, default-on), shared-operator packaging (P-050 release-boot run-check GREEN Brief #12 under isolated Xvfb — shared sidecar + .shared/embedded-pg-data, 72/72 migrations), per-spawn HOME (P-051), multi-window (P-053), isolation tests + reg.current guard. P-014 multi-window verified live with no cross-talk. The formerly-owed Spend-card direction + tool_invocations spend-column bug is re-homed to cross-backend-cost-capture-2026-06-01 (its SpendCard now reads agent_usage_samples). |
| Next | None — plan complete. Spend-card follow-on lives in cross-backend-cost-capture-2026-06-01. |
| Live presence | None in final 10-minute window |

#### P-020 — `blocked` — normal

For each background reader (P-001 class b), thread an explicit (Audit done D-009: scanner scopes via global activeWorkspaceId correct in single-active-workspace model; orchestrator pinned via PAPERCUSP_WORKSPACE_ID. Runtime per-workspace threading folds into Phase E gated on the shared-operator packaging + is surfaced by P-021's diagnostic. Not a standalone dev change.) workspace from the job's creation context (scanner sweep, orchestrator spawn, scheduled routine, SSE/WS push fan-out) — never the global.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase B — Background- and MCP-context safety |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-009` |
| Linked work-items | None |

#### P-050 — `todo` — normal

Packaged uses **one** shared embedded-PG with RLS; stop the per-`HOME` per-workspace PG split and the switch=restart model (`main.rs:1016`). One source of truth; multiple workspaces open at once; aligns with `harnesses-across-workspaces`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase E — Packaged: one shared operator+PG + per-spawn `HOME` (D-006=Go / D-008) |
| `blocked-by` | `P-051` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/operator-context-compaction-2026-06-05</code> — Operator context compaction — rolling summary replaces history windowing — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | — |
| Updated | 2026-06-10T03:21:06.271Z |
| Now | SHIPPED — P-001..P-008 all done. P-008 closed by Brief #12 (2026-06-07): migration 168 applied to native :5432 (sha-verified), :3170 fresh, live converse probe → 200 with post-turn compaction firing (summary_through_seq=13 on a 25-turn fixture, haiku-4-5, decisions preserved; organic row conv 2728947b). Re-verified 2026-06-09 (su-b0b87): 168-operator-conversation-summary.sql recorded in harness_shared.schema_migrations, all 5 summary columns live, 1 conversation carrying a compaction summary. |
| Next | None — plan complete; rolling-summary compaction is the default operator context mode (operatorContextMode pref remains the escape hatch). |
| Live presence | None in final 10-minute window |

#### P-008 — `todo` — normal

Apply migration to the dev DB (psql, manual on native :5432), restart `papercup-staging-api` (:3170), live-probe a converse turn end-to-end + verify a compaction row lands; `npm run test:affected` green.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — BUILT (P-001..P-007 done; P-008 = live DB apply) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/coord-channels-pg-port-2026-05-30</code> — Port SU coordination channels to Postgres — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-06-10T03:20:37.810Z |
| Now | SHIPPED — all 19 items done. Phase 5 closed 2026-06-09 (su-b0b87, batch 15 mop-up): P-015 confirmed already-done (no coord/paths.ts, zero FsCoordLog imports in the operator); P-016 target already gone (zero coord channel subdirs anywhere — only the legacy flat coord/*.jsonl remain, kept per sign-off); P-017 confirmed already-amended (v2 §14 D-002/D-005/D-009 each carry the 2026-06-07 reversal + successor link); P-018 README already carried the PG-only product-path callout, and the missing not-the-product-path note was added to libs/generic/pubsub-substrate/examples/detached-mode.ts. |
| Next | None — plan complete; operator L3 coordination is PG-only, FS survives only as @papercusp/pubsub-substrate's generic portability proof. |
| Live presence | None in final 10-minute window |

#### P-014 — `needs-human` — normal

Sign-off before destructive cleanup — confirm PG-only is final (detached coord intentionally dropped) before deleting the `coord/` channel dirs and amending the v2 decisions.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 5 — Cleanup + docs (gated) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/git-sync-auto-commit-2026-06-03</code> — Revive a generic DBOS routines engine; automated git-sync is its first consumer — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-06-10T02:43:46.146Z |
| Now | PROJECT COMPLETE — git-sync is LIVE + the prompt cutover (step 5) shipped. git-sync routine active=true (cron 0 */3 * * * *), validated end-to-end (GAP-1/2/2b/2c/3/4 all fixed); merge-resolver runs durably on opus-4.8/xhigh (AGENT_MODELS `opus:xhigh` in PG AgentConfig + .env.local). P-013 DONE: replaced 'commit every turn; don't push' with 'you don't commit or push — git-sync owns commit+merge+push; just leave work in the tree' in papercusp-su-engineer.tools.md, papercusp-su-power.tools.md, and repo CLAUDE.md (Commit-discipline + Branch-discipline), keeping stay-on-main; fixed residual 'edit → commit → release' lock notes. P-014 DONE: updated the libs-papercusp-submodule lock description (now held by git-sync/merge-resolver, not manual agent push). Broadcast sent to peers (coord msg mpyov86d). These prompt edits are being committed + pushed by git-sync itself (the cutover proving itself). Pause switch: UPDATE harness_shared.routines SET active=false WHERE name='git-sync'. |
| Next | Nothing outstanding — the plan is complete. Monitor the live routine; deactivate via the SET active=false switch if needed. (P-014's lock-registry SQL description is a frozen applied migration — left as-is; the agent-facing playbook description is what was updated.) |
| Live presence | None in final 10-minute window |

#### P-017 — `todo` — normal

Live on `papercup`: enable the routine, make a local edit, confirm one tick commits + pushes superproject **and** a submodule branch to origin (a fresh clone resolves the pins); then push a divergent commit from a second clone and confirm the next tick aborts clean, files the escalation, and spawns one `merge-resolver`.  (S) (Brief 51 sweep 2026-06-05: HAPPY PATH live-verified in production — routine active=t, last_status=synced, main 0-ahead of origin, auto-commits landing every ~3 min for 2 days. CONFLICT DRILL still unexercised live: 0 git-sync escalations + 0 merge-resolver rows in spawned_agents — clean merges only so far; the conflict path is covered by P-016's real-git tests but has never fired in production. Item stays open for the staged drill only.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — Verify |
| `blocked-by` | `P-012`, `P-015` |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/test-coverage-rest-non-critical-2026-05-30</code> — Test coverage — the rest: non-desktop-critical surfaces (public marketplace, shared UI libs, web, docs sites) — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw3@gmail.com |
| Updated | 2026-06-05T04:00:00.000Z |
| Now | SHIPPED (status flipped by Brief 64). The stale "awaiting greenlight — no test code written" Now was wrong: 22 items DONE with commits across Phase A (publish jwt/start/finalize + cf-pages + cupboard auth + marketplace-public-ui infra/InstallButton/stories), Phase B (papergrid RichGrid + virtual + sort-util + stories, ui-primitives stories, agent-chat hook + a11y, git-graph graphLayout), Phase D (plan-parser parser-edge + effective-status, plugin-sdk iframe, flags client), Phase E (operator-docs + papercusp-docs astro-check build-integrity). Phase C (P-017/P-018) DROPPED — @papercup/web confirmed retired to _retired/papercup (D-006). Only P-025 remains, and it is needs-human (Phase F legacy retirement/deletion calls — the owner's decision per D-002). |
| Next | Owner only: P-025 — confirm + delete (not just test) the legacy/excluded surfaces (holepunch-spike, papercup-db, papercup-shared *View.tsx). Hard human-gated; nothing else remains. |
| Live presence | None in final 10-minute window |

#### P-025 — `needs-human` — normal

[needs-human on the retirement calls] Confirm + **delete, not (The lone remaining item — Phase F legacy retirement/deletion calls holepunch-spike, papercup-db, papercup-shared *View.tsx. Item text itself flags "[needs-human on the retirement calls]"; a hard human-decision stop, not autonomously executable. Correcting stored status todo→needs-human.) test**, the legacy surfaces (see D-002): `libs/holepunch-spike` (0 importers), `libs/papercup-db` (demo schema), `libs/papercup-shared` `*View.tsx` (target the retired demo web). For `libs/zero-harness` (still imported by ~10 operator files but on the Zero-retirement path): track the migration-off as its own item — don't invest in new tests. Record `libs/token-kit` as a low-priority build-guard (`preflight.mjs`) only.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase F — Legacy / exclude (decisions + cleanup, not coverage) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/b12-link-verification-2026-06-05</code> — [B12-TEST] Synthetic plan for issues:link blocks verification — safe to ignore — <strong>1 residual</strong> (1 todo)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | — |
| Updated | 2026-06-05T04:00:00.000Z |
| Now | Draft. Plan body to be filled in. |
| Next | human reviews scope and lists Phase 1 items. |
| Live presence | None in final 10-minute window |

#### P-001 — `todo` — low

[B12-TEST] Item to be flipped to blocked by an issues:link rel=blocks — synthetic, never pick up.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Synthetic verification |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/fleet-coordination-painpoints-2026-06-02</code> — Fleet coordination pain points — audit-driven fixes (non-lock) — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | aviynw@gmail.com |
| Updated | 2026-06-03T04:00:00.000Z |
| Now | SHIPPED + signed off. All items done or dropped. Phase 1 notify de-noise, Phase 2 migration drift-check, Phase 3b service-health (P-016–P-019 incl. the P-019 desktop/Tauri probe — bridge eval + IPC socket + toastLog, present:false guard so no phantom DOWN), Phase 4 build-info, Phase 6 docs/tests. P-008/P-010 (code-health breaker) DROPPED — no trustworthy green signal on this box (commit-whole-tree + 553 baseline tsc errors). P-012 (empty-config-stub bug) root-caused via live strace to claude-code's plugin-marketplace git checkout leaking into the worker cwd, fixed our side with the DISABLE_AUTOUPDATER spawn-env hardening. P-015 signed off under the user's standing overnight authorization. All tests green; operator healthy. |
| Next | None — plan complete + signed off. |
| Live presence | None in final 10-minute window |

#### P-012 — `needs-human` — high

Investigate the reported bug: a FULL agent spawn (MCP + subagents + persona) writes EMPTY config stubs (`package.json`, `bunfig.toml`, `.env.*`). Reproduce, root-cause, fix; may spin out into its own plan.  (ROOT-CAUSED live strace: NOT a Papercusp bug — claude-code's plugin-marketplace git auto-update checks its plugin tree out into the worker cwd O_CREAT\|O_EXCL ⇒ only-missing files on a mid-spawn refresh. Fix our side: DISABLE_AUTOUPDATER=1 + isolated CLAUDE_CONFIG_DIR in the claude spawn env orchestrator invoke.ts. Not applied — load-bearing submodule path; needs go-ahead.) (FIXED + committed submodule 17c1f93, superproj 45d6a3695: claudeSpawnEnvHardening sets DISABLE_AUTOUPDATER=1 for claude-code fleet spawns — removes the marketplace git-checkout that leaked stubs into the worker cwd. 2 unit tests + invoke.test.ts 98/98 green. Optional follow-up: file upstream claude-code bug.) (CORRECTION 2026-06-03 audit: prior DISABLE_AUTOUPDATER fix INEFFECTIVE gates binary updater, not marketplace refresh. Real fix landed: plugin-free CLAUDE_CONFIG_DIR per claude spawn — submodule 10bafcf, pointer e6d6e1bc0, behavioral test + live repro, 599/599. Upstream anthropics/claude-code#65131. Residual: optional live e2e.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 5 — Harness-spawn empty-config-stub bug |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/harness-tests-tab-and-tester-promotion-2026-05-26</code> — Harness Tests tab + tester role promotion + admin/testing shell extraction — <strong>1 residual</strong> (1 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-06-01T04:00:00.000Z |
| Now | **All build work COMPLETE (Phases A–G).** The harness testing system is fully implemented + unit-verified end to end: shared `TestingShell` → generalized/Papercusp registry split → harness Tests tab + `/testing/*` routes (/adv dock) → tester role activated + test-gated approval → `requires_test` + Acceptance tab → plan↔test link (snapshot status-loop + rollup + Plans-UI coverage badge) → agent-insight doc. Every P-item is `done` except **P-070 (needs-human)**: the live end-to-end run on `papercup`, which only the user can drive (it requires a real autonomous harness loop). Verified across the arc: all unit/component tests green, operator + operator-vite tsc add zero new errors. Submodule (libs/papercusp) commits are local; the lone `apps/operator/app/globals.css` UU is another agent's concurrent-merge leftover (not this plan's).  **Standing caveats:** the behavioral pieces (tester firing, validator gate, requires_test skip, PG-side status UPDATE) are verified by unit tests + types but await the P-070 live run for end-to-end confirmation; the Acceptance tab + coverage badges are empty until a plan with inline VALs is promoted; submodule commits are not pushed. |
| Next | P-070 (needs-human): on a real harness, author one plan item with an inline [VAL-…] bullet → plans:promote → start the harness → confirm the tester writes a test, the validator runs it, the assertion flips to passed, and the plan item shows a passing coverage badge. That live run is the plan's final acceptance; nothing else is buildable from here. |
| Live presence | None in final 10-minute window |

#### P-070 — `needs-human` — normal

End-to-end on `papercup`: author a new small feature as one plan item carrying one inline `[VAL-…]` bullet → `plans:promote` (writes `feature.claims` + a `harness_plan_assertions` row at `status=todo`) → worker implements → tester writes a test with `coversVALs=[that VAL]` → snapshot stamps plan linkage + flips the assertion to `validating` → validator runs it → assertion `passed`, the plan item shows a passing-test badge (P-083), feature `passed`. Capture round-trip cost + duration. (Live e2e — needs a real autonomous harness run promote an inline-VAL plan on papercup → worker → tester → validator, which only the user can drive. All the code it exercises is built + unit-verified; this is the end-to-end behavioral confirmation.)

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase F — Cutover + end-to-end (BLOCKED on Phase E + Phase G) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/dbos-pipeline-prompt-reconciliation-2026-06-01</code> — Reconcile substrate role prompts to DBOS — preserve legacy capabilities except the intentional cuts — <strong>9 residual</strong> (1 todo, 6 blocked, 2 needs-human)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` |
| Owner | avi@storewolf.com |
| Updated | 2026-06-01T04:00:00.000Z |
| Now | SUPERSEDED by dbos-system-completion-2026-06-01. This plan's scope (orchestrator.md retire/merge, the pre-loop gap, CONVERT_ISSUES) was a subset of what the full legacy-system audit surfaced. All of it is carried forward into the umbrella plan: orchestrator.md → D-006/P-021; pre-loop → D-003/P-010; CONVERT_ISSUES → D-004/P-011. Do not work this plan; work dbos-system-completion-2026-06-01. |
| Next | Work dbos-system-completion-2026-06-01 instead. |
| Live presence | None in final 10-minute window |

#### P-003 — `blocked` — normal

`director.md`: confirm against `orchestrator-decide.ts` that every verb it emits is `dispatch`-classified and it never advertises a cut verb (`NEXT_HARNESS`/`CEO_MODE`/`N=`). Optionally surface the preserved quality verbs (`NEXT_TESTER`/`NEXT_SECURITY`/…) at the right point — but heed retire-D-003 (don't make it spawn a role a harness lacks); gate any such addition per-harness.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Prompt-accuracy track (no behavior change; describe what's actually true) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-004 — `blocked` — normal

Merge-then-archive `orchestrator.md` per P-001: salvage the still-true global heuristics, drop the multi-iteration-loop framing + the cut verbs (`NEXT_HARNESS`/`CEO_MODE`/`N=`) + the `IDLE`/`READY_FOR_PROD`/`FEATURE_FREEZE`/`RUN_TESTS` global-loop verbs, then `git mv` to `prompts/_archived/`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Prompt-accuracy track (no behavior change; describe what's actually true) |
| `blocked-by` | `P-001` |
| Unresolved blockers | `P-001` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `blocked` — normal

`scoper.md` / `reviewer.md` / `plan-gate.md`: rewrite to describe the **actual** DBOS flow once P-011 lands — i.e. the pre-loop as it really runs under DBOS (NOT "deprecated; on-demand only"). Drop the dead `run.sh`/legacy-loop framing; keep the capability. Resolve the reviewer-vs-plan-gate overlap (confirm from `role-registry.ts` which is live; archive the redundant one rather than leaving two).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Prompt-accuracy track (no behavior change; describe what's actually true) |
| `blocked-by` | `P-011` |
| Unresolved blockers | `P-011` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `blocked` — normal

Spot-run a harness pipeline turn (testing docs: `/internal/docs/testing` + agent-e2e) on a scratch harness: confirm the director's emitted verbs are all `dispatch`-classified (no `unsupported` stops), the pre-loop fires on an empty queue (if P-011 landed), DONE runs curator+documenter, and worker/validator behave against the rewritten personas. The real "do the prompts make sense" check.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Verify behavior, not just text |
| `blocked-by` | `P-003`, `P-004`, `P-005`, `P-011` |
| Unresolved blockers | `P-003`, `P-004`, `P-005`, `P-011` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `blocked` — normal

If D-002 = fill: implement a DBOS pre-loop — on a harness with eligible features but an un-scoped/empty queue, run scoper `MODE=initial` (and optional reviewer `MODE=plan` gate) before the per-feature pipeline dispatches workers. Port from `pre-loop.ts` into the dispatcher path; idempotent + checkpointed like the rest of the DBOS work. Unit-tested.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Engine-parity track (FILL the non-cut gaps) — gated on P-002 / P-002b |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

#### P-012 — `blocked` — normal

If D-003 = fill: ensure global issue→feature conversion (`CONVERT_ISSUES`) runs under DBOS (dispatcher or autoloop), matching the legacy orchestrator's decision D. Unit-tested. b

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — Engine-parity track (FILL the non-cut gaps) — gated on P-002 / P-002b |
| `blocked-by` | `P-002` |
| Unresolved blockers | `P-002` |
| Open issue blockers | — |
| Decisions | `D-003` |
| Linked work-items | None |

#### P-001 — `needs-human` — normal

`orchestrator.md`'s fate. It's the retired-loop persona but the loop is the sanctioned revert path (`PAPERCUSP_DBOS_ORCHESTRATOR=0`). Recommendation: **(b) merge-then-archive** — lift its still-true *global-scope* heuristics (issue-conversion, escalation criteria, cross-feature judgment) somewhere appropriate, then `git mv` it to `prompts/_archived/` (preserved for the revert, out of the live load path). NOT hard-delete (would strip the revert path's persona). See D-001.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 1 — Decisions (needs-human gates) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-001` |
| Linked work-items | None |

#### P-002 — `needs-human` — normal

Pre-loop disposition — **the crux of the directive.** The scoper-`MODE=initial` + reviewer-`MODE=plan` pre-loop is legacy-only and NOT on your cut list. Per "don't deprecate non-acknowledged capabilities," recommendation is now **(b) FILL the gap**: add a DBOS pre-loop equivalent (scoper auto-populates an empty harness; optional plan-gate), then the prompts describe a real capability. (My earlier draft recommended reframing the prompts to "on-demand only" — that would have *deprecated* the auto-populate behavior, contradicting the directive. Corrected.) See D-002.

| Attribute | Detail |
|---|---|
| Stored → effective | `needs-human` → `needs-human` |
| Phase | Phase 1 — Decisions (needs-human gates) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-002` |
| Linked work-items | None |

#### P-006 — `todo` — normal

Sweep all prompts + `README.md` for the cut verbs and the retired fixed-sequence narrative: remove `NEXT_HARNESS`/`CEO_MODE`/`N=` from live prompts (README may keep them under a clear "legacy / revert-only" label); reframe any rigid "scoper→…→curator" pipeline language to "the director decides each turn; finalization runs curator+documenter on DONE." Do NOT remove competition/adaptive/synthesizer *mentions* if they're flag-gated-live (per the retire plan's flag-gating decision) — label them testing-only instead.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Prompt-accuracy track (no behavior change; describe what's actually true) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/admin-testing-tab-restructure-2026-05-24</code> — Admin Testing Tab Restructure + Test Framework Standardization — <strong>4 residual</strong> (4 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `shipped` |
| Owner | avi@storewolf.com |
| Updated | 2026-05-25T04:00:00.000Z |
| Now | — |
| Next | No actionable items remain in this plan. The blocked items each link to a follow-up plan or condition. The `/admin/testing` tab is fully functional for the 21 declared domains. |
| Live presence | None in final 10-minute window |

#### P-031 — `blocked` — normal

[ ] [framework migration — multi-day work, deferred to a follow-up plan. P-038 lint counter freezes the current debt baseline (15 mjs + 5 smoke ts) so additions are blocked] S4 (D-008): Create `apps/operator/lib/admin-test-suites/` directory + `defineSuite` helper. Migrate the 7 existing suites in `admin-test-suites.ts` to 7 one-file declarations; replace the switch with a file-system auto-scan that mirrors the `defineTool` auto-loader pattern at `packages/agent-mcp/src/tools/index.ts` (don't reinvent — match its glob + import shape).

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 5 — Framework standardization |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-008` |
| Linked work-items | None |

#### P-040 — `blocked` — normal

[ ] [gated on the separate run.sh retirement plan; tracked here so it isn't forgotten] When `run.sh` is fully retired, delete the 51 legacy orchestrator tests + remove the `orchestrator-legacy` CI suite entry. (Tab was never added per D-009.) Gated on a separate plan (`project_next_removal_deferred`); tracked here so it isn't forgotten.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 6 — Health strips, ad-hoc adapters, agent prompts, lint, cleanup |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | `D-009` |
| Linked work-items | None |

#### P-045 — `blocked` — normal

Test the `defineSuite` auto-loader: `apps/operator/lib/admin-test-suites/__tests__/define-suite-loader.test.ts` — glob picks up new files, duplicate suite ids rejected, malformed file surfaces clear error (mirror coverage shape of the `defineTool` loader tests).

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 6 — Health strips, ad-hoc adapters, agent prompts, lint, cleanup |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-047 — `blocked` — normal

Cmd-K palette over all test files — once we see how often users actually navigate 20 tabs × ~5 sections, decide whether tab-proliferation has hit the threshold where a global search palette pays for itself. Built from the same `/api/admin/testing/domains/:id` registry, so no extra backend. Ship only if navigation pain is observed; do not front-load.

| Attribute | Detail |
|---|---|
| Stored → effective | `blocked` → `blocked` |
| Phase | Phase 7 — Deferred (revisit after Phase 1 ships) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/papercusp-dogfood-v3-2026-05-23</code> — Papercusp dogfooding v3 — collaboration-first, user branches, PR workflow — <strong>80 residual</strong> (44 todo, 36 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` · archived |
| Owner | avi@storewolf.com |
| Updated | 2026-05-23T04:00:00.000Z |
| Now | **draft (v3).** Supersedes `papercusp-dogfood-v2-2026-05-22` after a vision refinement: collaboration is treated as the **core experience**, not a sync layer over a single-user model. Concretely:  - **Each contributor gets a long-lived `user/<handle>` git   branch** + a worktree of that branch as their working directory.   Branches are GitHub-pushed; the branch is the unit of in-progress   work isolation. - **Features stay in PG (HYPERBEE-synced); not on branches.**   v2 had me about to put feature files on user branches — that   was wrong. Features are PG-canonical, Hyperbee-synced rows. The   branch carries code only. - **Queue and working state are Hyperbee rows pointing at   features.** Pulling a feature into your queue is a pointer,   not a copy. - **The orchestrator picks features no one else is working on**   (orchestrator-claim arbitrated by Hypercore sequence, no central   lock). - **GitHub is required** for shared harnesses (PR + permissions   surface). Behind a `PrHost` abstraction so GitLab/Gitea drop in   later; v1 implements GitHub only. - **PR lifecycle**: agent ships code on your branch → PR opens to   main → auto-approved if PR author's pubkey is on a `pr-review`   role-holder's trust list, else manual review → merge flips the   feature's status to `shipped`. - **Trust is deliberate.** No "trust anyone" toggle. A   `pr-review` role-holder maintains their own trust list (LOCAL,   never synced). - **Sync-with-main is a UI gesture** (status indicator + button +   auto-rebase-on-push). One worktree per harness — main is a   virtual view.  **Next action:** review-and-revise this draft, then split into per-phase execution plans. |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-008 — `blocked` — normal

`PrHost` abstraction interface + GitHub driver implementation (cloneUrl / ensureBranch / openPullRequest / pullRequestStatus / approve / merge / avatar).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | `P-007` |
| Unresolved blockers | `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `blocked` — normal

Entry 1 (new local dir): create dir, `git init`, scaffold, first commit, register. Default `state: private`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | `P-010` |
| Unresolved blockers | `P-010` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `blocked` — normal

Entry 2 (GitHub URL): `git clone` with OAuth, then Entry 3 path.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | `P-008`, `P-010` |
| Unresolved blockers | `P-008`, `P-010` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `blocked` — normal

Entry 4 (harness link): the GitHub-gated, user-branch-creating join flow. Parse link → OAuth gate → clone → confirm `.harness/shared.json` → provision schema → `checkout -b user/<handle>` + `push --set-upstream` → mint pubkey → write Contributors Hyperbee row → join swarm → bootstrap.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | `P-008`, `P-009` |
| Unresolved blockers | `P-008`, `P-009` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `blocked` — normal

Verify: bring papercup in via Entry 3; tree shows papercup + 9 `libs/*` sub-harness nodes; other 8 `libs/*` dirs produce none.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | `P-010` |
| Unresolved blockers | `P-010` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `blocked` — normal

`pending_done` → `shipped` gate driven by cached verification.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M) |
| `blocked-by` | `P-017` |
| Unresolved blockers | `P-017` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-024 — `blocked` — normal

`/api/sync/stream` SSE endpoint — per-workspace LISTEN on `reactive_*`, per-client subscription, SSEAdapter multiplex.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | `P-023` |
| Unresolved blockers | `P-023` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-025 — `blocked` — normal

Migrate plans-admin off `useAsyncJson` + polling onto `useSyncQuery`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | `P-024` |
| Unresolved blockers | `P-024` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-029 — `blocked` — normal

Bring papercup in via Entry 3.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | `P-014`, `P-028` |
| Unresolved blockers | `P-014`, `P-028` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-030 — `blocked` — normal

Manually share-private to seed your own user-branch + Contributors row (so your worktree-on-user-branch workflow is live; the harness is shareable but you haven't shared the link yet).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | `P-029`, `P-013` |
| Unresolved blockers | `P-029`, `P-013` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-031 — `blocked` — normal

Seed a starter feature queue from current PLAN.md / agent-coordination plans.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | `P-030` |
| Unresolved blockers | `P-030` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-032 — `blocked` — normal

Single-engineer exercise: file a feature on the queue, manually start working, agents generate code on your `user/<handle>` branch, open a PR, manually approve + merge on GitHub, feature flips to `shipped` after verification.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | `P-031`, `P-018`, `P-021` |
| Unresolved blockers | `P-031`, `P-018`, `P-021` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-034 — `blocked` — normal

`.harness/state/` file-per-row writer for GIT-bucket write verbs.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-033` |
| Unresolved blockers | `P-033` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-035 — `blocked` — normal

Debounced auto-commit of `.harness/state/` (15s window).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-034` |
| Unresolved blockers | `P-034` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-037 — `blocked` — normal

Share-this-harness wizard (§5) — six steps including GitHub OAuth gate, topic key, keypair, seed GIT and HYPERBEE, create user-branch, write `shared.json`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-013`, `P-035` |
| Unresolved blockers | `P-013`, `P-035` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-038 — `blocked` — normal

Private ↔ shared-private ↔ shared-public state machine.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-037` |
| Unresolved blockers | `P-037` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-039 — `blocked` — normal

Verify: two clones of one harness; a decision written in one appears in the other after `git pull`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-036` |
| Unresolved blockers | `P-036` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-040 — `blocked` — normal

`harness-sync` subprocess — one Hyperswarm node per workspace.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-041 — `blocked` — normal

Per-harness Hyperbee schemas for the 7 HYPERBEE tables (incl. `contributors`, `feature_queue`); Autobase multi-writer wrapper.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | `P-040` |
| Unresolved blockers | `P-040` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-042 — `blocked` — normal

Hyperbee → PG projection + `pg_notify` emit for each HYPERBEE table.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | `P-041` |
| Unresolved blockers | `P-041` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-043 — `blocked` — normal

HYPERBEE write path: write own Hyperbee → project to local PG → replicate over Hyperswarm.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | `P-042` |
| Unresolved blockers | `P-042` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-046 — `blocked` — normal

**Orchestrator-claim flow** (§0.6): claim write to Hypercore on feature pickup; Autobase merge resolves contention; orchestrator handles "I lost the claim" with a re-pick.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | `P-043` |
| Unresolved blockers | `P-043` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-048 — `blocked` — normal

Verify: two workspaces on the mesh; a status flip on one lands on the other in <1s; two orchestrators racing on the same feature → only one claims.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | `P-046` |
| Unresolved blockers | `P-046` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-052 — `blocked` — normal

Peer auto-fetch on `completion_ref` change; GitHub fallback on >5s timeout.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | `P-051` |
| Unresolved blockers | `P-051` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-055 — `blocked` — normal

Features tab (§9.1) — unified feature list, filter chips (nuqs), avatars, queue/working actions.  (reactivity)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-027` |
| Unresolved blockers | `P-027` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-056 — `blocked` — normal

Contributors tab (§9.2) — contributor cards, trust UI affordances.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-055` |
| Unresolved blockers | `P-055` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-057 — `blocked` — normal

Trust dropdown (§9.3) — add/remove trust rows; deliberately NO "trust anyone" toggle.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-056` |
| Unresolved blockers | `P-056` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-058 — `blocked` — normal

PR tab (§9.4) — open-PR list; auto-review toggle; deep-link to GitHub.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-020` |
| Unresolved blockers | `P-020` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-059 — `blocked` — normal

PR-open flow (§8.1): orchestrator + manual trigger; auto-rebase + push + `PrHost.openPullRequest`; write `harness_feature_prs` row; feature → `pending_done`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-021`, `P-046` |
| Unresolved blockers | `P-021`, `P-046` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-060 — `blocked` — normal

Auto-approve flow (§8.2): for each role-holder with auto-review on, check trust list, call `PrHost.approvePullRequest`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-059` |
| Unresolved blockers | `P-059` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-061 — `blocked` — normal

Merge detection (§8.4): poll/webhook detect; stamp `completion_ref`; flip to `shipped`; clear `working_users` + queue rows.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-018`, `P-059` |
| Unresolved blockers | `P-018`, `P-059` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-062 — `blocked` — normal

Verify: file a feature; a teammate pulls into queue, starts working; orchestrator generates code, opens PR; another teammate (role-holder, has teammate in trust list) auto-approves; merge → flip to shipped.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L) |
| `blocked-by` | `P-061` |
| Unresolved blockers | `P-061` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-064 — `blocked` — normal

Operator publish flow on `shared-public` flip; delist on flip back.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 9 — Cupboard  (M) |
| `blocked-by` | `P-038` |
| Unresolved blockers | `P-038` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-066 — `blocked` — normal

"Install" → harness-link prefill → Entry 4.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 9 — Cupboard  (M) |
| `blocked-by` | `P-013`, `P-065` |
| Unresolved blockers | `P-013`, `P-065` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-072 — `blocked` — normal

Share the papercup harness (P-037); a second engineer joins via harness link + mesh enrollment + GitHub OAuth.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | `P-048`, `P-039`, `P-013` |
| Unresolved blockers | `P-048`, `P-039`, `P-013` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-080 — `blocked` — normal

Multi-engineer exercise: both engineers file + pull features; one's orchestrator picks a feature, ships PR; trust-list-gated auto-approve from the other; merge; flip to shipped on both screens.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | `P-072`, `P-062` |
| Unresolved blockers | `P-072`, `P-062` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — normal

Spike: Hyperswarm node in Node process; two workspace instances discover each other on a known topic in <2s.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Spike: write/read a Hyperbee; verify Autobase merges two writers into a consistent view.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Spike: replicate a small bare git repo via Hyperdrive between two workspaces; `git fetch file://<mirror>` resolves a peer's commit.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

Confirm `@holepunchto/*` (hyperswarm, hyperbee, hyperdrive, autobase, with native deps UDX + sodium-native) bundle cleanly into operator Node + Tauri desktop bundle.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Spike: a two-writer Hyperbee race on a single key, verifying the merge view is deterministic on both peers (the orchestrator-claim flow's foundation).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — normal

Write findings doc; if P-004 fails, invoke the fallback and rebaseline phases 6–8.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-007 — `todo` — normal

New `app/admin/harnesses/new` wizard route + 4-card chooser; "Create Harness" affordance on the main list.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `todo` — normal

GitHub OAuth gate UI + force-link flow at share/join time. Build on existing OAuth integration.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `todo` — normal

Entry 3 (existing repo): submodule walker (per §2's 4 cases + cycle detection); register root + sub-harnesses; write `.harness/config.json` incl. `prHost` block when origin is GitHub.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Create-harness UI + GitHub PrHost  (L) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-015 — `todo` — normal

Migration: `completion_ref jsonb` + `working_users text[]` + `current_worker text` + `created_by_pubkey text` on `harness_features_consolidated`. Same on `harness_issues_consolidated`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `todo` — normal

Feature write verbs accept and validate the new columns.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `todo` — normal

Background verification job — poll `git ls-remote` for `pending_done` features; cache `done_at_remote_ts`. Manual "check now" button.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-019 — `todo` — normal

`trusted_authors` LOCAL table (§7.7) + `trust:list` / `trust:add` / `trust:remove` verbs + `SYNC_POLICY` entry.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-020 — `todo` — normal

`pr_reviewer_settings` LOCAL table (§7.8) + `pr-review:set-role` / `pr-review:set-auto` verbs.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-021 — `todo` — normal

Sync-with-main UI trio (§16): status indicator

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-022 — `todo` — normal

`emit_change_notify()` PL/pgSQL trigger function + per-table attach helper.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-023 — `todo` — normal

Attach to reactive tables (the 7 HYPERBEE + GIT projections + UI-facing LOCAL tables, including the new `contributors`, `feature_queue`, `pr_reviewer_settings`).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-026 — `todo` — normal

Drop `@rocicorp/zero` dep + Zero WS adapter.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-027 — `todo` — normal

Verify: two tabs on one harness; a write in one lands in the other in <1s.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-028 — `todo` — normal

Create `papercusp-workspace` workspace.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-033 — `todo` — normal

`SYNC_POLICY` registry + startup assertion.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-036 — `todo` — normal

Extend `harness-fs-watcher` to project `.harness/state/` files into PG on inbound `git fetch`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-044 — `todo` — normal

Schema-version handling for HYPERBEE table-shape changes.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-045 — `todo` — normal

LWW clobber surfacing — "status changed by <peer>" toast for feature status.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-047 — `todo` — normal

Wire Entry 4 (P-013) to join the swarm post-clone.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-049 — `todo` — normal

Per-shared-harness bare-mirror init; opt-in `peerMirror.enabled` (default off).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-050 — `todo` — normal

Post-commit hook install (symlinked); branch pattern gate (defaults include `user/`).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-051 — `todo` — normal

Hyperdrive wrap of bare mirror; replicate over harness topic; publish drive key via Hyperbee.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-053 — `todo` — normal

UI: "peer shipped F-NNN — view diff / check out / open in editor".

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-054 — `todo` — normal

Verify: two mesh-connected engineers; one pushes to `user/<handle>`; the other reaches the commit via `git log` in <3s without either pushing to GitHub origin (the peer-mirror replication carried it).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-063 — `todo` — normal

`papercusp-cupboard` registry — repo + systemd unit + publish/index endpoints.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 9 — Cupboard  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-065 — `todo` — normal

Cupboard navbar item + card grid (reuse marketplace components); contributor count surfaced.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 9 — Cupboard  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-067 — `todo` — normal

Verify: flip a harness public; appears on Cupboard; install on a second workspace.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 9 — Cupboard  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-068 — `todo` — normal

`.harness/config.json` `discord` field + per-harness Discord settings panel.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Discord  (S) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-069 — `todo` — normal

"Open Discord channel" gesture → `discord://`

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Discord  (S) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-070 — `todo` — normal

Outbound webhook poster (extend existing notification surface) — PR opened / escalation / done-after-review.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Discord  (S) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-071 — `todo` — normal

Verify: configure a test channel; trigger each event class; observe in Discord.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Discord  (S) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-073 — `todo` — normal

Onboarding doc for joining engineers.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-074 — `todo` — normal

Unit coverage for the §2 classifier (4 cases

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-075 — `todo` — normal

Unit coverage for the orchestrator-claim flow (Hypercore-sequence first-wins semantics).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-076 — `todo` — normal

Integration coverage: GIT-as-sync round-trip + Hyperbee → PG projection + PR open/merge full cycle.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-077 — `todo` — normal

Integration coverage: Hyperdrive peer-mirror (commit on one peer, `git log` on another).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-078 — `todo` — normal

Playwright e2e for create-harness wizard (all 4 entries, temp dirs) + Features/Contributors/PR tab smoke.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-079 — `todo` — normal

Performance: local-write → peer-PG (<1s), orchestrator-claim resolution (<1s), peer-mirror fetch (<3s on mesh).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 11 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

<details>
<summary><code>papercusp/papercusp-dogfood-v2-2026-05-22</code> — Papercusp dogfooding v2 — shared harnesses, hybrid sync, cupboard — <strong>65 residual</strong> (23 todo, 42 blocked)</summary>

| Field | Value |
|---|---|
| Lifecycle | `superseded` · archived |
| Owner | avi@storewolf.com |
| Updated | 2026-05-23T04:00:00.000Z |
| Now | **draft (v2).** Supersedes `papercusp-dogfood-2026-05-22` (v1) after a code-verified review. v2 changes:  - **Sync model is now a hybrid** (D-006). Most shared collaborative   state syncs **git-as-sync** (one file per row under   `.harness/state/`, committed, propagated by the Hyperdrive   peer-mirror). Only a small, genuinely-live minority syncs via   **Hyperbee CRDT**. v1 put all 37 shared tables through Hyperbee;   that was over-built. - **§7 is a complete table-by-table classification** of every   table in the schema (~155 tables) into LOCAL / GIT / HYPERBEE /   SECURITY — built from how each table is *used*, not its name. - **Q-7 / Q-8 resolved** (decided-first gate): the four papercup   repos stay **separate** top-level harnesses; no monorepo, no   umbrella superproject. - The dogfood is **pulled forward** — single-engineer dogfooding   starts after Phase 3, not Phase 8. - Review fixes folded in: peer-mirror is **opt-in per-harness**   (not on-by-default); `completion_ref` verification is a   background poll, not on-read; phase items renumbered `P-NNN`;   Phase 0 spike has a named fallback; phases carry S/M/L sizing.  **Next action:** review-and-revise this draft; then split into per-phase execution plans. |
| Next | — |
| Live presence | None in final 10-minute window |

#### P-007 — `blocked` — normal

Entry 3 (existing repo): the submodule walker — read `.gitmodules`, classify via §2's four cases, recurse, register root + sub-harness nodes with path-qualified slugs, write `.harness/config.json`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI  (L) |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-008 — `blocked` — normal

Entry 1 (new local dir): new backend — create dir, `git init`, scaffold `.harness/config.json` + `.gitignore`, first commit, register.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI  (L) |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-009 — `blocked` — normal

Entry 2 (GitHub URL): new backend — `git clone` with GitHub-OAuth auth surfacing, then continue as Entry 3.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI  (L) |
| `blocked-by` | `P-007` |
| Unresolved blockers | `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-010 — `blocked` — normal

Entry 4 (harness link): parser + validator + clone + `.harness/shared.json` verification. (Swarm join is wired in Phase 6.)

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI  (L) |
| `blocked-by` | `P-006` |
| Unresolved blockers | `P-006` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-011 — `blocked` — normal

Verify: bring the papercup checkout in via Entry 3; the tree shows papercup + 9 `libs/*` sub-harness nodes, the other 8 `libs/*` dirs produce none.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 1 — Create-harness UI  (L) |
| `blocked-by` | `P-007` |
| Unresolved blockers | `P-007` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-014 — `blocked` — normal

Background verification job: poll `git ls-remote` for `pending_done` features, cache result + `done_at_remote_ts`; reads serve from cache; manual "check now".

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — completion_ref + trust scaffold  (M) |
| `blocked-by` | `P-013` |
| Unresolved blockers | `P-013` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-015 — `blocked` — normal

`pending_done` → `done` gate driven by the cached verification.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — completion_ref + trust scaffold  (M) |
| `blocked-by` | `P-014` |
| Unresolved blockers | `P-014` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-017 — `blocked` — normal

UI: feature-row verification badge (pending / verified / failed); Pending-review panel for untrusted-author rows.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 2 — completion_ref + trust scaffold  (M) |
| `blocked-by` | `P-015`, `P-016` |
| Unresolved blockers | `P-015`, `P-016` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-019 — `blocked` — normal

Attach to reactive tables (HYPERBEE/GIT projections + UI-facing LOCAL tables).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | `P-018` |
| Unresolved blockers | `P-018` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-020 — `blocked` — normal

`/api/sync/stream` SSE endpoint — per-workspace `LISTEN` on `reactive_*`, per-client subscription, SSEAdapter multiplex.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | `P-019` |
| Unresolved blockers | `P-019` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-022 — `blocked` — normal

Drop `@rocicorp/zero` dep + Zero WS adapter.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | `P-021` |
| Unresolved blockers | `P-021` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-023 — `blocked` — normal

Verify: two tabs on one harness; a write in one lands in the other in <1s.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | `P-021` |
| Unresolved blockers | `P-021` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-025 — `blocked` — normal

Bring papercup in via Entry 3; verify the harness tree.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | `P-011`, `P-024` |
| Unresolved blockers | `P-011`, `P-024` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-026 — `blocked` — normal

Seed a starter feature queue from current PLAN.md / agent-coordination plans.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | `P-025` |
| Unresolved blockers | `P-025` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-027 — `blocked` — normal

Run a first single-engineer exercise: file a feature, scoper → worker → validator, status flips `in_progress` → `pending_done` → `done` after the commit is pushed.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | `P-026`, `P-017`, `P-023` |
| Unresolved blockers | `P-026`, `P-017`, `P-023` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-029 — `blocked` — normal

`.harness/state/` file-per-row writer — GIT-bucket write verbs write the row file alongside the PG row.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-028` |
| Unresolved blockers | `P-028` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-030 — `blocked` — normal

Debounced auto-commit of `.harness/state/` (15s window, generated message).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-029` |
| Unresolved blockers | `P-029` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-031 — `blocked` — normal

Extend `harness-fs-watcher` to project `.harness/state/` files into PG on inbound `git fetch`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-029` |
| Unresolved blockers | `P-029` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-033 — `blocked` — normal

Private ↔ shared-private ↔ shared-public state machine in `.harness/config.json`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-032` |
| Unresolved blockers | `P-032` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-034 — `blocked` — normal

Verify: two checkouts of one harness; a decision written in one appears in the other after `git pull`.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | `P-031` |
| Unresolved blockers | `P-031` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-035 — `blocked` — normal

`harness-sync` subprocess — one Hyperswarm node per workspace.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-005` |
| Unresolved blockers | `P-005` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-036 — `blocked` — normal

Per-harness Hyperbee schema for the 5 HYPERBEE tables; Autobase multi-writer wrapper.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-035` |
| Unresolved blockers | `P-035` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-037 — `blocked` — normal

Hyperbee → PG projection + `pg_notify` emit.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-036` |
| Unresolved blockers | `P-036` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-038 — `blocked` — normal

HYPERBEE-bucket write path: write own Hyperbee, project to local PG, replicate over Hyperswarm.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-037` |
| Unresolved blockers | `P-037` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-039 — `blocked` — normal

Schema-version handling for HYPERBEE table-shape changes.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-037` |
| Unresolved blockers | `P-037` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-040 — `blocked` — normal

LWW clobber surfacing — "status changed by <peer>" toast (§6.4).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-038` |
| Unresolved blockers | `P-038` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-041 — `blocked` — normal

Wire Entry 4 (P-010) to join the swarm after clone.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-038` |
| Unresolved blockers | `P-038` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-042 — `blocked` — normal

Verify: two workspaces on the mesh; a status flip on one lands on the other in <1s.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L) |
| `blocked-by` | `P-041` |
| Unresolved blockers | `P-041` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-044 — `blocked` — normal

Post-commit hook install (symlinked) + branch pattern gate.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | `P-043` |
| Unresolved blockers | `P-043` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-045 — `blocked` — normal

Hyperdrive wrap of the bare mirror; replicate over the harness topic; publish drive key via Hyperbee.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | `P-044`, `P-036` |
| Unresolved blockers | `P-044`, `P-036` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-046 — `blocked` — normal

Peer auto-fetch on `completion_ref` change; GitHub fallback on >5s timeout.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | `P-045` |
| Unresolved blockers | `P-045` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-047 — `blocked` — normal

UI: "peer shipped F-NNN — view diff / check out / open in editor".

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | `P-046` |
| Unresolved blockers | `P-046` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-048 — `blocked` — normal

Verify: two mesh-connected engineers; one commits on a `feature/*` branch; the other reaches it via `git log` in <3s with neither pushing to GitHub.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | `P-046` |
| Unresolved blockers | `P-046` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-050 — `blocked` — normal

Operator publish flow on `shared-public` flip → POST metadata; delist on flip back.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — Cupboard  (M) |
| `blocked-by` | `P-049`, `P-033` |
| Unresolved blockers | `P-049`, `P-033` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-051 — `blocked` — normal

"Cupboard" navbar item + card-grid UI (reuse marketplace components).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — Cupboard  (M) |
| `blocked-by` | `P-049` |
| Unresolved blockers | `P-049` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-052 — `blocked` — normal

"Install" on a card → harness-link prefill → Entry 4.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — Cupboard  (M) |
| `blocked-by` | `P-051`, `P-010` |
| Unresolved blockers | `P-051`, `P-010` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-053 — `blocked` — normal

Verify: flip a harness public; it appears on the Cupboard; install on a second workspace.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 8 — Cupboard  (M) |
| `blocked-by` | `P-052` |
| Unresolved blockers | `P-052` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-055 — `blocked` — normal

"Open Discord channel" gesture → `discord://` URI with HTTPS fallback.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 9 — Discord  (S) |
| `blocked-by` | `P-054` |
| Unresolved blockers | `P-054` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-056 — `blocked` — normal

Outbound webhook poster (extend any existing notification surface) — PR opened / escalation / done-after-review.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 9 — Discord  (S) |
| `blocked-by` | `P-054` |
| Unresolved blockers | `P-054` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-057 — `blocked` — normal

Verify: configure a test channel; trigger each event class; observe in Discord.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 9 — Discord  (S) |
| `blocked-by` | `P-056` |
| Unresolved blockers | `P-056` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-058 — `blocked` — normal

Share the papercup harness (P-032); a second engineer joins via harness link + mesh enrollment + trust.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | `P-042`, `P-034` |
| Unresolved blockers | `P-042`, `P-034` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-065 — `blocked` — normal

Multi-engineer exercise: both engineers file + pick up features on the shared papercup queue; trust gate + `completion_ref` verification both exercised.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `blocked` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | `P-058` |
| Unresolved blockers | `P-058` |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-001 — `todo` — normal

Spike: a Hyperswarm node inside the operator's Node process; two workspace instances on the WireGuard mesh discover each other on a known topic in <2s.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-002 — `todo` — normal

Spike: write/read a Hyperbee; verify Autobase merges two writers into a consistent view.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-003 — `todo` — normal

Spike: replicate a small bare git repo via Hyperdrive between two workspaces; `git fetch file://<mirror>` resolves a peer's commit.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-004 — `todo` — normal

Confirm `@holepunchto/*` (hyperswarm, hyperbee, hyperdrive, autobase — native deps UDX + sodium-native) bundle cleanly into the operator Node build *and* the Tauri desktop bundle. This is the highest packaging risk.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-005 — `todo` — normal

Write the spike findings doc; if P-004 fails, invoke the fallback and rebaseline phases 6–7.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 0 — Foundations + spike  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-006 — `todo` — normal

New `app/admin/harnesses/new` wizard route + 4-card entry-point chooser; "Create Harness" affordance on the main harnesses list.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 1 — Create-harness UI  (L) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-012 — `todo` — normal

Migration: `completion_ref jsonb` on `harness_features_consolidated` (null default).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — completion_ref + trust scaffold  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-013 — `todo` — normal

Feature write verbs accept + validate a `completion_ref` payload.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — completion_ref + trust scaffold  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-016 — `todo` — normal

`trusted_authors` table (LOCAL) + `trust:list` / `trust:add` / `trust:remove` verbs; `SYNC_POLICY` entry.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 2 — completion_ref + trust scaffold  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-018 — `todo` — normal

`emit_change_notify()` PL/pgSQL trigger function + per-table attach helper.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-021 — `todo` — normal

Migrate plans-admin (`RevisionsPanel`, `AgentsPanel`, `RunDetailPanel`, `PlanDetail`) off `useAsyncJson`

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 3 — Reactivity producer side  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-024 — `todo` — normal

Create the `papercusp-workspace` workspace via the desktop client.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 4 — Dogfood papercup, single-engineer  (S) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-028 — `todo` — normal

The `SYNC_POLICY` registry (§6.5) + startup assertion that every table has exactly one policy.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-032 — `todo` — normal

Share-this-harness wizard (§5) — topic key + Ed25519 keypair + seed `.harness/state/` + `.harness/shared.json`

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 5 — git-as-sync (the GIT bucket)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-043 — `todo` — normal

Per-shared-harness bare-mirror init; opt-in `peerMirror.enabled` in `.harness/config.json` (default off).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 7 — Hyperdrive peer-mirror (Path B)  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-049 — `todo` — normal

`papercusp-cupboard` registry — repo + systemd unit + publish/index endpoints (model on `papercusp-registry`).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 8 — Cupboard  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-054 — `todo` — normal

`discord` field in `.harness/config.json` + per-harness Discord settings panel.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 9 — Discord  (S) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-059 — `todo` — normal

Onboarding doc for joining engineers.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-060 — `todo` — normal

Unit coverage for the §2 classifier (4 cases + cycle detection).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-061 — `todo` — normal

Integration coverage: GIT-as-sync round-trip and Hyperbee → PG projection round-trip.

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-062 — `todo` — normal

Integration coverage: Hyperdrive peer-mirror (commit on one peer, `git log` on another).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-063 — `todo` — normal

Playwright e2e for the create-harness wizard (all four entry points in temp dirs).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

#### P-064 — `todo` — normal

Performance: local-write → peer-PG latency (<1s target) and peer-mirror fetch (<3s on mesh).

| Attribute | Detail |
|---|---|
| Stored → effective | `todo` → `todo` |
| Phase | Phase 10 — Multi-engineer dogfood + verification  (M) |
| `blocked-by` | — |
| Unresolved blockers | — |
| Open issue blockers | — |
| Decisions | — |
| Linked work-items | None |

</details>

## Audit notes

- Terminal-plan residue is consistency/cleanup debt, not ordinary backlog.
- A stored `wip` without live linked work is not proof of active execution; it is highlighted for reconciliation.
- Live presence is point-in-time and may change after generation.
- Sources: `harness_plans.items`, `work_items`, `coord_links` + open `engineer_issues`, and `coord_presence`.