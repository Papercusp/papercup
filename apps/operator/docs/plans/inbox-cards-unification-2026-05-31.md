---
title: Inbox-as-cards — one card UI for chat + every human-facing alert
slug: inbox-cards-unification-2026-05-31
status: ready
created: 2026-05-31
updated: 2026-05-31
---

# Inbox-as-cards — one card UI for chat + every human-facing alert

## Now

**State:** Core **COMPLETE** — Phases A, B, C + cross-cutting all shipped (commits b3760b866 → 743613c30). The Planning inbox now renders every human-facing item through the shared `AskChoiceCard`: terminal picks dispatch via `resolveAttentionAction` (parity-tested against the old handlers), `answer` reveals an inline `InputCard`, `chat` expands an inline `PlanChat`. `InboxItemActions` + `PlanChatModal` retired. Verified: 68 unit tests green (renderer/adapter/mapper/dispatch parity) + typecheck clean + a live Tauri check (the Other/escalation detail renders the card with the right question + Resolve + Chat). Agent insight written (`agent-insights/inbox-cards.mdx`); P-017 back-annotated.

**Phase D** (convergence) — **IMPLEMENTED**, behind the default-off `inboxDurableEscalations` flag (human-greenlit). P-031 flag; P-032 additive `CardSpec.onCard` surfaces the correlationId (tooldef, unit-tested); P-033 `openEscalation` persists a `meta` link (generic coord lib untouched); P-034 `chat:ask_choice` writes the linked escalation around `ctx.askUser` + closes it on resolve; P-035 `coord:resolve` → `unblockLinkedCard` → `resolveCardResponse` resumes the waiting agent; P-036 convergence test (real correlator + `InMemoryCoordLog`) green. Flag OFF ⇒ live `ctx.askUser` path 100% unchanged (the safety property: flag-off escalations carry no `cardCorrelationId`, so the fan-out is a no-op).

**Next (for the human):** the ONLY thing not verifiable headless is the live agent round-trip — flip `inboxDurableEscalations` ON, raise a decision card from a real agent, confirm it appears in the inbox and that resolving it there resumes the agent. Optional: the needs-human plan-item Answer-InputCard spot-check.

## Background

The chat "card system" the operator uses is **three decoupled layers**:

1. **Renderers** (pure presentational): `AskChoiceCard`
   (`apps/operator/app/_components/chat/AskChoiceCard.tsx`, radio/checkbox)
   and `InputCard` (text/date/slider). They take a spec — a *question/prompt*
   + *options* (`{id, label, hint, style: default|primary|danger}`) — render
   it, and call `onResponse({action:'submit'|'decline'|'cancel', payload})`.
   They know nothing about transport.
2. **Hosts/dispatch**: `PendingCardsBar.tsx` (consumes the server SSE
   state-channel) and `LocalCardHost.tsx` (consumes a client-side
   `askUserLocal` registry). Both dispatch by `presentation.kind` to the
   *same* renderers — so cards already come from **two emitters** and look
   identical.
3. **Lifecycle/transport**: `chat:ask_choice`
   (`apps/operator/lib/agent-tools/chat/ask_choice.ts`) is a thin wrapper over
   `ctx.askUser` — the card exists **only while a live agent is blocked inside
   the tool call**, and the human's click is the tool's return value. It is
   run-scoped, synchronous, and ephemeral (it vanishes on run-end / cancel).

Separately, the **inbox** (the items view) is `AttentionItem[]` from the
`plans:attention` reader — coord escalations, coord messages, needs-human plan
items, smoke-test failures, plans awaiting review. Each item already carries
`title`/`body` + an `actions[]` array (`{id, label, primary}`) + a typed `ref`
(`apps/operator/lib/attention/{adapters,types}.ts`). Today they render with
bespoke buttons in `PlanOtherList.tsx` (`OtherDetail`), `PlanItemsList.tsx`
(`InboxItemActions`), and `PlanItemPreview.tsx`; that action wiring (P-017 in
`planning-attention-importance-2026-05-31`, now **COMPLETE**) is **fully
implemented** — Resolve→`coord:resolve`, Ack→`coord:ack`, plan-item
Answer/Resolve/Drop→`addPlanDecision`/`setItemStatus` (+`resumeLoop`),
Chat→`PlanChatModal`; only View-log/Open are intentional placeholders that
point at the harness source view. **So Phase B/C is a refactor** that
centralizes this working code behind the shared card — gated on parity tests
(P-013) — not finishing half-done work. (Corrected after review, 2026-05-31.)

**The core question (from the human):** should every human-facing inbox item
use the same card system as chat, and can "Resolve" / "💬 Chat" become card
items?

**The answer this plan encodes:** reuse the **renderer** layer — strongly yes
— but **not** the `ctx.askUser` run-blocking **lifecycle**. Inbox items are
*durable, asynchronous* records (an escalation is resolved later and read by
the agent on its *next* run; nothing is blocked waiting). `ctx.askUser` cards
are *live, synchronous, ephemeral*. The clean unification is a **third card
emitter** — a durable/inbox path that renders each `AttentionItem` through the
shared `AskChoiceCard` and dispatches the response to the item's own backend.
"Resolve" / "Chat" are already `AttentionItem.actions`, which is the
`AskChoiceOption` shape — so they map to card options nearly for free.

### Design constraints / key facts

- **Renderers are transport-agnostic.** `AskChoiceCard` already supports
  styled options (default/primary/danger), single + multi select, an
  `answered`/disabled state, and a `decline` (Skip) affordance. It is the
  reusable core.
- **`ctx.askUser` is the wrong transport for the inbox.** Routing durable
  attention items through it would mean pinning agents alive blocking on a
  human — wrong for async work. Keep durable backends (`coord:resolve`, etc.)
  as the resolution path.
- **`AttentionItem.actions` ≈ `AskChoiceOption` — but the action MODEL must
  grow first (review gap).** `AttentionActionId` today is
  `chat|resolve|mark-done|view-log|open|ack` — there is **no `answer` and no
  `drop`** — and a needs-human item's `actions[]` is only
  `[mark-done("Resolve"), chat]`. The Answer/Resolve/Drop toolkit is
  **hard-coded in `InboxItemActions`**, not derived from `actions[]`. So an
  `actions[]`-driven mapper would silently lose Answer + Drop. **P-009 extends
  the adapter to emit the full set** before the mapper is written.
- **Terminal vs navigational, by id:**
  - *terminal* (commit + disable; handled by `resolveAttentionAction`):
    `mark-done`/`resolve` (→ resolve **+ `resumeLoop`**), `drop` (→
    `setItemStatus dropped`, **no resume** — preserve today's distinction),
    `ack` (→ `coord:ack`).
  - *navigate* (`terminal:false`; handled by the component): `chat` (→ inline
    `ChatPanel`), `answer` (→ inline `InputCard` → `addPlanDecision` +
    `setItemStatus done` **+ `resumeLoop`**), `view-log`/`open` (→ harness
    source view). The Phase-A `terminal` flag is what carries this.
- **Durable cards have no "Skip".** Inbox cards render with
  `allowDecline={false}` — `decline` is undefined for a durable record (it
  isn't keyed in `resolveAttentionAction`). A real dismiss/snooze can come
  later as an explicit action, not the chat "Skip". (D-008.)
- **No users yet (CLAUDE.md):** prefer collapsing the two surfaces now over
  maintaining bespoke inbox buttons alongside the card UI.

### Non-goals

- Not changing the chat `ctx.askUser` semantics (live agents still block on
  it). Phase D's convergence is optional/stretch.
- Not building a new card storage table — the inbox already has a durable
  source of truth (`plans:attention` + the per-kind backends).
- Not touching `InputCard` flows beyond confirming reuse.

## Phase A — Shared renderer + non-terminal action flag

P-001 done Confirm `AskChoiceCard` / `InputCard` are usable outside a live chat run (no hidden coupling to `ctx.askUser` / conversation state). Document the minimal prop surface a non-chat host must supply (`args`, `answered`, `onResponse`).
P-002 done Add an optional `terminal?: boolean` (default `true`) to `AskChoiceOption`. A non-terminal option click fires `onResponse({action:'navigate', option_id})` and does NOT mark the card answered/disabled. Extend `AskChoiceResponse` with the `navigate` action. blocked-by:P-001
P-003 done Render non-terminal options as a distinct secondary affordance (e.g. a quiet right-aligned action row / link style) so "💬 Chat" and "View log" read as "open this" rather than "answer this". CSS only; reuse the existing ask-choice option styles. blocked-by:P-002
P-004 done Unit tests for the renderer: terminal click → submit + disabled; non-terminal click → navigate, card stays live; multi-select unaffected; decline still works. blocked-by:P-002

## Phase B — Close the action-model gap, then adapter + durable dispatch

P-009 done **Prerequisite (review gap):** extend `AttentionActionId` with `answer` and `drop`, and have `planItemToAttention` (`adapters.ts`) emit the FULL needs-human set so `actions[]` is the single source of truth: `[answer (terminal:false), mark-done/"Resolve" (primary, terminal), drop (danger, terminal), chat (terminal:false)]`. Keeps the existing agent-facing `plans:attention` payload coherent. Adapter unit tests assert each kind's action set. blocked-by:P-002
P-010 done Pure mapper `attentionItemToCardSpec(item)` (new, `apps/operator/lib/attention/to-card-spec.ts`): `title`/`body` → question; `actions[]` → options — `primary`→`style:'primary'`, `drop`→`style:'danger'`, and `chat`/`answer`/`view-log`/`open`→`terminal:false`; emits `allowDecline:false` (D-008). Colocated unit test covering every kind (asserts Answer + Drop survive for needs-human, per P-009). blocked-by:P-009
P-011 done Durable dispatch `resolveAttentionAction(item, optionId)` (new, `apps/operator/lib/attention/resolve-action.ts`) for the TERMINAL ids only, calling the EXISTING helpers (D-007): coord-escalation/<option>→`resolveEscalation({msg_id, choice})`, coord-message/`ack`→`ackCoordMessage({msg_id})`, plan-item/`mark-done`→`setItemStatus done` **then `resumeLoop`**, plan-item/`drop`→`setItemStatus dropped` **(no resume)**. Returns `{ resolved: boolean }`. The navigate ids (`chat`/`answer`/`view-log`/`open`) are NOT handled here — the component owns them. blocked-by:P-010
P-012 done Escalation options: when `ref.options` is non-empty, the card's terminal options ARE those named options and each pick passes its `option_id` as `choice` to `resolveEscalation`; when empty, a single generic "Resolve". No new endpoint — `/api/admin/coord/:verb` already exists (D-007). blocked-by:P-011
P-013 done **Parity tests** (this is a refactor of working code, not new wiring): assert `resolveAttentionAction` reproduces today's `InboxItemActions`/`OtherDetail` behavior for every (kind, action) — same backend call, same args, AND the `resumeLoop`-on-resolve / no-resume-on-drop distinction. Only then delete the old per-action button code. blocked-by:P-011

## Phase C — Render the inbox through the card UI

P-020 done Replace `OtherDetail` (in `PlanOtherList.tsx`) body+buttons with `AskChoiceCard` fed by `attentionItemToCardSpec(item)`; wire `onResponse` → `resolveAttentionAction` for terminal picks; for the `chat` navigate action, expand a `ChatPanel` INLINE beneath the card (D-006), retiring `PlanChatModal` for this surface. Delete the bespoke per-action `toast`/button code. blocked-by:P-010,P-011,P-003
P-021 done Do the same for needs-human plan items via the shared card. Card composition (review gap #3): Resolve + Drop are terminal options; `answer` and `chat` are `terminal:false` navigate options. Clicking **Answer** reveals an inline `InputCard` beneath the card (mirroring the inline-chat pattern, D-006); its submit runs `addPlanDecision` + `setItemStatus done` + `resumeLoop` — i.e. one detail pane composes an `AskChoiceCard` (the options) with an on-demand `InputCard` (the answer). Retire the hard-coded `InboxItemActions` toolkit. blocked-by:P-020
P-022 done Apply the master-detail layout (D-005): keep the compact list; render the selected item as the shared card in the detail pane, with the inline chat (D-006) expanding inside that pane beneath the card. No card-stack rewrite. blocked-by:P-020
P-023 done Manual e2e in the Tauri desktop: an escalation, a message, a needs-human item, a smoke-fail, and a review each render as a card; the terminal action resolves the underlying record and the item leaves the inbox; "💬 Chat" opens the chat without resolving. blocked-by:P-021,P-022

## Phase D — Convergence: durable escalation cards (stretch / separate)

P-030 done Spike COMPLETE — feasibility confirmed and an implementation-ready design produced (see "Phase D — spike findings" below). Implementation itself is **held for a supervised session**: it changes the live `ctx.askUser` agent↔human handshake (incl. an API addition) and the cross-channel resolution can't be integration-tested headless, so it shouldn't ship in an unattended loop. The build-out items P-031..P-036 are scoped and ready. blocked-by:P-023

### Phase D — spike findings (implementation design)

**Goal.** When an agent raises a *decision* card (`chat:ask_choice` →
`ctx.askUser`), ALSO write a durable coord escalation, so the human can answer
it **live in chat** OR **later from the inbox** — and either path resolves the
same record. One card UI, two entry points.

**Mechanism (verified against the code).** `ctx.askUser({presentation})`
publishes a card on the state-channel keyed by an internally-generated
`correlationId` and `await`s a deferred held in `@papercusp/agent-mcp`'s PENDING
map. `/card-response` → `resolveCardResponse({correlationId, workspaceId,
action, payload})` resolves that deferred (the agent unblocks). Coord
escalations are an **event-sourced** store (`coordination/escalations.ts`):
`openEscalation(input)` appends an `escalation` event (with `msgId`, `severity`,
`options`); `resolveEscalation({msg_id, choice})` appends an
`escalation_resolved` event (idempotent — returns `'already_resolved'` on a
second call). So the two records already exist; convergence is **linking them by
`correlationId`** and making each resolve path fan out to the other.

**Design (all behind a default-OFF flag `inboxDurableEscalations`, so the live
path is 100% unchanged when off):**

P-031 done Flag `inboxDurableEscalations` (default false) in the flags system (`libs/flags`), gated like the other V1-cut surfaces. Every Phase-D branch checks it; off ⇒ zero behavior change.
P-032 done `ctx.askUser` API addition: surface the generated `correlationId` to the caller (e.g. an `onCard(correlationId)` callback or returning it alongside the promise). Needed because the tool must write the linked escalation but the id is minted inside `askUser`. Keep additive/optional so existing callers are untouched.
P-033 done `EscalationRecord` gains optional `cardCorrelationId` + `cardWorkspaceId` (`coordination/escalations.ts` types + `openEscalation`). Carries the link; absent on every existing/flag-off escalation (so P-035's branch is a no-op for them — the safety property).
P-034 done In `chat:ask_choice` (tool layer, NOT the core capability — smaller blast radius), when the flag is on and the card is a genuine decision: `openEscalation({summary: question, options, severity:'question', cardCorrelationId, cardWorkspaceId})` around the `await ctx.askUser(...)`; in `finally`, if the card resolved live, append `escalation_resolved` so the inbox copy clears. Dedup via the store's `already_resolved` guard.
P-035 done `coord:resolve` (→ `resolveEscalation`): after recording the resolution, if the folded record has a `cardCorrelationId`, call `resolveCardResponse({correlationId, workspaceId, action:'submit', payload:{picks:[choice]}})` to unblock the live agent. No-op when absent (flag-off escalations have none).
P-036 done Cancel/cleanup: on run-cancel (`run-cancel.ts` / the askUser `cancel` path) append `escalation_resolved` (choice `'cancelled'`) for the linked record so a dead run doesn't leave an orphan escalation in the inbox. Unit-test all of P-034/P-035/P-036 with mocked `resolveCardResponse` + escalation store; integration-test (live agent, flag on) is the supervised gate.

**Risk register.** (1) Hot-path: P-034 adds a flag-check + optional write to the
chat decision path — flag-off short-circuits before any new work. (2) Resolution
fan-out: P-035 touches `coord:resolve`, which the shipped inbox already uses —
but it only acts when `cardCorrelationId` is present, which only happens under
the flag, so flag-off escalations (all of today's) are unaffected. (3)
Double-resolve: the store's `already_resolved` guard + the PENDING map's
idempotent resolve make both directions safe to fire. (4) Unverifiable headless:
the live agent↔human round-trip can't be exercised without a real run — hence
the supervised-implementation gate.

## Cross-cutting

P-050 done Back-annotation only (P-017 is already done + that plan is COMPLETE): add a "superseded-by → inbox-cards-unification Phase B" pointer next to P-017, NOT a live hand-off. blocked-by:P-013
P-051 done Agent insight at `apps/operator-docs/src/content/docs/agent-insights/inbox-cards.mdx`: the renderer-vs-lifecycle split, the durable third emitter, and the terminal/navigate option convention — so the next agent doesn't try to route the inbox through `ctx.askUser`. blocked-by:P-023

## Decisions

### D-001 — Reuse the renderer, not the `ctx.askUser` lifecycle

The genuinely reusable part of the chat card system is the presentational
renderer (`AskChoiceCard` / `InputCard`), not the run-blocking `ctx.askUser`
transport. Inbox items are durable/async and resolved by their own backends;
they are not a live agent blocked awaiting a pick. We adopt the renderer and
keep the durable resolution paths.

### D-002 — The inbox is a third card emitter

Today two emitters feed the renderers (server SSE state-channel via
`PendingCardsBar`, client `askUserLocal` via `LocalCardHost`). We add a third:
a durable/inbox emitter that renders `AttentionItem`s as cards and dispatches
responses to per-kind backends. No new card storage table — `plans:attention`
remains the source of truth.

### D-003 — Add a `terminal` flag to options

Resolve/Ack/Drop are terminal (answer + disable). Chat/View-log/Review are
navigational (`terminal:false`) — they open a sub-surface and leave the card
live. This is the one real change to the shared renderer and it also enriches
chat cards (an option that escalates into a full chat).

### D-004 — Map `AttentionItem.actions` → `AskChoiceOption` (REVISED after review)

The shapes match (`{id,label,primary}` → `{id,label,style}`), BUT the action
*set* must grow first: `AttentionActionId` has no `answer`/`drop` today and the
needs-human `actions[]` is only `[mark-done, chat]` — Answer/Drop are hard-coded
in `InboxItemActions`. So this is **not** "no new data model": P-009 adds
`answer`+`drop` to the union and emits them from the adapter, making `actions[]`
the single source the mapper reads. Then `primary`→`style:'primary'`,
`drop`→`style:'danger'`, `chat`/`answer`/`view-log`/`open`→`terminal:false`.

### D-005 — Inbox layout: master-detail, card in the detail pane (RESOLVED 2026-05-31)

Option A. Keep the current compact master-detail list (rows scan fast, one
item open at a time) and render the SELECTED item as the shared `AskChoiceCard`
in the right-hand detail pane (`PlanItemPreview` / `OtherDetail`). The inline
chat (D-006) expands inside that detail pane beneath the card. Smaller change
than a full card-stack rewrite; preserves the list/preview muscle memory.
(Human call, 2026-05-31, chosen from the mock `/tmp/inbox-mock.png`.)

### D-006 — "Chat" opens INLINE (RESOLVED 2026-05-31)

The card's `chat` navigate action expands a `ChatPanel` **inline beneath the
card** (a sub-conversation), not the current `PlanChatModal`. The card stays
live above the chat; resolving the item collapses the chat. `PlanChatModal`'s
only consumers are `OtherDetail` + `PlanItemPreview` (both inbox surfaces,
verified), so this **retires `PlanChatModal` entirely** — delete the component
in Phase C, don't leave it dead. (Human call, 2026-05-31.)

### D-007 — Use the existing endpoint-system coord proxy, NO new route (RESOLVED 2026-05-31)

`defineTool` already projects the coord tools onto HTTP — `coord:resolve` /
`coord:ack` are reachable from the client today via the `/api/admin/coord/:verb`
proxy, with the ready-made helpers `resolveEscalation({msg_id, choice, note})`
and `ackCoordMessage({msg_id})` in `plans-api.ts`. Phase B's dispatch calls
those (plus `setItemStatus` for plan items) — no bespoke REST route to write.
(Human call, 2026-05-31: "can't our defineTool take care of that?" — yes.)

### D-008 — No "Skip" on durable inbox cards (from review)

`AskChoiceCard` shows a Skip affordance by default (`allowDecline=true`) firing
`{action:'decline'}`. For a *durable* inbox record that's undefined — `decline`
isn't keyed in `resolveAttentionAction`, so Skip would either no-op or hide the
card while the backend record stays open. Inbox cards therefore render with
`allowDecline={false}`. If a "dismiss/snooze" is wanted later it's an explicit
action (local UI state), not the chat Skip. (From review, 2026-05-31.)
