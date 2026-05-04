# Agent Action Registry — Implementation Plan v3

**Status:** v3 — restructured around delegate-to-Claude pattern
**Scope:** unify the agent tool surfaces (Oracle, Operator-voice, Pi) plus
the user-facing surfaces (keyboard shortcuts, ⌘K command palette) under a
single typed registry of commands (side-effects) and queries (reads),
with a clear architectural split between **reflexive UI control** (fast,
local, low-stakes) and **deep reasoning** (slow, claude-backed, high-context).

**Non-goals:** generic DOM clicker, free-text input tools, drag/resize
gestures, multi-step workflows in the registry. Deep-reasoning lives in
the existing `claude -p` scan endpoint, not in the registry.

**v3 deltas (vs v2):**
- §0 (new) — architectural split between **voice (OpenAI Realtime / fast)**
  and **deep agent (Claude / scan endpoint)**, connected via a single
  `delegate_to_claude` tool. This is the central change.
- §2 — Operator's voice tool surface is small and reflexive only; deep
  work is delegated. The Action Registry holds reflexive tools + queries
  the voice layer needs to answer quickly.
- §4 (new) — explicit catalog of "what the voice LLM has access to" with
  reasoning for each entry.
- §5 — `delegate_to_claude` design (response shape, summarization
  contract, panel auto-open behavior).
- §6 — `claude-pi` `fullAgentEngine` mode rejected; `gpt-realtime` stays
  primary.
- §7 — Registry shrinks because Operator's catalog shrinks. Pi keeps full
  read surface; Oracle's surface stays as today.

---

## §0. The architecture in one diagram

```
                    ┌────────────────────────────────────────┐
                    │     User speaks / keys / clicks        │
                    └──────┬──────────────────────┬──────────┘
                           │                      │
            voice          │                      │  click / kbd / Pi cmd
            ▼                                     ▼
   ┌───────────────────┐                ┌────────────────────────┐
   │ OpenAI Realtime   │                │ Action Registry        │
   │  (gpt-realtime)   │                │  (in-process, typed)   │
   │                   │                │                        │
   │ • <500ms latency  │ ◀──tools──────▶│  Reflexive commands:   │
   │ • conversation    │                │   panel.*, navigate,   │
   │ • prosody         │                │   harness.start/stop,  │
   │ • barge-in        │                │   workspace.switch …   │
   └────────┬──────────┘                │                        │
            │                           │  Fast queries:         │
            │ delegate_to_claude        │   harness.status,      │
            │ (one tool among many)     │   chat.list, …         │
            ▼                           └────────────────────────┘
   ┌───────────────────┐
   │ POST /api/agent-  │
   │ mcp/operator-scan │
   │                   │
   │ spawn `claude -p` │
   │ + full agent-mcp  │
   │ tool surface      │
   │                   │
   │ • file reads      │
   │ • multi-step plan │
   │ • code analysis   │
   │ • the heavy stuff │
   └────────┬──────────┘
            │
            ▼ streams back as the tool's return value
   ┌───────────────────┐
   │ OpenAI Realtime   │ ◀── full Claude text
   │ summarizes for    │
   │ voice + announces │
   │ "details in panel"│
   └────────┬──────────┘
            │
            ▼
   ┌───────────────────┐
   │ Operator panel    │ ◀── full Claude text written here
   │ auto-opens (opt   │     for the eye path
   │ -outable)         │
   └───────────────────┘
```

Two layers, two latency classes, two LLMs. They cooperate via one tool.

The voice layer **is not Claude.** It's OpenAI Realtime. Claude is the deep
brain it can call. This is deliberate: voice latency budget is ~500ms;
Claude with full agent-mcp tools is multi-second. Don't put the slow brain
in the voice critical path.

---

## §1. Why a registry at all

Even with the delegation split, three smaller pieces still want unification:

1. **Reflexive UI commands** are duplicated 2-3 times today:
   - `operator.toggle` shortcut + `open_operator` Realtime tool + (no palette
     entry, no Oracle tool) — same panel, three implementations.
   - Same story for navigation, voice mode, workspace switching.
2. **Fast queries the voice layer needs to answer questions without delegating** —
   "what's the current harness?", "is operator running?", "what workspace am
   I on?" — are scattered across hand-rolled fetches. The voice layer needs
   them as tools so it can answer reflexively instead of always delegating.
3. **Pi's read tools and Oracle's read tools overlap** today (both have
   `status`/`list_features`-shaped queries), differently named, differently
   shaped. Worth consolidating so the voice layer can use the same queries.

The registry is **smaller in v3 than v2** — Claude's deep tool surface
(file reads, code analysis, audit, etc.) is **not** in the registry. That
lives in the existing `agent-mcp` MCP config used by `operator-scan`, and
we leave it there. The registry only covers the reflexive + fast-query
surface.

---

## §2. Registry shape

Same types as v2 — `CommandDef`, `QueryDef`, `CommandResult<T>`,
`CommandContext { agent, workspace, sessionId?, requestId }` — see the
v2 backup at `agent-action-registry-plan.v2.md` for the type listing.

Net is unchanged from v2 except:

- Tool catalog is materially smaller (see §4).
- A new `tier: 'reflexive' | 'fast-query' | 'delegation'` field on each
  def, used by the voice prompt builder so the model knows when to use a
  registry tool vs. delegate.

```ts
export interface CommandDef<…> {
  // …all v2 fields…
  tier: 'reflexive' | 'delegation';
}
export interface QueryDef<…> {
  // …all v2 fields…
  tier: 'fast-query';
}
```

---

## §3. The cross-process and multi-tab parts (unchanged from v2)

- `requiresBrowser` → `browser: 'required' | 'optional' | 'none'` tristate
- Workspace scoping via `ctx.workspace`, never threaded through args
- Multi-tab arbitration via existing `voice-leader.ts` election; commands
  flow to the leader tab for the workspace
- Session registry in the operator app's Node process; SSE channel for
  cross-process (Pi → browser) command delivery
- See v2 §3 for full discussion.

---

## §4. What the voice LLM has access to

This is the central new material. Catalog of what Operator's voice
layer (OpenAI Realtime) gets in its tool list, with reasoning.

### Design principles

1. **Voice gets fast paths for things the user asks about often.** "What's
   the current state?" should not delegate to Claude.
2. **Voice gets reflexive controls that don't need reasoning.** Open the
   panel, navigate, change voice mode, start/stop a harness — all
   one-shot tools.
3. **Voice does NOT get file reads, code analysis, multi-step planning,
   or anything requiring filesystem walking.** Those go through
   `delegate_to_claude`.
4. **When in doubt, delegate.** The model's prompt explicitly tells it:
   "If you need to read files, plan more than one step, or analyze code,
   call `delegate_to_claude` — don't try to fake it from your training
   data."

### Catalog — reflexive commands

| Command | What it does | Why voice gets it directly |
|---|---|---|
| `panel.open({panel})` | Opens an app panel (operator, oracle) | Reflexive UI; sub-50ms, conversational ("open the operator panel for me") |
| `panel.close({panel})` | Closes an app panel | Same reason; fixes the original Operator-can't-close-itself complaint |
| `panel.toggle({panel})` | Toggles visibility | User says "show me the operator" = same |
| `navigate({path})` | Browser router push | "Take me to settings" — common, reflexive |
| `voice.set-mode({mode})` | off / push-to-talk / always-on | User says "stop listening" — should not need to delegate |
| `voice.set-engine({stt? tts? wakeWord?})` | Change engine selection | Same |
| `workspace.switch({id})` | Switch workspace | Common command, reflexive |
| `harness.start({slug?})` | Start the harness | Long-running but kicked off in one call; result is async |
| `harness.stop({slug?})` | Stop the harness | Same |
| `harness.scan({slug?, request?})` | Trigger an Operator scan (the existing button-driven flow). Returns delegationId immediately, streams result via SSE | Deliberately exposed to voice — user might ask "scan the harness" and expect the same result the panel button gives |
| `harness.approve({slug, capability?})` | Approve a pending capability | Already in Operator's existing tool set; keep it reflexive |
| `chat.open-pane({chatId})` | Open an existing chat pane | Reflexive — comes after `chat.list` |
| `palette.toggle()` | Open ⌘K | Reflexive |

### Catalog — fast queries

These let voice answer questions reflexively, without delegating.

| Query | Returns | Reason voice has it |
|---|---|---|
| `harness.status({slug?})` | Current iteration, last decision, alive/paused | "Is the harness running?" — voice answers immediately |
| `harness.list-features({slug?, status?})` | Feature queue (passed/in-progress/failed/blocked counts + titles) | "What's in the queue?" |
| `harness.list({workspace?})` | Slugs + paths + alive | "What harnesses do I have?" |
| `harness.recent-suggestions({slug?, limit?})` | Last N Operator scan suggestions cached in PG | Voice can refer to what Operator said earlier without re-scanning |
| `harness.last-scan({slug?})` | The Operator's last scan summary (cached, not re-run) | "What did the Operator find?" — much cheaper than re-scanning |
| `chat.list({slug?, role?, limit?})` | Recent chats with id, title, role, last activity | "What chats do I have open?" |
| `workspace.list()` | All workspaces with current marker | "Which workspace am I on?" |
| `voice.prefs()` | Current voice prefs (mode, engines, wake word) | Voice can answer "what's my wake word?" |
| `panel.state({panel?})` | Open/closed for each panel | "Is the operator open?" |

### Catalog — delegation tool

Exactly one entry, special-cased:

| Tool | What it does |
|---|---|
| `delegate_to_claude({task, context?})` | POSTs `task` to `/api/agent-mcp/operator-scan?request=<task>`. Streams the result back. See §5 for full design. |

### What's deliberately NOT in voice's catalog

- **No `harness.read-spec` / `harness.read-agent` / file reads.** If the
  user asks "what does the spec say?", voice delegates to Claude. Claude
  has filesystem access via its MCP tools; voice does not.
- **No mutations to feature queue, proposals, decisions.** Approving a
  capability via voice is OK (`harness.approve` — single decision, same
  authority the user has via the panel). Bulk changes go through Claude.
- **No code analysis, no grep, no git inspection.** Voice doesn't have
  these tools. If the user asks anything code-shaped, delegate.
- **No `chat.dispatch` from voice.** Starting a new agent chat is a
  decision worth Claude's context. Voice delegates with the user's
  request as `task` and Claude decides whether to dispatch.

**Total surface for voice:** ~13 reflexive commands + ~9 fast queries +
1 delegation tool = **23 tools.** Same order of magnitude as Realtime
LLMs handle well; not so big the model gets lost in tool selection.

### What Pi has access to (kept from v2)

Pi's tool surface stays as today — read-only data tools via
`papercusp-mcp-server`:
- All the harness queries above (status, list_features, lineage, audit,
  proposals, decisions, issues)
- Plus filesystem + shell because it's a coding subprocess

The registry-shim version of Pi's tools delegates to the same query
handlers as voice's fast queries — single source of truth for "what's
the harness state."

### What Oracle has access to (kept from v2)

Oracle's tool surface stays as today — list/navigate/dispatch:
- All voice's fast queries (Oracle is also a chat-bot answering quickly)
- The reflexive commands (Oracle can navigate, open chats, etc.)
- Plus its existing `dispatchToAgent`
- **Does NOT get `delegate_to_claude`** — Oracle IS Claude. Oracle's
  tool surface is already the "deep" surface.

---

## §5. `delegate_to_claude` design

The single tool that bridges voice (fast/shallow) → Claude (slow/deep).

### Signature

```ts
{
  name: 'delegate_to_claude',
  description: 'Delegate complex reasoning, file analysis, multi-step planning, or anything requiring filesystem/code access to the harness Claude agent. Returns the agent\'s text response. Voice should speak a one-sentence gist; full text appears in the operator panel.',
  parameters: {
    task: 'string',           // user's request, paraphrased if helpful
    context?: 'string',       // anything specific the user mentioned
    showInPanel?: 'boolean',  // default true; set false for trivial answers
  },
  // executes:
  // POST /api/agent-mcp/operator-chat?request=<task>&context=<context>
  // (new sibling endpoint to operator-scan, conversational system prompt)
}
```

### Server side

New endpoint `/api/agent-mcp/operator-chat/route.ts` — sibling of
`operator-scan`, copies its `runClaudeChat` invocation pattern with two
differences:

1. **Conversational system prompt** instead of suggestion-extraction:
   "You are an agent serving an Operator voice assistant. The user said
   `<task>`. Use your MCP tools to answer their request fully. Be
   thorough — your response is shown in a panel; you don't need to
   shorten for voice. The voice layer will summarize."
2. **Streams events to the operator panel** in addition to returning
   the final text to the voice tool call. The panel shows live deltas
   while the voice layer waits.

Same agent-mcp tools attached. Same `system:operator` principal. Same
budget enforcement. Same conversation continuity via `--resume <session>`
keyed on `(workspace, conversation-id)`.

### Streaming + voice timing

Tool call latency is the hard part. Claude scans take 5-30s.

Solution: **two-phase tool result.**

1. Tool call fires. Operator-chat endpoint starts streaming.
2. Voice gets back almost immediately (~100ms after tool fire) a
   `{status: 'thinking', delegationId: 'd_abc'}` partial result, plus
   a `thinkingMessage` field the voice prompt is told to speak:
   *"Let me check on that…"*
3. Claude finishes streaming. The endpoint POSTs the full text to a
   `/api/agent-mcp/operator-delegation/:id/complete` endpoint, which
   the voice session is subscribed to via SSE. Voice gets the result
   pushed in as a synthetic tool result, generates the gist + announce.

This pattern is supported by OpenAI Realtime — multiple sequential
tool returns within one user-turn are normal. The "thinking" message
gives the user audible feedback during the wait, and barge-in still
works (user can interrupt by speaking).

### Response shape voice receives

```ts
{
  status: 'complete',
  fullText: '<claude\'s full response>',
  panelDelegationId: 'd_abc',          // panel reference
  toolCallsClaudeMade: ['mcp__agentmcp__harness:get', …],  // for context
  costUsd: 0.012,
  durationMs: 8420,
}
```

Voice prompt: *"You will receive a `complete` response with `fullText`.
Speak a one-sentence summary (≤30 words). Mention 'I've put the details
in the operator panel'. Do NOT read fullText verbatim. If fullText
contains a clear action recommendation, propose it to the user as a
follow-up."*

### Panel behavior on completion

- **Panel auto-opens** on delegation completion if it's currently closed.
- **Voice settings toggle** `voicePanelAutoOpen: boolean` (default true)
  controls this — same model as toast notifications.
- **Panel content** is the streamed-live Claude output, with the user's
  original `task` shown as the prompt.
- **Conversation history** in the panel is keyed by
  `(workspace, conversation-id)`. Multiple voice delegations in one
  session show as a single threaded conversation in the panel.
- **Closing the panel** does not cancel an in-flight delegation. User
  can re-open and see the result land. (Cancellation is a future
  feature; not in this PR.)

### Cost gating

Reuses `operator-scan`'s existing `checkBudget` / `recordSpend`
infrastructure. Voice can't burn money calling Claude every turn:
- Soft cap (e.g. $0.50/day) → voice gets back a `'rate-limited'`
  status with a message; speaks "I've hit my daily reasoning budget,
  please raise it in voice settings or try again tomorrow."
- Hard cap (e.g. $5/day) → voice can't delegate at all; speaks the same.

### Ambiguity / "should I delegate?"

The voice prompt has a checklist:

> Delegate when:
> - The user asks "why" or "how" about anything
> - The user mentions a specific file, feature, or piece of code
> - The user asks for a plan or recommendation
> - The user asks something multi-step
> - You don't know the answer from the fast queries you have
>
> Do NOT delegate when:
> - User asked you to open/close/navigate/toggle something
> - User asked a question your fast queries answer (status, lists, etc.)
> - User said "stop", "wait", "ok", or any backchannel response

Test this prompt in practice — ambiguity will surface real cases. Iterate.

---

## §6. Why we're not building Operator-as-Claude (rejected idea)

Earlier turns explored running the entire Operator voice path through
`claude -p` or a persistent claude subprocess. **Rejected** in favor of
the delegation pattern because:

1. **Latency** — voice budget is ~500ms; Claude with tools is multi-second.
   Unacceptable for the conversational layer.
2. **Wrong tool for the job** — Realtime is purpose-built for streaming
   voice with prosody; `claude -p` produces text that goes through Kokoro,
   stripping prosody. Realtime sounds better.
3. **Existing investment** — the Realtime path is wired, working,
   tool-capable, and the user has confirmed it works. Don't rip out a
   working system.
4. **Delegation is honest** — when the model says "let me check on that"
   and goes quiet for 8 seconds, the user knows something deep is
   happening. That's the right UX cue.

`fullAgentEngine` choices stay as today: `'off'`, `'gpt-realtime'`,
plus future `'gemini-live'` / `'elevenlabs-conversational'`. No
`'claude'` mode added.

---

## §7. Migration plan (revised cadence)

### PR 1 — Registry skeleton + reflexive command set

- `lib/commands/types.ts`, `registry.ts`, `audit.ts` (cmd actions table only)
- `lib/commands/defs/panel.ts` — panel.toggle/open/close
- `lib/commands/defs/nav.ts` — navigate
- `lib/commands/defs/voice.ts` — voice.set-mode, voice.set-engine
- `lib/commands/defs/workspace.ts` — workspace.switch, workspace.list
- `lib/commands/shims/operator-shim.ts` — generates Realtime tool defs
- New `app/api/agent-mcp/run-command/route.ts` returns 503 for cross-process
- Leader-bridge SSE skeleton from v2 §4 PR 1

Outcome: ~7 reflexive commands wired through registry. Operator's voice
catalog includes them. Operator can close itself. ~700 LoC.

### PR 2 — Fast queries + Pi/Oracle read-side unification

- `lib/commands/defs/harness.ts` — status, list-features, list,
  last-scan, recent-suggestions (queries)
- `lib/commands/defs/chat.ts` — chat.list, chat.open-pane
- `lib/commands/defs/panel-state.ts` — panel.state
- Pi shim emits these via papercusp-mcp-server (replaces hand-coded
  tools).
- Oracle shim emits these via oracle-mcp-server.
- Operator's voice catalog gains these queries.

Outcome: voice can answer "what's the harness doing", "what chats do I
have", etc., without delegating. ~500 LoC.

### PR 3 — `delegate_to_claude`

- `lib/commands/defs/delegation.ts` — defines the tool
- `app/api/agent-mcp/operator-chat/route.ts` — new sibling of operator-scan
- `app/api/agent-mcp/operator-delegation/:id/complete/route.ts` — push
  result back to voice session via SSE
- Voice prompt update: includes the delegation rules + speak-the-gist
  contract
- Panel auto-open hook: subscribe to delegation-complete events, open
  panel if currently closed and `voicePanelAutoOpen` pref is true
- Voice settings adds `voicePanelAutoOpen` toggle

Outcome: voice can delegate to Claude. Single user-facing tool, two-phase
return. ~600 LoC including the conversational prompt.

### PR 4 — Palette + shortcut shims

(Same as v2 PR 3.)

### PR 5 — Operator's existing tools migrate to registry

(Same as v2 PR 4.)

### PR 6 — Pi gains server-side actions

(Same as v2 PR 5.)

### PR 7 — (optional) Pi browser back-channel

(Same as v2 PR 6.)

Same six-PR cadence as v2 with the delegation tool slotting in as PR 3.
Voice gains useful capability after each PR.

---

## §8. Risks (deltas vs v2)

| New risk | Mitigation |
|---|---|
| Voice over-delegates (calls Claude for trivial things) | Prompt has explicit "do not delegate when…" checklist; iterate on real usage; metric on delegation rate |
| Voice under-delegates (tries to answer file/code questions from training) | Same; iterate on prompt; query metrics for "user asked X, voice answered without delegating" |
| Two-phase tool return surprises the model | Snapshot test on Realtime SDK behavior; OpenAI's docs say sequential tool returns within a turn are supported, but verify before shipping |
| Panel auto-open is annoying | `voicePanelAutoOpen: false` toggle in voice settings; default-on but easy to disable |
| Two LLMs per delegation (Claude generates + Realtime summarizes) doubles cost | Realtime summarization happens inside the existing voice turn — incremental tokens, not a separate session. Realistic incremental cost: ~$0.0005 per delegation. Negligible. |

All v2 risks (cross-process, multi-tab, prompt drift, import cycles)
carry forward unchanged.

---

## §9. Open questions for review

Most remaining questions are about the access list in §4:

1. **Which queries are fast-enough to be reflexive?** The catalog above
   is my best guess. `harness.status` is probably ~100ms; `chat.list`
   could be slow if the harness has thousands of chats. Should we add
   `limit` or `since` defaults to keep voice from fetching too much?
2. **Voice's `harness.scan` vs `delegate_to_claude`** — both call into
   Claude. Is the distinction "scan = canonical Operator scan, returns
   suggestions; delegate = freeform task" clear enough, or do they
   collapse into one tool?
3. **Panel auto-open setting location** — in the voice settings page
   under "Output behavior"? Or under "Operator panel"? I'd put it under
   voice since the trigger is voice-initiated.
4. **Conversation continuity for delegations** — should every voice
   session start a new Claude conversation, or should they all share
   one per-(workspace, day)? Sharing means Claude has context of prior
   delegations; new-each-time is more predictable.
5. **What does voice read out for `harness.last-scan`?** The cached
   summary could itself be 200 words. Speak gist + "details in panel"
   even for cached content? I think yes — same UX consistency.

---

## §10. Shipping order

If you can only commit to one PR right now: **PR 3 (`delegate_to_claude`)
without the registry foundation.** It's standalone — the existing inline
Realtime tool config can host it directly. ~400 LoC instead of ~600.

The registry PRs (1, 2) become independent decisions later. If you want
the voice layer to gain delegation TODAY but defer the registry refactor,
that's coherent.

If you can commit to two PRs: PR 1 + PR 3. That's the foundation +
delegation, ~1300 LoC, gives Operator full functional shape.

The rest (PR 2, 4-7) are pure consolidation of duplication; they can
land asynchronously over weeks.
