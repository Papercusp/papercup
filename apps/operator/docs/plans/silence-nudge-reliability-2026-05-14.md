# Silence-nudge reliability — 2026-05-14

The 30 s silence-after-question nudge should reliably show a Ready card. Today it doesn't — the brain (Sonnet via claude-code CLI) often emits the card schema as `<say>` text instead of invoking `chat:ask_choice`. Smoke-tested 2026-05-14, two consecutive runs both produced text-only output, no `tool_call` event.

This plan fixes that. Closes out audit gap #7 from `voice-aware-cards-2026-05-14.md` and resolves deferred-followup V7-A.

---

## A. Goal & non-goals

### Goal
Make the silence nudge **always** render a clickable Ready card (and announce it via voice when the panel is closed). Time from silence-fire → card-visible should be ≤ a few seconds in the happy path.

### Non-goals
- Not changing what happens *after* the user clicks/says Ready. The user_says_ready trigger downstream behavior is unchanged.
- Not fixing the broader "brain underuses cards in `user_says_ready` / `open_canvas`" problem. That's a wider prompt-tuning task — separate plan if you want it. This plan only addresses the silence trigger, which has a deterministic structure (silence fires, card must appear, no creative latitude needed).
- Not adding API-level `tool_choice` forcing. The operator brain runs via the `claude-code` CLI which doesn't expose `--tool-choice`; this path is closed without a significant architectural change.

---

## B. Current state (verified 2026-05-14)

- **30 s timer**: lives in `OperatorConversationProvider` at the `silence_after_question` useEffect. Fires `runGeneration('silence_after_question')` when `sub === 'awaiting_reply'`, voice not active mid-turn, freshness window valid.
- **Brain prompt** (3 sites — `operator.converse.md` §Silence, `lib/agent-tools/operator/converse-prompt.ts` triggerLines, `lib/operator-converse-prompt.ts` mirror): currently says "CALL the chat:ask_choice tool" with inline ✅/❌ examples.
- **Brain compliance**: smoke-tested 2026-05-14:
  - Run 1 (with fenced code block in prompt) → brain wrote `"I'll emit a single-option Ready card..."` + the schema in fenced markdown. No tool_call event.
  - Run 2 (after fence removed) → brain wrote the schema as inline text. Still no tool_call event.
- **Backstops today**: none. If the brain emits text, the user just sees that text in chat (no card, no Ready button).

### Why prompt-level forcing is the lever

`runAgentChat` (`libs/papercup-shared/src/agent/chat-stream.ts:177`) spawns the `claude` CLI as a subprocess via `claude -p --output-format stream-json …`. The flags it can pass: `--model`, `--mcp-config`, `--allowed-tools`, `--permission-mode`, `--system-prompt`, `--append-system-prompt`, `--json-schema`, `--session-id`. Confirmed via `claude --help`: **no `--tool-choice` or equivalent flag exists** in the claude-code CLI. The only way to influence tool selection from outside the model is the prompt itself.

That means our levers are:
1. **Sharpen the prompt** — rewrite the silence trigger so the brain has no plausible interpretation other than "call chat:ask_choice." Shortest, fastest fix.
2. **Skip the brain** — provider-side timer opens the card via `ctx.askUser` directly, no LLM round-trip. Maximum reliability but loses the brain's ability to phrase the question.

Plan: try (1) first. If smoke tests after (1) still show prose-only output, fall through to (2). Both are scoped in this plan; (2) ships only if (1) fails.

---

## C. Design

### C.1 Step 1 — Hard imperative prompt

Today's prompt is paragraph-shaped with example-based "do this, not that" guidance. The brain interprets the examples as **patterns to copy in its output**, not as a behavior contract. The fix is structural: replace the paragraph + examples with a short, imperative directive.

Three principles for the new prompt:
1. **One path, no alternatives.** Don't show ✅/❌. Don't enumerate what NOT to do. Each negative example is a sentence the LLM can mimic.
2. **Plain English imperative, not pseudo-code.** "Call chat:ask_choice with these args:" not `chat:ask_choice({...})`. Pseudo-code samples are the strongest "copy this verbatim" signal.
3. **State the side effect, not the schema.** "This will show a Ready button the user can click or speak." Not "voiceAnswerable: true makes the card answerable by voice."

Concrete proposed text for the trigger-line (`lib/agent-tools/operator/converse-prompt.ts`):

```
Trigger: silence_after_question — the user went silent 30s after your prior question. Your task this turn is to display a single Ready button by invoking the chat:ask_choice tool.

Invoke chat:ask_choice with:
- question: short text referencing what you were waiting on (1 sentence, under 20 words; do not include "Still with me?"-style filler)
- options: a list containing exactly one entry with id "ready" and label "Ready"
- voiceAnswerable: true
- fallbackText: the question followed by " Click Ready, or say ready aloud, when you want to continue."

After you invoke the tool, the runtime blocks your turn until the user clicks Ready (or says "ready" by voice). Once they do, you continue the same turn with 2-3 concrete suggestions, the same as user_says_ready.

Do not write the tool call as text. Do not respond with <say>. Invoke the tool.
```

Reasoning:
- Opens with what the trigger means, in plain language.
- Tells the brain its task (display the button) BEFORE the implementation detail (invoke the tool). The brain understands the *purpose*, not just the syntax.
- Bullet-style args, not JSON. Closes off "mimic the JSON" failure mode.
- Final negative directive at the end (the only ❌) is short and absolute.

Mirror this in the two other sites (`operator.converse.md` §Silence and `lib/operator-converse-prompt.ts`) so the brain sees consistent guidance regardless of which prompt-assembly path produced it.

### C.2 Step 2 — Smoke-test loop

After each prompt revision: hit `/api/agent-mcp/operator-converse` with `trigger: silence_after_question` and a conversation history that ends in an assistant `<say>` containing a question. Repeat 3× with different seeds (varied prior questions) to control for randomness. Pass criterion: at least 3/3 produce a `tool_call` event for `chat:ask_choice` with a Ready option. If any of the 3 emit prose-only → revise prompt → retry.

Cap at 3 prompt revisions. If 3 attempts still produce prose-only on any of 3 trials, escalate to C.3 (the deterministic fallback).

Tests to add as part of this step:
- `lib/agent-tools/operator/converse-prompt.silence.test.ts` extended: assert the new shape (no fenced code blocks, no ✅/❌ patterns, imperative voice, bullet args).
- Add a `scripts/smoke-silence-nudge.sh` (or test fixture) for the live-server smoke test so it's repeatable later.

### C.3 Step 3 — Deterministic fallback (only if C.1+C.2 fails)

If prompt-level forcing fails the smoke gate, this is the escape hatch.

**Approach.** Replace `runGeneration('silence_after_question')` in the conversation provider with a direct server-side card emission. No LLM round-trip.

**Server endpoint** `POST /api/operator/conversations/:id/silence-nudge`:
- Auth: session cookie (same as `/card-response`).
- Body: `{ workspaceId, question?: string }`. If `question` is omitted, the server uses `"Want to continue?"`.
- Behavior: opens a `chat:ask_choice` card via the card-correlator with a single `Ready` option, `voiceAnswerable: true`, fallbackText derived from question. Returns `{ correlationId }`.
- Audit: same row as a regular card response, marked `source: 'silence_nudge_synthetic'`.

**Client-side**: the provider's silence timer now calls a small extractor:

```ts
function extractPriorQuestion(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const sayMatch = m.content.match(/<say(?:\s[^>]*)?>([\s\S]*?)<\/say>/i);
    const text = (sayMatch ? sayMatch[1] : m.content).trim();
    // Last sentence ending in '?' wins.
    const sentences = text.match(/[^.!?]+\?/g);
    if (sentences && sentences.length > 0) {
      const last = sentences[sentences.length - 1].trim();
      if (last.length > 5 && last.length < 200) return last;
    }
    break; // only look at the most recent assistant turn
  }
  return null;
}
```

Then POST to the new endpoint with the extracted question (or null → server uses generic fallback).

**Prompt cleanup**: `silence_after_question` is removed from the brain's trigger union since it never reaches the brain. The Silence section in `operator.converse.md` becomes a single sentence: "The runtime handles silence-after-question via a deterministic Ready card. You do not author this nudge."

**Tests**:
- `lib/extractPriorQuestion.test.ts` — unit tests for the regex extractor (last `?`-sentence wins, handles `<say>` wrapping, returns null when no question).
- Route test for the new endpoint (auth, body validation, card lands on state-snapshot).
- Provider test: timer fires → extractor runs → endpoint posted with correct body.

### C.4 Why C.1 first instead of C.3 directly

Two reasons.

**(a) Less surface area to change.** C.1 is prompt edits in 3 files plus a smoke script. C.3 adds an endpoint, an extractor, a route test, and modifies provider control flow. If C.1 works, half a day saved.

**(b) The brain's question is better than a regex's question.** When the brain successfully emits the card, it can rephrase the prior question naturally ("Still want me to dispatch the architect for that?" — not literally what the brain said before, but a reformulation that fits the nudge). A regex extractor is locked to verbatim repeat of the last `?` sentence, which can read mechanical. Worth trying for the better UX first.

If C.1 fails, the UX cost of switching to C.3 is real but acceptable.

---

## D. Phased implementation

### Phase 1 — Sharpen prompts (3 files)
1. Rewrite `silence_after_question` triggerLine in `lib/agent-tools/operator/converse-prompt.ts` per §C.1.
2. Rewrite the `## Silence` section in `apps/operator/prompts/operator.converse.md`.
3. Rewrite the mirror in `apps/operator/lib/operator-converse-prompt.ts`.
4. Update the unit test in `lib/agent-tools/operator/converse-prompt.silence.test.ts` to assert the new shape (imperative voice, bullet args, no fenced code, no ✅/❌ pairs).
5. Add `scripts/smoke-silence-nudge.sh` — POSTs to the live dev server with a fixed conversation, asserts `event: tool_call` for `chat:ask_choice` appears in the stream.

Commit, push, verify the unit tests pass.

### Phase 2 — Live smoke test
1. Run `scripts/smoke-silence-nudge.sh` 3× against `localhost:3055`.
2. Check that each run yields a `tool_call` event with `name: "chat:ask_choice"` and `input.options[0].id === "ready"`.
3. If 3/3 pass → ship. Mark V7-A resolved in deferred-followups.
4. If any of 3 fail → revise prompt (one more attempt), re-run. After 2 revisions still failing → proceed to Phase 3.

### Phase 3 — Deterministic fallback (only if Phase 2 fails)
1. Add `lib/extract-prior-question.ts` + unit tests.
2. Add `POST /api/operator/conversations/:id/silence-nudge` route + route tests.
3. Modify provider: silence timer calls extractor + the endpoint instead of `runGeneration`.
4. Strip `silence_after_question` from the brain trigger union; shrink the prompt section to a single sentence.
5. Add provider integration test (timer fires → endpoint hit → card appears on state-snapshot).

### Phase 4 — Close out
1. Update `voice-aware-cards-2026-05-14.md` audit gap #7 status (resolved by which phase).
2. Update `deferred-followups-2026-05-14.md` V7-A → resolved.
3. If Phase 3 ran, add a new deferred entry for "restore brain-driven silence nudge if/when LLM compliance improves."

---

## E. Risks

- **Prompt churn elsewhere.** A revised silence prompt might unintentionally affect adjacent triggers if it bleeds into shared sections. Mitigation: keep edits scoped to the silence trigger line and the silence section in the .md.
- **Phase 2 false positives.** A single smoke-test pass doesn't guarantee 100% future compliance; the model is non-deterministic. Mitigation: smoke at 3 trials, not 1. Accept that 100% reliability requires Phase 3.
- **Phase 3 broader change risk.** Modifies provider control flow, adds an endpoint. Mitigation: trigger never reaches the brain after Phase 3 lands → easier to reason about, smaller surface area for *future* bugs.
- **Phase 3 question quality.** Verbatim-repeated questions can feel mechanical. Mitigation: §C.3's extractor returns null → generic fallback only when no `?` found; in practice most assistant turns asking a question DO end in `?`. Acceptable.

---

## F. Open questions for review

1. **Should the smoke test go in CI?** Live-server smoke tests are expensive (LLM calls) but catch regressions the unit tests can't. Recommendation: ship `scripts/smoke-silence-nudge.sh` as a manual-run script for now, not in CI. Revisit if we add fake-LLM coverage for this trigger.
2. **In Phase 3, who owns the question text?** Two options: (a) client extracts and posts the question, (b) server reads conversation history and extracts there. Recommendation: (a) — client already has the messages in state, no extra DB read. The server validates length/safety and falls back to generic if needed.
3. **Phase 3 retire the trigger entirely or keep it for future re-enablement?** Recommendation: retire — keep the trigger union clean. If we want to re-enable brain-driven nudges later, that's a future PR.

---

## G. Out of scope

- Broader chat:ask_choice underuse (in user_says_ready / open_canvas). Documented in V7-A's "Note on root cause"; separate plan if you want to tackle it.
- API-level `tool_choice` forcing. Requires architectural change away from claude-code CLI; not justified for this single trigger.
- Card decline path on the silence nudge. Today's `chat:ask_choice` schema has `allowDecline: true` by default; in Phase 1 the brain decides whether to set it, in Phase 3 we hard-code `allowDecline: false` (a Ready card shouldn't be skippable — the user dismisses it by pressing Ready or just doing nothing, which leaves the card open).
