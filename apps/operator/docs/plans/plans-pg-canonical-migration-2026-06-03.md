---
title: Plans → PG-canonical, markdown rendered on-demand — full migration plan
slug: plans-pg-canonical-migration-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: aviynw@gmail.com
---

# Plans → PG-canonical, markdown rendered on-demand

## Now

**State:** Draft authored 2026-06-03 from a full codebase audit (7 parallel deep-reads, reconciled). Owner approved the direction: **PG is the single source of truth; markdown is rendered on demand and dropped from git (Option A).** The inventory below covers ~120 functional files across 12 subsystems + 219 plan `.md` files + ~30 comment-only citations, each with a migration action. No code written yet.

**Next:** owner reviews this plan; on sign-off, start **Stage 0** (migration 115 + generated schema + FS→PG backfill + the `renderPlanMarkdown` renderer gated by a round-trip property test over all 219 plans). Nothing flips until Stage 0's renderer round-trip is green.

## Background — why

Today a plan is a filesystem-canonical markdown file at `apps/operator/docs/plans/<slug>-<YYYY-MM-DD>.md` (219 of them now, up from the ~50 the original brief assumed). `apps/operator/lib/agent-tools/plans/source.ts` re-reads + re-parses the directory on every call. The original design (`plans-system-brief-2026-05-20`) declared "the filesystem is canonical — no Postgres table, no mirror, git history is the audit trail."

That design has already eroded:

- **Operational status + priority** (started/paused/done, dispatch priority) live in PG `harness_shared.harness_plan_status`.
- A **per-write revision spine** lives in PG `plan_revisions` (D-003 of `plan-agent-launch-2026-05-21` already demoted git to the "coarse, rationale-free" fallback view).
- `list.ts` carries a `reconcileStartStatus` "self-heal the cross-store invariant on read" hack — direct evidence of FS↔PG drift the pure-FS design was meant to prevent.

So this is not a clean design we're violating; it's a half-finished migration that leaked. Going PG-canonical finishes it: one indexed source of truth, parity with the features system (`harness_features_consolidated`: PG table, tsvector search, generated drizzle typing), the `reconcileStartStatus` hack deleted, cross-harness aggregation as one SQL query, and federation via the same CDC-outbox path features already use.

## Decisions

### D-001 — PG-canonical, markdown rendered on demand, dropped from git (Option A)
2026-06-03

A new PG table `harness_shared.harness_plans` becomes the single source of truth. Markdown is no longer stored in git; it is produced on demand by `plans:get` / the admin UI / a new `plans:export`. The 219 tracked `.md` files are removed after a one-time backfill. Rejected: (B) generate `.md` to disk as a one-way artifact — still a tracked mirror, churny diffs, needs a CI guard against hand-edits; (C) keep FS-canonical and move op-status back into frontmatter — doesn't scale queries, can't index/rank, stays inconsistent with features. Owner picked A: the only option with no residual mirror, and diff/review tooling already exists in PG (`plans:revision-diff`).

### D-002 — Two stages: lift-and-shift, then normalize
2026-06-03

Stage 1 stores the full markdown blob in `harness_plans.content` + frontmatter columns + a tsvector; reads parse the blob, writes splice it (today's logic, persisted to PG). This kills the FS dependency, folds in `harness_plan_status`, and delivers indexed list/search with minimal risk. Stage 2 normalizes items/decisions/now into JSONB/columns and makes the renderer the read path (markdown generated from structure). The "markdown generated from PG" end state is Stage 2; Stage 1 de-risks the cutover. The renderer is only strictly required at Stage 2.

### D-003 — Remove the git-history surface; plan_revisions is the audit trail
2026-06-03

Once plan files leave git, `plans:history` / `plans:diff` / `plan-git.ts` / `/api/admin/plans/git/*` have no meaning. `plan_revisions` (already PG, full content snapshots per write) is the audit trail; repoint history/diff to it and delete the git routes + helper. (Corrects the read-side audit agent, which assumed git history stays.)

### D-004 — Federation flips git → peer-log (CDC-outbox)
2026-06-03

`harness-state/table-registry.ts` would classify plans as `sync: git`. D-001 removes git as the transport, so `harness_plans` must federate via the hyperbee CDC-outbox path features/issues already use (`lib/sync/hyperbee/`). Classify the table workspace-owned, sync `peer-log`; register a plans projection before peers can sync.

### D-005 — Concurrency: version-column CAS is the guard; advisory lock only for ID allocation
2026-06-03

Replace the FS `O_EXCL` lock in `with-plan-lock.ts` with a PG advisory lock on `(harness_slug, plan_slug)`, but the real guard stays optimistic `version`-column CAS (matches today's "CAS not the lock is the real guard" note in `set-content.ts`). `expectedHash` becomes `expectedVersion` end to end. The advisory lock only needs to wrap P-/D-NNN id allocation.

### D-006 — One canonical representation, no double-blob
2026-06-03

Do NOT store both a raw markdown blob and structured JSONB as canonical (the schema agent's first-cut DDL did). Stage 1: `content` blob is canonical. Stage 2: structured columns are canonical and the blob is dropped (or kept only as a derived cache, never authoritative). The "no FS mirror" rule applies equally to an internal PG double-write.

### D-007 — What does NOT migrate
2026-06-03

Only **plan content** + **`harness_plan_status`** move into `harness_plans`. These survive unchanged as separate tables: `plan_events` (coord event log, `coord:plan-events`), `plan_revisions` (per-write audit), `harness_plan_review` (architect review gate), `plan_runs`/`plan_run_turns` (execution), `harness_plan_assertions` (VAL-* — kept as a projected child table, re-projected on plan write).

## Stages — build sequence

- **Stage 0 — Foundation (safe, additive):** migration 115 + generated drizzle schema; FS→PG backfill script (PG shadow, FS still canonical); `renderPlanMarkdown` + a `fast-check` round-trip property test (`parse(render(parse(x))) ≡ parse(x)`) over all 219 plans. Nothing flips.
- **Stage 1 — Flip reads:** `source.ts` + read tools + cross_harness + routes + coord + bootstrap-su read PG; add `table-to-query-names` + `harness-state` registry entries. UI unchanged.
- **Stage 2 — Flip writes:** write tools upsert PG; `with-plan-lock` → advisory lock + version CAS; `plans-api.ts` hash→version; delete `plan-git.ts`; repoint `plans:history`/`diff` to `plan_revisions`.
- **Stage 3 — Cut sync + remove files:** register hyperbee plans projection; flip `harness_plans` sync to peer-log; tag `plans-fs-retired-2026-06-03` then `git rm` the 219 files; retire `source.ts` FS paths; rewrite docs/prompts; ship `plans:export`.
- **Stage 4 — (optional) Normalize:** items/decisions/now → JSONB columns; renderer becomes the read path; drop the content blob as canonical.

## Migration inventory — every place

Coverage: ~120 functional files across 12 subsystems + 219 data files + ~30 comment-only citations, each assigned an action.

### 1. Storage substrate — schema, migrations, parser/renderer

| Place | Action |
|---|---|
| `libs/papercusp/libs/db/sql/115-harness-plans.sql` (NEW; next # is 115) | Create `harness_shared.harness_plans` (PK `workspace_id,harness_slug,plan_slug`; frontmatter cols; `content` TEXT; `version` BIGINT CAS; `content_hash`; `op_status`/`op_status_at` folded from harness_plan_status; `archived`, `is_legacy`; `_search` tsvector + GIN; RLS + grants for harness_app/harness_admin). Model on harness_features_consolidated. |
| `libs/papercusp/libs/db/src/schema/{schema,generated}.ts` | Add `harnessPlansInHarnessShared`; run pull-schema.mjs → generated typing for plans:get like features:get. |
| `harness_plan_status` (mig 086) | Fold into harness_plans; stop writing the standalone table post-backfill. |
| `harness_plan_assertions` (migs 087/088) | Keep as a projected child table (own status lifecycle, mutated by validators); re-project on plan-content write. |
| `harness_plan_review`, `plan_revisions`, `plan_runs`/`plan_run_turns` | No change — separate tables, survive. |
| `000-baseline.sql`, `archive/{086,087,088,089,092,095}` | Immutable/archive — reference only; re-grant for the new table in 115. |
| `libs/generic/plan-parser/src/renderer.ts` (NEW) + `renderer.test.ts` | Build `renderPlanMarkdown(parsed)→string` (inverse of parser.ts); none exists today. Gate with the round-trip property test over all 219 plans. Required for Stage 2. |
| `libs/generic/plan-parser/src/{index,parser,effective-status,content-hash}.ts` | No change — pure, input-complete; operator imports the new renderer alongside. |

### 2. Plan read tools — `apps/operator/lib/agent-tools/plans/`

| File | Action |
|---|---|
| `source.ts` | Cutover point. Replace listPlanFiles/readPlanBySlug/readAllPlans FS walk with PG selects; resolveHarnessPlansDir retained only as a slug validator. Delete FS-walk code end of Stage 1. |
| `_ctx-opts.ts` | Reduce to `{ harnessSlug }` only (drop plansDir/archiveDir). |
| `list.ts` | FS walk + per-slug harness_plan_status join → single SQL; delete reconcileStartStatus (op_status now a column). |
| `get.ts` | readPlanBySlug → SELECT content; render/parse for structured view; contentHash field → version. Feature-link + test-coverage subqueries unchanged. |
| `items.ts` | Stage 1: parse from content; Stage 2: read JSONB columns (pure SQL). |
| `search.ts` | In-memory TF scoring → PG tsvector / ts_rank_cd (parity with features:search). |
| `attention.ts` | Read plan rows from PG; smoke/review subqueries unchanged. |
| `lint.ts` | Read from PG; preserve legacy-plan exemption. |
| `history.ts`, `git-history.ts`, `diff.ts` | Remove git surface; plans:history/diff repoint to plan_revisions (or delete diff in favor of plans:revision-diff). |
| `context-bundle.ts` | readPlanBySlug → PG; plan_revisions read unchanged. |
| `effective-status.ts`, `parser.ts`, `content-hash.ts`, `val-assertions.ts`, `for-each-resolver.ts`, `read-dispatch.ts`, `_harness-scope.ts` | No change (pure shims / pure logic / dispatcher / scope helper). |

### 3. Plan write + lifecycle tools + concurrency

| File | Action |
|---|---|
| `with-plan-lock.ts` | FS O_EXCL lock → PG advisory lock on (harness_slug, plan_slug); real guard is version-column CAS (D-005). |
| `set-content.ts` / `set-content-chunk.ts` | Write content column; expectedHash → expectedVersion; same lint + legacy-boundary guards; stale-response shape unchanged (UI needs no change). |
| `set-status` / `set-importance` / `set-now` / `add-item` / `add-decision` / `set-frontmatter` / `set-plan-status` | Stage 1: splice content blob (unchanged regex) then upsert. Stage 2: mutate JSONB region columns. ID allocation inside the advisory lock. Each records a plan_revisions row via the existing afterWrite hook. |
| `new.ts` | INSERT harness_plans row instead of writing a file; emit created event. |
| `start.ts` / `pause.ts` / `set-priority.ts` / `plan-start-state.ts` | Already PG (harness_plan_status) → point at the folded columns on harness_plans; clearStartedForTerminalPlan → column update. |
| `launch.ts` / `resume.ts` / `turn.ts` / `runs(-list).ts` / `run-status.ts` / `run-transcript.ts` | No change to run lifecycle (already PG); only the plan body they read moves FS→PG via buildPlanContextBundle. |
| `revisions*.ts` (revisions, revisions-list, revisions-backfill, revision-diff, revision-summary, revision-transcript) | No change — plan_revisions is the audit spine and stays; revisions-backfill (git→PG) remains a one-time op. |
| `promote-policy.ts`, `destructive-replan.ts` | No change (pure logic). |
| Write-tool `filePath` return field | Drop or return a synthetic path (callers use it for event routing, not I/O). |

### 4. cross_harness tools

| File | Action |
|---|---|
| `cross_harness/plans_list.ts`, `plans_get.ts`, `plans_search.ts` | Drop per-harness FS fan-out → single SQL `WHERE harness_slug = ANY(...)`; preserve cross-workspace resolveProject as a WHERE filter. |

### 5. HTTP routes + host + registration

| File | Action |
|---|---|
| `endpoint-route/routes/admin/plans.ts` | Thin dispatch envelope — unchanged; underlying tools change. Keep SSE invalidations (now fire on PG write). |
| `endpoint-route/routes/admin/plan-git.ts` + `/api/admin/plans/git/*` | Delete (git history of plan files is gone); UI git strip removed. |
| `endpoint-route/routes/coord/index.ts` (`GET /coord/plans`, `/coord/plans/:slug`) | readAllPlans/readPlanBySlug → SQL; render markdown on demand for the :slug detail. |
| `endpoint-route/routes/agent-mcp/bootstrap-su.ts` (options endpoint) | Plan picker list: FS walk → SELECT slug,title,status FROM harness_plans. |
| `endpoint-route/routes/internal/plan-review-event.ts` | No change (already PG harness_plan_review). |
| `bin/host-bootstrap.ts` | No plan-specific change. |
| `agent-tools/index.ts` | No change to the import block (tool names stable). |

### 6. Admin UI — `apps/operator/app/admin/plans/` + `operator-vite/src/routes/admin/plans.tsx`

| File | Action |
|---|---|
| `plans-api.ts` (client) | The one substantive UI change: routes repoint transparently; contentHash→version, expectedHash→expectedVersion. staleConflictOf/writeErrorOf already defensive — no shape change. |
| `PlanConflictModal.tsx`, `RunDetailPanel.tsx` (stale badge) | CAS field rename only (hash→version); flow identical. |
| `PlanEditor.tsx` (vditor) | Keep — value stays raw markdown from plans:get; saving writes the content/body column, not a file. No AST shift in Stage 1. |
| `RevisionsPanel`, `RevisionDiffModal`, `RevisionConversationModal`, `AgentsPanel` | No change (already read PG revisions/runs). |
| `PlansClient`, `PlanDetail`, `PlanActions`, `PlanRail`, `PlanItems*`, `PlanStatusPopover`, `PlanBucketTabs`, `PlanFilters`, `plan-filtering`, `plan-renderers(-ir)`, `PlanSearchResults`, `PlanJumpToItem`, `PlanOtherList`, `attention-card`, `LintBanner`, `LockBanner`, `PlanChat`, `plans.tsx` | No change — all route through plans-api.ts; data shapes identical. |

### 7. Cross-cutting consumers

| File | Action |
|---|---|
| `lib/sync-resolver/index.ts` | The plans.* query entries (callPlansRead) hydrate from PG instead of FS — no contract change (flat-row arrays). |
| `lib/sync-resolver/table-to-query-names.ts` | Add harness_plans→[plans.get,plans.list], plan_revisions→[plans.revisions], plan_runs→[plans.runs] so PG writes fire SSE refetch (today empty for plans → would silently not invalidate). |
| `lib/harness-state/table-registry.ts` | Classify harness_plans (workspace-owned; sync peer-log, not git) before the table ships. |
| `lib/harness-fs-watcher.ts` | No change — confirmed it does NOT watch plan files; dropping them is safe for it. |
| `lib/plan-context-for-feature.ts` | readPlanBySlug → PG read; interface stable. |
| `lib/memory/audit-anchors.ts` | kind:'plan' anchors do fs.stat on plan files → switch to harness_plans.slug existence check. |
| `agent-tools/architect/plan-block-handler.ts`, `coordination/{promote,tools/handoff,tools/promote}.ts` | No change — dispatch to plans:* tools / carry plan_slug refs, not content. |
| `coordination/tools/plan-events.ts`, `tools/watermark-set.ts` | No change — plan_events is the coord log, survives. |
| `agent-tools/harness/plan_reviews.ts` | No change — harness_plan_review already PG. |
| `lib/attention/{adapters,sources,group,types}.ts` | No change — operate on parsed plan objects via the read tools. |
| `lib/dbos/{orchestrator-runner,orchestrator-loop}.ts`, `libs/papercusp/packages/orchestrator/state-pg.ts`, `agent-tools/generators/publish.ts`, `lib/harness-activity/load.ts`, `lib/operator-continue-chains.ts`, `agent-tools/docs/_engineering-adapter.ts`, `agent-tools/search/{fulltext,semantic}.ts`, `lib/agent-kickoff/prompt-file.ts` | No change — only metadata.source_plan_slug refs / no plan-content reads (plans not in prose search today; optional future add). |

### 8. Federation / sync cutover (hyperbee CDC-outbox)

| File | Action |
|---|---|
| `lib/sync/hyperbee/feature-issue-op-keys.ts` | Add harness_plans → 'plans-by-slug' to the table-tag map. |
| `lib/sync/hyperbee/wire-outbox.ts` + new `projections/harness-plans.ts` | Register a plans projection; backfill enqueues existing rows; drain LISTENs on harness_plans.changed. Required before peers can sync plans. |
| `lib/sync/hyperbee/boot.ts` | Wire the plans projection into per-harness boot. |

### 9. Scripts

| File | Action |
|---|---|
| `scripts/backfill-fs-plans-to-pg.ts` (NEW) | One-time: parse all 219 files → upsert harness_plans (+ initial version, content_hash, tsvector). Model on backfill-plan-promoted-blocks.ts. |
| `scripts/lint-plans.ts` (CI gate) | Repoint from FS scan to plans:lint over PG. |
| `scripts/migrations/backfill-plan-promoted-blocks.ts`, `_audit-write.ts`, `_smoke.ts` | Minor/none — confirm no residual FS plan writes. |

### 10. Tests

| File | Action |
|---|---|
| `plans/__tests__/resolve-harness-plans-dir.test.ts` | Delete (dir resolution removed). |
| `plans/__tests__/concurrency.test.ts` | Rewrite for PG version-CAS / advisory lock. |
| `plans/__tests__/e2e.test.ts` | Refactor: keep slug path-traversal guards + parser tests; FS reads → PG. |
| `cross_harness/__tests__/plans.test.ts` | Rewrite temp-FS setup → PG fixture rows. |
| `set-status` / `start-guard` / `plan-start-state` / `lib/__tests__/plan-context-for-feature.test.ts` | Minimal — swap mocked readPlanBySlug source FS→PG row. |
| `context-bundle`, `runs`, `revision-summary`, `revisions-backfill`, `set-priority`, `promote-policy`, `expand-generators`, `destructive-replan`, `for-each-resolver`, `with-plan-lock-slug`, `val-assertions` | No change (pure / already PG). |
| `e2e/plan-agent-launch.spec.ts`, `test/harness-plan-status-grants.integration.test.ts` | Verify green (already PG-centric). |
| `lib/__tests__/tools-md-sync.test.ts` | Verify green — tool names unchanged. |

### 11. Docs / prompts / registries

| File | Action |
|---|---|
| `apps/operator-docs/.../spec/plan-format.mdx` | Heavy rewrite — strike "filesystem is canonical / no PG mirror"; document harness_plans substrate + on-demand render; keep the markdown format spec; update the chunked-write protocol (now PG). |
| `apps/operator-docs/.../agent-policies.mdx` (§18) | Replace FS path + "archive dir" with PG model (archival = archived flag); keep chunking guidance. |
| `prompts/papercusp-su-{engineer,power}.tools.md` | Update the hard apps/operator/docs/plans/<slug>.md references → "stored in PG, read/write via plans:*". |
| `prompts/kickoffs/new-plan.md`, `agent-insights/per-phase-execution-plan-template.mdx` | Drop explicit FS paths; slugs stay the identity. |
| `lib/testing-domains-registry.ts`, `libs/testing-shell/src/registry.ts` | Verify green — globs are by file path, unaffected. |
| Regenerate `apps/operator/public/internal/docs/**` mirror (npm run build in operator-docs) | Commit with the .mdx edits. |

### 12. Data + comment citations

| Place | Action |
|---|---|
| 219 `apps/operator/docs/plans/*.md` | Backfill → git rm after a plans-fs-retired-2026-06-03 git tag (restore point). Ship plans:export for on-demand files. |
| ~30 code files citing docs/plans/<slug>.md in comments | Leave as-is (slug is durable, resolvable via plans:get). Optional one-line codemod only if zero dangling paths is wanted. |

## Risks

- **Renderer round-trip fidelity** on legacy/malformed plans — gated by the Stage 0 property test over all 219 before any flip.
- **Half-flipped read/write boundary** serving FS+PG mix — do each flip atomically (one commit per stage); verify against the running Tauri shell.
- **Missing `table-to-query-names` entries** → stale UI (no SSE refetch) — added in Stage 1.
- **Federation projection must land before peers sync** — Stage 3 ordering.
- **`harness_plan_assertions` re-projection** — VAL coverage must rebuild on plan-content write or validator state drifts.

## Out of scope (pending owner decision)

- **Verb-surface cleanup** — collapsing the 18 single-field `set-*` writers into a smaller patch-style surface + fixing file/tool-name mismatches (`revisions-list.ts`→`plans:revisions`, `run-status.ts`→`plans:set-run-status`, etc.). Deliberately excluded here to hold tool names stable (keeps tools-md-sync green, no UI churn). Clean Stage-4+ follow-up; fold in only on owner's say-so.

## Provenance

Audit method: 7 parallel read-only Explore agents over the plans tool surface (read/write/lifecycle), admin UI, routes/host/cross_harness, cross-cutting consumers, DB schema + parser lib + scripts, and tests/docs/prompts; findings reconciled by the operator (three conflicts corrected: git-history removal D-003, no double-blob D-006, federation git→peer-log D-004).
