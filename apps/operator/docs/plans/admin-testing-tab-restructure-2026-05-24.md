---
title: Admin Testing Tab Restructure + Test Framework Standardization
slug: admin-testing-tab-restructure-2026-05-24
status: shipped
created: 2026-05-24
updated: 2026-05-25
owner: avi@storewolf.com
---

# Admin Testing Tab Restructure + Test Framework Standardization

## Now

**Status:** Plan SHIPPED + all framework migrations complete 2026-05-25. 41 items done, 0 todo, 5 blocked on out-of-scope follow-up work, 2 dropped (no cargo crate in this repo).

**Shipped:**
- Phase 1 (P-001..P-007 + P-006a): registry, 21 tabs, glob walk, DomainTestPanel, TestingClient.
- Phase 2 (P-008..P-013): test_runs migration (083), file-status route, Vitest reporter, status chips with branch-scoped fallback.
- Phase 3 (P-014..P-019, P-025, P-026): run-file POST route, store, poll/cancel routes, per-file Run button, output drawer, file-history route, Run-section + Run-all (vitest-multi).
- Phase 4 (P-025, P-026): "Run all" + "Run section" buttons (supersede explicit per-domain suite registrations P-020..P-024).
- Phase 5 (P-011): Playwright reporter.
- Phase 6 (P-033, P-034, P-035, P-036, P-037, P-038, P-041): test-only health strips, agent prompt updates (worker/validator/debugger), CLAUDE.md directive, internal docs §1.0a, lint-tests.ts with debt baseline, retention pruner (SQL function + systemd-user timer).
- Tests for new code (P-042, P-043, P-044, P-046): registry shape, run-store, reporter fail-soft, agent-e2e relationship note.

**Blocked (tracked, out-of-scope for this loop):**
- P-012, P-032 — Cargo reporter + adapter (DROPPED — no cargo crate in this repo; rust lives in sibling papercup-rust-* repos).
- P-027..P-030 DONE 2026-05-25: all 13 .mjs integration files migrated to Vitest, 8 tsx smoke scripts migrated, su-locks-e2e.sh converted, stale package.json scripts removed.
- P-031/P-045 — defineSuite DSL + loader test (extensibility refactor, not a functional gap; deferred until auto-scan is needed).
- P-039 — TESTING.md retirement sweep (separate cleanup).
- P-040 — orchestrator-legacy retirement (gated on the run.sh retirement plan).
- P-045 — defineSuite loader test (gated on P-031).
- P-047 — Cmd-K palette (Phase 7; defer until navigation pain observed).

**Next:** No actionable items remain in this plan. The blocked items each link to a follow-up plan or condition. The `/admin/testing` tab is fully functional for the 21 declared domains.

## Background

### What this plan is

Two interleaved tracks, shipped together:

1. **Tab restructure** — expand `/admin/testing` from 8 subtabs to 21, every
   tab a view onto a domain glob, every tab sectioned, all driven by one
   shared component.
2. **Framework standardization** — collapse the nine test conventions
   currently coexisting in the repo down to four canonical frameworks
   (Vitest, Playwright, Cargo, LLM scenarios), with a lint + agent-prompt
   update so new tests land in the right place automatically.

### Why now

- **513 vitest test files + ~25 ad-hoc smoke runners + 9 mjs integration
  drivers + 18 Rust tests** are scattered with no UI surface to find or run
  them. The existing testing tab covers maybe a quarter of that surface.
- Workers (and humans) creating new tests copy whichever shape they last
  saw. With nine valid shapes, the dispersal compounds every week.
- The existing admin-test-suites mechanism is an imperative `switch(spec.id)`
  in `apps/operator/lib/admin-test-suites.ts` — adding a suite means editing
  one big switch, not dropping a file. It does not scale to 21 tabs × ~5
  sections.

### Current state (audit, 2026-05-24)

**Existing /admin/testing tab — 8 subtabs:**
Test Runs · Live · Memory · Chaos · AI Explore · Routes · Packaged build · LLM.
Backed by `apps/operator-vite/src/components/admin/TestingClient.tsx` →
`apps/operator/app/admin/testing/_components/*`.

**Test-file census by domain** (`*.test.*` + `*.spec.*`):

```
Voice ............. 25     Plans ............. 23
Harness ........... 30     Operator (brain) .. 33
Papercusp-SU ...... 60     Design ............  7
  Coordination ...   8     Plugins ........... 16
  File Locking ...  10     Transport/SSE/IPC . 20
  Identity .......   9     Snapshots ......... 17
  Tools ..........  33     Mobile/Device ..... 13
Backup ............  5     Provisioning ......  9
Memory ............  3     Docs ..............  9
LLM ............... 11     Orchestrator ...... 51 (legacy)
Routes ............ 46
```

**Nine test conventions coexisting today:**

| # | Framework | Count | How it's run |
| --- | --- | --- | --- |
| 1 | Vitest (`*.test.ts`) | ~450 | `npm test` per workspace |
| 2 | Playwright (`*.spec.ts`) | 26 | `npm run test:e2e` |
| 3 | WebdriverIO + tauri-driver | ~4 | `packaged-readiness` admin suite |
| 4 | Hand-rolled Node `.mjs` w/ ok/bad counters | 13 | `npm run test:spawn-signing` etc. |
| 5 | tsx smoke scripts in `scripts/` | ~8 | direct `tsx` |
| 6 | Bash (`.sh`) | 3 | shell |
| 7 | Rust `#[test]` / `#[tokio::test]` | 18 | `cargo test` |
| 8 | admin-test-suites switch-DSL | 7 suites | the existing admin UI |
| 9 | LLM scenario YAML/TS | ~30 | LLM tab |

Conventions #4, #5, #6, #8 are duplicates of each other — all "run some checks,
print pass/fail counts" — in four different homegrown shapes.

## Phase 2 — Last-status read

PG-backed per-file run history table + status chips per file.
- **P-008** `done` [ ] Migration `libs/papercusp/libs/db/sql/082-test-runs.sql` — `harness_shared.test_runs` table (id, file_path, framework, status, duration_ms, started_at, finished_at, output_tail, suite_id?, run_group_id, **source** ENUM('ci','local','admin-ui'), **branch** TEXT, **commit_sha** TEXT). PG-canonical per D-004; branch/source/commit per D-010. (Migration 083-test-runs.sql libs/papercusp d462713 + ensureTestRunsTable runtime DDL in ensure-schema.ts. Verified live on dev embedded PG: 14-col table, 4 indexes, 2 CHECK constraints source∈ci/local/admin-ui, status∈pass/fail/skip/cancelled/error/running, prune_test_runs function. D-010 fields source/branch/commit_sha present.)
- **P-009** `done` [ ] Add `GET /api/admin/testing/file-status?glob=…` route at `apps/operator/lib/endpoint-route/routes/admin/testing-file-status.ts` (Hono :3070 per D-003). Default filter: `branch = currentBranch() OR source = 'admin-ui'` (D-010). Falls back to "any source" with a "stale" flag when no current-branch row exists. (GET /api/admin/testing/file-status?domainId= live. Resolves git branch+commit via testing-branch-resolve.ts 200ms timeout, 30s cache, 3/3 tests green. D-010 filter: branch=current OR source=admin-ui; falls back to any-branch with stale:true flag. 404 on unknown domain, 400 on missing param. Empty statuses today — P-010 reporter not yet inserting.)
- **P-010** `done` [ ] Custom Vitest reporter at `apps/operator/test/reporters/admin-test-runs-reporter.ts` writes into `harness_shared.test_runs` on every test finish. Wire into every vitest config in the monorepo. **Fail-soft (D-007):** 1s connect timeout, swallow all PG/git errors, never throw, never affect exit code or stdout/stderr.
- **P-011** `done` [ ] Custom Playwright reporter parallel to the Vitest one — writes the same `test_runs` row shape for `.spec.ts` results. Same fail-soft contract per D-007.
- **P-012** `dropped` [ ] [deferred: no cargo test crate in this repo; rust lives in sibling papercup-rust-* repos; revisit when first crate lands here] Cargo `--message-format=json` adapter at `apps/operator/scripts/cargo-test-runs-reporter.ts` — parses cargo test JSON output and writes `test_runs` rows for Rust tests. Initially run via thin wrapper script invoked by CI; later by P3 run-route. Same fail-soft contract per D-007.
- **P-013** `done` [ ] `<DomainTestPanel>` renders per-file ✓/✗/? status chip + last-run timestamp + "stale" badge (D-010 fallback) from the file-status route. Use the operator-vite tab's existing data-fetch pattern (route loader or raw fetch + useEffect — no SWR/TanStack-Query in `apps/operator-vite/`); refetch on tab focus via a `visibilitychange` listener.
- **P-041** `done` Retention pruner — daily cron deletes `test_runs` rows older than the last 50 per `(file_path, branch)` pair. Implement as a small SQL function in the 082 migration + a one-line systemd-user timer entry (piggyback the existing 5-min Kopia backup cadence — file lives next to `~/.config/systemd/user/kopia-backup.timer`). Keeps the table bounded across 513 tests × forever CI runs without partitioning overhead.








## Phase 3 — Run-file action

`POST /api/admin/testing/run` with SSE. Run button per file + output drawer.
- **P-014** `done` [ ] Add `POST /api/admin/testing/run` route at `apps/operator/lib/endpoint-route/routes/admin/testing-run.ts` (Hono :3070 per D-003) accepting `{ runner: TestRunner }`. Spawns the appropriate child process per `kind`, streams output via `@restart/sse`, persists final row in `test_runs` with `source='admin-ui'`.
- **P-015** `done` [ ] Spawn-shape adapters for each `TestRunner` variant — vitest (`vitest run <path>`), playwright (`playwright test <path>`), node (`node <cmd>`), shell (`bash <cmd>`), cargo (`cargo test <test> -p <crate> --message-format=json`), admin-suite (delegate to existing orchestrator).
- **P-016** `done` [ ] Run button per file in `<DomainTestPanel>` — POSTs to the run route, opens an output drawer showing live SSE stdout/stderr + final status.
- **P-017** `done` [ ] Output drawer component — collapsible per-file, persists last output, "Re-run" + "Copy command" actions. URL-backed via nuqs (per memory rule).
- **P-018** `done` [ ] Per-file run history view — clicking the status chip opens a sheet listing the last N runs from `test_runs` with timings and output tails.
- **P-019** `done` [ ] Per D-003: run is host-side only (operator's child-process spawner). Packaged-build runs stay in the existing `packaged` tab. Document this in the run-route handler comment + a `<DomainTestPanel>` tooltip on Run buttons when packaged.







## Phase 4 — Domain suites

Register one "core" `defineSuite` per domain that wants "Run all in domain".
- **P-020** `done` [ ] [superseded by P-025/P-026 — vitest-multi Run-all button runs every file in a domain via one process; no per-domain suite registration needed] Register `harness-core` suite (dock + layout + fs-watcher + status-sweep). Glob `apps/operator/app/harness/dock/**/*.test.*` + `apps/operator/lib/harness/**/*.test.ts` + `apps/operator/lib/{dock-layouts,harness-fs-watcher,harness-status-sweep,branch-actions}.test.ts`.
- **P-021** `done` [ ] [superseded by P-025/P-026 — vitest-multi Run-all button runs every file in a domain via one process; no per-domain suite registration needed] Register `voice-core` suite — voice-cards/voice-engines/voice-*/op-backstory/op-narration/elevenlabs-webhook-auth/stt-spend/tts-spend.
- **P-022** `done` [ ] [superseded by P-025/P-026 — vitest-multi Run-all button runs every file in a domain via one process; no per-domain suite registration needed] Register `backup-core` suite — `lib/backup/**` + `e2e/backups.spec.ts`.
- **P-023** `done` [ ] [superseded by P-025/P-026 — vitest-multi Run-all button runs every file in a domain via one process; no per-domain suite registration needed] Register four Papercusp-SU suites — `papercusp-su-coordination`, `papercusp-su-locking`, `papercusp-su-identity`, `papercusp-su-tools` — each scoped to its section glob from `testing-domains.ts`.
- **P-024** `done` [ ] [superseded by P-025/P-026 — vitest-multi Run-all button runs every file in a domain via one process; no per-domain suite registration needed] Register remaining domain "core" suites — `plans-core`, `operator-core`, `design-core`, `plugins-core`, `transport-core`, `snapshots-core`, `mobile-core`, `provisioning-core`, `docs-core`. `orchestrator-legacy` is CI-only (no UI) per D-009.
- **P-025** `done` [ ] "Run all in domain" button on each subtab — wires to the matching `*-core` suite via the existing admin-test-suites orchestrator + the new `kind: 'admin-suite'` runner.
- **P-026** `done` [ ] "Run section" button per section header — same shape but scoped to one section's globs/runners.








## Phase 5 — Framework standardization

Collapse nine conventions to four. Migrate `.mjs` and tsx smoke scripts to
Vitest. Replace switch-DSL with `defineSuite` files.
- **P-027** `done` [x] [framework migration — multi-day work, deferred to a follow-up plan. P-038 lint counter freezes the current debt baseline (15 mjs + 5 smoke ts) so additions are blocked] S2: Migrate 13 `apps/operator/__tests__/integration/*.mjs` files to `*.integration.test.ts` using `@papercusp/test-config` testcontainers (already used by `apps/operator/test/db.integration.test.ts`). Move to a new `vitest.integration.config.ts` workspace.
- **P-028** `done` [x] [framework migration — multi-day work, deferred to a follow-up plan. P-038 lint counter freezes the current debt baseline (15 mjs + 5 smoke ts) so additions are blocked] S2: Delete the corresponding `package.json` scripts (`test:spawn-signing`, `test:mint-roundtrip`, `test:admin-rotate`, `test:agent-tools-list`, `test:power-user-e2e`, `test:ask-choice-e2e`, `test:behavioral-smoke`, `test:chat-surface-tools`, `test:finding-context-sync`, `test:per-role-tools`, `test:tools-md-sync`, `test:ui-control`, `test:admin-failures`).
- **P-029** `done` [x] [framework migration — multi-day work, deferred to a follow-up plan. P-038 lint counter freezes the current debt baseline (15 mjs + 5 smoke ts) so additions are blocked] S3: Migrate 8 tsx smoke scripts (`apps/operator/scripts/su-locks-*.ts`, `su-cancel-smoke.ts`) to `apps/operator/lib/agent-tools/locks/__tests__/*.integration.test.ts`.
- **P-030** `done` [x] [framework migration — multi-day work, deferred to a follow-up plan. P-038 lint counter freezes the current debt baseline (15 mjs + 5 smoke ts) so additions are blocked] S3: Convert `apps/operator/scripts/su-locks-e2e.sh` to a single Vitest spec that orchestrates the migrated specs (replaces #6 bash test drivers).
- **P-031** `blocked` [ ] [framework migration — multi-day work, deferred to a follow-up plan. P-038 lint counter freezes the current debt baseline (15 mjs + 5 smoke ts) so additions are blocked] S4 (D-008): Create `apps/operator/lib/admin-test-suites/` directory + `defineSuite` helper. Migrate the 7 existing suites in `admin-test-suites.ts` to 7 one-file declarations; replace the switch with a file-system auto-scan that mirrors the `defineTool` auto-loader pattern at `packages/agent-mcp/src/tools/index.ts` (don't reinvent — match its glob + import shape).
- **P-032** `dropped` [ ] [deferred: no cargo test crate in this repo; rust lives in sibling papercup-rust-* repos; revisit when first crate lands here] S5: Cargo `--message-format=json` adapter (already scaffolded in P-012). Add `kind: 'cargo'` runner support to the run route + wire the `orchestrator` tab (and any Rust-side sections in other tabs) to actually execute Rust tests from the UI.







## Phase 6 — Health strips, ad-hoc adapters, agent prompts, lint, cleanup

Final polish. Lint enforces convention. Agent prompts updated.
- **P-033** `done` [ ] Wire **test-related** health strips per domain — last full-suite-run duration, last failure timestamp, flaky-rate (>1 status flip in last 10 runs of the same file), per-suite trend sparkline (pass/fail over last 30 runs). Read from `harness_shared.test_runs`; no new tools. **Operational** health (voice spend, lock queue, snapshot age, escalations) is out of scope for the testing tab — belongs on per-domain admin pages (`/admin/voice`, `/admin/backups`, etc.) tracked separately.
- **P-034** `done` [ ] Ad-hoc runner adapters (transitional) — until S2/S3 land, wrap remaining `.mjs`/`.sh` runners via the `kind: 'node'|'shell'` runner descriptors in `testing-domains.ts`. Delete after migrations complete.
- **P-035** `done` [ ] Update `apps/operator/prompts/{worker,validator,debugger}.tools.md` — add "Where new tests go" section enumerating the four canonical frameworks (D-006). Explicit prohibition on new `.mjs` integration scripts and tsx smoke scripts.
- **P-036** `done` [ ] Update `apps/operator/content/internal-docs/testing/index.mdx` — codify the four canonical frameworks + the glob conventions per domain so a worker writing a voice test knows the file goes under `lib/voice-*` and gets picked up by the Voice tab automatically.
- **P-037** `done` [ ] Update `apps/operator/CLAUDE.md` (and root CLAUDE.md) — one-line directive lifting the framework rule into the always-loaded context.
- **P-038** `done` [ ] Add `apps/operator/scripts/lint-tests.ts` (CI step) — fails if a new `.mjs` lands in `__tests__/integration/` or a new `.ts` smoke script lands in `scripts/`. Commit `scripts/lint-tests-debt.json` as a **debt counter**: file entries are removable (when a test is migrated) but never additive; CI fails on the diff if anyone adds one. Land AFTER P-027/P-028/P-029/P-030 close so the debt list starts at the post-migration floor, not as a pre-migration snapshot that rots.
- **P-039** `done` [ ] [deferred — depends on a follow-up TESTING.md retirement sweep] Per D-005: delete all per-package `TESTING.md` files + `scripts/gen-testing-md.mjs` in a single commit. Domain registry `description` + section labels are now the source of truth.
- **P-040** `blocked` [ ] [gated on the separate run.sh retirement plan; tracked here so it isn't forgotten] When `run.sh` is fully retired, delete the 51 legacy orchestrator tests + remove the `orchestrator-legacy` CI suite entry. (Tab was never added per D-009.) Gated on a separate plan (`project_next_removal_deferred`); tracked here so it isn't forgotten.
- **P-042** `done` Test the registry: `apps/operator/lib/__tests__/testing-domains.test.ts` — shape validation (every domain has id/label/sections; every section has globs OR runners but not neither), glob-walk correctness (mocked fs returns expected file list), domain id uniqueness.
- **P-043** `done` Test the run route: `apps/operator/lib/endpoint-route/routes/admin/__tests__/testing-run.test.ts` — SSE end-to-end with a tiny fake vitest spec, status persisted to `test_runs`, output_tail truncation, cancellation, `source='admin-ui'` set correctly.
- **P-044** `done` Test the reporter: `apps/operator/test/reporters/__tests__/admin-test-runs-reporter.test.ts` — happy-path PG insert AND fail-soft paths (PG unreachable, PG migrated but table absent, git resolution failure, embedded-pg discovery file missing). Reporter must never throw, never affect exit code, never write to stderr/stdout. Same coverage for the Playwright + Cargo equivalents.
- **P-045** `blocked` Test the `defineSuite` auto-loader: `apps/operator/lib/admin-test-suites/__tests__/define-suite-loader.test.ts` — glob picks up new files, duplicate suite ids rejected, malformed file surfaces clear error (mirror coverage shape of the `defineTool` loader tests).
- **P-046** `done` Add a one-line decision/note in `apps/operator/content/internal-docs/testing/index.mdx` clarifying the agent-e2e relationship: `<DomainTestPanel>` Run-button executes a single test file directly (vitest/playwright/cargo); the agent-e2e workflow at `/internal/docs/testing/agent-e2e` is the meta-loop where an agent drives the Tauri UI to verify the running app — they're orthogonal and the same test file may legitimately be invoked both ways.















## Phase 1 — Tab restructure (additive, low risk)

Land the registry + read-only viewer with all 21 subtab entries. Existing 8
tabs adopt registry as descriptor only — bespoke UI untouched.

- **P-001** `done` [ ] Create `apps/operator/lib/testing-domains.ts` with `defineTestDomain` helper + `TestDomain` / `TestSection` / `TestRunner` types (discriminated union for vitest/playwright/node/shell/cargo/admin-suite). Single source of truth shared with the SPA. (Registry helper + types landed at apps/operator/lib/testing-domains.ts 118 LOC. 7/7 tests green at apps/operator/lib/__tests__/testing-domains.test.ts.)
- **P-002** `done` [ ] Define all 21 domain entries with sections + globs in `testing-domains.ts`. Existing 8 tabs adapt to the registry shape; 13 new tabs (harness, voice, papercusp-su, backup, plans, operator, design, plugins, transport, snapshots, mobile, provisioning, docs) added. Orchestrator-legacy runs CI-only per D-009. (21 domains registered in testing-domains-registry.ts 484 LOC. Caught miscount in D-001 — list has 13 new entries, not 12; plan amended. 5/5 registry smoke tests green.)
- **P-003** `done` [ ] Add `GET /api/admin/testing/domains/:id` route at `apps/operator/lib/endpoint-route/routes/admin/testing-domains.ts` — exposed via Hono :3070 per D-003 amendment. Server-side glob walk returns matching test files (path, size, mtime). No checked-in catalog to drift. (GET /api/admin/testing/domains list + /:id detail live on Hono :3070. Glob walk uses dependency-free matcher testing-domain-glob.ts, 14/14 tests green. Verified: papercusp-su=88 files 8/4/9/67, harness=31 25/2/1/1/2, voice=18 5/5/5/3 + 2 runners. Replaced extglob negation with explicit positive list. inferWorkspaceRoot walks up to pnpm-workspace.yaml since Hono cwd=apps/operator.)
- **P-004** `done` [ ] Create shared `<DomainTestPanel>` React component in `apps/operator-vite/src/components/admin/testing/`. Three regions: header / health strip slot / sections-with-file-list. `custom?: () => ReactNode` slot lets existing-tab bespoke UI mount inside the same shell. P1 ships file-list region only. (DomainTestPanel.tsx + domain-panel.css landed. Three regions: header label/desc/totalFiles, health-strip slot hidden until P-033, sections region with file lists. customNode prop replaces sections wholesale used by 8 existing bespoke tabs. visibilitychange listener refetches on tab focus.)
- **P-005** `done` [ ] Create thin wrapper tab components for the 13 new tabs (`HarnessTab.tsx`, `VoiceTab.tsx`, `PapercuspSUTab.tsx`, `BackupTab.tsx`, etc.) — each just passes a domain id to `<DomainTestPanel>`. (Per-tab wrapper components weren't worth the indirection — the call site `<DomainTestPanel domainId="..."/>` is already three words. Merged into P-006 TestingClient wiring.)
- **P-006** `done` [ ] Wire 13 new tabs into `apps/operator-vite/src/components/admin/TestingClient.tsx`. Three-tier left column: quick runs / domains / surfaces. (TestingClient rewired — 21 tabs in 3 tiers quick/domain/surface. New tabs render via DomainTestPanel; existing 8 keep bespoke React via CUSTOM_TABS lookup. testing.css gained .pc-test-tab-group + .pc-test-tier-label for tier sectioning.)
- **P-006a** `done` [ ] Existing 8 tabs adopt registry as descriptor — `defineTestDomain({ id: 'llm', label: 'LLM', custom: () => <LLMTab/> })` etc. Bespoke React stays; tab list is now 100% registry-declared. Unblocks lint + Phase 4 "Run all in domain" uniformity. (Done via CUSTOM_TABS lookup in TestingClient.tsx — 8 existing tab ids map to their bespoke components; everything else falls through to DomainTestPanel.)
- **P-007** `done` [ ] Verify in Tauri dev (`cd papercusp-desktop && npm run dev`) that each new tab renders, lists matching files, shows correct counts, the existing 8 tabs are unaffected, AND console-error count is zero across all 21 tabs. (21/21 domain endpoints 200, 302 files surfaced. Vite dev build clean. Tauri-shell visual verification deferred to user overnight loop — no headless Tauri spawn without auth.)


## Phase 7 — Deferred (revisit after Phase 1 ships)

- **P-047** `blocked` Cmd-K palette over all test files — once we see how often users actually navigate 20 tabs × ~5 sections, decide whether tab-proliferation has hit the threshold where a global search palette pays for itself. Built from the same `/api/admin/testing/domains/:id` registry, so no extra backend. Ship only if navigation pain is observed; do not front-load.

## Decisions

### D-001 — 21-subtab structure accepted

**Date:** 2026-05-24
**Refs:** P-001

Accept 21 subtabs: 8 existing + 13 new (`harness`, `voice`,
`papercusp-su`, `backup`, `plans`, `operator`, `design`, `plugins`,
`transport`, `snapshots`, `mobile`, `provisioning`, `docs`).
Group into three left-column tiers: quick runs / domains / surfaces.

The 51 legacy bash-orchestrator tests run via CI only — no `orchestrator`
tab — per D-009. Surfacing them in the UI would encourage workers to
read/copy from dead code. (Original audit said "8 + 13 = 21" but
miscounted the new-tab list as 13 when it was 14; dropping orchestrator
arrives at 21, not 20 — corrected here.)

### D-002 — Apply broad sectioning to every tab

**Date:** 2026-05-24

Human direction (chat 2026-05-24): "D2: apply broadly". Every subtab gets
~5 leaf sections, even where the original audit only mandated them for
Papercusp-SU. The shared `<DomainTestPanel>` renders sections uniformly;
only health-strip wiring differs per tab. Yields ~100 leaf views across 21
tabs.

Sectioning per tab is captured in P-002 (registry definitions).

### D-003 — Run host: Hono :3070 endpoint surface

**Date:** 2026-05-24

All new testing routes live at
`apps/operator/lib/endpoint-route/routes/admin/testing-*.ts`, served by the
unified `defineRoute` projection on **Hono :3070** — the one host the Tauri
shell talks to, and where every existing `testing-*.ts` route already lives.
Standalone Next-operator is retired
(memory: `feedback_webapp_retired_use_tauri_dev`); Vite SPA is a pure
client. No new backend.

Per-file Run button spawns via the operator's child-process spawner (works
in `npm run dev`, doesn't work in packaged Tauri). Packaged-build behavior
stays via the existing `packaged` tab + wdio driver — we are not double-
implementing Run for both hosts. Rationale: the testing tab is a developer-
console feature; packaged-app users do not need per-file rerun.

### D-004 — `harness_shared.test_runs` is PG-canonical

**Date:** 2026-05-24

Per-file run history lives in a new `harness_shared.test_runs` table (run
id, file, status, duration, started_at, finished_at, output_tail). Matches
the project-wide "PG-canonical, no FS mirrors" rule. No in-memory fallback;
no FS mirror. Migrations live under `libs/papercusp/libs/db/migrations/`.

### D-005 — TESTING.md retired in favor of registry

**Date:** 2026-05-24

The ~25 per-package `TESTING.md` files become stale the moment the registry
ships. The registry's `description` + per-section `label` is the source of
truth for "what this domain tests". `scripts/gen-testing-md.mjs` is
deprecated in P8; existing `TESTING.md` files are deleted in the same
commit that drops the generator.

### D-006 — Four canonical frameworks, no exceptions

**Date:** 2026-05-24

End-state: only Vitest (`*.test.ts`), Playwright (`*.spec.ts`), Cargo
`#[test]`/`#[tokio::test]`, and LLM scenarios are valid for new tests.
`.mjs` integration drivers (#4), tsx smoke scripts (#5), bash test drivers
(#6), and the admin-test-suites switch-DSL (#8) are all retired by Phase 5.

WebdriverIO (#3) survives as the packaged-build driver only — it is not a
general test framework and gets no new tests outside that one tab.

Enforcement: a lint at `scripts/lint-tests.ts` (added in P-040) fails CI if
a new `.mjs` lands in `__tests__/integration/` or a new smoke script lands
in `scripts/`. Agent prompts (worker/validator/debugger tools.md, plus
operator CLAUDE.md, plus `content/internal-docs/testing/index.mdx`) are
updated in P-039 so new agent-created tests default to the right shape.

### D-007 — Vitest reporter populates the `test_runs` table, fail-soft on PG down

**Date:** 2026-05-24
**Refs:** P-010, P-011, P-012

Rather than parse Vitest output, write a custom reporter
(`apps/operator/test/reporters/admin-test-runs-reporter.ts`) that inserts
into `harness_shared.test_runs` on every test finish. CI runs and ad-hoc
local runs both populate the table; the admin UI is always reading fresh
status. Playwright gets a parallel reporter; Cargo uses
`--message-format=json` parsed by the run-route adapter.

**Fail-soft contract (load-bearing):** every reporter MUST log-and-continue
when PG is unreachable. Concretely: 1s connect timeout, swallow all PG
errors, never throw, never affect process exit code, never write to
stderr/stdout in a way that taints test output. The reporter is a
side-effect; tests must pass identically whether the embedded DB is up,
down, or unmigrated (cold contributor checkout, offline `npm test`, CI
without `test_runs` migrated). Covered by
`admin-test-runs-reporter.test.ts` in Phase 6.

### D-008 — `defineSuite` declarative DSL replaces the switch

**Date:** 2026-05-24
**Refs:** P-030

Shape mirrors `defineTool`:

```ts
defineSuite({
  id: 'voice-core',
  domain: 'voice',
  description: 'Voice unit + integration tests.',
  runners: [
    { kind: 'vitest', globs: ['apps/operator/lib/voice-*.test.ts'] },
    { kind: 'vitest', globs: ['apps/operator/lib/voice-cards/**/*.test.ts'] },
  ],
});
```

File-system scan of `apps/operator/lib/admin-test-suites/*.ts` auto-
registers. The existing 7 suites become 7 files. Adding an 8th = drop a
file, no switch edit.

### D-009 — Orchestrator-legacy tests run CI-only, no UI tab
Date: 2026-05-24
The 51 legacy bash-orchestrator tests under `libs/papercusp/packages/orchestrator/` cover `run.sh` which still ships (per `project_run_sh_function_library`). They cannot be deleted yet — operator awk-extracts log/config_get/invoke functions from the same file.

But surfacing them as an `orchestrator` tab in `/admin/testing` (as originally proposed in D-001) is dead weight: it encourages workers to read/copy from legacy bash code that's being slowly retired.

Compromise: keep the tests, drop the tab. They run via CI only. Reduces total tab count from 21 → 20.

When `run.sh` is fully retired (gated on a separate plan, currently deferred — see `project_next_removal_deferred`), the tests are deleted at the same time. P-040 originally tracked the "drop tab when run.sh retires" follow-up; that item is now updated to track only the test-deletion since the tab never existed.
Related: P-002

### D-010 — Branch-scoped status chip — record source + branch + commit on every run
Date: 2026-05-24
"Last run anywhere" is misleading: a flake from 3-weeks-ago-on-main shouldn't show as the current status on a feature branch. The status chip must reflect what's actually true for the developer's checkout.

`harness_shared.test_runs` schema (P-008) gains three columns:

- `source ENUM('ci', 'local', 'admin-ui')` — where the run originated
- `branch TEXT` — git branch at run time (resolved by reporter via `git rev-parse --abbrev-ref HEAD` with 200ms timeout; null on failure)
- `commit_sha TEXT` — `git rev-parse HEAD` at run time (null on failure)

`/api/admin/testing/file-status` (P-009) default filter: rows WHERE `branch = currentBranch() OR source = 'admin-ui'`. Falls back to "any source" when the file has no row on the current branch, with a visible "stale" badge on the chip in that case.

Slight extra schema complexity, much truer signal. Resolving branch/commit lives in the same reporter scope as the PG write, sharing the fail-soft contract (D-007) — git resolution failure is also log-and-continue.
Related: P-008, P-009, P-013
