---
title: "@papercusp/omp — power-user agent bundle"
slug: omp-power-user-bundle-2026-05-20
status: in-progress
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
---

# @papercusp/omp — power-user agent bundle

Give advanced Papercusp users the same engineer-collaborator agent
experience the Papercusp engineers themselves have — without shipping
a UI for it. Users with [OMP](../../../../reference_oh_my_pi.md) installed
can click **Launch terminal** in the main navbar and get an OMP agent
session that is workspace-scoped, user-scoped, and pre-seeded with
the current Papercusp persona + tools playbook + tool catalog.

## Now

P-001 through P-004 implemented and verified against a live operator
dev server (2026-05-20). Remaining before this is `shipped`:

- Land the file-locking plan's L1/L2/L3 OMP hook into
  `apps/operator/scripts/hooks/omp/` so the bundle's `hooks[]` is
  non-empty (§4.3.1, D-008).
- Audience-neutral rewrite of `papercusp-su.tools.md` (D-008b, locks
  plan owner).
- Rebuild the desktop operator sidecar so the new routes + navbar
  button go live in the packaged app (dev server already serves them).
- Open questions still parked: none blocking — Q-B1/Q-E1/Q-F1 were
  decided with the plan defaults at implementation time.

### Verified 2026-05-20 (operator `next dev`)

- `POST /api/agent-tokens/power-user` issues access + refresh tokens.
- `POST .../refresh` mints a new access token; an access token used
  as a refresh token is rejected 401 (type confusion).
- `GET /api/agent-bundle` returns the live `papercusp-su.tools.md`
  (18 KB), origin-derived `mcp_url`, workspace + user; 401 without a
  token.
- `POST /api/mcp?power_user=1` `tools/list` returns the operator-tier
  catalog with a valid token, `[]` with a garbage token.
- `POST /api/agent-mcp/console/launch {mode:'omp'}` returns
  `omp_not_installed` with the install command when `papercusp-omp`
  is absent.
- `power-user-token` unit suite: 8/8 pass. Full operator typecheck
  clean. `@papercusp/omp` builds + CLI smoke-tests.

## 1. Problem

There are three categories of Papercusp user:

1. **End users in the desktop app.** Interact only via the chat UI,
   the harness panel, and approval prompts. Don't see MCP at all.
2. **Engineers building Papercusp** (currently: marsh-office).
   Run `omp` against `localhost:3070/api/mcp?superuser=1` with
   admin-tier access across every workspace, seeded by a
   hand-installed playbook. OMP is the one sanctioned agent runtime
   — engineers who want a Claude, GPT, or Gemini *model* select it
   within OMP (`omp --model …`), not a separate agent CLI.
3. **Advanced power users.** Today: nothing. They are end users with
   no escape hatch into the agent surface, even though they are
   capable of managing their own terminal, their own `omp` install,
   and their own machine config.

The middle tier is configured via `install-standalone-mcp.sh`, which:

- Writes a bearer token to `~/.papercusp/superuser-token`.
- Edits a global agent-config file on the user's machine to inject
  the `papercusp-su` playbook block.
- Wires `papercusp-su` into the user's MCP client config.

That flow is correct for engineers — it is wrong for end users:

- It edits global files on the user's machine.
- It grants superuser-across-all-workspaces, not "power-user-in-one".
- It is a hand-run install script, not a one-click affordance.
- It has no "which workspace / acting as which user" affordance —
  superuser doesn't need one; a power-user agent does.

We want a third tier — **workspace power-user** — packaged as an OMP
plugin, launched from a button the user already has in the navbar.

## 2. Goals

- A user with `omp` installed can click **Launch terminal** in the
  Papercusp navbar and end up in an OMP session whose agent has:
  - the current Papercusp persona + tools playbook as system prompt
  - the full Papercusp MCP tool catalog scoped to one workspace
  - identity = the logged-in user (audit trail intact)
  - the user's own machine setup (their shell, dotfiles, editor) —
    Papercusp does not install or own the terminal
- Prompts and tool catalog stay in sync with the running Papercusp
  instance — when the engineers edit `papercusp-su.tools.md`, the
  next power-user session sees the change without re-installing.
- A user **without** `omp` installed sees a one-line install hint
  and the same launch command, copy-pasteable.
- No global file edits on the user's machine. No global
  agent-config rewrites. No bearer token sitting in plaintext on
  disk forever.

## 3. Non-goals

- Spawning, embedding, or otherwise hosting a terminal inside the
  Papercusp UI. The button hands off to the user's existing terminal.
  (Earlier exploration of `gnome-terminal` embedding via WRY/TAO/VTE
  rejected — see end of doc.)
- Building a Papercusp-branded fork of `omp`. We ship a plugin,
  not a runtime.
- Distributing prompts via npm. Prompts live in this repo; the
  plugin fetches them at session start.
- Supporting any agent runtime other than OMP. OMP is the single
  sanctioned runtime for the power-user path — permanently, not
  just v1. A user who wants a Claude, GPT, or Gemini *model* selects
  it inside OMP (`omp --model …`); Papercusp does not integrate any
  other agent CLI.
- A new persona. The power-user agent uses the existing
  `papercusp-su.persona.md` + `papercusp-su.tools.md` as-is. Future
  divergence (a `power-user.tools.md`) is a separate plan.

## 4. Shape of the solution

Four pieces, each independently reviewable:

### 4.1 New auth tier: `workspace-power-user`

Today the endpoint-system has two effective tiers:

- **role-gated** — every tool checks `asRole` against the user's
  workspace role; quotas apply.
- **superuser** — `?superuser=1` + loopback + valid bearer in
  `~/.papercusp/superuser-token` bypasses role and quota gates.
  Cross-workspace.

We add a third:

- **workspace-power-user** — `?power_user=1` + valid scoped token,
  passed as `Authorization: Bearer <token>`, **never in the URL**
  (URLs leak to logs and process lists). Access tokens carry
  `{workspace_id, user_id, auth_session_id, exp}`. The dispatcher
  clamps every tool call to `workspace_id` and treats the agent
  as `user_id` for audit. Tool catalog is identical to operator-tier
  (the same surface the engineer sees today via
  `agent_tools:list { asRole: 'operator' }`). Quotas apply per
  the workspace's normal limits.

**Naming note — two different "session" concepts.** The token claim
`auth_session_id` (this plan) is **not** the same as
`Mcp-Session-Id` (the MCP transport header). `auth_session_id` is
the lifetime of one OMP power-user session (hours to a day);
`Mcp-Session-Id` is the lifetime of one MCP transport handshake
(seconds to minutes). Coordination plans relying on identity
(`agent-coordination-architecture-2026-05-20.md` §11.2)
should map `token.user_id` → `AgentIdentity.userId` and treat
`auth_session_id` as the long-lived identifier.

**Two-token issuance — OAuth-style.** A new HTTP route
`POST /api/agent-tokens/power-user`, authenticated by the existing
operator session cookie, returns:

- `access_token` — HMAC-signed, short TTL (default **1h**), carries
  `{workspace_id, user_id, auth_session_id, exp}`. Plugin sends
  this in `Authorization: Bearer` on every MCP call.
- `refresh_token` — HMAC-signed, long TTL (default **24h**),
  carries `{auth_session_id, exp}`. Plugin uses this to mint new
  access tokens via `POST /api/agent-tokens/power-user/refresh`
  (no operator cookie needed — the refresh token itself is the
  credential).

**Revocation surface.** A new `power_user_sessions` table holds
one row per active session (`auth_session_id`, `workspace_id`,
`user_id`, `created_at`, `last_seen_at`, `revoked_at`). Refresh
requests join against it; a row missing or `revoked_at IS NOT NULL`
→ refresh fails. Access tokens remain valid until their (short)
TTL expires; refresh-token deletion stops the chain at the next
refresh cycle. **Revocation latency: worst-case = access-token TTL
(1h).** Instant revocation would require per-call session lookup,
which defeats the stateless-access-token win; accepted tradeoff.

**Refresh-token rotation deferred to v2.** Standard OAuth practice
issues a new refresh token on every refresh, invalidating the old.
v1 keeps the refresh token reusable for the full 24h TTL. Threat
model: single-user desktop, refresh token in plugin memory only
(never on disk — see §4.3 step 2), session ends on OMP exit. A
24h replay window in this model is acceptable; rotation can be
added later without protocol change.

No plaintext-on-disk forever like the superuser token; tokens live
only in the plugin's process memory for the duration of the OMP
session.

**Scope risk — workspace clamp is not a 5-line change.** Many tools
in the catalog accept an explicit `workspace` argument today
(superuser fan-out depends on this). Server-side clamp requires a
sweep of the ~96-tool catalog: either every tool reads workspace
from `ctx` and ignores any `workspace` arg, or the dispatcher
rewrites/rejects mismatched args before tool entry. Pick one
discipline and audit the whole catalog. Plan for ~1 day of careful
work, not 5 lines. P-001 ships only after the audit.

Files touched:

- `apps/operator/lib/endpoint-system/auth.ts` (or wherever
  `?superuser=1` is gated — verify path during implementation).
- `apps/operator/app/api/agent-tokens/power-user/route.ts` (new,
  issue) + `/refresh/route.ts` (new, refresh).
- `apps/operator/lib/endpoint-system/dispatcher.ts` — workspace
  clamp + acting-as user.
- `apps/operator/lib/agent-tools/**/*.ts` — catalog audit
  for any tool reading `workspace` from args rather than `ctx`.
- New DB migration: `power_user_sessions` table.

Q-A1 resolved by the OAuth-style two-token shape above: session
revocation is "delete the row in `power_user_sessions`." A
dedicated admin UI listing active sessions is a v2 polish item,
deferred.

### 4.2 `/api/agent-bundle` — the prompts + tool manifest

A new HTTP route the OMP plugin fetches on connect:

```
GET /api/agent-bundle?workspace=<id>
  Headers: Authorization: Bearer <power-user-token>
  Response: {
    persona:    "<contents of papercusp-su.persona.md>",
    toolsmd:    "<contents of papercusp-su.tools.md, audience-rewritten>",
    skills:     [<skill bundle, see below>],
    hooks:      [<hook bundle, see §4.3.1>],
    mcp_url:    "<derived from request origin>/api/mcp?power_user=1",
    workspace:  { id, name, slug },
    user:       { id, email, displayName },
    expires_at: <iso8601 — same as token>
  }
```

The bundle reads directly from `apps/operator/prompts/` at request
time — no caching layer; this stays under 100KB and is called once
per session.

**`mcp_url` is derived, not hardcoded.** Use the request `origin`
the same way `buildConsoleEnvelope` (`apps/operator/lib/console-launcher.ts`)
already does for the superuser console envelope. The dev box has
both `:3070` (public sidecar) and `:3055` (loopback-only sidecar)
live at the same time; the bundle must serve whichever origin the
caller hit. Token is always passed by the plugin in
`Authorization: Bearer`, never appended to the URL.

**Packaging pre-req.** In dev, prompts live at
`apps/operator/prompts/`. In a packaged desktop build, the operator
ships as a sidecar (`/usr/lib/Papercusp/sidecar/apps/operator/.next/...`
in the .deb layout — see `deb-verify/` for the canonical packaged
shape). Two options:

1. Read prompts via a runtime-resolved path
   (`path.join(process.cwd(), 'prompts', ...)`) and confirm
   `process.cwd()` lines up with the sidecar layout.
2. Bundle prompts into the route's compiled output via Next's
   `import` + a static `.md` loader.

Pick one before P-002 lands; option 1 is less ceremony but option 2
is more deploy-robust. Open question Q-F1 below.

**What goes in `skills[]`:**

- Skills that are *Papercusp-shaped*: how-to docs for the tool
  surface, named workflows from `tools.md`, cross-tool patterns.
  Concretely: any skill whose subject matter is the Papercusp tool
  catalog itself.
- **NOT** machine-specific skills like `restart-stack`,
  `harness-paperclip`, or anything that references a path on the
  engineer's machine. Those stay in the engineer's personal memory
  and don't belong in a user-distributed bundle.

Concrete source for v1: a new directory
`apps/operator/prompts/power-user-skills/` containing markdown
skill files, each with frontmatter `{ name, description }`. Empty
on day one — we add skills as we observe what power users actually
need.

Files touched:

- `apps/operator/app/api/agent-bundle/route.ts` (new).
- `apps/operator/prompts/power-user-skills/` (new, empty dir +
  README explaining what goes here).

Open question Q-B1: should the bundle include a curated subset of
`agent-insights/`? Default = no; insights are engineer-facing and
reference repo paths.

### 4.3 The OMP plugin: `@papercusp/omp`

A standalone npm package (lives in this monorepo as a new
workspace, e.g. `packages/omp-plugin/`). Implements the
**`@oh-my-pi/pi-coding-agent` HookAPI** — specifically
`registerCommand` — installed at
`/home/marsh-office/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/`.
Concretely we use `extensibility/hooks/`, `extensibility/skills.ts`,
and `extensibility/custom-commands/` as the integration surface.
Q-C1 thereby resolved.

Exposes one OMP command:

```
omp papercusp connect --url=<bundle-url> --token=<token>
```

**Runtime-dir resolution (cross-platform).** The plugin uses a
small `runtimeDir()` helper, *not* a hardcoded `$XDG_RUNTIME_DIR`:

| Platform | Path                                                           | Cleanup model               |
| -------- | -------------------------------------------------------------- | --------------------------- |
| Linux    | `$XDG_RUNTIME_DIR/papercusp-omp/<auth_session_id>/`            | Tmpfs auto-clear on logout  |
| macOS    | `~/Library/Application Support/Papercusp/runtime/<auth_session_id>/` (mode 0700) | None — explicit cleanup-on-exit required |
| Windows  | `%LOCALAPPDATA%\Papercusp\runtime\<auth_session_id>\`          | None — explicit cleanup-on-exit required |

Explicit cleanup-on-exit is the **primary** mechanism on every
platform (see step 4). Linux tmpfs auto-clear is a safety net, not
a substitute for explicit cleanup.

Behavior:

1. **Token intake — never via argv.** The plugin reads the access
   token + refresh token from the environment variables
   `PAPERCUSP_BUNDLE_ACCESS_TOKEN` and
   `PAPERCUSP_BUNDLE_REFRESH_TOKEN` (set by Tauri's
   `Command::new(...).envs(...)` — see §4.4). Argv leaks to `ps`,
   shell history, and kernel audit; D-006 forbids it. Env is
   visible to the same user via `/proc/<pid>/environ` but not in
   `ps`, which is the acceptable middle. Fallback for non-Tauri
   callers: `--token-file=<path>` pointing at a 0600 file in
   `runtimeDir()`. **Refresh token stays in plugin process memory
   only**; it is never written to the MCP config, never written to
   a file, never re-read from env after startup. If the plugin
   process dies, the user re-launches from the navbar — a new
   session, by design.
2. `GET <bundle-url>` with `Authorization: Bearer <access_token>`.
   Parse the response.
3. Write a session-scoped OMP profile to `runtimeDir()`:
   - system prompt = `bundle.persona + "\n\n" + bundle.toolsmd`
   - MCP config = `bundle.mcp_url`, **access token only** in
     `Authorization` header config (an MCP-client config file
     with `headers.Authorization`). Refresh token does **not**
     touch disk.
   - skills = `bundle.skills` written to the scratch dir,
     not the user's global skills tree (no pollution)
   - hooks = `bundle.hooks` written to the scratch dir, registered
     via OMP's `--hook=<path>` explicit flag (no auto-discovery
     install ceremony) — see §4.3.1
4. **Spawn OMP as a child and stay attached for its lifetime.**
   The `connect` command does *not* exec-and-detach; it
   `Command::new("omp").spawn()`s OMP and waits on its exit.
   This bounds scratch-dir lifetime to the actual session.
5. On OMP exit: explicit recursive cleanup of the scratch dir,
   then exit. On every platform — Linux tmpfs auto-clear is a
   belt-and-suspenders defense, not the load-bearing mechanism.
6. **Token refresh during the session.** A background timer in the
   plugin refreshes the access token ~5 minutes before its TTL via
   `POST /api/agent-tokens/power-user/refresh` with
   `Authorization: Bearer <refresh_token>` (held in plugin memory
   only). The new access token is rewritten into the MCP-client
   config; OMP's MCP client picks it up on the next request
   (or via SIGHUP / config-reload — TBD by OMP's behavior). No
   browser cookie involved.
7. **Sleep/wake recovery.** If the laptop sleeps across the refresh
   window and the timer fires late, the first MCP call after wake
   may use an expired access token → 401. The plugin's MCP client
   wrapper catches 401, triggers an immediate refresh, and retries
   the original request **once**. A second 401 after refresh is a
   real auth failure and bubbles to the user. Standard OAuth client
   behavior.

The plugin is **stateless across sessions** — every `connect`
re-fetches the bundle. Drift impossible.

Files touched:

- `packages/omp-plugin/package.json` (new)
- `packages/omp-plugin/src/connect.ts` (new)
- `packages/omp-plugin/src/profile-writer.ts` (new)
- `packages/omp-plugin/README.md` (new)

### 4.3.1 Hooks in the bundle

The plan's hook story coordinates with the file-locking plan
(`file-locking-improvements-2026-05-20.md`). The locks plan ships
a PreToolUse hook that auto-acquires file locks before Edit/Write
calls; today that hook installs **globally** into
`~/.omp/agent/hooks/` via `install-standalone-mcp.sh` (engineer
path).

Power users cannot run that install — D-007 below bars global file
edits for the power-user path. So the bundle delivers the hook
the same way it delivers prompts:

- Hook source-of-truth: `apps/operator/scripts/hooks/omp/<hook>.ts`
  (or `.js` — TBD by what OMP's hook loader accepts).
- `/api/agent-bundle` reads `apps/operator/scripts/hooks/omp/` at
  request time and emits `hooks: [{ name, source }]`.
- Plugin writes each hook to the session-scratch dir and passes
  `--hook=<path>` to OMP for each.
- Same drift-resistance as prompts.
- Same source file backs both install paths: the engineer install
  script copies the same file into `~/.omp/agent/hooks/`; the
  bundle serves the same file inline. Single source, two
  deliveries.

v1 hooks contents: the file-locking enforcement hook from the
locks plan, once it lands. v1 of *this* plan ships an empty
`hooks` array if the locks hook isn't ready yet — neither plan
blocks the other.

### 4.4 Navbar wiring — extend the **ConsoleLauncherButton**

The button exists today as `ConsoleLauncherButton`
(`apps/operator/app/_components/ConsoleLauncherButton.tsx`). It
already does most of what we need:

1. Reads the active harness slug from `usePathname()`.
2. Calls `launchNativeConsole({ slug })` (`apps/operator/lib/native-console.ts`),
   which POSTs `/api/agent-mcp/console/resolve`.
3. The resolve route invokes `buildConsoleEnvelope`
   (`apps/operator/lib/console-launcher.ts`), returning a `cwd`,
   `env`, and `.mcp.json` body that wires the spawned shell into
   the superuser MCP surface.
4. Tauri's `console_launch` command opens a native OS terminal
   with that envelope.

Q-D1 thereby resolved — we extend rather than replace.

**New behavior — a `mode` switch on the envelope:**

- `POST /api/agent-mcp/console/resolve` body gains
  `{ slug?: string | null, mode?: 'shell' | 'omp' }`. Default
  `'shell'` preserves today's behavior exactly. The engineer's
  current `+` click is unaffected.
- When `mode: 'omp'`:
  - The route additionally calls `POST /api/agent-tokens/power-user`
    internally and returns:
    ```
    {
      cwd, env, mcp_json,              // existing
      launch_command: "omp",            // bare command, no args
      launch_args: ["papercusp", "connect", "--url", "<bundle_url>"],
      launch_env: {
        PAPERCUSP_BUNDLE_ACCESS_TOKEN: "<access_token>",
        PAPERCUSP_BUNDLE_REFRESH_TOKEN: "<refresh_token>",
      },
    }
    ```
    Tokens travel in `launch_env`, never in `launch_args`. D-006
    enforced at the envelope layer.
  - Tauri's `console_launch` runs `Command::new(launch_command).args(launch_args).envs(launch_env)`,
    in the same harness `cwd`.
- Tauri side gains an `omp_available()` command (`which omp`)
  used by the renderer to pick the mode and/or surface the
  install-hint modal.

**UI affordance — Q-G1 below.** Options:

- A sibling button next to the existing `+` ("Launch agent" with
  a robot/agent glyph). Visible affordance, honest about the
  choice, accessible without right-click gymnastics on Mac
  touchpads.
- Right-click the existing button → menu: "Open shell" vs
  "Open OMP agent."
- Shift-click for OMP, plain click for shell.

Default: **sibling button.** Discoverability wins over chrome
parsimony for a power-user feature most users won't expect to
exist behind a context menu. Right-click menu can be added as a
nicety on either button later.

If `omp` is **not** installed when the user picks `mode: 'omp'`:
open a modal with the install command (`npm i -g @oh-my-pi/cli @papercusp/omp`)
and a "Retry" button that re-runs the `omp_available()` probe.

Files touched:

- `apps/operator/app/_components/ConsoleLauncherButton.tsx`
  (context menu / shift-click handling, modal trigger).
- `apps/operator/lib/native-console.ts`
  (pass `mode` through).
- `apps/operator/app/api/agent-mcp/console/resolve/route.ts`
  (accept `mode`).
- `apps/operator/lib/console-launcher.ts`
  (`buildConsoleEnvelope` branches on `mode`, calls token route
  internally when `omp`).
- `papercusp-desktop/src-tauri/src/console_launch.rs`
  (run `launch_command` when present; new `omp_available` command).
- New `OmpInstallHintModal` component, sibling to
  `ConsoleLauncherButton`.

## 5. Order of work

Ship in the order auth → bundle → plugin → button. Each is
independently testable.

- **P-001**: Auth tier `workspace-power-user` + token route.
  Tested via curl from loopback: issue token, hit
  `/api/mcp?power_user=1&workspace=X` with it, confirm a
  cross-workspace tool call gets clamped.
- **P-002**: `/api/agent-bundle` route + `prompts/power-user-skills/`
  scaffold. Tested via curl: bundle returns persona + toolsmd from
  the live file, not a cache.
- **P-003**: `@papercusp/omp` plugin. Tested by `omp papercusp connect`
  against a local Papercusp; agent answers a question that requires
  reading the playbook (e.g. "what's the workspace clamp rule?").
- **P-004**: Navbar button repurpose + Tauri `omp_available()`.
  Tested by clicking it in the live desktop app, with and without
  `omp` on `$PATH`.

## 6. Decisions

- **D-001** Distribute prompts via live HTTP fetch, not via npm
  bundling. *Why:* keeps prompts versioned with the code they
  describe; same model as `docs:outline`. *Tradeoff accepted:* OMP
  agent requires Papercusp to be running.
- **D-002** Plugin name = `@papercusp/omp` (user instruction
  2026-05-20). Standard scoped-package convention: publisher
  (`@papercusp`) first, package (`omp`) second.
- **D-003** Extend `ConsoleLauncherButton` + the `console/resolve`
  envelope with a `mode` field, rather than building a parallel
  launch path. *Why:* the existing button already wires Tauri →
  envelope → native terminal with `.mcp.json`; we add a branch
  on `mode`. Engineer's current click stays untouched.
- **D-004** Power-user tier is workspace-scoped, not cross-workspace.
  *Why:* cross-workspace admin belongs to the engineer install path,
  not end users; reduces blast radius. *Caveat:* see §4.1 scope
  risk — the clamp requires a catalog-wide audit, not a 5-line patch.
- **D-005** OMP is the only sanctioned agent runtime for the
  power-user path — permanently, not just v1. *Why:* one runtime to
  build, test, and support. OMP already multiplexes model providers,
  so a user who wants a Claude / GPT / Gemini model gets it via
  `omp --model …`; Papercusp does not wire up any other agent CLI.
- **D-006** Tokens never travel in URLs **or argv**. MCP calls use
  `Authorization: Bearer` headers. Plugin-launch tokens pass via
  process env (`Command::new(...).envs(...)`) — visible to the
  same user via `/proc/<pid>/environ` but not in `ps`, shell
  history, or kernel audit. Argv-fallback (`--token-file=`) points
  at a 0600 file in `runtimeDir()`, never the token literal.
  *Why:* URLs and argv both leak to logs, process tables, audit
  trails. Same risk class; same rule. Plugin enforces on the
  client side; server side ignores any `?token=` query param.
- **D-009** Refresh token lives in plugin process memory only.
  Never written to disk, never re-read from env after startup,
  never sent to OMP. *Why:* the access token is on disk inside
  the MCP-client config (it has to be — OMP reads it); keeping
  the refresh token off-disk means a stolen scratch dir cannot
  mint new tokens. Plugin crash → user re-launches from navbar.
- **D-010** `runtimeDir()` is per-OS, not `$XDG_RUNTIME_DIR`-only.
  *Why:* Papercusp ships on macOS and Windows via Tauri, neither
  of which has XDG. Cleanup-on-exit is the primary mechanism on
  every platform; Linux tmpfs auto-clear is a safety net only.
- **D-011** Token claims use `auth_session_id`, not `session_id`,
  to disambiguate from `Mcp-Session-Id`. *Why:* the MCP transport
  already has its own session concept with a different lifetime
  (transport handshake vs OMP session). Naming collisions in
  coordination plans become confusing fast; pay the typing cost
  once.
- **D-007** No global file edits on user machines from the
  power-user path. Hooks, skills, prompts, MCP config all live in
  a session-scratch dir cleaned up on exit. *Why:* end users
  haven't consented to having global agent-config files or
  `~/.omp/agent/` rewritten by a button click.
- **D-008** Cross-plan coordination with
  `file-locking-improvements-2026-05-20.md`:
  - **(a)** Hook source-of-truth lives in
    `apps/operator/scripts/hooks/omp/`. Engineer install copies it
    to `~/.omp/agent/hooks/`; bundle serves the same file inline.
    Single source, two deliveries.
  - **(b)** `papercusp-su.tools.md` PreToolUse-hook paragraph gets
    audience-rewritten — describe the lock contract without naming
    the install path. Either plan can absorb that edit; tracked
    once in both. **Owner: locks plan author (more familiar with
    the lock contract language).**
  - **(c)** Locks schema's `workspace_id` field renames to
    `coordination_domain` to avoid collision with Papercusp's
    workspace concept now that workspaces are first-class at the
    agent layer. **Owner: locks plan author** (their schema; this
    plan only references it).

## 7. Items deferred / not in v1

- Auto-install of `@papercusp/omp` from the button. v1 shows the
  command; v2 can shell out to `npm i -g`.
- Power-user persona divergence from `papercusp-su.persona.md`.
  Same prompt for now.
- Skills curation beyond an empty `power-user-skills/` directory.
- Multi-workspace OMP sessions (one session, multiple clamped
  scopes). Out of scope; users open one session per workspace.
- Token revocation admin UI (Q-A1).

## 8. Open questions

### Resolved during plan review

- **Q-A1** *(resolved)* OAuth-style two-token shape (§4.1) +
  `power_user_sessions` table = real session-bound revocation,
  minimal server state. Admin UI listing active sessions deferred
  to v2.
- **Q-C1** *(resolved)* OMP plugin contract =
  `@oh-my-pi/pi-coding-agent/src/extensibility/HookAPI`,
  specifically `registerCommand` for the `omp papercusp connect`
  command, plus `extensibility/hooks/` and `extensibility/skills.ts`
  for the bundle's hook + skill delivery.
- **Q-D1** *(resolved)* The button today is
  `ConsoleLauncherButton`, already opens a native terminal with
  a `.mcp.json` envelope. Extend with a `mode` field — see §4.4.
- **Q-G1** *(resolved)* Default = sibling button ("Launch agent")
  next to the existing `+`. Visible affordance over hidden
  context menu. Right-click can be added as a nicety later.

### Still open (for user)

- **Q-B1** Should the bundle include any `agent-insights/` content?
  Default proposal: no.
- **Q-E1** Token TTL defaults. Proposing **1h access / 24h refresh**
  with silent refresh ~5 min before access expiry. Reasonable?
- **Q-F1** Packaging strategy for serving prompts from the route:
  runtime-path resolution (`process.cwd()` + relative) or compile-time
  bundling via static `.md` import? Default proposal: runtime-path,
  verified against the `deb-verify/` sidecar layout before P-002.

## 9. Coordination with adjacent plans

### 9.1 File-locking plan (`file-locking-improvements-2026-05-20.md`)

Resolutions agreed in plan review:

- **Hook delivery for power users** — bundle delivers hooks into
  session-scratch + `--hook=<path>` flag. Locks plan keeps its
  engineer install route (`~/.omp/agent/hooks/`) but adds a §4.X
  noting the bundle delivery path. Single source file backs both.
- **Playbook audience neutrality** — `papercusp-su.tools.md`'s
  PreToolUse-hook paragraph describes one specific install path.
  It gets rewritten audience-neutral (describe the lock contract,
  not the install path) so power users on OMP aren't told about a
  hook they don't have. Edit lives in the locks plan.
- **`workspace_id` → `coordination_domain` rename in locks schema**
  — avoids terminology collision with Papercusp's workspace
  concept now that workspaces are first-class at the agent layer.
  Locks plan's call; this plan only depends on the rename being
  cosmetic (no functional change to lock semantics).

### 9.2 Agent coordination architecture (`agent-coordination-architecture-2026-05-20.md`)

The coordination plan introduces a three-layer model (L1 identity
+ presence, L2 file-lock enforcement, L3 turn-start context
injection). This plan's bundle surface dovetails cleanly:

- **L1 identity mapping** — power-user access tokens carry
  `{workspace_id, user_id, auth_session_id, exp}`. The coordination
  plan's L1 `AgentIdentity.userId` should map directly from
  `token.user_id`; `AgentIdentity.sessionId` from
  `token.auth_session_id`. Map at hook entry via the env-injected
  token, not from any side channel.
- **L1/L2/L3 hook bundling** — §4.3.1's `hooks[]` bundle field is
  the delivery channel for **all three handlers**, not just L2's
  file-lock enforcement. Per the coordination plan, the OMP hook
  is one module exporting `tool_call` (L2), `session_start` (L1
  presence), and `turn_start` (L3 context injection). The bundle
  ships that one module; OMP wires all three handlers via
  `--hook=<path>`.
- **Source-of-truth path** — confirmed
  `apps/operator/scripts/hooks/omp/<hook>.ts` from D-008, used by
  both engineer install and bundle delivery.

Neither plan blocks the other. The seams meet by construction.

## 10. Rejected alternatives

- **Embed a terminal in the Papercusp UI.** Considered three forms:
  xterm.js + Rust PTY, reuse code-server's terminal, ttyd/wetty
  sidecar. Even more ambitious: drop the webview entirely and
  embed VTE via TAO + GTK. All rejected — power users already
  manage their own terminals; building one duplicates work and
  doesn't add capability.
- **Bundle prompts into the npm plugin.** Rejected per D-001;
  drift is the killer.
- **Reuse the superuser auth tier with workspace clamp at the
  client.** Rejected — clamp must be server-side or it's not a
  security boundary. Power users shouldn't be able to remove
  `?workspace=X` from the URL and get cross-workspace admin.
- **A Papercusp-branded fork of OMP.** Rejected — too much surface
  area; we want OMP-the-runtime to do the runtime work and our
  plugin to do the Papercusp-specific seeding.
