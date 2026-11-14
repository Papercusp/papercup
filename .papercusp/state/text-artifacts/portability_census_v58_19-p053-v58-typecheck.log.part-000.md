---
rel_path: "portability/census/v58/19-p053-v58-typecheck.log.part-000"
updated_at: 1794252348729
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/backup/state-census-producers.ts,packages/operator-core/lib/backup/state-census-producers.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T19:22:31.788Z head=6aa900507c scope=files files=2
  checked files : packages/operator-core/lib/backup/state-census-producers.ts
                 packages/operator-core/lib/backup/state-census-producers.test.ts
LINT_TSC_CROSS_LEG checked=1 clean=lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=compiler-initialize elapsedMs=2407 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=compiler-initialized elapsedMs=2436 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=snapshot-update elapsedMs=2436 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=snapshot-rpc-completed elapsedMs=5746 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=snapshot-updated elapsedMs=5783 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=project-roots-refresh elapsedMs=5783 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=project-roots-refreshed elapsedMs=5867 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=refreshed elapsedMs=5867 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=program-files elapsedMs=5867 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 serverPhase=scope elapsedMs=5903 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 resultOrigin=pending
TSC_SERVICE state=accepted requestId=513f177c-272e-416c-ab58-2d3c71c6a092 resultOrigin=pending
TSC_SERVICE used=1 checked=6 named=2 typeReferencing=0 importers=4 errors=0 queuedMs=0 refreshMs=5867 checkMs=7130 snapshotAgeMs=7130
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-09T19:22:31.788Z head=6aa900507c

