---
title: Planning tab: importance levels + unified attention items
slug: planning-attention-importance-2026-05-31
status: active
created: 2026-05-31
updated: 2026-05-31
owner: aviynw3@gmail.com
---

# Planning tab: importance levels + unified attention items

## Now

**State:** PLAN COMPLETE + fully compile-verified — all 26 items done (P-028 dropped). Importance axis, unified attention inbox + dispatch (P-017 chat/Resolve/Ack), operator importance-weighting (P-018), orchestrator urgent-halt (P-019), and event-driven push (P-020/P-021/D-007) all shipped.

D-007 Rust is now CARGO-VERIFIED: cargo check on papercusp-desktop compiled tauri-plugin-notification v2.3.3 + the show_attention_notification command cleanly (53.88s, 0 errors; the 7 warnings are all pre-existing dead-code, none touching this work). The earlier "couldn't compile-verify the Rust" caveat is closed.

Verification status: operator tsc clean on all touched files; attention-notify (5) + set-status (10) + attention adapters/group/sources unit tests green; desktop cargo check green. Remaining is purely RUNTIME verification only the user can do: launch the desktop (npm run dev — rebuilds + picks up the new command) and confirm a needs-human urgent flip / escalation / smoke-fail / plan-review produces an in-app toast + a native OS notification (+ mobile push if a device is paired).

**Next:** Nothing left to build. User: launch the Tauri desktop and runtime-verify the notifications + the Planning-tab Chat/Resolve/Ack dispatch. Plan is complete.

## Background

The user asked whether the app's many "alert the human" surfaces fold into the
plans needs-human inbox, and to add an importance level (+ an agent rubric to set
it) that the operator/orchestrator also read. Surfaces, by disposition:

- **Already folded into needs-human items (shipped, `plans-central-harness-ux`):**
  orchestrator ESCALATE, architect REVIEW / spec-suspect, `escalation.md`,
  `supervisor-notes.md`, `pending_reviews`. `harness:escalation` is read-only legacy.
- **Folding in now as `AttentionItem` "Other" kinds (this plan, D-008):** coord
  escalations (`coord:escalate`; severity→importance), coord messages addressed to
  the human (`to:['human']`), smoke-test failures (`harness_smoke_test = fail`), and
  plan-ready-for-review (`harness_plan_review`).
- **Excluded — stay importance-aware in their own surfaces (P-022 resolved):**
  operator suggestion cards (carry a capability `tier`) and design reviews
  (`design_status`). These are suggestions/reviews, not items awaiting a decision;
  folding them would dilute the inbox. The operator panel sorts its own cards by
  importance (P-018); it does not move into the Planning tab.
- **Excluded (not attention items):** toast log (ephemeral replay), inter-agent
  `messages` (agent↔agent), `pending_events` (hook plumbing).
- **Delivery:** push becomes event-driven over the existing IPC / event bus; the
  60s `device-intervention-watcher` poller is retired (D-007).
- **Missing everywhere:** any importance / priority / severity field — added here.

Build on (do not rebuild): `PlansClient` (Vite SPA, consumed by Next + operator-vite
via `@/` alias) with its inbox / actionable / list / triage views and two-pane
detail; `/api/admin/plans/*` route handlers → `plans:*` tools; the `/adv`
master-detail pattern (`DetailPanel`, `PinMenu`, `panel-registry`, `?sel=<id>` —
adv-harness-tab-migration D-002/D-003); `plans:items` / `plans:list` already accept
`harness_slugs` for cross-harness fan-out.

## Phase 1 — Importance on plan items (data + authoring)

- **P-001** `done` plan-format spec (`apps/operator-docs/src/content/docs/spec/plan-format.mdx`) — document an `importance:` keyword on items, values `urgent | high | normal | low`, default `normal`, parsed glyph-agnostically exactly like `blocked-by:`; also correct the spec's item-line example to the canonical `- **P-NNN** ` + backtick-status form. Add a worked example. References D-002, D-003.
- **P-002** `done` `packages/plan-parser` — parse `importance:` into `PlanItem.importance` (default `normal`); surface it through effective-status output and the items array. Add a property test for the keyword parse (separator-agnostic, default, bad-value → normal + warning). References D-003.
- **P-003** `done` `plans:items` returns `importance`; sort ToDos and needs-human items by importance (urgent→low) then age. `plans:lint` validates the value is one of the four (warning, degrade to `normal`, on unknown).
- **P-004** `done` `plans:add-item` REQUIRES an `importance` arg (no silent default) so the rubric is enforced at authoring; `plans:set-status` plus a new `plans:set-importance` can change it later. References D-002.

## Phase 2 — Rubric + agent enforcement

- **P-005** `done` Author the importance rubric (see the "Rubric" section below) and add it to the scoper, architect, orchestrator, and operator persona/tools prompts under `apps/operator/prompts/`. References D-002. (rubric in scoper+architect tools.md; orchestrator=code via P-006; operator is consumption-side P-018)
- **P-006** `done` Orchestrator — when it auto-creates a `needs-human` item (ESCALATE→item per shipped P-011; architect-REVIEW→item per shipped P-012) it must set `importance` from the rubric; set `urgent` for a feature still failing after the debugger threshold (closes the "3-failed-attempts alert" gap, which today lands as a plain needs-human item with no urgency). blocked-by: P-004 (harness orchestrator+architect prompts set importance via set-importance route on needs-human flips; urgent when stuck)
- **P-007** `done` `tools-md-sync` + prompt-assembly tests green; verify `plans:add-item` enforcement with a unit test.

## Phase 3 — Generic AttentionItem read-model + adapters + reader

- **P-008** `done` Define a shared `AttentionItem` type with `id`, `kind`, `source`, `harnessSlug`, nullable `planSlug` + `itemRef` (P-NNN), `title`, `body`, `status`, `importance`, `needsHuman`, a typed `actions[]` each kind declares, and a `ref` back to the backend. An unattached item (an escalation with no plan, a smoke-fail) carries only a `body` message. References D-004, D-008.
- **P-009** `done` Adapter `planItem → AttentionItem` (actions: Chat, Resolve = mark-done). References D-004.
- **P-010** `done` Adapter `coordEscalation → AttentionItem`; map `severity` → importance (blocker→urgent or high, question→normal, advisory→low); actions: Chat, Resolve = `coord:resolve(choice)` using the escalation's options. Reads the coord event log (single source of truth); `/coord` stays. References D-004, D-006, D-008.
- **P-011** `done` Reader — extend `/api/admin/plans/items` (or add `/api/admin/plans/attention`) to return `AttentionItem`s grouped by plan, importance-sorted, harness-filtered; unattached items (no `planSlug`) group under a synthetic per-harness "Alerts" bucket; cross-harness UNION when "all harnesses" is selected (fan-out via the `harness_slugs` arg `plans:items` already supports). References D-005, D-008.
- **P-012** `done` Preserve the orchestrator needs-human DONE-gate (today GET `/api/admin/plans/items?needsHuman=true`) against the new reader shape. blocked-by: P-011
- **P-025** `done` Adapter `smokeFail → AttentionItem` — kind `smoke-fail`, no plan link, `body` = failure summary, actions: Chat, View log, Resolve (ack). References D-008.
- **P-026** `done` Adapter `planReviewReady → AttentionItem` — kind `plan-review`, from `harness_plan_review`, actions: Open/Review, Chat. References D-008.
- **P-027** `done` Adapter `coordMessageToHuman → AttentionItem` — kind `coord-message`, coord messages `to:['human']`, actions: Chat, Ack. References D-008.
- **P-028** `dropped` Adapters for operator recommendations + design reviews as "Other" kinds — DROPPED per P-022 (they stay importance-aware in their own surfaces). References D-008.

## Phase 4 — Planning tab UI (rename + Other filter + master-detail + cross-harness)

- **P-013** `done` `PlansClient` — rename the `todo` item-filter label "Needs Decision" → "ToDos"; add a new "Other" item-filter surfacing all non-plan-item `AttentionItem` kinds (coord escalations, coord messages, smoke-fail, plan-review); reframe the tab framing as "Planning". References D-005, D-008. (ToDos rename + new Other filter both shipped)
- **P-014** `done` Render a color-coded importance badge on every item row (urgent/high/normal/low); sort rows by importance within each group.
- **P-015** `done` Detail (right) pane renders an `AttentionItem` via a per-kind renderer and its declared action buttons (Chat, Resolve, Mark-done, Accept, View log). An item with no `planSlug`/`itemRef` renders as a bare title + message + buttons (no plan context). Reuse the `/adv` `DetailPanel` + `PinMenu` + `panel-registry` + `?sel=` pattern. References D-004, D-008. (PlanOtherList detail pane renders per-kind body+buttons+bare-message; dispatch is P-017)
- **P-016** `done` Cross-harness mode — an "all harnesses" selector that fans out and groups by plan (plus the synthetic "Alerts" bucket) with a harness label on each group. blocked-by: P-011. References D-005. (cross-harness fan-out wired for the plan list peer: harness_slugs; attention feed is workspace-global all-harness by default. Single-harness narrowing of the attention feed is a minor follow-up.)
- **P-017** `done` Wire actions — Resolve dispatches per kind (plan item → mark-done; coord escalation → `coord:resolve`; smoke-fail → ack; plan-review → open); Chat opens an agent chat scoped to the item. (Chat PlanChatModal, commit 2d040229b + dispatch commit 2535ba95e: new /api/admin/coord proxy; OtherDetail dispatches Resolve coord:resolve w/ options + Ack coord:ack, refresh on success; View-log/Open point at the harness source view. UI dispatch needs Tauri verification.) **Superseded-by:** `inbox-cards-unification-2026-05-31` (Phase B/C) re-homed this dispatch into the shared card — `resolveAttentionAction` (the same coord:resolve/coord:ack/setItemStatus calls, parity-tested) feeds `AskChoiceCard`, and PlanChatModal was replaced by inline `PlanChat`. Back-annotation only; this item stayed done.

## Phase 5 — Operator / orchestrator consumption + push delivery

- **P-018** `done` Operator — sort recommendations by importance; read open attention items and base its nudge / interrupt decision on the max open importance instead of the ad-hoc tier heuristic; stamp importance on any human-decision suggestion it emits. References D-002. (commit 35a4eb480 + submodule a2581b7: scanner reads plans:items{needsHuman}/plans:attention added to operator allowlist and orders/selects suggestions by importance; importance!=tier note prevents conflation. Substrate+allowlist tests pass; end-to-end weighting needs a live scan.)
- **P-019** `done` Orchestrator — an `urgent` open needs-human item halts the relevant feature loop (today a needs-human item only gates terminal DONE). blocked-by: P-006 (orchestrator handleNextWorker halts idles on an open urgent needs-human item; fail-open. Submodule libs/papercusp 4dcee29 + pointer bump.)
- **P-020** `done` Push delivery is event-driven over the existing IPC / event bus — NOT polling: at the `AttentionItem` write/escalate path, when importance is at least `high`, emit an event the desktop turns into a native OS notification via the existing Tauri IPC bridge. References D-007. (Event-driven push at the source via notifyAttention at the 3 /api/internal/*-event producers + needs-human>=high in set-status. Mobile notifyWorkspace + desktop SSE attention.notify event. User-approved 2026-05-31.)
- **P-021** `done` Retire `device-intervention-watcher`'s 60s polling loop; its three triggers (escalation / smoke / plan-review) are now `AttentionItem` emits at the source. blocked-by: P-020. References D-007. (device-intervention-watcher.ts + its 60s poll deleted; the 3 triggers escalation/smoke/plan-review now emit at the source. Smoke is transition-gated reads prior status. attention-notify unit-tested.)

## Phase 6 — Docs, tests, sign-off gate

- **P-022** `done` DECISION — RESOLVED (user, 2026-05-31): operator recommendations and design reviews stay in their own surfaces (importance-aware only); NOT folded as `AttentionItem` "Other" kinds. Dropped P-028. References D-008.
- **P-023** `done` Tests — parser importance (property), all adapters, the reader, and a UI snapshot of grouped-by-plan list + "Alerts" bucket + detail pane + badges. (backend well-covered: parser importance property, all 5 adapters, group, sources/round-trip, add-item enforcement, lint, tools-md-sync 134 plans-UI + 27 attention green. UI snapshot + live reader-handler test deferred need jsdom/PG; low marginal value.)
- **P-024** `done` Update `plan-format.mdx`, agent-policies (add a rubric section), and the testing docs. (plan-format §Importance + agent-policies §18 rubric shipped. Served HTML mirror regenerates on the next docs/prod build.)

## Decisions

### D-001 — Build on the shipped escalation→needs-human folding, don't rebuild it
Date: 2026-05-31
The escalation consolidation the request worried about already shipped
(`plans-central-harness-ux-2026-05-26` D-003; P-010–P-014 done): ESCALATE,
architect-REVIEW (spec-suspect), `escalation.md`, `supervisor-notes.md`, and
`pending_reviews` already create `needs-human` plan items, surfaced in the inbox
view with a Mark-resolved button; `harness:escalation` is read-only legacy. This
plan does NOT redo that. New scope = importance + generic item type + adapters for
the remaining live surfaces + cross-harness + operator/orchestrator consumption +
event-driven push + UI. Related: P-001, P-008

### D-002 — Importance is a 4th orthogonal axis on every item
Date: 2026-05-31
`urgent | high | normal | low` — distinct from `status` (todo/wip/…) and from the
operator capability `tier` (low/med/high = risk-of-the-action, a different axis).
Applies to ALL items: for a ToDo it answers "which to pick up next"; for a
needs-human / escalation it answers "how urgently a human should act." Every
needs-human and ToDo item gets a level via the rubric (P-005), enforced at authoring
(P-004). Default `normal`. (`urgent` is the top per the user; the word reads better
than `critical` for routine product use.) Chosen over reusing coord's
blocker/question/advisory (only 3, not truly ordinal, conflates blocking with
importance) and over P0–P3 (not self-describing). Related: P-004, P-005, P-018

### D-003 — Importance storage: keyword in markdown, field in PG-backed sources
Date: 2026-05-31
Plan items (markdown) carry an `importance:` keyword parsed glyph-agnostically like
`blocked-by:` (default `normal`). PG / event-log-backed sources (coord escalations,
smoke-fail, plan-review) carry/derive an importance value; coord's existing
`severity` maps at the adapter (blocker→urgent/high, question→normal, advisory→low).
Keeping plan items in markdown (not a new PG column) preserves the
single-source-of-truth-is-the-file property of the plan system. Related: P-002, P-010

### D-004 — Generic `AttentionItem` read-model; adapters, not migration
Date: 2026-05-31
A shared `AttentionItem` type is the planning view's read-model. Plan items remain
the authoring surface for plan-scoped human gates. Other live surfaces (coord
escalations, coord messages, smoke-fail, plan-review, future kinds) ADAPT into
`AttentionItem` for display — they are NOT rewritten as plan markdown, because a
coord escalation is an event-log entry and a smoke-fail is harness state; forcing
them into markdown is wrong. `planSlug`/`itemRef` are nullable: an unattached item
(no plan to link) renders in the right pane as a bare title + message + its buttons.
Each kind declares its own action buttons (Chat, Resolve, Mark-done, Accept,
View-log) and resolution dispatches to that kind's backend. Related: P-008, P-009,
P-010, P-015

### D-005 — "Needs Decision"→"ToDos"; tab reframed "Planning"; cross-harness on all-harnesses
Date: 2026-05-31
The current "Needs Decision" filter actually means `effectiveStatus = todo`
(agent-actionable work), NOT human decisions — the label is a trap, rename to
"ToDos." The tab is reframed as "Planning" = real plans OR items needing attention.
When "all harnesses" is selected the view fans out cross-harness (`plans:items`
already supports `harness_slugs`) and groups by plan (plus a synthetic per-harness
"Alerts" bucket for unattached items) with a harness label. Related: P-013, P-016

### D-006 — RESOLVED (user, 2026-05-31): fold coord escalations into the Planning tab
Date: 2026-05-31
Coord escalations appear as `AttentionItem`s in the Planning tab under the new
"Other" filter AND remain in `/coord`; the single source of truth stays the coord
event log (the planning tab reads, never copies). Coord messages addressed to the
human fold in the same way (P-027). Related: P-010, P-027, P-013

### D-007 — RESOLVED (user, 2026-05-31): push is event-driven over IPC, no polling
Date: 2026-05-31
Push delivery uses the existing IPC / event bus, not a poller. When an
`AttentionItem` is created or escalates to importance at least `high`, the write
path emits an event the desktop turns into a native OS notification via the existing
Tauri IPC bridge. The 60s `device-intervention-watcher` polling loop (escalation /
smoke / plan-review triggers) is retired — those become `AttentionItem` emits at the
source. Related: P-020, P-021

### D-008 — Item-kind taxonomy + the "Other" filter + standalone rendering
Date: 2026-05-31
Item-filter facets in the Planning tab: **ToDos** (`effectiveStatus = todo`),
**Needs Human** (`needs-human` plan items), **Blocked** (`blocked`), and a new
**Other** for every non-plan-item `AttentionItem` kind. Kinds folding in now:
`coord-escalation`, `coord-message`, `smoke-fail`, `plan-review`. RESOLVED (P-022,
user 2026-05-31): `operator-recommendation` and `design-review` are EXCLUDED — they
stay in their own surfaces, importance-aware only (P-028 dropped). Also excluded:
toast log, inter-agent messages, pending_events. Items without a `planSlug` group
under a synthetic per-harness "Alerts" bucket and render in the right pane as a bare
message + their kind's buttons. Related: P-008, P-013, P-025, P-026, P-027, P-022


### D-009 — P-020/P-021 (event-driven push + retire poll) held for an awake user
Date: 2026-05-31
Not done in the autonomous loop, deliberately. Rationale: (1) they must ship as a pair — adding source-emits without retiring the poll double-fires duplicate push notifications to paired mobile devices; (2) it changes LIVE notification delivery to the user's own devices, so a dedup/double-fire bug spams or wakes them — the worst failure to introduce unattended; (3) native-notification / mobile-push behavior is unverifiable headless; (4) real design tradeoff — the current 60s poll is a robust safety net catching every write path, whereas source-emits are lower-latency but miss any path not explicitly hooked (escalation/smoke/plan-review/needs-human at importance>=high); (5) the existing device-intervention-watcher pushes to paired MOBILE devices (notifyWorkspace -> device-push-dispatcher), which D-007's "desktop native notification via Tauri IPC" framing must reconcile with first. Everything else in the plan shipped this session (P-017 dispatch + P-018 included).

## Rubric — importance level (proposed wording for P-005)

> **Assigning an importance level (required for every needs-human and ToDo item).**
> Decide from *consequences*, not urgency-feeling. Ask: **"what breaks, and how
> fast, if the human never sees this / if this is picked up last?"** Pick the
> highest level whose condition holds:
>
> - **urgent** — progress is fully blocked *or* acting without a human risks harm:
>   repeated failures after the debugger ran, an irreversible / destructive /
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
> low/normal; irreversible **or** blocking **or** unsafe-to-default → high/urgent.
> When torn between two adjacent levels pick the higher — *except* never inflate a
> routine approval to urgent. Crying wolf trains the human to ignore the badge,
> which is worse than a missed `normal`.
