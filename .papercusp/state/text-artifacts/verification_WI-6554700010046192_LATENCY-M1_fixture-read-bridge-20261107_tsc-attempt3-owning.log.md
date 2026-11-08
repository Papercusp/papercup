---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/fixture-read-bridge-20261107/tsc-attempt3-owning.log"
updated_at: 1794095643172
_body: "content"
---

COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 683110, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: node scripts/lint-tsc.mjs --files=packages/operator-core/lib/external-bench/private-fixture-reads.ts,packages/operator-core/lib/external-bench/private-fixture-reads.test.ts,packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts,packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts,packages/operator-core/lib/capability-envelope/session-confinement.ts,packages/operator-core/lib/capability-envelope/session-confinement-store.ts,packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts,packages/operator-core/lib/external-bench/current-su.ts,packages/operator-core/lib/external-bench/current-su.test.ts,packages/operator-core/lib/external-bench/reproducibility/schema.ts,packages/operator-core/lib/agent-tools/index.ts --all-errors --no-cross-leg (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
LINT_TSC_RUN_STAMP label=operator-core at=2026-11-07T23:49:09.627Z head=14ee0e3754 scope=files files=11
  checked files : packages/operator-core/lib/external-bench/private-fixture-reads.ts
                 packages/operator-core/lib/external-bench/private-fixture-reads.test.ts
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts
                 packages/operator-core/lib/capability-envelope/session-confinement.ts
                 packages/operator-core/lib/capability-envelope/session-confinement-store.ts
                 packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts
                 packages/operator-core/lib/external-bench/current-su.ts
                 packages/operator-core/lib/external-bench/current-su.test.ts
                 packages/operator-core/lib/external-bench/reproducibility/schema.ts
                 packages/operator-core/lib/agent-tools/index.ts
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=compiler-initialize elapsedMs=44 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=compiler-initialized elapsedMs=44 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=snapshot-release elapsedMs=44 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=snapshot-update elapsedMs=46 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=snapshot-rpc-completed elapsedMs=11463 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=snapshot-updated elapsedMs=12137 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=project-roots-refresh elapsedMs=12138 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=project-roots-refreshed elapsedMs=12245 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=refreshed elapsedMs=12245 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=program-files elapsedMs=12245 resultOrigin=pending
TSC_SERVICE state=accepted requestId=6c34bf84-881f-476b-962b-dc2b41f8ae29 serverPhase=scope elapsedMs=12285 resultOrigin=pending
⚠ TSC_SERVICE declined (scope-too-wide: at least 1501 files (limit 1500); a full compile is cheaper) — running the full operator-core compile instead. state=scope-too-wide resultOrigin=full-compile-required
[pc-heavy] checkpoint reserve discovery incomplete (status=124); retaining conservative reserve
[pc-heavy] release gate is JUDGING (phase=unknown) — heavy slots clamped to 4 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 691418, waiting up to 30s
[pc-heavy] still queued (16s elapsed, pid 691418, slots=1)
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=5 admittedCgroupMiB=22140 admissionId=pc-heavy-691418-1794095404730182576 retryHandle=psi-recovery:pc-heavy-691418-1794095404730182576 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-691418-1794095404730182576 retryHandle=psi-recovery:pc-heavy-691418-1794095404730182576 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TSC operator-core: 255 type errors across 149 file(s) (baseline total 224) [--files]
✓ The current --mine dirty set is tsc-clean. 0 baseline-regressed file(s) are outside that set:
   (Not gated under --mine. The shared git-status set can include other sessions' dirty edits;
    use --files= for explicit attribution.)
    A bare npm run of this gate will still catch these for whoever owns them.
   ⚠ 75 NEW file(s) (absent from the baseline) also have type errors, none of them in the set you named:
   packages/operator-core/lib/agent-tools/work_items/create.test.ts: 0 → 3  (+3)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/agent-tools/tools/invoke.ts: 0 → 14  (+14)  ← UNCHANGED 7919min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/bash_output.ts: 0 → 10  (+10)  ← UNCHANGED 3094min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/git_sync/run.ts: 0 → 7  (+7)  ← UNCHANGED 397min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/cupboard/installed-tool-funding.test.ts: 0 → 7  (+7)  ← UNCHANGED 40357min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/__tests__/fs-mutex.test.ts: 0 → 6  (+6)  ← UNCHANGED 2391min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts: 0 → 5  (+5)  ← UNCHANGED 2592min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts: 0 → 4  (+4)  ← UNCHANGED 8391min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts: 0 → 4  (+4)  ← UNCHANGED 1940min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/service-memory-attribution.integration.test.ts: 0 → 4  (+4)  ← UNCHANGED 6802min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts: 0 → 3  (+3)  ← UNCHANGED 7595min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts: 0 → 3  (+3)  ← UNCHANGED 7132min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/start-guard.test.ts: 0 → 3  (+3)  ← UNCHANGED 1061min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/degradation/rail-migration-cases.ts: 0 → 3  (+3)  ← UNCHANGED 2933min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/license-gate.test.ts: 0 → 3  (+3)  ← UNCHANGED 7810min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.test.ts: 0 → 3  (+3)  ← UNCHANGED 356min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 1579min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-status.ts: 0 → 2  (+2)  ← UNCHANGED 2466min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/work_items/get-shape.ts: 0 → 2  (+2)  ← UNCHANGED 47min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/blind-review-source-image.ts: 0 → 2  (+2)  ← UNCHANGED 14867min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/capability-envelope/identity-tool-surface.ts: 0 → 2  (+2)  ← UNCHANGED 7278min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-brief.test.ts: 0 → 2  (+2)  ← UNCHANGED 25min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 7084min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 3144min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/gate-candidate-failures.test.ts: 0 → 2  (+2)  ← UNCHANGED 8105min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/grading-integrity.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 885min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/improvements/observation-types.test.ts: 0 → 2  (+2)  ← UNCHANGED 335min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/memory/context-injection-reliability.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 38min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/result-door.test.ts: 0 → 2  (+2)  ← UNCHANGED 2466min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/turn-end-tracking-io.test.ts: 0 → 2  (+2)  ← UNCHANGED 7914min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/test/omp-managed-native-lifecycle.ts: 0 → 2  (+2)  ← UNCHANGED 1061min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/test/private-http-workspace-preflight.ts: 0 → 2  (+2)  ← UNCHANGED 155min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/__tests__/test-file-router.test.ts: 0 → 1  (+1)  ← UNCHANGED 91min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/acceptance-bar-contract-snapshot.ts: 0 → 1  (+1)  ← UNCHANGED 3202min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-plane-measurement-sweep.test.ts: 0 → 1  (+1)  ← UNCHANGED 92542min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-answer.test.ts: 0 → 1  (+1)  ← UNCHANGED 7831min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/dispatch.test.ts: 0 → 1  (+1)  ← UNCHANGED 8241min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/dev/restart.ts: 0 → 1  (+1)  ← UNCHANGED 2668min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts: 0 → 1  (+1)  ← UNCHANGED 8241min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/attention-parallel.test.ts: 0 → 1  (+1)  ← UNCHANGED 358min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/new-surface.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 7268min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts: 0 → 1  (+1)  ← UNCHANGED 7225min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/coordination-metadata-preflight.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 21345min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/legacy-item-index-compatibility.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 7474min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/pg-tool-fixture.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 2316min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/recipes/git-sync-liveness-recipe.test.ts: 0 → 1  (+1)  ← UNCHANGED 8344min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/release/trace.ts: 0 → 1  (+1)  ← UNCHANGED 7964min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.ts: 0 → 1  (+1)  ← UNCHANGED 1579min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/get_claim_spec.ts: 0 → 1  (+1)  ← UNCHANGED 9299min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/testing/runs.ts: 0 → 1  (+1)  ← UNCHANGED 1034min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 15698min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/cell-read-coalesce.test.ts: 0 → 1  (+1)  ← UNCHANGED 2299min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/change-kind-refactor-facts.ts: 0 → 1  (+1)  ← UNCHANGED 7830min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.ts: 0 → 1  (+1)  ← UNCHANGED 2592min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/routines-workflow.test.ts: 0 → 1  (+1)  ← UNCHANGED 1709min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/hosted-lead-binding.test.ts: 0 → 1  (+1)  ← UNCHANGED 7084min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 7488min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts: 0 → 1  (+1)  ← UNCHANGED 7488min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/event-loop-lag-monitor.test.ts: 0 → 1  (+1)  ← UNCHANGED 2282min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/improvements/agent-review.test.ts: 0 → 1  (+1)  ← UNCHANGED 347min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/task-reconcile-consult.fixture.ts: 0 → 1  (+1)  ← UNCHANGED 3173min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/task-reconcile-consult.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 3173min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/inference-gateway/codex-oauth-kernel-adapter.test.ts: 0 → 1  (+1)  ← UNCHANGED 466min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/memory/corpus-recall-io.test.ts: 0 → 1  (+1)  ← UNCHANGED 101min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/schedule-inventory.test.ts: 0 → 1  (+1)  ← UNCHANGED 7360min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scheduler/issue-claim-update-profile.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 2343min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.ts: 0 → 1  (+1)  ← UNCHANGED 356min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/system-health/desktop-perf-cohort.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 7364min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/test-run-receipt-reconciliation.test.ts: 0 → 1  (+1)  ← UNCHANGED 7818min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/testing-run-store.ts: 0 → 1  (+1)  ← UNCHANGED 34min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/text-artifacts.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 7275min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/wait-ref-admission.ts: 0 → 1  (+1)  ← UNCHANGED 25159min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/work-admission/lifecycle.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 8395min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/work-item-admission-review.test.ts: 0 → 1  (+1)  ← UNCHANGED 1692min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/work-items-admission-promoter.test.ts: 0 → 1  (+1)  ← UNCHANGED 2192min; error SURFACES here, so the cause is a change ELSEWHERE
    Not YOUR gate failure (you did not name them), so this run stays green.
    ALREADY RECORDED — do NOT hand-file a work-item. tsc-red-sweep files only the ones still
    standing after 45min; most self-heal first (measured: 4 of 5 gone in 15min), so
    filing on sight just makes duplicates (WI-7149/WI-7150, 75s apart). If one is YOURS, fix it.
    ⚠ 74 of the above has/have NOT been committed in a long time (marked UNCHANGED).
    A tsc error is reported where it SURFACES, not where it ORIGINATES: a required field added to
    a shared interface, a changed export type, or a resolution change strands sites in files
    nobody touched. Investigating an UNCHANGED file directly is the wrong move — look at what
    changed in its IMPORT GRAPH. For the dominant cause: npm run lint:required-field-strands
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-07T23:49:09.627Z head=14ee0e3754

