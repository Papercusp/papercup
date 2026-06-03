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

**State:** Draft 2026-06-03, grounded in a live-DB audit of the existing issues system. Builds on [[coordination-substrate-2026-06-03]]; interplays with [[plans-pg-canonical-migration-2026-06-03]] (blocking edges) and features. No code yet.

**Next:** build after the substrate's Phase 0–1. The blocking edges are cleanest after plan items are structured (plans-pg Stage 3) but can land earlier keyed on `(plan_slug, P-NNN)`.

## Background — the gap + the audit truth

Agents discover problems mid-work and have nowhere to put them: `issues:list` is a dead stub returning `[]`; all writes are validator-pipeline-only via private HTTP routes; the project (`papercup`) harness's issue surface is empty. The existing harness issues are **~60% PG-canonical** — intake (`harness_pending_issues`) + read + federation (`harness_issues_consolidated`: 102 rows, CDC + federation columns) are PG; only the curated tracker is still `.harness/issues.json` FS-canonical with a two-layer PG mirror (`harness-issues.ts` + `promote-issue.ts` explicitly call JSON authoritative — the exact "PG mirror" pattern CLAUDE.md forbids). Features already carry `source_plan_slug`, `source_plan_item_ids` (P-NNN array), `blocked_by`. Plan items have `blocked-by: P-NNN` + an `effectiveStatus:'blocked'` resolver in `@papercusp/plan-parser`.

## Decisions

### D-001 — Separate engineer_issues table, shared shape in code (not one table)
2026-06-03

Engineer/SU-discovered issues are ad-hoc, often featureless, cross-cutting-capable, claimable, human-authored; pipeline issues are born in a validation round, auto-promote, per-harness, machine-authored. Different workflows → separate tables. But ONE shared TS shape (severity/status/source enums + field names) imported by both so they cannot drift. Rejected: extending the SELECT-only consolidated mirror (entangling, and the auto-promote sweep would swallow engineer issues); a ground-up v2 rewrite of the pipeline (out of scope).

### D-002 — Build on the substrate
2026-06-03

An issue is `Subscribable + Taggable + Threadable (the notes/comment timeline) + Linkable + Claimable + Lifecycle` plus {severity, source=`engineer`|`su`, status, promote-to-feature}. Reuses the substrate's comment thread, topic routing (agents subscribed to a topic see new issues tagged it — this satisfies "others see them" + "pick them up later" with the same mechanism that routes questions), and subscription delivery.

### D-003 — Claim the issues:* MCP namespace (redefine the dead stub)
2026-06-03

`issues:list` is a non-functional stub and we are pre-alpha — redefine `issues:*` for this engineer-facing surface rather than inventing `eng_issues:*`. The validator pipeline keeps its private write path (no MCP verbs to collide with). Verbs: `create` / `list` / `get` / `update` / `comment` / `claim` / `release` / `close` / `link` / `promote` (+ `search`).

### D-004 — Finish the issues PG-canonical migration
2026-06-03

Make `harness_issues` the store-of-record: kill `.harness/issues.json` FS-canonical + the mirror trigger, route the curated writes (`createIssue`/`updateIssue`/`triage`) to PG, redefine the stale `issues:list`/consolidation stub, and enforce the severity/status enums (currently drifted — `info`, `resolved` appear with no DB constraint). This finishes the last mile the audit found; the engineer surface and the pipeline then share one PG store-of-record.

### D-005 — Polymorphic many-to-many blocking edges
2026-06-03

An issue blocks a LIST of targets, polymorphic over `plan_item | feature` — a single PG edge (substrate Linkable / `issue_blocks`), NOT written into plan markdown. Closing an issue unblocks every target atomically (one row flip, no N-file edits). The edge is PROJECTED into the plan on read and FEEDS the existing `effectiveStatus:'blocked'` resolver (which today only accepts `/^P-\d{3,}$/` — extend it to accept issue refs). So an open blocking issue makes a plan item non-actionable; closing it makes it pickable again — for free, on existing machinery. The feature edge reuses features' existing `blocked_by`/`source_plan_item_ids`.

## Build

### Phase 1 — Issues surface on the substrate
Migration `engineer_issues` (shared enums; scope discriminator `harness:<slug>`|`operator`; assignee, tags, federation columns) + the `issues:*` CRUD/claim/comment/close verbs (comment = Threadable; tags = Taggable; claim = Claimable). Redefine `issues:list`.

### Phase 2 — Blocking edges
The `issue_blocks` edge (issue → plan_item|feature, many-to-many); extend the `effectiveStatus` resolver to accept issue refs; project into `plans:get`/`plans:items` ("🚧 blocked by I-NNN"). Coordinate the resolver change with [[plans-pg-canonical-migration-2026-06-03]] (cleanest after items are PG rows).

### Phase 3 — PG-canonical finish
Kill `issues.json` + the mirror trigger; route curated writes to PG; enforce enums; reconcile the consolidated read path. Can run parallel to Phase 1–2; sequence to avoid disrupting the live validator pipeline.

### Phase 4 — Promote
`issues:promote` → feature (reuse the existing F-FIX promotion path). Conversations promote INTO issues (from [[coordination-conversations-2026-06-03]]).

## Risks
- **Disrupting the live validator pipeline** — its write path (append-pending → triage → consolidated) must keep working through the PG-canonical finish; do Phase 3 carefully, behind integration tests (harness-plan-status-grants style).
- **Resolver change blast radius** — accepting issue refs in `effectiveStatus` touches the shared `@papercusp/plan-parser`; gate with its round-trip/property tests.
- **Double-modeling** — features already track `source_plan_item_ids`; the issue→feature edge must not duplicate that relationship.

## Dependencies
Substrate; [[plans-pg-canonical-migration-2026-06-03]] (resolver + structured items); the existing federation outbox (issues already ride it).
