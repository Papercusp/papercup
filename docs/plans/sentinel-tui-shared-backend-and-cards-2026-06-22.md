# Plan — Restore the operator shared-backend + card system on the Sentinel/TUI + Queen architecture

**Owner ask (2026-06-22):** bring back the *functionality* of the old operator system — (a) voice and text riding the **same backend** so behavior is identical, and (b) the **interactive card system** — but working with the **new** shape: the **Sentinel chat in the Claude TUI** (zellij) where the **Queen is the brain**. Reuse old code where we can; rewrite where we must.

> This plan is grounded in a read of the old code (how it worked) and the current wiring. File:line refs included so the next engineer can trace it.

> **⚠ SUPERSEDED (2026-06-22, same day).** This plan made the Sentinel =
> `operator:converse` (a lighter brain) rendered in the webview + the `apps/tui`
> ratatui. After driving the live zellij dock we found the owner's actual Sentinel
> is the **`psu --agent=claude` Claude-Code pane**, and the owner directed it to
> become a **full Claude TUI**. The Phase-1 (voice→`operator:converse`) and Phase-2
> (ratatui cards) work shipped here targeted the **wrong surfaces**. The live
> redesign is now **[sentinel-as-claude-tui-2026-06-22](./sentinel-as-claude-tui-2026-06-22.md)**.
> Kept for history + the reusable bits (voice runtime, server card machinery, the
> already-shipped UI changes).

---

## Status & active work (owner-directed, 2026-06-22)

Three workstreams in flight (owner: "continue working on 1,2,3"):

1. **Cross-surface one-thread unification** — voice (desktop webview) and the Sentinel text chat (zellij claude-TUI) now share the same `operator:converse` / Sentinel **brain** (Phase 1, shipped), but NOT yet one conversation **thread** across surfaces. Make the webview voice turn + the TUI text turn target the same `conversationId` (Phase 1 §5 + Phase 3). **Status: not started.**
2. **Phase 2 — cards in the Claude TUI** — render the `openCards` snapshot as ratatui menus + POST `/card-response`; re-enable `chat:ask_choice` on `surface:'tui'` (Phase 2). **Status: in progress (delegated).**
3. **Voice round-trip test + live verification** — a registered test in the `/admin/testing` **Voice domain** exercising transcript → bridge → `operator:converse` → spoken reply, plus a live simulated conversation via the agent-e2e bridge (needs a small dev test-seam to inject a transcript + read the spoken reply — also fills a real agent-e2e gap: there's no way to drive a conversational voice turn today). **Status: in progress.**

**Shipped already (Phase 1 + the UI asks):** voice → `operator:converse` bridge · `speak()` unmute · STT local-whisper fallback · `fullAgentEngine`→off · left-rail voice bar · "Novice" rename · "Sentinel" rebrand (lexicon) · 3-state Active/Passive/Off toggle · heading removal · collapse control relocated · EI-2425 shell `no-store`.

> **Official-plan note:** this markdown doc is the working plan. The PG-backed papercusp plan (`plans:*`) could NOT be created while the `papercusp-su` MCP is disconnected — promote this to a real `plans:new` entry (phases = the sections below) once the MCP reconnects.

---

## 1. How the OLD system worked (the thing we're bringing back)

**One brain, two modes (voice ≡ text).** The papercup sidebar chat was the front door:
- Text: `OperatorChatSidebar` → `conv.sendUserMessage` (`apps/operator/app/_components/OperatorChatSidebar.tsx:254`) → `OperatorConversationProvider.runGeneration` (`OperatorConversationProvider.tsx:1877`) → `operator:converse` (the operator brain) → streamed reply rendered in the sidebar.
- Voice: STT transcript → fed the **same** conversation provider → same `runGeneration` → reply **spoken** via `speak()` (`voice-mode.ts:2009`) + shown in the same sidebar. Design intent note: `voice-mode.ts:45-60`.
- Net: speaking and typing produced identical behavior because both drove `operator:converse` through one `OperatorConversationProvider`.

**The card system (structured, blocking asks).** Two paths, same renderers:
- **Server cards** — the brain calls `chat:ask_choice` (`packages/operator-core/lib/agent-tools/chat/ask_choice.ts`) → `ctx.askUser` (`libs/generic/tooldef/src/dispatch-stack.ts:482`) → **card-correlator** (`libs/generic/tooldef/src/card-correlator.ts`) mints a `correlationId`, blocks the tool call, and mirrors the pending set onto the **state-channel `openCards`** snapshot. Browser renders `PendingCardsBar` (`apps/operator/app/_components/chat/PendingCardsBar.tsx`) → user answers → `POST /card-response` (`packages/operator-core/lib/endpoint-route/routes/operator/card-response.ts`) → `resolveCardResponse` unblocks the brain's tool call with the pick.
- **Client cards** — `askUserLocal` (`apps/operator/lib/chat-cards/ask-user-local.ts`) → `LocalCardHost` (`apps/operator/app/_components/chat/LocalCardHost.tsx`), for UI-only prompts. Both hosts mounted in `OperatorChatSidebar.tsx` (`:270`).
- Voice users answered the **same** server cards by speaking (`packages/operator-core/lib/voice-cards/match-voice-answer.ts`).

---

## 2. What the migration broke (current state)

The sidebar was retired; the live app is `apps/operator-vite`, and chat moved to the **Claude TUI** (`apps/tui`, Rust/ratatui) in a zellij pane.

- **Sentinel chat = `operator:converse` with `role:'sentinel'`, `surface:'tui'`** (`converse.ts:91-101`; alias `sentinel:converse`). Same operator brain, Herald persona. The TUI consumes the converse **text** stream over IPC/SSE (`apps/tui/src/{sse.rs,http.rs,chat_tags.rs}`); it parses only `<say>/<report>/<set_mode>/<sleep>/<spawn>/<continue>`.
- **Queen** is a *separate* role — the autonomous engineer/placement brain (`apps/tui/src/agent_pane_kind.rs`: Queen ♛ and Sentinel 🛡 are sibling auto-roles; lexicon maps `operator`→Queen, `brain`→Queen in the-hive pack).
- **Voice is severed from the chat backend.** Live config: `fullAgentEngine: elevenlabs-conv` → voice routes to **ElevenLabs' hosted agent** (a separate brain), overriding STT/TTS. The fallback local-STT path goes only to **Oracle** (`VoiceAppBridge.tsx:246`), and that's doubly dead: `/api/oracle/chat` 404s on the desktop host, and `speak()` hard-mutes unless `sessionStorage['oracle-tutorial-complete']==='true'` — set **only by e2e tests** (`voice-mode.ts:2015`; confirmed `null` on the live session). The operator conversation's reply generator (`sendUserMessage`/`runGeneration`) is **never called by voice** — its only caller was the retired sidebar (now TESTING-gated, `ChromeShell.tsx:239`).
- **Cards are dead in the live app.** `PendingCardsBar`/`LocalCardHost` were never ported to operator-vite (grep: zero hits). The **TUI deliberately disables** cards: `operator:converse` strips `chat:ask_choice` when `surface:'tui'` (`converse.ts:279-282`) and the prompt forbids it (`converse-prompt.ts:356-376`, "the terminal can't render choice cards"). The **server machinery is fully intact** (correlator, `/card-response`, `/run-cancel`).

**Summary:** voice → EL/Oracle (muted), text → operator:converse via TUI, cards → nowhere. Three separate breaks, all from the sidebar removal.

---

## 3. Target architecture

- **One brain behind the Sentinel chat.** Voice and TUI text both drive the **same** `operator:converse` conversation (same `conversationId`), so behavior is identical across modes — the original "voice ≡ text" property, restored.
- **Cards work in the TUI** — structured asks render as terminal menus (and/or via the inbox/coord bridge), answered back through the existing `/card-response` server contract.
- **Queen-as-brain** honored per the Phase 0 decision below.

---

## 4. Phase 0 — the one design decision to confirm first

**Who is the brain behind the Sentinel chat — the Sentinel persona, or the Queen?**

In code today, the Sentinel chat is the *operator* brain wearing the Herald persona (`operator:converse role=sentinel`); the **Queen** is a distinct engineer brain. The owner says "the queen is the brain." Two coherent readings:

- **(A) Sentinel = front-door persona; Queen = the engineer it dispatches to.** The user converses with the Sentinel (operator:converse); for real engineering work the Sentinel hands off to the Queen (placement/engineer). Minimal change to the converse brain; matches the current sibling-role model.
- **(B) The Sentinel chat IS the Queen.** `operator:converse` (the chat the TUI/voice drive) is backed by the Queen brain/persona directly — one brain that both converses and engineers.

This choice changes *which brain* Phases 1–3 wire voice/text/cards into. **Recommend confirming (A) vs (B) before Phase 1.** (My read: (A) matches the shipped lexicon + TUI role model, with the Queen reachable via dispatch; but this is the owner's call.)

> **DECISION (owner, 2026-06-22): (A).** Sentinel is the conversational front-door persona (`operator:converse role=sentinel`); it **dispatches** engineering work to the Queen (the separate placement/engineer brain). So Phases 1–3 wire voice/text/cards into the **operator:converse / Sentinel** brain, and the Sentinel hands off to the Queen for engineering via the existing dispatch tools — we do NOT replace the converse brain with the Queen.

---

## 5. Quick wins (independent of the big plan — do now)

1. **Unmute `speak()`** — remove/relocate the `oracle-tutorial-complete` gate (`voice-mode.ts:2015`); it's a test-only flag silencing *all* voice output. (1 line.)
2. **STT keyless fallback** — DONE this session: `detectEngines` now falls back to local Whisper when the chosen STT engine is unconfigured (`voice-engines.ts`), fixing the deepgram-no-key dead input.
3. **Decide the voice engine** — `fullAgentEngine: elevenlabs-conv` routes voice to ElevenLabs' brain (not the operator). For the shared-backend goal, set `fullAgentEngine: 'off'` so voice uses the operator STT→brain→TTS path.

---

## 6. Phase 1 — Voice rides the same backend as the Sentinel TUI chat

**Goal:** speaking drives the same `operator:converse` conversation the TUI text chat drives; the reply is spoken.

- Set `fullAgentEngine:'off'` (or make EL Conv an explicit, separate "talk to ElevenLabs" mode, not the default).
- Add an always-mounted **voice→converse bridge** (extend `VoiceAppBridge` or a new component inside `OperatorConversationProvider`): on `onFinalUtterance`, call the conversation's `sendUserMessage`/`runGeneration` (expose it outside the React tree via a ref/singleton — today it's only in the context value at `OperatorConversationProvider.tsx:2044`).
- **Speak assistant turns** when voice is active: pipe `runGeneration`'s assistant output through `speak(text, 'system:operator')` (Kokoro TTS, `:8880` — confirmed up).
- Apply the `speak()` unmute (Quick win #1).
- **Share one conversation across surfaces:** the voice turn and the TUI text turn must target the same `conversationId` so the transcript/brain are unified (the TUI already drives `operator:converse`; point voice at the same conversation).

**Files:** `apps/operator/app/_components/voice/voice-mode.ts` (speak gate, transcript dispatch), `VoiceAppBridge.tsx`, `OperatorConversationProvider.tsx` (expose+call `sendUserMessage`, speak assistant turns), voice prefs default for `fullAgentEngine`.

**Exit check:** speak a phrase → STT transcribes → `operator:converse` (Sentinel/Queen per Phase 0) responds → reply spoken → the SAME turn is visible in the TUI chat transcript.

---

## 7. Phase 2 — Card system in the Claude TUI

The server side (correlator + `openCards` snapshot + `/card-response` + `/run-cancel`) is reusable as-is. The gap is a TUI **renderer + responder**. Two complementary options:

- **2a. Inline terminal cards (faithful parity).** Re-enable `chat:ask_choice` for `surface:'tui'` (un-filter `converse.ts:280-281`, drop the prohibition in `converse-prompt.ts:374`); subscribe the TUI to the state-channel `openCards` snapshot (Rust struct mirroring `card-correlator.ts:85-96`, like `chat_tags.rs` mirrors `<report>`); add a ratatui card widget (radio = arrows/number, checkbox = space, text/date/slider = input line) in `apps/tui/src/{ui.rs,app.rs,+ new card_view.rs}`; on answer POST `/card-response` (reuse `post-card-response.ts` body shape via the existing `apps/tui/src/{http.rs,network.rs}`). Server resolves the brain's blocked tool — **no server change**. *Medium effort, all Rust UI.*
- **2b. Async via the coord/inbox bridge (mostly built).** `chat:ask_choice` already mirrors a card into a coord **escalation** (`coordination/card-link.ts`); `coord:resolve` calls back into `resolveCardResponse`. The TUI already has an Inbox surface — render the escalation there and answer via `coord:resolve`. Needs `INBOX_DURABLE_ESCALATIONS` on + a TUI answer affordance. *Lower effort; async/"answer later" UX rather than inline.*
- **2c. (Optional) client `askUserLocal` host** for any desktop-UI-only prompts in operator-vite (port `LocalCardHost`), if those are still needed outside the TUI.

**Recommend 2a for inline parity + 2b as the durable async path.** Voice-answering of cards (`voice-cards/match-voice-answer.ts`) drops in once voice rides the converse backend (Phase 1) and cards are live again.

**Exit check:** brain calls `chat:ask_choice` in the TUI → a choice menu renders in the pane → arrow/number-select answers it → the brain's tool call returns the pick → flow continues. (And the same answerable by voice.)

---

## 8. Phase 3 — Unify + harden

- Confirm voice + TUI text + cards all flow through the **one** brain (per Phase 0), with identical behavior.
- Replace the 15s "Agent did not respond" timeout (`voice-mode.ts:240`) UX with real round-trip success.
- Tests: an LLM-scenario or e2e that drives a voice turn → converse reply → spoken; a TUI card render+answer test (Rust + a server integration test on `/card-response`).
- Retire the dead Oracle voice fallback path (or fix `/api/oracle/chat`) so there's no silent dead branch.

---

## 9. Risks / open questions

- **Phase 0 brain routing (A vs B)** — gates everything; confirm with owner.
- **EL Conv full-agent** — keep as an explicit alternate voice mode, or drop? It's a different brain (breaks "same backend") by design.
- **TUI card work is Rust** (ratatui) — the only non-TS surface; scope accordingly.
- **Conversation identity across surfaces** — voice and TUI text must share `conversationId`/brain or they'll diverge again.
- **Reuse vs rewrite** — server card machinery + `operator:converse` + voice-mode runtime are reusable; the *renderers* (sidebar `PendingCardsBar`/`LocalCardHost`) are rewritten as TUI widgets (2a) since the surface changed from web to terminal.

---

## 10. Reuse map (old code → new home)

| Old (reusable) | New home |
|---|---|
| `operator:converse` brain, `OperatorConversationProvider.runGeneration` | Same brain; voice bridges into it (Phase 1) |
| voice-mode runtime (STT/TTS, `speak()`) | Same; unmute + route to converse (Phase 1) |
| card-correlator, `openCards` snapshot, `/card-response`, `/run-cancel` | Reused as-is; TUI becomes a new consumer (Phase 2a) |
| `chat:ask_choice`, `ctx.askUser`, `voice-cards/match-voice-answer` | Reused; re-enabled on `surface:'tui'` |
| `PendingCardsBar`/`LocalCardHost`/`AskChoiceCard` (web renderers) | **Rewritten** as ratatui widgets in `apps/tui/src` |
| coord `card-link`/`escalations`/`coord:resolve` | Reused for the async card path (Phase 2b) |
