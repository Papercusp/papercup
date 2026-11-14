---
rel_path: "portability/census/v59-v62/30-p053-v60-typecheck.log.part-000"
updated_at: 1794254851488
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/backup/state-census-producers.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T19:39:06.428Z head=b28a830cce scope=files files=1
  checked files : packages/operator-core/lib/backup/state-census-producers.test.ts
LINT_TSC_CROSS_LEG checked=0 clean=- red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:scripts compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=compiler-initialize elapsedMs=550 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=compiler-initialized elapsedMs=572 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=snapshot-update elapsedMs=572 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=snapshot-rpc-completed elapsedMs=3513 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=snapshot-updated elapsedMs=3558 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=project-roots-refresh elapsedMs=3558 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=project-roots-refreshed elapsedMs=3648 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=refreshed elapsedMs=3648 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=program-files elapsedMs=3648 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 serverPhase=scope elapsedMs=3681 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f49b1b-72a0-48ec-8345-5f13a184c859 resultOrigin=pending
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=0 refreshMs=3648 checkMs=7148 snapshotAgeMs=7148
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-09T19:39:06.428Z head=b28a830cce

