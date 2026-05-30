#!/usr/bin/env bash
# install-standalone-mcp.sh — set up papercusp's superuser MCP endpoint
# for an OMP / Claude Code / Codex shell launched outside papercusp.
# (Gemini is NOT a supported client.)
#
# What this does:
#   1. Generates a 32-byte random token
#   2. Writes ~/.papercusp/superuser-token (mode 0600)
#   3. MERGES a `papercusp-su` server entry into ~/.omp/agent/mcp.json
#      AND ~/.claude.json (preserves any other MCP servers already
#      configured in either client).
#   4. Writes the engineer-collaborator playbook + coordination extension
#      as standalone OPT-IN files under ~/.papercusp/, and installs the
#      `omp-su`, `claude-su`, and `codex-su` wrappers that launch each
#      client with them. Plain `omp` / `claude` / `codex` are left
#      untouched — engineer-collaborator mode is no longer always-on.
#   4b. Installs the SU-locks ENFORCEMENT hooks so an edit to a file
#      another agent is holding is BLOCKED (not merely discouraged):
#        - OMP    → coord-hook.ts, loaded by omp-su via `-e`.
#        - Claude → Pre/PostToolUse hooks in ~/.claude/settings.json.
#        - Codex  → Pre/PostToolUse hooks in the codex-su CODEX_HOME.
#      Claude and Codex share one hook pair (same hook wire format).
#   5. Verifies HTTP 200 against the running operator
#
# Re-running REUSES the existing token (so live shells keep working),
# updates the MCP entry, and refreshes the playbook, the coordination
# extension, and the omp-su wrapper. To rotate the token deliberately,
# delete ~/.papercusp/superuser-token first, then re-run.
#
# Threat model: friction, not enforcement. Any process running as the
# same user can read ~/.papercusp/superuser-token. See
# /docs/endpoint-system/superuser-mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# Parse --profile=engineer|power (default: engineer).
# engineer — full Papercusp-engineer playbook (238 tools, all scopes).
# power    — power-engineer subset (generic Group B + Group C harness tools).
PROFILE="engineer"
for arg in "$@"; do
  case "$arg" in
    --profile=engineer) PROFILE="engineer" ;;
    --profile=power)    PROFILE="power" ;;
    --profile=*)
      echo "! Unknown profile '${arg#--profile=}'. Valid: engineer, power" >&2
      exit 1
      ;;
  esac
done

PROMPTS_DIR="${SCRIPT_DIR}/../prompts"
PLAYBOOK_PATH="${PROMPTS_DIR}/papercusp-su-${PROFILE}.tools.md"
# Per-client tooling overlays (profile-independent). The shared base
# playbook carries client-neutral guidance; each client's native
# task/workflow tooling (OMP vs Claude Code vs Codex) lives in its own
# overlay, spliced into the base at the CLIENT-TOOLING-OVERLAY marker by
# render_playbook below. This is what keeps OMP-only task-tool guidance
# out of the Claude/Codex playbooks.
OVERLAY_OMP="${PROMPTS_DIR}/papercusp-su.omp.md"
OVERLAY_CLAUDE="${PROMPTS_DIR}/papercusp-su.claude.md"
OVERLAY_CODEX="${PROMPTS_DIR}/papercusp-su.codex.md"

# Splice a client overlay into the base playbook at the marker. Falls
# back to appending if the marker is absent, or to base-only if the
# overlay file is missing. One source of truth for the shared base.
render_playbook() {
  python3 - "$1" "$2" "$3" <<'PYEOF'
import sys
base_path, overlay_path, dest_path = sys.argv[1], sys.argv[2], sys.argv[3]
marker = "<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->"
with open(base_path) as f:
    base = f.read()
try:
    with open(overlay_path) as f:
        overlay = f.read().rstrip("\n")
except FileNotFoundError:
    overlay = ""
out = base.replace(marker, overlay) if marker in base else base.rstrip("\n") + "\n\n" + overlay + "\n"
with open(dest_path, "w") as f:
    f.write(out)
PYEOF
}

# Workspace root = the parent of this checkout. All papercup worktrees
# (papercup, papercup-<topic>, …) are siblings under it; the lock hooks
# scope enforcement to this dir so a plain `claude`/`codex` editing an
# unrelated git repo never locks it into the shared store.
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# Shared Claude+Codex lock-enforcement hooks. Both clients implement the
# same hook wire format (PreToolUse/PostToolUse, settings.json,
# permissionDecision), so ONE script pair serves both. Installed to a
# stable runtime location (the repo copy isn't on the agents' radar).
CC_HOOK_SRC_DIR="${SCRIPT_DIR}/hooks/cc"
CC_HOOK_DEST_DIR="${HOME}/.papercusp/hooks/cc"
CC_PRE_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-locks-acquire.sh"
CC_POST_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-locks-release.sh"

# Merge our PreToolUse + PostToolUse lock hooks into a settings.json
# (Claude's ~/.claude/settings.json or a codex-su CODEX_HOME). Idempotent
# and non-destructive: removes any prior entry pointing at our two
# scripts (so re-runs don't duplicate), preserves every other user hook,
# then appends fresh entries with the given tool-name matcher.
#   $1 = settings.json path   $2 = matcher regex (e.g. "Edit|Write")
merge_lock_hooks() {
  python3 - "$1" "$2" "$CC_PRE_HOOK" "$CC_POST_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, matcher, pre, post, workspace_root = sys.argv[1:6]
try:
    with open(path) as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError
except FileNotFoundError:
    cfg = {}
except (json.JSONDecodeError, ValueError):
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

ours = {pre, post, os.path.basename(pre), os.path.basename(post)}

def is_ours(entry):
    for h in (entry.get('hooks') or []):
        cmd = h.get('command', '')
        if any(o in cmd for o in ours):
            return True
    return False

# Pass the workspace root through so the hook scopes correctly even on a
# non-default layout. Claude/Codex run hook commands through a shell, so
# an env prefix is honored.
pre_cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {pre}"
post_cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {post}"

hooks = cfg.setdefault('hooks', {})
for event, cmd in (('PreToolUse', pre_cmd), ('PostToolUse', post_cmd)):
    arr = [e for e in hooks.get(event, []) if not is_ours(e)]  # drop stale ours
    arr.append({'matcher': matcher,
                'hooks': [{'type': 'command', 'command': cmd}]})
    hooks[event] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# OMP looks for its MCP server config at ~/.omp/agent/mcp.json. The
# directory may not exist on a fresh OMP install — create it.
OMP_CONFIG_DIR="${HOME}/.omp/agent"
OMP_CONFIG_PATH="${OMP_CONFIG_DIR}/mcp.json"

mkdir -p "$(dirname "$TOKEN_PATH")"
mkdir -p "$OMP_CONFIG_DIR"

# 1+2. Superuser token. Reuse the existing token if one is already
# present — re-runs refresh the playbook / extension / wrapper and must
# NOT disrupt live shells by rotating their bearer. A fresh 32-byte
# token is minted only on first install. To rotate deliberately, delete
# the token file and re-run.
umask 077
if [ -s "$TOKEN_PATH" ]; then
  TOKEN="$(cat "$TOKEN_PATH")"
  echo "✓ Reusing existing superuser token from $TOKEN_PATH"
else
  TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32)
  printf '%s\n' "$TOKEN" > "$TOKEN_PATH"
  chmod 600 "$TOKEN_PATH"
  echo "✓ Minted $TOKEN_PATH (mode 0600)"
fi

# 2b. Stable agent_id (UUID) for SU-locks coordination.
# Generated ONCE per machine+user, baked into the MCP URL as the
# `?client=` param. NOTE: this is a per-machine FALLBACK identity only.
# The lock system prefers a per-SESSION id — the MCP transport's
# Mcp-Session-Id header for cooperative calls, and Claude Code's
# session_id for hook calls — so two shells on one machine get
# distinct lock owners. This baked id is used only when no per-session
# id is available. Re-runs of the install script preserve it.
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
if [ ! -s "$AGENT_ID_PATH" ]; then
  if command -v uuidgen >/dev/null 2>&1; then
    AGENT_ID="$(uuidgen | tr 'A-Z' 'a-z')"
  else
    AGENT_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  fi
  printf '%s\n' "$AGENT_ID" > "$AGENT_ID_PATH"
  chmod 600 "$AGENT_ID_PATH"
  echo "✓ Minted $AGENT_ID_PATH (mode 0600)"
else
  AGENT_ID="$(cat "$AGENT_ID_PATH")"
  echo "✓ Reusing existing agent_id from $AGENT_ID_PATH"
fi

# 3. Merge `papercusp-su` into the existing OMP MCP config.
# We use python because jq is not guaranteed and the merge needs to be
# idempotent (re-runs just rotate the token, don't duplicate the entry).
python3 - "$OMP_CONFIG_PATH" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$PROFILE" <<'PYEOF'
import json, os, sys
path, operator_url, token, agent_id, profile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except json.JSONDecodeError:
    print(f'! existing {path} is invalid JSON; backing up and starting fresh', file=sys.stderr)
    os.rename(path, path + '.bak.' + str(int(__import__('time').time())))
    cfg = {}

cfg.setdefault('mcpServers', {})
# Preserve any user-configured Hindsight MCP server. OMP-native Hindsight is
# enabled through `omp config set memory.backend hindsight` below; standalone
# Hindsight MCP entries are no longer stripped by the Papercusp installer.
# `?client=<agent_id>` surfaces as ctx.uiClientId in tool handlers so
# locks:* can identify ownership without per-call args.
profile_param = '&profile=power' if profile == 'power' else ''
cfg['mcpServers']['papercusp-su'] = {
    'type': 'http',
    'url': operator_url + '/api/mcp?superuser=1' + profile_param + '&client=' + agent_id,
    'headers': {
        'Authorization': 'Bearer ' + token,
    },
}
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
chmod 600 "$OMP_CONFIG_PATH"
echo "✓ Merged 'papercusp-su' into $OMP_CONFIG_PATH (mode 0600)"

# 3a. Merge the same `papercusp-su` entry into Claude Code's config.
# Claude Code reads ~/.claude.json (per-user, global) for MCP servers
# in addition to per-project .mcp.json files. We only touch it if the
# file already exists — a missing ~/.claude.json means Claude Code has
# never been launched on this machine, and creating one would seed
# unrelated defaults the user didn't ask for. The merge preserves
# every other MCP server already registered.
CLAUDE_CONFIG_PATH="${HOME}/.claude.json"
if [ -f "$CLAUDE_CONFIG_PATH" ]; then
  python3 - "$CLAUDE_CONFIG_PATH" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$PROFILE" <<'PYEOF'
import json, os, sys, time
path, operator_url, token, agent_id, profile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
try:
    with open(path) as f:
        cfg = json.load(f)
except json.JSONDecodeError:
    print(f'! existing {path} is invalid JSON; backing up and starting fresh', file=sys.stderr)
    os.rename(path, path + '.bak.' + str(int(time.time())))
    cfg = {}

cfg.setdefault('mcpServers', {})
profile_param = '&profile=power' if profile == 'power' else ''
# Per-session identity: Claude Code expands ${VAR}/${VAR:-default} in the
# mcp url at launch. The claude-su wrapper exports a per-launch
# PAPERCUSP_SID, so each shell gets a DISTINCT ?client= (→ distinct coord
# /lock owner — fixes the same-machine collapse). Plain `claude` (no env)
# falls back to the static machine id → unchanged. NOTE: this ${...} form
# is written only here (Claude); OMP/Codex don't do url env-interpolation.
cfg['mcpServers']['papercusp-su'] = {
    'type': 'http',
    'url': operator_url + '/api/mcp?superuser=1' + profile_param + '&client=${PAPERCUSP_SID:-' + agent_id + '}',
    'headers': {
        'Authorization': 'Bearer ' + token,
    },
}
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
  chmod 600 "$CLAUDE_CONFIG_PATH"
  echo "✓ Merged 'papercusp-su' into $CLAUDE_CONFIG_PATH (mode 0600)"
else
  echo "· $CLAUDE_CONFIG_PATH not found — skipping Claude Code MCP merge (launch \`claude\` once then re-run to opt in)"
fi

# 3b. Enable OMP-native Hindsight memory. This is the first-class OMP
# memory backend: it exposes recall/retain/reflect tools and auto-retains
# session history every N turns. The server may be local Docker or Cloud;
# env lets a machine override the default without editing this script.
HINDSIGHT_URL="${PAPERCUSP_HINDSIGHT_API_URL:-${HINDSIGHT_API_URL:-http://localhost:8888}}"
set_omp_config() {
  local key="$1"
  local value="$2"
  if command -v omp >/dev/null 2>&1 && omp config set "$key" "$value" >/dev/null 2>&1; then
    echo "✓ OMP config $key=$value"
  else
    echo "! Could not set OMP config $key (is omp installed and healthy?)"
  fi
}
set_omp_config "memory.backend" "hindsight"
set_omp_config "hindsight.apiUrl" "$HINDSIGHT_URL"
set_omp_config "hindsight.scoping" "per-project-tagged"
set_omp_config "hindsight.autoRecall" "true"
set_omp_config "hindsight.autoRetain" "true"

# 4. Render the per-client playbooks as standalone OPT-IN files.
# The shared base playbook (papercusp-su-<profile>.tools.md) carries all
# client-neutral guidance; the client-specific task/workflow tooling
# (OMP vs Claude Code vs Codex) is spliced in from a small overlay so
# that, e.g., OMP's "don't use the Claude task tools" guidance never
# lands in the Claude or Codex playbook. These files are loaded only by
# the -su wrappers; plain `omp`/`claude`/`codex` never see them.
#
# Destinations:
#   omp    → ~/.papercusp/${PROFILE}-collaborator.md         (omp-su, step 4d)
#   claude → ~/.papercusp/${PROFILE}-collaborator.claude.md  (claude-su, step 4e)
#   codex  → ~/.papercusp/codex-su-home/AGENTS.md            (codex-su, step 4f)
PLAYBOOK_DEST="${HOME}/.papercusp/${PROFILE}-collaborator.md"
PLAYBOOK_DEST_CLAUDE="${HOME}/.papercusp/${PROFILE}-collaborator.claude.md"
if [ ! -f "$PLAYBOOK_PATH" ]; then
  echo "! Expected base playbook at $PLAYBOOK_PATH; skipping playbook install"
else
  for ov in "$OVERLAY_OMP" "$OVERLAY_CLAUDE" "$OVERLAY_CODEX"; do
    [ -f "$ov" ] || echo "! Missing client overlay $(basename "$ov") — that playbook falls back to base-only"
  done
  render_playbook "$PLAYBOOK_PATH" "$OVERLAY_OMP" "$PLAYBOOK_DEST"
  chmod 644 "$PLAYBOOK_DEST"
  echo "✓ Wrote ${PROFILE} OMP playbook to $PLAYBOOK_DEST"
  render_playbook "$PLAYBOOK_PATH" "$OVERLAY_CLAUDE" "$PLAYBOOK_DEST_CLAUDE"
  chmod 644 "$PLAYBOOK_DEST_CLAUDE"
  echo "✓ Wrote ${PROFILE} Claude Code playbook to $PLAYBOOK_DEST_CLAUDE"
fi

# 4a. Migration cleanup: strip the legacy always-on managed block from
# ~/.omp/agent/CLAUDE.md left by earlier versions of this script, so
# plain `omp` stops auto-loading the playbook. Idempotent — a no-op once
# the block is gone. Content outside the BEGIN/END markers is preserved.
LEGACY_CTX="${HOME}/.omp/agent/CLAUDE.md"
if [ -f "$LEGACY_CTX" ]; then
  STRIPPED="$(python3 - "$LEGACY_CTX" <<'PYEOF'
import re, sys
path = sys.argv[1]
begin = "<!-- BEGIN papercusp-su playbook (managed by install-standalone-mcp.sh) -->"
end = "<!-- END papercusp-su playbook -->"
with open(path) as f:
    text = f.read()
pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", re.DOTALL)
if pattern.search(text):
    with open(path, "w") as f:
        f.write(pattern.sub("", text).lstrip("\n"))
    print("stripped")
PYEOF
)"
  if [ "$STRIPPED" = "stripped" ]; then
    echo "✓ Removed legacy always-on playbook block from $LEGACY_CTX"
  fi
fi

# 4c. Install the coordination extension as a standalone OPT-IN file.
#
# OMP loads `pi.on(...)` factory modules via the extension runner and
# AUTO-DISCOVERS any `*.ts` under ~/.omp/agent/extensions/ — which made
# the coordination runtime (locks enforcement, turn-start injection)
# load on every `omp`. It now lives at ~/.papercusp/papercusp-coord.ts
# and is loaded only by the `omp-su` wrapper (step 4d) via `-e`. The
# legacy auto-discovered copy is removed so plain `omp` no longer picks
# it up.
COORD_EXT_SRC="${SCRIPT_DIR}/hooks/omp/coord-hook.ts"
COORD_EXT_DEST="${HOME}/.papercusp/papercusp-coord.ts"
LEGACY_EXT="${OMP_CONFIG_DIR}/extensions/papercusp-coord.ts"
if [ -f "$COORD_EXT_SRC" ]; then
  cp "$COORD_EXT_SRC" "$COORD_EXT_DEST"
  chmod 644 "$COORD_EXT_DEST"
  echo "✓ Installed coordination extension to $COORD_EXT_DEST"
else
  echo "! Expected coord extension at $COORD_EXT_SRC; skipping (coordination inactive in omp-su)"
fi
if [ -f "$LEGACY_EXT" ]; then
  rm -f "$LEGACY_EXT"
  echo "✓ Removed legacy auto-discovered extension at $LEGACY_EXT"
fi

# 4c-bis. Install the shared Claude+Codex lock-enforcement hooks to a
# stable runtime location. settings.json (Claude in step 4e, Codex in
# step 4f) references these absolute paths. The OMP equivalent is the
# coord extension above (loaded via `-e`); Claude/Codex use these.
if [ -f "${CC_HOOK_SRC_DIR}/pretooluse-locks-acquire.sh" ]; then
  mkdir -p "$CC_HOOK_DEST_DIR"
  cp "${CC_HOOK_SRC_DIR}/pretooluse-locks-acquire.sh" "$CC_PRE_HOOK"
  cp "${CC_HOOK_SRC_DIR}/posttooluse-locks-release.sh" "$CC_POST_HOOK"
  chmod 755 "$CC_PRE_HOOK" "$CC_POST_HOOK"
  echo "✓ Installed Claude/Codex lock hooks to $CC_HOOK_DEST_DIR"
else
  echo "! Expected CC lock hooks at $CC_HOOK_SRC_DIR; skipping (Claude/Codex lock enforcement inactive)"
fi

# 4d. Install the `omp-su` wrapper — engineer-collaborator mode as one
# command. Plain `omp` stays vanilla; `omp-su` launches OMP with the
# playbook (--append-system-prompt) + the coordination extension (-e).
# The wrapper is co-located with the `omp` binary so it lands on the
# same PATH; it falls back to ~/.local/bin if `omp` can't be located.
if OMP_BIN="$(command -v omp 2>/dev/null)"; then
  WRAPPER_DIR="$(dirname "$OMP_BIN")"
else
  WRAPPER_DIR="${HOME}/.local/bin"
fi
mkdir -p "$WRAPPER_DIR"
WRAPPER_PATH="${WRAPPER_DIR}/omp-su"
# Write the wrapper with the profile-specific playbook path baked in.
# PLAYBOOK_DEST is expanded here (not single-quoted) so the installed
# path is concrete — the wrapper has no dependency on env vars at runtime.
cat > "$WRAPPER_PATH" <<WRAPEOF
#!/usr/bin/env bash
# papercusp ${PROFILE}-collaborator launcher (managed by install-standalone-mcp.sh --profile=${PROFILE}).
# Plain \`omp\` is a vanilla coding assistant; this wrapper opts into the
# ${PROFILE} playbook + the papercusp coordination extension.
# To switch profiles, re-run: install-standalone-mcp.sh --profile=engineer|power
exec omp \\
  --append-system-prompt "${PLAYBOOK_DEST}" \\
  -e "${HOME}/.papercusp/papercusp-coord.ts" \\
  "\$@"
WRAPEOF
chmod 755 "$WRAPPER_PATH"
echo "✓ Installed $WRAPPER_PATH"
case ":${PATH}:" in
  *":${WRAPPER_DIR}:"*) : ;;
  *) echo "! $WRAPPER_DIR is not on PATH — add it or invoke $WRAPPER_PATH by full path" ;;
esac

# 4e. Install the `claude-su` wrapper — Claude Code equivalent of omp-su.
# Plain `claude` stays vanilla; `claude-su` launches Claude Code with
# the playbook (--append-system-prompt-file). The papercusp-su MCP
# server is already registered in ~/.claude.json (step 3a), so the SU
# tool catalog is available either way — only the playbook injection
# is opt-in.
#
# Hooks: Claude Code's hook system is settings.json-driven, not module-
# loaded like OMP's `-e`. The lock-enforcement Pre/PostToolUse hooks are
# merged into ~/.claude/settings.json below (step 4e-hooks) — USER-level,
# so they protect both `claude` and `claude-su`. They scope to the
# papercup workspace and no-op when Papercusp isn't installed, so they
# are safe globally; the playbook (this wrapper) stays the only opt-in.
if CLAUDE_BIN="$(command -v claude 2>/dev/null)"; then
  CLAUDE_WRAPPER_DIR="$(dirname "$CLAUDE_BIN")"
else
  CLAUDE_WRAPPER_DIR="${HOME}/.local/bin"
fi
mkdir -p "$CLAUDE_WRAPPER_DIR"
CLAUDE_WRAPPER_PATH="${CLAUDE_WRAPPER_DIR}/claude-su"
cat > "$CLAUDE_WRAPPER_PATH" <<WRAPEOF
#!/usr/bin/env bash
# papercusp ${PROFILE}-collaborator launcher for Claude Code
# (managed by install-standalone-mcp.sh --profile=${PROFILE}).
# Plain \`claude\` is a vanilla Claude Code session; this wrapper opts
# into the ${PROFILE} playbook (Claude-Code variant — OMP-only task-tool
# guidance stripped out) via --append-system-prompt-file. The
# papercusp-su MCP server is already in ~/.claude.json, so all SU
# tools are available either way.
# To switch profiles, re-run: install-standalone-mcp.sh --profile=engineer|power
# Per-session coordination identity. Mint a distinct id per launch so two
# claude-su shells on one machine get DISTINCT coord/lock owners (fixes
# the same-machine collapse where coord:inbox self-filtered peers). The
# ~/.claude.json mcp url expands \${PAPERCUSP_SID:-<machine-id>}, and the
# lock hook reads the same var — so a shell's interactive calls and its
# hook share one owner. Reuse an inherited value if already set.
if [ -z "\${PAPERCUSP_SID:-}" ]; then
  PAPERCUSP_SID="claude-su-\$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "\$\$-\${RANDOM}")"
fi
export PAPERCUSP_SID
exec claude \\
  --append-system-prompt-file "${PLAYBOOK_DEST_CLAUDE}" \\
  "\$@"
WRAPEOF
chmod 755 "$CLAUDE_WRAPPER_PATH"
echo "✓ Installed $CLAUDE_WRAPPER_PATH"
case ":${PATH}:" in
  *":${CLAUDE_WRAPPER_DIR}:"*) : ;;
  *) echo "! $CLAUDE_WRAPPER_DIR is not on PATH — add it or invoke $CLAUDE_WRAPPER_PATH by full path" ;;
esac

# 4e-hooks. Merge the SU-locks Pre/PostToolUse hooks into Claude Code's
# USER settings (~/.claude/settings.json). User-level so both `claude`
# and `claude-su` enforce locks; the matcher limits them to file edits,
# and the hook itself scopes to the papercup workspace + no-ops when
# Papercusp isn't installed.
if [ -x "$CC_PRE_HOOK" ]; then
  CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
  merge_lock_hooks "$CLAUDE_SETTINGS" "Edit|Write|MultiEdit"
  chmod 600 "$CLAUDE_SETTINGS"
  echo "✓ Merged SU-locks Pre/PostToolUse hooks into $CLAUDE_SETTINGS"
else
  echo "· Claude lock hooks not installed (no $CC_PRE_HOOK) — skipping settings merge"
fi

# 4f. Install the `codex-su` wrapper — Codex CLI equivalent of omp-su.
# Codex has no `--append-system-prompt`; it injects instructions through
# AGENTS.md files within its CODEX_HOME. So codex-su runs Codex in a
# DEDICATED CODEX_HOME (~/.papercusp/codex-su-home) whose AGENTS.md IS
# the ${PROFILE} playbook. Plain `codex` (CODEX_HOME=~/.codex) stays
# vanilla — it never sees the playbook or the papercusp-su server.
#
# Login is shared by symlinking ~/.codex/auth.json (no separate sign-in).
# The papercusp-su MCP server is registered ONLY in this SU home and uses
# a bearer-token ENV VAR — the codex-su wrapper reads the 0600 token file
# at launch and exports it, so the token is never written into config.
CODEX_SU_HOME="${HOME}/.papercusp/codex-su-home"
mkdir -p "${CODEX_SU_HOME}/sessions"
chmod 700 "$CODEX_SU_HOME"
if [ ! -f "$PLAYBOOK_PATH" ]; then
  echo "! Expected base playbook at $PLAYBOOK_PATH; skipping codex-su home"
else
  render_playbook "$PLAYBOOK_PATH" "$OVERLAY_CODEX" "${CODEX_SU_HOME}/AGENTS.md"
  chmod 644 "${CODEX_SU_HOME}/AGENTS.md"
  echo "✓ Wrote ${PROFILE} Codex playbook to ${CODEX_SU_HOME}/AGENTS.md"
fi
# Share login with the user's real Codex install.
if [ -e "${HOME}/.codex/auth.json" ]; then
  ln -sf "${HOME}/.codex/auth.json" "${CODEX_SU_HOME}/auth.json"
  echo "✓ Linked ${CODEX_SU_HOME}/auth.json → ~/.codex/auth.json (shared login)"
else
  echo "· ~/.codex/auth.json not found — run \`codex\` once and sign in, then re-run to share login"
fi
# SU-home config.toml: papercusp-su MCP server + model/effort inherited
# from ~/.codex/config.toml (top-level scalars only; snapshot, re-run to
# refresh). The bearer token comes from PAPERCUSP_SU_TOKEN at runtime.
python3 - "${CODEX_SU_HOME}/config.toml" "${HOME}/.codex/config.toml" "$OPERATOR_URL" "$AGENT_ID" "$PROFILE" <<'PYEOF'
import re, sys
dest, user_cfg, operator_url, agent_id, profile = sys.argv[1:6]
model = effort = None
try:
    with open(user_cfg) as f:
        for line in f:
            s = line.strip()
            if s.startswith('['):
                break  # stop at the first table — only inherit top-level scalars
            m = re.match(r'model\s*=\s*(.+)$', s)
            if m: model = m.group(1).strip()
            m = re.match(r'model_reasoning_effort\s*=\s*(.+)$', s)
            if m: effort = m.group(1).strip()
except FileNotFoundError:
    pass
profile_param = '&profile=power' if profile == 'power' else ''
url = operator_url + '/api/mcp?superuser=1' + profile_param + '&client=' + agent_id
lines = [
    '# Papercusp codex-su home config (managed by install-standalone-mcp.sh).',
    '# Applies ONLY when launched via the `codex-su` wrapper; plain `codex`',
    '# (CODEX_HOME=~/.codex) is unaffected.',
]
if model:  lines.append(f'model = {model}')
if effort: lines.append(f'model_reasoning_effort = {effort}')
lines += [
    '',
    '[mcp_servers.papercusp-su]',
    f'url = "{url}"',
    'bearer_token_env_var = "PAPERCUSP_SU_TOKEN"',
    '',
]
with open(dest, 'w') as f:
    f.write('\n'.join(lines))
PYEOF
chmod 600 "${CODEX_SU_HOME}/config.toml"
echo "✓ Wrote ${CODEX_SU_HOME}/config.toml (papercusp-su MCP, scoped to codex-su)"

# Merge the SAME lock hooks into the codex-su CODEX_HOME settings.json.
# Codex 0.135 implements the Claude hook wire format, so the script pair
# is shared; only the matcher differs — Codex edits via `apply_patch`
# (and write_file/edit_file), not Edit/Write. Scoped to the codex-su
# home (plain `codex` uses ~/.codex and is unaffected).
if [ -x "$CC_PRE_HOOK" ]; then
  merge_lock_hooks "${CODEX_SU_HOME}/settings.json" "apply_patch|write_file|edit_file"
  chmod 600 "${CODEX_SU_HOME}/settings.json"
  echo "✓ Merged SU-locks Pre/PostToolUse hooks into ${CODEX_SU_HOME}/settings.json"
else
  echo "· Codex lock hooks not installed (no $CC_PRE_HOOK) — skipping settings merge"
fi

if CODEX_BIN="$(command -v codex 2>/dev/null)"; then
  CODEX_WRAPPER_DIR="$(dirname "$CODEX_BIN")"
else
  CODEX_WRAPPER_DIR="${HOME}/.local/bin"
fi
mkdir -p "$CODEX_WRAPPER_DIR"
CODEX_WRAPPER_PATH="${CODEX_WRAPPER_DIR}/codex-su"
# Base MCP url for the per-launch ?client override below (mirrors the
# config.toml url, minus the &client= part the wrapper supplies per launch).
CODEX_MCP_BASE="${OPERATOR_URL}/api/mcp?superuser=1"
[ "$PROFILE" = "power" ] && CODEX_MCP_BASE="${CODEX_MCP_BASE}&profile=power"
cat > "$CODEX_WRAPPER_PATH" <<WRAPEOF
#!/usr/bin/env bash
# papercusp ${PROFILE}-collaborator launcher for Codex CLI
# (managed by install-standalone-mcp.sh --profile=${PROFILE}).
# Codex has no --append-system-prompt, so this runs Codex in a dedicated
# CODEX_HOME whose AGENTS.md is the ${PROFILE} playbook, with the
# papercusp-su MCP server scoped to it. Plain \`codex\` is unaffected.
# To switch profiles, re-run: install-standalone-mcp.sh --profile=engineer|power
if [ -z "\${PAPERCUSP_SU_TOKEN:-}" ] && [ -s "${TOKEN_PATH}" ]; then
  PAPERCUSP_SU_TOKEN="\$(cat "${TOKEN_PATH}")"
  export PAPERCUSP_SU_TOKEN
fi
# Per-session coordination identity. A distinct id per launch so two
# codex-su shells on one machine get DISTINCT coord/lock owners. Codex
# does NOT env-expand config.toml, so the mcp url is overridden per launch
# via -c; the lock hook reads the same PAPERCUSP_SID, so a shell's
# interactive calls and its hook share one owner. Reuse if inherited.
if [ -z "\${PAPERCUSP_SID:-}" ]; then
  PAPERCUSP_SID="codex-su-\$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "\$\$-\${RANDOM}")"
fi
export PAPERCUSP_SID
# --dangerously-bypass-hook-trust: Codex requires persisted trust before
# running settings.json hooks. The ONLY hooks in this dedicated CODEX_HOME
# are the SU-locks Pre/PostToolUse pair this installer wrote, so bypassing
# the trust prompt is the documented "automation that vets its own hook
# sources" path — not arbitrary third-party hooks.
exec env CODEX_HOME="${CODEX_SU_HOME}" codex --dangerously-bypass-hook-trust \\
  -c "mcp_servers.papercusp-su.url=\"${CODEX_MCP_BASE}&client=\${PAPERCUSP_SID}\"" \\
  "\$@"
WRAPEOF
chmod 755 "$CODEX_WRAPPER_PATH"
echo "✓ Installed $CODEX_WRAPPER_PATH"
case ":${PATH}:" in
  *":${CODEX_WRAPPER_DIR}:"*) : ;;
  *) echo "! $CODEX_WRAPPER_DIR is not on PATH — add it or invoke $CODEX_WRAPPER_PATH by full path" ;;
esac

# 4g. Install the `psu` command — the plan-tracked picker launcher.
# Unlike the *-su wrappers (direct, untracked), `psu` prompts for
# agent + harness + plan, records a tracked /adv session via the
# operator's bootstrap-su endpoint, then exec's the chosen *-su wrapper.
# It's a thin shim over the Node launcher in the repo (which resolves
# @inquirer/prompts from the operator's node_modules). Scripting escape:
#   psu --no-picker --agent=<claude|omp|codex> --harness=<slug> [--plan=<slug>|--no-plan]
PSU_LAUNCHER="${SCRIPT_DIR}/psu-launcher.mjs"
PSU_BIN_DIR="${HOME}/.local/bin"
PSU_PATH="${PSU_BIN_DIR}/psu"
if [ -f "$PSU_LAUNCHER" ]; then
  mkdir -p "$PSU_BIN_DIR"
  cat > "$PSU_PATH" <<WRAPEOF
#!/usr/bin/env bash
# papercusp tracked SU launcher (managed by install-standalone-mcp.sh).
# Picks agent + harness + plan, records a tracked /adv session, then
# launches the matching *-su wrapper. The plain *-su wrappers stay direct.
exec node "${PSU_LAUNCHER}" "\$@"
WRAPEOF
  chmod 755 "$PSU_PATH"
  echo "✓ Installed $PSU_PATH (tracked picker launcher)"
  case ":${PATH}:" in
    *":${PSU_BIN_DIR}:"*) : ;;
    *) echo "! $PSU_BIN_DIR is not on PATH — add it or invoke $PSU_PATH by full path" ;;
  esac
else
  echo "! psu launcher not found at $PSU_LAUNCHER; skipping psu install"
fi

# 5. Verify the endpoint accepts the token.
echo
echo "→ Verifying loopback access at ${OPERATOR_URL}/api/mcp?superuser=1"
# curl writes %{http_code} on stdout even on connection failure
# (it's just "000" in that case), so we don't need an `|| echo "000"`
# fallback — and adding one duplicates the output to "000000".
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -X POST "${OPERATOR_URL}/api/mcp?superuser=1" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  --max-time 5 || true)
[ -z "$status" ] && status="000"

if [ "$status" = "200" ]; then
  echo "✓ Endpoint responded 200"
else
  echo "✗ Endpoint responded $status (expected 200) — operator may not be running"
  exit 1
fi

cat <<EOF

Done.  Profile: ${PROFILE}

  Plain OMP / Claude Code — vanilla coding assistant, no playbook:
    \$ omp
    \$ claude

  ${PROFILE^}-collaborator mode — playbook injected, papercusp-su tools available:
    \$ omp-su       # OMP + playbook + coordination extension
    \$ claude-su    # Claude Code + playbook
    \$ codex-su     # Codex + playbook (dedicated CODEX_HOME, shared login)
    > call mcp__papercusp-su__papercusp:list_workspaces

  SU-locks ENFORCEMENT is active on all three clients: an Edit/Write/
  apply_patch to a file another SU agent holds is BLOCKED with the
  holder's intent + expiry, so the agent can wait, pivot, or queue.
    - OMP    → coord-hook.ts (omp-su, via \`-e\`)
    - Claude → Pre/PostToolUse hooks in ~/.claude/settings.json (user-level)
    - Codex  → Pre/PostToolUse hooks in the codex-su CODEX_HOME
  Enforcement scopes to the papercup workspace and no-ops when the
  operator is down (fail-open). /coord surfaces "enforcement offline".

  Each -su wrapper loads the SAME base playbook with its OWN client
  tooling overlay spliced in, so OMP-only task-tool guidance never lands
  in the Claude or Codex playbook.

  Plan-tracked launch — pick agent + harness + plan; the session shows up
  in /adv (under its plan, or the "No plan" group). \`psu\` exec's the
  matching -su wrapper, so it's the same engineer mode, just tracked:
    \$ psu                                                       # interactive picker
    \$ psu --no-picker --agent=claude --harness=papercup --no-plan   # scripting

  One-off, without the wrappers:
    \$ omp    --append-system-prompt ${PLAYBOOK_DEST} \\
             -e ~/.papercusp/papercusp-coord.ts
    \$ claude --append-system-prompt-file ${PLAYBOOK_DEST_CLAUDE}
    \$ CODEX_HOME=${CODEX_SU_HOME} PAPERCUSP_SU_TOKEN=\$(cat ${TOKEN_PATH}) codex

  Switch profiles:
    \$ install-standalone-mcp.sh --profile=engineer   # full Papercusp-engineer playbook
    \$ install-standalone-mcp.sh --profile=power      # power-engineer subset (generic tools)

The papercusp-su MCP server is registered for plain \`omp\`, \`omp-su\`,
\`claude\`, and \`claude-su\` (entries in ~/.omp/agent/mcp.json and
~/.claude.json) — only the playbook (and, for OMP, the coordination
extension) are gated behind the -su wrappers. For Codex it is different:
the server is registered ONLY in the codex-su home (${CODEX_SU_HOME}/config.toml),
so plain \`codex\` is fully vanilla and only \`codex-su\` gets the SU tools.

OMP-native Hindsight memory is enabled by this installer:
  memory.backend=hindsight
  hindsight.apiUrl=${HINDSIGHT_URL}
  hindsight.scoping=per-project-tagged
Start a local server if you are not using Hindsight Cloud:
  docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest

Project docs — point the docs:* tools at YOUR project's docs (instead
of Papercusp engineering docs) by setting the env var below before
launching omp-su (or any omp session):
    \$ export PAPERCUSP_PROJECT_DOCS_ROOT=\$PWD/docs
    \$ omp-su
The docs:* tools (outline/get/search) then read from that dir on every
no-harness call. Unset → docs:* returns no_docs_source for non-SU
callers (rather than silently leaking Papercusp's docs).

To rotate the token, delete $TOKEN_PATH and re-run. To revoke, delete:
  $TOKEN_PATH
  $PLAYBOOK_DEST
  $PLAYBOOK_DEST_CLAUDE
  $COORD_EXT_DEST
  $WRAPPER_PATH
  $CLAUDE_WRAPPER_PATH
  $CODEX_WRAPPER_PATH
  $PSU_PATH   (the tracked picker launcher)
  $CODEX_SU_HOME   (the dedicated codex-su CODEX_HOME — incl. its settings.json hooks)
  $CC_HOOK_DEST_DIR   (the shared Claude/Codex lock hooks)
  (remove the 'papercusp-su' entry from both $OMP_CONFIG_PATH and $CLAUDE_CONFIG_PATH,
   and the SU-locks Pre/PostToolUse entries from ${HOME}/.claude/settings.json)

EOF
