---
title: Active-mode proactive responses — 2026-05-14 (v2)
slug: active-mode-proactive-ticks-2026-05-14
status: shipped
created: 2026-05-14
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** The operator should be active in active mode — pipe up when there's work to surface, auto-progress multi-step user requests, and never produce dead-end silence. Today it only speaks when the user does. This plan adds **brain-driven** proactivity: the brain itself signals at end-of-turn whether it has more to do, has options to surface, or needs to scan-and-suggest.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Active-mode proactive responses — 2026-05-14 (v2)

The operator should be active in active mode — pipe up when there's work to surface, auto-progress multi-step user requests, and never produce dead-end silence. Today it only speaks when the user does. This plan adds **brain-driven** proactivity: the brain itself signals at end-of-turn whether it has more to do, has options to surface, or needs to scan-and-suggest.

v2 supersedes v1 (timer-based polling). v1 was wrong — the brain knows when it has more to do; the runtime should not. New shape: three end-of-turn outcomes encoded as brain signals; the runtime just reads the signal and reacts.

Resolves V8 from `voice-aware-cards-2026-05-14.md`. Builds on the silence-nudge work (V7-A) that just shipped — the reactive side is now deterministic, freeing this work to focus purely on proactive behavior.

---

## A. Goals & non-goals

### Goals
1. **Three end-of-turn outcomes** the brain explicitly produces: continue, await-with-known-options, terminal. Runtime reads the signal and acts.
2. **Multi-step user-asked work auto-progresses** with visible narration ("Did X, now doing Y") via a new `<continue/>` tag.
3. **Active-mode terminal turns auto-scan**: after a brain turn that doesn't continue and doesn't ask, the runtime fires `'user_says_ready'` so the brain surfaces 2-3 things to do next.
4. **"Generate ideas" button** in the chat composer fires the same `user_says_ready` trigger manually, in any mode.
5. **Brain back-pressure honored**: `<sleep/>` tag (existing) prevents further proactive turns until the sleep elapses. Safety caps prevent runaway `<continue/>` chains.
6. **No timers, no polling.** All cadence comes from the brain's own decisions.

### Non-goals
- **Not a scanner→brain wire.** May-5 Option J stands. The brain reads its own MCP tools when it gets a turn; no separate scanner integration.
- **Not voice-side proactive behavior.** When EL Conv AI is active, the auto-scan path is suppressed — voice has its own conversational cadence.
- **Not removing `open_canvas`.** Still fires once on empty sidebar.
- **Not silently auto-firing.** Every `<continue/>` requires the brain to first narrate what it's about to do. The user is never surprised by a chained turn.
- **Not letting `<continue/>` execute side-effects from an idle context.** When auto-firing from a terminal turn (`'user_says_ready'`), the brain may not emit `<continue/>` — that path is one-shot by design.

---

## B. Current state

### Reactive triggers today
- `user_message` — user types or speaks
- `user_says_ready` — user says "ready"/"next"/"go" (text or voice)
- `quiet_wait_resume` — user re-engages after silence
- `open_canvas` — once on empty sidebar
- `user_welcomed` — once after login
- ~~`silence_after_question`~~ retired 2026-05-14 (deterministic `/silence-nudge`)

All user-initiated. The brain literally cannot proactively speak.

### What exists that we'll reuse
- `<say>`, `<set_mode>`, `<sleep>`, `<spawn>` tag parser in `operator-converse-tags.ts`. Adding `<continue/>` is one entry.
- `runGeneration(trigger)` already accepts an enum; adding values is straightforward.
- `chat:ask_choice` already supports `voiceAnswerable` and renders consistently in text/voice.
- `runAgentChat` already runs Claude in **agentic** mode within a single turn (multi-tool loop with up to N tool calls per turn). So multi-tool investigation works natively — `<continue/>` is reserved for user-visible cross-turn progress, not for "I need more tool calls."

---

## C. Design

### C.1 End-of-turn outcomes

The brain produces exactly one of four signals at end-of-turn:

| # | Signal | Runtime action |
|---|---|---|
| 1 | `<continue/>` tag (alongside a `<say>` narrating what's about to happen) | Auto-fire `runGeneration('continue')` after the current turn settles |
| 2 | `chat:ask_choice` tool call (the brain has options it knows about) | Standard bespoke-card flow — wait for the user pick |
| 3 | Terminal `<say>` — no `<continue/>`, no card, no `?` ending | **In active mode**: auto-fire `runGeneration('user_says_ready')` ONCE. **In passive mode**: stay quiet. |
| 4 | `<sleep duration_minutes="N"/>` tag | Honor — no auto-fire until the sleep elapses |

A turn ending in `?` (or via `chat:ask_choice`) is the existing `awaiting_reply` state that the silence-nudge ladder already handles. No new behavior there.

### C.2 The `<continue/>` tag

New tag. Parser: `<continue/>` with no children, no attributes. The brain emits it ALONGSIDE a `<say>` block in the same response — never standalone. The pattern is:

```
<say>Dispatched the architect for the auth rewrite. Now waiting on the result.</say>
<continue/>
```

When the runtime sees `<continue/>` in the parsed turn output, it:
1. Settles the current turn (displays the `<say>`, runs tag side effects).
2. Increments `continueChainCountRef`.
3. Records `continueChainStartedAtMs` if first in a chain.
4. Checks safety caps (§C.4). If exceeded, force-wait (no auto-fire); the brain is allowed to re-emit `<continue/>` on the next user turn.
5. Otherwise, immediately fires `runGeneration('continue')`.

The brain receives the `continue` trigger and either continues the work or finishes (any of states 1-4 above).

### C.3 Continue narration is mandatory

Brain prompt rule:

> **`<continue/>` MUST be paired with a `<say>` that narrates what you're about to do next.** "Now starting X." "Architect dispatched, waiting on the result." The user must always see what's happening — never a silent chained turn.

This is enforced by prompt only — the runtime doesn't reject continue without say (would be a brain-instruction violation visible in chat). The brain has been disciplined about narration in similar contexts.

### C.4 Safety caps

Configurable in `/settings/voice` → "Operator behavior" section:

| Pref | Default | Range | What |
|---|---|---|---|
| `maxConsecutiveContinues` | 5 | 1-20 | Max `<continue/>` chain depth before force-wait |
| `maxContinueChainSecs` | 300 | 30-1800 | Max wall-clock duration of a `<continue/>` chain |
| `proactiveTicksEnabled` | true | bool | Master toggle for active-mode auto-fire on terminal turns. When false, terminal turns just terminate (passive behavior in active mode too). |

When either cap is hit, the runtime force-stops the chain. The next turn requires user input. The brain sees `'user_message'` or similar (whatever the user sends).

### C.5 The `user_says_ready` auto-fire (active mode)

When a brain turn ends with state #3 (terminal, no continue, no card, no `?`) AND `mode === 'active'` AND `voiceActive === false` AND `proactiveTicksEnabled === true`:

The runtime fires `runGeneration('user_says_ready')` ONCE. The brain's prompt for this trigger says:

> Trigger: user_says_ready — the user is open to suggestions (either they said "ready"/"next"/"go", they clicked "Generate ideas", OR you just finished a task and active mode is checking what's actionable next).
>
> Use MCP tools to read what's relevant. **All investigation happens in this ONE turn — do not emit `<continue/>` from this trigger.** Produce one of:
> - `chat:ask_choice` with 2-3 specific options the user could pick (e.g. "Sheets has 3 escalations — open the latest?", "Resume marketplace pipeline", "Look at wiki cleanup")
> - `<sleep duration_minutes="N"/>` if there's genuinely nothing worth surfacing right now
>
> **Do not produce a terminal `<say>` without a card.** A terminal `<say>` from this trigger would loop right back to another auto-fire — instead, sleep or emit a card.

The "no `<continue/>` from idle context" rule prevents the brain from auto-executing work — which we explicitly want to require user approval.

The "no terminal `<say>` without a card" rule prevents an infinite loop: if the brain says "let me think" with no card and no sleep, the runtime would auto-fire again, and again. Forcing card-or-sleep terminates the loop.

### C.6 Always-produce-card when options are known (state #2)

Brain prompt rule:

> **When you have 2-3 distinct options the user could pick between AND those options come from prior conversation context (not requiring a fresh scan), you MUST emit `chat:ask_choice` rather than asking in plain text.**
>
> ✅ chat:ask_choice({ question: "Pick up where you left off?", options: [{id:"rust",label:"Check rust port"},{id:"market",label:"Resume marketplace"}] })
>
> ❌ `<say>"Do you want to look at the rust port or the marketplace?"</say>`

This was implicit in the prior plan; making it explicit removes a common drift mode.

### C.7 Voice-mode interaction

The auto-fire on terminal turns is gated on `voiceActive === false`. When voice is on, EL Conv AI manages the conversational cadence; layering our auto-fire on top would confuse turn-taking.

`<continue/>` is allowed in voice mode (multi-step work narration is just as valuable spoken). The brain's chained turns flow through the same EL session.

The "Generate ideas" button is available in both modes — it's an explicit user click.

### C.8 EL-teardown cool-off (continuation from V7-A)

When silence-nudge fires the EL teardown event (`papercusp:voiceSilenceTeardown`), voiceActive flips to false. Without a cool-off, the next terminal turn in active mode would immediately auto-fire `user_says_ready`. That's bad UX — we *just* told the user "say wake word when ready."

Solution: track `lastELTeardownMs`. If `nowMs - lastELTeardownMs < 5 min`, suppress the auto-fire. Brain still sees the terminal turn but no auto-scan kicks in. Either the user wakes the system back up via wake-word (resumes via the open Ready card) or the cool-off elapses naturally.

### C.9 The "Generate ideas" button

Add a small button in the chat composer area, to the left of Send. Icon: lightbulb or sparkles. On click: dispatches `runGeneration('user_says_ready')` with no preceding turn. Same prompt-trigger path. Works in active and passive mode (it's an explicit user request).

Why this matters:
- Manual escape hatch when brain is in `<sleep>` and user wants ideas now.
- Discoverability: passive-mode users may not know they can type "ready" — the button surfaces the affordance.
- A11y: keyboard shortcut maps to it (e.g. `Cmd/Ctrl + Shift + I`).

### C.10 Trigger naming — merged

Per our discussion: `user_says_ready` is the single trigger for all three entry points (user types "ready", user clicks Generate Ideas, terminal-turn auto-fire). One prompt section, simpler code. Telemetry can distinguish via a separate `dispatch_source` field if we want it later.

### C.11 Passive mode semantics

Passive mode is fully reactive. Terminal turns end naturally — no auto-fire. The "Generate ideas" button still works (explicit user click). No silence-nudge ladder.

The existing silence-nudge code already gates on `mode === 'active'`. Confirming this stays as-is.

---

## D. Phased implementation

### Phase 1 — Tag parser + types (~30 min)
1. Add `<continue/>` to the parser in `apps/operator/lib/operator-converse-tags.ts`. Return shape: `parsed.continue: boolean`.
2. Unit tests for the parser (5 cases — present, absent, with say, with sleep, malformed).

### Phase 2 — Prefs + UI (~30 min)
1. Add `proactiveTicksEnabled`, `maxConsecutiveContinues`, `maxContinueChainSecs` to `voice-prefs.ts` + `voice-prefs-client.ts`.
2. Rename `/settings/voice` "Feature toggles" subsection where these live to keep clear UI grouping; new "Operator behavior" header for the three new prefs.
3. Tests: pref roundtrip.

### Phase 3 — Brain prompt updates (~30 min)
Three sites — `apps/operator/prompts/operator.converse.md`, `apps/operator/lib/operator-converse-prompt.ts`, `apps/operator/lib/agent-tools/operator/converse-prompt.ts`:

1. Add a "Multi-step work — using `<continue/>`" section (mandatory narration + when to use).
2. Update the `user_says_ready` trigger-line to:
   - State that the trigger fires from (i) user input, (ii) Generate Ideas button, (iii) terminal-turn auto-fire in active mode.
   - Enforce: one turn, no `<continue/>`, terminal output must be `chat:ask_choice` or `<sleep>`.
3. Add a "Known options must use cards" rule to the "Picking cards vs text" section.

Unit tests: assert each rule appears in the assembled prompt.

### Phase 4 — Runtime (~1-2 hours)
1. Provider's `runGeneration` settle-phase reads `parsed.continue`. If set AND caps not exceeded, auto-fire `runGeneration('continue')`.
2. Track `continueChainCountRef`, `continueChainStartedAtMs` — reset on any user turn.
3. Track `lastELTeardownMs` — set when `papercusp:voiceSilenceTeardown` event fires.
4. Terminal-turn auto-fire path: when the parsed turn has no continue, no card, no `?`, mode is active, voice is off, ticks enabled, cool-off elapsed → dispatch `runGeneration('user_says_ready')`. Mark this dispatch source so we don't re-loop if THAT turn also terminates.
5. Per-trigger guard: when `runGeneration('user_says_ready')` is itself a terminal turn auto-fire, suppress a subsequent terminal-auto-fire (would be a loop). Detection: tag the in-flight request with `isAutoFire` and don't auto-fire again from its result.

### Phase 5 — "Generate ideas" button (~30 min)
1. Add button to the chat composer (existing component — `apps/operator/app/_components/OperatorChat.tsx`).
2. Onclick: provider exposes `generateIdeas()` callback that calls `runGeneration('user_says_ready')` directly.
3. Keyboard shortcut binding via existing chrome hotkey system.
4. Visual: lightbulb icon, accessible label "Generate ideas (Cmd+Shift+I)".

### Phase 6 — Tests + manual smoke (~1 hour)
- Parser tests (Phase 1, already)
- Pref tests (Phase 2, already)
- Prompt assertions (Phase 3, already)
- Provider unit tests for: `<continue/>` auto-fire, cap enforcement, terminal-turn auto-fire in active mode, suppression in passive, suppression mid-voice, EL-teardown cool-off, anti-loop guard.
- Manual smoke against dev server:
  - "Set up a new harness" → observe `<continue/>` chain with visible narration, terminating in a card or sleep.
  - Send a regular question → answer terminates → observe auto-fire in active mode produces a follow-up card.
  - Toggle mode to passive → terminal turn stays terminal.
  - Click Generate Ideas → observe card.

---

## E. Locked decisions

| Decision | Lock |
|---|---|
| Three end-of-turn outcomes (continue/card/terminal) | yes |
| `<continue/>` narration mandatory | yes — prompt rule |
| Known-options card mandatory | yes — prompt rule |
| Idle-scan one turn, no chaining | yes — prompt rule |
| `maxConsecutiveContinues` default 5 | yes |
| `maxContinueChainSecs` default 300 | yes |
| `proactiveTicksEnabled` default true | yes |
| Terminal auto-fire only in active mode, voice off | yes |
| EL teardown cool-off 5 min | yes |
| Single trigger `user_says_ready` for all three entry points | yes |
| Passive mode: no auto-fire, no silence-nudge | yes (silence-nudge gating already in place) |
| Settings live in `/settings/voice` under "Operator behavior" | yes |
| "Generate ideas" button works in active + passive | yes |

---

## F. Risks

- **Runaway `<continue/>` chains.** Mitigated by caps + brain prompt discipline + cost gates already in the converse path. Even at the max (5 continues × ~$0.005 each ≈ $0.025 per chain) the worst case is bounded.
- **Loop: terminal turn → auto-fire `user_says_ready` → terminal `<say>` (brain forgot card-or-sleep rule) → auto-fire again.** Mitigated by §D.4's `isAutoFire` flag: a turn dispatched by terminal-turn-auto-fire cannot itself trigger another auto-fire. The brain prompt also explicitly forbids terminal `<say>` from `user_says_ready`.
- **User finds proactive turns annoying.** The pref toggle off is the kill switch. Default-on is the right user-expectation match for "active mode."
- **Brain mis-classifies and silently chains via `<continue/>` for investigative work it should have done in one turn.** Caps cap it; cost is small. Worth a manual smoke test to verify the brain follows the "investigation in one turn" rule for idle_scan.
- **Voice + multi-step work**: brain emits `<continue/>` mid-voice-call. EL session is active; the chained turn still proceeds. User hears narration before each chained step. Fine — that's the point. Just confirming voice doesn't accidentally suppress `<continue/>` (it doesn't; only the terminal-auto-fire is voice-gated).

---

## G. Out of scope — deferred follow-ups

- **V8-A: SSE-driven immediate trigger.** When the trigger-state fingerprint changes (e.g. a smoke test just failed), fire `user_says_ready` immediately rather than waiting for the next terminal turn. Adds value if users complain that proactive responses are too lazy. Trigger to revisit: ≥ 3 user complaints about "operator didn't tell me X happened until I asked."
- **V8-B: User-level back-pressure learning.** Track which proactive turns the user engaged with vs ignored; the brain uses this to calibrate over time. Requires a feedback signal beyond `<sleep>`. Trigger: user wants smarter cadence.
- **V8-C: Voice-mode proactive ticks.** Today voice mode bypasses the auto-fire. If EL ever has hooks for "I just finished, what should I do?" we can wire it. Trigger: EL SDK change.
- **V8-D: Time-of-day cadence.** Quieter at night. Trigger: user feedback.

---

## H. Phase ↔ PR sizing

| Phase | Files | Est. |
|---|---|---|
| 1 — tag parser | 1 + 1 test | ~30 min |
| 2 — prefs + UI | 3 | ~30 min |
| 3 — brain prompts | 3 prompt files + 1 test | ~30 min |
| 4 — runtime | 1 (provider) | ~1-2 hours |
| 5 — Generate ideas button | 2 (OperatorChat + provider hook) | ~30 min |
| 6 — tests + smoke | ~5 test files | ~1 hour |

Total: ~3-4 hours end-to-end. Conservative; the actual work is mostly prompt + a small parser addition + 1 provider effect.

---

## I. Done state

After all phases ship:

**Scenario 1 — Multi-step user work:**
- User: "Set up a new harness from scratch."
- Brain: `<say>Creating workspace.</say><continue/>` → `<say>Workspace created. Writing config now.</say><continue/>` → `<say>Config written. Running smoke test.</say><continue/>` → `<say>Smoke passed. Done.</say>` → terminal.
- In active mode: auto-fire `user_says_ready` → `chat:ask_choice("Want to commit and push, or look at something else?")`.

**Scenario 2 — Known options:**
- User: "Pick up where I left off."
- Brain reads context, knows recent threads were rust port and marketplace.
- Brain: `chat:ask_choice({question:"Pick up where you left off?", options:[{id:"rust",label:"Check rust port"},{id:"market",label:"Resume marketplace"}]})`.

**Scenario 3 — Idle scan after terminal:**
- User: "What time is it in Tokyo?"
- Brain: `<say>It's 3:42 PM in Tokyo.</say>` → terminal.
- Active mode auto-fire → `runGeneration('user_says_ready')` → brain scans workspaces → `chat:ask_choice("Sheets has 3 escalations — open the latest?", options:[...])`.

**Scenario 4 — Generate Ideas button:**
- User in passive mode clicks Generate Ideas.
- `runGeneration('user_says_ready')` fires → card surfaces.

**Scenario 5 — Brain has nothing:**
- Terminal turn → auto-fire `user_says_ready` → brain scans, nothing actionable → `<sleep duration_minutes="15"/>`. Operator stays quiet for 15 min.

Closes V8 in deferred-followups.
