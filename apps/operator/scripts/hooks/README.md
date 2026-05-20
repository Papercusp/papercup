# SU agent file-lock enforcement hooks

These shell scripts turn the cooperative `locks:*` MCP surface into
**enforced** coordination at the host-CLI layer. Without them, an SU
agent has to remember to call `locks:acquire` before every edit. With
them, the host CLI refuses contested edits automatically.

The cooperative surface is universal across all host CLIs; enforcement
is per-CLI. Coverage:

| Host CLI    | Status | Hook file |
|-------------|--------|-----------|
| Claude Code | ✅ shipped | `pretooluse-locks-acquire.sh` + `posttooluse-locks-release.sh` |
| OMP         | 🚧 TODO    | needs OMP-hook spec; see below |
| Codex CLI   | 🚧 TODO    | needs Codex-hook spec; patches welcome |
| Gemini CLI  | 🚧 TODO    | needs Gemini-hook spec; patches welcome |

**Important:** until every host CLI an engineer might use has a hook,
the system is best-effort. Cooperative discipline (the playbook tells
agents to call `locks:acquire` themselves) closes the gap when a hook
isn't installed.

## Claude Code

`install-standalone-mcp.sh` writes a `hooks` block into
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/pretooluse-locks-acquire.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/posttooluse-locks-release.sh" }
        ]
      }
    ]
  }
}
```

### Flow

1. Agent triggers `Edit { file_path }`.
2. **PreToolUse** runs the hook script with the tool input on stdin.
3. The script extracts `file_path`, computes the repo-relative path
   (if under `~/papercupai-workspace/papercup/`), and calls
   `locks:acquire { paths, intent, ttl_sec: 1200 }` via HTTP MCP.
4. On success: writes `lock_id` to
   `~/.papercusp/locks-cache/<tool_use_id>.lock` and exits 0 (allows
   the edit).
5. On busy: exit 2 with a stderr message listing the holders' intents
   and expiry. Claude Code surfaces stderr to the agent; the agent
   re-plans.
6. **PostToolUse** reads the cached `lock_id`, calls `locks:release`,
   deletes the cache file. Exits 0 always.

### Failure modes

- **Operator unreachable** → hook allows the edit (cooperative
  discipline takes over). Better to allow than wedge.
- **Repo-outside path** → hook no-ops. `~/.bashrc` and similar aren't
  workspace-locked.
- **`tool_use_id` missing in PostToolUse** → no-op. TTL covers any
  missed release.

### Trying it locally

After running `install-standalone-mcp.sh`:

```bash
# In one Claude Code session, hold a lock manually:
$ claude
> Use locks:acquire to claim apps/operator/lib/foo.ts for 60s

# In a second session, try to edit the same file:
$ claude
> Read apps/operator/lib/foo.ts then change the export name

# The second session's first Edit attempt should be refused by the hook
# with a stderr message naming the first session as the holder.
```

## OMP / Codex / Gemini

As of 2026-05-14, none of these host CLIs ship a registered-config-file
hook surface equivalent to Claude Code's `PreToolUse`/`PostToolUse`.
What they have is closer:

### OMP

`@oh-my-pi/pi-coding-agent`'s `ClientBridge` interface exposes a
`requestPermission(toolCall, options, signal)` callback that fires
**before any tool execution that requires permission** — but it's
invoked through the agent's TUI permission flow, not registered via
a config file the way Claude Code hooks are. Wiring a permission
handler from outside OMP requires patching the bridge at
runtime, which is too invasive for an out-of-process install script.

**OMP coverage today:** cooperative discipline only. The injected
`papercusp-su.tools.md` block in `~/.omp/agent/CLAUDE.md` tells the
agent to call `locks:acquire` itself before any edit. Adherence
depends on the model following the playbook.

### Codex CLI / Gemini CLI

No equivalent native hook surface that we've found. Same posture as
OMP — cooperative discipline via the injected playbook block.

### What would change this

A worthwhile follow-up is to land a real hook entry-point upstream in
OMP (one that loads from `~/.omp/agent/hooks.json` or similar). With
that, the existing `pretooluse-locks-acquire.sh` script works as-is —
the script logic is universal, only the registration mechanism is
CLI-specific. Until then: cooperative.

## Manual smoke

The hook scripts themselves don't require the CLI — they just read
stdin and POST to the operator. You can exercise the Pre hook by
piping mock input:

```bash
# Should succeed (acquires the lock):
echo '{"tool_name":"Edit","tool_input":{"file_path":"/home/marsh-office/papercupai-workspace/papercup/some/file.ts"},"tool_use_id":"test-1"}' \
  | bash ./pretooluse-locks-acquire.sh
echo "exit code: $?"

# Inspect the cache:
cat ~/.papercusp/locks-cache/test-1.lock

# Release:
echo '{"tool_use_id":"test-1"}' | bash ./posttooluse-locks-release.sh
echo "exit code: $?"

# Cache should be gone:
ls ~/.papercusp/locks-cache/test-1.lock 2>&1
```

A second invocation of the Pre hook on the same file before releasing
should exit non-zero with a busy message on stderr.
