---
title: Agent-backend refactor (omp / claude / codex) — handoff
slug: agent-backend-refactor-handoff-2026-05-30
status: shipped
created: 2026-05-30
updated: 2026-06-01
owner: aviynw3@gmail.com
---

## Now

**▶ EXECUTION MOVED 2026-05-30 → `agent-launch-unification-2026-05-30`.** The
two remaining items below — (b-orchestrator) codex in the pipeline, and (c)
the legacy console-launch path — are now Phases 2 + 4 of the unified plan,
sequenced with the psu role-sessions work because both efforts converge on
`orchestrator/invoke.ts` + the `AgentBackend` type (the unified plan reconciles
the two type copies once, up front). **This brief remains the canonical
REFERENCE** — §2 (two-backend model), §7 (live-test codex), §8 (LANDMINES),
§9 (file index). Read it; execute from the unified plan.

**State:** The audit + the two highest-value pieces are DONE and committed:
(a) a per-surface backend override for the in-app brains, honored at all 8
brain launch sites + a `/settings/agent` UI; (b) **codex** is now a real,
live-verified 4th subprocess backend for those brains (ChatGPT OAuth, no API
key). Two bounded follow-ups remain, both on launch paths I did NOT touch:
**(b-orchestrator)** wire codex into the harness pipeline-agent spawn path
(`orchestrator/invoke.ts` — a separate mechanism from the brains'), and
**(c)** make the older `/api/agent-mcp/console/launch` (mode `omp`) path
agent-aware (it is still live via plan-launch + native-console, but omp-only).

**Next:** Read §2 (the two-backend-systems model — the single most important
orientation) and §6 (the open design forks) FIRST, then pick up (b-orchestrator)
and (c). Both have a clear pattern to mirror from the work already landed.

---

# Agent-backend refactor — handoff brief

You are taking over the agent-backend (omp / claude / codex) settings refactor.
I (a prior session) did the audit + the in-app-brain half. This brief is the
map so you don't re-audit and don't step on the landmines I found.

## 1. The original ask (two questions from the user)

1. "We changed our agent backend system to support omp / claude / codex —
   make sure the settings are honored everywhere they're set, and check every
   place we launch agents uses the right settings."
2. "Is there any agent-launch site with no place to change which backend it
   uses? If so, where should that setting live?"

## 2. ⭐ THE MODEL: there are TWO separate backend systems. Don't conflate them.

This is the thing that will save you the most time. The user said "omp / claude
/ codex," but the codebase has **two distinct backend abstractions**, and
"codex" was only a first-class citizen in ONE of them before this work:

| System | Values | Drives | Defined in |
|---|---|---|---|
| **`AgentBackend`** | `omp` · `claude-code` · `meridian` · **`codex`** (added this session) | The in-app **brains** (operator/oracle/architect/brainstorm/agent_chats/plans/scanner/delegate) via `runAgentChat`, AND the harness **orchestrator** pipeline via its own path | `libs/papercup-shared/src/agent/chat-stream.ts:41`; a SEPARATE copy in `libs/papercusp/packages/orchestrator/src/types.ts:101` (`'claude-code' | 'omp'`); and `apps/operator/lib/agent-config.ts:28` |
| **`SuAgent`** | `claude` · `omp` · `codex` | Superuser **engineer-collaborator consoles** — the `*-su` wrapper binaries (`claude-su`/`omp-su`/`codex-su`) | `apps/operator/lib/su-agents.ts:14` |

- `meridian` = a stateless single Anthropic-format HTTP round-trip (no
  subprocess, no MCP) — used by `haiku.ts` + `llm-testing/llm-client.ts` for
  judges/summaries. It is intentionally hardcoded at those 2 sites; leave them.
- **codex auth is ChatGPT OAuth** (`~/.codex/auth.json`, `auth_mode="chatgpt"`),
  NOT an OpenAI API key. claude-code auth is Claude Code OAuth
  (`~/.claude/.credentials.json`). omp has its own login. **No backend needs a
  raw API key** — this was the key correction this session (an earlier dead-end
  injected `ANTHROPIC_API_KEY`, which only hit a 10k-ITPM rate wall; the real
  fix is "use a logged-in backend").

## 3. The settings model (3 tiers — all real, all canonical for their scope)

1. **Workspace-global** → PG `harness_shared.operator_agent_config`
   `{ backend, cmd, models, backends }` ← `/settings/agent` page. Helpers in
   `apps/operator/lib/agent-config.ts`. On read it populates everything; on
   write it ALSO mirrors `backend`/`cmd`/`models` into `process.env`
   (`applyToProcessEnv`, agent-config.ts:120) AND writes
   `~/.papercusp/agent/env.sh` for headless `run.sh`. Registered as a
   bootstrap so `runAgentChat`'s `maybeBootstrap()` (chat-stream.ts:58) syncs
   env before the first spawn.
2. **Per-harness** → `.harness/config.json` `aiBackend.{default,roles[role]}`
   `{ agentCmd, model, extraArgs }` ← HarnessSettingsPanel. Read by the
   orchestrator (`invoke.ts` `resolveAgentForRole` / `resolveModel`).
3. **Per-user** → `operator_user_profile.preferred_models` ← `/settings/profile`
   — **models only, no backend** (by design; backend stays workspace-scoped).

**Backend and model are SEPARATE settings** (don't conflate). The operator
brain's model is independently pinned in `resolveBrainModel()`
(`converse.ts:113`, default `anthropic/claude-opus-4-7`).

## 4. ✅ DONE this session (commits)

### (a) Per-surface backend override for the in-app brains
- **`4174949d`** — Added `AgentConfig.backends?: Partial<Record<SurfaceKey, AgentBackend>>`
  (`agent-config.ts`), with `SURFACE_KEYS` =
  `operator|scanner|delegate|oracle|architect|brainstorm|agent_chats|plans`,
  a `parseBackends()` validator, and a `surfaceBackend(surface)` resolver
  (returns the override or `undefined` = inherit global; pass straight to
  `RunAgentChatOptions.backend`). Threaded `backend: surfaceBackend('<surface>')`
  into ALL 8 brain launch sites (they previously relied only on the global
  `$AGENT_BACKEND` env — which DID work transitively via `applyToProcessEnv`,
  but couldn't be set per-surface). The `architect/chat.ts` `streamPrompt`
  helper is shared by architect + brainstorm — it now takes a `surface` param.
  POST `/api/agent-config` validates the `backends` map.
- **`269913d3`** — `/settings/agent` per-surface table UI (a `<select>` per
  surface: "Inherit global" / omp / claude-code / codex).

### (b) codex as a 4th subprocess `AgentBackend` (in-app brains) — LIVE-VERIFIED
- **submodule `papercup-shared@6454481`** — `chat-stream.ts`: added `'codex'`
  to `AgentBackend`; `resolveBackend`/`resolveAgentBin` map env `codex` + a
  `codex` binary name; a codex arg-branch (`codex exec --json
  --skip-git-repo-check --ephemeral`, prompt on **stdin** via trailing `-`);
  a per-spawn `CODEX_HOME` tmpdir holding `AGENTS.md` (= `systemPromptText`,
  codex's only system-prompt surface — it has NO `--system-prompt` flag),
  `config.toml` (`[mcp_servers.<name>]` with `url` + `bearer_token_env_var`),
  and an `auth.json` symlink to `~/.codex/auth.json`; a `handleCodexEvent`
  parser (JSONL events: `item.completed`/`agent_message` → whole-blob delta;
  `mcp_tool_call`/`command_execution` → tool_call; `turn.completed` → result);
  a `CODEX_PRICES` table (the stream carries no cost field).
- **`14603003`** — exposed codex in the parent: `agent-config.ts`
  (`AgentBackend` + `validBackend`/`parseBackends`/`effectiveBackend`), the
  POST validator, the `/settings/agent` radio + per-surface selects, and the
  submodule pointer bump.
- **Live-verified** (codex IS logged in on this box): a plain turn streamed a
  `delta:"OK"` + costed `result`; an MCP turn fired a real `harness:list`
  tool_call through the `config.toml`+bearer-env wiring. **No API key used.**

### Adjacent fixes already landed earlier this session (context, not this refactor)
- **`b61baa60`** — `operator:scan` was still hardcoding `:3055` + the flaky
  `mcp-remote` stdio bridge; backported converse.ts's `selfUrl()` + native HTTP
  MCP. (Real independent bug — the scanner was silently dead on desktop.)
- **`5f6aba3c` + submodule `d780d8b` + `460e09e3`** — `OPERATOR_LEAN_PROMPT=1`
  (default off) test-only lean mode (prompt 14k→3.4k) + a `disableBuiltinTools`
  option (omp `--no-tools`, 91k→64k). These were motivated by a now-understood
  rate-limit dead-end; harmless + gated. Not part of the backend refactor per se.

## 5. ⬜ REMAINING WORK

### (b-orchestrator) — codex for the harness PIPELINE agents
The orchestrator (worker/scoper/validator/reviewer/documenter/curator/debugger)
does NOT use `runAgentChat`. It has its OWN spawn path + its OWN `AgentBackend`
type. So the codex work in `chat-stream.ts` does NOT reach it — you re-apply the
same *pattern* in a different codebase:
- `libs/papercusp/packages/orchestrator/src/types.ts:101` — add `'codex'` to the
  orchestrator's `AgentBackend`.
- `libs/papercusp/packages/orchestrator/src/env.ts:18` — `resolveAgentBackend`
  must map env `codex` + a `codex` binary name; `normalizeModelForBackend` must
  handle codex's bare model ids.
- `libs/papercusp/packages/orchestrator/src/invoke.ts` — `resolveAgentForRole`
  (~259) + the spawn + the per-backend structured-output flags + the event
  parser. Mirror the `handleCodexEvent` logic from `chat-stream.ts@6454481`
  (it's the reference implementation — copy its event shapes + arg-builder).
- This is a submodule (`libs/papercusp`). Per-role codex is then configurable
  via `.harness/config.json` `aiBackend.roles[role].agentCmd = 'codex'` (or a
  HarnessSettingsPanel control).
- **Note the two `AgentBackend` types are separate copies** — keep them in
  sync, or (better, if you want to do it right per CLAUDE.md "fix it now")
  consolidate to one shared type. Today: chat-stream has `+meridian +codex`,
  orchestrator has neither historically. Decide whether to unify.

### (c) — the older `/api/agent-mcp/console/launch` path is omp-only
- The **modern/canonical** SU console launch ALREADY honors all 3 agents:
  `AdvSessionsClient.tsx:487` → `POST /api/adv/sessions/launch-su`
  (`endpoint-route/routes/adv/launch-su.ts`) → spawns `psu --agent=<claude|omp|codex>`
  → exec's the matching `*-su` wrapper. ✅ Nothing to do there.
- The **OLDER** path is still live and omp-only:
  `apps/operator/lib/endpoint-route/routes/agent-mcp/console-launch.ts`
  (`mode: 'shell' | 'omp'`) → `buildConsoleEnvelope` (`console-launcher.ts:145`)
  → `buildEngineerOmpLaunchCommand` (`console-launcher.ts:299`) which literally
  builds `omp --append-system-prompt … -e …` with no claude/codex option.
  - Live callers: `apps/operator/app/admin/plans/plans-api.ts:1099` (plan-agent
    launch) and `apps/operator/lib/native-console.ts` / `native-omp-launch.ts`.
  - The omp-mode path deliberately builds **raw `omp`** (not the `omp-su`
    wrapper) for profile-independence (see the comment at console-launcher.ts:186).
  - **Design fork (see §6):** route claude/codex through the `*-su` wrappers
    (reuse `SU_WRAPPER_BIN` from su-agents.ts, consistent with `launch-su`) vs.
    raw per-agent command construction. Plus: the omp path supports `--model`
    and `-r <resume>` — confirm whether `claude-su`/`codex-su` accept those
    flags before threading them, else gate model/resume to omp.
  - Also needs a UI affordance to *pick* the agent at plan-launch time
    (today there's no agent selector on that flow).

## 6. 🔑 OPEN DECISIONS (get a human call before building these)

- **OQ1 (c) approach:** `*-su` wrappers vs raw per-agent construction for the
  older console/launch path? Or just deprecate that path and migrate plan-launch
  + native-console onto the modern `psu`/`launch-su` flow that already handles
  all 3? (Migration may be the cleanest per the repo's "no users yet, fix it
  right" ethos.)
- **OQ2 (b-orchestrator) scope:** do harness pipeline agents on codex actually
  matter yet, or defer? And: unify the two `AgentBackend` type copies while
  you're in there, or keep them separate?
- **OQ3 model+backend coupling:** the operator brain's model is pinned to
  `anthropic/claude-opus-4-7` (`converse.ts:113`) regardless of backend — on
  codex/claude that model id may not resolve. Decide whether per-surface backend
  should also carry a per-surface model (today `models` is per-ROLE, not
  per-surface). Probably worth a `models` companion to the `backends` map.

## 7. How to TEST (codex is logged in — verify, don't just compile)

- **Codex is authed** (`codex login status` → "Logged in using ChatGPT").
  claude-code is authed (`~/.claude/.credentials.json`). So you can live-test
  all three with NO API key.
- Live-test pattern that worked this session: a tiny tsx script calling
  `runAgentChat({ promptText, backend:'codex', systemPromptText, mcpConfig, allowedTools })`
  and asserting `delta` + `result` (+ a `tool_call` for the MCP case). For MCP,
  point agentmcp at `http://127.0.0.1:3070/api/mcp?superuser=1&workspace=papercusp-workspace`
  with `Authorization: Bearer $(cat ~/.papercusp/superuser-token)`.
- **The running `:3070` must be on your latest code** — it's `tsx bin/hono-host.ts`
  with NO file-watch; reload the Tauri shell / restart to pick up server-side
  changes. (This session burned time on a stale `:3070` that wouldn't free its
  port; if a fresh hono-host won't bind, an orphaned old one is squatting on
  :3070 — its parent is `systemd --user`, kill the orphan tree.)
- For UI verification, drive the **Tauri shell** via `tauri-agent-tools` per
  `/internal/docs/testing/agent-e2e` — NOT a browser against :3055/:3070.

## 8. ⚠️ LANDMINES

- **codex needs `-s danger-full-access --dangerously-bypass-approvals-and-sandbox`
  for MCP tool calls to fire.** Under `-s read-only` codex CANCELS MCP tool
  calls ("user cancelled MCP tool call"). So MCP-bearing codex callers must pass
  `permissionMode: 'bypassPermissions'`. (Handled in chat-stream@6454481; mirror
  it in the orchestrator.)
- **codex tool-call shape:** name is on `item.tool` (NOT `item.name`), args on
  `item.arguments`, plus an `item.server`. agent_message arrives only as
  `item.completed`; tool items arrive as both `item.started` + `item.completed`
  — emit on `completed` only to avoid double-emit.
- **omp `--system-prompt` is a landmine** (documented at chat-stream.ts ~723):
  it REPLACES omp's base prompt and breaks MCP tool-calling ("5x
  WaitForMcpServers / 0 real tool calls"). Always `--append-system-prompt`.
- **`libs/papercup-shared` and `libs/papercusp` are git SUBMODULES.** Commit the
  submodule first (only your file — both carry foreign dirty state like a
  deleted `TESTING.md`; use path-scoped `git commit <file>`), then bump the
  pointer in the parent. The parent has occasionally had an unmerged
  `globals.css` conflict from other agents — use path-scoped commits to avoid
  it blocking you.
- **There is NO `selectStreamFormat` helper** in chat-stream.ts (an audit
  sub-agent hallucinated it). Backend dispatch is the inline ternary at ~917
  (`backend === 'codex' ? handleCodexEvent : backend === 'omp' ? ... : ...`)
  plus the meridian early-return.
- **Don't "fix" the brains that pass no `backend:` and read env** — that IS how
  they inherit the global setting (via `applyToProcessEnv` → `$AGENT_BACKEND`).
  The per-surface `backend:` I added is an OVERRIDE on top, `undefined` = inherit.

## 9. File index (the whole surface, one place)

- Backend enum / resolvers: `libs/papercup-shared/src/agent/chat-stream.ts`
  (`AgentBackend`:41, `resolveBackend`:89, `resolveAgentBin`:108, codex branch +
  `handleCodexEvent` + `CODEX_PRICES`).
- Orchestrator copy: `libs/papercusp/packages/orchestrator/src/{types.ts:101,
  env.ts:18, invoke.ts:225-281}`.
- Workspace config store + per-surface resolver: `apps/operator/lib/agent-config.ts`
  (`surfaceBackend`, `SURFACE_KEYS`, `parseBackends`, `applyToProcessEnv`).
- Config API: `apps/operator/lib/endpoint-route/routes/agent-config/index.ts`.
- Settings UI: `apps/operator/app/settings/agent/page.tsx`.
- In-app brain launch sites (all now pass `backend: surfaceBackend(...)`):
  `agent-tools/operator/{converse,scan,delegate}.ts`,
  `agent-tools/oracle/chat.ts`, `agent-tools/architect/chat.ts` (shared by
  architect+brainstorm), `agent-tools/agent_chats/chat.ts`,
  `agent-tools/plans/runner.ts`.
- SU agents + wrappers: `apps/operator/lib/su-agents.ts`.
- Modern SU launch (already 3-agent): `endpoint-route/routes/adv/launch-su.ts`,
  `app/adv/sessions/AdvSessionsClient.tsx`.
- Older omp-only launch (REMAINING (c)): `endpoint-route/routes/agent-mcp/console-launch.ts`,
  `lib/console-launcher.ts` (`buildConsoleEnvelope`:145, `buildEngineerOmpLaunchCommand`:299).
- Intentional `meridian` hardcodes (leave): `lib/haiku.ts:47`,
  `lib/llm-testing/llm-client.ts:80`.
