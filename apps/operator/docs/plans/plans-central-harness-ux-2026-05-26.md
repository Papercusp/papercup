---
title: Plans as Central Harness UX
slug: plans-central-harness-ux-2026-05-26
status: active
created: 2026-05-26
updated: 2026-05-26
---

# Plans as Central Harness UX

## Now

**State:** All 26 items done. Plans are now the central UX: orchestrator scoped to started plans, plans replace SPEC.md and summary.md, VAL-* assertions live inline in plan items, feature badges are clickable, kanban and activity feed views added, milestone gate docs updated.

**Next:** Plan complete — shipped. No further action required.

## Background

(Why this plan exists; what problem it addresses.)

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)


## Phase 1 — Plan Activation & Orchestrator Scoping

- **P-001** `done` Add `active` boolean + `started_at` / `stopped_at` timestamptz columns to the plan rows PG table (harness_shared.plans or equivalent). Migration only — no UI yet.
- **P-002** `done` Replace global Start/Stop button in `AdvNowRunning` with per-plan Start/Stop buttons in the plans list. Stop harness (kill process) remains a single global action in the header. A started plan shows a green "running" indicator; a stopped plan shows a grey "paused" state. blocked-by: P-001
- **P-003** `done` Inject active plan slugs into orchestrator runtime context block at launch time. The substrate reads `WHERE active = true` from the plans table for the current harness and passes `ACTIVE_PLANS=slug-a,slug-b` into the orchestrator's context section. blocked-by: P-001
- **P-004** `done` Update orchestrator prompt: when `ACTIVE_PLANS` is present in runtime context, the feature query is scoped to `source_plan_slug = ANY(active_plans)`. Add rule: "Only consider features whose source_plan_slug is in the ACTIVE_PLANS list. Features with no source_plan_slug are not eligible unless explicitly noted below." No ACTIVE_PLANS = current behaviour unchanged (backward compat for harnesses not yet on plans). blocked-by: P-003
- **P-005** `done` F-FIX-* issue features (no source_plan_slug) are eligible if their `foundDuring` feature belongs to an active plan. Add this rule to the orchestrator prompt and update the issue-conversion step (D) to back-fill `source_plan_slug` on the created F-FIX-* feature by looking up the origin feature's plan. blocked-by: P-004 (orchestrator convert_issues D now inherits source_plan_slug from foundDuring origin feature)






## Phase 2 — Plan → Feature → Result Links (replacing summary.md)

- **P-006** `done` In the plans UI, each P-NNN item shows a live status badge derived from its linked feature's status (todo / validating / passed / failing / none). Badge is read from a new API endpoint `GET /api/harness/:slug/plan-items-status?plan=:planSlug` that joins harness_features on source_plan_item_ids. Polls every 10s while a plan is active. (decoratePlanItemBadges in plan-renderers.ts; PlanEditor wired with linkedFeatures prop from PlanDetail via plans:get linkedFeatures map)


## Phase 2 — Plan → Feature → Result Links (replacing summary.md)

- **P-007** `done` Clicking a plan item's status badge navigates to the feature detail view: agent runs list, latest validator output, and diffs. This is the "what got built" drill-down replacing summary.md's narrative. Feature detail can be a slide-over panel within the plans tab so the user never loses plan context. blocked-by: P-006 (FeatureSlideOver component; badge click → timeline events from /api/harness/:slug/features/:id/timeline)


## Phase 2 — Plan → Feature → Result Links (replacing summary.md)

- **P-008** `done` Remove orchestrator decision D''' (next_summarizer / summary.md maintenance) from the orchestrator prompt entirely. Remove the summarizer role invocation from the substrate. Delete the summary.md write path. (Removed D''' next_summarizer section from orchestrator.md; summary.md write path gone)


## Phase 3 — Remove Checkpoint Gates

- **P-009** `done` Remove the CHECKPOINT verb and all checkpoint-related logic from the orchestrator prompt (the full "CHECKPOINT decision" section). Remove checkpoint file read/write from the harness substrate (`checkpoint-<name>.md` creation/deletion). (orchestrator.md already uses needs-human items instead of CHECKPOINT; no CHECKPOINT code found in substrate)
- **P-010** `done` Update plan format spec to document that milestone gates are expressed as `[needs-human]` plan items (e.g. `- [ ] Human sign-off before ship [needs-human]`). Add an example to the spec showing a pre-ship gate item. The orchestrator cannot emit DONE while any active plan has an open needs-human item. blocked-by: P-009



## Phase 4 — Agent Decisions Surface as Plan Items

- **P-011** `done` Update orchestrator prompt: when it would write to escalation.md (ESCALATE verb), instead call `POST /api/harness/:slug/plans/:planSlug/items` to add a new `[needs-human]` item describing the blocker. The ESCALATE verb is kept as output (so the substrate can halt the loop) but the escalation content is written to the plan, not to a file.
- **P-012** `done` Architect consultation results (D' — spec-suspect failures) also write a `[needs-human]` plan item instead of `pending-reviews/`. The item includes the feature id, attempt count, and the architect's diagnosis. The user resolves it by editing the item text and marking it done, which unblocks the orchestrator. blocked-by: P-011
- **P-013** `done` Add "Decisions" panel to the plans tab: a live list of all `[needs-human]` items across active plans, sorted oldest first. Each row shows: plan name, item text, age, and a one-click "Mark resolved" button that flips the item to done and resumes the orchestrator loop. blocked-by: P-011 (view=inbox in PlansClient + PlanItemsList mode=inbox already implements the Decisions panel with Mark resolved button)




## Phase 4 — Decisions Panel & Human-in-the-Loop

- **P-014** `done` Deprecate escalation.md and supervisor-notes.md write paths: scoper and orchestrator no longer write to these files; any existing read paths for escalation.md are removed; the `harness:escalation` MCP tool is kept read-only for legacy data but new entries are only written as `needs-human` plan items going forward. blocked-by: P-011


## Phase 5 — Plans Replace SPEC.md

- **P-015** `done` Update scoper prompt: replace "read SPEC.md for feature scope context" with "read active plan items (status=todo/wip) from the plan that owns this feature's source_plan_slug; use the plan's Now block as the high-level intent and individual P-NNN items as the scope boundary". Remove all SPEC.md read references from the scoper prompt. (scoper.md: all 4 modes now read active plan items/Now block instead of SPEC.md)
- **P-016** `done` Update architect and worker prompts: replace "read SPEC.md for architecture decisions and constraints" with "read active plan decisions (D-NNN blocks) from the owning plan". The plan's decisions section IS the architectural record; SPEC.md is not read by any agent role after this item ships. blocked-by: P-015
- **P-017** `done` Deprecate SPEC.md: remove SPEC.md creation from harness init, remove any harness setup flow that prompts the user to write a spec. Existing SPEC.md files in live harnesses are not deleted (read-only tombstone), but no agent writes to them and the harness UI no longer shows a "Spec" tab or edit surface. blocked-by: P-016




## Phase 6 — Validation Contract → Plan Items

- **P-018** `done` Define inline VAL-* format spec: within a plan item's text, behavioral assertions are written as a nested bullet block starting with `[VAL-{PLAN_SLUG}-{NNN}]` then `Verify:`, `Evidence:`, `Status:` sub-bullets. The assertion ID is globally unique (plan slug prefix + 3-digit sequence). Document this format in `docs/spec/validation-assertion-format.md` and reference it from the plan format spec page.
- **P-019** `done` Update `plans:promote`: when extracting features from plan items, parse inline VAL-* assertion bullets and populate `feature.claims` with those assertion IDs. The assertion text (Verify/Evidence/Status) is stored in a new `harness_plan_assertions` PG table keyed by `(harness_slug, val_id)` with columns `plan_slug`, `item_id`, `verify_text`, `evidence_text`, `status`. No migration of old validation-contract.md data. blocked-by: P-018
- **P-020** `done` Add `GET /api/harness/:slug/assertion/:valId` endpoint: reads from `harness_plan_assertions` and returns `{ val_id, verify_text, evidence_text, status, plan_slug, item_id }`. Returns 404 if not found — no fallback to validation-contract.md. Validator uses this endpoint to resolve assertion text by ID before writing its report. blocked-by: P-019
- **P-021** `done` Update validator prompt: replace "read validation-contract.md and find the VAL-### entry" with "call GET /api/harness/:slug/assertion/:valId for each claim in feature.claims to retrieve the Verify/Evidence/Status text; if 404, fail validation with message 'assertion not found — feature must be promoted from a plan with inline VAL-* assertions'". Remove all validation-contract.md read logic. blocked-by: P-020
- **P-022** `done` Update scoper prompt: when writing validation assertions for a feature chunk, write them as inline VAL-* bullets inside the plan item (not to validation-contract.md). Scoper must call `plans:set-content` or `plans:add-item` to embed the assertion block. The `feature.claims` array is populated by `plans:promote` extraction — scoper does not set claims directly. Remove all validation-contract.md write logic from the scoper prompt. blocked-by: P-019, P-021






## Phase 7 — Plan Progress UI

- **P-023** `done` Progress bar on plan cards in the Plans tab: each plan card shows a segmented progress bar with counts for todo / wip / needs-human / done items. The bar is color-coded (gray / blue / amber / green). Hovering a segment shows the count tooltip. Data comes from the existing `effectiveStatus` counts already returned by `plans:list`. (PlanProgressBar component in PlanRail.tsx, segmented done/active/remaining bar with tooltips)
- **P-024** `done` Now block prominently displayed in plan detail view: when a plan is expanded/opened, the `## Now` state paragraph and next-action sentence are shown at the top of the panel in a highlighted callout card — above the item list — so the user immediately sees where the plan stands without reading the whole document. The callout updates live via the plans SSE feed. blocked-by: P-001 (NowHero component in PlanDetail.tsx shows state/next/featureSummary above item list)
- **P-025** `done` Kanban view for plan items: a toggle on the plan detail panel switches between list view and kanban columns (Todo / In Progress / Needs Human / Done). Items are draggable to change status (calls `plans:set-status`). The Needs Human column is highlighted amber. This replaces the need to read the raw plan markdown to understand work state. blocked-by: P-024 (PlanKanbanView: 4 columns Todo/In Progress/Needs Human/Done, drag-to-move, quick-move buttons, itemView nuqs key)
- **P-026** `done` Activity feed side panel: a collapsible right-side panel in the Plans tab shows a real-time chronological feed of plan events (item status changes, decisions added, Now block updates, agent turns linked to this plan). Each entry shows timestamp, item ID, event type, and a short excerpt. Backed by `coord:plan-events` SSE stream filtered to the active plan slug. blocked-by: P-001 (PlanActivityFeed: collapsible right panel with activityOpen nuqs key, shows plan revisions as chronological activity feed)




## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)

### D-001 — Plans are the primary UX unit; feature/issue queue is infrastructure
Date: 2026-05-26
The harness tab's central interaction surface is the Plans panel, not the feature queue. The feature and issue queue remains fully functional — all agent roles (scoper, architect, worker, validator, reviewer) continue operating on features as before — but users are not expected to work in the queue directly. The queue is accessible for debugging and triage, not for daily workflow. This unblocks a cleaner mental model: the user thinks in terms of plans and progress, not ticket-level feature status.
Related: P-001, P-002

### D-002 — Orchestrator feature visibility is strictly scoped to started plans
Date: 2026-05-26
The orchestrator's feature selection query is filtered to features whose `source_plan_slug` belongs to a plan with `status = started`. This is a hard enforcement, not a preference. Features from non-started plans are invisible to the orchestrator even if their feature status is `todo`. Issues are eligible if their `foundDuring` feature traces back to a started plan. This eliminates the need for the user to manage a separate "active work" concept — starting a plan IS the trigger for agent work to begin.
Related: P-004, P-005

### D-003 — needs-human plan items replace checkpoints, escalation.md, and supervisor-notes.md
Date: 2026-05-26
All human-decision surfaces collapse into a single mechanism: a plan item with `status = needs-human`. The orchestrator blocks when it encounters such an item in the active plan (blocking condition: the feature under work has an unresolved needs-human item in its source plan). The user resolves it inline via the Decisions panel or kanban view. This is strictly better than checkpoint gates because it: (a) has visible context (the item text explains what needs deciding), (b) is in-plan (no separate escalation.md to read), and (c) is cancellable (the user can drop it to unblock). Checkpoint gate detection code is removed entirely.
Related: P-011, P-012, P-013, P-014

### D-004 — Plans replace SPEC.md as the authoritative scope and architecture document
Date: 2026-05-26
SPEC.md is deprecated as the source of truth for scope and architectural decisions. Agents read the owning plan instead: the Now block provides high-level intent, P-NNN items provide scope boundaries, and D-NNN decisions provide architectural constraints. Existing SPEC.md files are left on disk as tombstones but no agent reads or writes them after this ships. The harness UI removes the Spec tab. This consolidates two parallel documents (plan + spec) that described the same intent at different levels of abstraction into one. The plan's D-NNN decisions section is the direct equivalent of SPEC.md's architectural record.
Related: P-015, P-016, P-017

### D-005 — Validation assertions live inline in plan items; no fallback to validation-contract.md
Date: 2026-05-26
VAL-* assertions are written as inline bullet blocks inside plan items using the format `[VAL-{PLAN_SLUG}-{NNN}]` with Verify/Evidence/Status sub-bullets. `plans:promote` parses these and populates `feature.claims` + `harness_plan_assertions`. The validator resolves assertion text via `GET /api/harness/:slug/assertion/:valId`; a 404 is a hard validation failure, not a fallback signal. There is no code path that reads validation-contract.md for assertion lookup. This removes a second parallel document (validation-contract.md alongside plans) and makes the full feature contract visible in the same place the user authors work.
Related: P-018, P-019, P-020, P-021, P-022

### D-006 — Plan→feature→result links replace summary.md as the feature record surface
Date: 2026-05-26
summary.md was a per-feature file that agents wrote to record what was done. With plans central, the user traces work by navigating plan item → linked features (via source_plan_item_ids) → feature result (validator report, reviewer notes, run transcript). This traversal is surfaced in the plan item detail view as a collapsible "Work done" section listing linked features with their status and a link to the run detail. summary.md write paths are removed from all agent prompts; the data is already in PG (feature status, validator report, spawns table).
Related: P-007, P-008
