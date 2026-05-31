---
title: Agent launch unification — one spec, every backend, every surface
slug: agent-launch-unification-2026-05-30
status: active
created: 2026-05-30
updated: 2026-05-30
owner: aviynw3@gmail.com
---

## Now

**State:** Unifies two in-flight efforts that converge on the same hot path
(`orchestrator/invoke.ts` + the backend abstraction): (1) the **agent-backend
refactor** handoff (`agent-backend-refactor-handoff-2026-05-30`) — its (a)
per-surface brain backend + (b-brains) codex-for-brains are DONE; (b-orchestrator)
+ (c) remain; and (2) **psu role sessions** (`psu-role-sessions-2026-05-30`,
now folded in here). Both touch `invoke.ts` and the `AgentBackend` type — doing
them separately means colliding/reworking, so they are sequenced as one plan.

**Next:** human confirms the open decisions in §Decisions (esp. unifying the two
`AgentBackend` copies, and migrating the legacy console-launch path onto psu),
then Phase 1 (the shared spine: backend reconcile + `consumes` + `buildRoleLaunchSpec`).

**Reference (do not duplicate — read these):** the handoff brief
`agent-backend-refactor-handoff-2026-05-30.md` is the canonical reference for
§2 (the two-backend-systems model), §7 (how to live-test codex), §8 (LANDMINES
— codex sandbox/tool-call shapes, omp `--system-prompt`, submodule commit
order), and §9 (the full file index). This plan is the execution sequence; that
brief is the map. Keep both.

## Background

Two backend abstractions, multiple launch paths, one convergence point.

**Two backend systems** (handoff §2 — don't conflate):
- **`AgentBackend`** = `claude-code | omp | meridian | codex` — drives the in-app
  **brains** (`runAgentChat`) AND the harness **orchestrator** pipeline. The
  shared type (`libs/papercup-shared/.../chat-stream.ts:41`) has all four; the
  orchestrator keeps a **separate, narrower copy**
  (`libs/papercusp/packages/orchestrator/src/types.ts:101` = `claude-code | omp`
  — no codex, no meridian). **Verified 2026-05-30.**
- **`SuAgent`** = `claude | omp | codex` — drives the superuser consoles / the
  `*-su` wrappers / `psu` (`apps/operator/lib/su-agents.ts`).

**Launch paths:**
- brains → `runAgentChat` (per-surface backend override — DONE).
- orchestrator pipeline roles → `invoke(ctx, role, extras)` (`invoke.ts`), also
  reached by the `orchestrator.spawn` MCP primitive. Mints `<role>.persona.md` +
  `<role>.tools.md` + a **signed per-spawn MCP URL** (`signSpawnParams` →
  `role=&…&sig=`) with real role-allowlist enforcement at dispatch.
- SU / role consoles → `psu` → `bootstrap-su` → `*-su` wrapper (interactive).
  The `?superuser=1` MCP path **hardcodes `role: operator` + bypasses the
  role-allowlist** (`_mcp-handler.ts`), so SU consoles are inherently un-scopeable.
- legacy → `/api/agent-mcp/console/launch` (mode `omp`) → `buildEngineerOmpLaunchCommand`
  — still live (plan-agent launch + native-console) and **omp-only**.

**The convergence:** `invoke.ts` is where the handoff's "codex in the
orchestrator" lands AND where psu role sessions get their spec. A true
role-scoped interactive session is *the same spec `invoke()` builds, run
interactively*. So the keystone is a single **`buildRoleLaunchSpec`** + a
**reconciled `AgentBackend`**, consumed by: the orchestrator loop,
`orchestrator.spawn`, and psu. That's the unification.

## Done (context — do NOT redo; from the handoff)

- **(a)** Per-surface backend override for the 8 in-app brains + `/settings/agent`
  UI (`4174949d`, `269913d3`). `AgentConfig.backends` + `surfaceBackend()`.
- **(b-brains)** **codex** as a live-verified 4th `AgentBackend` for the brains —
  ChatGPT OAuth, no API key; codex arg-branch + `handleCodexEvent` + `CODEX_PRICES`
  in `chat-stream.ts@papercup-shared 6454481`; exposed in `agent-config.ts`
  (`14603003`).
- **psu (this session, shipped):** `bootstrap-su` + role-agnostic SU picker,
  workspace selector, skip-permissions on all `*-su` wrappers, `psu --resume`
  (cwd-from-DB), flag preselect, /adv "No plan" group + agent-kind chip + live
  refresh. (Plan `psu-wrappers-and-plan-tracked-launch-2026-05-30`, merged #87.)

## Phase 1 — Shared spine (backend reconcile + role registry + one spec)

> Everything downstream depends on this. Do it once, here.

P-001 todo **Reconcile the two `AgentBackend` copies** (handoff OQ2b). Make the orchestrator consume the shared `AgentBackend` from `@restart/papercup-shared` (which already has `codex`+`meridian`) instead of its private `types.ts:101` copy — or, if a clean import boundary isn't available across the submodule edge, narrow to a single shared source and document why. Removes the "keep two enums in sync" landmine. blocked-by:(none)
P-002 todo Add `consumes: { feature: 'required'|'optional'|'none'; plan: 'optional'|'none' }` to `RoleManifest` (`role-registry.ts`) + validation; default `{none,none}` (back-compat). Declare it in each built-in `prompts/<role>.role.json`, cross-checked against which roles actually get `FEATURE_ID` in `main-loop.ts`. Surface on `roles:get`/`roles:list`. blocked-by:(none)
P-003 todo **Extract `buildRoleLaunchSpec(ctx, role, extras, opts)`** from `invoke()` → `{ promptFile, mcpUrl (signed), cwd, env, backend, model, runId, spawnId, structuredOutputFlags }`. No exec — pure assembly. Re-express `invoke()` on top of it (its headless exec + decision-parse retained verbatim). Parity unit test: the spec for `worker`+`FEATURE_ID=F` is byte-identical to what `invoke()` built pre-refactor. **Highest-care change — the orchestrator hot path.** blocked-by:P-001

## Phase 2 — codex in the orchestrator pipeline (handoff b-orchestrator)

> Re-applies the brains' codex pattern in the orchestrator codebase, now on
> top of the reconciled backend + spec from Phase 1.

P-010 todo `orchestrator/env.ts` — `resolveAgentBackend` maps env `codex` + a `codex` binary; `normalizeModelForBackend` handles codex bare model ids. blocked-by:P-001
P-011 todo `invoke.ts` / `buildRoleLaunchSpec` — codex arg-branch (`codex exec --json --skip-git-repo-check --ephemeral`, prompt on stdin, per-spawn `CODEX_HOME` with `AGENTS.md`+`config.toml`+`auth.json` symlink), codex structured-output flags, and a `handleCodexEvent` parser mirroring `chat-stream.ts@6454481` (tool name on `item.tool`, emit on `item.completed` only). **Landmine:** codex MCP tool-calls need `-s danger-full-access --dangerously-bypass-approvals-and-sandbox` (handoff §8). blocked-by:P-003,P-010
P-012 todo Per-role codex via `.harness/config.json` `aiBackend.roles[role].agentCmd='codex'` + (optional) a HarnessSettingsPanel control. blocked-by:P-011
P-013 todo Live-test (codex is logged in — verify, don't compile-only): a codex `worker` on a real feature streams a result + fires an MCP tool_call. Commit submodule-first, then bump the parent pointer (handoff §8). blocked-by:P-011

## Phase 3 — psu interactive role sessions (folds in psu-role-sessions plan)

> Same `buildRoleLaunchSpec` from Phase 1, run INTERACTIVELY. Role-scoped tools
> come free via the signed per-spawn URL (vs `?superuser=1`).

P-020 todo `adv_sessions`: add `role` + `feature` columns (ALTER IF NOT EXISTS, `cwd`-precedent — no submodule migration); thread through `adv-sessions.ts`. blocked-by:(none)
P-021 todo `bootstrap-role` endpoint (`POST /api/agent-mcp/console/bootstrap-role { role, backend, workspace, harness, feature?, plan? }`). Calls `buildRoleLaunchSpec`, writes the signed `.mcp.json` to the session cwd, records the `adv_sessions` row (role+feature), returns `{ sessionId, cwd, launchBin, args, mcpJsonPath, promptFile, envelopeEnv }`. Rejects a `consumes.feature:required` role with no feature. blocked-by:P-003,P-020
P-022 todo Role-aware launch: exec the chosen backend with the **role** prompt (`<role>.persona.md`+`tools.md`, NOT the engineer playbook) + the per-session signed `.mcp.json`. Reuse the `*-su` wrapper with a prompt-override env where possible; backend chosen via the same `AgentBackend`/`SuAgent` (reconcile naming at the psu seam). blocked-by:P-021
P-023 todo psu `--role` (default `su`) + role-first picker driven by `roles:list`+`consumes`: `role → backend → workspace → harness → (feature|plan|none) → launch`. Feature picker via a new `?role=&harness=&features=1` mode on the options endpoint (reuses `features:list`). `--role`/`--feature`/`--backend` preselectable (existing partial-preselect rule). blocked-by:P-021,P-020
P-024 todo Manual e2e: `psu --role=worker` → harness → feature → backend opens with worker persona + **worker-scoped tools** (verify a non-worker tool is rejected) + `FEATURE_ID` set + tracked /adv row tagged worker·F-NNN. Repeat one role on codex backend. blocked-by:P-022,P-023

## Phase 4 — retire the legacy omp-only console-launch path (handoff c)

> Decision OQ1 leans migrate (repo "no users, fix it right"): route the legacy
> callers onto the modern psu/bootstrap flow that already handles all 3 agents +
> (after Phase 3) all roles, rather than teaching the old omp-only builder two
> more agents.

P-030 todo Migrate plan-agent launch (`plans-api.ts`) + native-console (`native-console.ts`/`native-omp-launch.ts`) onto `bootstrap-su`/`bootstrap-role` (+ the terminal spawn psu uses), replacing the `mode:'omp'` `buildEngineerOmpLaunchCommand` path. Gate `--model`/`-r <resume>` per backend (confirm claude-su/codex-su accept them; else omp-only). blocked-by:P-021
P-031 todo Plan-launch UI: add an agent (+ role?) selector to the launch affordance (today there's none). blocked-by:P-030
P-032 todo Retire `buildEngineerOmpLaunchCommand` + the `mode:'omp'` branch of `console-launch.ts` once callers are migrated; grep for stragglers. blocked-by:P-030,P-031

## Phase 5 — surfacing, model coupling, docs

P-040 todo /adv Sessions: show role + feature + backend on rows (extends the agent-kind chip); group/filter by role. blocked-by:P-020
P-041 todo **Model+backend coupling** (handoff OQ3): the operator brain model is pinned `anthropic/claude-opus-4-7` (`converse.ts:113`) regardless of backend — won't resolve on codex/claude. Add a per-surface `models` companion to the `backends` map so a per-surface backend carries a compatible model. blocked-by:(none)
P-042 todo Docs: extend `agent-spawning/terminal-wrappers.mdx` (role sessions, `consumes`, tool-scoping, signed-URL parity) + a backend-systems page distilled from handoff §2. Memory note: psu launches role sessions; `consumes` + `buildRoleLaunchSpec` are the single sources. blocked-by:P-024,P-013

## Decisions

### D-001 — Role-scoped tools via the signed per-spawn URL (locked 2026-05-30)
A role session's `.mcp.json` uses a `signSpawnParams`-signed URL carrying
`role=<role>` (NOT `?superuser=1`), so the agent gets exactly that role's
allowlisted tools — literal parity with the orchestrator's agent. SU stays on
the superuser URL.

### D-002 — `consumes` declared in the role registry (locked 2026-05-30)
Single source for "what context does this role need." Replaces the implicit
mapping in `invoke()`/loop logic; read by psu, UIs, and the orchestrator.

### D-003 — One shared `buildRoleLaunchSpec` (locked 2026-05-30)
Extracted from `invoke()`; consumed by the orchestrator loop, `orchestrator.spawn`,
and psu. The unification keystone — the same prompt/tools/feature/backend spec
for every caller, differing only in interactive-vs-headless execution.

### OQ1 — legacy console-launch: migrate vs teach-it-agents (handoff c)
**Recommendation: migrate** (Phase 4) onto psu/bootstrap, per the repo's "no
users, fix it right" ethos and the handoff's own lean. Confirm before P-030.

### OQ2 — backend abstraction (handoff)
- **OQ2a — does codex in the pipeline matter yet, or defer Phase 2?** Human call.
- **OQ2b — unify the two `AgentBackend` copies?** Recommendation: **yes, P-001** —
  it's the prerequisite that keeps Phase 2 + Phase 3 from re-introducing drift.

### OQ3 — per-surface model companion to `backends` (handoff)
Folded in as P-041 (Phase 5).

### Deferred — autonomous spawn trigger
`psu --role=worker --feature=F --detach` firing a real headless
`orchestrator.spawn` (parsed, scheduled, lineage) is a natural follow-up once
`buildRoleLaunchSpec` exists, but is OUT OF SCOPE here and MUST route through
`orchestrator.spawn`, never an external exec (bypasses scheduling + leaks runs).
