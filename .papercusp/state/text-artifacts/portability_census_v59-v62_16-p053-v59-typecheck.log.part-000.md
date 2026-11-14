---
rel_path: "portability/census/v59-v62/16-p053-v59-typecheck.log.part-000"
updated_at: 1794254851488
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/admin-commands.ts,packages/operator-core/lib/admin-commands.test.ts,packages/operator-core/lib/backup/state-census-producers.ts,packages/operator-core/lib/backup/state-census-producers.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T19:35:09.731Z head=b28a830cce scope=files files=4
  checked files : packages/operator-core/lib/admin-commands.ts
                 packages/operator-core/lib/admin-commands.test.ts
                 packages/operator-core/lib/backup/state-census-producers.ts
                 packages/operator-core/lib/backup/state-census-producers.test.ts
LINT_TSC_CROSS_LEG checked=4 clean=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=-
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=compiler-initialize elapsedMs=532 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=compiler-initialized elapsedMs=550 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=snapshot-update elapsedMs=550 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=snapshot-rpc-completed elapsedMs=3523 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=snapshot-updated elapsedMs=3568 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=project-roots-refresh elapsedMs=3569 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=project-roots-refreshed elapsedMs=3661 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=refreshed elapsedMs=3662 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=program-files elapsedMs=3662 resultOrigin=pending
TSC_SERVICE state=accepted requestId=e99417a7-dbef-4d67-ab37-fad266104950 serverPhase=scope elapsedMs=3702 resultOrigin=pending
⚠ TSC_SERVICE declined (scope-too-wide: at least 1501 files (limit 1500); a full compile is cheaper) — running the full operator-core compile instead. state=scope-too-wide resultOrigin=full-compile-required
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-191783-1794252926566802998 retryHandle=psi-recovery:pc-heavy-191783-1794252926566802998 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TSC operator-core: 251 type errors across 149 file(s) (baseline total 224) [--files]
✓ The current --mine dirty set is tsc-clean. 0 baseline-regressed file(s) are outside that set:
   (Not gated under --mine. The shared git-status set can include other sessions' dirty edits;
    use --files= for explicit attribution.)
    A bare npm run of this gate will still catch these for whoever owns them.
   ⚠ 75 NEW file(s) (absent from the baseline) also have type errors, none of them in the set you named:
   packages/operator-core/lib/work-items.ts: 0 → 3  (+3)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/testing-run-store.test.ts: 0 → 1  (+1)  ← uncommitted, a peer is likely mid-edit
   packages/operator-core/lib/agent-tools/tools/invoke.ts: 0 → 14  (+14)  ← UNCHANGED 10543min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/bash_output.ts: 0 → 10  (+10)  ← UNCHANGED 5718min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/cupboard/installed-tool-funding.test.ts: 0 → 7  (+7)  ← UNCHANGED 42982min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/__tests__/fs-mutex.test.ts: 0 → 6  (+6)  ← UNCHANGED 5015min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/runtime-blocker-condition.ts: 0 → 6  (+6)  ← UNCHANGED 1066min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts: 0 → 5  (+5)  ← UNCHANGED 5216min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts: 0 → 4  (+4)  ← UNCHANGED 11016min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts: 0 → 4  (+4)  ← UNCHANGED 1336min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/service-memory-attribution.integration.test.ts: 0 → 4  (+4)  ← UNCHANGED 9426min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts: 0 → 3  (+3)  ← UNCHANGED 10220min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts: 0 → 3  (+3)  ← UNCHANGED 9757min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/degradation/rail-migration-cases.ts: 0 → 3  (+3)  ← UNCHANGED 5558min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/license-gate.test.ts: 0 → 3  (+3)  ← UNCHANGED 10434min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.test.ts: 0 → 3  (+3)  ← UNCHANGED 2981min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 4204min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-status.ts: 0 → 2  (+2)  ← UNCHANGED 5091min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scorecards/emit-from-ledger.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 640min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/work_items/get-shape.ts: 0 → 2  (+2)  ← UNCHANGED 2672min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/blind-review-source-image.ts: 0 → 2  (+2)  ← UNCHANGED 17491min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/capability-envelope/identity-tool-surface.ts: 0 → 2  (+2)  ← UNCHANGED 9902min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-brief.test.ts: 0 → 2  (+2)  ← UNCHANGED 2650min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 9709min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 5768min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/events/await/declared-gate-recovery.test.ts: 0 → 2  (+2)  ← UNCHANGED 1448min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/gate-candidate-failures.test.ts: 0 → 2  (+2)  ← UNCHANGED 10730min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/improvements/observation-types.test.ts: 0 → 2  (+2)  ← UNCHANGED 2959min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/result-door.test.ts: 0 → 2  (+2)  ← UNCHANGED 5091min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/spec-conformance/conformance-run-deps.test.ts: 0 → 2  (+2)  ← UNCHANGED 1041min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/turn-end-tracking-io.test.ts: 0 → 2  (+2)  ← UNCHANGED 10539min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-plane-measurement-sweep.test.ts: 0 → 1  (+1)  ← UNCHANGED 95166min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/code/capture-recipe.test.ts: 0 → 1  (+1)  ← UNCHANGED 1373min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-answer.test.ts: 0 → 1  (+1)  ← UNCHANGED 10456min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/dispatch.test.ts: 0 → 1  (+1)  ← UNCHANGED 10866min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/dev/restart.ts: 0 → 1  (+1)  ← UNCHANGED 5293min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/events/status.test.ts: 0 → 1  (+1)  ← UNCHANGED 1448min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/events/status.ts: 0 → 1  (+1)  ← UNCHANGED 1448min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts: 0 → 1  (+1)  ← UNCHANGED 10866min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/attention-parallel.test.ts: 0 → 1  (+1)  ← UNCHANGED 2983min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/new-surface.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 9893min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts: 0 → 1  (+1)  ← UNCHANGED 9850min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/coordination-metadata-preflight.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 23970min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/evaluate-spec-test-adequacy.ts: 0 → 1  (+1)  ← UNCHANGED 2783min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/legacy-item-index-compatibility.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 10099min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/pg-tool-fixture.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 4941min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/recipes/git-sync-liveness-recipe.test.ts: 0 → 1  (+1)  ← UNCHANGED 10968min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/release/trace.ts: 0 → 1  (+1)  ← UNCHANGED 10589min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.ts: 0 → 1  (+1)  ← UNCHANGED 4204min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/get_claim_spec.ts: 0 → 1  (+1)  ← UNCHANGED 11924min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/testing/runs.ts: 0 → 1  (+1)  ← UNCHANGED 3659min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 18323min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/bg-source-dependency-boundaries.test.ts: 0 → 1  (+1)  ← UNCHANGED 294min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/cell-read-coalesce.test.ts: 0 → 1  (+1)  ← UNCHANGED 4924min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/change-kind-refactor-facts.ts: 0 → 1  (+1)  ← UNCHANGED 10455min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.ts: 0 → 1  (+1)  ← UNCHANGED 5216min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/routines-workflow.test.ts: 0 → 1  (+1)  ← UNCHANGED 4333min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/hosted-lead-binding.test.ts: 0 → 1  (+1)  ← UNCHANGED 9709min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 10113min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts: 0 → 1  (+1)  ← UNCHANGED 10113min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/event-loop-lag-monitor.test.ts: 0 → 1  (+1)  ← UNCHANGED 4907min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/fleet/operator-spawn.ts: 0 → 1  (+1)  ← UNCHANGED 12212min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/improvements/agent-review.test.ts: 0 → 1  (+1)  ← UNCHANGED 2971min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/task-reconcile-consult.fixture.ts: 0 → 1  (+1)  ← UNCHANGED 5797min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/task-reconcile-consult.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 5797min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/inference-gateway/codex-oauth-kernel-adapter.test.ts: 0 → 1  (+1)  ← UNCHANGED 3091min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/llm-testing/scenarios/su/_overrides.test.ts: 0 → 1  (+1)  ← UNCHANGED 38min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/llm-testing/scenarios/su/blocker-resolution.ts: 0 → 1  (+1)  ← UNCHANGED 577min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/memory/corpus-recall-io.test.ts: 0 → 1  (+1)  ← UNCHANGED 2726min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/owner-directive-routing.test.ts: 0 → 1  (+1)  ← UNCHANGED 1043min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/schedule-inventory.test.ts: 0 → 1  (+1)  ← UNCHANGED 9985min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scheduler/issue-claim-update-profile.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 4968min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.ts: 0 → 1  (+1)  ← UNCHANGED 2981min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/system-health/desktop-perf-cohort.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 9989min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/test-run-receipt-reconciliation.test.ts: 0 → 1  (+1)  ← UNCHANGED 10443min; error SURFACES here, so the cause is a change ELSEWHERE
    Not YOUR gate failure (you did not name them), so this run stays green.
    ALREADY RECORDED — do NOT hand-file a work-item. tsc-red-sweep files only the ones still
    standing after 45min; most self-heal first (measured: 4 of 5 gone in 15min), so
    filing on sight just makes duplicates (WI-7149/WI-7150, 75s apart). If one is YOURS, fix it.
    ⚠ 73 of the above has/have NOT been committed in a long time (marked UNCHANGED).
    A tsc error is reported where it SURFACES, not where it ORIGINATES: a required field added to
    a shared interface, a changed export type, or a resolution change strands sites in files
    nobody touched. Investigating an UNCHANGED file directly is the wrong move — look at what
    changed in its IMPORT GRAPH. For the dominant cause: npm run lint:required-field-strands
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-09T19:35:09.731Z head=b28a830cce

