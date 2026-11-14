---
rel_path: "portability/census/v58/11-p053-v57-typecheck.log.part-000"
updated_at: 1794252348729
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/backup/state-census-cli.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T19:18:08.044Z head=c0a74e0997 scope=files files=1
  checked files : packages/operator-core/lib/backup/state-census-cli.test.ts
LINT_TSC_CROSS_LEG checked=0 clean=- red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=refresh elapsedMs=1 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=compiler-initialize elapsedMs=511 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=compiler-initialized elapsedMs=534 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=snapshot-update elapsedMs=534 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=snapshot-rpc-completed elapsedMs=2809 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=snapshot-updated elapsedMs=2851 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=project-roots-refresh elapsedMs=2851 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=project-roots-refreshed elapsedMs=2929 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=refreshed elapsedMs=2929 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=program-files elapsedMs=2929 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 serverPhase=scope elapsedMs=2962 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 resultOrigin=pending
TSC_SERVICE state=accepted requestId=1637717b-a4de-498f-9493-be17091f35f6 resultOrigin=pending
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=1 refreshMs=2928 checkMs=6170 snapshotAgeMs=6170
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-09T19:18:08.044Z head=c0a74e0997

