# Grading gate test reuse yield
URL: /internal/docs/agent-insights/gate-test-reuse-yield-grading

Shared procedure for the four reuse-yield acceptance criteria: exact runnable checks, fixed replay populations, qualified live evidence, same-process capture and generated-schema reduction with mode-catalog non-regression.

This is the main procedure for grading `acceptance-gate-test-reuse-yield-2026-10-01`. It uses the existing plan acceptance workflow and exact-file test router. The rubric's individual METHODs remain the per-criterion replication drills. This procedure supplies their shared population, provenance and outcome checks; it does not change a BAR.

The current canonical rubric and its generated requirements govern. The approved reconciliation in Decisions D-013, D-014, D-016 and D-018 supersedes the early outside-process capture and strict mode-catalog reduction interpretations. Always resolve the current revision and criteriaHash before using this guide; if a guide example disagrees with that contract, reconcile the existing guide before grading rather than enforcing an obsolete example.

## Bind the subject before measuring

Read the current full rubric with `rubrics:get` and the source plan with `plans:get`. Record rubric revision, criteriaHash, barSetHash, plan revision/contentHash, the current R-1 through R-4 text, and Decisions D-003, D-005, D-010, D-011, D-013, D-014, D-015, D-016 and every later canonical amendment decision affecting these BARs. Retrieve one Decision at a time if the plan read defers bodies. Never grade a clipped body as complete.

Pin the implementation and test blobs, committed candidate SHA, runner configuration and run context. Use exact persisted test-run IDs and their provenance; a dirty-tree row, an unscoped run, or a completed test with an unobserved imported source is a partial check, not clean committed acceptance proof. Match the requested files to the executed files and record skips/errors. No rows is UNKNOWN, not zero failures.

For each replay pin the entire eligible proof population, every input pair, selector version, proof-age reference time, drift set and per-lane counters before measuring. Keep the raw references addressable from the grading. Use the same inputs for the before/after sides.

## Verify the runnable checks

Use one exact-file `testing:run` call per owning runner group, with the held work-item attribution and evidence mapping when binding a proof:

* R-1: `packages/operator-core/lib/release/test-pass-reuse-report.test.ts`.
* R-2: `packages/operator-core/lib/__tests__/test-pass-reuse.test.ts`, `packages/operator-core/lib/__tests__/schema-symbol-drift.test.ts` and `packages/operator-core/lib/release/test-pass-reuse-report.test.ts`.
* R-3: `packages/operator-core/lib/__tests__/pure-lane-proof-capture.test.ts`, `apps/operator/lib/release/green-checkpoint-pure-proof-capture.test.ts` and `apps/operator/lib/release/green-checkpoint.test.ts`.
* R-4: `packages/operator-core/lib/__tests__/schema-symbol-drift.test.ts`.

Require exact file matching, completed verdicts, and no skipped tests or errored runner groups. A partial multi-route result cannot certify its missing file. Recover existing rows with `testing:runs` using the exact runGroup; `testing:run-status` may report unknown\_run when a complete terminal manifest is absent even though some per-file PASS rows exist. Rerun the missing file rather than reconstructing a whole matrix. Retain the process/session handle until exit. The native CLI fallback uses the maintained `npm run test:file -- <path>` runner with `PAPERCUSP_TEST_RUN_HARNESS=papercusp`; it is a runnable check until clean source-bound evidence is separately qualified.

These tests exercise counter integrity, selector soundness, schema narrowing and capture sequencing. They do not measure full replay yield, a live soundness window, capture yield or a subsequent full run.

## Measure the four outcomes

### R-1: per-phase reuse yield

Retain the original fixed baseline pair (proofs at `29bf7350`, candidate `599dbeeb`) for phases A/B/C and record each side's per-lane reused count. D-003 contains Avi's explicit choice of an additional Phase-A pair with nested Vitest/config/script differences and no dependency change. Pin that second pair before measuring and report both pairs. Require a strict Phase-A reuse increase on the additional eligible D-003 pair; retain Phase A's original-pair result as an observation without an increase requirement. Require a strict increase on the original pair for each of B and C. The additional pair's complete diff must cover the nested Vitest/config/script/test-config scope without package-lock.json or non-script package.json changes. Do not discard the original observations, substitute a cohort or choose a pair after seeing the results.

Resolve each phase's referenced replay and its next full run's exact TEST\_PASS\_REUSE lines. Record full run ID, judged SHA, runtime identity and timestamps. Missing populations, pairs or log lines rate UNKNOWN. A measured failure to satisfy the governing increase condition rates FAIL.

### R-2: dependency invalidation and live soundness

Enumerate every narrowing in P-001 through P-005 and P-007. Map each to a test counterexample for executed-module or main-process-runner input drift and qualify the bound test evidence.

Separately pin the exact P-008 measurement-window boundaries and enumerate the complete reuse-audit invocation population: run IDs, timestamps, audited files and TEST\_PASS\_REUSE\_ALARM outcomes. Preserve the configured 5% sampling probability; a finite cohort need not realize exactly 5% audited files. Zero real misses requires a nonempty observed qualified window. Empty, partial or substituted populations, unknown named results or sampling-policy drift rate UNKNOWN; any real miss rates FAIL. The existing report suite exercises evaluateTestPassReuseAuditWindow and its invalid-window counterexamples. Its unit PASS does not establish that a live window occurred and cannot settle this outcome alone.

### R-3: pure-lane capture and subsequent reuse

Resolve the named producer `scripts/lib/pure-lane-proof-capture.mjs/runPureLaneProofCapture` and wrapper `apps/operator/lib/release/green-checkpoint.ts/runPostVerdictPureProofCapture`. Record the exact process identity, runGroup, judged SHA, final recursive runGreenCheckpoint resolution, verdict and promotion-decision timestamps, capture start/end, source=local per-file proof rows and the first subsequent full run's lane-pure reuse line. Require exactly-once capture in the same green-checkpoint process after the final recursive call resolves and after the verdict and promotion decision are recorded, on a clean tree at the exact judged SHA. Require named per-file local proofs and nonzero lane-pure reuse on the first subsequent full run.

D-011's final-recursion boundary and the approved same-process post-verdict capture contract are cumulative requirements. Moved HEAD, a dirty/unjudged tree or no suite rows yields an explicit skip and no proof; skipped or missing capture cannot satisfy this outcome. The three bound suites provide producer, wrapper and real-recursion construction checks. Actual process ordering, clean judged-SHA capture and subsequent reuse still require their separately qualified runtime records. Missing records rate UNKNOWN; measured violations rate FAIL.

Superseded history: an earlier guide interpreted capture as outside the gate run and preserved an apparent conflict with D-005. D-013, D-014 and the approved D-018 requirement now make the same-process post-verdict sequence explicit. Preserve older receipts as history; do not grade against that obsolete interpretation.

### R-4: generated-schema reduction and mode-catalog non-regression

Read the P-007 rationale and replay the original fixed pair with the complete cohort. Independently count proofs invalidated by the generated schema and by the mode catalog. The current BAR requires generated-schema invalidations strictly below `1300` and mode-catalog invalidations no greater than `990` on that original complete cohort. Report both measurements and the rationale. Missing populations rate UNKNOWN; a measured generated-schema count at or above `1300` or a mode-catalog count above `990` rates FAIL.

D-010 expressly leaves the mode catalog unchanged; D-015, D-016 and D-017 make its obligation non-regression rather than a strict reduction. Another cohort's percentage or a green schema unit test cannot establish either exact historical comparison.

Superseded history: the earlier strict-below-`990` mode-catalog instruction predates that approved reconciliation. Retain it only in historical review records, not as a current grading threshold.

## Use recorded runtime evidence and independent review

This repair lane does not start, rerun, monitor or deploy the current green-checkpoint. Use already-recorded run evidence; request needed evidence once from its registered owner. A live-plane criterion still needs an identified runtime and a qualified loaded build. Do not default to a port or promote unit evidence to live evidence.

After a criteriaHash change or a material method correction, request a current independent contract critique through `consult:get_feedback { policy:'rubric-vetting' }`, naming the exact rubric ID and current criteriaHash and asking the critic to read this complete guide. Use the existing review thread for a same-subject follow-up; a changed hash requires a critique whose opening request names that new identity. The canonical direct-critique path needs no legacy meta-scorecard or grading-integrity audit. An amendment approval authorizes its exact patch and supplies no outcome grading; an unanswered or expired consult supplies no independent critique. Resolve substantive method objections before accepting clauses or binding proof, then use the existing independent grading and rubric-author verdict workflow in [the plan completion runbook](/internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook) and [current vetting guidance](/internal/docs/agent-insights/acceptance-rubric-vetting).

REPLICATION DRILL: a second reader resolves the same pinned rubric, Decisions, source/test blobs, proof cohort, replay pairs and run-window references; repeats the exact-file checks and each outcome measurement; and can reproduce the per-criterion rating without an inferred zero, a substituted cohort, or a weakened falsifier.
