---
title: Planning tab: importance levels + unified attention items
slug: planning-attention-importance-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: aviynw3@gmail.com
---

# Planning tab: importance levels + unified attention items

## Now

**State:** Draft for review. Audit (2026-05-30) found the escalation→needs-human
folding already shipped (`plans-central-harness-ux-2026-05-26` D-003; items
P-010–P-014 all done): ESCALATE, architect-REVIEW (spec-suspect), `escalation.md`,
`supervisor-notes.md`, and `pending_reviews` already become `needs-human` plan
items, shown in the inbox view with a Mark-resolved button. So the data
consolidation is largely done. The remaining gaps are: (1) no importance level on
items anywhere, (2) no generic item type, so the remaining live escalation surface
(coord escalations) does not render in the same view, (3) the "Needs Decision"
filter is mislabeled, (4) no cross-harness attention view, (5) operator/orchestrator
do not read importance.

**Next:** Review the Decisions — especially open D-006 (fold coord escalations?)
and D-007 (push delivery scope) — and the two `needs-human` sign-off items
(P-020, P-022), then flip status to `ready`.

## Background

The user asked whether the app's many "alert the human" surfaces are all updated
to use the plans needs-human inbox, whether they fold in well, and to add an
importance level (+ an agent rubric to set it) that the operator/orchestrator also
read. Audit of the surfaces found:

- **Already folded into needs-human items** (shipped, `plans-central-harness-ux`):
  orchestrator ESCALATE, architect REVIEW / spec-suspect, `escalation.md`,
  `supervisor-notes.md`, `pending_reviews`. `harness:escalation` is now read-only
  legacy.
- **Still separate / live:** coord escalations (`coord:escalate`, the `/coord`
  inbox; carries its own `severity: blocker|question|advisory`); the mobile/desktop
  push watcher (`device-intervention-watcher`, polls escalations + smoke-fail +
  plan-review); the toast log (ephemeral replay, not an inbox); inter-agent
  `messages`; operator suggestion cards (carry a capability `tier`, not importance).
- **Missing everywhere:** any importance / priority / severity field on plan items.

Existing surfaces to build on (do not rebuild): `PlansClient` (Vite SPA, consumed
by Next + operator-vite via `@/` alias) with its inbox / actionable / list / triage
views and two-pane detail; `/api/admin/plans/*` route handlers → `plans:*` tools;
the `/adv` master-detail pattern (`DetailPanel`, `PinMenu`, `panel-registry`,
`?sel=<id>` — adv-harness-tab-migration D-002/D-003); `plans:items` /
`plans:list` already accept `harness_slugs` for cross-harness fan-out.

## Phase 1 — Importance on plan items (data + authoring)

- [ ] P-001: plan-format spec (`apps/operator-docs/src/content/docs/spec/plan-format.mdx`) — document an `importance:` keyword on items, values `critical | high | normal | low`, default `normal`, parsed glyph-agnostically exactly like `blocked-by:`. Add a worked example. References D-002, D-003.
- [ ] P-002: `packages/plan-parser` — parse `importance:` into `PlanItem.importance` (default `normal`); surface it through effective-status output and the items array. Add a `*.property.test.ts` for the keyword parse (separator-agnostic, default, bad-value → normal + lint warning). References D-003.
- [ ] P-003: `plans:items` returns `importance`; sort ToDos and needs-human items by importance (critical→low) then age. `plans:lint` validates the value is one of the four (warning, not error, on unknown — degrade to `normal`).
- [ ] P-004: `plans:add-item` REQUIRES an `importance` arg (no silent default) so the rubric is enforced at authoring; `plans:set-status` / a new `plans:set-importance` can change it later. References D-002.

## Phase 2 — Rubric + agent enforcement

- [ ] P-005: Author the importance rubric (see the "Rubric" section below) and add it to the scoper, architect, orchestrator, and operator persona/tools prompts under `apps/operator/prompts/`. References D-002.
- [ ] P-006: Orchestrator — when it auto-creates a `needs-human` item (ESCALATE→item per shipped P-011; architect-REVIEW→item per shipped P-012) it must set `importance` from the rubric; set `critical` for a feature still failing after the debugger threshold (closes the "3-failed-attempts alert" gap, which today lands as a plain needs-human item with no urgency). blocked-by: P-004
- [ ] P-007: `tools-md-sync` + prompt-assembly tests green; verify `plans:add-item` enforcement with a unit test.

## Phase 3 — Generic AttentionItem read-model + reader

- [ ] P-008: Define a shared `AttentionItem` type: `{ id, kind, source, harnessSlug, planSlug, title, body, status, importance, needsHuman, actions[], ref }`. `kind` ∈ plan-item | coord-escalation | (future). `actions[]` is a typed list of buttons each kind declares. References D-004.
- [ ] P-009: Adapter `planItem → AttentionItem` (actions: Chat, Resolve = mark-done). References D-004.
- [ ] P-010: Adapter `coordEscalation → AttentionItem`; map `severity` → importance (blocker→high or critical, question→normal, advisory→low); actions: Chat, Resolve = `coord:resolve(choice)` using the escalation's options. References D-004, D-006.
- [ ] P-011: Reader — extend `/api/admin/plans/items` (or add `/api/admin/plans/attention`) to return `AttentionItem`s grouped by plan, importance-sorted, harness-filtered; cross-harness UNION when "all harnesses" is selected (fan-out via the `harness_slugs` arg `plans:items` already supports). References D-005.
- [ ] P-012: Preserve the orchestrator needs-human DONE-gate (today `GET /api/admin/plans/items?needsHuman=true`) against the new reader shape. blocked-by: P-011

## Phase 4 — Planning tab UI (rename + master-detail + actions + cross-harness)

- [ ] P-013: `PlansClient` — rename the `todo` item-filter label "Needs Decision" → "ToDos"; reframe the tab framing as "Planning" (real plans OR items needing attention). References D-005.
- [ ] P-014: Render a color-coded importance badge on every item row (critical/high/normal/low); sort rows by importance within each group.
- [ ] P-015: Detail (right) pane renders an `AttentionItem` with its per-kind action buttons (Chat, Resolve, Mark-done, Accept). Reuse the `/adv` `DetailPanel` + `PinMenu` + `panel-registry` + `?sel=<id>` pattern where it fits rather than a new shell. References D-004.
- [ ] P-016: Cross-harness mode — an "all harnesses" selector that fans out and groups by plan with a harness label on each group. blocked-by: P-011. References D-005.
- [ ] P-017: Wire actions — Resolve dispatches per kind (plan item → mark-done; coord escalation → `coord:resolve`); Chat opens an agent chat scoped to the item.

## Phase 5 — Operator / orchestrator consumption + delivery

- [ ] P-018: Operator — sort recommendations by importance; read open attention items and base its nudge / interrupt decision on the max open importance instead of the ad-hoc tier heuristic; stamp importance on any human-decision suggestion it emits. References D-002.
- [ ] P-019: Orchestrator — a `critical` open needs-human item halts the relevant feature loop (today a needs-human item only gates terminal DONE). blocked-by: P-006
- [needs-human] P-020: DECISION — is push delivery in scope now or a follow-up? (Collapse `device-intervention-watcher`'s per-source polling into one "push when an open AttentionItem ≥ high appears" rule.) Resolve before P-021. References D-007.
- [ ] P-021: (if P-020 approves) `device-intervention-watcher` — replace per-source push triggers with the single importance-threshold rule. blocked-by: P-020

## Phase 6 — Docs, tests, sign-off gate

- [needs-human] P-022: DECISION — confirm the open scope questions before the UI replaces the old inbox: (a) D-006 fold coord escalations into the planning tab? (b) the `critical/high/normal/low` taxonomy, (c) the `importance:` keyword syntax. References D-006.
- [ ] P-023: Tests — parser importance (property), both adapters, the reader, and a UI snapshot of grouped-by-plan list + detail pane + badges.
- [ ] P-024: Update `plan-format.mdx`, agent-policies (add a rubric section), and the testing docs.

## Decisions

### D-001 — Build on the shipped escalation→needs-human folding, don't rebuild it
Date: 2026-05-31
The escalation consolidation the request worried about already shipped
(`plans-central-harness-ux-2026-05-26` D-003; P-010–P-014 done): ESCALATE,
architect-REVIEW (spec-suspect), `escalation.md`, `supervisor-notes.md`, and
`pending_reviews` already create `needs-human` plan items, surfaced in the inbox
view with a Mark-resolved button; `harness:escalation` is read-only legacy. This
plan does NOT redo that. New scope = importance + generic item type +
coord-escalation adapter + cross-harness + operator/orchestrator consumption + UI.
Related: P-001, P-008

### D-002 — Importance is a 4th orthogonal axis on every item
Date: 2026-05-31
`critical | high | normal | low` — distinct from `status` (todo/wip/…) and from the
operator capability `tier` (low/med/high = risk-of-the-action, a different axis).
Applies to ALL items: for a ToDo it answers "which to pick up next"; for a
needs-human / escalation it answers "how urgently a human should act." Every
needs-human and ToDo item gets a level via the rubric (P-005), enforced at authoring
(P-004). Default `normal`. Chosen over reusing coord's blocker/question/advisory
(only 3, not truly ordinal, conflates blocking with importance) and over P0–P3
(not self-describing; agents apply numeric severities less consistently).
Related: P-004, P-005, P-018

### D-003 — Importance storage: keyword in markdown, field in PG-backed sources
Date: 2026-05-31
Plan items (markdown) carry an `importance:` keyword parsed glyph-agnostically like
`blocked-by:` (default `normal`). PG / event-log-backed sources (coord escalations)
carry an importance value; coord's existing `severity` maps to importance at the
adapter (blocker→high/critical, question→normal, advisory→low). Keeping plan items
in markdown (not a new PG column) preserves the single-source-of-truth-is-the-file
property of the plan system. Related: P-002, P-010

### D-004 — Generic `AttentionItem` read-model; adapters, not migration
Date: 2026-05-31
A shared `AttentionItem` type is the planning view's read-model. Plan items remain
the authoring surface for plan-scoped human gates. Other live surfaces (coord
escalations, future kinds) ADAPT into `AttentionItem` for display — they are NOT
rewritten as plan markdown, because a coord escalation is an event-log entry and a
stuck feature is orchestrator state; forcing them into markdown is wrong. Each kind
declares its own action buttons (Chat, Resolve, Mark-done, Accept) and resolution
dispatches to that kind's backend. The view groups by plan, left list + right
detail pane, matching the `/adv` pattern. Related: P-008, P-009, P-010, P-015

### D-005 — "Needs Decision"→"ToDos"; tab reframed "Planning"; cross-harness on all-harnesses
Date: 2026-05-31
The current "Needs Decision" filter actually means `effectiveStatus = todo`
(agent-actionable work), NOT human decisions — the label is a trap, rename to
"ToDos." The tab is reframed as "Planning" = real plans OR items needing attention.
When "all harnesses" is selected the view fans out cross-harness (`plans:items`
already supports `harness_slugs`) and groups by plan with a harness label.
Related: P-013, P-016

### D-006 — OPEN (proposed): coord escalations surface in the planning tab; /coord stays
Date: 2026-05-31
PROPOSED, needs the user's call (P-022): coord escalations appear as
`AttentionItem`s in the planning tab AND remain in `/coord`; the single source of
truth stays the coord event log (the planning tab reads, never copies). The
alternative is to leave coord escalations only in `/coord`. Resolving this sets
whether P-010 ships in v1. Related: P-010, P-022

### D-007 — OPEN (proposed): push delivery deferred to a follow-up phase
Date: 2026-05-31
PROPOSED, needs the user's call (P-020): defer collapsing
`device-intervention-watcher`'s per-source push triggers into one
"push when an open AttentionItem ≥ high appears" rule, so v1 ships the in-app
inbox + importance first and push lands as P-021. Related: P-020, P-021

## Rubric — importance level (proposed wording for P-005)

> **Assigning an importance level (required for every needs-human and ToDo item).**
> Decide from *consequences*, not urgency-feeling. Ask: **"what breaks, and how
> fast, if the human never sees this / if this is picked up last?"** Pick the
> highest level whose condition holds:
>
> - **critical** — progress is fully blocked *or* acting without a human risks
>   harm: repeated failures after the debugger ran, an irreversible / destructive /
>   production-affecting action awaits approval, a security or data-loss risk, or a
>   release is gated. Interrupt the human now.
> - **high** — a genuine decision is needed and this work thread is paused until
>   it's answered, but other work proceeds and nothing is at risk. The human should
>   see it today.
> - **normal** *(default)* — a decision/approval or task is needed; nothing is stuck
>   and it fits the normal cadence.
> - **low** — informational, or you have a safe default and will proceed with it if
>   unanswered.
>
> Rule of thumb: reversible **and** non-blocking **and** has-a-safe-default →
> low/normal; irreversible **or** blocking **or** unsafe-to-default → high/critical.
> When torn between two adjacent levels pick the higher — *except* never inflate a
> routine approval to critical. Crying wolf trains the human to ignore the badge,
> which is worse than a missed `normal`.
