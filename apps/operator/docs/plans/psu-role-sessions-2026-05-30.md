---
title: psu role sessions — interactive, role-scoped, one launch spec
slug: psu-role-sessions-2026-05-30
status: draft
created: 2026-05-30
updated: 2026-05-30
---

# psu role sessions — interactive, role-scoped, one launch spec

## Now

**State:** Plan drafted; design decisions locked with the user (role-scoped
tools via the signed per-spawn URL; `consumes` declared in the role
registry). Awaiting review before Phase 1.

**Next:** human confirms phase ordering, then Phase 1 (the `consumes` field
+ shared launch-spec builder extracted from `invoke()`).

## Background

`psu` today launches an **SU engineer** session: full `papercusp-su`
catalog, engineer playbook, interactive, no role/feature scoping. It
execs the `*-su` wrappers, whose MCP config points at the
`?superuser=1` endpoint — which **hardcodes `role: 'operator'` and
bypasses the role-allowlist** (`_mcp-handler.ts`). So an SU session is
inherently un-scopeable by role.

The pipeline roles (scoper/architect/worker/validator/reviewer/debugger/
documenter/curator/…) are launched by the orchestrator through a single
function: **`invoke(ctx, role, extras, options)`** (`orchestrator/src/invoke.ts`),
called both by the main loop and by the `orchestrator.spawn` MCP
primitive (`spawn-mcp.ts`). `invoke()` resolves `<role>.persona.md` +
`<role>.tools.md`, binds `FEATURE_ID` + the feature worktree as cwd, and
mints a **signed per-spawn MCP URL** (`signSpawnParams` →
`role=&harness=&workspace=&run=&spawn=&exp=&sig=`) that gets real
role-allowlist enforcement at dispatch.

The user wants `psu` to launch any role — an **interactive role
session**: same persona + tools + feature context the orchestrator
gives the role, but a human drives (no headless `-p`, no output
parsing). The keystone insight: a true role-scoped interactive session
is **the same launch spec `invoke()` builds, run interactively** — same
prompt, same signed URL, same role-allowlist. Only the execution differs
(interactive vs `omp -p` + parse).

This plan does NOT build the autonomous-spawn trigger (psu firing a
real headless `orchestrator.spawn`); that's a separate follow-up and
must route through `orchestrator.spawn`, never an external exec.

### Design constraints / decisions

- **D-001 — Role-scoped tools via the signed per-spawn URL.** A role
  session's `.mcp.json` points at a `signSpawnParams`-signed URL
  carrying `role=<role>` (NOT `?superuser=1`), so the agent gets
  exactly that role's allowlisted tools — literal parity with the
  orchestrator's agent. SU stays on the superuser URL (operator-tier).
- **D-002 — `consumes` declared in the role registry.** Add
  `consumes: { feature: 'required'|'optional'|'none'; plan:
  'optional'|'none' }` to `RoleManifest` + each `prompts/<role>.role.json`.
  Single source of truth for "what context does this role need"; psu,
  any UI, and the orchestrator read it. Replaces the implicit mapping
  in `invoke()`/loop logic.
- **D-003 — One shared launch-spec builder.** Extract
  `buildRoleLaunchSpec(ctx, role, extras)` from `invoke()` returning
  `{ promptFile, mcpUrl (signed), cwd, env, runId, spawnId }`. The
  orchestrator wraps it (headless exec + decision parse); psu wraps it
  (interactive exec + `adv_sessions` tracking). This is the unification
  — the same spec feeds the loop, `orchestrator.spawn`, and psu.
- **D-004 — psu picker is role-first.** `role → workspace → harness →
  (feature | plan | nothing per `consumes`) → backend`. Default role
  `su` keeps today's exact flow + endpoint (`bootstrap-su`). Real roles
  go through a new `bootstrap-role` path. All fields preselectable via
  flags (`--role`, `--feature`), same partial-preselect rule as today.
- **D-005 — SU and role launches stay distinct endpoints.**
  `bootstrap-su` (SU/engineer, superuser URL) is untouched;
  `bootstrap-role` (real role, signed URL, role prompt, feature) is
  new. Both record `adv_sessions` rows (now carrying `role` + `feature`).

## Phase 1 — Foundation (registry + shared spec)

P-001 todo Add `consumes` to `RoleManifest` (`apps/operator/lib/role-registry.ts`) + validation in `readBuiltinRoles`/`readPluginRolesFromDir`. Default `{ feature: 'none', plan: 'none' }` when absent (back-compat).
P-002 todo Declare `consumes` in each built-in `prompts/<role>.role.json` (worker/validator/reviewer/debugger/documenter → feature required; scoper/architect → plan optional; operator/oracle/curator → none). Verify against `invoke()` call-sites in `main-loop.ts` (which roles actually get `FEATURE_ID`).
P-003 todo Surface `consumes` on `roles:get` / `roles:list` so psu + UIs read it. blocked-by:P-001
P-004 todo Extract `buildRoleLaunchSpec(ctx, role, extras, opts)` from `invoke()` → `{ promptFile, mcpUrl, cwd, env, runId, spawnId, signed }`. Pure-ish (no exec). `invoke()` re-expressed on top of it (headless exec + parse retained). Unit-test parity: spec for `worker`+`FEATURE_ID=F` matches what `invoke()` used to build. blocked-by:P-001

## Phase 2 — psu interactive role sessions

P-010 todo `bootstrap-role` endpoint (`POST /api/agent-mcp/console/bootstrap-role { role, workspace, harness, feature?, plan? }`). Calls `buildRoleLaunchSpec`, writes the signed `.mcp.json` to the session cwd, records an `adv_sessions` row tagged `role`+`feature`, returns `{ sessionId, cwd, wrapperBin, mcpJsonPath, promptFile, envelopeEnv }`. Rejects when a `consumes.feature: required` role has no feature. blocked-by:P-004
P-011 todo `adv_sessions`: add `role` + `feature` columns (ALTER IF NOT EXISTS, `cwd`-precedent — no submodule migration). Thread through `adv-sessions.ts`. blocked-by:(none)
P-012 todo Role-aware `*-su`-style wrapper launch: the role session execs the agent CLI with `--append-system-prompt-file <role prompt>` (NOT the engineer playbook) and the per-session signed `.mcp.json`. Decide: reuse the `*-su` wrappers with a prompt-override env, or a thin per-launch invocation. blocked-by:P-010
P-013 todo psu `--role` (default `su`) + role-first picker driven by `roles:list` + `consumes`. Feature picker (new `?features` mode on the options endpoint, reusing `features:list`). Partial-preselect for `--role`/`--feature` like the existing flags. blocked-by:P-010,P-011
P-014 todo Options endpoint: add `?role=` (validate) + `?harness=&features=1` (feature list for feature-consuming roles). blocked-by:P-011
P-015 todo Manual e2e: `psu --role=worker` → pick harness → pick feature → claude/omp opens with the worker persona + worker-scoped tools (verify a non-worker tool is rejected) + FEATURE_ID set + tracked row in /adv tagged worker·F-NNN. blocked-by:P-012,P-013

## Phase 3 — surfacing + docs

P-020 todo /adv Sessions: show role + feature on rows (extends the existing agent-kind chip); group/filter by role. blocked-by:P-011
P-021 todo Docs: extend `agent-spawning/terminal-wrappers.mdx` with role sessions (picker flow, `consumes`, tool-scoping, the signed-URL parity note). blocked-by:P-015
P-022 todo Memory + playbook note: psu now launches role sessions; `consumes` is the role→context source of truth.

## Decisions

(D-001 … D-005 above, locked with the user 2026-05-30.)

### Deferred — autonomous spawn trigger

`psu --role=worker --feature=F --detach` firing a real headless
`orchestrator.spawn` (output parsed, scheduled, spawn-graph lineage) is
a natural follow-up once Phase 1's `buildRoleLaunchSpec` exists — but it
is OUT OF SCOPE here and MUST route through `orchestrator.spawn`, never
an external exec (bypasses scheduling + leaks runs, per agent-policies).
