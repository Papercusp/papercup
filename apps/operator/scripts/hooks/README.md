# SU-agent hooks — cross-CLI (Claude / Codex / OMP)

The cooperative `locks:*` + `coord:*` + `activity:*` MCP surfaces are
**universal** across the host CLIs; the host's tool-call hooks make them
**enforced / automatic**. There are two hook families, attached three ways:

| Family       | Lives in | Claude | Codex | OMP |
|--------------|----------|--------|-------|-----|
| Shell hooks  | `cc/`    | ✅ user `~/.claude/settings.json` | ✅ per-session `$CODEX_HOME/hooks.json` | — |
| In-process   | `omp/`   | — | — | ✅ `coord-hook.ts`, loaded via `-e` |

> **This README used to say "OMP-only; Claude/Codex/Gemini were dropped."
> That is wrong and was corrected** (papercusp-worker-integration-2026-06-04,
> D-009). The `cc/` shell scripts are **shared by Claude AND Codex** — both
> speak the same Pre/PostToolUse JSON-on-stdin → `hookSpecificOutput` wire
> contract, so one script pair serves both. Only the **attachment** differs
> per CLI (settings.json vs `$CODEX_HOME/hooks.json` vs OMP `-e`). Gemini is
> not a supported host CLI.

## `cc/` — the shared Claude+Codex shell hooks

JSON on stdin (`tool_name` / `tool_input` / `tool_use_id` / `session_id` /
`cwd`; the `apply_patch` / `Edit` / `Write` matcher aliases cover both CLIs'
edit tools), a `hookSpecificOutput` decision on stdout. All are **fail-open**
(a blip never blocks a tool) and **psu-scoped** (no-op unless `PAPERCUSP_SID`
+ the su-token are present).

| Script                                | Event        | Purpose |
|---------------------------------------|--------------|---------|
| `pretooluse-locks-acquire.sh`         | PreToolUse   | Acquire a file lock before an edit; block on busy (file-locking #2). |
| `posttooluse-locks-release.sh`        | PostToolUse  | Release the lock for that `tool_use_id`. |
| `posttooluse-coord-inbox.sh`          | PostToolUse  | Inject NEW `coord:inbox` messages mid-turn (SU only). |
| `posttooluse-activity-report.sh`      | PostToolUse  | **Activity bridge** — mirror every native tool call into `harness_shared.agent_activity` → the pui fleet view + curator (papercusp-worker-integration-2026-06-04). Fire-and-forget + detached, so it adds no latency. |
| `pretooluse-bash-resource-gate.sh`    | PreToolUse   | Refuse a destructive Bash command that collides with an EXCLUSIVE hold on a registered named resource. |

**Codex caveat (D-006):** Codex does **not** currently fire PreToolUse for
edits/Bash (upstream openai/codex #20204), so the *lock* PreToolUse is
config-ready-but-inert on Codex — lock coordination there is voluntary
(`locks:*` calls). Codex's **PostToolUse DOES fire**, so the coord-inbox +
activity-report hooks work on Codex. Claude fires both. Because Codex hands
hooks a **minimal env**, the Codex `hooks.json` **bakes** `PAPERCUSP_SID`
(+ `PAPERCUSP_AGENT=codex`) into the command; Claude reads them from the
inherited session env, so its `settings.json` entry is just the script path.

Installed to `~/.papercusp/hooks/cc/` by `install-standalone-mcp.sh`, which
also merges the Claude `settings.json` entries. The Codex entries are written
per-session by `role-codex-home.ts` (`writeCodexLockHooks`) into each
`$CODEX_HOME/hooks.json` (codex reads `hooks.json`, **not** `settings.json`).

## `omp/` — the OMP in-process port

`omp/coord-hook.ts` is the OMP extension owning the same surface in-process
(per agent-coordination-architecture-v2 §12.1). One module, five handlers:

| Event           | Purpose                                                          |
|-----------------|-----------------------------------------------------------------|
| `session_start` | Probe operator (attached / detached), declare presence          |
| `turn_start`    | Inject the held-locks / inbox / changed-plans reminder          |
| `turn_end`      | Persist watermark pointers                                      |
| `tool_call`     | Acquire file lock (block on busy) **+ report activity** (`activity:report`, the OMP leg of the bridge — reports at tool_call because the OMP `tool_result` event carries no input) |
| `tool_result`   | Release the acquired lock by `toolCallId`; poll the inbox delta |

`install-standalone-mcp.sh` installs it to `~/.papercusp/papercusp-coord.ts`
(it was moved out of `~/.omp/agent/extensions/` so it no longer auto-loads on
**every** `omp`); `psu` loads it via `-e` for both **su** and **role** omp
launches. The `tool_call` handler is **fail-open**: if the operator is
unreachable the edit is allowed (cooperative discipline only works when the
system is up). See `recordHookError` / file-locking #3 for the persistent
marker the operator UI reads to surface "enforcement is offline."

## Adding a new host CLI

Port `omp/coord-hook.ts` to its hook API (or, if it speaks the Claude
Pre/PostToolUse wire contract, reuse `cc/` + add an attachment path). The MCP
call shapes are identical; only the event-subscription wiring + the
attachment differ.
