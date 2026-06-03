---
title: Plans → PG-canonical, markdown rendered on-demand — full migration plan
slug: plans-pg-canonical-migration-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: aviynw@gmail.com
companion-to: [coordination-substrate-2026-06-03]
---

# Plans → PG-canonical, markdown rendered on-demand

## Now

**State:** Draft, **fully owned by me** — su-08782 (storage-unification) went idle and the owner authorized me to revise this plan without coordination. Two owner directives folded into this revision: **(1) federation is PRESERVED & adapted, not deferred** (D-004 reversed); **(2) I'm authoritative** on the table-registry / migration-number / projection-engine calls (D-008 reversed). Direction approved: PG is the single source of truth; markdown rendered on demand, dropped from git (Option A).

**Next:** owner review; then **Stage 0** (additive: migration + generated schema + FS→PG backfill + the renderer's round-trip property test). No longer blocked on any other agent.

## Background — why

Today a plan is a filesystem-canonical markdown file at `apps/operator/docs/plans/<slug>-<YYYY-MM-DD>.md` (219 of them). The original design declared "the filesystem is canonical — no PG table, git history is the audit trail." That has already eroded: operational status + priority live in PG (`harness_plan_status`), a per-write revision spine lives in PG (`plan_revisions`), and `list.ts` carries a `reconcileStartStatus` self-heal hack for the FS↔PG drift the pure-FS design was meant to prevent. Going PG-canonical finishes a migration that already leaked: one indexed source of truth, parity with features (`harness_features_consolidated`), the drift hack deleted, cross-harness aggregation as one SQL query.

## Decisions

### D-001 — PG-canonical, markdown rendered on demand, dropped from git (Option A)
2026-06-03

A new PG table `harness_shared.harness_plans` is the single source of truth. Markdown is produced on demand by `plans:get` / the admin UI / `plans:export`; the 219 tracked files are removed after backfill. Rejected: (B) generate `.md` as a tracked one-way artifact (still a mirror); (C) keep FS-canonical (doesn't scale, inconsistent with features).

### D-002 — Two stages: lift-and-shift, then normalize
2026-06-03

Through the file-removal stage the markdown **blob is canonical** in `harness_plans.content`: reads return it, writes splice it (today's logic, persisted to PG) — no renderer dependency. The optional normalize stage moves the *queryable* parts (items/decisions/now) into columns as a derived index; the prose body stays canonical (D-006). The renderer is required only at normalize.

### D-003 — Remove the git-history surface; plan_revisions is the audit trail; git-rm gated
2026-06-03

Once files leave git, `plans:history`/`diff`/`plan-git.ts`/`/api/admin/plans/git/*` have no meaning; `plan_revisions` (PG, full snapshots per write) is the audit trail. The `git rm` is gated on (a) a verified-lossless backfill of git plan-history into `plan_revisions` and (b) `harness_plans` confirmed in `backup:*` scope.

### D-004 — Federation PRESERVED & adapted to PG-canonical (REVERSES the earlier deferral)
2026-06-03

**Per owner: the federation feature cannot be removed. This supersedes the prior reviewer-driven "defer / sync: none / drop the hyperbee work" decision.** Plans federate via the **peer-log / CDC-outbox projection** — the coordination substrate's federation framework ([[coordination-substrate-2026-06-03]] D-009) — replacing git-as-sync. Concretely, `harness_plans` joins the federated table set: registered in the wire-outbox table-tag map + a plans projection module, carrying the `origin='remote'` echo-guard, the AFTER-UPDATE `WHEN OLD.* IS DISTINCT FROM NEW.*` trigger guard, and the jsonb-binding fixes (`agent-insights/postgres-js-jsonb-binding`) so the CDC round-trip reaches a fixed point and the outbox does not self-amplify. LWW conflict resolution per Model-B. Net: cross-machine plan sync is RESTORED (the original git→peer-log intent), now over PG-canonical content. So PG is **not** the only copy — peers hold federated copies — though D-003's backup requirement still applies. Note the plan content blob is large to ship per write; acceptable, but a reason the normalize stage (smaller structured deltas) is desirable later.

### D-005 — Concurrency: version-column CAS is the guard; advisory lock only for ID allocation
2026-06-03

Replace the FS `O_EXCL` lock with a PG advisory lock on `(harness_slug, plan_slug)`; the real guard is optimistic `version`-column CAS (matches today's "CAS not the lock" note). `expectedHash` → `expectedVersion`. `content_hash` kept only if a consumer needs it; else vestigial.

### D-006 — Prose body stays canonical; only queryable parts become a derived index
2026-06-03

At normalize, structure only the queryable sections (items/decisions/now) into columns as a derived index; keep the prose body canonical in TEXT. `parse(render(parse(x))) ≡ parse(x)` proves semantic stability, not byte-fidelity of free prose — so the renderer never reproduces prose. (Tempers the "markdown fully generated from PG" framing: prose is stored, structured sections are generated.)

### D-007 — What does NOT migrate
2026-06-03

Only plan content + `harness_plan_status` move into `harness_plans`. Survive unchanged: `plan_events` (coord log), `plan_revisions` (audit), `harness_plan_review` (architect gate), `plan_runs`/`plan_run_turns` (execution). `harness_plan_assertions` (VAL-*) stays a projected child table, re-synced on plan write as a **status-preserving merge upsert**, not a rebuild.

### D-008 — I own this plan + the table-registry / migration / engine calls (su-08782 idle)
2026-06-03

**Reverses the prior "coordinate with su-08782 / hold the registry edit / await reply" decision** — su-08782 went idle and the owner put me in charge with no coordination. So I decide directly: (a) take the next free migration # via `db:check_drift` at implementation (115–117 taken); (b) classify `harness_plans` in `table-registry.ts` myself (workspace-owned; sync: **peer-log** per D-004); (c) build the fan-out + federation projections on the **existing** features/issues federation machinery (`wire-outbox`/`feature-issue-op-keys` + per-table projection modules), generalizing opportunistically — not waiting on any in-flight engine refactor.

## Stages — build sequence

- **Stage 0 — Foundation (additive; NO renderer gate):** add the `harness_plans` migration (next free # via `db:check_drift`) + generated drizzle schema; write the FS→PG backfill (parse all 219 → upsert; PG shadow, FS still canonical). The renderer is NOT built/gated here — it is normalize-only.
- **Stage 1 — Atomic reads+writes flip (one commit/restart):** `source.ts` + all read/write tools + cross_harness + admin/coord/bootstrap-su routes move to PG in a single change; `with-plan-lock` → advisory + `version` CAS; `plans-api.ts` `contentHash`→`version`; delete `plan-git.ts`; repoint `plans:history`/`diff` → `plan_revisions`; add `table-to-query-names` + `harness-state` registry entries. **Re-run the backfill immediately before the flip** (closes the read-before-write data-loss window).
- **Stage 2 — Remove files + cut sync to peer-log + docs:** verify the lossless `plan_revisions` git-history backfill + `harness_plans` in `backup:*` scope; **bring up the plans federation projection (peer-log) BEFORE removing files** (git-as-sync must not drop until peer-log replaces it — D-004); tag `plans-fs-retired-2026-06-03`, then `git rm` the 219 files; retire `source.ts` FS paths; rewrite docs/prompts; ship `plans:export`. Add the CI grep-gate "zero `docs/plans/` reads outside `source.ts`".
- **Stage 3 — (OPTIONAL) Normalize:** structure items/decisions/now into columns (derived index; prose stays canonical, D-006); build `renderPlanMarkdown` + the `fast-check` round-trip property test over all 219 — the only stage gated on renderer fidelity. Smaller structured deltas also lighten federation ship cost (D-004).

## Migration inventory — every place

Coverage: ~120 functional files across 12 subsystems + 219 data files + ~30 comment-only citations.

### 1. Storage substrate — schema, migrations, parser/renderer
| Place | Action |
|---|---|
| `libs/papercusp/libs/db/sql/<NNN>-harness-plans.sql` (NEW; next free #, verify via db:check_drift) | Create `harness_shared.harness_plans` (PK `workspace_id,harness_slug,plan_slug`; frontmatter cols; `content` TEXT canonical; `version` BIGINT CAS; `op_status`/`op_status_at` folded from harness_plan_status; `archived`,`is_legacy`; `_search` tsvector + GIN; RLS + grants; federation columns `origin`/`author_pubkey`/`workspace_id` mirroring the consolidated tables per D-004). Classify in `table-registry.ts` (workspace-owned; sync: peer-log). |
| `libs/papercusp/libs/db/src/schema/{schema,generated}.ts` | Add `harnessPlansInHarnessShared`; run pull-schema.mjs. Verify the `primaryKey` import survives regen (a prior regen dropped it → fleet crash-loop). |
| `harness_plan_status` (mig 086) | Fold into harness_plans; stop writing the standalone table post-backfill. |
| `harness_plan_assertions` (migs 087/088) | Keep as a projected child table; status-preserving merge upsert on plan write (D-007). |
| `harness_plan_review`, `plan_revisions`, `plan_runs`/`plan_run_turns` | No change — separate tables, survive. |
| `libs/generic/plan-parser/src/renderer.ts` (NEW) + `renderer.test.ts` | Stage 3 ONLY. `renderPlanMarkdown(structured)→markdown` for the queryable sections (NOT prose). Gate Stage 3 with the round-trip property test over all 219. |
| `libs/generic/plan-parser/src/{index,parser,effective-status,content-hash}.ts` | No change. |

### 2. Plan read tools — `apps/operator/lib/agent-tools/plans/`
| File | Action |
|---|---|
| `source.ts` | Cutover point: FS walk → PG selects; `resolveHarnessPlansDir` retained as a slug validator only; delete FS-walk code (Stage 1), final retirement Stage 2. |
| `_ctx-opts.ts` | Reduce to `{ harnessSlug }`. |
| `list.ts` | FS walk + per-slug status join → single SQL; **delete reconcileStartStatus** (op_status is a column). |
| `get.ts` | readPlanBySlug → SELECT content (blob through Stage 2); contentHash field → version. |
| `items.ts` | Stage 1: parse from blob; Stage 3: read structured columns. |
| `search.ts` | In-memory TF scoring → PG tsvector / ts_rank_cd. |
| `attention.ts`, `lint.ts`, `context-bundle.ts` | Read from PG; smoke/review/revisions subqueries unchanged. |
| `history.ts`, `git-history.ts`, `diff.ts` | Remove git surface (Stage 1); repoint to plan_revisions. |
| `effective-status.ts`, `parser.ts`, `content-hash.ts`, `val-assertions.ts`, `for-each-resolver.ts`, `read-dispatch.ts`, `_harness-scope.ts` | No change. |

### 3. Plan write + lifecycle tools + concurrency
| File | Action |
|---|---|
| `with-plan-lock.ts` | FS lock → advisory lock + version CAS (D-005). |
| `set-content.ts`/`set-content-chunk.ts` | Write content column; expectedHash→expectedVersion; same lint + legacy guards; stale-response shape unchanged. |
| `set-status`/`set-importance`/`set-now`/`add-item`/`add-decision`/`set-frontmatter`/`set-plan-status` | Stage 1: splice blob then upsert; Stage 3: mutate structured columns; ID allocation inside the advisory lock; each records a plan_revisions row. |
| `new.ts` | INSERT row instead of writing a file. |
| `start`/`pause`/`set-priority`/`plan-start-state` | Already PG → point at the folded columns. |
| `launch`/`resume`/`turn`/`runs(-list)`/`run-status`/`run-transcript` | No change to run lifecycle; only the body source moves FS→PG. |
| `revisions*` | No change; `revisions-backfill` (git→PG) is promoted to a verified-lossless gate for the Stage-2 git-rm. |
| Write-tool `filePath` return | Drop or return a synthetic path. |

### 4. cross_harness tools
| File | Action |
|---|---|
| `cross_harness/plans_{list,get,search}.ts` | Drop FS fan-out → single SQL `WHERE harness_slug = ANY(...)`; preserve cross-workspace resolveProject as a WHERE filter. |

### 5. HTTP routes + host + registration
| File | Action |
|---|---|
| `routes/admin/plans.ts` | Thin dispatch envelope — unchanged; keep SSE invalidations (fire on PG write). |
| `routes/admin/plan-git.ts` + `/api/admin/plans/git/*` | Delete (Stage 1). |
| `routes/coord/index.ts` (`/coord/plans`, `/coord/plans/:slug`) | readAll/readBySlug → SQL; return the blob for the detail. |
| `routes/agent-mcp/bootstrap-su.ts` (options) | Plan picker: FS walk → SELECT from harness_plans. |
| `routes/internal/plan-review-event.ts`, `bin/host-bootstrap.ts`, `agent-tools/index.ts` | No change (tool names stable). |

### 6. Admin UI — `app/admin/plans/` + `operator-vite/.../plans.tsx`
| File | Action |
|---|---|
| `plans-api.ts` | The one substantive UI change: routes repoint transparently; contentHash→version, expectedHash→expectedVersion; staleConflictOf/writeErrorOf already defensive. |
| `PlanConflictModal`, `RunDetailPanel` (stale badge) | CAS field rename only. |
| `PlanEditor` (vditor) | Keep; saving writes the content column, not a file. |
| Revisions/runs panels + all other admin/plans components | No change (already PG / route through plans-api). |

### 7. Cross-cutting consumers
| File | Action |
|---|---|
| `lib/sync-resolver/index.ts` | plans.* queries hydrate from PG; no contract change. |
| `lib/sync-resolver/table-to-query-names.ts` | Add harness_plans→[plans.get,plans.list], plan_revisions→[plans.revisions], plan_runs→[plans.runs]. |
| `lib/harness-state/table-registry.ts` | Classify harness_plans (workspace-owned; sync: peer-log per D-004) — I own this edit (D-008). |
| `lib/harness-fs-watcher.ts` | No change (does not watch plan files). |
| `lib/plan-context-for-feature.ts` | readPlanBySlug → PG. |
| `lib/memory/audit-anchors.ts` | kind:'plan' anchors → harness_plans.slug existence check. |
| architect/plan-block-handler, coordination promote/handoff/plan-events/watermark-set, harness/plan_reviews, attention/*, dbos/*, orchestrator state-pg, generators/publish, harness-activity/load, operator-continue-chains, docs/_engineering-adapter, search/*, agent-kickoff/prompt-file | No change (dispatch to tools / carry refs / no plan-content reads). |

### 8. Cross-machine sync — federation projection (IN SCOPE; was deferred)
| File | Action |
|---|---|
| `lib/sync/hyperbee/feature-issue-op-keys.ts` | Add `harness_plans → 'plans-by-slug'` to the table-tag map. |
| `lib/sync/hyperbee/wire-outbox.ts` + new `projections/harness-plans.ts` | Register the plans projection (model on features/issues): bind jsonb as `${JSON.stringify(x)}::jsonb`, `normalizeJsonbInput()`, origin echo-guard, AFTER-UPDATE `WHEN OLD.* IS DISTINCT FROM NEW.*`, recompute `_search` locally, mind the large content blob per write (`agent-insights/postgres-js-jsonb-binding`). Backfill enqueues existing rows; drain LISTENs on `harness_plans.changed`. |
| `lib/sync/hyperbee/boot.ts` | Wire the projection into per-harness boot. Bring this up in Stage 2 **before** the git-rm. |

### 9. Scripts
| File | Action |
|---|---|
| `scripts/backfill-fs-plans-to-pg.ts` (NEW) | Parse all 219 → upsert; run at Stage 0 (shadow) AND immediately before the Stage-1 flip. |
| `scripts/lint-plans.ts` (CI gate) | FS scan → plans:lint over PG. |
| `scripts/migrations/backfill-plan-promoted-blocks.ts`, `_audit-write.ts`, `_smoke.ts` | Minor/none. |
| CI grep-gate (NEW) | Fail on any `docs/plans/` read outside `source.ts`; green before the Stage-2 git-rm. |

### 10. Tests
| File | Action |
|---|---|
| `plans/__tests__/resolve-harness-plans-dir.test.ts` | Delete (dir resolution removed). |
| `plans/__tests__/concurrency.test.ts` | Rewrite for PG version-CAS / advisory lock. |
| `plans/__tests__/e2e.test.ts` | Refactor: keep slug path-traversal + parser; FS→PG. |
| `cross_harness/__tests__/plans.test.ts` | Rewrite temp-FS → PG fixtures. |
| `set-status`/`start-guard`/`plan-start-state`/`plan-context-for-feature.test` | Minimal — swap mocked readPlanBySlug source. |
| pure/already-PG tests + `e2e/plan-agent-launch.spec.ts` + `harness-plan-status-grants.integration` + `tools-md-sync` | Verify green. |

### 11. Docs / prompts / registries
| File | Action |
|---|---|
| `spec/plan-format.mdx` | Heavy rewrite — strike "filesystem is canonical"; document harness_plans substrate + peer-log federation; keep the markdown format spec; update the chunked-write protocol. |
| `agent-policies.mdx` (§18), `papercusp-su-{engineer,power}.tools.md`, `kickoffs/new-plan.md`, `per-phase-execution-plan-template.mdx` | Replace FS path refs with the PG model. |
| `testing-domains-registry.ts`, `testing-shell/registry.ts` | Verify green (globs unaffected). |
| Regenerate `public/internal/docs/**` mirror | Commit with the .mdx edits. |

### 12. Data + comment citations
| Place | Action |
|---|---|
| 219 `docs/plans/*.md` | Backfill → git rm (Stage 2) after the tag, gated on lossless backfill + backup scope + peer-log federation live (D-003/D-004). Ship plans:export. |
| ~30 code files citing `docs/plans/<slug>.md` in comments | Leave as-is (slug durable). Optional codemod only if zero dangling paths wanted. |

## Risks
- **Renderer round-trip fidelity** — isolated to Stage 3 only; prose stays stored (D-006).
- **Read-before-write data-loss window** — closed by the Stage-1 atomic flip + re-run backfill.
- **Federation cutover ordering** — peer-log MUST be live before the git-rm drops git-as-sync (Stage 2); otherwise a window with no cross-machine sync. Bring up the projection first, verify a two-peer round-trip, then remove files.
- **Outbox self-amplification** — the plans projection must carry the jsonb-binding fixes + the AFTER-UPDATE-DISTINCT guard, or the large content blob re-upserts forever (D-004).
- **Missing `table-to-query-names` entries** → stale UI; added in Stage 1.
- **`harness_plan_assertions` re-sync** — status-preserving merge, not rebuild (D-007).

## Out of scope (pending owner decision)
- **Verb-surface cleanup** — collapsing the 18 single-field `set-*` writers + fixing file/tool-name mismatches. Held out to keep tool names stable (tools-md-sync green). Stage-3+ follow-up.

## Provenance
Audit method: 7 parallel read-only Explore agents over the plans surface; operator-reconciled. **Revised twice on 2026-06-03:** (1) after peer review (renderer decoupled to normalize, read-before-write window closed, D-006 prose-canonical, assertions merge, git-rm gated); (2) per owner directives — **federation PRESERVED & adapted to a peer-log projection (D-004 reversed)** and **full ownership with no coordination (D-008 reversed; su-08782 idle).**
