---
title: Restore claude-code as a fully-supported agent backend
slug: claude-code-backend-restore-2026-05-30
status: draft
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
---

# Restore claude-code as a fully-supported agent backend

## Now

**State:** Draft — audit complete, awaiting scope sign-off. A code-only audit
(the code was treated as the only source of truth; docs + memory ignored) found
that `claude-code` was **never removed** — both agent spawn paths still carry
working claude branches. The deprecation was *neglect*, not deletion: as
MCP-wiring, Meridian routing, and model-id conventions landed, only the **omp**
path was kept correct. The claude branches rotted in a small set of identifiable
places. The one critical, fully-verified blocker: **orchestrator-spawned fleet
agents (worker/validator/scoper/reviewer/debugger/documenter/curator) get zero
MCP tools on claude-code** — making the autonomous loop non-functional there.
The in-process chat surfaces (operator brain, oracle, scan, delegate, plans
runner) already work on claude-code.

**Next:** human approves scope (P-001) — confirm "fully supported" = the
autonomous fleet runs on claude-code with tools + the correct model (critical
path P-002…P-006), and whether the residual Meridian coupling for stateless
summaries/testing (P-007) is acceptable or must also be decoupled.

## Background

The user asked: "we made the agent backend selectable between omp and others like
claude, then deprecated the non-omp ones and only kept omp working as we added
features — what would it take to make claude fully supported again?"

This plan is the answer, derived from reading the actual code. It is an
**audit + work-scope**, not yet an implementation.

### The abstraction: two independent spawn paths

`type AgentBackend = 'claude-code' | 'omp' | 'meridian'`. There are **two
completely separate** mechanisms that spawn an agent, each with its own backend
handling:

1. **In-process chat path** — `runAgentChat()` in
   `libs/papercup-shared/src/agent/chat-stream.ts`. Drives the operator brain
   (converse), oracle, operator-scan, delegate, plans-runner, pm-dispatch,
   agent-chats. Has a **complete** claude-code branch (`chat-stream.ts:388` —
   passes `--mcp-config`, `--allowed-tools`, `--permission-mode`, `--model`,
   session flags). `meridian` is a third, subprocess-free branch (stateless
   Anthropic-format HTTP call to the local Meridian router) used for one-shot
   non-agent-loop turns.
2. **Headless orchestrator path** — `invoke()` in
   `libs/papercusp/packages/orchestrator/src/invoke.ts` (the TS orchestrator,
   default; `PAPERCUSP_USE_TS_ORCHESTRATOR=0` falls back to the deprecated bash
   `run.sh`). Spawns the autonomous fleet. Backend is `'claude-code' | 'omp'`.
   Its claude branch appends stream-json flags **but no MCP wiring**.

### What already works for claude-code (verified)

- **Settings UI** — `apps/operator/app/settings/agent/page.tsx:198` renders the
  full 3-way `auto / claude-code / omp` radio with binary detection and
  `claude -p` / `claude -p (skip perms)` quick-set presets. The choice is fully
  exposed and persisted (`lib/agent-config.ts`).
- **Auth** — `apps/operator/lib/agent-auth-detect.ts:19` detects a Claude CLI
  session (`~/.claude/.credentials.json`); `app/settings/api-keys/page.tsx:131`
  stores an Anthropic API key documented as "only needed when
  `AGENT_BACKEND=claude-code`."
- **Every in-process chat surface** correctly passes `mcpConfig` +
  `allowedTools` + `permissionMode: 'bypassPermissions'` (converse `:275`,
  oracle `:95`, scan `:206`, delegate `:244`, plans-runner `:266`) through
  chat-stream's complete claude-code branch. claude-code accepts both
  `type:'http'` and `type:'stdio'` MCP servers, so all of these work on
  claude-code at the wiring level. (Correction to an earlier read: scan/delegate
  using a stdio `mcp-remote` bridge is **not** a claude-code blocker — claude
  accepts stdio servers in `--mcp-config`.)
- **pm-dispatch** (`apps/operator/lib/pm-dispatch.ts:166`) honors
  `resolveBackend()` and its parser handles **both** stream formats
  (`:459` omp `message_end` / `:474` claude `result`).
- The orchestrator's result extractor already parses `claude-stream-json`
  (`invoke.ts:363`), and the MCP signed-URL auth (`spawn-mcp.ts:272`) is
  transport-agnostic.

### The verified blockers (ranked)

**B1 — CRITICAL: orchestrator-spawned agents get zero MCP tools on claude-code.**
Three compounding causes:
- `invoke.ts:777` builds `finalArgv = [...argv, ...extraFlags]`, where
  `extraFlags` is only stream-format flags + `--model`. It **never appends
  `--mcp-config` or `--allowed-tools`** — those flags exist only in the
  in-process chat-stream path, never in the orchestrator.
- `spawn-mcp.ts:2` is explicitly built for *"so **OMP** discovers… OMP's MCP
  discovery is path-based (no env-var override exists)."* It writes
  `<cwd>/.mcp.json` and relies on omp auto-loading it. **`claude -p` does not
  auto-load a project `.mcp.json`** without `--mcp-config` (and prior approval),
  so the file is never read.
- The written config is `{ papercusp: { url } }` (`spawn-mcp.ts:78`) — a bare
  `url` with **no `type` field**. omp infers http; claude-code's mcp-config
  schema wants `{"type":"http","url":…}`.

Result: a claude-code fleet agent boots with built-in tools only — no
`features:*`, `messages:*`, `issues:*`, escalations. It cannot do harness work.

**B2 — HIGH: model IDs are in omp/Meridian `provider/model` format.** The
operator brain default is `'anthropic/claude-opus-4-7'`
(`converse.ts:111`), and the code (`converse.ts:107`) notes this is omp's
required `provider/model` form. `claude --model` rejects the `anthropic/`
prefix — it wants `claude-opus-4-7` or an alias (`opus`/`sonnet`). Both
`invoke.ts` `resolveModel` and chat-stream pass the configured id verbatim, so
any per-role override or the brain default breaks on claude-code.

**B3 — MEDIUM: stateless background paths are hard-pinned to Meridian.**
`haiku.ts:45` (summarizer), `llm-testing/llm-client.ts:80` (judge/sim-user), and
the "Test current backend" button (`agent-config/test.ts:41`) all hardcode
`backend:'meridian'`, which needs `~/.omp/agent/auth.json`. Consequences:
(a) a "claude-code-only" user still needs Meridian/omp auth for summaries;
(b) the test button validates Meridian, not the selected backend — misleading
when claude-code is chosen. (a) may be acceptable by design (these are stateless
one-shots needing `maxTokens`/`thinking` that the CLIs ignore) — but it must be a
conscious ruling, and (b) should be fixed.

**B4 — MEDIUM: bash `run.sh` has no MCP wiring for either backend.**
`run.sh` builds correct claude stream flags (`:1288`) but contains zero
`--mcp-config` / `.mcp.json` code. It's the deprecated fallback (TS orchestrator
is default), so lower priority — but `PAPERCUSP_USE_TS_ORCHESTRATOR=0` would make
all agents tool-less regardless of backend.

**B5 — LOW (UX): SetupWizard frames the three tools as a mandatory bundle.**
`StepAgents.tsx:100` — *"oh-my-pi + Claude Code + Meridian as a bundle… You need
all three"*; gates on `claudeOk && ompOk && meridianOk` (`:61`). It never
presents claude-code as a standalone backend alternative. Onboarding-only; the
settings page already offers the real choice.

### Effort

Critical path is **B1a + B1b + B1c + B2** (P-002…P-005), concentrated almost
entirely in the orchestrator (`invoke.ts` + `spawn-mcp.ts`) plus a model-id
shim — roughly a **1–2 day focused effort**, not a re-implementation. B3/B4/B5
are correctness/UX polish around it.

## Phase 0 — Scope gate

- **P-001** `needs-human` Approve scope: confirm "fully supported" = the autonomous fleet runs on claude-code with MCP tools + correct model (Phase 1 critical path), and rule whether the residual Meridian dependency for stateless summaries/testing is acceptable or must also be decoupled (→ D-004). Blocks Phase 1.

## Phase 1 — Orchestrator MCP + model wiring (critical path)

Makes the autonomous fleet actually run with tools + the right model on
claude-code.

- **P-002** `todo` B1a — invoke.ts: on the claude-code path, append `--mcp-config <mcpHandle.path>` and a permission bypass (`--permission-mode bypassPermissions` or honor `--dangerously-skip-permissions` from AGENT_CMD) so spawned fleet agents actually load the per-spawn `.mcp.json`. mcpHandle.path is already in scope at the spawn (invoke.ts:901; finalArgv at :777). blocked-by: P-001
- **P-003** `todo` B1b — spawn-mcp.ts: emit a claude-compatible server entry (`{type:'http', url}`) alongside omp's bare `{url}` shorthand (buildSpawnMcpConfig + writeSignedSpawnMcp, spawn-mcp.ts:78/196). claude-code's mcp-config schema requires the `type` field; omp infers it. blocked-by: P-001
- **P-004** `todo` B1c — resolve the `--allowed-tools` set for headless roles. The fleet has no per-role allow-list today the way chat surfaces do. First cut: rely on `--dangerously-skip-permissions` so no list is needed (the settings UI already offers this preset). Cleanest: derive the list from each role's tools.md surface. Pick one (→ D-003). blocked-by: P-001
- **P-005** `todo` B2 — model-id normalization: when backend is claude-code, translate omp `provider/model` ids (e.g. `anthropic/claude-opus-4-7`) to claude CLI ids (`claude-opus-4-7`/alias) and supply claude-format defaults. Centralize in invoke.ts resolveModel + the OPERATOR_BRAIN_MODEL_DEFAULT (converse.ts:111); chat-stream also passes `--model` verbatim. blocked-by: P-001
- **P-006** `todo` Verification harness: with `AGENT_BACKEND=claude-code`, spawn a real fleet agent (e.g. a worker) and confirm it invokes an agent-mcp tool (e.g. `features:get`) end-to-end — not just typecheck. New test under the canonical Vitest/Playwright paths per the repo testing convention. blocked-by: P-002, P-003, P-004, P-005

## Phase 2 — Background paths & UX polish

Meridian coupling, the test button, the wizard, the bash fallback.

- **P-007** `needs-human` Rule on Meridian's role for the stateless one-shot paths (haiku summarizer, llm-testing). Option A: accept Meridian as the always-on stateless path (document that a claude-code user still needs omp/Meridian auth). Option B: add a claude-code/Anthropic-direct branch to `meridianAgentChat` so those paths can run without omp auth. (→ D-004) blocked-by: P-001
- **P-008** `todo` Fix the "Test current backend" button to probe the *selected* backend (one-shot through the configured CLI), not the hardcoded `backend:'meridian'` (agent-config/test.ts:41). Keep a separate Meridian reachability check if useful.
- **P-009** `todo` SetupWizard: present claude-code as a standalone backend alternative; gate readiness on the *chosen* backend's deps, not `claudeOk && ompOk && meridianOk` (StepAgents.tsx:61/100).
- **P-010** `needs-human` Decide bash `run.sh`: document it as a legacy, tool-less fallback (recommended — TS orchestrator is the default) vs. port the MCP wiring into its `invoke()`. Affects both backends, not just claude-code.

## Decisions

(Appended via plans:add-decision.)

### D-001 — claude-code was deprecated by neglect, not removed
Date: 2026-05-30
The central audit finding. Both agent spawn paths still carry working claude-code branches: chat-stream.ts has a complete one (--mcp-config/--allowed-tools/--permission-mode/--model), and the orchestrator's invoke.ts still selects claude stream-json flags and parses claude-stream-json output. Nothing was deleted. What happened instead: as MCP host-discovery, Meridian routing, and `provider/model` id conventions were added, only the omp path was updated to match. So claude-code "stopped working" in specific places (orchestrator MCP wiring, model-id format, Meridian-pinned background paths) rather than being torn out. Implication: this is a gap-closing job, not a re-implementation — see the ranked blockers B1–B5 in Background.

### D-002 — The gap is the orchestrator path, not the in-process chat path
Date: 2026-05-30
There are two spawn mechanisms and they are in very different states. The in-process chat path (runAgentChat in chat-stream.ts) already drives claude-code correctly — every caller (converse, oracle, scan, delegate, plans-runner) passes mcpConfig + allowedTools + permissionMode:'bypassPermissions', and the claude branch turns those into real CLI flags. So the operator brain, oracle, scan, delegate and plan agents would already function on claude-code today (modulo the model-id format, D below). The headless orchestrator path (invoke.ts) is the broken one: it writes a per-spawn .mcp.json designed for omp's path-based auto-discovery but never passes --mcp-config/--allowed-tools to claude, so a claude-code worker/validator/scoper/etc. boots tool-less. Therefore the critical-path work (P-002…P-005) lives almost entirely in invoke.ts + spawn-mcp.ts; do not rewrite the chat path.
Related: P-002, P-003

### D-003 — Headless allowed-tools: ship --dangerously-skip-permissions first, derive per-role later
Date: 2026-05-30
Proposed direction (confirm at P-004). The in-process chat surfaces each hand claude an explicit `allowedTools` allow-list, but the headless fleet has no equivalent — it relied on omp's own permissioning + path-discovery. claude -p will otherwise block on a permission prompt for every MCP tool call, which hangs a non-interactive spawn. Two options: (A) spawn claude with `--dangerously-skip-permissions` so no allow-list is needed — the settings UI already ships a `claude -p (skip perms)` preset and the harness runs in an isolated worktree, so this is the pragmatic first cut; (B) derive a per-role allow-list from each role's tools.md surface (cleaner, more work, keeps a guardrail). Recommendation: A for the first functional cut, B as later hardening. This choice also interacts with B1a (P-002): if A, P-002 just needs --mcp-config + skip-perms; if B, P-002 must also assemble and pass --allowed-tools.
Related: P-004, P-002

### D-004 — Meridian likely stays the stateless one-shot path even under claude-code (open — human ruling)
Date: 2026-05-30
Open question for the scope gate (P-001/P-007). Three surfaces hardcode backend:'meridian' — the haiku summarizer (haiku.ts:45), llm-testing judge/sim-user (llm-client.ts:80), and the settings "Test current backend" button (agent-config/test.ts:41). Meridian is a subprocess-free Anthropic-format HTTP path that honors maxTokens/temperature/thinkingBudgetTokens — things the agent-loop CLIs (omp, claude-code) ignore. So even a user who picks claude-code as their agent backend still needs ~/.omp/agent/auth.json for these background calls. Recommendation: accept Meridian as the always-on stateless path and document the residual omp-auth dependency (Option A), rather than build an Anthropic-direct branch (Option B) just to let a claude-code user drop omp entirely. Independently of this ruling, the test button (P-008) should still probe the *selected* agent backend, since today it silently tests Meridian regardless of the user's choice.
Related: P-007, P-008
