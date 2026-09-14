# Backend reliability follow-through: diagnostic ledger

Plan: `backend-audit-diagnosis-before-repair-2026-09-13`.
Driver: `WI-10001261`, session `su-6eeda0f9-9087-43b2-b27d-e3856a7cf256`.
Updated: September 14, 2026, approximately 04:49 UTC (September 14 EDT).

This is an execution ledger, not a second completed audit or a repair certificate.
The original report and measurement window remain in
`docs/audits/backend-reliability-2026-09-13.md` and its evidence JSON.
No product repair by this driver is certified here.

## Authority, scope and completion rules

- The owner authorized this session to implement the broader recommendations in
  AUTO through shipped status in
  `session_turn:codex:01a09d53-bfbf-71d0-b849-79f63df8c570:27`.
- The original instruction to complete all diagnosis before implementation remains
  in force:
  `session_turn:codex:01a09cf7-0097-72b3-9640-33de048ca7a6:14`.
- The owner assigned `managed-carry-lifecycle-enforcement-2026-09-13` to another
  agent. Its current driver is `su-c77f160e-1bd4-4436-9090-bb0360873809`;
  `WI-10001256` was released with evidence. This driver must adopt overlapping
  carry evidence, not duplicate that implementation.
- Other existing work is prior art or a dependency, not automatically permission
  to take over an active claim. Inspect current ownership before touching it.
- A draft plan, an accepted request, a live process, a passing local test and a
  repaired affected runtime are different states.
- A diagnosis may close only as reproduced cause, demonstrated intentional
  behavior, verified already-fixed behavior, or a refuted premise with its
  falsifier. Unknown history is not a completed diagnosis by relabeling.

## Complete finding population and next discriminating work

Every F01–F18 identifier occurs exactly once below. “Open” means the diagnostic
obligation is still open; it does not assert that the original symptom is still
present in every running build.

| Finding | Current evidence / status | Plan coverage and ownership | Next discriminating evidence |
| --- | --- | --- | --- |
| F01 session-history SQL | Cause reproduced by the maintained private-PG regression, which passed 7/7 with zero skips. Its source covers the uncast control, cast repair, predecessor/successor, named scope, search-to-readMore and exact continuation windows. Default-endpoint reads still failed after this carry; staging self-read succeeded. A demonstrated main-selection gap is recorded below. | P-002 / P-014; gate repair P-013/P-023. Recurrence `EI-23195479465396624`; new gate gap `EI-23210600888560844`. | Complete actual producer/transport and affected-runtime coverage; adopt the saved SQL proof rather than rerunning only to reconstruct it. Main selection must be repaired after the all-diagnosis barrier. |
| F02 busy-boundary deferral | Open. Own host recorded only 144 ms maximum quiet against 1,500 ms, despite native task completion. Deferral counts are not lost-message counts. | P-003 / P-016. Carry-specific boundary repair belongs to the separate carry plan; general wake residue stays here. | Adopt exact carry fixture and native-boundary evidence; test idle repaint versus active reasoning and unsent human input without driving an attended terminal. |
| F03 folded wake completion | Open. Original actual-factory counterexample leaves folded B completed after parent A defers; current source inspected still marked folded IDs completed at admission. | P-003 / P-015. General delivery/coalescing scope here; coordinate any shared PTY file. | Reproduce through the maintained isolated host/executor fixture, including defer, retry, cancellation and exactly one eventual native turn. |
| F04 missing carry prompt | Open. Original host repeatedly lacked `session-22472/AGENTS.md`; initiating removal was not established. | P-004 / P-016. Adopt carry-plan prerequisite diagnosis and repair evidence. | Trace launch/archive/cleanup ownership and reproduce a missing prerequisite in a disposable fixture; establish safe recovery or explicit blocking while preserving predecessor. |
| F05 reconnect macro | Open. Original episode repeatedly failed at dialog-open or connected-marker checks; exact UI/config/transport cause unresolved. | P-004 / P-016. Reconnect residue belongs here unless explicitly covered by the carry plan. | Inspect retained effective configuration, version and dialog evidence; distinguish missing entry, UI mismatch and transport/auth failure in isolated fixtures. |
| F06 host version lifecycle | Open. A child-only restart does not reload a long-lived parent host. A different host hash alone does not prove a missing fix. | P-004 / P-017. Carry-plan adoption evidence is an external dependency. | Match required behavior to the actual loaded host generation; verify safe attended/headless upgrade and failed-upgrade behavior without blanket restart. |
| F07 corpus deadlines | Open. Original corpus timeouts; an independently authored deadline-chain audit identifies enclosing waits, uncancelled losing work and lack of incremental safe results. | P-005 / P-018. Existing `retrieval-soft-budget-hard-deadline-2026-09-13` and `WI-10001232` must be checked for ownership and reusable evidence. | Separate queue/acquisition/inference/search/rerank latency; distinguish enclosing deadline loss from unavailable data; validate known answers under one scoped deadline. |
| F08 misleading embedder availability | Open. Original timeout construction labeled an unobserved embedder unavailable. | P-005 / P-018; overlap with existing retrieval plan must be resolved before implementation. | Independently delay embedding, SQL and reranking; require unknown for unobserved stages and unavailable only with stage-specific evidence. |
| F09 retrieval completeness and use | Open. Retrieved, admitted, delivered and used are distinct. Existing retrieval audit reports indexing falling behind in its bounded window and a delivered historical pointer not followed by an agent. | P-005 / P-010 / P-018. Reuse retrieval-plan fixtures and preserve consumer scope. | Known-answer predecessor/ID reads, indexing freshness denominator, epoch reset, exclusions and actual delivery/utilization; no inference from low scores alone. |
| F10 scheduler/control starvation | Open, concrete mechanism established below. Due loop is present but critical-pressure policy overrides offered admission to zero. Other delayed routine classes remain to be classified. | P-006 / P-019; this driver's scheduler lane. | Repeated epoch/cohort evidence, correct pressure attribution, sustained-pressure fairness negative control and bounded recovery progress. |
| F11 standing schedule materialization | Open. Original validator named missing standing-action schedules; not every declaration necessarily belongs active in this workspace. | P-006 / P-019. | Enumerate the exact original named set; reconcile declaration, boot/seed, intended scope and active/disabled/on-demand/retired disposition. |
| F12 cancellation/SQL fragments | Open for real-PG and runtime verification. Existing wrapper unit suite passed 11/11, including no eager tagged/unsafe fragment execution and active-query cancellation. These are mock-client tests, not a real-PG regression or proof that historical runtime errors remain current. | P-002 / P-014. | Execute nested fragments and abort-before/during-query through the real isolated wrapper; establish relevant build vintage rather than reopening historical errors alone. |
| F13 hook/receiver skew | Open. Original release rejected the current hook's `role` field; staging accepts it. Existing activity lifecycle unit suite passed 15/15, but directly calls the handler, so it does not establish actual producer-to-projected-receiver compatibility. | P-002 / P-014. | Actual old/new producer-to-projected-receiver matrix with recorded fixtures; establish downstream liveness impact without injecting production hooks. Preserve the isolated-test caveats below. |
| F14 incident identity | Open. Original unique-index failures and repeated title-family filings; related fixes `WI-10001183`, `EI-22536211469362868`, `EI-23198068959671510` are terminal and require verification. | P-007 / P-020. | Real-PG concurrent same/different identity submissions, claimed-content preservation, current runtime replay and stable observation attachment. |
| F15 communication receipts | Open. Transport acceptance, inbox preservation, native start and requested action completion differ. A peer inbox wake started a turn here while the recurring loop still recorded no fire. | P-003 / P-007 / P-015 / P-020. Adopt carry receipt contract without treating it as all communications coverage. | Commit/abort/ACK-loss and retry lifecycle; exact intended native turn count; inbox fallback remains degraded pickup, not completion. |
| F16 governor and loop visibility | Open. Original queue combined waiting and running. Current loop status failed to indicate a never-fired overdue loop; recovery later moved its due time without producing a fire. | P-006 / P-010 / P-021. | Trace writer units and unknowns; classify valid versus stale demand; test zero-fire deadline detection independently of manual agent activity. |
| F17 assurance evidence | Open. Sparse attached evidence does not establish absent tests. Existing `WI-2143001` concerns coverage attribution and must be checked before duplicate work. | P-008 / P-010 / P-021. | Known positive/negative test evidence must update the right surface; enumerate unsupported/waived cases and verify actual gate selection. |
| F18 backups and restore | Open. Original application ledger was old; independent backup mechanisms were not disproven. Related `WI-2145397`, `WI-2146225`, `WI-40561` concern relocated writer/probe/destination and are terminal. | P-009 / P-022. | Inspect current `/mnt/backup/db-dumps`, not abandoned `/mnt/data/Backup`; validate actual artifacts and run an existing isolated restore drill without overwriting production. |

## Loop failure: exact recorded scheduler mechanism

Subject:
`rt_papercusp_loop_su_6eeda0f9_9087_43b2_b27d_e3856a7cf256`,
workspace `papercusp-workspace`, install `papercusp`, tier `durable`.

The arm writer persisted an active 60-second loop at
`2026-09-14T01:24:34.863Z`, initially due at `01:25:34.863Z`.
At approximately `02:05Z`, the reader returned no last fire and zero fire count,
while the target socket was reachable. This establishes successful persistence,
not successful scheduling.

At `03:31:08.083Z` the recovery sweep updated its due time and recorded
`loop_rearmed_reason` as fire-starved. It still did not record a fire.
Moving the due timestamp is not evidence that the blocking policy changed.

The durable DBOS workflow
`sched-.routinesTick-2026-09-14T03:37:30.000Z`, executor `bg-host-3270`,
contains both:

1. `list-due-routines`: its recorded output includes the exact subject loop.
2. `routine-dispatch-feedback-epoch`: pressure `critical`, probe `2699` ms,
   generation `133`; queue `routines-loop` has `inFlight=0`,
   `controllerAvailableStarts=1`, but `availableStarts=0`.

Source correspondence:

- `packages/operator-core/lib/dbos/routines-workflow.ts`,
  `evaluateRoutineDispatchEpoch`, overrides critical-pressure starts to zero for
  every queue except `ROUTINES_CRITICAL_QUEUE`.
- The same file's `routinesTickImpl` separately skips targets excluded by
  `shouldFireUnderPoolShed` before claim.
- `libs/papercusp/libs/db/src/routines-runtime.ts`,
  `listDueCronRoutines`, includes active durable cron rows when due.
- `packages/operator-core/lib/harness/routines/loop.ts`,
  `computeTurnsStalled`, exits early below a minimum fire count; it cannot alone
  diagnose a loop that has never fired.

These observations distinguish pre-claim withholding from a missing loop row,
a loop absent from the due list, a full loop queue, and a lost post-submit ACK.
They do **not** yet prove why the database probe was slow or explain every
other agent's failure.

### Repeated evidence, not one transient sample

A read around `03:54Z` grouped retained `routine-dispatch-feedback-epoch`
records in the preceding hour that contained `routines-loop`:

| Pressure | Epochs | Probe range, ms | Empty queue but zero starts | Controller offered starts but override closed |
| --- | ---: | ---: | ---: | ---: |
| critical | 41 | 2082–4003 | 35 | 35 |
| elevated | 14 | 318–1942 | 0 | 0 |
| ok | 4 | 1–101 | 0 | 0 |

This is the specified retained epoch population, not all ticks or a loss rate.
The noncritical samples are positive controls against a permanently full queue.
Some ticks recorded no steps, so “tick SUCCESS” also needs its executed-step
context before interpretation.

The pressure probe itself still needs attribution:
`packages/operator-core/lib/dbos/pool-pressure.ts` measures `Date.now()` elapsed
over a lazy module import and `SELECT 1`, bounded by a `Promise.race`.
Elapsed time can include module loading and event-loop scheduling as well as
connection acquisition/query work. It must not be labeled exclusively database
pool wait without a distinguishing observation.

### Required durable repair properties

The eventual repair must give eligible, reachable loop/control work bounded
progress under sustained pressure while keeping ordinary work backpressured.
It must preserve database safety, fairness, cancellation and exactly-once
execution. Simply increasing concurrency, raising timeouts, rearming the row,
or returning “healthy” is not a fix.

Required negative controls include:

- A fresh active loop that has never fired cannot stay falsely healthy past its
  first-fire objective.
- Critical-pressure epochs cannot indefinitely exclude eligible recovery work
  solely because it belongs to the loop queue.
- A busy native turn or staged human input remains protected.
- Repeated scheduler ticks or recovery attempts cannot duplicate a native turn.
- A request ACK, successful spawn or stored inbox item cannot certify native
  turn completion.

## Existing retrieval work: adopt carefully

`docs/evidence/retrieval-deadline-audit-2026-09-13.md` records a separate owner
approval for a 1,200 ms performance target and one 10,000 ms hard deadline.
It distinguishes tolerating slow success from diagnosing the cause of latency.
This is scoped authority for that effort, not permission to widen unrelated
timeouts here.

The document identifies client-port enclosing deadlines, corpus races that
discard completed results, unforwarded cancellation, second-stage widening,
scope filtering and shared-consumer ownership obligations. Its measurements
are pre-implementation evidence. The plan reader still returned `draft` at
this inspection; neither its prose nor a terminal preparation item proves
product implementation or shipment.

## Activation and next work

### Superseded first grading attempt

Plan revision 9 / D-005 records that independent card
`EI-23207802912043197` **failed** the earlier spec-quality card
`EI-23207223300694459`. The earlier evaluator's pass was not accepted:
its acceptance-provenance statement incorrectly included 42 unaccepted drafts,
and some active clauses bundled independently testable outcomes. The review
work-item `WI-10001295` is terminal; that does not mean the plan passed.
The prior paragraph describing that review as merely pending is superseded.

The source-conversation activation audit was refreshed at sequence 2 for plan
revision 9. No product implementation is certified by that audit.

### Corrected contract set

On September 14, the active clauses for session windows versus SQL-fragment
execution, native-turn safety versus human-input safety, and completed retrieval
results versus truthful unknown stage status were split into separate outcomes.

The 42 seeded AUTO-BAR clauses were then deliberately revised from draft to
active using current revision CAS through the staging tool endpoint. Each now
has one observable contract, a concrete falsifier and a rerunnable inspection
procedure. **The complete original BAR text is preserved verbatim in required
evidence; the shorter behavior does not replace or weaken it.** The source BAR
hash, bar-set hash, rubric revision, evidence plane and acceptance reference
were preserved. Readback verified all 42 revisions, their acceptance actor and
their retained pins; no seeded draft remains.

The resulting set has 70 clauses: 55 active and 15 explicit non-behavioral
exemptions. These are contract states, not completed findings or passing tests.
The staging evaluator returned pass with no structural blockers for exact hash
`4ee4155a9b178e0d7b8a280556ef0286c78aacc131f0ae92c60af66b539dcc3b`.
New terminal spec-quality card `EI-23210288564537863` has **independent
grading-integrity review pending**. Its exact subject is
`spec-set:plan-class-bugfix:4ee4155a9b178e0d7b8a280556ef0286c78aacc131f0ae92c60af66b539dcc3b:806b7bd34648328c`.
The automatic router selected an already-ended session. Its consult
`conv-mu0r5bj8-0000-754c5ae7ed0a4645bf4fa354bc5a6029` expired at
`2026-09-14T04:37:59.048849Z`, with no responder and no posts. A direct wake to
that recipient was refused; nothing was delivered. This corrects any
interpretation of the reservation as a progressing audit. The defect is
registered as `EI-23210715718620697`.

**Temporary mitigation:** review work `WI-10001306` was assigned to the previous
independent reviewer, `su-c77f160e-1bd4-4436-9090-bb0360873809`, whose current
presence was parked rather than ended. A shortened action request was
successfully delivered at `04:46:11Z`, after an oversized request was refused.
Its wake was queued, with `pickupConfirmed:false`; neither actual pickup nor
an independent verdict has yet been verified. Repairing the router's dead
candidate/cascade path remains separate work. Do not reuse the failed card,
self-audit the new one, or activate before the independent pass.

Continue read-only diagnostic preparation while review is pending. After
activation, complete the per-finding diagnostic records and the all-diagnosis
review before repairs, then maintained behavioral regressions and actual
promotion selection, rollout and independent acceptance. This initial
inventory is not all diagnosis complete.

## Retained verification and runtime observations

- Maintained test:
  `packages/operator-core/lib/agent-tools/sessions/read.integration.test.ts`.
  Saved run `task0mu0pzmkop8yvzh1raw`, bash handle `eec645d8-549`, log
  `.papercusp/scratch/bash-eec645d8-549.log`: 7/7 passed, zero skips, one
  requested/executed file. The earlier checkpoint records tested HEAD
  `03d0fc4691` and no uncommitted changes to the tested file before/after.
  Adopt this proof rather than rerunning only to reconstruct it.
- Post-carry default `sessions:read {session:"self",tail:5}` again failed with
  `invalid escape string`; that occurrence coalesced onto
  `EI-23195479465396624`.
- Explicit `ptool --url=http://127.0.0.1:3170 --transport=http` successfully
  read the current self-session. The staging scorecard emitter identifies
  loaded build `e0070449ea9fbb10f00d6d9d812bf31ed0dcc3b8`, started
  `2026-09-14T04:10:37.000Z`. These observations establish a usable staging
  tool path, not release deployment or background-host readiness.
- The carry's last successful operation and flight record identify the
  pre-boundary compaction request and its activity report. There is no new
  product edit in that recorded blind window.

### Main-promotion selection: demonstrated gap, not missing test

The documented read-only selector was executed with exactly these changed paths:

```text
packages/operator-core/lib/agent-tools/sessions/read.ts
packages/operator-core/lib/agent-tools/sessions/read.integration.test.ts
```

`node scripts/affected-tests.mjs --changed-paths <the two paths> --print-affected`
exited zero and selected the operator-core unit lanes and applicable lints,
but no integration task. The same probe with `--integration` is a positive
control: it selected operator-core `test:integration`. Both outputs were
untruncated; their complete task lists are retained in
`.papercusp/scratch/bash-26df0ab1-19a.log` and
`.papercusp/scratch/bash-2ffd8f4d-28d.log`.

The writer explains the difference: `scripts/affected-tests.mjs` adds the broad
integration task only when `runIntegration` is true. The root `test:affected`
command does not pass that flag. Operator-core's ordinary configurations use
the unit layer, whose shared config in `libs/test-config/src/vitest-config.ts`
excludes integration-test suffixes. A positional test filter cannot reverse
that exclusion.

`EI-23210600888560844` records the scoped repair under P-013/P-023: reuse the
existing focused invariant-guard integration venue, with selection tests for
relevant source/test/fixture/config/submodule triggers and fail-closed
execution. Do not turn on the entire integration sweep as a shortcut. No
current release verdict was read, rerun or changed by these source-selector
probes.

### Existing cancellation and activity tests

Run `0mu0rhce31kypv2ktsh` / bash `3222fd44-60e`, retained log
`.papercusp/scratch/bash-3222fd44-60e.log`, completed with exit zero through
the maintained `npm run test:file` router:

- `packages/operator-core/lib/pg-bounded-txn.test.ts`: 11 passed.
- `packages/operator-core/lib/agent-tools/activity/report-lifecycle.test.ts`:
  15 passed.
- Router: two requested, two executed, 26 passed, zero skips. Tested HEAD
  `a6bf58a90c0673a21800e66dccfe50ffd588c7f7`; the two test files were clean.
  Before/after hashes for both tests and both production source files were
  identical.

These tests do not complete F12/F13 diagnosis. The wrapper test uses a fake
thenable client; the activity test bypasses projected schema dispatch and
mocks the persistence/lifecycle seams. The output also reports unit-PG guards
rejecting carry/reset marker reads, followed by the handler's fallback path.
No real database connection was permitted by those guards. That warning
cannot be represented as successful testing of the true carry-marker path,
nor does it establish a production outage.
