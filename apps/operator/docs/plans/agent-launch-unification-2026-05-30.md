---
title: Agent launch unification — one spec, every backend, every surface
slug: agent-launch-unification-2026-05-30
status: active
created: 2026-05-30
updated: 2026-05-30
owner: aviynw3@gmail.com
---

## Now

**State: COMPLETE (2026-05-31). All five phases + P-032 shipped & live-verified;
NO open items.** P-032 (the last) converged omp onto psu and deleted the legacy
`buildEngineerOmpLaunchCommand` / console-launch `mode:'omp'` — ONE launch
implementation for every agent now (net −405 lines; commits `deb1ff36e`/
`0e31b43d6`/`a8d4bdbf1`). Everything verifiable by an agent is verified live:
Phase 3 launch plumbing, P-013 codex worker, P-041 settings UI, D-001
tool-scoping, the Phase-4 launch button (fresh-Xvfb in-webview → `launch-su`),
the codex role HTTP round-trip, the codex interactive **TUI** (USER-VERIFIED:
`psu --role=scoper --agent=codex --workspace=papercusp-workspace
--harness=papercup` → TUI opened, role-scoped MCP, `callerRole: scoper,
isSuperuser: false` — after fixing a workspace-blind role-launch bug it surfaced,
orchestrator `f888638` + superproject `f67fe4494`), and P-032 omp parity
(`launch-su {agent:omp,model,kickoff:new-plan}` → 200 + brief generated + psu
spawn; bad-kind → 400 via the shared allowlist). The only inherently-human sliver
left anywhere is a person typing in an interactive TUI; every mechanical layer is
proven. Details in the e2e handoff brief (sessions 2 / 2b / 2c / 2d + P-032).
Unified the agent-backend refactor handoff + psu role sessions:
- **Phase 1** (shared spine): P-001 unify `AGENT_BACKENDS` + drift guard;
  P-002 `consumes` single-source; P-003 `buildRoleLaunchSpec`.
- **Phase 2** (codex orchestrator pipeline): P-010/P-011/P-012 — codex spawn
  path in `invoke.ts` + `writeSignedSpawnCodexHome`.
- **Phase 3** (psu role sessions): P-020/P-021/P-022/P-023 — `adv_sessions`
  role+feature, `bootstrap-role`, `psu --role` picker + role-scoped exec.
- **Phase 4** (launch dispatcher): P-030/P-031 — 6 launch sites → `launchAgent`
  (omp unchanged; claude/codex via launch-su).
- **Phase 5** (surfacing + coupling + docs): P-040 /adv role+feature chips;
  P-041 `surfaceModels` foundation (OQ3); P-042 docs + memory note.

**Session 2 (2026-05-31, codex re-authed + spawn/UI cleared) — most gates CLOSED:**
- **Phase 3 launch plumbing VERIFIED** — bootstrap-role happy path (real isolated
  harness) → `claude -p` w/ roleLaunchArgs connected to the papercusp MCP,
  `callerRole=scoper, isSuperuser=false`.
- **P-013 codex worker VERIFIED** — `codex exec --json` + per-spawn CODEX_HOME
  connected, fired an `mcp_tool_call`, streamed a parseable result. codex auth
  intact after (symlink).
- **codex interactive role sessions BUILT** (commit `39902a89`) — lifted the
  `codex_role_unsupported` 400; `writeRoleCodexHome` mints a per-session
  CODEX_HOME; psu codex branch. 31/31 tests. Only the codex TUI launch (inherent
  human step) unverified.
- **P-041 settings UI VERIFIED end-to-end** via the Tauri bridge (8 model inputs
  render, persisted value loads, type+Save+persist round-trip).
- **Phase 4 launch buttons** — unit (6) + endpoint tested + omp byte-identical;
  in-webview button render/click NOT inspected (drove a stale leftover window
  that wedged; use a fresh Xvfb instance next time, not the user's live window).
Details in the e2e handoff brief "Session 2".

**Partial live verification DONE (2026-05-31 session 1, desktop up on this code):**
45 unit tests green (guardrail set + psu-launcher/adv-sessions); **P-041 backend
round-trip** confirmed via `/api/agent-config` (set `surfaceModels.oracle` → GET
→ reset); **bootstrap-role route mounted + principal-gated** with all negative
gates live — invalid-role 400, codex→400 `codex_role_unsupported`,
worker-no-feature→400 `feature_required`, missing-harness 400. **Options endpoint
(the picker data layer) live** — 28 roles each with `consumes`
(worker=feature:required, scoper=plan:optional), 6 workspaces, 19 features — so
P-023's pickers + P-002's consumes single-source are correct on the wire.
**CLI flags parse-verified** against the installed binaries: claude 2.1.158
accepts `--append-system-prompt-file` + `--strict-mcp-config`; codex-cli 0.135.0
`exec` has every flag invoke.ts passes (the `-`-stdin pattern matches the
live-verified chat-stream path); omp's `--append-system-prompt` documents
file-content support (the one omp-role detail still for e2e). **Code audit of
all four new surfaces (bootstrap-role, psu-launcher, launch-su, invoke.ts codex)
found no bugs** — remaining items are live-behavior gates, not latent defects.
Full notes in the e2e handoff brief
(`agent-launch-unification-e2e-handoff-2026-05-31.md`, "Already verified live").

**Outstanding (the verification debt — needs terminal / authed codex / Tauri UI
driving; the data paths behind these are proven):**
- **P-013** — live codex worker e2e (a codex pipeline agent streams a result +
  fires an MCP tool_call). Needs codex re-auth (token was revoked).
- **Phase 3 e2e** — `psu --role=worker --feature=F` opens a worker session
  tracked in /adv. **D-001 tool-scoping at dispatch is now LIVE-VERIFIED**
  (spawn-signing-e2e: signed worker URL → role-filtered list; worker →
  `role_not_allowed` on operator-only `autoloop:control`; tamper/expiry rejected;
  10/10). Server gates + scoping proven; only the interactive-launch *plumbing*
  (psu→claude/omp connects to the role `.mcp.json`) is unverified.
- **Phase 4 e2e** — the launch buttons on claude/codex (in the webview).
- **P-041 UI** — the `/settings/agent` model widget driving the (proven) round-trip.

**P-041 consumption DONE (2026-05-31):** `surfaceModel()` is now wired into all
8 brain surfaces (converse/oracle/scanner/delegate/architect/brainstorm/
agent_chats/plans) — additive (`surfaceModel ?? existing`), a no-op until a
per-surface model is set. Commit `6c9db80e`. The per-surface model column
in the `/settings/agent` UI is now also wired (load/save/render, commit
`407094cf`) — UI e2e through the Tauri shell is its only pending gate.

**Deferred follow-ups (gated on the e2e + parity):** P-032 (delete the legacy
`buildEngineerOmpLaunchCommand` / console-launch `mode:'omp'`, converging omp
onto psu); codex *interactive* role sessions (psu --role on codex).

**Decisions locked (2026-05-30):** unify the AgentBackend copies (yes), do
codex pipeline agents now (yes, Phase 2), migrate legacy console-launch onto
psu (yes, Phase 4 — reversibly: omp keeps its path, P-032 deletion deferred).

**✅ Phase 1 DONE (the shared spine):**
- **P-001** — unified `AgentBackend` to one canonical subprocess set
  (`claude-code|omp|codex`) as runtime tuples per layer (type derived) +
  a drift-guard test in `apps/operator` (imports all three across the
  submodule boundary). orchestrator widened (+codex resolver/normalizer).
  Commits: papercup-shared `f9b2cdd`, papercusp `ad15d1f`, parent `32212ca7`.
- **P-002** — `consumes` (feature/plan) as the single role→context source:
  `RoleManifest.consumes` + `KERNEL_ROLE_CONSUMES` + `roleConsumes()`,
  surfaced on `roles:get`/`roles:known`. Commit `ee288244`.
- **P-003** — `buildRoleLaunchSpec` (`apps/operator/lib/role-launch-spec.ts`).
  **De-risked vs the original plan:** rather than carve apart `invoke()`'s
  hot path, it COMPOSES the leaves the system already shares —
  `assembleRolePrompt` (`@papercusp/orchestrator/role-prompt`, already used
  by the operator brains) + the operator's `signSpawnParams` (same HMAC key
  the MCP handler verifies) + `resolveProjectDir`. The orchestrator submodule
  is untouched; psu role sessions are assembled from the same primitives as
  the orchestrator + brains. Folding `invoke()` itself onto the builder would
  require unifying autonomous-vs-chat context injection (a behavior change) —
  deferred, not needed for psu. 3 tests green.

**✅ Phase 3 DONE (psu interactive role sessions):**
- **P-020** — `adv_sessions.role` + `.feature` columns (ensure-schema + adv-sessions.ts). Commit `bbfe92a1`.
- **P-021** — `POST /api/agent-mcp/console/bootstrap-role`: composes `buildRoleLaunchSpec`, writes the signed role-scoped `.mcp.json` + the role prompt file, records the `adv_sessions` row (role+feature+agent), feature-gates via `roleConsumes`. codex role sessions 400 (deferred to Phase 2). Commit `bbfe92a1`.
- **P-022/P-023** — `psu --role`: role-first picker (role → backend(claude/omp) → workspace → harness → feature-iff-consumed) + `roleLaunchArgs` exec'ing the raw backend with the role prompt + signed `.mcp.json` (claude `--strict-mcp-config` = true tool-scoping). Options endpoint gains `?features=1` + `roles`. `--role`/`--feature` preselectable. Commit `3b47eb34`.

**Remaining:** Phase 2 (codex in the orchestrator pipeline — also unlocks codex
interactive role sessions), Phase 4 (migrate legacy console-launch onto psu),
Phase 5 (/adv role+feature surfacing + per-surface model coupling + docs).
Manual e2e for Phase 3 (P-024) is gated on an operator reload (the
bootstrap-role + options routes register at boot).

**✅ Phase 2 CODE-COMPLETE (codex in the orchestrator pipeline):**
- **P-010** (env.ts resolver + model normalizer for codex) — landed in P-001.
- **P-011** — `invoke.ts` codex spawn path: `StreamFormat 'codex-json'` +
  `selectStreamFormat`/`streamFormatFlags` (`codex exec --json` +
  unconditional sandbox bypass), `extractResult` codex JSONL parsing (so
  `parseDecision` works), backend-aware model flag (`-m`), prompt via stdin
  `-`, and `writeSignedSpawnCodexHome` (per-spawn `CODEX_HOME` w/ config.toml
  carrying the SAME signed role-scoped URL — sig-auth, no bearer — + ChatGPT
  auth symlink) wired + cleaned up. 5 unit tests (flags + JSONL parsing).
  Commits: orchestrator `03a2c38`, parent bump `26d6eb42`.
- **P-013 (live e2e) PENDING** — a real codex `worker` on a feature must
  stream a result + fire an MCP tool_call. Can't be closed from here (needs a
  running harness + the operator on this code + authed codex). The deterministic
  parts are unit-tested; the spawn wiring mirrors the live-verified chat-stream
  reference but is itself UNVERIFIED-live. Per-role codex via
  `.harness/config.json` `aiBackend.roles[role].agentCmd='codex'`.

**✅ Phase 4 DONE (legacy launch → unified dispatcher):** P-030/P-031 — all 6
`launchOmpAgent` call sites now route through `lib/launch-agent.ts` `launchAgent`
(omp → unchanged path; claude/codex → launch-su → psu). Agent selection on the
AdvSessions surface (existing suAgent control). P-032 (deleting the omp builder)
deferred per the "keep fallback" choice — converge omp onto psu once the psu
path reaches model/kickoff/resume parity + UI e2e confirms it. Commit `c288cbf1`.
UI e2e (drive the Tauri shell) is the pending verification gate; omp behavior is
byte-identical so the default path carries no regression risk.

**Next:** Phase 5 (/adv role+feature+backend surfacing, per-surface model
coupling, docs). Also unblocked: codex interactive role sessions (psu --role on
codex — the CODEX_HOME machinery now exists; currently 400'd in bootstrap-role)
and P-032 (omp→psu convergence, gated on parity + e2e).

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
P-003 done **`buildRoleLaunchSpec`** (`apps/operator/lib/role-launch-spec.ts`) → `{ role, runId, spawnId, cwd, promptText, promptFile, mcpUrl (signed, role-scoped), mcpJsonContents }`. **De-risked:** composes the already-shared leaves (`assembleRolePrompt` from `@papercusp/orchestrator/role-prompt` — already used by the operator brains — + the operator's `signSpawnParams` over the same param set the orchestrator's `writeSignedSpawnMcp` signs + `resolveProjectDir`), so the orchestrator hot path is NOT rewritten. The role's MCP URL carries `role=<role>` (not `?superuser=1`) → dispatch enforces the role tool-allowlist (D-001). Folding `invoke()` onto the builder is deferred (would change autonomous-vs-chat context injection). 3 unit tests green. blocked-by:P-001

## Phase 2 — codex in the orchestrator pipeline (handoff b-orchestrator)

> Re-applies the brains' codex pattern in the orchestrator codebase, now on
> top of the reconciled backend + spec from Phase 1.

P-010 done `orchestrator/env.ts` codex in `resolveAgentBackend` + `normalizeModelForBackend` (landed in P-001, papercusp `ad15d1f`).
P-011 done `invoke.ts` codex spawn path: `codex-json` StreamFormat, `codex exec --json` flags + unconditional sandbox bypass, `extractResult` JSONL parsing (agent_message item.completed), backend-aware `-m` model flag, stdin `-` prompt, `writeSignedSpawnCodexHome` (per-spawn CODEX_HOME config.toml w/ signed role-scoped URL + auth symlink) wired + cleaned up. 5 unit tests. orchestrator `03a2c38`, parent `26d6eb42`. (Used `buildRoleLaunchSpec`? No — invoke keeps its own assembly; codex wired in-place per the de-risk in P-003.)
P-012 done Per-role codex is configurable via `.harness/config.json` `aiBackend.roles[role].agentCmd='codex'` (resolveAgentForRole + the codex spawn path consume it). HarnessSettingsPanel control optional/deferred.
P-013 todo **Live e2e (the verification gate)** — a real codex `worker` on a feature streams a result + fires an MCP tool_call. Deterministic parts unit-tested; spawn wiring mirrors the live-verified chat-stream reference but is UNVERIFIED-live. Needs a running harness + operator-on-this-code + authed codex. blocked-by:P-011

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

P-030 done All 6 `launchOmpAgent` call sites (PlanActions, PlanItemPreview, PlansClient, AgentLauncherButton, AdvSessionsClient ×3) re-pointed through a unified `lib/launch-agent.ts` `launchAgent({ agent, … })` dispatcher: `omp` (default) → the unchanged launchOmpAgent path (model/kickoff/resume preserved); `claude`/`codex` → `POST /adv/sessions/launch-su` → psu → `*-su` wrapper. 6 dispatch unit tests. Commit `c288cbf1`. (Lowest-regression migration: omp behavior byte-identical; claude/codex are the new capability.)
P-031 done Agent selection on the primary launch surface is the existing AdvSessions `suAgent` select + "Launch SU" control (built in the psu-wrappers arc). Per-button selectors on the smaller plan buttons can be added incrementally; they default to omp today.
P-032 done **Converged + deleted (2026-05-31, user-approved "do it now").** All four work-order steps shipped: (1) `--model`/`--resume-session`/`--launch-context` passthrough + `suWrapperExtraArgs` in `psu-launcher.mjs` (the `*-su` wrappers end with `"$@"` → flags reach the CLI); (2) `launchAgent` routes ALL agents — incl. omp — through `launch-su → psu`, threading model/resume/kickoff (`launch-su` generates the kickoff brief server-side via `buildKickoffPromptFile`); deleted `native-omp-launch.ts`. (3) Live-verified: `omp-su --model opus` accepted; `POST launch-su {agent:omp,model,kickoff:new-plan}` → 200 + kickoff brief generated in /dev/shm + terminal spawned via psu; bad kickoff kind → 400 from the shared allowlist. (4) Deleted `buildEngineerOmpLaunchCommand` + `shellSafeOmpModel`/`shellSafePromptPath`/`kickoffSpecToCtx` + the `ConsoleMode`/`KickoffSpec` types + omp-only `ConsoleEnvelope` fields from `console-launcher.ts`; deleted the `envelope.mode==='omp'` branch + `buildOmpOneliner` + omp imports + omp body-params from the `console-launch` route; deduped the kickoff-kind allowlist into shared `@/lib/agent-kickoff/kickoff-kind`. Net −405 lines; ONE launch implementation for every agent; shell-console path untouched. 77 tests green. Commits: part 1 `deb1ff36e`+`0e31b43d6`, part 2 `a8d4bdbf1`. blocked-by:P-030

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
