# Silence-nudge reliability + EL idle teardown — 2026-05-14 (v3)

The 30 s silence-after-question nudge should reliably show a Ready card, and after a further 30 s of continued silence the active ElevenLabs Conv AI session should tear down so the user isn't burning credits while not talking. Wake-word detection (when configured) resumes the session and auto-resolves the open card.

Closes audit gap #7 from `voice-aware-cards-2026-05-14.md` and resolves V7-A. Adds a new "EL idle teardown on silence" capability that mirrors the mobile pattern at the *design* level (each platform implements independently).

---

## A. Goals & non-goals

### Goals
1. The Ready card **always appears** within milliseconds of the silence timer firing.
2. After a configurable grace period (default 30 s) of continued silence with the card unanswered, the active EL Conv AI session tears down.
3. If the user has wake-word configured, wake-word listening kicks in after teardown and auto-resumes on detection — the open Ready card resolves with `submit` so the brain continues with `user_says_ready` semantics.
4. If the user doesn't have wake-word configured, the card remains the resume affordance — they click Ready, or the card auto-cancels at the server-side 120 s timeout.

### Non-goals
- **Not removing the existing EL idle timer** (`fullAgentIdleTimeoutMin`). That continues to bound worst-case session length regardless of conversation activity. The silence-nudge teardown is an *additional* faster teardown specifically tied to mid-conversation silence.
- **Not sharing code with mobile.** Each platform implements independently; mobile is referenced only for design patterns (cited in comments where the pattern is borrowed). Voice prefs and silence policy stay platform-specific.
- **Not unifying wake-word pref schema between desktop and mobile.** Today desktop has `porcupineKeyword` / `openwakewordKeyword`; mobile has its own `wakeWord` field. Unification is a separate follow-up — captured in §H as a deferred entry.
- **Not redesigning the wake-word system.** The existing `startWakeWordGate(prefs)` in `voice-mode.ts` is the integration point.
- **Not changing the post-Ready brain behavior.** After the user resolves the card, the brain produces 2-3 follow-up suggestions via the existing path.
- **Not reviving brain-driven silence nudges.** The brain is removed from this path. Re-enablement is a separate decision if compliance improves later.

---

## B. Current state — what already exists

### Desktop infrastructure
- **Silence-after-question timer** lives in `OperatorConversationProvider.tsx`. Fires 30 s after `sub === 'awaiting_reply'`, today calling `runGeneration('silence_after_question')`. Smoke-tested 2026-05-14: brain emits text, not a `tool_call` event. Bug confirmed.
- **EL Conv AI session** lifecycle is in `apps/operator/lib/voice-engines/elevenlabs-conv.ts` + `voice-mode.ts`. Idle timer (`armIdleTimer`, default 2 min via `fullAgentIdleTimeoutMin`) fires when no user transcript has been heard. On fire: `stopRealtimeSession()` + emit toast + set status `'idle'`. If `wakeGated`, `startWakeWordGate(prefs)` arms.
- **Wake-word listener** (`startWakeWordGate` in `voice-mode.ts:670+`) supports Picovoice Porcupine and openWakeWord. Already routes back into `setVoiceMode('always-on')` on detection.
- **Voice-aware cards** (shipped 2026-05-14). Spoken "ready" against an open `voiceAnswerable:true` card resolves the card. Works as long as EL is alive.
- **Idle-reset rule** (`nudgeIdleTimer`): called only on user transcripts, never on agent text. EL credit-burn audit fix #2.

### Mobile patterns (iOS `VoiceManager.swift`, mirrored on Android) — design-level borrows only
- **Mutually exclusive state**: `voice.state == .idle` ↔ wake-word listening. Driven by SwiftUI `.onChange(of: voice.state)`. Desktop already exhibits this pattern via the existing wake-gated idle path; we just hook the silence-nudge teardown into the same machinery.
- **Two timers**: `idleTimerTask` (resets on USER transcript only) + `sessionMaxTimerTask` (set once, never resets). Desktop has both. The silence-nudge teardown is a *third* timer with shorter cadence, scoped to the "user went silent mid-conversation" event.
- **Failure-state UX**: when idle fires on mobile, the UI surfaces "Voice idle Xm — tap to resume." Desktop equivalent: the open Ready card.
- **Server-driven config**: mobile reads timer budgets from `/api/mobile/voice-session-init`. Desktop reads `voice-prefs.ts` directly. Same single-source-of-truth principle; different transport.

### Why mobile is relevant
The state-transition pattern (voice.state → wake-word arm/disarm) is the shape this work follows on desktop. The desktop's existing wake-gated idle path already does this for the generic 2-minute idle. We extend the same transition to fire earlier (30 s into a silence-after-question scenario, with a 30 s grace period after the nudge).

---

## C. Design

### C.1 PR-1 — Deterministic silence card

**Replace** the brain-driven `runGeneration('silence_after_question')` with a direct server-side card emission.

**New endpoint** `POST /api/operator/conversations/:id/silence-nudge`:
- Auth: session cookie (same as `/card-response`).
- Body: `{ workspaceId: string; voiceActive: boolean; wakeword?: string }`.
- Server-side behavior: opens a `chat:ask_choice` card directly via the card-correlator (not via the LLM) with:
  - `options: [{ id: 'ready', label: 'Ready' }]`
  - `voiceAnswerable: true`
  - `prompt` (chat-thread text): `"Ready when you are."`
  - `fallbackText` (announcer text):
    - If `voiceActive === true` AND `wakeword` is set: `"When you're ready, click Ready or say {wakeword}."`
    - If `voiceActive === true` AND no `wakeword`: `"When you're ready, click Ready or say ready."`
    - If `voiceActive === false`: `"Click Ready when you want to continue."`
  - `allowDecline: false` — there is no "skip" affordance.
- Returns `{ correlationId }`.
- Audit: same row as `/card-response`; the audit log row uses `source: 'silence_nudge_synthetic'` to distinguish from brain-emitted cards.

**Provider change**: replace the silence-timer's `runGeneration` call with a small helper `fireSilenceNudge()` that:
1. Reads `voiceActive` from `voiceActiveRef.current`.
2. Reads `wakeword` from a new pure helper `getConfiguredWakeWordForDisplay(prefs)` (see C.3).
3. POSTs to the new endpoint.

**Brain prompt cleanup**:
- Remove `'silence_after_question'` from `GenerationRequest['trigger']` union in `OperatorConversationProvider.tsx` and from the input type in `apps/operator/lib/agent-tools/operator/converse-prompt.ts`.
- Delete the `## Silence` section from `apps/operator/prompts/operator.converse.md`.
- Delete the matching section from `apps/operator/lib/operator-converse-prompt.ts`.
- Delete the `silence_after_question` entry from `triggerLines` in `converse-prompt.ts`.
- Delete `lib/agent-tools/operator/converse-prompt.silence.test.ts` (the contract it tested is gone).

### C.2 PR-2 — EL teardown after grace + wake-word resume

**New timer** in `OperatorConversationProvider.tsx`: after the silence-nudge card opens, arm a one-shot `nudgeGraceTimer` (configurable, default 30 s). When the timer fires:

1. **Voice off path** (no active EL session): timer is a no-op. Card stays open until clicked or 120 s server-side timeout.
2. **Voice on path** (EL Conv AI session active):
   - Dispatch a window event `papercusp:voiceSilenceTeardown`.
   - `voice-mode.ts` listens for the event and calls `stopRealtimeSession()` + transitions status to `'idle'`.
   - If `wakeGated` OR `wakeWordEngine !== 'off'`: existing `startWakeWordGate(prefs)` flow restarts (today's path, no new code needed).
   - Otherwise: stay idle. User must click Ready or re-engage manually.
3. The card stays open through all of this. `ctx.askUser` only resolves on `/card-response` POST, run abort, or 120 s server-side timeout — *not* on voice-mode state changes.

**Wake-word → auto-resume cascade**: when wake-word fires and EL restarts, the conversation provider observes `voiceActive: true` again. The voice-card router (from the prior plan) already has `activeVoiceCardRef` pointing at the still-open Ready card. The first matching transcript ("ready", "okay", etc.) resolves the card via `/card-response`. No new code — existing voice-aware-cards logic cascades correctly. **The plan adds an integration test for this cascade.**

**Cancellation**:
- User clicks Ready or speaks "ready" before the grace timer fires → `/card-response` resolves the card → state-snapshot drops it → effect cleanup cancels the grace timer.
- User types in the chat composer during the grace → `record_user_turn` fires → cancel the grace timer; EL stays up if it was up.
- Workspace switch / mode flip during the grace → cancel the grace timer; existing state handlers do the rest.
- voice toggle to off → grace timer cancelled (voice-off reset path already in the provider).

**New pref**: `voice.silenceNudgeGraceSecs` (default 30, range 5–120) in `voice-prefs.ts` + client cache + settings UI toggle. This pref is **desktop-only** — not shared with mobile (mobile's silence story is different; see §B). The unified-wake-word-pref work in §H is the only cross-platform pref unification I'm acknowledging.

**Handoff announcement** (per decided open question §F-4): when the grace timer fires AND voice was active AND wake-word is configured, the announcer plays one short cue: `"Going to wake-word listening. Say {wakeword} when you're ready."` Gated by a new pref `voice.speakSessionHandoff` (default true).

### C.3 Wake-word display helper

New pure helper in `apps/operator/lib/voice-cards/wakeword-display.ts`:

```ts
/**
 * Render the configured wake-word as a short, TTS-friendly phrase.
 *
 *   Porcupine "Hey Papercup"     → "hey papercup"
 *   openWakeWord "hey_jarvis"     → "hey jarvis"
 *   openWakeWord "ok_nabu"        → "ok nabu"
 *   wakeWordEngine === 'off'      → null
 *
 * Returns null when no wake-word engine is configured, so callers can
 * branch fallbackText shape accordingly.
 */
export function getConfiguredWakeWordForDisplay(prefs: VoicePrefs): string | null;
```

Pure function, ~20 lines, no Rust, no FFI. Mobile has its own equivalent for its own UI; that's fine — these are tiny functions that don't justify a shared runtime. (Cross-platform consistency is enforced by patterns + comments, not shared code.)

Unit tests cover every `wakeWordEngine` value × each documented keyword.

### C.4 Card UX by voice state — concrete strings

| State | `prompt` (chat thread bubble) | `fallbackText` (announcer reads) |
|---|---|---|
| Voice on, Porcupine = "Hey Papercup" | "Ready when you are." | "When you're ready, click Ready or say hey papercup." |
| Voice on, openWakeWord = "hey_jarvis" | "Ready when you are." | "When you're ready, click Ready or say hey jarvis." |
| Voice on, wake-word off (engine === 'off') | "Ready when you are." | "When you're ready, click Ready or say ready." |
| Voice off | "Ready when you are." | "Click Ready when you want to continue." |

### C.5 What happens when wake-word isn't configured

After the 30 s grace, if no wake-word engine is set:
- EL session still tears down (saves credits).
- User has two resume paths: (a) click Ready on the card, or (b) toggle voice on manually.
- Card stays open until click / run abort / 120 s server-side timeout.

This is acceptable: users without wake-word are explicitly opting out of voice-resume. The grace period + EL teardown still saves them money during the silence.

### C.6 Detailed flow — voice user with wake-word

```
T0       Brain ends turn with question → sub: 'awaiting_reply'
T0+30s   Silence timer fires → fireSilenceNudge() → POST /silence-nudge → card emitted
         Announcer speaks "When you're ready, click Ready or say hey papercup."
T0+30s+ε Provider arms nudgeGraceTimer (30 s, configurable)
T0+60s   nudgeGraceTimer fires →
         dispatch papercusp:voiceSilenceTeardown →
         voice-mode.ts → stopRealtimeSession() → status: 'idle'
         startWakeWordGate(prefs) → wake-word listener armed
         Announcer plays handoff cue (if pref enabled)
         Card still open in chat surface (state-snapshot unchanged)
T0+60s..T0+150s
         User says "hey papercup" → wake-word fires →
         setVoiceMode('always-on') → EL restarts → voice active
         Provider's voice-card router catches first matching transcript →
         POST /card-response submit → tool resolves → brain continues
         (or: user clicks Ready manually → /card-response submit)
         (or: 120 s after card emit → ctx.askUser cancels → idle)
```

### C.7 Detailed flow — text user (no voice)

```
T0       Brain ends turn with question → sub: 'awaiting_reply'
T0+30s   Silence timer fires → fireSilenceNudge() → POST /silence-nudge → card emitted
         (No announcer since voice is off)
T0+30s+ε Provider arms nudgeGraceTimer (30 s)
T0+60s   nudgeGraceTimer fires → no-op (no EL session to tear down)
T0+60s..T0+150s
         User clicks Ready → /card-response submit → done
         (or: 120 s timeout → card cancels → idle)
```

---

## D. Phased implementation

### Phase 1 — PR-1 (deterministic card, ~3-4 hours)
1. Add `lib/voice-cards/wakeword-display.ts` (§C.3) + unit tests.
2. Add `POST /api/operator/conversations/:id/silence-nudge` route. Route handler:
   - Validates session cookie + body.
   - Opens the card directly via the card-correlator (NOT through the LLM path).
   - Persists an assistant turn into the conversation history representing the synthetic nudge ("Ready when you are." + the card metadata) so the chat thread is coherent across reloads.
   - Returns `{ correlationId }`.
   - Route tests.
3. Modify provider's silence-timer useEffect: replace `runGeneration('silence_after_question')` with `fireSilenceNudge()`. Provider tests for the dispatch.
4. Remove `'silence_after_question'` from the trigger union; delete `triggerLines.silence_after_question`; delete the prompt sections in three files; delete the silence test file.
5. Verify no orphan references via repo-wide grep; existing operator-converse-prompt tests still pass.

Ship PR-1. Live smoke confirms the card always appears, no LLM call involved.

### Phase 2 — PR-2 (grace timer + EL teardown, ~3-4 hours)
1. Add `voice.silenceNudgeGraceSecs` (default 30) and `voice.speakSessionHandoff` (default true) to `voice-prefs.ts` + `voice-prefs-client.ts` + settings UI.
2. Provider gets `nudgeGraceTimerRef`. Armed on receiving the silence-nudge POST response (or on state-snapshot diff showing the new card). Cancelled by:
   - Card resolution (state-snapshot drops it)
   - User typing (existing `record_user_turn` path)
   - Workspace switch / mode flip / voice off (existing reset paths — hook the existing effects)
3. On timer fire: if `voiceActiveRef.current`, dispatch `papercusp:voiceSilenceTeardown`. `voice-mode.ts` adds a listener that calls `stopRealtimeSession()`; the existing wake-gated path takes it from there.
4. Add `speak()` of the handoff cue when pref is enabled (announcer infrastructure already there).
5. Verify auto-resume cascade with an integration test: mock wake-word fire → assert `/card-response submit` POST.
6. Tests: timer arm/cancel paths (4+ scenarios), pref read, voice-off no-op, wake-word configured vs not, handoff-pref off vs on.

Ship PR-2. Manual smoke against the dev server: trigger a silence, wait 60 s, verify EL torn down and wake-word listening; say wake word, verify resume.

### Phase 3 — Documentation cleanup (~30 min)
1. Update `voice-aware-cards-2026-05-14.md`: gap #7 resolved by Phase 1 + Phase 2 of this plan.
2. Update `deferred-followups-2026-05-14.md`: V7-A resolved, link to this plan. Add new V7-C (unified wake-word pref schema across desktop+mobile) per §H below.
3. Add a brief note to the operator-converse-prompt module docstring: silence is handled deterministically; brain authoring is no longer involved.

---

## E. Test plan

### Phase 1 tests
- `lib/voice-cards/wakeword-display.test.ts` — every `wakeWordEngine` value × each documented keyword + null cases. ~10 cases.
- Route test for `POST /silence-nudge`: 401 without session, 400 on bad body, 200 + correlationId on success, audit row written with `source: 'silence_nudge_synthetic'`, card visible in subsequent state-snapshot.
- Provider unit: silence timer no longer dispatches `runGeneration`; `fireSilenceNudge` POSTs with the correct body for voice on / voice off / various wake-word states.
- Existing `OPERATOR_CONVERSE_PROMPT` tests: assert silence section is gone.

### Phase 2 tests
- Pref roundtrip for `silenceNudgeGraceSecs` and `speakSessionHandoff`.
- Provider integration: card opens → 30 s timer → window event fires; card resolves before 30 s → timer cancelled; user types → timer cancelled.
- `voice-mode.ts` integration: `papercusp:voiceSilenceTeardown` triggers `stopRealtimeSession` only when EL session is active; `startWakeWordGate` called only when wake-word configured (re-uses existing path, no new wake-word code).
- Auto-resume cascade: with `activeVoiceCardRef` set, simulate wake-word fire → mock transcript `"ready"` → assert `/card-response` POST with `{action:'submit', payload:{picks:['ready']}}`.
- Manual e2e: silence → 60 s observation → confirm session torn down and wake-word listening. (Headless Playwright with audio is out of scope; this stays a manual smoke.)

---

## F. Locked decisions (was: open questions in v2)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Text-side grace timer behavior | **No-op.** Voice-off has no EL to tear down. Rely on the 120 s `ctx.askUser` server-side timeout for the text-only abandon case. | Avoids adding a card-cancel client-side path when the server already handles it. |
| 2 | Default `silenceNudgeGraceSecs` value | **30 s.** Total silence budget = 60 s (30 s silence trigger + 30 s grace) before EL teardown. | Approximate parity with mobile's 2-minute idle when you account for desktop's "asked a question" guard. Configurable 5–120. |
| 3 | PTT mode handling | **No special handling.** PTT mode doesn't keep EL idle alive; the teardown is naturally a no-op. | Avoids feature-flag branching for a path that's already harmless. |
| 4 | Handoff re-announcement | **Yes, gated by `voice.speakSessionHandoff` (default true).** When grace fires AND voice was active AND wake-word configured, announcer says "Going to wake-word listening. Say {wakeword} when you're ready." | Signals the channel change so the user knows the cycle continues; pref-gated for users who find it chatty. |
| 5 | Race with EL's own idle timer (`fullAgentIdleTimeoutMin`) | **Accept by design.** Grace fires first (30 s < 2 min default). If user has overridden idle to <30 s, EL's idle fires first and the grace timer is redundant — also fine. | No special coordination needed; both paths converge on `stopRealtimeSession` + wake-word arm. |

---

## G. Risks

- **Wake-word false positives auto-resolving cards.** Picovoice / openWakeWord can mis-fire (TV audio, overheard conversation); after EL restarts, the first matching transcript would route to the open card. Mitigation: handoff announcement (F-4) makes the cycle audible; user can still click Cancel on the card if they want; observability — add `silence_nudge_synthetic` audit source so we can spot accidental resolutions in the log.
- **Race: user clicks Ready exactly as grace timer fires.** `/card-response` and `papercusp:voiceSilenceTeardown` are in the same tick. Order: card-response wins (server resolves; state-snapshot drops the card; provider cleanup cancels the timer). If the timer wins by a tick, EL is torn down briefly, but the click still resolves the card via the existing route — the brain then restarts via `user_says_ready`. Minor cosmetic blip (TV blips off then on). Functionally correct.
- **No wake-word + voice on**: handled explicitly in §C.5. Card-click is the only resume; UX is degraded but no broken state.
- **Removing `silence_after_question` trigger union**: any cached compiled output or stray reference breaks. Mitigation: repo-wide grep at delete-time; existing tests catch surviving references.
- **Server-side 120 s `ctx.askUser` timeout** could fire while EL is down and wake-word hasn't yet triggered. Card resolves with `action:'cancel'`; provider goes back to idle; user has to manually engage. Acceptable for "user walked away" case.
- **Wake-word display string mismatch with actual wake-word.** If the configured Porcupine keyword changes but `getConfiguredWakeWordForDisplay` isn't updated, fallbackText becomes wrong. Mitigation: unit tests cover every known keyword constant; lint hook could enforce parity (out of scope for v1).

---

## H. Out of scope — deferred follow-ups

- **Unified wake-word pref schema across desktop and mobile.** Today desktop has `porcupineKeyword` + `openwakewordKeyword` in operator voice-prefs (PG-persisted); mobile has its own `wakeWord` field in iOS UserDefaults. Both could read from a single shared field if the mobile dev's "shared options" surface gains a wake-word entry. Will file as deferred-followup V7-C with revisit trigger "next time we touch wake-word config on either platform."
- **Reviving brain-driven silence nudges.** If LLM compliance improves on a future Sonnet/Opus release, we *could* swap the synthetic card for a brain-emitted card. Revisit trigger: brain reliably emits chat:ask_choice >90% of the time across 50 trials in any future smoke.
- **Replacing the 30 s initial silence delay with something dynamic** (e.g. based on prior question complexity). Out of scope; the 30 s is well-tuned today.
- **Adding a "Stop nudging me" option to the card.** Out of scope. The pref `silenceNudgeGraceSecs` set to a very high value (or a future `silenceNudgeEnabled: false` pref) is the right escape hatch.
- **Cross-tab voice race.** Existing voice-leader infrastructure handles single-tab election; the grace timer is per-tab and benign.
- **Headless Playwright e2e with real audio.** Voice-mode.spec.ts notes this is unreliable; manual smoke is the current bar.

---

## I. Phase ↔ PR sizing

| Phase | Files touched | Roughly | Reviewable in isolation? |
|---|---|---|---|
| 1 (PR-1) | 1 helper + 1 endpoint route + 1 endpoint test + 3 prompt files (deletions) + 1 provider edit + delete 1 silence test | ~3-4 hours | yes |
| 2 (PR-2) | 2 prefs files + settings UI + 1 provider effect + 1 voice-mode listener + 1 announcer call + 4-5 tests | ~3-4 hours | yes (depends on Phase 1) |
| 3 (docs) | 3 docs | ~30 min | yes |

Total: ~half a day to a day end-to-end. Deterministic, lower-cost, simpler than v1's three-phase brain-driven approach.

---

## J. Done state

After Phase 2 ships:
- Silence-after-question always shows a Ready card within milliseconds.
- Voice users in silence get EL torn down at 60 s total silence, wake-word listening enabled.
- Wake-word fire → EL resume → card auto-resolves via voice-aware-cards router (cascade verified by integration test).
- Text users see the card and click; voice-off users see the card and click (no special voice handling).
- Brain is out of the silence path entirely. Smaller prompt every operator turn.
- Audit gap #7 closed; V7-A resolved; V7-C added (unified wake-word pref).
