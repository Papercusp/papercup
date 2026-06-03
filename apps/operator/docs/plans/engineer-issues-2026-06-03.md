---
title: Engineer issues — agent-facing issue surface, PG-canonical finish, and blocking edges
slug: engineer-issues-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: aviynw@gmail.com
companion-to: [coordination-substrate-2026-06-03, plans-pg-canonical-migration-2026-06-03]
---

# Engineer issues — agent-facing surface, PG-canonical finish, blocking edges

## Now

**State:** Draft 2026-06-03, grounded in a live-DB audit of the existing issues system (re-verified during the plan audit). Builds on [[coordination-substrate-2026-06-03]]; interplays with [[plans-pg-canonical-migration-2026-06-03]] (blocking edges) and features. No code yet.

**Next:** build after the substrate's Phase 0–1. The blocking edges are cleanest after plan items are structured (plans-pg Stage 3) but can land earlier keyed on `(plan_slug, P-NNN)`.

## Background — the gap + the audit truth

Agents discover problems mid-work and have nowhere to put them: `issues:list` is a dead stub returning `[]`; all writes are validator-pipeline-only via private `auth:'public'` HTTP routes; the project (`papercup`) harness's issue surface is empty (all 102 live rows are the `sheets` harness). The existing harness issues are **~60% PG-canonical** — intake (`harness_pending_issues`) + read + federation (`harness_issues_consolidated`: 102 rows, CDC + federation columns origin/author_pubkey/workspace_id) are PG; only the curated tracker is still `.harness/issues.json` FS-canonical with a best-effort PG mirror written by **application code** — `harness-issues.ts` `saveIssues` writes the JSON then `syncIssuesToPg(...)` ("JSON remains authoritative; PG is the read-side replica **via Zero**"); `promote-issue.ts` agrees. **Audit correction:** `harness_issues_consolidated` is populated by that app-code sync, **NOT by a live DB trigger** — the `sync_issues_consolidated` trigger (migration 030) is defined but **dormant** (attached to no per-harness table), and the mirror was built for a Zero read-side that is now retired. This is the exact "PG mirror where the file is primary" pattern CLAUDE.md forbids. Features already carry `source_plan_slug`, `source_plan_item_ids` (text[] of P-NNN), `blocked_by` (text[]). Plan items have `blocked-by: P-NNN` + an `effectiveStatus:'blocked'` resolver in `@papercusp/plan-parser`.

## Decisions

### D-001 — Separate engineer_issues table, shared shape in code (not one table)
2026-06-03

Engineer/SU-discovered issues are ad-hoc, often featureless, cross-cutting-capable, claimable, human-authored; pipeline issues are born in a validation round, auto-promote, per-harness, machine-authored. Different workflows → separate tables. But ONE shared TS shape (severity/status/source enums + field names) imported by both so they cannot drift. Rejected: extending the consolidated mirror (it's a derived mirror, not a store-of-record, and the auto-promote sweep would swallow engineer issues); a ground-up v2 rewrite of the pipeline (out of scope).

### D-002 — Build on the substrate
2026-06-03

An issue is `Subscribable + Taggable + Threadable (the notes/comment timeline) + Linkable + Claimable + Lifecycle` plus {severity, source=`engineer`|`su`, status, promote-to-feature}. Reuses the substrate's comment thread, topic routing (agents subscribed to a topic see new issues tagged it — this satisfies "others see them" + "pick them up later" with the same mechanism that routes questions), and subscription delivery.

### D-003 — Claim the issues:* MCP namespace (redefine the dead stub)
2026-06-03

`issues:list` is a non-functional stub and we are pre-alpha — redefine `issues:*` for this engineer-facing surface rather than inventing `eng_issues:*`. The validator pipeline keeps its private write path (no MCP verbs to collide with). Verbs: `create` / `list` / `get` / `update` / `comment` / `claim` / `release` / `close` / `link` / `promote` (+ `search`).

### D-004 — Finish the issues PG-canonical migration
2026-06-03

Make `harness_issues` the store-of-record: kill the `.harness/issues.json` FS-canonical write + the best-effort **app-code mirror** (`saveIssues`→`syncIssuesToPg`), route the curated writes (`createIssue`/`updateIssue`/`triage`) straight to PG, redefine the stale `issues:list`/consolidation stub, and enforce the severity/status enums with a DB CHECK — **but the existing tables hold drift rows (`severity='info'`, `status='acknowledged'`/`'resolved'`) and Postgres refuses a CHECK on a table with violating rows, so a data-cleanup migration must run FIRST** (normalize drift → canonical enum, verify zero violations) or use `ADD … NOT VALID` then `VALIDATE`; the NEW `engineer_issues` table starts clean and takes the CHECK at creation. Also resolve the **dormant** `sync_issues_consolidated` trigger (drop it, or wire it as the real consolidation path). This finishes the last mile the audit found; the engineer surface + the pipeline then share one PG store-of-record. (The mirror was built "via Zero", which is retired — extra reason to finish.)

### D-005 — Polymorphic many-to-many blocking edges
2026-06-03

An issue blocks a LIST of targets, polymorphic over `plan_item | feature` — a single PG edge (substrate Linkable / `issue_blocks`), NOT written into plan markdown. Closing an issue unblocks every target atomically (one row flip, no N-file edits). The edge is PROJECTED into the plan on read. **The `effectiveStatus` resolver is a PURE function** over a parsed plan (`@papercusp/plan-parser`, no DB/IO) — so it is NOT extended. Instead, at the `plans:*` operator call-sites (`plans:get`/`list`/`items`), AFTER `resolveEffectiveStatus(parsed)` we fetch the `issue_blocks` rows and **merge them post-resolution** (override an item's `todo → blocked` when it has an open blocking issue) — the exact pattern `plans:get` already uses to merge feature-links + test-status after resolution. The markdown `blocked-by: P-NNN` deps stay inside the pure resolver; the `add-item.ts` `/^P-\d{3,}$/` regex is **UNCHANGED** (issue blocks aren't authored via `blocked-by:`). So an open blocking issue makes a plan item non-actionable; closing it makes it pickable again. The feature edge reuses features' existing `blocked_by`/`source_plan_item_ids`.

## Build

### Phase 1 — Issues surface on the substrate
Migration `engineer_issues` (shared enums; scope discriminator `harness:<slug>`|`operator`; assignee, tags, federation columns) + the `issues:*` CRUD/claim/comment/close verbs (comment = Threadable; tags = Taggable; claim = Claimable). Redefine `issues:list`.

### Phase 2 — Blocking edges
The `issue_blocks` edge (issue → plan_item|feature, many-to-many); **merge it at the `plans:get`/`list`/`items` operator call-sites POST-resolution** (the pure resolver is untouched — D-005); project into the read output ("🚧 blocked by I-NNN"). This touches the same readers [[plans-pg-canonical-migration-2026-06-03]] Stage 1 rewrites to PG — sequence Stage 1 before/with this merge.

### Phase 3 — PG-canonical finish
Kill the `.harness/issues.json` write + the app-code mirror (`syncIssuesToPg`); route curated writes to PG; **normalize the existing severity/status drift, THEN add the enum CHECK** (PG rejects a CHECK on violating rows — D-004); reconcile the consolidated read path; resolve the dormant `sync_issues_consolidated` trigger. Can run parallel to Phase 1–2; sequence to avoid disrupting the live validator pipeline.

### Phase 4 — Promote
`issues:promote` → feature (reuse the existing F-FIX promotion path). Conversations promote INTO issues (from [[coordination-conversations-2026-06-03]]).

## Risks
- **Disrupting the live validator pipeline** — its write path (append-pending → triage → consolidated) must keep working through the PG-canonical finish; do Phase 3 carefully, behind integration tests (harness-plan-status-grants style).
- **Where the blocking merge lives** — the pure `@papercusp/plan-parser` resolver is UNCHANGED; the `issue_blocks` merge is in the operator readers (`plans:get`/`list`/`items`) post-resolution (D-005) — test it there, and sequence after plans-pg Stage 1 (same readers). The enum CHECK can't precede the drift cleanup (D-004).
- **Double-modeling** — features already track `source_plan_item_ids`; the issue→feature edge must not duplicate that relationship.

## Dependencies
Substrate; [[plans-pg-canonical-migration-2026-06-03]] (resolver + structured items); the existing federation outbox (issues already ride it).
