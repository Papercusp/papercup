---
title: Steer + chat with agents
description: Two ways to interact with running agents — async notes that the worker reads on its next dispatch, and real-time multi-turn chats with any role.
---

Papercup is autonomous by default — the orchestrator dispatches roles, roles read state and write code, and operators usually just watch. But sometimes you need to interject: a worker is heading the wrong direction, the architect's reasoning is unclear, you want to see what the validator sees. Two affordances cover this without breaking the autonomous loop.

| Use | When | Cost |
|---|---|---|
| **Steer** (operator note) | Async hint the worker reads on its next dispatch | Free — no extra LLM call |
| **Chat** (real-time conversation) | Multi-turn dialogue with any role's full context | One `claude -p` per message |

Both are surfaced on the harness dashboard at `/harness/<slug>` (default `localhost:3055`).

## Steer — async note to the worker

The cheap path. Drop a guidance note onto a feature; the worker reads it on its next autonomous dispatch. No real-time interaction. Best for *"you're going about this wrong, try X"* style nudges that don't need a back-and-forth.

### How to send a note

1. **Click any feature row** in the feature queue. The right-side **Feature peek panel** opens with claims, status, attempts.
2. In the peek panel's action row, click **`note`**.
3. The form expands inline below the existing-notes section:
   - List of any prior notes (timestamp + author header per block)
   - Textarea for the new note
   - **send note** button (or ⌘/Ctrl+Enter)
4. Type, send. You'll see "sent ✓" briefly. The note is appended to disk.
5. Click **hide note** when done.

### What happens next

The next time the orchestrator dispatches `NEXT_WORKER <featureId>` for that feature, the worker prompt's `Required Read #6` section auto-injects the contents of the notes file. The worker treats it as guidance from the operator alongside the spec, contract, and AGENTS.md.

Dispatch may be seconds away (if the loop is hot) or minutes (if other features are queued). The orchestrator decides when based on the queue.

### Where it lives on disk

```
<harness-dir>/.harness/notes/F-XXX.md
```

Plain markdown, append-only by the form, but human-editable too. If the file is absent, no notes are injected. To retract a piece of guidance, edit or delete the file directly — the form will not "undo" a sent note.

### Scope

Notes are **feature-scoped + worker-scoped**. Other roles (validator, architect, debugger) don't read them. If you want to nudge another role, use chat below.

### Common gotcha

Notes are **additive forever**. Three contradictory notes over a week means the worker reads all three. The system doesn't auto-expire or supersede them — the file is the source of truth, and the worker decides how to weigh conflicting blocks.

## Chat — real-time conversation with any agent

The expensive path. Opens a fresh `claude -p` invocation with the agent's full prompt + state, streams responses, lets you have a multi-turn dialogue. Best for *"let me understand what you're doing"* or *"let's work through this problem together."*

### Two ways to start a chat

#### Path A — chat with a worker on a specific feature

1. Click any feature row → peek panel opens.
2. Click **`chat`** in the action row.
3. The dashboard auto-switches to the **consoles** tab. A new dock panel appears, labeled `worker · F-XXX`.
4. Type a message in the textbox → **send** (or ⌘/Ctrl+Enter). The response streams in token-by-token.

This is the most common path: a feature is acting up, you want to interrogate the worker about it.

#### Path B — ad-hoc chat with any role

1. Click the **consoles** tab in the dashboard tab strip.
2. In the dock header, click **`+ chat`** (next to **`+ terminal`**).
3. A popover appears with:
   - **Role** dropdown — orchestrator, scoper, worker, validator, plan-gate, architect, debugger, crosscheck, ui-qa, documenter, summarizer, curator, project_manager
   - **Feature ID** field (optional — only relevant for worker/validator/architect/debugger)
   - **Title** field (optional — defaults to `<role> · <featureId>` or just `<role>`)
4. Click **create**. New dock panel opens.

Use Path B when you want to talk to a role that doesn't naturally appear in the peek panel — architect for spec questions, scoper for scope questions, project_manager for spec-curation questions.

### What the chat panel shows

| Element | What it does |
|---|---|
| Header — role + feature + cost meter (`$0.0000`) | Running cost. Updates after each turn. |
| Yellow concurrent-run banner | Appears if the autonomous loop is currently mid-tick on the same feature. The chat agent is told to give advice but NOT commit to the worktree. |
| Transcript area | Full history. Persisted in the harness DB, survives reloads. |
| Textarea + send button | ⌘/Ctrl+Enter to send. |
| Archive button (header right) | Closes the panel and archives the chat. The DB row stays for audit; the transcript is preserved. |

### What happens server-side per message

1. POST to `/api/harness/<slug>/agent-chats/<chatId>/messages` with the user's message.
2. Server takes a per-chat in-memory lock — no two concurrent messages on the same chat.
3. Loads the current transcript from `harness_<slug>.agent_chats`.
4. Calls `assembleRolePrompt()` — the same prompt assembly the autonomous loop uses, plus:
   - `MODE=chat` preamble telling the agent it's in conversational mode
   - The transcript as conversation history
5. Spawns `claude -p` with `--output-format stream-json`. Pipes deltas back to the browser via SSE.
6. On stream end: persists the assistant turn to the transcript, updates token + cost counters.
7. Enforces `maxChatCostUsd` (per-chat) and `maxAggregateChatCostUsd` (across all non-archived chats) caps if set in `.harness/config.json`. Default: uncapped.

### Side-channel rule — chats don't mutate the worktree

By design, the chat agent **cannot commit code to the worktree**. Its prompt explicitly says:

> In chat mode you give advice; the autonomous loop is authoritative for code changes.

If the chat's reasoning is good and you want it to land:

- **For worker-shaped guidance** → ask the chat to summarize the change, then drop a note via the steer flow above. The next autonomous worker tick reads it.
- **For spec-shaped guidance** → ask the chat (architect or project_manager) to write a proposal block. The architect role's autonomous path will pick it up via the existing proposal lifecycle.
- **For ad-hoc edits** → paste the chat's suggestion into a worker prompt yourself, or apply it manually.

This separation preserves the autonomous-by-default property: chats inform the loop, they don't hijack it. Two voices on the same worktree at once is exactly the situation that creates conflicting commits.

### Multi-pane chats

The consoles tab is built on Dockview — terminals and chat panels coexist as panel types in the same dock.

- **Drag a chat tab to a dock edge** → splits into two side-by-side panes. Useful for "compare what worker on F-001 says vs validator on F-001."
- **Drag tabs between groups** to rearrange.
- **Mix terminals and chats** — a bash terminal next to a chat next to another chat is fine.
- **Layout persists per-harness** in `localStorage` (`pi-dock-layout-<slug>`). A reload restores your arrangement; pty contents start fresh, chat transcripts are restored from the DB.

### When to use which

| Situation | Use |
|---|---|
| Worker is stuck on F-001, try this approach | **steer** — async, free, picked up next dispatch |
| Why did the worker make this design choice? | **chat** with worker on F-001 — read-only Q&A |
| Let me think through the spec with the architect before we commit | **chat** with architect — multi-turn, no autonomous interference |
| Want to inspect the same context the autonomous validator has | **chat** with validator |
| Need to ask the project_manager about what's in the project spec and why | **chat** with project_manager |
| Debugging weird orchestrator behavior | **chat** with orchestrator — read-only; don't expect it to fix the loop |

## Cost discipline

Every chat turn is a full `claude -p` call. The cost meter in each chat header shows running spend. To set hard caps, add to `.harness/config.json`:

```json
{
  "maxChatCostUsd": 5,
  "maxAggregateChatCostUsd": 50
}
```

- `maxChatCostUsd` — limit per individual chat. When hit, further messages on that chat are refused.
- `maxAggregateChatCostUsd` — limit across all non-archived chats in this harness. When hit, no new messages on any chat. Archive a chat to free its budget.

Both are optional; default is uncapped. The autonomous loop's `maxCostUsd` budget is separate — chats don't draw from it.

## Audit trail

Both features leave a durable trail:

- **Notes** → `<harness-dir>/.harness/notes/F-XXX.md` (file timestamps + author headers per block)
- **Chats** → `harness_<slug>.agent_chats` table (id, role, feature_id, transcript jsonb, tokens_in, tokens_out, cost_usd_cents, created_at, archived_at)

Archiving a chat does not delete the row. Two-week-old chats are still queryable: `SELECT * FROM harness_<slug>.agent_chats WHERE archived_at IS NOT NULL`.

## Related

- [Lifecycle hooks](/docs/operating/hooks) — fire on agent boundary events. The worker reads notes on every dispatch; if you want to react to *new note added*, write a watcher hook.
- [Operator conventions](/docs/operating/conventions) — patterns for managing harness state, including notes hygiene.
- [Roles](/docs/architecture/roles) — what each role does, when the orchestrator dispatches it, what it reads and writes.
