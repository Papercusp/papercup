---
title: Restore claude-code as a fully-supported agent backend
slug: claude-code-backend-restore-2026-05-30
status: active
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
---

# Restore claude-code as a fully-supported agent backend

## Now

**State:** Phase 1 critical path **shipped on main** 2026-05-30. claude-code is
now wired in the headless orchestrator: a fleet agent spawned with
`AGENT_BACKEND=claude-code` is passed
`--mcp-config <cwd>/.mcp.json --strict-mcp-config --permission-mode bypassPermissions`
so it loads + trusts the signed per-spawn `.mcp.json` (omp path-discovers it;
claude `-p` treats an unapproved project `.mcp.json` as pending and never
connects — verified vs claude 2.1.158). `spawn-mcp` now emits `{type:'http',url}`
(both backends load it), and model ids are normalized for claude
(`anthropic/claude-opus-4-7` → `claude-opus-4-7`) in both the orchestrator and
the in-process chat path. Submodule commits `papercusp@39ef1d0` +
`papercup-shared@ff1045e`, pinned by superproject main commit `39ace491`. 13 new
unit tests + full suites green (59 orchestrator, 3 chat-stream). D-003 resolved
to option A (bypassPermissions, no per-role allow-list yet). Not pushed to the
Papercusp remotes (local-only pins, per the repo's existing convention).

**Next:** Phase 1 is **fully verified** — P-006 was confirmed live 2026-05-30:
`claude -p` with the fix's flags (`--mcp-config {type:'http',url} --strict-mcp-config
--permission-mode bypassPermissions`) pointed at the real papercusp MCP host on
`:3070` loaded the config, connected, listed the tool surface, and **actually
invoked** `mcp__papercusp__harness_list` (tool_use + tool_result in the
stream-json). **P-007 is also done** (2026-05-30): per the user's ruling, the
stateless paths now go direct to Anthropic with the Claude session for
claude-code users (Meridian kept for omp) — so **a claude-code user needs no omp
or Meridian auth at all**. Remaining: P-009 (wizard copy, now unblocked by P-007,
needs the desktop to verify render); P-010 (retire `run.sh` — its orchestrator
role is already dead, but 3 operator sites still source its bash function
library; deletion = porting those to the TS `invoke()`); and the deferred push
of the submodules to the Papercusp remotes.

## Progress log

### 2026-05-30 — Phase 1 critical path shipped (P-002…P-005 done; P-006 unit-level)

Submodule commits `papercusp@39ef1d0` (orchestrator) + `papercup-shared@ff1045e`
(chat-stream), pinned on superproject `main` by `39ace491`. All edits
lock-claimed via `locks:*`.

- **P-002** `invoke.ts` — new pure `claudeMcpArgs()` appends
  `--mcp-config <cwd>/.mcp.json --strict-mcp-config --permission-mode bypassPermissions`
  on the claude-code path. No-ops for omp / no-workspace / non-claude stream, and
  honors any of those flags the user already put in `AGENT_CMD`.
- **P-003** `spawn-mcp.ts` — `buildSpawnMcpConfig` + `writeSignedSpawnMcp` now
  emit `{ type:'http', url }`. Verified omp still loads it (converse already
  ships an explicit `type:'http'` server through omp).
- **P-004** resolved per **D-003 option A**: `--permission-mode bypassPermissions`,
  no per-role allow-list. Per-role derivation from `tools.md` deferred as later
  hardening.
- **P-005** `normalizeModelForBackend` (orchestrator `env.ts`) +
  `normalizeModelForClaude` (`chat-stream.ts`) strip a leading `provider/`
  segment for the claude-code backend; omp keeps the prefix.
- **P-006** unit-level **done**: `claudeMcpArgs` (6), `normalizeModelForBackend`
  (6), `normalizeModelForClaude` (3), spawn-mcp `type:'http'` guard — all green.
  The live "spawn a real claude worker and watch it call a tool" check still owed
  (needs the Tauri desktop + a claude session) — item kept `wip`.

### 2026-05-30 — P-008 shipped (Test-current-backend probes the selected backend)

Superproject commit `b6dc9411` (apps/operator — not a submodule). The
`/agent-config/test` route hard-pinned `backend:'meridian'`, so the settings
"Test current backend" button validated the background-summary path regardless
of the user's choice. Now it resolves `effectiveBackend()` and fires the one-shot
PONG at that CLI (claude-code or omp). `effectiveBackend` was consolidated into
`lib/agent-config.ts` (was a private copy in the route's `index.ts`); 4 unit
tests added. This is independent of the P-007 Meridian ruling.

**Landing logistics (for the next agent):** this code lives in the
`libs/papercusp` + `libs/papercup-shared` **git submodules**, whose pinned
commits are **local-only** (never pushed to github.com/Papercusp — `origin/main`
of each is behind the pin). Workflow used: edit + verify in the shared checkout's
submodule working trees → commit on each submodule's `main` → bump the
superproject pointer on `main`. Pushing the submodule repos to the Papercusp
remotes is a separate, batched step the team already defers (superproject `main`
already pinned an unpushed submodule commit before this change), so it was NOT
done here.

### 2026-05-30 — P-006 verified live (claude calls a real papercusp tool)

No code change — verification only. claude 2.1.158 is authenticated headless on
this box, and the papercusp MCP host answers a Streamable-HTTP `initialize` on
`:3070`. Wrote a `.mcp.json` of the exact shape `buildSpawnMcpConfig` produces
(`{type:'http', url}`, + a superuser bearer for this ad-hoc test) and ran
`claude -p --mcp-config <file> --strict-mcp-config --permission-mode bypassPermissions
--output-format stream-json` with a prompt forcing a tool call. Result: a
`tool_use` event for `mcp__papercusp__harness_list` plus two `tool_result`s —
i.e. claude loaded the config, connected, did `tools/list` over the 100+ tool
surface, and invoked one. The old path (no `--mcp-config`, or bare `{url}`) left
the server "⏸ pending approval, not connected." The tool *returned* an auth
error because the bare `?superuser=1` URL carried no workspace scoping — a
property of the ad-hoc test config, not the fix; the real fleet uses the
spawn-**signed** URL whose params carry workspace/role. The full round-trip
(claude→operator→tool→response→claude) executed. Remaining gold-standard:
orchestrator `invoke()` spawning a claude worker with the signed-URL `.mcp.json`
against a running desktop doing real harness work — each link of which is now
independently verified.

### 2026-05-30 — P-007 done (claude-direct stateless) + P-010 run.sh investigated

**P-007** (submodule `papercup-shared@fb85c809`, superproject `69e94bd9`): the
stateless `'meridian'` path now auto-routes via `resolveStatelessTransport()` —
claude-code users hit api.anthropic.com directly with their Claude OAuth session;
omp users keep the Meridian router. Probed first that the Claude OAuth token
works direct (it does, no Claude-Code-usage gating), then verified the integrated
path live (`AGENT_BACKEND=claude-code` → `runAgentChat backend:'meridian'` →
`PONG`, real tokens + $0.0000376). A claude-code user now needs **zero** omp/
Meridian auth. See D-004.

**P-010 / run.sh** (investigation, no change yet): answer to "is run.sh used at
all" — its **orchestrator main-loop role is dead** (`orchestrator/bin/run.ts`:
`PAPERCUSP_USE_TS_ORCHESTRATOR=0` no longer honored; TS is the only loop since
2026-05-08). But it is **not** deletable yet: three live operator sites still
`source` run.sh's bash *function library* to spawn agents —
`harness-scoper.ts:52`, `expert-dispatcher.ts:302`,
`endpoint-route/routes/harness/spawn.ts:252` (and the retired web surface, which
doesn't count). Full retirement = porting those onto the existing TS `invoke()`,
a deliberate refactor with scoper/expert/spawn blast radius (PARITY.md). Left as
P-010 `todo`, not rushed.

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
   Its claude branch appended stream-json flags **but no MCP wiring** (fixed in
   P-002/P-003).

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

**B1 — CRITICAL: orchestrator-spawned agents got zero MCP tools on claude-code.**
(Fixed — P-002/P-003.) Three compounding causes:
- `invoke.ts` built `finalArgv = [...argv, ...extraFlags]` with only
  stream-format flags + `--model` — it **never appended `--mcp-config` or a
  permission bypass**. Those flags existed only in the in-process chat-stream
  path. (Now: `claudeMcpArgs()`.)
- `spawn-mcp.ts:2` is explicitly built for *"so **OMP** discovers… OMP's MCP
  discovery is path-based (no env-var override exists)."* It writes
  `<cwd>/.mcp.json` and relies on omp auto-loading it. **`claude -p` does not
  auto-load an unapproved project `.mcp.json`** — verified vs claude 2.1.158
  (`claude mcp get` reports unapproved `.mcp.json` servers as "⏸ Pending
  approval and not connected to"). `--mcp-config` loads + trusts it directly.
- The written config was `{ papercusp: { url } }` — a bare `url` with **no
  `type` field**. omp infers http; claude-code's mcp-config schema wants
  `{"type":"http","url":…}`. (Now: emitted unconditionally.)

**B2 — HIGH: model IDs are in omp/Meridian `provider/model` format.** (Fixed —
P-005.) The operator brain default is `'anthropic/claude-opus-4-7'`
(`converse.ts:111`); `claude --model` rejects the `anthropic/` prefix — it wants
`claude-opus-4-7` or an alias. Both `invoke.ts` and chat-stream passed the id
verbatim. (Now: normalized for claude in both paths.)

**B3 — MEDIUM: stateless background paths were hard-pinned to Meridian.**
(**Resolved** — P-007 + P-008.) `haiku.ts` (summarizer) + `llm-client.ts`
(judge/sim-user) routed `backend:'meridian'` through the Meridian router, which
needs `~/.omp/agent/auth.json` — so a claude-code user still depended on omp
auth. Now `resolveStatelessTransport()` sends a claude-code user's stateless
calls direct to Anthropic with their Claude session; Meridian only for omp. The
"Test current backend" button (`agent-config/test.ts`) probes the selected
backend, not Meridian. A claude-code user now needs no omp/Meridian auth.

**B4 — MEDIUM: bash `run.sh` has no MCP wiring for either backend.** (Open —
P-010.) `run.sh` builds correct claude stream flags (`:1288`) but contains zero
`--mcp-config` / `.mcp.json` code. It's the deprecated fallback (TS orchestrator
is default), so lower priority.

**B5 — LOW (UX): SetupWizard frames the three tools as a mandatory bundle.**
(Open — P-009; unblocked by P-007.) `StepAgents.tsx:100` — *"oh-my-pi + Claude
Code + Meridian as a bundle… You need all three"*; gates on `claudeOk && ompOk
&& meridianOk` (`:61`). Now that a claude-code user needs neither omp nor
Meridian (P-007), the wizard can gate on the chosen backend's deps. Onboarding-
only; the settings page already offers the real choice.

### Effort

Critical path was **B1a + B1b + B1c + B2** (P-002…P-005), concentrated almost
entirely in the orchestrator (`invoke.ts` + `spawn-mcp.ts`) plus a model-id
shim. Shipped 2026-05-30. B3/B4/B5 are correctness/UX polish around it.

## Phase 0 — Scope gate

- **P-001** `done` Scope approved: proceed with the Phase 1 critical path (the autonomous fleet on claude-code with MCP tools + correct model). The Meridian ruling (→ D-004) was carved out to P-007 and is still open.

## Phase 1 — Orchestrator MCP + model wiring (critical path)

Makes the autonomous fleet actually run with tools + the right model on
claude-code. **Shipped 2026-05-30** (see Progress log).

- **P-002** `done` B1a — invoke.ts `claudeMcpArgs()` appends `--mcp-config <cwd>/.mcp.json --strict-mcp-config --permission-mode bypassPermissions` on the claude-code path so spawned fleet agents load + trust the per-spawn signed `.mcp.json`.
- **P-003** `done` B1b — spawn-mcp.ts `buildSpawnMcpConfig` + `writeSignedSpawnMcp` emit `{type:'http', url}`; verified omp still loads it.
- **P-004** `done` B1c — resolved per D-003 option A: `--permission-mode bypassPermissions`, no per-role allow-list (deferred hardening).
- **P-005** `done` B2 — `normalizeModelForBackend` (env.ts) + `normalizeModelForClaude` (chat-stream.ts) strip the `provider/` prefix for claude-code; omp keeps it.
- **P-006** `done` Verification: unit-level (13 tests) + **live** — `claude -p` with the fix's flags against the real papercusp MCP host on `:3070` loaded the config, connected, and invoked `mcp__papercusp__harness_list` (tool_use + tool_result in stream-json). Confirms claude loads + calls our `{type:'http',url}` config, the behavior the old unloaded path lacked. blocked-by: P-002, P-003, P-004, P-005

## Phase 2 — Background paths & UX polish

Meridian coupling, the test button, the wizard, the bash fallback.

- **P-007** `done` Ruled (user 2026-05-30): keep Meridian for non-claude; claude-code users auth direct. Implemented `resolveStatelessTransport()` in chat-stream.ts — the stateless 'meridian' path (haiku, llm-testing) now goes DIRECT to api.anthropic.com with the Claude OAuth session for claude-code users (verified live: PONG + real cost; the OAuth token works against the API with `anthropic-beta: oauth-2025-04-20`), and via the Meridian router for omp. A claude-code user no longer needs omp auth. Submodule `papercup-shared@fb85c809`, pinned by `69e94bd9`. (→ D-004)
- **P-008** `done` Test-current-backend now probes the *selected* backend (one-shot through the configured CLI via `effectiveBackend()`), not hardcoded `meridian`. `effectiveBackend` consolidated into `lib/agent-config.ts`; 4 unit tests. Commit `b6dc9411`.
- **P-009** `todo` SetupWizard: present claude-code as a standalone backend; gate readiness on the *chosen* backend's deps, not `claudeOk && ompOk && meridianOk` (StepAgents.tsx:61/100). UNBLOCKED by P-007 — a claude-code user now needs only the `claude` CLI + a Claude session (no omp, no Meridian): the orchestrator runs claude-code and the stateless paths go direct. Needs the Tauri desktop to verify the wizard render.
- **P-010** `todo` Retire bash `run.sh` entirely (user ruling 2026-05-30). Finding: its orchestrator main-loop role is ALREADY dead — `orchestrator/bin/run.ts` warns `PAPERCUSP_USE_TS_ORCHESTRATOR=0` is no longer honored (TS is the only loop since 2026-05-08). What blocks deletion: 3 live operator sites still `source` run.sh's bash *function library* (`invoke`/`log`/`config_get`/…) to spawn agents — `harness-scoper.ts:52`, `expert-dispatcher.ts:302`, `endpoint-route/routes/harness/spawn.ts:252`. Port those onto the TS `invoke()` (orchestrator/src/invoke.ts), then delete run.sh. Real refactor with scoper/expert/spawn blast radius (PARITY.md territory) — do deliberately + verify scoping still works.

## Decisions

### D-001 — claude-code was deprecated by neglect, not removed
Date: 2026-05-30
The central audit finding. Both agent spawn paths still carry working claude-code branches: chat-stream.ts has a complete one (--mcp-config/--allowed-tools/--permission-mode/--model), and the orchestrator's invoke.ts still selects claude stream-json flags and parses claude-stream-json output. Nothing was deleted. What happened instead: as MCP host-discovery, Meridian routing, and `provider/model` id conventions were added, only the omp path was updated to match. So claude-code "stopped working" in specific places (orchestrator MCP wiring, model-id format, Meridian-pinned background paths) rather than being torn out. Implication: this is a gap-closing job, not a re-implementation — see the ranked blockers B1–B5 in Background.

### D-002 — The gap is the orchestrator path, not the in-process chat path
Date: 2026-05-30
There are two spawn mechanisms and they are in very different states. The in-process chat path (runAgentChat in chat-stream.ts) already drives claude-code correctly — every caller (converse, oracle, scan, delegate, plans-runner) passes mcpConfig + allowedTools + permissionMode:'bypassPermissions', and the claude branch turns those into real CLI flags. So the operator brain, oracle, scan, delegate and plan agents would already function on claude-code today (modulo the model-id format, D below). The headless orchestrator path (invoke.ts) is the broken one: it writes a per-spawn .mcp.json designed for omp's path-based auto-discovery but never passes --mcp-config/--allowed-tools to claude, so a claude-code worker/validator/scoper/etc. boots tool-less. Therefore the critical-path work (P-002…P-005) lives almost entirely in invoke.ts + spawn-mcp.ts; do not rewrite the chat path.
Related: P-002, P-003

### D-003 — Headless allowed-tools: ship bypassPermissions first, derive per-role later
Date: 2026-05-30
Resolved to option A and shipped (P-004). The in-process chat surfaces each hand claude an explicit `allowedTools` allow-list, but the headless fleet has no equivalent — it relied on omp's own permissioning + path-discovery. claude -p will otherwise block on a permission prompt for every MCP tool call, which hangs a non-interactive spawn. Two options: (A) spawn claude with `--permission-mode bypassPermissions` so no allow-list is needed — the harness runs in an isolated worktree, so this is the pragmatic first cut; (B) derive a per-role allow-list from each role's tools.md surface (cleaner, more work, keeps a guardrail). Chose A for the first functional cut; B remains available as later hardening.
Related: P-004, P-002

### D-004 — RESOLVED: keep Meridian for non-claude; claude users auth direct
Date: 2026-05-30
**User ruling (2026-05-30):** "Meridian only needed for non-claude now. Keep Meridian. They can auth with claude directly now." So the stateless one-shot paths (haiku summarizer, llm-testing) are now backend-aware rather than hard-pinned to Meridian — Option B, not A.

Verified the premise before building: the Claude OAuth session token (`~/.claude/.credentials.json` → `claudeAiOauth.accessToken`) works **directly** against api.anthropic.com with `authorization: Bearer` + `anthropic-version: 2023-06-01` + `anthropic-beta: oauth-2025-04-20` — returns normally, no Claude-Code-shaped-usage gating (the thing that historically forced these through Meridian). It's the same Claude-Max OAuth credential Meridian was forwarding.

Implemented as `resolveStatelessTransport()` in `chat-stream.ts` (P-007): when the effective agent backend is claude-code (or no Meridian token but a Claude session is present) the stateless path goes direct to Anthropic; otherwise it routes through the local Meridian router (omp's multi-provider path). Call sites (haiku, llm-client) are unchanged — they still pass `backend:'meridian'`; the routing is internal. Net: a claude-code user needs **no omp/Meridian auth at all**. The test button (P-008) independently already probes the selected backend.
Related: P-007, P-008
