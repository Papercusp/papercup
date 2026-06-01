---
title: Un-hardcode the Harness System — Tracking Doc
slug: un-hardcode-plan-2026-05-10
status: active
created: 2026-05-10
updated: 2026-06-01
owner: pandawamble@gmail.com
---

## Now

**State:** Two distinct goals. (1) **Un-hardcoding** (no hardcoded harness slugs/paths in code) — effectively MET (a `project_un_hardcode_arc_complete` marker exists). (2) **Full table-consolidation** (drop the per-harness schema model; move all 11 per-harness tables to `harness_slug`-partitioned consolidated tables) — only PARTIAL: `harness_features_consolidated`, `harness_issues_consolidated`, `harness_snapshots_consolidated` exist, but `libs/papercusp/libs/db/sql/002-per-harness-template.sql` STILL scaffolds 11 per-harness tables (agent_runs, feature_audit, agent_chats, messages, supervisor_notes, …) and `bin/scaffold-harness-schema.sh` is still the live scaffolding path. The system runs a HYBRID: 3 consolidated + 8 still per-harness. Phase 1's remaining verticals, items 12–13 (drop the per-harness model), and Phase 4 (ESLint rule / e2e / docs) are unshipped and parked since 2026-05.

**Next:** Owner decision — either (a) resume full consolidation (the 8 remaining per-harness tables → consolidated, then drop the per-harness template), a large migration with no current driver, OR (b) accept the hybrid as the end state and mark this shipped. The hardcoded-slug goal itself is already met.

## Goal

A new harness installed via template registers in the DB and *every* surface (Zero subscriptions, dashboards, schemas, sweepers, watchers, prompts, plugins) picks it up — zero code changes required. No hardcoded slug lists. No hardcoded paths. No "edit this TypeScript and restart" steps.

## Decisions (locked in)

- **D1**: Per-harness schemas → single shared schema with `harness_slug` partition column. (Option A.)
- **D2**: PG canonical for text/structured state; FS for blobs (logs, snapshots, worktrees, screenshots). SPEC.md bidirectional. (Option C.)
- **D3**: Slug ↔ schema-name translation locked into one helper; ESLint rule bans inline `harness_${slug}` concat.

## Backup before starting

- `~/papercusp-archive/20260507-024517-pre-unhardcode/`
  - `papercusp.dump` (PG dump, 1MB)
  - `sheets-clone.tar.gz` (live FS state, 140MB)
  - `registry.json` (registry snapshot)
  - `state-snapshot.txt` (counts: 92 features, 71 issues, 262 agent_runs in sheets)

Restore: `pg_restore -d papercusp --clean --no-owner papercusp.dump`

## Approach: vertical slices, not horizontal

Going to migrate one artifact type at a time, end-to-end (DB → writer → Zero → dashboard), prove it works, then repeat the pattern. This way every commit leaves the system runnable and the rollback is bounded.

## Phase 1 — Per-table verticals (target ~1 week wall-time)

For each artifact, the steps are identical:

1. **Add columns** to `harness_shared.<table>` (which usually already exists as a consolidated mirror) so it's the canonical store, not a mirror copy.
2. **Stop the trigger** that mirrors from per-harness → consolidated; flip writes to go directly to the shared table.
3. **Update writer endpoints** in `apps/operator/app/api/_hono/harness.ts` to write to `harness_shared.<table>` directly.
4. **Update Zero schema** to expose ONE `<table>.bySlug` query reading from the shared table.
5. **Update dashboard panels** to use the new query (drop `slugTo<X>Key` indirection).
6. **Drop the per-harness `<table>` from per-schema templates** (next install won't create them).
7. **Cleanup migration** (separate later) drops the per-harness columns/tables once nothing reads them.

### Order

1. ⬜ `harness_features` (highest-impact — drives feature queue)
2. ⬜ `harness_issues`
3. ⬜ `agent_runs`
4. ⬜ `harness_snapshots`
5. ⬜ `agent_chats`
6. ⬜ `feature_audit`
7. ⬜ `messages`
8. ⬜ `supervisor_notes`
9. ⬜ `directive_summaries`
10. ⬜ `executed_actions`
11. ⬜ `config_token`

### After all 11 verticals are done

12. ⬜ Drop the per-harness schema model entirely (drop `bin/scaffold-harness-schema.sh`, drop `regenerate-harness-features-view.sh`, drop the per-harness template).
13. ⬜ Update the `embedded-postgres-server` to no longer pre-provision per-harness schemas.

## Phase 2 — Filesystem state into PG

Each in its own commit. Pattern adopted: **PG-canonical with file-mirror via dual-write** (the autonomous worker reads files per role-prompt, so the file can't be dropped — instead it becomes a derived mirror written on every operator-side save). Documented in `apps/operator/content/docs/system/storage-policy.mdx`.

- ✅ `brainstorm.md`, `brainstorm.canvas.json`, `brainstorm.mindmap.json` — Migration 033 (`harness_brainstorm`); operator UI dual-writes
- ✅ `plan-review.md` — Migration in `harness_plan_review`; fs-watcher mirrors disk → PG; reader converted (`8b11e03`)
- ✅ `escalation.md` — Migration 035 (`harness_text_artifacts`); operator dual-writes via `lib/text-artifacts.ts`
- ✅ `memory/raw.md`, `memory/summary.md`, `memory/MEMORY.md` — Migration 035; same dual-write
- ✅ `validation-contract.md` — Migration 034 (`harness_project_files.contract`); operator dual-writes
- ✅ `issues.md` — Migration 035; dual-write fixed in `70bc9a5` (round 18)
- ✅ `pending-issues.jsonl` — `harness_pending_issues` populated by fs-watcher; reader converted + id synthesis aligned (`8223287`)
- ✅ `config.json` — Migration 034 (`harness_project_files.config`); operator dual-writes
- ✅ `identity/<role>.md` — partial migration shipped (`52a05de`): Migration 041 + fs-watcher (`identity-files-watcher.ts`) keeps `harness_shared.identity_files` synced. Operator UI reads PG; orchestrator subprocess still reads files at `prompt-build.ts:87`. Full PG-canonical (orchestrator reads PG too) blocked on substrate-side change to `libs/papercusp/packages/orchestrator`.
- ✅ `SPEC.md` — Migration 034 (`harness_project_files.spec`); bidirectional handled by writes through `saveProjectFiles` + fs-watcher reverse-sync

## Phase 3 — Hardcoded paths cleanup (after Phases 1-2)

- ✅ `cwd: '/home/marsh-office/Restart'` in `harness.ts:686,697` — already removed (lines now contain different code; no `/home/marsh-office/Restart` literal in `harness.ts`)
- ✅ `'/home/marsh-office/Restart'` fallback in `execute-action.ts:615` — already removed
- N/A `~/.restart-org/secrets/` in mobile build scripts — kept as graceful fallback in `bin/build-mobile.sh`, `store-submit.sh`, `install-mobile-toolchain.sh`. Primary is `$HOME/.papercusp/secrets/`; legacy path is honored only when the new one is missing. By-design backward-compat shim, not a hardcoded primary.
- N/A `~/.restart-harness-projects.json` reads in run.sh + main-loop.ts — workspace registry is primary; this path is the legacy fallback for pre-workspace harnesses. Cache-key sig in `harness.ts` updated to also include the workspace-registry mtime so cache busts on workspace-registry edits.
- ✅ `DEPARTMENT_SLUGS` const in `DocumentationFrame.tsx` — already removed (comment at L21: "no compile-time list of departments")
- N/A Marketplace fallback catalog hardcodes — by definition the fallback for when both PG and the marketplace API are unreachable. Cannot live in PG; small (2 items) and intentional.

## Phase 4 — Codify (1 day)

- ⬜ ESLint rule banning `harness_${...}` interpolation, hardcoded harness slug literals
- ⬜ E2E test: install fake template via API → all dashboard panels work for the new slug without restart
- ⬜ `/docs/system/lifecycle.mdx`: "How to add a harness" → just call the install API

## Progress log

(Updates appended here as I go.)

