---
title: Revive a generic DBOS routines engine; automated git-sync is its first consumer
slug: git-sync-auto-commit-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: avi@storewolf.com
---

# Revive a generic DBOS routines engine; automated git-sync is its first consumer

## Now

**State:** BUILT + TESTED (autonomous overnight), awaiting supervised go-live. Shipped on main: the revived generic DBOS routines engine (P-001/P-002), the git-sync pipeline (P-005–P-008, real-git tested incl. submodule push), the system:git-sync action with locks + conflict-escalation + deduped merge-resolver (P-009–P-012, role+persona in submodule), dead routine-ticker removed (P-004), the per-harness config helper (P-003a), and the papercup routine SEEDED INACTIVE (P-015). 14 tests green; typecheck clean. P-003 wip = routines:list/set MCP tools deferred (thin wrapper, follow-up). P-016 wip = DBOS-launch crash-replay + PG-escalation tests fold into the held live verify. EVERYTHING IS DORMANT: PAPERCUSP_DBOS_ROUTINES off + routine active=false; agents still commit as before (P-013 NOT landed).

**Next:** HELD for avi (supervised go-live — see final report): set PAPERCUSP_DBOS_ROUTINES=1, flip the papercup routine active=true (P-015→active), land the agent prompt edit (P-013) + submodule-guidance revert (P-014), then live-verify on a real edit + induced conflict (P-016/P-017). Optional follow-up: routines:list/set MCP tools (P-003b).

## Background

Today every agent commits its own work each turn (and does not push); submodule pins are kept local-only and pushed by a manual "owner-sync" dance. We replace all of it with **git-as-sync**: one background system owns commit + merge + push so the shared `papercup` tree continuously converges with `origin/main`, and **agents stop doing git**.

The substrate is a **revived generic routines engine** (chosen "Fate 1" over a one-off git-sync workflow). Why: DBOS provides durable execution + *static-at-boot* cron (`registerScheduled`) + delayed enqueue + queues, but **not** a runtime-editable, per-tenant schedule registry — and that registry is exactly what `harness_shared.routines` already is (`trigger_kind`/`trigger_config`/`target_role`/`concurrency`/`catchup`/`active`/`next_fire_at`). Its only weak part is the *engine*: `routine-ticker` is a dead in-process `setTimeout` loop, not running in the operator and not durable. So we keep the registry + policies, **replace the loop with a DBOS `routinesTick` workflow**, and **generalize a routine's target** to be either an agent-role spawn (existing) or a `system:<action>` handler (new). git-sync is the first `system:` action; future per-harness scheduled tasks reuse the same engine. No second scheduler (pg-boss/BullMQ stay rejected); cron stays the format (DBOS-native), next-fire calculator pluggable behind `computeNextFireAt`.

Grounding (from code audit):
- **Engine pieces:** `routine-ticker.ts` (the dead loop — *replace*), `routines-runtime.ts` `listDueCronRoutines`/`fireRoutine`/`upsertRoutine`/`setRoutineActive`/`deleteRoutine` + the injected `computeNextFireAt` seam (*keep*), `pending_events` (the dormant role-dispatch hop — *retire/replace*). DBOS recipe: `lib/dbos/periodic-workflows.ts` + `bootstrap.ts` + `dbos-flags.ts`.
- **Git plumbing to reuse:** async `RunGit` (`git-export/git-committer.ts:29`), `getConflictedFiles()` (`auto-rebase.ts:142`), `buildRebaseConflictEscalation`/`composeStashBranchRef` (`sync-with-main-types.ts:176,190`), `writeEscalation()` (`auto-rebase.ts:159`), `projectDirForSlug` (`operator-notes.ts:62`).
- **Roles:** `AGENT_ROLES` (`role-config.ts:24`) compile-time list; personas at `libs/papercusp/packages/harness/prompts/<role>.md`; `buildRoleLaunchSpec` (`role-launch-spec.ts:85`) optional `featureId` + `extras`; `launchAgent` (`launch-agent.ts:47`).
- **Submodules:** no existing commit+push+bump automation — new. `libs-papercusp-submodule` lock (locks `007-*.sql`) currently only serializes the manual process.
- **Migrations:** next DB migration `115-*`; next locks migration `008-*` (`papercusp_su`).

## Phase 1 — Revive the routines engine on DBOS (the generic substrate)

- **P-001** `done` `routinesTick` DBOS scheduled workflow (`lib/dbos/routines-workflow.ts`, `registerScheduled({ crontab: '*/30 * * * * *' })`) **replacing the dead in-process `routine-ticker` loop**. Each tick: `listDueCronRoutines(sql)` → dispatch each by target (P-002) → advance `next_fire_at` via the injected `computeNextFireAt` (cron-parser/croner) — all as durable `DBOS.runStep`s with retry/recovery. Gate `dbosRoutinesActive()` in `dbos-flags.ts` (default-on under the orchestrator gate; env `PAPERCUSP_DBOS_ROUTINES`); register in `bootstrap.ts`. Skip-missed; per-routine dedup so one routine can't double-fire. (M) (routinesTick workflow + claim + dedup queue + cron helper; unit-tested, typecheck clean)
- **P-002** `done` Generalize a routine's **target** into two kinds, keyed off `target_role`: an **agent role** (existing) or a reserved **`system:<action>`** (new). Add a handler registry (`registerSystemAction(name, fn)`); the tick runs `system:` actions **inline as durable steps**, and dispatches role routines **directly** via `buildRoleLaunchSpec` + `launchAgent`. The dormant `routines → pending_events → consumer` hop is **retired** (no dead infra). The `system:` prefix needs no migration — `target_role` stays an opaque dispatch key. (M) (system:&lt;action&gt; dispatch + registry done; pending_events hop retired; agent-role-spawn half lands in P-012) (system:&lt;action&gt; inline + agent-role routines spawned via invoke route; pending_events hop retired)
- **P-003** `wip` Routines config surface: ensure `upsertRoutine`/`listDueCronRoutines`/`setRoutineActive`/`deleteRoutine` work against the live engine; add `system:`-action conveniences + a `routines:list` / `routines:set` agent-tool surface so per-harness schedules are editable as ordinary harness config (the "generalize as harness config" ask). (S) (helper done git-sync-routine.ts: get/upsert/setActive. routines:list/set MCP agent tools deferred — thin wrapper over the helper, lowest-urgency go-live held; schedules editable via the helper/SQL meanwhile. Follow-up.)
- **P-004** `done` Decommission the dead `routine-ticker` `setTimeout` loop (keep the `listDueCronRoutines`/`fireRoutine` primitives the DBOS tick reuses; drop the loop + the `pending_events` dispatch assumptions). First confirm nothing else still drives it (standalone harness CLI / substrate service); pre-alpha → delete, don't shim. Cross-ref consolidation D-006. (S) (deleted dead routine-ticker loop submodule e899ef1, pointer a12d79b2d; confirmed zero callers; kept listDueCronRoutines/fireRoutine)

## Phase 2 — git-sync as the first `system:` action (the pipeline)

- **P-005** `done` Register the `system:git-sync` handler `runGitSync(slug, cfg)` (`lib/harness/git-sync/run-git-sync.ts`): resolve repo path via `projectDirForSlug(slug)`; async git runner (reuse `RunGit`); detect dirty state; structured `GitSyncOutcome` (`synced`|`conflict`|`nothing`|`error`) recorded to routine `metadata` (`last_synced_at`, `last_status`, `head_sha`). Config from the routine's `trigger_config` (`{ cron, push, push_submodules, merge_strategy }`). (M) (run-git-sync.ts pipeline scaffold + GitSyncOutcome; real-git tested)
- **P-006** `done` Commit step: `git add -A` + `git commit --no-verify` the superproject **and each submodule** (`libs/papercusp`, `libs/papercup-shared`) when dirty — skip clean ones. Serialize the index with the per-process git mutex + the resource lock (P-009). (M) (whole-tree commit superproject + dirty submodules; cross-run serialization via routine dedup, resource lock in P-009)
- **P-007** `done` Submodule push FIRST (D-003): for each dirty/ahead submodule `git -C <sub> push origin HEAD:<branch>` (handle detached HEAD via the tracked branch), THEN `git add <sub>` so the bumped pointer is committed. A fresh clone of pushed `main` resolves its pins. (M) (submodule commit+push-first then pointer bump; ordering coded, real submodule-push test in P-016)
- **P-008** `done` Sync step: `git fetch origin main`; `git merge --no-edit origin/main` (merge, not rebase — D-002); on success `git push origin HEAD:main`. On non-fast-forward rejection re-fetch + re-merge once, else treat as conflict. (M) (fetch+merge --no-edit+push HEAD:main, non-ff re-merge once, conflict→abort clean; tested)
- **P-009** `done` Locks: register a `git-sync` resource (locks `008-*.sql`); the handler holds `exclusive(git-sync)` for the repo + `exclusive(libs-papercusp-submodule)` across commit→submodule-push→pointer-bump→push, with a short drain so peer edits settle; release broadcasts the new tip. (S) (git-sync + libs-papercusp-submodule exclusive locks across the run; resource registered locks migration 008; held→skip, infra-down→best-effort)

## Phase 3 — Conflict resolution via a merge-resolver agent

- **P-010** `done` On merge conflict: `getConflictedFiles()`, then **`git merge --abort`** (clean tree — agents must never see a conflicted/half-merged tree); write a git-sync escalation into `harness_escalations` (new `kind` alongside the rebase one; reuse the `writeEscalation` + builder pattern); record `last_status='conflict'` + conflicted files. (M) (conflict→merge --abort in pipeline + git-sync-conflict harness_escalations row; cleared on a clean pass)
- **P-011** `done` Add the `merge-resolver` role: append `'merge-resolver'` to `AGENT_ROLES` + persona `libs/papercusp/packages/harness/prompts/merge-resolver.md` (job: fetch + merge `origin/main`, resolve, commit on `main`, leave tree clean; hold the `git-sync` lock during its merge; do NOT push — the next tick pushes). (M) (merge-resolver added to AGENT_ROLES + persona at harness/prompts/merge-resolver.md committed in submodule 80733cb)
- **P-012** `done` Spawn the resolver from the handler via the **same** role-launch path as P-002 (`buildRoleLaunchSpec({ role:'merge-resolver', featureId:null, extras:[conflicted files, escalation ref] })` → `launchAgent`). **Dedup** on the open git-sync escalation (one resolver per harness). Resolver clears the escalation on success → the next tick pushes. (M) (spawnMergeResolver via invoke route, deduped on open git-sync escalation; role-map completeness to confirm in P-016)

## Phase 4 — Cutover: agents stop doing git + the prompt edit

- **P-013** `todo` SU engineer prompt edit (`apps/operator/prompts/papercusp-su-engineer.tools.md`, "Commit every turn; don't push…" block, ~L229): replace with **"You do not commit or push at all — a background git-sync routine owns commit + merge + push end-to-end. Just leave your work in the tree."** Keep "stay on main / never worktree". Mirror into `papercusp-su-power.tools.md` + repo `CLAUDE.md` (the per-turn-commit rule). **Lands only once the system is live — shipping early would tell agents to stop committing before anything commits for them, losing work.** blocked-by: P-001, P-005, P-012 (S)
- **P-014** `todo` Revert the "submodule pins are local-only / don't push without asking" guidance now that auto-push owns it: the `libs-papercusp-submodule` lock description (locks SQL), the SU playbooks, `CLAUDE.md`. (S)
- **P-015** `done` Seed git-sync for `papercup`: upsert a `system:git-sync` routine (interval ~3 min, `push:true`, `push_submodules:true`). Other harnesses opt-in. blocked-by: P-003 (XS) (papercup git-sync routine seeded INACTIVE active=f, cron 0 */3 * * * *, push+push_submodules, ws=papercusp-workspace. Doubly dormant active=false + PAPERCUSP_DBOS_ROUTINES off. Go-live = flip active=true + flag on.)

## Phase 5 — Verify

- **P-016** `wip` Tests: the **engine** (routinesTick fires a due routine once, runs a `system:` action inline, dispatches a role routine, advances `next_fire_at`; crash-replay mid-tick) + the **git-sync pipeline** against a throwaway local origin + submodule fixture (happy path; no-op clean tick; conflict → `merge --abort` → escalation → resolver-spawn stub). Mirror `test/dbos-crash-replay.integration.test.ts`. (M) (DONE: pipeline+submodule real-git 5 tests, engine cron/registry/dispatch unit 4 tests, role-map safety verified clean. DEFERRED to P-017 held, needs live system/test-PG: DBOS-launch tick crash-replay + PG escalation/dedup integration engine reuses the proven registerWorkflow/runStep recipe.)
- **P-017** `todo` Live on `papercup`: enable the routine, make a local edit, confirm one tick commits + pushes superproject **and** a submodule branch to origin (a fresh clone resolves the pins); then push a divergent commit from a second clone and confirm the next tick aborts clean, files the escalation, and spawns one `merge-resolver`. blocked-by: P-012, P-015 (S)

## Decisions

### D-001 — Substrate: revive the routines engine under DBOS (Fate 1); git-sync is its first system action
Date: 2026-06-03 (avi)
DBOS provides durable execution + *static-at-boot* cron (`registerScheduled`) + delayed enqueue + queues, but **not** a runtime-editable, per-tenant schedule registry. That registry is exactly what `harness_shared.routines` already is. Its only weak part is the engine — the dead in-process `routine-ticker` `setTimeout` loop. So we **keep the registry + per-job policies, replace the loop with a DBOS `routinesTick` workflow (durable), and generalize a routine's target to agent-role-spawn OR `system:<action>`**. git-sync is the first `system:` action; future per-harness scheduled tasks reuse the engine. This **supersedes the earlier option C** (a bespoke `gitSyncTick` reading routines as config-only): reviving the engine generically is barely more work, yields one reusable engine, and retires the dormant `pending_events` path instead of leaving dead infra. Options A (bespoke config table; doesn't generalize) and B (drive the dead loop as-is; not durable) are rejected; pg-boss/BullMQ stay rejected (prior DBOS plan D-001). The sibling consolidation plan's D-006 records this as routine-ticker's disposition (revive, implemented here in Phase 1).

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
The per-turn "commit every turn; don't push" rule is replaced: agents do no git at all. The prompt change (P-013) ships only once the system is live, so there's never a window where agents stop committing before the system commits for them.

### D-006 — Dispatch model + schedule format
Date: 2026-06-03
A routine's `target_role` is generalized into two dispatch kinds **without a schema change**: an **agent role** (spawned via `buildRoleLaunchSpec` + `launchAgent`) or a reserved **`system:<action>`** (run inline as a durable DBOS step via a `registerSystemAction` registry). The dormant `routines → pending_events → consumer` indirection is **retired** — the DBOS tick dispatches directly, so there's no dead queue to drain. **Cron stays the schedule format** (DBOS speaks crontab natively); the next-fire calculator stays pluggable behind the existing `computeNextFireAt` seam (cron-parser/croner now; `rrule` only if calendar-grade recurrence — nth-weekday, until-dates — is ever needed, stored as `{rrule}` vs `{cron}` in `trigger_config`). No second scheduler library is adopted (D-001).
