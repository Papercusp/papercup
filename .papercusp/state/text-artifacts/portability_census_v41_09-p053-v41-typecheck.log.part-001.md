---
rel_path: "portability/census/v41/09-p053-v41-typecheck.log.part-001"
updated_at: 1794241756285
_body: "content"
---

r-core/lib/agent-tools/plans/evaluate-spec-test-adequacy.ts: 0 → 1  (+1)  ← UNCHANGED 2593min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/legacy-item-index-compatibility.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 9909min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/pg-tool-fixture.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 4751min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/recipes/git-sync-liveness-recipe.test.ts: 0 → 1  (+1)  ← UNCHANGED 10778min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/release/trace.ts: 0 → 1  (+1)  ← UNCHANGED 10399min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.ts: 0 → 1  (+1)  ← UNCHANGED 4013min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/get_claim_spec.ts: 0 → 1  (+1)  ← UNCHANGED 11734min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/testing/runs.ts: 0 → 1  (+1)  ← UNCHANGED 3469min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 18133min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/bg-source-dependency-boundaries.test.ts: 0 → 1  (+1)  ← UNCHANGED 104min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/cell-read-coalesce.test.ts: 0 → 1  (+1)  ← UNCHANGED 4734min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/change-kind-refactor-facts.ts: 0 → 1  (+1)  ← UNCHANGED 10264min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.ts: 0 → 1  (+1)  ← UNCHANGED 5026min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/routines-workflow.test.ts: 0 → 1  (+1)  ← UNCHANGED 4143min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/hosted-lead-binding.test.ts: 0 → 1  (+1)  ← UNCHANGED 9519min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 9923min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts: 0 → 1  (+1)  ← UNCHANGED 9923min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/event-loop-lag-monitor.test.ts: 0 → 1  (+1)  ← UNCHANGED 4717min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/fleet/operator-spawn.ts: 0 → 1  (+1)  ← UNCHANGED 12022min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/improvements/agent-review.test.ts: 0 → 1  (+1)  ← UNCHANGED 2781min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/task-reconcile-consult.fixture.ts: 0 → 1  (+1)  ← UNCHANGED 5607min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/routines/task-reconcile-consult.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 5607min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/inference-gateway/codex-oauth-kernel-adapter.test.ts: 0 → 1  (+1)  ← UNCHANGED 2900min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/llm-testing/scenarios/su/blocker-resolution.ts: 0 → 1  (+1)  ← UNCHANGED 386min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/memory/corpus-recall-io.test.ts: 0 → 1  (+1)  ← UNCHANGED 2536min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/owner-directive-routing.test.ts: 0 → 1  (+1)  ← UNCHANGED 853min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/schedule-inventory.test.ts: 0 → 1  (+1)  ← UNCHANGED 9795min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scheduler/issue-claim-update-profile.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 4777min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.ts: 0 → 1  (+1)  ← UNCHANGED 2791min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/system-health/desktop-perf-cohort.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 9799min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/test-run-receipt-reconciliation.test.ts: 0 → 1  (+1)  ← UNCHANGED 10253min; error SURFACES here, so the cause is a change ELSEWHERE
    Not YOUR gate failure (you did not name them), so this run stays green.
    ALREADY RECORDED — do NOT hand-file a work-item. tsc-red-sweep files only the ones still
    standing after 45min; most self-heal first (measured: 4 of 5 gone in 15min), so
    filing on sight just makes duplicates (WI-7149/WI-7150, 75s apart). If one is YOURS, fix it.
    ⚠ 72 of the above has/have NOT been committed in a long time (marked UNCHANGED).
    A tsc error is reported where it SURFACES, not where it ORIGINATES: a required field added to
    a shared interface, a changed export type, or a resolution change strands sites in files
    nobody touched. Investigating an UNCHANGED file directly is the wrong move — look at what
    changed in its IMPORT GRAPH. For the dominant cause: npm run lint:required-field-strands
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=1 at=2026-11-09T16:24:40.665Z head=3c12ce8e91

