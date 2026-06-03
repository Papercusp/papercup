---
title: Automated git-sync: scheduled commit + submodule push + merge, with a merge-resolver agent
slug: git-sync-auto-commit-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: avi@storewolf.com
---

# Automated git-sync: scheduled commit + submodule push + merge, with a merge-resolver agent

## Now

**State:** Designed + grounded against the code. A background DBOS-scheduled job will, per harness on an interval, **commit everything** (superproject + submodules), **push submodule branches to origin first**, **bump + push the superproject pointer**, doing a **merge with origin/main** in between, and on a merge conflict **abort to a clean tree + spawn a `merge-resolver` agent**. Agents stop committing/pushing entirely (prompt edit). Per-harness config rides the existing `harness_shared.routines` table; scheduling + execution run as durable DBOS steps. Awaiting human review before implementation. Builds on the live DBOS substrate (`PAPERCUSP_DBOS_ENABLE=1`, `lib/dbos/periodic-workflows.ts` recipe).

**Next:** P-001 — model git-sync config as a `routines` row + read/write helpers, then P-002 the `gitSyncTick` DBOS scheduled workflow.

## Background

Today every SU/agent commits its own work each turn (and does not push); submodule pins are kept local-only and pushed by a manual "owner-sync" dance. We're replacing all of that with **git-as-sync**: one background system owns commit + merge + push so the shared `papercup` tree continuously converges with `origin/main` across machines/contributors, and **agents stop doing git entirely**.

Grounding (from code audit):
- **Substrate:** DBOS is live (`bootstrap.ts`, gated `PAPERCUSP_DBOS_ENABLE=1`; `.env.local:68` + `lib/gym/boot-spec.ts:76`). The `harness_shared.routines` table (`trigger_kind`/`trigger_config`/`target_role`/`concurrency`/`catchup`/`active`/`next_fire_at`) is the per-harness scheduled-task config surface. Its `routine-ticker`/`fireRoutine`→`pending_events` path is **not running in the operator**, so git-sync will **not** route through `pending_events`; the DBOS workflow reads due routines and executes inline (durable, retryable).
- **Git plumbing to reuse:** async `RunGit` (`lib/harness-state/git-export/git-committer.ts:29`), `getConflictedFiles()` via `git diff --diff-filter=U` (`lib/harness/auto-rebase.ts:142`), `buildRebaseConflictEscalation()`/`composeStashBranchRef()` (`lib/harness/sync-with-main-types.ts:176,190`), `writeEscalation()` into `harness_shared.harness_escalations` (`auto-rebase.ts:159`), repo path via `projectDirForSlug(slug)` (`lib/operator-notes.ts:62`).
- **Roles:** `AGENT_ROLES` (`packages/agent-mcp/src/role-config.ts:24`) is a compile-time string list; personas live at `libs/papercusp/packages/harness/prompts/<role>.md`; no DB roles table. `buildRoleLaunchSpec` (`lib/role-launch-spec.ts:85`) takes an **optional `featureId`** + `extras` env bullets — so a non-feature system role launches cleanly. `launchAgent` (`lib/launch-agent.ts:47`) POSTs `launch-su`.
- **Submodules:** no existing commit+push+bump automation — new capability. The `libs-papercusp-submodule` resource lock (locks pkg `007-*.sql`) currently only serializes the manual process; we reuse it to serialize the automated one.
- **Migrations:** next DB migration is `115-*` (`libs/papercusp/libs/db/sql/`); next locks migration is `008-*` (locks pkg, `papercusp_su`).

## Phase 1 — Config + scheduler substrate

- **P-001** `todo` Model git-sync config on `harness_shared.routines`: a reserved system target `target_role = 'system:git-sync'` (not an agent role — handled inline, never spawned), `trigger_kind='cron'`, `trigger_config = { cron, push: true, push_submodules: true, merge_strategy: 'merge' }`, `active` toggle. Add `getGitSyncRoutines(sql)` / `upsertGitSyncRoutine(sql, {installSlug, cron, ...})` helpers (wrap existing `upsertRoutine`/a filtered `listDueCronRoutines`). Per-harness enable/interval is just routine rows → satisfies the "generalize as harness config" ask. (M)
- **P-002** `todo` `gitSyncTick` DBOS scheduled workflow (`lib/dbos/git-sync-workflow.ts`, `registerScheduled({ crontab: '*/60 * * * * *' })` = every 60s): query due `system:git-sync` routines (`active`, `next_fire_at <= now`), and for each run the pipeline (Phase 2) as a child workflow / `DBOS.runStep`s, then advance `next_fire_at`. Add `dbosGitSyncActive()` to `dbos-flags.ts` (default-on under the orchestrator gate, env override `PAPERCUSP_DBOS_GIT_SYNC`); register in `bootstrap.ts`. Skip-missed; per-harness dedup so two ticks can't sync one repo at once. (M)

## Phase 2 — The git-sync pipeline (durable steps)

- **P-003** `todo` Pipeline scaffold `lib/harness/git-sync/run-git-sync.ts`: resolve repo path via `projectDirForSlug(slug)`; an async git runner (reuse the `RunGit` shape); detect dirty state; structured `GitSyncOutcome` (`synced` | `conflict` | `nothing` | `error`) recorded back onto the routine `metadata` (`last_synced_at`, `last_status`, `head_sha`). (M)
- **P-004** `todo` Commit step: stage + `git commit --no-verify` the superproject (`git add -A`) **and each submodule** (`libs/papercusp`, `libs/papercup-shared`) when dirty — skip clean ones. Serialize the index with the existing per-process git mutex pattern + the resource lock (P-007). (M)
- **P-005** `todo` Submodule push FIRST (reverts the local-only rule, D-003): for each dirty/ahead submodule `git -C <sub> push origin HEAD:<branch>` (branch from submodule HEAD; handle detached HEAD by pushing to the tracked branch), THEN `git add <sub>` in the superproject so the bumped pointer is committed. Guarantees a fresh clone of pushed `main` resolves submodule pins. (M)
- **P-006** `todo` Sync step: `git fetch origin main`; `git merge --no-edit origin/main` (merge, not rebase — D-002); on success `git push origin HEAD:main`. On non-fast-forward push rejection, re-fetch + re-merge once, else treat as conflict. (M)
- **P-007** `todo` Locks integration: register a `git-sync` resource (locks `008-*.sql`); the pipeline acquires `exclusive(git-sync)` for the repo + `exclusive(libs-papercusp-submodule)` across the commit→submodule-push→pointer-bump→push sequence, with a short drain so in-flight peer edits settle; release broadcasts the new tip. (S)

## Phase 3 — Conflict resolution via a merge-resolver agent

- **P-008** `todo` On merge conflict: `getConflictedFiles()`, then **`git merge --abort`** to restore a clean tree (agents must never see a conflicted/half-merged tree), and write a git-sync escalation into `harness_escalations` (new `kind` alongside the rebase one; reuse the `writeEscalation` + builder pattern). Record `last_status='conflict'` + the conflicted files. (M)
- **P-009** `todo` Add the `merge-resolver` role: append `'merge-resolver'` to `AGENT_ROLES` (`role-config.ts`) + write persona `libs/papercusp/packages/harness/prompts/merge-resolver.md` (job: fetch + merge `origin/main`, resolve conflicts, commit on `main`, leave tree clean; acquire the `git-sync` lock during its merge; do NOT push — the next tick pushes). (M)
- **P-010** `todo` Spawn the resolver from the pipeline: `buildRoleLaunchSpec({ role:'merge-resolver', workspaceId, harnessSlug, featureId:null, extras:[conflicted files, escalation ref] })` → `launchAgent`. **Dedup**: only spawn if no open git-sync escalation / no live merge-resolver session for that harness (the open escalation is the dedup key). Resolver clears the escalation on success → next `gitSyncTick` pushes the resolved tree. (M)

## Phase 4 — Cutover: agents stop doing git + the prompt edit

- **P-011** `todo` SU engineer prompt edit (`apps/operator/prompts/papercusp-su-engineer.tools.md`, the "Commit every turn; don't push; don't fight the messy history" block, ~L229): replace with **"You do not commit or push at all — a background git-sync system (a DBOS routine) owns commit + merge + push end-to-end. Just leave your work in the tree; it will be committed, merged with origin, and pushed for you."** Keep the "stay on main / never worktree" guidance. Mirror into `papercusp-su-power.tools.md` and the repo `CLAUDE.md` (the per-turn-commit rule) so every surface agrees. **Lands only once the system is live (blocked-by P-002, P-010) — shipping it earlier would tell agents to stop committing before anything commits for them, losing work.** blocked-by: P-002, P-010 (S)
- **P-012** `todo` Revert the "submodule pins are local-only / don't push without asking" guidance now that auto-push owns it: update the `libs-papercusp-submodule` lock description (locks SQL), the SU playbooks, and `CLAUDE.md` where that rule appears. (S)
- **P-013** `todo` Seed git-sync for the `papercup` harness: upsert a `system:git-sync` routine (default interval ~3 min, `push:true`, `push_submodules:true`). Leave other harnesses opt-in. blocked-by: P-001 (XS)

## Phase 5 — Verify

- **P-014** `todo` Integration test the pipeline against a throwaway local origin + a submodule fixture: happy path (commit → submodule push → pointer bump → merge → push), no-op tick (clean tree), and conflict path (induced divergence → `merge --abort` → escalation → resolver-spawn stub). Add a DBOS crash-replay test (mirror `test/dbos-crash-replay.integration.test.ts`) so a mid-sync crash resumes safely. (M)
- **P-015** `todo` Live on `papercup`: enable the routine, make a local edit, confirm one tick commits + pushes superproject **and** a submodule branch to origin (verify a fresh clone resolves the pins); then push a divergent commit from a second clone and confirm the next tick detects the conflict, aborts clean, files the escalation, and spawns one `merge-resolver`. blocked-by: P-010, P-013 (S)

## Decisions

### D-001 — Substrate: DBOS owns scheduling + execution; routines is the config store
Date: 2026-06-03
Per-harness config (enable, cron, push policy) lives in `harness_shared.routines` (reserved `target_role='system:git-sync'`) so it's editable as ordinary harness config and generalizes to future scheduled tasks — answering the "make it part of the harness configuration" ask. But execution does **not** go through the `routines → pending_events → role-spawn` path: that ticker isn't running in the operator and git-sync is a *system action*, not an agent spawn. A dedicated `gitSyncTick` DBOS scheduled workflow reads due git-sync routines and runs the pipeline as durable, retryable steps (crash-safe resume), reusing the proven `periodic-workflows.ts` recipe. This is option **C** from the design discussion (DBOS + routines), chosen over A (dedicated bespoke config; doesn't generalize) and B (drive the dormant routine-ticker; not durable).

### D-002 — Merge, not rebase
Date: 2026-06-03
The pipeline pushes every tick, so local commits become published quickly. Rebasing published history is wrong; a plain `git merge --no-edit origin/main` keeps the shared tree converging without rewriting commits other clones already have. Matches the repo's "messy history is fine; we package whatever's in the tree" philosophy.

### D-003 — Auto-push submodule branches (reverts "pins local-only / don't push without asking")
Date: 2026-06-03 (avi)
We deliberately reverse the standing rule that `libs/papercusp` + `libs/papercup-shared` pins stay local-only. The pipeline pushes each submodule branch to origin **before** bumping + pushing the superproject pointer, so a fresh clone of pushed `main` always resolves its pins (no more `upload-pack: not our ref`). This retires the manual "owner-sync" broadcasts the `libs-papercusp-submodule` lock was created to coordinate.

### D-004 — On conflict: abort to a clean tree, then spawn a deduped merge-resolver
Date: 2026-06-03
Agents share one working tree on `main`; they must never encounter a conflicted/half-merged tree. So on a merge conflict the tick `git merge --abort`s (clean tree, work preserved as local commits), files a git-sync escalation, and spawns one `merge-resolver` agent (deduped on the open escalation). The resolver redoes `fetch + merge` fresh, resolves, commits on `main`, and leaves the tree clean; the next tick pushes. No human in the loop unless the resolver itself escalates.

### D-005 — Agents stop committing and pushing entirely
Date: 2026-06-03 (avi)
The per-turn "commit every turn; don't push" rule is replaced: agents do no git at all. The prompt change (P-011) ships only once the system is live, so there's never a window where agents stop committing before the system commits for them.
