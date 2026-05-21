# SU agent file-lock enforcement

The cooperative `locks:*` MCP surface (universal across host CLIs)
becomes **enforced** by the host's tool-call hook: before every
`write` / `edit` / `ast_edit`, the hook calls `coord:locks:acquire`
and blocks the tool call if the path is held by another SU agent.

## OMP

`omp/coord-hook.ts` is the OMP extension that owns enforcement. It
combines four handlers in one module (per
agent-coordination-architecture-v2 §12.1):

| Event           | Purpose                                                |
|-----------------|--------------------------------------------------------|
| `session_start` | Probe operator (attached / detached), declare presence |
| `turn_start`    | Inject the held-locks / inbox / changed-plans reminder |
| `turn_end`      | Persist watermark pointers                             |
| `tool_call`     | Acquire file lock; block on busy (file-locking #2)     |
| `tool_result`   | Release the acquired lock by `toolCallId`              |

`install-standalone-mcp.sh` symlinks the extension into
`~/.omp/agent/extensions/` so OMP discovers it on next session start.

The `tool_call` handler is **fail-open**: if the operator is
unreachable the edit is allowed (cooperative discipline only works
when the system is up; blocking edits would wedge the agent). See the
console.error message and file-locking #3 for the persistent marker
the operator UI reads to surface "enforcement is offline."

## Other host CLIs

Not supported. The project is OMP-only (`claude-code` / Codex / Gemini
were dropped — see `project_claude_code_unsupported`). The shell
PreToolUse/PostToolUse hook scripts that previously lived next to
this README were deleted in file-locking #2.

## Adding a new host CLI

If a future host CLI ships, port `omp/coord-hook.ts` to its hook API.
The MCP call shape is identical; only event-subscription wiring and
event-payload field names need adapting.
