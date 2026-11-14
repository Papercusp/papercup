---
rel_path: "portability/census/v40/14-p053-v40-typecheck.log.part-000"
updated_at: 1794240916945
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 lint:tsc
> node scripts/lint-tsc.mjs --files=scripts/state-census-roots.mts,packages/operator-core/lib/backup/state-census-producers.ts,packages/operator-core/lib/backup/state-census-producers.test.ts,packages/operator-core/lib/backup/state-census-cli.test.ts

LINT_TSC_RUN_STAMP label=operator-core at=2026-11-09T16:12:46.381Z head=8ef49c84c3 scope=files files=4
  checked files : scripts/state-census-roots.mts
                 packages/operator-core/lib/backup/state-census-producers.ts
                 packages/operator-core/lib/backup/state-census-producers.test.ts
                 packages/operator-core/lib/backup/state-census-cli.test.ts
LINT_TSC_CROSS_LEG checked=2 clean=lint:tsc,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator
ⓘ cross-leg: lint:tsc:operator-vite compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:orchestrator compiles none of the named files; nothing was checked there (it cannot red on them).
ⓘ cross-leg: lint:tsc:operator compiles none of the named files; nothing was checked there (it cannot red on them).

→ 1 of the file(s) you named are outside `operator-core` — ROUTING them to the gate that owns them.
   `--files=` scopes this gate's VERDICT; it does not widen what tsc compiles.

   AUTO-ROUTING to check them:  npm run lint:tsc:scripts -- --files=scripts/state-census-roots.mts
     - scripts/state-census-roots.mts

TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=refresh elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=compiler-initialize elapsedMs=24 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=compiler-initialized elapsedMs=24 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=snapshot-release elapsedMs=24 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=snapshot-update elapsedMs=25 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=snapshot-rpc-completed elapsedMs=429 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=snapshot-updated elapsedMs=468 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=project-roots-refresh elapsedMs=468 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=project-roots-refreshed elapsedMs=472 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=refreshed elapsedMs=472 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=program-files elapsedMs=472 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 serverPhase=scope elapsedMs=488 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 resultOrigin=pending
TSC_SERVICE state=accepted requestId=d9b46086-8686-4d91-a226-6b2af1fca591 resultOrigin=pending

> @papercupai/papercusp-monorepo@0.0.1 lint:tsc:scripts
> node scripts/lint-tsc-scripts.mjs --files=scripts/state-census-roots.mts

LINT_TSC_RUN_STAMP label=scripts at=2026-11-09T16:13:02.398Z head=2b813902ab scope=files files=1
  checked files : scripts/state-census-roots.mts
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE used=1 checked=1 named=1 typeReferencing=0 importers=0 errors=0 queuedMs=0 refreshMs=472 checkMs=3413 snapshotAgeMs=3413
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC scripts: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every scripts file is at or under its type-error baseline.
LINT_TSC_RESULT label=scripts scope=files exit=0 status=clean at=2026-11-09T16:13:02.398Z head=2b813902ab
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=refresh elapsedMs=1 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=compiler-initialize elapsedMs=1342 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=compiler-initialized elapsedMs=1360 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=snapshot-update elapsedMs=1360 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=snapshot-rpc-completed elapsedMs=4370 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=snapshot-updated elapsedMs=4399 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=project-roots-refresh elapsedMs=4399 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=project-roots-refreshed elapsedMs=4484 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=refreshed elapsedMs=4484 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=program-files elapsedMs=4484 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 serverPhase=scope elapsedMs=4528 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 resultOrigin=pending
TSC_SERVICE state=accepted requestId=2f8db322-00f0-457f-89a9-d8a4d44fa380 resultOrigin=pending
TSC_SERVICE used=1 checked=6 named=4 typeReferencing=0 importers=2 errors=0 queuedMs=1 refreshMs=4483 checkMs=9443 snapshotAgeMs=9443
   (shared typecheck service: judged your files and resolved importers, including barrels — not the whole project. Unrelated files are judged by the bare run; PAPERCUSP_TSC_SERVICE=0 forces the full compile.)
TSC operator-core: 0 type errors across 0 file(s) (baseline total 0) [--files]
✓ Every operator-core file is at or under its type-error baseline.
LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=1 at=2026-11-09T16:12:46.381Z head=8ef49c84c3

