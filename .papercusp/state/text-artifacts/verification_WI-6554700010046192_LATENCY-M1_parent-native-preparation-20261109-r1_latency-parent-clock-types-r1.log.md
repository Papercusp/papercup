---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-parent-clock-types-r1.log"
updated_at: 1794255622680
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/test/private-http-workspace-preflight.ts,packages/operator-core/test/committed-reader-source-preflight.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T20:03:54.996Z head=6cd9e7e540 scope=files files=2
  checked files : packages/operator-core/test/private-http-workspace-preflight.ts
                 packages/operator-core/test/committed-reader-source-preflight.test.ts
LINT_TSC_CROSS_LEG checked=3 clean=lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=compiler-initialize elapsedMs=1467 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=compiler-initialized elapsedMs=1485 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=snapshot-update elapsedMs=1485 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=snapshot-rpc-completed elapsedMs=5615 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=snapshot-updated elapsedMs=5656 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=project-roots-refresh elapsedMs=5656 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=project-roots-refreshed elapsedMs=5770 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=refreshed elapsedMs=5771 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=program-files elapsedMs=5771 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b serverPhase=scope elapsedMs=5826 resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b resultOrigin=pending
TSC_SERVICE state=accepted requestId=b358b281-cf46-4af3-9f9c-81728369779b resultOrigin=pending
TSC_SERVICE used=1 checked=121 named=1 typeReferencing=0 importers=120 errors=0 queuedMs=0 refreshMs=5771 checkMs=9775 snapshotAgeMs=9775
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
   (1 named file(s) are not in this project's program, as with the CLI: packages/operator-core/test/committed-reader-source-preflight.test.ts)
⚠ 1 named file(s) were NOT typechecked: absent from the actual operator-core compiler program.
   - packages/operator-core/test/committed-reader-source-preflight.test.ts
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=1 at=2026-11-09T20:03:54.996Z head=6cd9e7e540

