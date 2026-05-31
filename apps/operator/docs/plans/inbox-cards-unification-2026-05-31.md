---
title: Inbox-as-cards — one card UI for chat + every human-facing alert
slug: inbox-cards-unification-2026-05-31
status: ready
created: 2026-05-31
updated: 2026-05-31
---

# Inbox-as-cards — one card UI for chat + every human-facing alert

## Now

**State:** Approved — all open questions resolved (D-005 Option A master-detail, D-006 inline chat, D-007 endpoint-system coord proxy). Starting **Phase A**: add an additive `terminal` flag + `navigate` action to the shared `AskChoiceCard` (backward-compatible — existing chat callers unaffected).

**Next:** finish Phase A (renderer flag + CSS + tests), then Phase B (AttentionItem→CardSpec adapter + durable dispatch via the existing coord helpers).

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
(`InboxItemActions`), and `PlanItemPreview.tsx`; the action wiring
(`coord:resolve` / `setItemStatus` / `coord:ack` / open-log / open-review /
`PlanChatModal`) is the "P-017" work from the
`planning-attention-importance-2026-05-31` plan, currently half-wired.

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
- **`AttentionItem.actions` ≈ `AskChoiceOption`.** `{id:'resolve',
  label:'Resolve', primary:true}` → `{id:'resolve', label:'Resolve',
  style:'primary'}`. Drop → `style:'danger'`; the rest → default.
- **Terminal vs navigational actions.** Resolve / Ack / Drop are *terminal*
  (they answer and disable the card). Chat / View-log / Review are
  *navigational* (they open a sub-surface and the card should stay open).
  `AskChoiceCard` today commits-and-disables on any single-select click —
  this is the one real renderer change needed.
- **No users yet (CLAUDE.md):** prefer collapsing the two surfaces now over
  maintaining bespoke inbox buttons alongside the card UI.

### Non-goals

- Not changing the chat `ctx.askUser` semantics (live agents still block on
  it). Phase D's convergence is optional/stretch.
- Not building a new card storage table — the inbox already has a durable
  source of truth (`plans:attention` + the per-kind backends).
- Not touching `InputCard` flows beyond confirming reuse.

## Phase A — Shared renderer + non-terminal action flag

P-001 todo Confirm `AskChoiceCard` / `InputCard` are usable outside a live chat run (no hidden coupling to `ctx.askUser` / conversation state). Document the minimal prop surface a non-chat host must supply (`args`, `answered`, `onResponse`).
P-002 todo Add an optional `terminal?: boolean` (default `true`) to `AskChoiceOption`. A non-terminal option click fires `onResponse({action:'navigate', option_id})` and does NOT mark the card answered/disabled. Extend `AskChoiceResponse` with the `navigate` action. blocked-by:P-001
P-003 todo Render non-terminal options as a distinct secondary affordance (e.g. a quiet right-aligned action row / link style) so "💬 Chat" and "View log" read as "open this" rather than "answer this". CSS only; reuse the existing ask-choice option styles. blocked-by:P-002
P-004 todo Unit tests for the renderer: terminal click → submit + disabled; non-terminal click → navigate, card stays live; multi-select unaffected; decline still works. blocked-by:P-002

## Phase B — AttentionItem → CardSpec adapter + durable dispatch

P-010 todo Pure mapper `attentionItemToCardSpec(item)` (new, `apps/operator/lib/attention/to-card-spec.ts`): `title`/`body` → question; `actions[]` → options (primary→`style:'primary'`, `drop`→`style:'danger'`, `chat`/`view-log`/`open`→`terminal:false`). Colocated unit test covering every kind. blocked-by:P-002
P-011 todo Durable dispatch map `resolveAttentionAction(item, optionId)` (new, `apps/operator/lib/attention/resolve-action.ts`) keyed by `(ref.kind, optionId)`, calling the EXISTING client helpers (D-007): coord-escalation/<option>→`resolveEscalation({msg_id, choice})`, coord-message/ack→`ackCoordMessage({msg_id})`, plan-item/resolve→`setItemStatus done`, plan-item/drop→`setItemStatus dropped`, smoke-fail/view-log + plan-review/open→navigate (non-terminal). Returns `{ resolved: boolean }` so the card knows whether to mark answered. This is the P-017 action wiring, centralized. blocked-by:P-010
P-012 todo Escalation options: when `ref.options` is non-empty, the card's terminal options ARE those named options and each pick passes its `option_id` as `choice` to `resolveEscalation`; when empty, a single generic "Resolve" records acknowledgement. No new endpoint — `/api/admin/coord/:verb` already exists (D-007). blocked-by:P-011
P-013 todo Integration test: each kind's terminal action calls the right backend and the underlying record changes (escalation closed / item status flipped / message acked). blocked-by:P-011

## Phase C — Render the inbox through the card UI

P-020 todo Replace `OtherDetail` (in `PlanOtherList.tsx`) body+buttons with `AskChoiceCard` fed by `attentionItemToCardSpec(item)`; wire `onResponse` → `resolveAttentionAction` for terminal picks; for the `chat` navigate action, expand a `ChatPanel` INLINE beneath the card (D-006), retiring `PlanChatModal` for this surface. Delete the bespoke per-action `toast`/button code. blocked-by:P-010,P-011,P-003
P-021 todo Do the same for needs-human plan items: render `PlanItemPreview` / `InboxItemActions` via the shared card (Answer becomes an `InputCard` text card; Resolve/Drop are terminal options; Chat expands the inline `ChatPanel`). Retire `InboxItemActions` bespoke buttons. blocked-by:P-020
P-022 todo Apply the master-detail layout (D-005): keep the compact list; render the selected item as the shared card in the detail pane, with the inline chat (D-006) expanding inside that pane beneath the card. No card-stack rewrite. blocked-by:P-020
P-023 todo Manual e2e in the Tauri desktop: an escalation, a message, a needs-human item, a smoke-fail, and a review each render as a card; the terminal action resolves the underlying record and the item leaves the inbox; "💬 Chat" opens the chat without resolving. blocked-by:P-021,P-022

## Phase D — Convergence: durable escalation cards (stretch / separate)

P-030 todo Spike: when an agent calls `ctx.askUser` for a *decision* (not a quick UI choice), ALSO write a durable coord escalation so the human can answer it live in chat OR later from the inbox — and either path resolves the same record. One card UI, two entry points. Keep behind a flag; do not block Phases A–C. blocked-by:P-023

## Cross-cutting

P-050 todo Update the `planning-attention-importance-2026-05-31` plan: mark its P-017 "action wiring" as subsumed by this plan's Phase B, with a pointer. blocked-by:P-011
P-051 todo Agent insight at `apps/operator-docs/src/content/docs/agent-insights/inbox-cards.mdx`: the renderer-vs-lifecycle split, the durable third emitter, and the terminal/navigate option convention — so the next agent doesn't try to route the inbox through `ctx.askUser`. blocked-by:P-023

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

### D-004 — Map `AttentionItem.actions` → `AskChoiceOption`

The action shape already matches the option shape. `primary:true` →
`style:'primary'`; a `drop` action → `style:'danger'`; everything else
default. "Resolve" and "💬 Chat" become card options with no new data model.

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
live above the chat; resolving the item collapses the chat. `PlanChatModal`
is retired for this surface. (Human call, 2026-05-31.)

### D-007 — Use the existing endpoint-system coord proxy, NO new route (RESOLVED 2026-05-31)

`defineTool` already projects the coord tools onto HTTP — `coord:resolve` /
`coord:ack` are reachable from the client today via the `/api/admin/coord/:verb`
proxy, with the ready-made helpers `resolveEscalation({msg_id, choice, note})`
and `ackCoordMessage({msg_id})` in `plans-api.ts`. Phase B's dispatch calls
those (plus `setItemStatus` for plan items) — no bespoke REST route to write.
(Human call, 2026-05-31: "can't our defineTool take care of that?" — yes.)
