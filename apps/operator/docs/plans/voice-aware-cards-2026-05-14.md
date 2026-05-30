---
title: Voice-aware cards — 2026-05-14 (v2)
slug: voice-aware-cards-2026-05-14
status: shipped
created: 2026-05-14
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** Make `ctx.askUser` / `chat:ask_choice` first-class in voice mode: the brain emits **one card** regardless of modality, the voice surface **announces it**, the user **answers by speaking**, and the spoken answer **resolves the in-flight `ctx.askUser` promise** through the same `/card-response` path the text surface uses.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Voice-aware cards — 2026-05-14 (v2)

Make `ctx.askUser` / `chat:ask_choice` first-class in voice mode: the brain emits **one card** regardless of modality, the voice surface **announces it**, the user **answers by speaking**, and the spoken answer **resolves the in-flight `ctx.askUser` promise** through the same `/card-response` path the text surface uses.

This plan absorbs the Ready-card silence-nudge work (see §G) — that becomes the simplest possible test case for the voice-aware-card path. The narrow text-only edits already on disk (`silence_after_question` text/voice split in three files) are reverted as part of Phase 0.

**v2 changes (from review):**
- §C.1a added — snapshot-arrival race fix (H1): brain emits a `tool-call` SSE event before the state-snapshot lands, so the provider arms a "pending card incoming" flag on tool-call and buffers transcripts (≤1 s) until the snapshot resolves a `correlationId`.
- §C.2 rewritten — explicit precedence (M2: id > label > decline > substring); STT confidence in the parser contract (M1, default 0.6); ambiguity disambiguation extracted to a separate composer (H2) split for separation-of-concerns, not "purity"; max-2 disambiguation rounds (M5); `voiceAnswerable` honored only when `presentation.kind === 'radio'` (M6).
- §C.3 — `voiceAnswerable` default flipped to **false** (H3). Phase 6 Ready card sets it explicitly. Telemetry-driven follow-up to consider flipping later.
- §C.7 — head-of-queue selection moved into a shared `selectFocusedCard(openCards)` helper, consumed by both `PendingCardsBar` and the voice router (M4).
- §C.10 added — two prefs are explicitly distinct (L2): `voice.cardAnsweringEnabled` (master kill-switch for STT routing) vs `voice.speakOpenCards` (announce aloud).
- §D — new **Phase 0.5** Realtime state-snapshot spike (H4) before Phase 1 commits; Phase 7 writes deferred-followup entries with revisit triggers, not just lists them (L3).
- §G + §H — answers to original Q1–Q5 inlined; M3 (announcement-started timing) moved to deferred-followups with a concrete telemetry trigger.
- §B — wording corrected (L4): EL Conv AI reads state-snapshot frames from the chat-stream SSE consumer (same stream as deltas), not via `useStateSnapshots`.

---

## A. Goals & non-goals

### Goals
- One mental model: cards work the same way in text and voice. Brain doesn't have to choose a different output shape based on modality.
- Spoken answers route through `/card-response` (same auth, same correlator, same resolution path), not through `user_message`.
- The Ready-card silence nudge becomes the first card that works end-to-end in voice (announce + resolve by saying "ready").
- Mid-card mode switches (text → voice → text) keep the same card alive and answerable from either surface.

### Non-goals
- Multi-card concurrency in voice. v1 voice-answers the **head of the queue** only.
- Complex card shapes in voice. v1 covers `radio` (1 pick) and the implicit single-option Ready card. `checkbox` (multi), `text`, `date`, `slider` stay text-only until proven needed. Brain is told this in the prompt; in voice it's allowed to emit `chat:ask_choice` only when `multi !== true` and `options.length <= 6`.
- New brain proactivity ("active mode actually tickles itself"). That arc is separate — call it out as a follow-up and keep it out of this plan.
- Scanner→brain wiring. May-5 decision (Option J) stands.

### Out of scope but explicitly preserved
- `fallbackText` voice-announce path that already exists in `lib/voice-engines/elevenlabs-conv.ts` (lines 562–650). v1 extends and reuses it; never replaces it.
- Bespoke-card-improvements v2 contract: `{action, payload}`, `submit|decline|cancel`, `presentation`, `dataSchema`.

---

## B. Current state (verified 2026-05-14)

### What already works
- **Text surface**: full bespoke-card flow. Brain emits `chat:ask_choice` → state-snapshot writes an `openCards[]` entry → `PendingCardsBar` (chat thread) and/or `LocalCardHost` (OracleDock) render → user clicks → `POST /api/operator/conversations/:id/card-response` → `resolveCardResponse` resolves the `ctx.askUser` promise → brain continues same turn.
- **EL Conv AI voice engine**: `askOperatorViaSse` reads state-snapshot SSE frames from the same chat-stream SSE consumer that handles delta frames (NOT via `useStateSnapshots` — that's client-only and the engine sits server-side of it), collects `fallbackText`/`prompt` from `openCards`, appends to the spoken response. So a card *emitted* during a voice turn is at least **read aloud** today.
- **OpenAI Realtime voice engine**: no card awareness. State-snapshot frames are ignored.
- **STT path** for both engines: `onTranscript` → `emitOperatorUserTurn` → `papercusp:operatorUserTurn` window event → `OperatorConversationProvider.onVoiceUserTurn` → next `runGeneration` as `user_message` / `user_says_ready` / `quiet_wait_resume`. **Never to `/card-response`.**
- **Tool catalog**: `chat:ask_choice` is declared `modality:['text']` (`apps/operator/lib/agent-tools/chat/ask_choice.ts:75`). In voice turns it's filtered out of the catalog and the prompt instructs the brain not to emit it.

### What doesn't work
1. Brain can never emit `chat:ask_choice` in voice (catalog-filtered).
2. Realtime engine doesn't speak open-card prompts at all.
3. There is no STT-side router that classifies "this utterance is answering an open card" vs "this utterance is a new user message," so spoken answers always become `user_message` and the in-flight card hangs until its 120s idle timeout aborts the run.
4. `chat:ask_choice` and bespoke `ctx.askUser` calls have no voice-tailored option-naming or matcher (option labels were designed for buttons, not phonemes).
5. The text-only Ready-card edits sitting on disk encode "voice keeps the spoken-only affordance" as a permanent rule. That's wrong if we're doing voice-aware cards.

### Wires we can reuse (the cheap parts)
- State-snapshot SSE: already flows through both `useStateSnapshots` (client) and the EL engine (server-side intermediary).
- `/api/operator/conversations/:id/card-response`: already accepts `{correlationId, action, workspaceId, payload?}`. No schema change needed.
- `useStateSnapshots()`: client-side openCards subscription exists; voice-side just needs to attach.
- `aria-live-bus` / `OperatorVoiceAnnouncer`: pre-built announcement plumbing with priority/dedup. Cards become another publisher.

---

## C. Design

### C.1 Card-aware STT routing (the load-bearing decision)

The conversation provider gains a per-card **answer claim window**. When the client sees a new openCard via the state-snapshot stream:

1. If voice is active and the card's `voiceAnswerable` is true (see C.3 for which cards qualify), the provider sets `state.activeVoiceCard = {correlationId, workspaceId, presentation}`.
2. While `activeVoiceCard != null`, the existing `onVoiceUserTurn` handler **first** invokes `matchVoiceAnswer(transcript, card)` (Phase 1 pure library). Behavior per result:
   - `{action:'submit', payload}` / `{action:'decline'}` → POST `/card-response`, clear `activeVoiceCard`, **do not** dispatch `runGeneration`.
   - `{action:'ambiguous', candidateIds}` → call `composeAmbiguityPrompt(card, candidateIds)`, speak via the announcer, leave the ref armed, **do not** dispatch `runGeneration`. Repeat for up to 2 disambiguation rounds; on the 3rd ambiguous result, fall through to today's `user_message` behavior with the original transcript and clear the ref (M5).
   - `null` (no match) → today's behavior. Card stays open in the chat surface; no announcement (per answered Q2 — silence is fine because the card is still visible). The deferred-followup entry will track whether users miss a "keep the card open" announcement.
3. The card is cleared by the next state-snapshot showing it gone (server resolved it), by an explicit `decline`, by the run aborting, by 120 s idle (server-side), or by `voiceActive: false`.

Why "first try the card, then fall back to user_message" instead of voice-side classification? Because the user can always change the conversation away from the card ("actually wait, let me ask something else first"). Hard-routing every utterance to the card would trap them. Soft routing — try-parse-then-fallback — is the well-trodden voice-agent pattern.

### C.1a Snapshot-arrival race (H1 from v2 review)

There is a window between the brain emitting `chat:ask_choice` and the resulting state-snapshot reaching the client (SSE serialization + network — typically ≤200 ms, occasionally more). During that window the user can already start speaking the answer to a card they just heard the brain narrate. Without a guard, that transcript arrives **before** `activeVoiceCardRef` is armed and gets dispatched as a `user_message` — the card then hangs until the 120 s server-side idle resolve.

The chat-stream SSE emits a typed `tool-call` event for `chat:ask_choice` *before* the state-snapshot rides through (verified — see `operator-converse` SSE event sequence). The provider therefore arms in two stages:

1. **Pending-card flag** — on observing `tool-call` for `chat:ask_choice`, set `pendingVoiceCardRef = {toolCallId, observedAtMs}`. From this moment, any incoming voice transcript is **buffered** (held in a small queue, not dispatched) for up to `BUFFER_WINDOW_MS = 1000`.
2. **Resolution** — on the matching state-snapshot landing (correlator binds `toolCallId` to `correlationId`), `activeVoiceCardRef` arms with the real card spec; buffered transcripts are replayed through the C.1 router. If `BUFFER_WINDOW_MS` elapses without a snapshot, buffered transcripts flush as `user_message` (today's behavior); `pendingVoiceCardRef` clears.

This also handles M3 partially: a transcript whose `tsMs` is **earlier than** `pendingVoiceCardRef.observedAtMs - 250 ms` is unambiguously pre-card and bypasses the buffer (dispatched immediately as `user_message`). True "user answered before the announcement finished" remains a v1.1 follow-up — see §H.

Cleanup: `pendingVoiceCardRef` also clears on tool-call abort, on voice deactivation, and on workspace switch.

### C.2 Spoken-answer parser

The parser is a pure function (no side effects, no I/O) that maps a normalized transcript + a card spec to a match result. It ships as `apps/operator/lib/voice-cards/match-voice-answer.ts`.

#### Contract

```ts
interface VoiceTranscript {
  text: string;           // raw STT output
  confidence?: number;    // 0..1 if engine reports it (Realtime does; EL doesn't reliably)
  tsMs: number;           // finalized-at timestamp, captured at STT
}

type MatchResult =
  | { action: 'submit'; payload: { picks: string[] } }
  | { action: 'decline' }
  | { action: 'ambiguous'; candidateIds: string[] }
  | null;  // fall through to user_message

function matchVoiceAnswer(
  transcript: VoiceTranscript,
  card: OpenCardSnapshot,
  opts?: { minConfidence?: number },  // default 0.6 (short labels → high baseline confidence)
): MatchResult;
```

#### Precedence (M2 — explicit, in order; first match wins)

1. **Exact match against an option `id`** → `submit`. Brain-authored ids (`ready`, `yes`, `no`) are stable and phoneme-clean; this is the highest-signal path and the one the Ready card relies on.
2. **Exact match against an option `label`** (case-insensitive, punctuation-stripped, whitespace-collapsed) → `submit`.
3. **Exact match against a decline phrase** (`skip`, `cancel`, `never mind`, `not now`, `forget it`) → `decline`. Note: precedence below labels means an option literally named "Skip this step" wins over the global `skip` phrase.
4. **Single substring match against option labels** (token-bounded, stop-words removed) → `submit` *only if exactly one option matches*. Multiple substring matches → `ambiguous` with the matching ids.
5. Anything else → `null`.

Special-case: if `card.options.length === 1`, the ready-style phrases `ready`, `continue`, `go`, `ok`, `okay` match the lone option's id at step 1. This makes the Ready card work for "say ready" without depending on label phonetics.

#### Confidence gate

If `transcript.confidence` is present and `< opts.minConfidence`, the parser returns `null` (fall through) even when a match would otherwise succeed. Default `minConfidence: 0.6`. The Realtime engine fills `confidence` from its native scoring; EL Conv AI doesn't expose it reliably so the parser sees `undefined` and the gate is skipped (today's behavior).

#### Coverage by presentation kind

| Kind | Honored? | Notes |
|---|---|---|
| `radio` (`options.length >= 1`, treated as single-select when `multi !== true`) | **yes** | v1 target |
| `checkbox` (multi) | no | brain prompt forbids; if one slips through, parser returns `null` and the announce-only path applies |
| `text` / `date` / `slider` | no | same |
| Bare `ctx.askUser` with no `presentation` | no | M6 — only `presentation.kind === 'radio'` opts in |

#### Separated composer (H2 — separation of concerns, not purity)

Ambiguity prompt composition lives in a sibling file `apps/operator/lib/voice-cards/compose-ambiguity-prompt.ts`. It's also pure (composing a string from a card is a pure operation) — the split exists because **matching is a stable, language-agnostic problem; phrasing is TTS-aware and likely to churn**. Two files = two test suites = the matcher can stay frozen while phrasing evolves.

```ts
function composeAmbiguityPrompt(card: OpenCardSnapshot, candidateIds: string[]): string;
// e.g. "Did you mean Use the existing version, or Generate a new one?"
```

Phase 2's runtime wiring calls `matchVoiceAnswer` first, then on `ambiguous` calls `composeAmbiguityPrompt` and pipes the result through `OperatorVoiceAnnouncer`.

### C.3 Which cards opt into voice (H3 — default false)

A new optional field on `CardPresentation` (radio only — M6) and on `chat:ask_choice` args: `voiceAnswerable?: boolean`.

**Default: `false`.** Today's behavior is preserved for every existing call site that doesn't explicitly opt in. Cards announce their `fallbackText` (today's path) but voice cannot answer — the user must click.

To opt in, a tool author sets `voiceAnswerable: true`. The Ready card in Phase 6 sets it explicitly. The brain prompt (§C.4) encourages cards for closed questions ≤ 6 options *regardless of modality*, but doesn't require the brain to predict which call sites are voice-friendly — that judgment is local to each tool.

Why default-false (revised from v1's default-true): the reviewer's counter-example was decisive — existing 1-pick cards with click-designed labels like "Use the existing version" / "Generate a new one" will mis-route on STT and replace a working click experience with a worse voice one. Default-false keeps the new path opt-in until telemetry shows the parser's miss-rate is acceptable for unconstrained labels. See §H for the revisit trigger.

This is an additive optional field — no breaking schema change.

### C.4 Brain prompt changes

Three converse-prompt sites get a single new note replacing the today-incorrect "in voice, don't emit `chat:ask_choice`" lines:

> When asking a closed question with ≤ 6 short labelled options, emit `chat:ask_choice` regardless of modality. Voice users will hear the question (`fallbackText`) and either click on the chat surface or — if the call site explicitly opts in via `voiceAnswerable: true` — speak their pick by label or id. Reserve `<say>` lists for genuinely open-ended prompts that don't fit a card.

The brain doesn't have to *predict* `voiceAnswerable`; it's set by each tool's own author. From the brain's perspective the call shape is the same. The Ready card (Phase 6) is the one explicit voice-answerable card in v1.

The `silence_after_question` instruction collapses back to the modality-agnostic single-option Ready card (no text/voice branching). Voice announces "say ready when you want to continue, or click Ready" via the card's `fallbackText`, exactly as if a tool had asked.

The voice tool-catalog filter drops `modality:['text']` from `chat:ask_choice`. New helper `isVoiceAnswerableCardTool(name)` (in `lib/tools-catalog.ts`) keeps non-card text-only tools (file viewers, etc.) filtered. `chat:ask_choice` is voice-emittable always; whether the resulting card auto-resolves on voice is up to the individual call site's `voiceAnswerable` flag.

### C.5 Realtime engine parity

`lib/voice-engines/openai-realtime.ts` doesn't currently watch the state-snapshot stream. v1 wires it to the same subscriber the chat surface already uses (`useStateSnapshots` is client-only, so the engine uses the underlying SSE consumer directly) so the engine can speak open-card prompts the same way EL does. Plumbing-only — the prompt-aloud and parser-on-transcript live in the conversation provider, not in the engine.

### C.6 Mode-switch behavior

If the user switches text → voice with a card pending: state-snapshot announces it via `OperatorVoiceAnnouncer` (new publisher). If they switch voice → text: the card is already visible in `PendingCardsBar`. The card itself doesn't care; only the routing of the answer differs by which surface clicked / spoke last.

The `activeVoiceCard` ref clears on `voiceActive: false`, so a text answer (button click) wins without contention. Re-arming on voice-on uses the latest state-snapshot.

### C.7 Concurrency / queue (M4 — shared focused-card helper)

State channel can hold multiple openCards. v1 voice-routes against **the same card the chat surface displays first** — consistency over freshness. Today `PendingCardsBar` renders one card at a time; this plan formalizes the selection in a shared helper:

```ts
// apps/operator/lib/chat-cards/select-focused-card.ts
export function selectFocusedCard(openCards: OpenCardWithRun[]): OpenCardWithRun | null;
// Implementation: openCards is already in createdAt-ascending order from the correlator
// (verified in apps/operator/lib/use-state-snapshots.ts:100-104), so the helper returns
// openCards[0] for now. Centralizing the choice means changing it later (e.g. priority
// flags, run-id grouping) flips both surfaces at once.
```

Both `PendingCardsBar` (text) and the new voice router (`onVoiceUserTurn`'s card-resolution branch) consume `selectFocusedCard`. If the user verbally answers a non-focused card, the parser may misattribute — accepted v1 risk because two cards open at once is the brain's bug to begin with, and the user can always switch surfaces and click the right one.

### C.8 Idle / timeout

`ctx.askUser` already has a server-side idle-resolve (`{action:'cancel'}` on workspace switch / run abort / 120s). v1 doesn't change this. The voice surface inherits it: if the user doesn't answer, the card eventually resolves cancel and the brain continues. No new client-side timer needed.

### C.9 Logging / replay

`/card-response` already audits text answers. Voice answers POST through the same route — the only addition is a `source: 'voice_stt'` annotation in the body so the audit log can distinguish. `resolveCardResponse` accepts this passthrough; correlator stores it.

### C.10 Two voice prefs — distinct concerns (L2 from v2 review)

Two prefs in `loadVoicePrefsClient()`, intentionally separate:

| Pref | Default | Controls | Personas it serves |
|---|---|---|---|
| `voice.cardAnsweringEnabled` | `true` | Whether STT transcripts route to `/card-response` at all. Off = STT never resolves cards; click is required even when `voiceAnswerable: true`. | "I want voice in, voice out, but I'm paranoid about misheard answers on consequential prompts." |
| `voice.speakOpenCards` | `true` | Whether the announcer reads card prompts aloud when the panel is closed. Off = silent UI; user discovers the card by looking. | Accessibility / quiet office — wants cards spoken but not answered by voice (or vice-versa). |

The crossed case (speak on, answer off) is the most likely "I tried this and didn't like it" path: a user hears the card spoken, tries answering, gets misheard, decides clicking is safer. Toggling answer off without losing the announcement should be a one-tap fix.

---

## D. Phased implementation

### Phase 0 — undo the text-only Ready-card edits (revert)

- Revert the three files edited last turn:
  - `apps/operator/prompts/operator.converse.md`
  - `apps/operator/lib/operator-converse-prompt.ts`
  - `apps/operator/lib/agent-tools/operator/converse-prompt.ts`
- Single commit, no functional change vs main pre-edits.
- Rationale: those edits hard-coded the wrong rule. They get re-introduced (differently) in Phase 3 and Phase 6.

### Phase 0.5 — Realtime engine state-snapshot spike (H4 from v2 review)

**Goal: 30-min spike, lands before Phase 1.** Inspect `lib/voice-engines/openai-realtime.ts` and the chat-stream SSE shape it consumes. Answer:

- Does the Realtime engine consume `event: state-snapshot` SSE frames today? (Hypothesis: no — only EL does.)
- If no, where would the integration point sit? (Hypothesis: in the SSE consumer at the same layer EL handles it.)
- Does Realtime expose per-utterance `confidence` to `onTranscript`? (Hypothesis: yes — verify the callback shape.)
- Does Realtime emit a usable "announcement-started" timestamp anywhere? (Hypothesis: no — defer M3 if confirmed.)

Output: a short note appended to this plan as **§K — Realtime spike findings**. Decision gate: if Realtime architecture diverges enough that Phase 4 grows past 1 day, surface that here before committing further. Parser API in Phase 1 is engine-agnostic so it lands regardless — confirmed by the spike, not blocked by it.

### Phase 1 — voice-answer parser + ambiguity composer

- New `apps/operator/lib/voice-cards/match-voice-answer.ts`: pure function per §C.2 contract (confidence-aware, presentation-kind-gated to `radio`, precedence id > label > decline > substring).
- New `apps/operator/lib/voice-cards/compose-ambiguity-prompt.ts`: pure string composer per §C.2's separation-of-concerns split.
- New `apps/operator/lib/voice-cards/decline-phrases.ts`: shared phrase list with `isDeclinePhrase(normalized: string)`.
- Unit tests: every match/ambiguity/decline/null branch, every precedence-collision case (M2 examples — "Skip this step" option vs `skip` global phrase), confidence threshold boundary (M1), `presentation` absent / non-radio (M6), ready-card special phrase set. ~40 tests across the three files.
- Zero runtime wiring yet — pure libraries land first.

### Phase 2 — provider STT-card routing

- `OperatorConversationProvider` gains `activeVoiceCardRef` (active card) and `pendingVoiceCardRef` (in-flight tool-call awaiting snapshot, per §C.1a).
- New `selectFocusedCard` helper (`apps/operator/lib/chat-cards/select-focused-card.ts`) consumed by both `PendingCardsBar` and the provider (M4).
- Subscribe to:
  - Tool-call events on the chat-stream SSE → arm `pendingVoiceCardRef` (`tool: 'chat:ask_choice'`) with a `BUFFER_WINDOW_MS = 1000` timer.
  - State-snapshot events → resolve `pendingVoiceCardRef` to `activeVoiceCardRef`, replay buffered transcripts.
- Modify `onVoiceUserTurn`:
  - If `pendingVoiceCardRef.set`: buffer the transcript (or fast-fail if `tsMs < pendingVoiceCardRef.observedAtMs - 250 ms`).
  - If `activeVoiceCardRef.set`: invoke `matchVoiceAnswer`; route per §C.1. Honor max-2 disambiguation rounds (M5).
  - Otherwise: today's behavior.
- Clear refs on `voiceActive: false`, workspace switch, tool-call abort, run completion without snapshot, state-snapshot showing card gone.
- Provider tests: every C.1 route, the C.1a race window (both pre-card and post-card transcript arrival), buffer-expiry path, max-2 disambiguation, mode-switch clearing, `voiceAnswerable: false` card never arms the ref. ~15 tests.

### Phase 3 — brain prompt + tool catalog + schema

- Drop `modality:['text']` from `chat:ask_choice` registration. Update tool-catalog filter helper (`isVoiceAnswerableCardTool`).
- Add `voiceAnswerable?: boolean` field (optional, default false per §C.3) to `CardPresentation` (radio only — M6) and to `chat:ask_choice` args (`packages/agent-mcp/src/types.ts` + `apps/operator/lib/agent-tools/chat/ask_choice.ts`).
- Update three converse-prompt sites per §C.4. Single unified "use cards regardless of modality" instruction, with the `voiceAnswerable` opt-in clarified.
- Brain-prompt unit tests assert the new instruction renders in both modalities; the strict "no `chat:ask_choice` in voice" line is gone; the `silence_after_question` line is the unified Ready-card form.

### Phase 4 — Realtime engine state-snapshot parity

- Implement state-snapshot reading in `lib/voice-engines/openai-realtime.ts` per Phase 0.5's findings.
- Surface `confidence` to `onTranscript` if Phase 0.5 confirmed it.
- Tests with mocked SSE frames, mirroring `lib/voice-engines/elevenlabs-conv.test.ts`.

### Phase 5 — `OperatorVoiceAnnouncer` extension

- New `'operator:cardOpen'` window event published by the provider on state-snapshot diff (openCards entry added). Carries `{correlationId, fallbackText, prompt}`.
- `OperatorVoiceAnnouncer` listens; respects `voice.speakOpenCards` pref (§C.10, default true) and the existing panel-closed cadence gating.
- Speaks the card's `fallbackText` or `prompt`. Idempotent per `correlationId` (dedup set).
- Disambiguation-prompt announcements (Phase 2's ambiguous path) route through the same announcer at `polite` priority.
- Tests: prefs off → silent, panel open → silent (chat surface owns it), dedup across re-render, disambiguation announcement fires for ambiguous results.

### Phase 6 — Ready-card silence nudge as the integration test case

- Rewrite the `silence_after_question` trigger output: brain emits a single-option `chat:ask_choice` with `voiceAnswerable: true`, option `{id: 'ready', label: 'Ready'}`, and `fallbackText: "Say ready when you want to continue, or click Ready."`
- Provider continues to set `sub: 'nudged'` after the trigger (so the 30 s timer doesn't re-arm) — preserved from today.
- E2E spec (`apps/operator/e2e/voice-ready-card.spec.ts`, Playwright per project convention) — mocked STT → emit "ready" → assert `/card-response` POST with `{action:'submit', payload:{picks:['ready']}, source:'voice_stt'}` → assert brain receives the resolved tool call → assert no `user_message` / `user_says_ready` dispatch occurred.
- Text-mode regression in the same spec: card visible, click Ready, same resolution path with `source` absent or `text_typed`.

### Phase 7 — Documentation + deferred-followups (L3 expanded)

- Update `apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md` with a "voice-aware-cards extension landed" note pointing at this plan.
- Append concrete entries to `apps/operator/docs/deferred-followups-2026-05-14.md`, each with a **revisit trigger** (not just "later"):
  - **Flip `voiceAnswerable` default to true** — *trigger:* parser miss-rate < 5% in telemetry across ≥ 50 voice-card answers from real users (instrumented via `/card-response` audit + outcome correlation). *Owner:* whoever closes the next voice-arc plan.
  - **Multi-card voice handling** — *trigger:* observation in logs of ≥ 1 brain turn emitting two concurrent `ctx.askUser` calls in a voice-active session.
  - **`checkbox` / `text` / `date` / `slider` voice support** — *trigger:* explicit user ask or a tool's design needs it.
  - **Announcement-started timing (M3)** — *trigger:* ≥ 3 audit-logged occurrences of answered-before-heard misroutes (transcript matches card but `tsMs - announcement_start_estimate < 0`).
  - **Brain-side `<sleep>` discipline + active-mode proactive ticks** — *trigger:* user follow-up on the original "operator is passive" complaint after this plan ships, or telemetry showing < 1 brain turn per active hour outside reactive replies.
  - **No-match "I'll keep the card open" announcement** — *trigger:* explicit user feedback that cards going answered-but-not-acknowledged is confusing.

---

## E. Test plan (concrete files)

```
NEW
apps/operator/lib/voice-cards/match-voice-answer.test.ts             ~30 cases  (Phase 1)
apps/operator/lib/voice-cards/compose-ambiguity-prompt.test.ts        ~6 cases  (Phase 1)
apps/operator/lib/voice-cards/decline-phrases.test.ts                 ~6 cases  (Phase 1)
apps/operator/lib/chat-cards/select-focused-card.test.ts              ~4 cases  (Phase 2)
apps/operator/app/_components/OperatorConversationProvider.voice-cards.test.tsx
                                                                     ~15 cases  (Phase 2)
apps/operator/lib/voice-engines/openai-realtime.state-snapshot.test.ts
                                                                      ~4 cases  (Phase 4)
apps/operator/app/_components/voice/OperatorVoiceAnnouncer.cards.test.tsx
                                                                      ~6 cases  (Phase 5)
apps/operator/e2e/voice-ready-card.spec.ts                            ~3 cases  (Phase 6)

EXTENDED
apps/operator/lib/operator-want-active.test.ts            (silence path goes via card, not <say>)
apps/operator/lib/agent-tools/chat/ask_choice.test.ts     (voiceAnswerable schema field, default false)
packages/agent-mcp/src/__tests__/types.test.ts            (CardPresentation new field on radio only)
apps/operator/app/_components/chat/PendingCardsBar.test.tsx (consumes selectFocusedCard helper)
```

Key invariants the tests must lock in:
1. Spoken "ready" with the Ready card pending → exactly one `/card-response` POST with `source: 'voice_stt'`, zero `user_message` generations.
2. Spoken "ready" with no card pending → unchanged today behavior (`user_says_ready` trigger fires).
3. `matchVoiceAnswer` returning `ambiguous` → composer runs, announcer speaks disambiguation, card stays open, no POST. After 2 ambiguous rounds the 3rd transcript falls through to `user_message` and clears the ref (M5).
4. Card pending in voice → mode switch to text → click answers normally, voice-side ref cleared without race.
5. State-snapshot drops card mid-flight (run abort) → `activeVoiceCardRef` clears, no stale POST.
6. Transcript arrives between tool-call and state-snapshot (C.1a race) → buffered and replayed correctly. Transcript arriving >250 ms *before* tool-call event bypasses the buffer.
7. Decline phrase "skip" with an option literally labeled "Skip this step" → submits the option (M2 precedence). Plain "skip" with no such option → declines.
8. Card with `voiceAnswerable: false` → never arms `activeVoiceCardRef`, even in voice mode. Announce-only path still works.
9. Confidence below `minConfidence` → parser returns null even on exact match (M1).

---

## F. Rollout

- Two new prefs per §C.10:
  - `voice.cardAnsweringEnabled` (default **true**) — user can disable STT routing entirely.
  - `voice.speakOpenCards` (default **true**) — user can disable announcer reading aloud.
- No feature flag at the registry / endpoint-system level — pure-client behavioral change, low blast radius. Pre-alpha freedom.
- Backwards-compat: `chat:ask_choice` without explicit `voiceAnswerable` defaults **false** (§C.3, H3 revision). Every existing call site behaves exactly as today.

---

## G. Decisions (v1 Q1–Q5 resolved by v2 review)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Voice ambiguity handling | Speak the disambiguation prompt (`composeAmbiguityPrompt`), not the original card prompt. | Friendlier, faster, and the question already worked once — only the answer was unclear. |
| 2 | No-match announcement | No announcement in v1. Card stays visible in the chat surface. | Pre-alpha noise > value. Add opt-in pref later if users miss it (see §H revisit trigger). |
| 3 | `voiceAnswerable` default | **false** — explicit opt-in only. | H3: existing 1-pick cards with click-designed labels will mis-route on STT; default-false preserves today's UX everywhere it's already working. |
| 4 | Decline confirmation | No confirmation. | Pre-alpha. Friction is worse than the rare accidental skip; user can re-trigger if needed. |
| 5 | Ready-card persistence | Transient (like all `ctx.askUser` cards today). | The silence nudge is reactive — reload restarts the cycle. Persistence would conflict with `sub: 'nudged'`'s once-per-cycle gate. |

---

## H. Deferred follow-ups (Phase 7 writes these into `deferred-followups-2026-05-14.md` with revisit triggers)

Each entry below carries an explicit trigger so future-us doesn't re-debate priority — the trigger fires, the work moves up.

- **Flip `voiceAnswerable` default to true.** *Trigger:* parser miss-rate < 5% measured across ≥ 50 voice-card answers from real users (audit log + outcome correlation).
- **No-match "I'll keep the card open" announcement.** *Trigger:* ≥ 2 user reports that voice-answering a card without acknowledgement is confusing.
- **Announcement-started timing (M3 from review).** *Trigger:* ≥ 3 audit-logged occurrences of answered-before-heard misroutes. Requires engine plumbing for announcement-start timestamps.
- **Multi-card voice handling.** *Trigger:* observation of ≥ 1 brain turn with two concurrent `ctx.askUser` calls in a voice-active session.
- **`checkbox` / `text` / `date` / `slider` voice support.** *Trigger:* explicit user ask or tool-design need.
- **Active-mode proactive ticks** (the *original* "operator is passive" complaint). Separate plan, separate scope. *Trigger:* user follow-up on the original passivity complaint after this plan ships, or telemetry showing < 1 brain turn per active hour outside reactive replies.
- **Brain-side `<sleep>` discipline as back-pressure.** Drops out of the active-mode arc, not this one. *Trigger:* same as proactive-ticks entry.

---

## I. Phase ↔ PR sizing

| Phase | Files touched | Roughly | Reviewable in isolation? |
|---|---|---|---|
| 0 | 3 (reverts) | 5 min | yes |
| 0.5 | 0 (spike, appends §K) | 30 min | yes — output is a written finding |
| 1 | 3 new + 3 test | ~half day | yes (library only) |
| 2 | 2 + 2 test | ~1 day | yes (depends on Phase 1) |
| 3 | 4 prompt + 2 schema + 2 test | ~half day | yes (depends on Phase 1, 2) |
| 4 | 1 + 1 test | depends on §K | yes (parity-only) |
| 5 | 1 + 1 test | ~half day | yes |
| 6 | 1 prompt + 1 e2e + provider tests | ~half day | yes (final integration) |
| 7 | 2 doc | trivial | yes |

Total: ~3–3.5 dev days + half-day review buffer. Phases land in order; 4 and 5 can shuffle. Phase 4's size is the one unknown until Phase 0.5 lands.

---

## J. Risks

- **STT mishears option labels.** A user saying "A" or "yes" against a card with two long-label options will trip ambiguity often. Mitigation: precedence-1 id-match (M2), so brain-authored stable ids (`ready`, `yes`, `no`) match even when label phrasing varies; default-false `voiceAnswerable` (H3) keeps unconstrained labels out of the voice path entirely.
- **Snapshot-arrival race (H1).** Mitigated by §C.1a pending-card buffer; explicit tests in Phase 2.
- **Realtime engine state-snapshot plumbing unknown.** Resolved by Phase 0.5 spike before Phase 1 ships.
- **Confidence-gate too strict / too loose.** v1 default 0.6 chosen because card option labels are short and STT engines bias toward high confidence on short utterances. Adjustable per call site via `opts.minConfidence`. Telemetry will tell us if 0.6 is wrong; pref doesn't need a UI yet.
- **Answered-before-heard (M3).** Deferred per §H. The C.1a buffer covers the most common case (transcript before snapshot); the rarer "transcript after snapshot but before announcement TTS finishes playing" stays a known v1 gap.

---

## K. Phase 0.5 spike findings — Realtime engine state-snapshot plumbing (2026-05-14)

**TL;DR:** OpenAI Realtime is architecturally different from EL Conv AI. v1 scope shrinks to **EL Conv AI + text-via-state-snapshot** only. Realtime voice users get unchanged behavior in v1 (no voice-aware cards in Realtime sessions). Phase 4 is deferred-followup, not part of this plan.

### What I learned

`lib/voice-engines/openai-realtime.ts` opens a direct WebRTC session between the user's browser and OpenAI Realtime. The Realtime agent **is** the operator brain in voice mode — `buildInstructions(...)` bakes `OPERATOR_PERSONA_PROMPT`, `OPERATOR_CONVERSE_PROMPT`, `TOOL_ROUTING`, and `OPERATOR_FEW_SHOTS` into the session at connect time. The agent's tool surface is the **commands registry** (panel toggles, navigate, scan, approve, across-workspaces) plus `delegate_to_claude`. The Realtime agent never calls `chat:ask_choice` directly — that tool lives behind `/operator-converse`, which the Realtime path bypasses entirely.

Concretely:
- No `/operator-converse` SSE consumer exists in the Realtime engine. There is no state-snapshot stream to read.
- `onTranscript` receives plain text via `session.on('history_updated', …)`; the SDK doesn't surface per-utterance `confidence` at the API layer we use today.
- No "announcement-started" timestamp is exposed by the Realtime SDK. TTS playback is the SDK's responsibility; we don't get a signal when an utterance begins or ends speaking.

By contrast, EL Conv AI runs a server-side proxy (`askOperatorViaSse`) that *is* an `/operator-converse` consumer — that's why it already speaks `fallbackText`. Cards work there because the EL agent calls our `ask_operator` tool, which proxies through the operator-converse brain, which can emit `chat:ask_choice`, which lands a state-snapshot frame on the same SSE the proxy is reading. The Realtime path skips the entire middle stack.

### Decision: scope v1 to EL Conv AI only

For v1:
- The conversation provider's STT-card routing (Phase 2) attaches to the `papercusp:operatorUserTurn` window event, which both engines publish. So Phase 2 wiring works regardless of which engine is active — *if* an `activeVoiceCardRef` is set.
- `activeVoiceCardRef` is only set when an openCard appears on the state-snapshot stream the provider already subscribes to (`useStateSnapshots`). That stream is fed by `/operator-converse` runs. In **Realtime sessions, no `/operator-converse` run happens for voice turns**, so no state-snapshot, so no `activeVoiceCardRef`, so no voice-side routing — the provider falls through to today's behavior. Zero regression for Realtime users.
- The Ready-card silence nudge (Phase 6) fires from the conversation provider's silence timer, which is decoupled from voice engine. If the user is in Realtime mode but `state.messages` carries an `awaiting_reply` from a prior text turn, the silence-after-question trigger still fires through `/operator-converse`, which still produces a card. That card is visible in the chat surface but **the user must click it** (Realtime engine doesn't watch state-snapshot, so it won't speak `fallbackText` and can't accept a spoken "ready"). This is acceptable v1 behavior — same UX as before this plan for Realtime users.

### Implications for the plan

- **Phase 4 is removed from this plan.** Realtime state-snapshot parity becomes a new deferred-followup entry in §H (see addition below) with a clear trigger.
- **`minConfidence` defaults remain useful for EL** — EL Conv AI does expose word-level scores when configured; the parser contract stays unchanged. Realtime sessions just don't fill `confidence`, so the gate is skipped (same as v1 plan for EL).
- **Phase 5 (announcer) is unaffected.** It listens on `'operator:cardOpen'` events the provider publishes from state-snapshot diffs. Realtime users in active EL chat threads still get spoken card prompts via the announcer.
- **Phase 6 spec stays as written**, just with one extra assertion: when the test mocks the active engine as `openai-realtime`, the same card is emitted but the spoken-answer path is NOT exercised (only click-answer works). This locks in the deliberate Realtime gap so a future change doesn't accidentally cover it without a real implementation.

### New deferred-followup entry (folded into §H)

- **Voice-aware cards in OpenAI Realtime sessions.** *Trigger:* Realtime becomes the default full-agent engine, OR ≥ 3 user reports that cards-can't-be-voice-answered in Realtime mode is a problem. *Approach:* either (a) thread state-snapshot events through the Realtime session via a server-side relay + new `card.respond` browser tool wired into the Realtime tool surface; or (b) downgrade Realtime to a "voice front-end + delegate" mode that always routes substantive turns through `/operator-converse`. Decide at trigger-time based on observed Realtime usage patterns.

### Phase numbering after this finding

- Phase 0 — revert (no-op, already at main baseline)
- Phase 0.5 — spike (this section) ✓
- Phase 1 — voice-answer parser library
- Phase 2 — provider STT-card routing (EL-driven state-snapshot only)
- Phase 3 — brain prompt + tool catalog + schema
- ~~Phase 4 — Realtime engine state-snapshot parity~~ → deferred to §H
- Phase 5 — announcer extension
- Phase 6 — Ready-card silence nudge integration
- Phase 7 — docs + deferred-followups

Total revised: ~2.5 dev days (down from ~3-3.5).
