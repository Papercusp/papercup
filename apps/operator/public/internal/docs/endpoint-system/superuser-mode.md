# Superuser mode
URL: /internal/docs/endpoint-system/superuser-mode

Give an OMP shell launched outside Papercusp full access to MCP tools across every workspace and harness, with a single token.

import { Aside } from '@astrojs/starlight/components';

## What this is

A way to point any `omp`, `claude`, or `codex` shell — running in any
directory, on any of your workspaces — at Papercusp's MCP server. Plugin
tools (Repomix, GitNexus, Firecrawl, Phase 9 spawn primitive, …) and
built-ins (intel:*, artifacts:*, …) all become available. The agent
picks the workspace per call.

This is the opposite of the orchestrator's per-spawn URL: instead of
locking the agent into one (workspace, harness, role, run, spawn), the
agent gets superuser access and chooses workspace per tool invocation.

Loopback alone can't tell a user-shell agent apart from a
papercusp-spawned agent — both run on the same machine, same user,
same loopback. Superuser requires a bearer token from
`~/.papercusp/superuser-token` (mode 0600). A spawned agent that wants
to escalate its gates can `cat` the token file. Same way it can
`rm -rf` your home directory.

Superuser is for *honest* user shells, not for *enforced* isolation.
For real isolation, run shell-omp under a different OS user with file
ACLs that prevent the orchestrator user from reading the token.

(The orchestrator-spawned path has a separate envelope — see
[Spawn-URL signing](/internal/docs/endpoint-system/spawn-signing). Forging a
worker URL into operator-tier fails the HMAC verifier; pasting the
superuser token into your own shell does not, by design.)

## One-time setup

```bash
$ apps/operator/scripts/install-standalone-mcp.sh
✓ Wrote ~/.papercusp/superuser-token (mode 0600)
✓ Wrote ~/.omp/agent/mcp.json (mode 0600)
✓ Endpoint responded 200
```

The script:

1. Generates a 32-byte random token
2. Writes it to `~/.papercusp/superuser-token` (mode 0600, owned by you)
3. Registers the `papercusp-su` MCP server for OMP
   (`~/.omp/agent/mcp.json`) and Claude Code (`~/.claude.json`), each
   with the operator URL + `Authorization: Bearer <token>`
4. Installs the per-client playbooks and the `omp-su` / `claude-su` /
   `codex-su` wrappers (see [below](#per-client-wrappers-and-playbooks))
5. Verifies the operator is running and accepts the token

Re-run any time to rotate the token (or refresh the playbooks/wrappers).
The operator picks up the new token without restart (file mtime triggers
cache refresh). Add `--profile=power` for the power-engineer subset.

## Per-client wrappers and playbooks

The MCP registration above makes the SU tools *available*; a second,
opt-in layer injects the **engineer-collaborator playbook** so a shell
knows how to use them. The installer creates one wrapper per supported
client. Plain `omp` / `claude` / `codex` stay vanilla — only the `-su`
wrappers load the playbook.

| Wrapper     | Launches                              | Playbook injection                                                          |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `omp-su`    | OMP + the coordination extension      | `--append-system-prompt ~/.papercusp/<profile>-collaborator.md`             |
| `claude-su` | Claude Code                           | `--append-system-prompt-file ~/.papercusp/<profile>-collaborator.claude.md` |
| `codex-su`  | Codex CLI in a dedicated `CODEX_HOME` | `~/.papercusp/codex-su-home/AGENTS.md`                                      |

**One base, per-client overlays.** The shared base playbook
(`prompts/papercusp-su-<profile>.tools.md`) carries all client-neutral
guidance. The client-specific task/workflow tooling — which differs by
client (OMP `todo_write` / `omp:sessions`; Claude Code `TodoWrite` /
`Task`; Codex `update_plan`) — lives in a small overlay
(`papercusp-su.{omp,claude,codex}.md`) that is spliced into the base at a
`<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->` marker at install time.
This keeps one source of truth for the base and prevents, e.g., OMP-only
"don't use the Claude task tools" guidance from landing in the Claude or
Codex playbook.

**Codex is special.** Codex has no `--append-system-prompt`; it injects
instructions through `AGENTS.md` within its `CODEX_HOME`. So `codex-su`
runs Codex in a dedicated `CODEX_HOME` (`~/.papercusp/codex-su-home`)
whose `AGENTS.md` *is* the playbook, sharing your real login via a
symlinked `auth.json`. The `papercusp-su` server is registered only in
that home, with the bearer token supplied at launch from the 0600 token
file via `PAPERCUSP_SU_TOKEN` — so plain `codex` never sees the server,
and the token is never written into config.

Re-run `install-standalone-mcp.sh` (optionally `--profile=power`) any
time to refresh every wrapper and playbook.

## How the request flows

```
omp shell anywhere on the box
  └─ reads ~/.omp/agent/mcp.json
  └─ POST http://localhost:3070/api/mcp?superuser=1
       Authorization: Bearer <token>
       Accept: application/json, text/event-stream

operator
  └─ /api/mcp route detects ?superuser=1
  └─ checks: loopback origin + bearer matches superuser-token file
  └─ on failure: tool-shaped error from tools/call (`request_rejected: superuser_invalid_bearer`).
  │  (initialize + tools/list remain open per MCP spec; the gate fires at dispatch.)
  └─ on success: builds spawn ctx { isSuperuser: true,
                                    workspaceId: '*',
                                    role: 'operator', ... }

projected-tool dispatcher
  └─ ctx.isSuperuser === true → bypass role allowlist
  └─ ctx.isSuperuser === true → bypass quota window
  └─ capability gate still runs when a principal is attached
  └─ tool runs
  └─ tool_invocations row recorded with role='operator',
     run_id='standalone', spawn_id='ephemeral-<hex>',
     window_key='superuser'
```

## Workspace switching

The endpoint URL is workspace-agnostic. Tools that need a workspace
take a `workspace` argument; the dispatcher uses `args.workspace ??
ctx.workspaceId`, and `ctx.workspaceId` defaults to `'*'` in superuser
mode.

To discover what workspaces exist:

```typescript
papercusp:list_workspaces()
// → { workspaces: [
//      { slug: "default", harnesses: ["sheets","papercup-org"], lastActiveTs: 1778... },
//      { slug: "scratch", harnesses: [], lastActiveTs: 1778... }
//    ],
//    defaultWorkspace: "default" }
```

Then any subsequent call:

```typescript
intel.spawn_tree({ harness: "sheets", workspace: "default", limit: 50 })
orchestrator.spawn({ workspace: "default", harness: "sheets",
                     role: "worker", featureId: "F-FILL-001",
                     chunkId: "C-1" })
```

Tools that don't care about workspace (`repomix.pack`,
`fetch_plus.fetch_clean`, `firecrawl.scrape`, `gitnexus.list_repos`)
ignore the missing `workspace` arg — they're path-driven or URL-driven.

## What's NOT bypassed

These still apply to superuser:

1. **Per-tool input validation** — invalid args still return
   `invalid_input` 400.
2. **Per-tool timeout** — long-running tools still get killed at the
   tool's `timeoutSec`.
3. **Workspace requirement on first-party tools.** Most first-party
   tools (`harness:*`, `tasks:*`, `messages:*`, …) need a concrete
   workspace to open a PG transaction. Pass `?superuser=1&workspace=<slug>`
   in the URL — the default `workspaceId='*'` doesn't satisfy them and
   you'll get `handler_error: built-in tool "..." requires authenticated
   request (bearer + workspace tx)`.

What **is** bypassed: role allowlist, capability gate (the dispatcher's
`isSuperuser` short-circuits in both), per-window quota, and the
spawn-URL signature check (superuser has its own bearer envelope).

## Troubleshooting

| Symptom                          | Cause                                                               | Fix                                                                            |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `unauthorized` 401               | Token mismatch or token file missing                                | Re-run `install-standalone-mcp.sh`                                             |
| `unknown_tool` 404               | Plugin didn't load                                                  | `curl /api/plugins/host/refresh` to see load errors                            |
| `workspace required` from a tool | Tool needs a real workspace; `*` doesn't work for it                | Pass `workspace: "default"` (or other slug from `list_workspaces`) explicitly  |
| `invalid_request_context`        | URL had `?superuser=1` but bearer was missing/wrong (MCP transport) | Check `Authorization: Bearer <token>` header is set in `~/.omp/agent/mcp.json` |

## Telemetry

Every superuser tool call writes a `harness_shared.tool_invocations`
row with:

* `role = "operator"`
* `run_id = "standalone"`
* `spawn_id = "ephemeral-<random hex>"`
* `window_key = "superuser"`

Filter the Intel panel's Spawns sub-tab by `runId="standalone"` to see
just superuser activity.

## Revoking access

```bash
$ rm ~/.papercusp/superuser-token
```

The next call returns `unauthorized` 401. To rotate without revoking,
re-run `install-standalone-mcp.sh`.
