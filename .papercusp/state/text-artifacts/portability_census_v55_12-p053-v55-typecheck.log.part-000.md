---
rel_path: "portability/census/v55/12-p053-v55-typecheck.log.part-000"
updated_at: 1794250602744
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/backup/state-census-producers.ts,packages/operator-core/lib/backup/state-census-producers.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T18:54:09.521Z head=193590928a scope=files files=2
  checked files : packages/operator-core/lib/backup/state-census-producers.ts
                 packages/operator-core/lib/backup/state-census-producers.test.ts
LINT_TSC_CROSS_LEG checked=1 clean=lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=compiler-initialize elapsedMs=627 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=compiler-initialized elapsedMs=646 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=snapshot-update elapsedMs=646 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=snapshot-rpc-completed elapsedMs=3802 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=snapshot-updated elapsedMs=3848 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=project-roots-refresh elapsedMs=3848 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=project-roots-refreshed elapsedMs=3960 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=refreshed elapsedMs=3960 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=program-files elapsedMs=3961 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 serverPhase=scope elapsedMs=4020 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 resultOrigin=pending
TSC_SERVICE state=accepted requestId=8ba70965-f1b1-4279-8780-fd412eb06785 resultOrigin=pending
TSC_SERVICE used=1 checked=6 named=2 typeReferencing=0 importers=4 errors=0 queuedMs=1 refreshMs=3960 checkMs=7960 snapshotAgeMs=7961
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-11-09T18:54:09.521Z head=193590928a

