---
rel_path: "portability/census/v58/07-p053-v56-typecheck.log.part-000"
updated_at: 1794252348729
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=packages/operator-core/lib/backup/state-census-producers.ts,packages/operator-core/lib/backup/state-census-producers.test.ts,scripts/state-census-roots.mts,packages/operator-core/lib/backup/state-census-cli.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T19:09:42.375Z head=6f97e03d31 scope=files files=4
  checked files : packages/operator-core/lib/backup/state-census-producers.ts
                 packages/operator-core/lib/backup/state-census-producers.test.ts
                 scripts/state-census-roots.mts
                 packages/operator-core/lib/backup/state-census-cli.test.ts
LINT_TSC_CROSS_LEG checked=2 clean=lint:tsc,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).

→ 1 of the file(s) you named are outside `operator-core` — ROUTING them to the gate that owns them.
   `--files=` scopes this gate's VERDICT; it does not widen what tsc compiles.

   AUTO-ROUTING to check them:  npm run lint:tsc:scripts -- --files=scripts/state-census-roots.mts
     - scripts/state-census-roots.mts

TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=compiler-initialize elapsedMs=46 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=compiler-initialized elapsedMs=46 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=snapshot-release elapsedMs=46 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=snapshot-update elapsedMs=65 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=snapshot-rpc-completed elapsedMs=383 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=snapshot-updated elapsedMs=422 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=project-roots-refresh elapsedMs=422 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=project-roots-refreshed elapsedMs=426 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=refreshed elapsedMs=426 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=program-files elapsedMs=426 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 serverPhase=scope elapsedMs=447 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 resultOrigin=pending
TSC_SERVICE state=accepted requestId=11f11401-8808-4db0-a427-baa11e9b22d2 resultOrigin=pending

> @papercupai/papercusp-monorepo@0.0.1 lint:tsc:scripts
> node scripts/lint-tsc-scripts.mjs --files=scripts/state-census-roots.mts

LINT_TSC_RUN_STAMP label=scripts at=2026-11-09T19:10:09.238Z head=6f97e03d31 scope=files files=1
  checked files : scripts/state-census-roots.mts
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=0 refreshMs=426 checkMs=3402 snapshotAgeMs=3402
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC scripts: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every scripts file is at or under its type-error baseline.
LINT_TSC_RESULT label=scripts scope=files exit=0 status=clean at=2026-11-09T19:10:09.238Z head=6f97e03d31
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=refresh elapsedMs=1 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=compiler-initialize elapsedMs=708 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=compiler-initialized elapsedMs=737 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=snapshot-update elapsedMs=738 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=snapshot-rpc-completed elapsedMs=4489 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=snapshot-updated elapsedMs=4536 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=project-roots-refresh elapsedMs=4536 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=project-roots-refreshed elapsedMs=4618 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=refreshed elapsedMs=4618 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=program-files elapsedMs=4618 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 serverPhase=scope elapsedMs=4649 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 resultOrigin=pending
TSC_SERVICE state=accepted requestId=3bd4353a-2d9d-4418-8da0-6a158a8f8a73 resultOrigin=pending
TSC_SERVICE used=1 checked=6 named=4 typeReferencing=0 importers=2 errors=0 queuedMs=1 refreshMs=4617 checkMs=7696 snapshotAgeMs=7696
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=1 at=2026-11-09T19:09:42.375Z head=6f97e03d31

