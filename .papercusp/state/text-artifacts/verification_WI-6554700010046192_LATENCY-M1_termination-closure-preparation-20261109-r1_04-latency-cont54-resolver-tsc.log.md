---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/termination-closure-preparation-20261109-r1/04-latency-cont54-resolver-tsc.log"
updated_at: 1794246055540
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/test/private-http-workspace-preflight.ts,packages/operator-core/test/committed-reader-source-preflight.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T17:28:21.911Z head=a0a5cb142d scope=files files=2
  checked files : packages/operator-core/test/private-http-workspace-preflight.ts
                 packages/operator-core/test/committed-reader-source-preflight.test.ts
LINT_TSC_CROSS_LEG checked=3 clean=lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=compiler-initialize elapsedMs=2875 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=compiler-initialized elapsedMs=2913 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=snapshot-update elapsedMs=2913 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=snapshot-rpc-completed elapsedMs=8857 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=snapshot-updated elapsedMs=8891 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=project-roots-refresh elapsedMs=8891 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=project-roots-refreshed elapsedMs=9003 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=refreshed elapsedMs=9003 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=program-files elapsedMs=9004 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 serverPhase=scope elapsedMs=9044 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d03e229f-be23-4d4a-b6e5-f3a7cd93f870 resultOrigin=pending
TSC_SERVICE used=1 checked=120 named=1 typeReferencing=0 importers=119 errors=0 queuedMs=1 refreshMs=9003 checkMs=9896 snapshotAgeMs=9897
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
   (1 named file(s) are not in this project's program, as with the CLI: packages/operator-core/test/committed-reader-source-preflight.test.ts)
⚠ 1 named file(s) were NOT typechecked: absent from the actual operator-core compiler program.
   - packages/operator-core/test/committed-reader-source-preflight.test.ts
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=1 at=2026-11-09T17:28:21.911Z head=a0a5cb142d

