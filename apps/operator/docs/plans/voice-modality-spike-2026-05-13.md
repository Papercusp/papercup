---
title: T3.1 voice modality spike — memo
slug: voice-modality-spike-2026-05-13
status: shipped
created: 2026-05-13
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** **Status:** spike complete 2026-05-13. **Recommendation: substantially re-scope T3.1.** The plan's framework-level "narrate" event abstraction doesn't fit the EL Conv AI integration shape. The real win is plumbing `modality` as prompt-assembly metadata + standardizing the output-tag protocol — not building a new transport adapter.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# T3.1 voice modality spike — memo

**Status:** spike complete 2026-05-13. **Recommendation: substantially re-scope T3.1.** The plan's framework-level "narrate" event abstraction doesn't fit the EL Conv AI integration shape. The real win is plumbing `modality` as prompt-assembly metadata + standardizing the output-tag protocol — not building a new transport adapter.

Spike output per `phase-4-endpoint-system-2026-05-12.md` § T3.1 pre-work.

---

## Findings: what EL Conv AI actually is in this architecture

Read `apps/operator/lib/voice-engines/elevenlabs-conv.ts` (772 LoC) end-to-end. The integration is *not* what the plan assumed.

### EL Conv AI is a hosted black box

- Browser opens a WebRTC session to EL's hosted agent (Claude Haiku via BYO-LLM).
- The hosted agent has **`ask_operator(text, trigger?)` as a client-tool** — the EL SDK calls our handler in the browser when the LLM decides to "ask the operator."
- Our handler at `elevenlabs-conv.ts:481` (`askOperatorViaSse`) POSTs `/api/agent-mcp/operator-converse`, drains the SSE, **returns a single string** to EL.
- EL speaks that string verbatim via its TTS.

**EL's contract with us is one string in, one string out.** EL is not subscribing to a typed-event channel; it is not consuming structured narration events; it is calling a clientTool and reading the function's return value.

### Where modality actually gets enforced today

The voice/text branching lives in **the OPERATOR brain's prompt**, not in EL or in the framework:

1. `apps/operator/lib/agent-tools/operator/converse-prompt.ts:33` accepts a `modality: 'voice' | 'text'` input field.
2. `apps/operator/lib/operator-converse-prompt.ts:187` instructs the LLM to wrap voice-mode replies in `<say>…</say>` (along with `<set_mode>`, `<spawn>`, `<sleep>` for other concerns).
3. Server-side and client-side, `parseOperatorTurn` (`lib/operator-converse-tags.ts`) extracts the `<say>` body.
4. `askOperatorViaSse` returns the say-body to EL; EL's TTS speaks it.

**The framework has no role in producing voice output.** EL has no role in consuming structured events. The "narration" is a tag the LLM emits in plain text that the client greps out before handing to TTS.

---

## What the plan envisioned vs what's tractable

### Plan's original T3.1 design

From the v2 plan doc:
> Tools declare `modality: ['text', 'voice']`; framework auto-narrates progress/done for voice surfaces.
>
> - Need a voice transport adapter (parallel to HTTP/MCP/IPC)
> - `ctx.narrate` API + how it maps to EL Conv AI's tool-result-aware speaking
> - Tools that already have voice-aware prompts (operator:converse) need to migrate to declarative

### Why that doesn't fit

The auto-narrate model presumes the framework can drive TTS output. It can't:

- TTS lives inside EL's hosted infra, reachable only via the WebRTC session EL holds with the browser.
- The framework can't push narration events into that session — EL is the one calling tools, not the other way around.
- Even if the framework emitted a `narrate` event, EL would never see it; the only return channel to EL is the clientTool's return value.

A "voice transport adapter" parallel to HTTP/MCP/IPC would have nothing to transport to. EL doesn't subscribe.

### What is tractable: prompt-assembly metadata + tag protocol consolidation

The same goal — "tools declare modality, framework helps voice surfaces stay voice-shaped" — collapses to:

**(A) Tool-side declaration as prompt metadata.**

```ts
defineTool({
  name: 'operator:converse',
  modality: ['text', 'voice'],  // optional; default ['text']
  ...
});
```

The framework exposes `tool.modality` on the projected registry. Prompt-assembly (`prompt-assembly.ts`) consumes it when rendering the tools catalog for a given surface — voice-only tools get a `[voice-only]` hint in their description; text-only tools get filtered out of voice-surface catalogs.

**(B) Tag-protocol consolidation in `lib/operator-converse-tags.ts`.**

Today the LLM emits `<say>`, `<set_mode>`, `<sleep>`, `<spawn>` as plain XML-ish tags. The parsing is hand-rolled. Standardize:

- Keep `<say>` as the speak-to-TTS marker (load-bearing for EL clientTool return).
- Document the tag set in `apps/operator/docs/endpoint-system/voice-modality.mdx` so plugin authors writing voice-eligible tools know what to emit.
- Add a sanitizer at the EL boundary that warns when a voice turn arrives with no `<say>` tag (silent regression class — currently returns `assembled.trim()` which would include `<set_mode>` etc literally and speak them).

**(C) Catalog-level modality filtering.**

`ALL_AGENT_MCP_TOOLS` (the operator's voice-eligible catalog) currently lists everything. Adding `modality: ['text']` to tools that can't usefully be invoked from voice (e.g., `chat:ask_choice` — the user can't click buttons by voice) lets the framework auto-filter them out of voice-surface contexts.

This is what `operator-converse-prompt.ts:163` already does manually for `chat:ask_choice` in voice mode:
> NOTE: when modality is 'voice', do NOT emit chat:ask_choice — buttons are invisible to a voice user.

Hoisting that into the tool definition itself (`chat:ask_choice` declares `modality: ['text']`) means the prompt doesn't need to special-case it — the catalog renderer drops it automatically.

### What stays NOT in scope

- `ctx.narrate` API. No framework-side TTS sink to drive.
- Voice transport adapter. EL doesn't subscribe.
- Auto-narration of `progress`/`done` events. EL only consumes the `ask_operator` return value; it doesn't get a stream of mid-call events.

---

## Open questions where code-reading didn't fully answer

These would benefit from actually running EL Conv AI's hosted infra:

1. **Does EL truncate or buffer long string returns from `ask_operator`?** The current operator brain emits 220-char-max `<say>` bodies; if EL has a higher limit, we could embed multiple `<say>` blocks in one return for richer turns. The plan doc and the brain prompt both default to 1-2 sentences ≤220 chars, but we haven't verified that EL would handle longer.

2. **Does EL support tool-result streaming?** I.e., can `ask_operator` return a Promise that resolves progressively, with EL beginning TTS on the first chunk? The current SDK call `await runCommand(...)` suggests no — it awaits a single value. If EL added streaming returns later, the current setup would auto-benefit, but no design work needed.

3. **`<say>` tag inside a longer return.** If EL receives `Pre-thought... <say>spoken bit</say> ...post-thought`, does it speak the whole string verbatim (our `<say>` parser is server-side, but at the EL boundary we already strip), or does it strip XML-ish content? Worth confirming the **`askOperatorViaSse` return value is the ONLY string EL receives** — anything else would be a surprise.

The spike doesn't NEED to answer these to proceed; they're follow-up tasks that fit naturally into the proposed re-scope.

---

## Recommendation

**Re-scope T3.1 as a 2-3 day refactor instead of a 2-week framework migration:**

| Item | Estimated cost |
|---|---|
| Add `modality?: ('text' \| 'voice')[]` to `RoleToolDefinition` + `ProjectedTool` | 1 hour |
| Plumb through `defineTool` + `registerProjectedTool` | 1 hour |
| `prompt-assembly.ts` catalog renderer filters by modality | 2 hours |
| Migrate `chat:ask_choice` → `modality: ['text']` + remove the manual NOTE from operator-converse-prompt | 1 hour |
| Migrate `operator:converse` → `modality: ['text', 'voice']` (no behavior change; declarative metadata) | 30 min |
| Sanitizer in `askOperatorViaSse`: warn-log when voice turn has no `<say>` tag | 1 hour |
| Tests: catalog-filter assertions, sanitizer warn fires correctly | 2 hours |
| Docs: `endpoint-system/voice-modality.mdx` explains the tag protocol + the modality declaration | 2 hours |
| **Total** | **~10 hours = 1.5 days** |

This delivers the "tools declare modality + framework helps" win the plan called for, without the impossible "framework-side TTS" leg.

**Defer the original `ctx.narrate` design indefinitely.** It would only make sense if EL Conv AI grew a structured-event subscription API on its hosted side — out of our control.

---

## Coordination with Avi / parallel work

This memo is the spike output the v2 plan called for. If Avi's parallel work hasn't landed any voice-related commits since Tier 2 merged, the path is:

1. **Approve this re-scope** in a reply or a follow-up commit.
2. **Land T3.2 (plugin events from JSON manifests) in parallel** — same as the plan said; T3.2 has no overlap with this work.
3. **Refactor T3.1 per the re-scoped plan** — small enough to do in one PR.

If the re-scope is rejected, the alternative is to drop T3.1 entirely (no voice-side change at all) and let the modality plumbing stay in operator-converse-prompt as it is today.

---

## Files to touch when T3.1 implementation proceeds

```
packages/agent-mcp/src/types.ts                      modality?:('text'|'voice')[]
packages/agent-mcp/src/tool-projection.ts            ProjectedTool.modality
packages/agent-mcp/src/define-tool.ts                propagate field
apps/operator/lib/prompt-assembly.ts                 catalog filter
apps/operator/lib/agent-tools/chat/ask_choice.ts     modality: ['text']
apps/operator/lib/agent-tools/operator/converse.ts   modality: ['text', 'voice']
apps/operator/lib/voice-engines/elevenlabs-conv.ts   sanitizer warn-log
apps/operator/content/docs/endpoint-system/voice-modality.mdx   (new)
```

Plan-doc update path: add an "T3.1 re-scoped" subsection to `phase-4-endpoint-system-2026-05-12.md` pointing at this memo + replacing the spike's "if approved" body with the 10-hour task list above.
