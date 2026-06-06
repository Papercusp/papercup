# RESTORE — legacy-orchestrator-run-loop integration tests (superproject side)

**Retired:** 2026-06-06 · plan `archive-legacy-orchestrator-deadcode-2026-06-06` (Phase 1)

`apps-operator-test/` holds four `apps/operator/test/*.integration.test.ts` files that
exercised the legacy orchestrator PG modules (`snapshots-pg`, `checkpoints-pg`,
`mission-state-pg`, `dispatches-pg`). Those modules were retired into the **papercusp
submodule** at `libs/papercusp/_retired/orchestrator-run-loop/src/` — these tests moved
with them but had to land here (different git repo). They import the modules by relative
path (`../../../libs/papercusp/packages/orchestrator/src/<file>`), which no longer
resolves; they are frozen reference, not run.

**To restore:** `git mv _retired/orchestrator-run-loop/apps-operator-test/*.integration.test.ts apps/operator/test/`
after restoring the submodule modules (see
`libs/papercusp/_retired/orchestrator-run-loop/RESTORE.md`).
