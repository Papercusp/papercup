# Terminal wrappers + psu
URL: /internal/docs/agent-spawning/terminal-wrappers

The *-su engineer-collaborator wrappers and the psu plan-tracked launcher.

Papercusp installs two kinds of terminal entry point for launching a CLI
agent in **engineer-collaborator mode** (the full `papercusp-su` tool
catalog + playbook): the per-agent **`*-su` wrappers** (direct), and the
**`psu`** command (a picker that records a tracked `/adv` session).

Both are installed by `apps/operator/scripts/install-standalone-mcp.sh`
(or the desktop's per-harness install). Plain `omp` / `claude` / `codex`
stay vanilla — engineer mode is opt-in.

## The `*-su` wrappers — direct

| Wrapper     | Launches | Playbook injection                                       | Skip-permissions                             |
| ----------- | -------- | -------------------------------------------------------- | -------------------------------------------- |
| `omp-su`    | `omp`    | `--append-system-prompt` + `-e` coord extension          | `--approval-mode yolo`                       |
| `claude-su` | `claude` | `--append-system-prompt-file`                            | `--dangerously-skip-permissions`             |
| `codex-su`  | `codex`  | dedicated `CODEX_HOME` whose `AGENTS.md` is the playbook | `--dangerously-bypass-approvals-and-sandbox` |

Each opts into the engineer playbook + the `papercusp-su` MCP server and
pre-bypasses tool approvals. They run wherever you launch them and are
**not** tracked — use them for a quick ad-hoc SU shell.

Codex is the odd one out: it has no `--append-system-prompt` flag, so
`codex-su` runs Codex in a dedicated `CODEX_HOME` (`~/.papercusp/codex-su-home`)
whose `AGENTS.md` is the playbook and whose `config.toml` scopes the
`papercusp-su` MCP server to that home (bearer read from `PAPERCUSP_SU_TOKEN`
at launch). Plain `codex` (`CODEX_HOME=~/.codex`) is unaffected.

## `psu` — the plan-tracked launcher

`psu` is one command that **picks an agent + workspace + harness + plan**,
records a tracked session row, then `exec`s the matching `*-su` wrapper.
The session shows up in the **`/adv` Sessions** tab — under its plan, or
under the **"No plan"** group for ad-hoc sessions — labelled with its agent
kind and resumable like any other session.

```bash
psu          # interactive: pick agent → workspace → harness → plan (or "NO PLAN")
```

Harnesses are **workspace-scoped**, so the picker asks for the workspace
before the harness. When there's only one workspace it's chosen
automatically (no prompt).

### Preselecting with flags

You can preselect any of agent / workspace / harness / plan on the command
line and the picker will **only prompt for what you omit**:

```bash
psu --agent=claude                      # preset the backend; pick workspace/harness/plan
psu --agent=omp --workspace=my-ws       # preset both; pick harness/plan
psu --agent=codex --harness=papercup --no-plan   # everything preset → no prompts
```

Flags: `--agent=<claude|omp|codex>`, `--workspace=<id>`, `--harness=<slug>`,
`--plan=<slug>`, `--no-plan`. Whatever you leave off is still picked
interactively.

Under the hood `psu` calls `POST /api/agent-mcp/console/bootstrap-su`,
which creates the `adv_sessions` row (with `agent` + `plan_slug`, or a
null `plan_slug` for "No plan") and returns the cwd + tracking env; `psu`
then `exec`s the chosen `*-su` wrapper in the harness directory. The
wrapper still supplies the playbook + skip-permissions + MCP — `psu` only
adds the picker and the tracking.

### Scripting escape

Skip the prompts for shell scripts / CI:

```bash
psu --no-picker --agent=claude --harness=papercup --plan=my-plan-slug
psu --no-picker --agent=omp --workspace=my-ws --harness=papercup --no-plan
psu --no-picker --agent=codex --no-plan          # active workspace root, no harness
```

`--agent` is required (`claude` | `omp` | `codex`); `--workspace` defaults
to the active workspace; `--harness` defaults to the workspace root if
omitted; pass `--no-plan` for an ad-hoc session or `--plan=<slug>` to bind
one.

### Resuming

The agents scope their resumable sessions **by working directory**. A
harness launch runs in the harness repo, so resume the agent's session
(e.g. `claude --resume <id>`) **from that repo dir**. A no-harness launch
runs in the directory you invoked `psu` from (not an internal dir), so its
resume works from that same terminal. `psu` prints the launch `cwd` so you
know where to resume from. (Or resume from the `/adv` Sessions tab, which
already knows the cwd.)

`psu --resume` is the location-independent path: it lists your recent
tracked sessions, `cd`s to each one's recorded cwd, and resumes the agent
there — so you don't have to be in the launch dir.

## Role sessions — `psu --role`

By default `psu` launches an **engineer-collaborator (`su`)** session: the
full `papercusp-su` catalog + the engineer playbook. With `--role` you
instead launch the session **as a pipeline role** (worker, validator,
reviewer, debugger, documenter, architect, scoper, …) — the same persona,
tools, and feature context the orchestrator gives that role, but **you**
drive it interactively. It's "wear the worker's hat on F-042 and drive it
by hand" — for debugging why a role keeps failing, hand-finishing a
feature, or sanity-checking what a role can see.

```bash
psu --role=worker                 # picker: role → backend → workspace → harness → feature
psu --role=worker --feature=F-042 --harness=papercup --agent=claude   # scripted
```

What's different from a plain `su` session:

* **Role prompt, not the engineer playbook** — `<role>.persona.md` +
  `<role>.tools.md`, assembled by the same `assembleRolePrompt` the
  orchestrator and the in-app brains use.
* **Role-scoped tools** — the session's MCP config is a *signed,
  role-scoped* URL (`role=<role>`, not `?superuser=1`), so the dispatch
  layer enforces exactly that role's tool allowlist — true parity with an
  orchestrator-spawned agent.
* **Feature context** — feature-consuming roles (worker/validator/…)
  prompt for a feature; the picker knows which roles need one from the
  role registry's `consumes` field (`roleConsumes`), the single source for
  "what context does this role need."

The session is tracked in `/adv` Sessions like any other, tagged with its
role + feature. Backends: `claude` and `omp` today; `codex` interactive
role sessions are not yet wired (use `claude`/`omp`).

This is distinct from the orchestrator firing a role **autonomously**
(headless, output-parsed, scheduled) — that always routes through
`orchestrator.spawn`, never a terminal `psu`.

## Install

```bash
bash apps/operator/scripts/install-standalone-mcp.sh
```

This mints the superuser token, merges `papercusp-su` into each client's
MCP config, writes the playbook + the three `*-su` wrappers, and installs
`psu` (a shim that `exec`s the in-repo launcher so it resolves
`@inquirer/prompts` from the operator's `node_modules`). Re-run to refresh;
to revoke, delete the listed files (the installer prints them).

## How tracking flows

```
psu  ──pick──▶  bootstrap-su  ──records──▶  adv_sessions row (agent, plan_slug|null)
  │                                              │
  └──exec──▶  <agent>-su wrapper                 └──▶ /adv Sessions (live, ~3s refresh)
                (playbook + MCP + skip-perms)          under plan / "No plan" group
```

The `*-su` wrappers used directly are **not** tracked (no row); only `psu`
launches appear in `/adv`.
