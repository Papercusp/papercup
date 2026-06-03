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

**State:** Draft authored 2026-06-03 from a full codebase audit (7 parallel deep-reads), then **revised after peer review** (all three checkable claims verified: migration 115 is taken — dir at 117; `harness-state-storage-unification-2026-06-01` is actively editing `table-registry.ts` + the migration baseline and already hit the same 115→116 collision; the jsonb-binding fixes + `_jsonb-input.ts` helper are real). Direction approved by owner: **PG is the single source of truth; markdown is rendered on demand and dropped from git (Option A).** Inventory covers ~120 functional files across 12 subsystems + 219 plan `.md` files + ~30 comment-only citations.

**Next:** (1) `coord:send` sent to su-08782 to sequence after their consolidation engine + align the `table-registry.ts` edit and migration numbering — **await reply before Stage 0**. (2) Owner reviews this revision (esp. D-004 federation deferral → plans become single-machine + backup-only, and D-006 prose-canonical refinement). On both, start **Stage 0** (additive: migration + generated schema + FS→PG backfill; no flips, no renderer gate).

## Background — why

Today a plan is a filesystem-canonical markdown file at `apps/operator/docs/plans/<slug>-<YYYY-MM-DD>.md` (219 of them, up from the ~50 the original brief assumed). `source.ts` re-reads + re-parses the directory on every call. The original design (`plans-system-brief-2026-05-20`) declared "the filesystem is canonical — no Postgres table, no mirror, git history is the audit trail."

That design has already eroded:

- **Operational status + priority** (started/paused/done, dispatch priority) live in PG `harness_shared.harness_plan_status`.
- A **per-write revision spine** lives in PG `plan_revisions` (D-003 of `plan-agent-launch-2026-05-21` already demoted git to the "coarse, rationale-free" fallback view).
- `list.ts` carries a `reconcileStartStatus` "self-heal the cross-store invariant on read" hack — direct evidence of FS↔PG drift the pure-FS design was meant to prevent.

So this is not a clean design we're violating; it's a half-finished migration that leaked. Going PG-canonical finishes it: one indexed source of truth, parity with the features system (`harness_features_consolidated`: PG table, tsvector search, generated drizzle typing), the `reconcileStartStatus` hack deleted, and cross-harness aggregation as one SQL query.

## Decisions

### D-001 — PG-canonical, markdown rendered on demand, dropped from git (Option A)
2026-06-03

A new PG table `harness_shared.harness_plans` becomes the single source of truth. Markdown is no longer stored in git; it is produced on demand by `plans:get` / the admin UI / a new `plans:export`. The 219 tracked `.md` files are removed after a one-time backfill. Rejected: (B) generate `.md` to disk as a one-way artifact — still a tracked mirror, churny diffs, needs a CI guard against hand-edits; (C) keep FS-canonical and move op-status to frontmatter — doesn't scale queries, stays inconsistent with features. Owner picked A: the only option with no residual mirror.

### D-002 — Two phases of change: lift-and-shift, then (optional) normalize
2026-06-03

Through Stage 2 the **markdown blob is canonical** in `harness_plans.content`: reads return the stored blob, writes splice it (today's regex logic, persisted to PG). This delivers the wins (indexed PG list/search, drift hack deleted, cross-harness SQL) with **no renderer dependency**. The optional Stage 3 normalizes the *queryable* parts (items/decisions/now) into columns as a derived index; the prose body stays canonical (see D-006). The renderer (inverse parser) is required **only at Stage 3**, not before. See the Stages section for the unified 0–3 numbering.

### D-003 — Remove the git-history surface; plan_revisions is the audit trail; git-rm is gated
2026-06-03

Once plan files leave git, `plans:history` / `plans:diff` / `plan-git.ts` / `/api/admin/plans/git/*` have no meaning. `plan_revisions` (already PG, full content snapshots per write) is the audit trail; repoint history/diff to it and delete the git routes + helper. The `git rm` of the 219 files is **gated** on: (a) a verified-lossless backfill of full git plan history into `plan_revisions` (not a loose "one-time op" — assert seq/content parity), and (b) `harness_plans` confirmed in `backup:*` snapshot scope (post-removal, PG is the only copy; git was a free offsite backup).

### D-004 — Federation DEFERRED; sync:none for now; ride su-08782's projection engine
2026-06-03

**Reversed from the first draft** (which built a hyperbee CDC-outbox projection for plans). Per review: that projection is a known bug magnet (su-08782 spent a session fixing 4 latent throwers + a CDC convergence cascade in those exact files), and cross-machine peer sync of operator-scoped engineering plans is speculative. Classify `harness_plans` as **`sync: none`** for now and **drop §8 entirely** (no hyperbee projection built here). Honest consequence to flag the owner: today plans sync cross-machine *via git*; D-001 removes that, so `sync: none` makes plans **single-machine-local, PG-as-only-copy** — which is why D-003's backup requirement is load-bearing, not a nit. If cross-machine plan sync is later required, it's a **separate follow-up** that declares `sync: peer-log` on su-08782's registry-driven projection engine (P-003 of storage-unification) — a one-line change, not a hand-rolled projection — and only then copies the jsonb-binding fixes (see Deferred follow-up). **Do NOT gate the git-rm on a federation projection** (the first draft's Stage 3 wrongly coupled them).

### D-005 — Concurrency: version-column CAS is the guard; advisory lock only for ID allocation
2026-06-03

Replace the FS `O_EXCL` lock in `with-plan-lock.ts` with a PG advisory lock on `(harness_slug, plan_slug)`, but the real guard stays optimistic `version`-column CAS (matches today's "CAS not the lock is the real guard" note in `set-content.ts`). `expectedHash` becomes `expectedVersion` end to end. The advisory lock only needs to wrap P-/D-NNN id allocation. `content_hash` is retained for dedup + revision identity, but `version` is the CAS guard — keep `content_hash` only if a consumer needs it (the revision spine already hashes snapshots), else drop as vestigial.

### D-006 — Prose body stays canonical; only queryable parts become a derived index
2026-06-03

**Refined from the first draft** (which said "drop the content blob as canonical" at normalize). `parse(render(parse(x))) ≡ parse(x)` proves *semantic* stability, not *byte-fidelity* of free prose (Background / Risks / Provenance). So at Stage 3, structure only the queryable sections (items/decisions/now) into columns as a **derived index**; keep the **prose body canonical** in a TEXT column. The rendered markdown = render(structured sections) + stored prose. The renderer never has to reproduce free prose, which removes the fidelity risk. Caveat for the owner: this tempers the original "markdown fully generated from PG" framing — prose is *stored*, only structured sections are *generated*.

### D-007 — What does NOT migrate
2026-06-03

Only **plan content** + **`harness_plan_status`** move into `harness_plans`. These survive unchanged as separate tables: `plan_events` (coord event log, `coord:plan-events`), `plan_revisions` (per-write audit), `harness_plan_review` (architect review gate), `plan_runs`/`plan_run_turns` (execution). `harness_plan_assertions` (VAL-*) stays a **projected child table**, re-synced on plan-content write as a **status-preserving merge upsert** (sync the assertion set to the plan body, preserve existing validator statuses) — **NOT a rebuild**, which would wipe statuses validators are actively mutating.

### D-008 — Sequence after / depend on storage-unification; coordinate the shared edits
2026-06-03

`harness-state-storage-unification-2026-06-01` (su-08782, active) is consolidating per-harness→slug-keyed tables behind one registry-driven projection engine (its P-003) and is editing `table-registry.ts` + renumbering migrations. `harness_plans` should be born into that world: a slug-keyed PG table declared in the final registry shape, getting projection (or `sync: none`) for free. So: (a) **do not hard-pin a migration number** — take the next free # verified via `db:check_drift` at implementation, sequenced after their in-flight migrations; (b) **hold the `table-registry.ts` edit** until their registry cutover (P-006) lands, then add `harness_plans` via the final shape; (c) sequence Stage 0 after their consolidation engine. Coordinated via `coord:send` (msg sent 2026-06-03).

## Stages — build sequence (unified numbering 0–3)

- **Stage 0 — Foundation (additive; NO renderer gate):** add the `harness_plans` migration (next free # via `db:check_drift`) + generated drizzle schema; write the FS→PG backfill (parse all 219 → upsert; PG is a shadow, FS still canonical). Nothing flips. *(The renderer is NOT built or gated here — it's Stage-3-only.)*
- **Stage 1 — Atomic reads+writes flip (one commit / one restart):** in a single change, move `source.ts` + all read tools + all write tools + cross_harness + the admin/coord/bootstrap-su routes to PG; `with-plan-lock` → advisory lock + `version` CAS; `plans-api.ts` `contentHash`→`version`; delete `plan-git.ts`; repoint `plans:history`/`diff` → `plan_revisions`; add the `table-to-query-names` + (coordinated) `harness-state` registry entries. **Re-run the backfill immediately before the flip.** *(Reads and writes flip together to close the data-loss window the first draft's split Stage-1/Stage-2 opened — on this box the fleet writes plans every few minutes, so a reads-before-writes gap would lose any FS-only write made between deploys.)*
- **Stage 2 — Remove files + docs:** add a CI grep-gate "zero `docs/plans/` reads outside `source.ts`" and confirm green (catches any reader the audit missed); verify the lossless `plan_revisions` git-history backfill + `harness_plans` in `backup:*` scope (D-003 gate); tag `plans-fs-retired-2026-06-03`, then `git rm` the 219 files; retire `source.ts` FS paths; rewrite docs/prompts; ship `plans:export` (on-demand file dump — confirm a real consumer or mark it insurance).
- **Stage 3 — (OPTIONAL) Normalize:** structure items/decisions/now into columns (derived index); prose body stays canonical (D-006); build `renderPlanMarkdown` + the `fast-check` round-trip property test over all 219 plans — **this stage is the only thing gated on renderer fidelity.**
- **Deferred follow-up — cross-machine plan sync (only if required):** flip the registry declaration to `sync: peer-log` on su-08782's engine; only then port the jsonb-binding fixes below.

## Migration inventory — every place

Coverage: ~120 functional files across 12 subsystems + 219 data files + ~30 comment-only citations.

### 1. Storage substrate — schema, migrations, parser/renderer

| Place | Action |
|---|---|
| `libs/papercusp/libs/db/sql/<NNN>-harness-plans.sql` (NEW; **next free # — 115–117 taken; verify via db:check_drift, sequence after storage-unification's in-flight migrations**) | Create `harness_shared.harness_plans` (PK `workspace_id,harness_slug,plan_slug`; frontmatter cols; `content` TEXT canonical; `version` BIGINT CAS; `op_status`/`op_status_at` folded from harness_plan_status; `archived`, `is_legacy`; `_search` tsvector + GIN; RLS + grants). Model on harness_features_consolidated. Add the table to `table-registry.ts` **via su-08782's final registry shape** (D-008), classified `sync: none` (D-004). |
| `libs/papercusp/libs/db/src/schema/{schema,generated}.ts` | Add `harnessPlansInHarnessShared`; run pull-schema.mjs. NOTE: storage-unification just had a `generated.ts` regen drop the `primaryKey` import (191 uses) → fleet crash-loop; verify the import survives regen. |
| `harness_plan_status` (mig 086) | Fold into harness_plans; stop writing the standalone table post-backfill. |
| `harness_plan_assertions` (migs 087/088) | Keep as a projected child table; re-sync as a **status-preserving merge upsert** on plan-content write (D-007). |
| `harness_plan_review`, `plan_revisions`, `plan_runs`/`plan_run_turns` | No change — separate tables, survive. |
| `000-baseline.sql`, `archive/{086,087,088,089,092,095}` | Immutable/archive — reference only; re-grant for the new table in the new migration. |
| `libs/generic/plan-parser/src/renderer.ts` (NEW) + `renderer.test.ts` | **Stage 3 ONLY.** Build `renderPlanMarkdown(structured)→markdown` for the queryable sections (NOT prose, which stays stored). Gate Stage 3 with the round-trip property test over all 219 plans. |
| `libs/generic/plan-parser/src/{index,parser,effective-status,content-hash}.ts` | No change — pure, input-complete. |

### 2. Plan read tools — `apps/operator/lib/agent-tools/plans/`

| File | Action |
|---|---|
| `source.ts` | Cutover point. Replace listPlanFiles/readPlanBySlug/readAllPlans FS walk with PG selects; resolveHarnessPlansDir retained only as a slug validator. Delete FS-walk code in Stage 1; final FS-path retirement in Stage 2. |
| `_ctx-opts.ts` | Reduce to `{ harnessSlug }` only (drop plansDir/archiveDir). |
| `list.ts` | FS walk + per-slug harness_plan_status join → single SQL; **delete reconcileStartStatus** (op_status now a column). |
| `get.ts` | readPlanBySlug → SELECT content (blob, returned as-is through Stage 2); contentHash field → version. Feature-link + test-coverage subqueries unchanged. |
| `items.ts` | Stage 1: parse from content blob; Stage 3: read structured columns (pure SQL). |
| `search.ts` | In-memory TF scoring → PG tsvector / ts_rank_cd (parity with features:search). |
| `attention.ts` | Read plan rows from PG; smoke/review subqueries unchanged. |
| `lint.ts` | Read from PG; preserve legacy-plan exemption. |
| `history.ts`, `git-history.ts`, `diff.ts` | Remove git surface (Stage 1); plans:history/diff repoint to plan_revisions. |
| `context-bundle.ts` | readPlanBySlug → PG; plan_revisions read unchanged. |
| `effective-status.ts`, `parser.ts`, `content-hash.ts`, `val-assertions.ts`, `for-each-resolver.ts`, `read-dispatch.ts`, `_harness-scope.ts` | No change (pure shims / logic / dispatcher / scope helper). |

### 3. Plan write + lifecycle tools + concurrency

| File | Action |
|---|---|
| `with-plan-lock.ts` | FS O_EXCL lock → PG advisory lock on (harness_slug, plan_slug); real guard is version-column CAS (D-005). |
| `set-content.ts` / `set-content-chunk.ts` | Write content column; expectedHash → expectedVersion; same lint + legacy-boundary guards; stale-response shape unchanged (UI needs no change). |
| `set-status` / `set-importance` / `set-now` / `add-item` / `add-decision` / `set-frontmatter` / `set-plan-status` | Stage 1: splice content blob (unchanged regex) then upsert. Stage 3: mutate structured columns. ID allocation inside the advisory lock. Each records a plan_revisions row via the existing afterWrite hook. |
| `new.ts` | INSERT harness_plans row instead of writing a file; emit created event. |
| `start.ts` / `pause.ts` / `set-priority.ts` / `plan-start-state.ts` | Already PG (harness_plan_status) → point at the folded columns on harness_plans; clearStartedForTerminalPlan → column update. |
| `launch.ts` / `resume.ts` / `turn.ts` / `runs(-list).ts` / `run-status.ts` / `run-transcript.ts` | No change to run lifecycle (already PG); only the plan body they read moves FS→PG via buildPlanContextBundle. |
| `revisions*.ts` (revisions, revisions-list, revisions-backfill, revision-diff, revision-summary, revision-transcript) | No change to the read/record path. `revisions-backfill` (git→PG) is **promoted to a verified-lossless gate** for the Stage-2 git-rm (D-003). |
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
| `endpoint-route/routes/admin/plan-git.ts` + `/api/admin/plans/git/*` | Delete (Stage 1); UI git strip removed. |
| `endpoint-route/routes/coord/index.ts` (`GET /coord/plans`, `/coord/plans/:slug`) | readAllPlans/readPlanBySlug → SQL; return the stored blob for the :slug detail (no render through Stage 2). |
| `endpoint-route/routes/agent-mcp/bootstrap-su.ts` (options endpoint) | Plan picker list: FS walk → SELECT slug,title,status FROM harness_plans. |
| `endpoint-route/routes/internal/plan-review-event.ts` | No change (already PG harness_plan_review). |
| `bin/host-bootstrap.ts`, `agent-tools/index.ts` | No change (tool names stable). |

### 6. Admin UI — `apps/operator/app/admin/plans/` + `operator-vite/src/routes/admin/plans.tsx`

| File | Action |
|---|---|
| `plans-api.ts` (client) | The one substantive UI change: routes repoint transparently; contentHash→version, expectedHash→expectedVersion. staleConflictOf/writeErrorOf already defensive — no shape change. |
| `PlanConflictModal.tsx`, `RunDetailPanel.tsx` (stale badge) | CAS field rename only (hash→version); flow identical. |
| `PlanEditor.tsx` (vditor) | Keep — value stays raw markdown from plans:get; saving writes the content column, not a file. |
| `RevisionsPanel`, `RevisionDiffModal`, `RevisionConversationModal`, `AgentsPanel` | No change (already read PG revisions/runs). |
| `PlansClient`, `PlanDetail`, `PlanActions`, `PlanRail`, `PlanItems*`, `PlanStatusPopover`, `PlanBucketTabs`, `PlanFilters`, `plan-filtering`, `plan-renderers(-ir)`, `PlanSearchResults`, `PlanJumpToItem`, `PlanOtherList`, `attention-card`, `LintBanner`, `LockBanner`, `PlanChat`, `plans.tsx` | No change — all route through plans-api.ts; data shapes identical. |

### 7. Cross-cutting consumers

| File | Action |
|---|---|
| `lib/sync-resolver/index.ts` | The plans.* query entries (callPlansRead) hydrate from PG instead of FS — no contract change. |
| `lib/sync-resolver/table-to-query-names.ts` | Add harness_plans→[plans.get,plans.list], plan_revisions→[plans.revisions], plan_runs→[plans.runs] so PG writes fire SSE refetch (today empty for plans → would silently not invalidate). |
| `lib/harness-state/table-registry.ts` | Classify harness_plans (workspace-owned; **sync: none** per D-004) — **via su-08782's final registry shape, after their P-006 cutover** (D-008). |
| `lib/harness-fs-watcher.ts` | No change — confirmed it does NOT watch plan files; dropping them is safe. |
| `lib/plan-context-for-feature.ts` | readPlanBySlug → PG read; interface stable. |
| `lib/memory/audit-anchors.ts` | kind:'plan' anchors do fs.stat on plan files → switch to harness_plans.slug existence check. |
| `agent-tools/architect/plan-block-handler.ts`, `coordination/{promote,tools/handoff,tools/promote}.ts` | No change — dispatch to plans:* tools / carry plan_slug refs. |
| `coordination/tools/plan-events.ts`, `tools/watermark-set.ts` | No change — plan_events is the coord log, survives. |
| `agent-tools/harness/plan_reviews.ts` | No change — harness_plan_review already PG. |
| `lib/attention/{adapters,sources,group,types}.ts` | No change — operate on parsed plan objects via the read tools. |
| `lib/dbos/{orchestrator-runner,orchestrator-loop}.ts`, `libs/papercusp/packages/orchestrator/state-pg.ts`, `agent-tools/generators/publish.ts`, `lib/harness-activity/load.ts`, `lib/operator-continue-chains.ts`, `agent-tools/docs/_engineering-adapter.ts`, `agent-tools/search/{fulltext,semantic}.ts`, `lib/agent-kickoff/prompt-file.ts` | No change — only metadata.source_plan_slug refs / no plan-content reads. |

### 8. Cross-machine sync — DEFERRED (was: hyperbee CDC-outbox)

Per **D-004**, no hyperbee projection is built in this plan. `harness_plans` ships `sync: none`. The files below are **NOT touched here**; they are the reference target for the deferred follow-up *if* cross-machine plan sync is later required:

| File | Deferred action (only if federating later) |
|---|---|
| `lib/sync/hyperbee/feature-issue-op-keys.ts` | Add harness_plans → 'plans-by-slug'. |
| `lib/sync/hyperbee/wire-outbox.ts` + new `projections/harness-plans.ts` | Register a plans projection — and copy the fixes that landed in issues/contributors/harness-features/usage: bind every jsonb col as `${JSON.stringify(x)}::jsonb` (never `sql.json()` — throws under getOrgPg's client); wrap inputs in `normalizeJsonbInput()` (`_jsonb-input.ts`) so federated already-stringified blobs re-parse to an `IS DISTINCT FROM` fixed point (else the outbox self-amplifies); carry the origin echo-guard + AFTER-UPDATE `WHEN OLD.* IS DISTINCT FROM NEW.*` trigger; recompute `_search` locally (don't federate it); mind the large content blob per write. See `agent-insights/postgres-js-jsonb-binding`. |
| `lib/sync/hyperbee/boot.ts` | Wire the projection into per-harness boot. |

### 9. Scripts

| File | Action |
|---|---|
| `scripts/backfill-fs-plans-to-pg.ts` (NEW) | Parse all 219 files → upsert harness_plans. Run at Stage 0 (shadow) AND re-run immediately before the Stage-1 atomic flip (closes the data-loss window). Model on backfill-plan-promoted-blocks.ts. |
| `scripts/lint-plans.ts` (CI gate) | Repoint from FS scan to plans:lint over PG. |
| `scripts/migrations/backfill-plan-promoted-blocks.ts`, `_audit-write.ts`, `_smoke.ts` | Minor/none — confirm no residual FS plan writes. |
| CI grep-gate (NEW) | Add a lint that fails on any `docs/plans/` read outside `source.ts`; must be green before the Stage-2 git-rm. |

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
| `apps/operator-docs/.../spec/plan-format.mdx` | Heavy rewrite — strike "filesystem is canonical / no PG mirror"; document harness_plans substrate; keep the markdown format spec; update the chunked-write protocol (now PG). |
| `apps/operator-docs/.../agent-policies.mdx` (§18) | Replace FS path + "archive dir" with PG model (archival = archived flag); keep chunking guidance. |
| `prompts/papercusp-su-{engineer,power}.tools.md` | Update the hard apps/operator/docs/plans/<slug>.md references → "stored in PG, read/write via plans:*". |
| `prompts/kickoffs/new-plan.md`, `agent-insights/per-phase-execution-plan-template.mdx` | Drop explicit FS paths; slugs stay the identity. |
| `lib/testing-domains-registry.ts`, `libs/testing-shell/src/registry.ts` | Verify green — globs are by file path, unaffected. |
| Regenerate `apps/operator/public/internal/docs/**` mirror (npm run build in operator-docs) | Commit with the .mdx edits. |

### 12. Data + comment citations

| Place | Action |
|---|---|
| 219 `apps/operator/docs/plans/*.md` | Backfill → git rm (Stage 2) after the `plans-fs-retired-2026-06-03` tag, gated on lossless plan_revisions backfill + backup scope (D-003). Ship plans:export for on-demand files. |
| ~30 code files citing docs/plans/<slug>.md in comments | Leave as-is (slug is durable, resolvable via plans:get). Optional codemod only if zero dangling paths is wanted. |

## Risks

- **Renderer round-trip fidelity** — now isolated to **Stage 3 only** (was gating the whole migration); prose stays stored (D-006), so the renderer only synthesizes structured sections.
- **Read-before-write data-loss window** — **closed** by the Stage-1 atomic reads+writes flip + a re-run backfill immediately before cutover (D-002 / Stage 1). On this box the fleet writes plans every few minutes, so this was a real loss window, not theoretical.
- **Collision with storage-unification** — `table-registry.ts` edit + migration numbering overlap an active plan; mitigated by D-008 (coordinate first, ride their engine, un-pin the number) — **the top live risk; await su-08782 before Stage 0.**
- **PG becomes the only copy** — D-001 + D-004 (sync:none) remove git as both sync and offsite backup; gated by D-003's backup-scope requirement before any git-rm.
- **Missing `table-to-query-names` entries** → stale UI (no SSE refetch) — added in Stage 1.
- **`harness_plan_assertions` re-sync** — must be a status-preserving merge upsert, not a rebuild (D-007), or validator VAL-* statuses are wiped.

## Out of scope (pending owner decision)

- **Verb-surface cleanup** — collapsing the 18 single-field `set-*` writers into a smaller patch-style surface + fixing file/tool-name mismatches (`revisions-list.ts`→`plans:revisions`, `run-status.ts`→`plans:set-run-status`, etc.). Held out to keep tool names stable (tools-md-sync green, no UI churn). Stage-3+ follow-up; fold in only on owner's say-so.
- **Cross-machine plan sync (federation)** — deferred per D-004; a one-line `sync: peer-log` declaration on the storage-unification engine if/when required.

## Provenance

Audit method: 7 parallel read-only Explore agents over the plans tool surface (read/write/lifecycle), admin UI, routes/host/cross_harness, cross-cutting consumers, DB schema + parser lib + scripts, and tests/docs/prompts; operator-reconciled. **Revised after peer review (2026-06-03)** — verified the reviewer's three claims (mig 115 taken, storage-unification collision active, jsonb fixes real) and adopted: renderer decoupled to Stage 3 (#1), federation deferred (#2, D-004), read-before-write window closed via atomic flip (#3, Stage 1), migration number un-pinned + coordinate with su-08782 (#4, D-008), plus stage-numbering unification, D-006 prose-canonical refinement, assertions merge-not-rebuild, git-rm backfill+backup gate, content_hash clarification, CI grep-gate, and plans:export consumer check.
