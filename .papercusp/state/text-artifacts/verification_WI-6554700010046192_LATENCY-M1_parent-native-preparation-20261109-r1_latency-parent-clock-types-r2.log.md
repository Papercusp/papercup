---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-parent-clock-types-r2.log"
updated_at: 1794255622680
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/test/private-http-workspace-preflight.ts,packages/operator-core/test/committed-reader-source-preflight.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T20:09:54.342Z head=6cd9e7e540 scope=files files=2
  checked files : packages/operator-core/test/private-http-workspace-preflight.ts
                 packages/operator-core/test/committed-reader-source-preflight.test.ts
LINT_TSC_CROSS_LEG checked=3 clean=lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=refresh elapsedMs=1 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=compiler-initialize elapsedMs=1545 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=compiler-initialized elapsedMs=1566 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=snapshot-update elapsedMs=1566 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=snapshot-rpc-completed elapsedMs=5744 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=snapshot-updated elapsedMs=5791 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=project-roots-refresh elapsedMs=5791 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=project-roots-refreshed elapsedMs=5896 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=refreshed elapsedMs=5896 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=program-files elapsedMs=5896 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e serverPhase=scope elapsedMs=5948 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e resultOrigin=pending
TSC_SERVICE state=accepted requestId=8af23c87-fd40-4022-ae8c-deb3cb1e2a0e resultOrigin=pending
TSC_SERVICE used=1 checked=121 named=1 typeReferencing=0 importers=120 errors=0 queuedMs=1 refreshMs=5895 checkMs=9890 snapshotAgeMs=9890
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
   (1 named file(s) are not in this project's program, as with the CLI: packages/operator-core/test/committed-reader-source-preflight.test.ts)
⚠ 1 named file(s) were NOT typechecked: absent from the actual operator-core compiler program.
   - packages/operator-core/test/committed-reader-source-preflight.test.ts
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=1 at=2026-11-09T20:09:54.342Z head=6cd9e7e540

