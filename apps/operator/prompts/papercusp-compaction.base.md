<!--
CANONICAL SOURCE — edit THIS file. The per-client compaction prompts
(Claude `# Compact Instructions`, the operator converse-brain summarizer) are
PROJECTIONS generated from it via the splice projector — never hand-edit those.
Plan: agent-managed-compaction-2026-07-01.
-->
# Compaction instructions — Papercusp

You are producing the summary that will carry a session across a context
compaction. **The summary is an INDEX into live sources to re-verify — not a
self-contained state dump.** This is a live multi-agent coordination system;
what you write goes stale the moment it is written.

## Open with the re-orient banner
Begin the summary with a one-line instruction to the successor, stated
explicitly: **"This is a stale snapshot of a live system. Before acting on any
fleet / claim / liveness statement below, re-run `coord:orient` and reconcile."**

## Preserve with highest priority
- **Identity block** — as structured fields, not prose: the session `su-id`, the
  fleet slug it leads (if any), the account pin, the harness, the workspace.
- **Session-mode flags** — AUTO mode on/off; monitor/engine loop armed or ended;
  and, when leading a fleet, **per-member wake-mode (auto vs manual)** (a manual
  member silently stages directives instead of delivering them).
- **Unverified claims awaiting owner confirmation** — verbatim, in their own
  slot. These are open commitments; prose dissolves them.
- **Owner-gated walls** — anything blocked on the owner (credentials, capital
  arming, category-1 approvals) — verbatim, in their own slot.
- Decisions made and why; standing instructions / preferences the user stated.
- Named artifacts: plans (slug), work items (WI-NNN), features (F-NNN), files,
  harnesses, URLs, migration numbers.
- Open questions, in-flight work, and the next concrete action.

## Do NOT re-summarize — it is already in the system prompt, re-injected each turn
The agent instructions / su playbook, the tool catalogue (full or trimmed), the
wire-schemas and coord legends, root/user CLAUDE.md, and MEMORY.md are delivered
via the system prompt or MCP tool-definitions and **cannot be lost to
compaction**. Do not spend summary budget restating them. Keep only:
- **Pointers, not copies** — "re-orient via `coord:orient`", "see plan `<slug>`".
- **Reload-hints** for on-demand tools a trimmed session pulled in — e.g.
  "re-`tools:find` / ToolSearch `<capability>` if needed" — never the schema text.

## Liveness semantics (so the successor avoids the classic error)
`fleet:status.alive` = heartbeat freshness only (a process keepalive), NOT
"taking turns / working". Verify real activity via `coord:presence.sessionState`
(live / parked / ended) + `last_active_at`; `intentStale` = a claim not
progressing.

## Memory rule (this system — not the generic guidance)
Durable facts go to `memory:remember` (the shared store). Do **not** instruct the
reader to "add a pointer to MEMORY.md" — MEMORY.md is an auto-regenerated
projection and must never be hand-edited.

## Compress or drop
Greetings, transient status chatter, superseded states, verbose tool output, and
resolved intermediate reasoning.

<!-- PAPERCUSP-COMPACTION:CLIENT-OVERLAY -->
