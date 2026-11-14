---
rel_path: "portability/census/v41/09-p053-v41-typecheck.log.part-000"
updated_at: 1794241756285
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=scripts/state-census-roots.mts,packages/operator-core/lib/backup/state-census-producers.ts,packages/operator-core/lib/backup/state-census-producers.test.ts,packages/operator-core/lib/backup/state-census-cli.test.ts,packages/operator-core/lib/agent-tools/testing/run-artifacts.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T16:24:40.665Z head=3c12ce8e91 scope=files files=5
  checked files : scripts/state-census-roots.mts
                 packages/operator-core/lib/backup/state-census-producers.ts
                 packages/operator-core/lib/backup/state-census-producers.test.ts
                 packages/operator-core/lib/backup/state-census-cli.test.ts
                 packages/operator-core/lib/agent-tools/testing/run-artifacts.ts
LINT_TSC_CROSS_LEG checked=5 clean=lint:tsc,lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=-

→ 1 of the file(s) you named are outside `operator-core` — ROUTING them to the gate that owns them.
   `--files=` scopes this gate's VERDICT; it does not widen what tsc compiles.

   AUTO-ROUTING to check them:  npm run lint:tsc:scripts -- --files=scripts/state-census-roots.mts
     - scripts/state-census-roots.mts

TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=compiler-initialize elapsedMs=37 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=compiler-initialized elapsedMs=37 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=snapshot-release elapsedMs=37 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=snapshot-update elapsedMs=45 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=snapshot-rpc-completed elapsedMs=506 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=snapshot-updated elapsedMs=529 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=project-roots-refresh elapsedMs=530 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=project-roots-refreshed elapsedMs=533 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=refreshed elapsedMs=533 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=program-files elapsedMs=533 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 serverPhase=scope elapsedMs=543 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 resultOrigin=pending
TSC_SERVICE state=accepted requestId=81ef7b85-e7fb-4b44-941a-3d51ab669d28 resultOrigin=pending

> @papercupai/papercusp-monorepo@0.0.1 lint:tsc:scripts
> node scripts/lint-tsc-scripts.mjs --files=scripts/state-census-roots.mts

LINT_TSC_RUN_STAMP label=scripts at=2026-11-09T16:25:09.646Z head=3c12ce8e91 scope=files files=1
  checked files : scripts/state-census-roots.mts
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=0 refreshMs=533 checkMs=2973 snapshotAgeMs=2973
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC scripts: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every scripts file is at or under its type-error baseline.
LINT_TSC_RESULT label=scripts scope=files exit=0 status=clean at=2026-11-09T16:25:09.646Z head=3c12ce8e91
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=compiler-initialize elapsedMs=1875 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=compiler-initialized elapsedMs=1909 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=snapshot-update elapsedMs=1909 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=snapshot-rpc-completed elapsedMs=5953 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=snapshot-updated elapsedMs=5988 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=project-roots-refresh elapsedMs=5988 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=project-roots-refreshed elapsedMs=6091 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=refreshed elapsedMs=6091 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=program-files elapsedMs=6091 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8890e113-b5b3-48b9-a414-8ab75255c83e serverPhase=scope elapsedMs=6133 resultOrigin=pending
⚠ TSC_SERVICE declined (scope-too-wide: at least 1501 files (limit 1500); a full compile is cheaper) — running the full operator-core compile instead. state=scope-too-wide resultOrigin=full-compile-required
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-1948505-1794241525169505230 retryHandle=psi-recovery:pc-heavy-1948505-1794241525169505230 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TSC operator-core: 246 type errors across 146 file(s) (baseline total 224) [--files]
✓ The current --mine dirty set is tsc-clean. 0 baseline-regressed file(s) are outside that set:
   (Not gated under --mine. The shared git-status set can include other sessions' dirty edits;
    use --files= for explicit attribution.)
    A bare npm run of this gate will still catch these for whoever owns them.
   ⚠ 72 NEW file(s) (absent from the baseline) also have type errors, none of them in the set you named:
   packages/operator-core/lib/agent-tools/tools/invoke.ts: 0 → 14  (+14)  ← UNCHANGED 10353min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/capability/bash_output.ts: 0 → 10  (+10)  ← UNCHANGED 5528min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/cupboard/installed-tool-funding.test.ts: 0 → 7  (+7)  ← UNCHANGED 42792min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/__tests__/fs-mutex.test.ts: 0 → 6  (+6)  ← UNCHANGED 4825min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/runtime-blocker-condition.ts: 0 → 6  (+6)  ← UNCHANGED 876min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts: 0 → 5  (+5)  ← UNCHANGED 5026min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts: 0 → 4  (+4)  ← UNCHANGED 10826min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts: 0 → 4  (+4)  ← UNCHANGED 1146min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/service-memory-attribution.integration.test.ts: 0 → 4  (+4)  ← UNCHANGED 9236min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts: 0 → 3  (+3)  ← UNCHANGED 10030min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts: 0 → 3  (+3)  ← UNCHANGED 9567min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/degradation/rail-migration-cases.ts: 0 → 3  (+3)  ← UNCHANGED 5368min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/license-gate.test.ts: 0 → 3  (+3)  ← UNCHANGED 10244min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/scratch-gc.test.ts: 0 → 3  (+3)  ← UNCHANGED 2791min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 4013min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/rubrics/amend-status.ts: 0 → 2  (+2)  ← UNCHANGED 4900min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/scorecards/emit-from-ledger.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 450min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/work_items/get-shape.ts: 0 → 2  (+2)  ← UNCHANGED 2482min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/blind-review-source-image.ts: 0 → 2  (+2)  ← UNCHANGED 17301min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/capability-envelope/identity-tool-surface.ts: 0 → 2  (+2)  ← UNCHANGED 9712min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/carry-brief.test.ts: 0 → 2  (+2)  ← UNCHANGED 2460min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 9519min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts: 0 → 2  (+2)  ← UNCHANGED 5578min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/events/await/declared-gate-recovery.test.ts: 0 → 2  (+2)  ← UNCHANGED 1257min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/gate-candidate-failures.test.ts: 0 → 2  (+2)  ← UNCHANGED 10539min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/harness/improvements/observation-types.test.ts: 0 → 2  (+2)  ← UNCHANGED 2769min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/result-door.test.ts: 0 → 2  (+2)  ← UNCHANGED 4900min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/spec-conformance/conformance-run-deps.test.ts: 0 → 2  (+2)  ← UNCHANGED 851min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/turn-end-tracking-io.test.ts: 0 → 2  (+2)  ← UNCHANGED 10348min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-plane-measurement-sweep.test.ts: 0 → 1  (+1)  ← UNCHANGED 94976min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/code/capture-recipe.test.ts: 0 → 1  (+1)  ← UNCHANGED 1183min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-answer.test.ts: 0 → 1  (+1)  ← UNCHANGED 10266min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/coordination/tools/dispatch.test.ts: 0 → 1  (+1)  ← UNCHANGED 10676min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/dev/restart.ts: 0 → 1  (+1)  ← UNCHANGED 5103min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/events/status.test.ts: 0 → 1  (+1)  ← UNCHANGED 1257min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/events/status.ts: 0 → 1  (+1)  ← UNCHANGED 1257min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts: 0 → 1  (+1)  ← UNCHANGED 10676min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/attention-parallel.test.ts: 0 → 1  (+1)  ← UNCHANGED 2793min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/__tests__/new-surface.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 9703min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts: 0 → 1  (+1)  ← UNCHANGED 9660min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operator-core/lib/agent-tools/plans/coordination-metadata-preflight.integration.test.ts: 0 → 1  (+1)  ← UNCHANGED 23779min; error SURFACES here, so the cause is a change ELSEWHERE
   packages/operato
