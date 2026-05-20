---
title: "@papercusp/omp power-user bundle — end-to-end brief"
slug: omp-power-user-bundle-brief-2026-05-20
status: shipped
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
---

# @papercusp/omp power-user bundle — end-to-end brief

How the shipped power-user feature works, written for the agent
building the multi-agent coordination system
(`agent-coordination-architecture-2026-05-20.md`). The design
rationale is in `omp-power-user-bundle-2026-05-20.md`; this is the
operational reality — identifiers, lifecycle, and the integration
seam.

**TL;DR for coordination:** every power-user OMP session is one
"agent". It is identified by a stable `auth_session_id`, clamped to
exactly one workspace, has a row in `harness_shared.power_user_sessions`
for its whole life, and runs whatever hook modules live in
`apps/operator/scripts/hooks/omp/`. That hook directory is your
integration point — drop the L1/L2/L3 coordination hook there and it
auto-delivers to every power-user session.

## 1. What it is

A power user clicks **Launch agent** in the Papercusp navbar and gets
an [OMP](https://omp.sh) terminal session that is:

- **workspace-scoped** — clamped to one workspace, server-side;
- **user-scoped** — runs as the logged-in user, audit trail intact;
- **pre-seeded** — the Papercusp engineer playbook as system prompt,
  the full operator-tier MCP tool catalog, quota-enforced.

It is the third auth tier. The other two: `role-gated` (orchestrator
spawns) and `superuser` (the engineers, `?superuser=1`). Power-user is
`?power_user=1`.

## 2. End-to-end flow

```
[navbar] AgentLauncherButton
   │ POST /api/agent-mcp/console/launch {mode:'omp'}
   ▼
[operator] buildConsoleEnvelope({mode:'omp'})
   │  • createPowerUserSession()  → INSERT power_user_sessions row,
   │                                mints auth_session_id = "pus-<uuid>"
   │  • mintAccessToken()         → HMAC token, 1h TTL
   │  • mintRefreshToken()        → HMAC token, 24h TTL
   │  envelope = { cwd, env(non-secret), secretEnv(tokens),
   │               launchCommand: "papercusp-omp connect" }
   ▼
[operator] spawns a native terminal:
   gnome-terminal -- bash -lc 'cd <cwd> && export <non-secret env> &&
                               exec papercusp-omp connect'
   tokens ride the spawn env option, never the argv (D-006)
   ▼
[papercusp-omp connect]  (the @papercusp/omp npm bin)
   │  • reads PAPERCUSP_BUNDLE_* from env
   │  • GET /api/agent-bundle  (Authorization: Bearer <access>)
   │      → { persona, toolsmd, skills[], hooks[], mcp_url,
   │          workspace, user, expires_at }
   │  • writes session-scratch dir (per-OS runtime dir):
   │      system-prompt.md, .mcp.json, skills/, hooks/
   │  • places .mcp.json in the OMP project dir (backs up existing)
   │  • background timer: refresh access token ~5 min before expiry
   ▼
[omp]  spawned as a child, stays attached:
   omp --append-system-prompt <scratch>/system-prompt.md
       --hook <scratch>/hooks/<each hook>
   ▼
[omp agent] makes MCP calls to mcp_url =
   <origin>/api/mcp?power_user=1   (Authorization: Bearer <access>)
   ▼
on omp exit → restore .mcp.json, delete scratch dir, end session
```

The launch path is **server-side spawn** — the operator process spawns
the terminal. The Tauri `console_launch` IPC is a dead fallback (broken
webkit2gtk). Linux-only today.

## 3. Identifiers — the part coordination depends on

| id | shape | lifetime | where |
| -- | ----- | -------- | ----- |
| `auth_session_id` | `pus-<uuid>` | one OMP session (hours–1 day) | token claim; `power_user_sessions` PK; `PAPERCUSP_AUTH_SESSION_ID` env; `ctx.uiClientId` |
| `workspace_id` | e.g. `default` | — | token claim; clamps every tool call |
| `user_id` | users-table uuid | — | token claim; `ctx` audit identity |
| `runId` | random uuid | **one MCP call** | `ctx.runId` — ephemeral, do NOT key on it |
| `spawnId` | `poweruser-<hex>` | one MCP call | `ctx.spawnId` — ephemeral |
| `Mcp-Session-Id` | transport uuid | one MCP transport handshake | HTTP header, set by `mcp-handler` |

**One OMP session = one agent.** Its identity is `auth_session_id`.
In a power-user MCP tool context (`UnifiedToolContext`):

- `ctx.uiClientId === auth_session_id` — **the stable per-agent id.**
- `ctx.workspaceId` — the clamped workspace.
- `ctx.runId` / `ctx.spawnId` — fresh **every call**; never use them
  to identify the agent or as a coordination window key.
- `ctx.isPowerUser === true`, `ctx.isSuperuser === true`.

**Two distinct "session" concepts** — do not conflate:

- `auth_session_id` — the OMP session / agent lifetime. This is what
  L1 `AgentIdentity` should key on.
- `Mcp-Session-Id` — the MCP transport handshake; much shorter-lived,
  irrelevant to coordination identity.

## 4. The MCP surface for a power-user agent

A power-user agent calls `POST <origin>/api/mcp?power_user=1` with
`Authorization: Bearer <access_token>`. In
`apps/operator/app/api/[transport]/route.ts`, `tryBuildSpawnContext`'s
`?power_user=1` branch:

- verifies the HMAC access token → `{workspaceId, userId, authSessionId}`;
- **clamps `workspaceId` to the token claim** — any `?workspace=` in
  the URL is ignored. A power-user agent cannot reach another
  workspace. (There is also a dispatcher-level clamp that overwrites
  any `workspace` *tool argument* with the token's workspace.)
- builds the ctx: `role='operator'`, `isSuperuser=true`,
  `isPowerUser=true`, `uiClientId=authSessionId`.

Dispatch behaviour (`packages/agent-mcp/src/dispatch-stack.ts`):

- **role-allowlist + capability** — bypassed (`isSuperuser`); the agent
  sees the full operator-tier catalog.
- **quota** — **enforced** (bypass is `isSuperuser && !isPowerUser`).
  The quota window is keyed on `power-user:<auth_session_id>` so it
  accrues across the whole session, not per call.

So: a power-user agent has the operator's tool surface, scoped to one
workspace, with the workspace's quotas applying to it.

## 5. The hook channel — your integration point

This is how coordination logic reaches power-user OMP sessions.

**Source of truth:** `apps/operator/scripts/hooks/omp/*.{ts,js,mjs}`
(directory exists with a contract `README.md`; currently empty).

**Delivery:**

1. `GET /api/agent-bundle` reads every file in that directory at
   request time and returns them inline in `hooks[]`
   (`[{ name, source }]`).
2. `papercusp-omp connect` writes each into the session-scratch dir
   (`<runtimeDir>/papercusp-omp/<auth_session_id>/hooks/`).
3. It launches `omp` with `--hook=<path>` for each — OMP's explicit
   hook-load flag. No global install, no `~/.omp` edit.

**Same source file, two delivery paths** (D-008a): the engineer
install script copies the same `scripts/hooks/omp/` files into
`~/.omp/agent/hooks/`; the bundle serves them inline. Write the hook
once, both the engineer (`?superuser=1`) and power-user
(`?power_user=1`) sessions get it.

Per the coordination plan, the hook is expected to be one module
exporting three handlers — `session_start` (L1 presence),
`tool_call` (L2 file-lock enforcement), `turn_start` (L3 context
injection). The hook runs inside the OMP process and can read the
session env, so it can self-identify:

- `PAPERCUSP_AUTH_SESSION_ID` — the agent id (also `--hook` modules
  can read it from `process.env`).
- `PAPERCUSP_BUNDLE_URL` — the operator origin, for calling back.

A hook that needs the workspace can get it from any MCP tool ctx, or
by decoding nothing — simplest is to have the operator surface it; for
now the agent's workspace is whatever the bundle's `workspace.id` was.

## 6. Session lifecycle & the presence table

`harness_shared.power_user_sessions` is the durable record of every
power-user agent. One row per session:

```
auth_session_id  TEXT PRIMARY KEY   -- the agent id
workspace_id     TEXT
user_id          TEXT
created_at       TIMESTAMPTZ
last_seen_at     TIMESTAMPTZ        -- bumped on every token refresh
revoked_at       TIMESTAMPTZ        -- NULL = active
```

- **Created** when `buildConsoleEnvelope({mode:'omp'})` runs (the
  Launch-agent click).
- **`last_seen_at`** is bumped by `getActivePowerUserSession()` — i.e.
  on every access-token refresh (~hourly). It is a coarse liveness
  signal, not a heartbeat.
- **Revoked** by stamping `revoked_at` (`revokePowerUserSession()`).
  A revoked session's refresh token stops working immediately; its
  current access token still works until its ≤1h TTL expires.
- There is **no explicit "session ended" write.** When `omp` exits,
  `papercusp-omp` cleans up the local scratch dir but does **not**
  delete or revoke the row. A row with an old `last_seen_at` and no
  `revoked_at` is a session that has almost certainly ended.

Helpers in `apps/operator/lib/power-user-sessions.ts`:
`createPowerUserSession`, `getActivePowerUserSession` (active-only,
bumps `last_seen_at`), `revokePowerUserSession`,
`listActivePowerUserSessions(workspaceId)`.

`listActivePowerUserSessions` is a ready-made "who's active in this
workspace" query for the coordination system — though treat its rows
as "not revoked" rather than "definitely live" (see the no-end-write
caveat above). If the coordination system needs true liveness, the
L1 `session_start` hook should register presence in its own table and
a `session_end`/process-exit signal should clear it.

## 7. What this means for multi-agent coordination

- **An agent == an OMP power-user session == one `auth_session_id`.**
  Key all coordination identity on `auth_session_id` (it surfaces as
  `ctx.uiClientId` in MCP tool calls and as `PAPERCUSP_AUTH_SESSION_ID`
  in the hook's process env).
- **Never key on `runId`/`spawnId`** — they are per-MCP-call for the
  power-user tier. (This is exactly why the quota window had to move
  to `auth_session_id`.)
- **Agents are workspace-partitioned.** A power-user agent physically
  cannot touch another workspace through MCP. Cross-workspace
  coordination must happen above the agent layer.
- **The filesystem is shared, the workspace is not.** Two power-user
  agents on the same machine in *different* workspaces still edit the
  same disk — file-lock coordination is per-machine, which is why the
  locks plan keys its domain on the machine, not the workspace
  (`coordination_domain`, D-008c).
- **Delivery is solved.** You do not need to build a channel to get a
  hook into power-user sessions — drop it in
  `apps/operator/scripts/hooks/omp/`. It reaches every new session
  (power-user via the bundle, engineer via the install script) with
  no per-agent setup.
- **The bundle is fetched live** — when you change the hook, the next
  `papercusp-omp connect` picks it up. No version pinning, no
  re-install. Already-running sessions keep the hook they launched
  with.

## 8. Key files

| concern | file |
| ------- | ---- |
| token mint/verify | `apps/operator/lib/power-user-token.ts` |
| session table CRUD | `apps/operator/lib/power-user-sessions.ts` |
| token routes | `apps/operator/app/api/agent-tokens/power-user/{route,refresh/route}.ts` |
| bundle route | `apps/operator/app/api/agent-bundle/route.ts` |
| `?power_user=1` MCP branch | `apps/operator/app/api/[transport]/route.ts` |
| quota gate / window key | `packages/agent-mcp/src/dispatch-stack.ts`, `dispatch-types.ts` |
| launch envelope | `apps/operator/lib/console-launcher.ts` |
| launch route | `apps/operator/app/api/agent-mcp/console/launch/route.ts` |
| navbar button | `apps/operator/app/_components/AgentLauncherButton.tsx` |
| the npm plugin | `packages/omp-plugin/` (`@papercusp/omp`) |
| hook directory | `apps/operator/scripts/hooks/omp/` |
| regression tests | `apps/operator/__tests__/integration/power-user-e2e.mjs`, `apps/operator/lib/power-user-token.test.ts` |
