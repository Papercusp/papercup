# HANDOFF — the git pipeline changed under you (staging→main cutover, 2026-06-06)

> For agents whose session/context predates 2026-06-06 ~08:40 EDT. Several
> things you "know" about this repo's git model are now WRONG. Read this once;
> the canon lives in `CLAUDE.md` (§Branch discipline, §Commit discipline), the
> psu playbooks, `apps/operator/lib/release/README.md`, and plan
> `staging-branch-pipeline-2026-06-06` (shipped).

## What changed (old belief → new reality)

| You may believe | Reality since 2026-06-06 |
|---|---|
| The shared tree stays on `main` | It stays on **`staging`**. If `git branch --show-current` ≠ `staging`, flag via coord — do NOT "fix" it back to `main`. |
| git-sync pushes `origin/main` | git-sync pushes **`origin/staging`** (same cadence, ~10 min; submodules unchanged — their own default branches). |
| `main` is the churny WIP branch | **`main` is GREEN-ONLY**: green-checkpoint (hourly) runs the suite on staging HEAD in an isolated checkout and fast-forwards `main` only when it passes. A **pre-push hook blocks any manual push to `main`** — don't try, don't bypass. |
| The green pin is the `ready` ref | **`ready` is DELETED.** The `main` branch IS the green pin (`releaseRef='main'`, `integrationBranch='staging'` in `release-config.ts`). |
| Deploys to `:3070` are deliberate/manual | **AUTO-SERVE**: `release-trigger` (every 15 min) runs the scripted `deploy-cli --execute` whenever green `main` is ahead of the release checkout (drain → snapshot → swap → migrate → SPA build → restart → health, auto-rollback). The release-manager agent is for incidents only. |

## What did NOT change

- You still **never `git add/commit/push/stash/branch`** — git-sync owns VCS.
  Just leave work in the tree.
- File locks (PreToolUse hook) + `coord:*` discipline are identical.
- Submodule editing is identical (in place, inside the canonical tree).
- `:3170` (`papercup-staging-api`) is still where you live-verify backend
  edits: `systemctl --user restart papercup-staging-api.service` → probe.

## Directories — work ONLY in the canonical tree

- ✅ `~/papercupai-workspace/papercup` (branch `staging`) — all work.
- 🚫 `papercup-release/` — :3070's deploy artifact (green `main`); reset +
  rebuilt every deploy. Edits there are clobbered and never reach origin.
- 🚫 `papercup-checkpoint/` — green-checkpoint's isolated test tree; reset +
  `git clean`ed every run. Stray files there poison the green gate.

## How your change reaches the live host now

Leave it in the tree → git-sync → `origin/staging` → (suite green) → `main`
→ (≤15 min) auto-deployed to `:3070`. If `:3070` lacks your change, either
the hourly checkpoint hasn't run or **staging is red** — check the
**`/admin/git`** tab (pipeline dashboard: sync/conflict/resolver stats,
green-pin gap, deploy events; backed by `harness_shared.pipeline_events`,
mig 177) or the 🟩/🟥 green-checkpoint coord broadcasts. A red suite holds
`main` — fix forward on staging; never force-push around the gate
(`deploy-cli --deploy-commit <sha> --execute` is the loud, owner-level
escape hatch).

## Sharp edges discovered during bring-up (already fixed, don't re-trip them)

- Tests must pass in a **fresh checkout**: the checkpoint tree exposed a
  cwd/repo-root-probing bug (`git-history.ts` — fixed to
  `git rev-parse --show-toplevel`). Don't write tests that depend on
  untracked files or the live tree's incidental state.
- The checkpoint suite runs with capped vitest workers
  (`VITEST_MAX_FORKS=8`) — a load-flake there reads as "not green" and
  stalls the pipeline; prefer generous timeouts on import-heavy tests.
- Deploys rebuild the release SPA (`--build-spa`) because
  `operator-vite/dist` is untracked — never hand-build in `papercup-release/`.
- The psu playbooks' "Where to work" section is now GENERATED
  (`<!-- PAPERCUSP-SU:WORKSPACE-MAP -->` marker →
  `renderWorkspaceMapSection()` in
  `packages/operator-core/lib/desktop-install/workspace-map.ts`, derived
  from the release-gate env/config seams). Don't hand-write folder/branch
  facts into the playbook prose — change the config/renderer instead.

Questions → coord to `su-0e442` (this cutover's author) or read the plan:
`plans:get { slug: 'staging-branch-pipeline-2026-06-06', harness: 'all' }`.
