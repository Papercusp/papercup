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
#      as standalone OPT-IN files under ~/.papercusp/, and installs `psu`
#      (the one launcher). The `*-su` wrappers are RETIRED — `psu` →
#      `bootstrap-su` → `buildLaunchSpec` assembles the playbook + MCP +
#      flags per-launch and execs the RAW CLI. Plain `omp` / `claude` /
#      `codex` are left untouched.
#   4b. Installs the SU-locks ENFORCEMENT hook scripts + wires them where
#      the client actually reads them:
#        - Claude → Pre/PostToolUse in ~/.claude/settings.json (USER-level,
#          automatic — survives a raw `claude`/`psu` launch).
#        - OMP    → coord-hook.ts, loaded per-launch by psu via `-e`.
#        - Codex  → hooks.json in the per-session CODEX_HOME psu mints.
#          NOTE: codex does not currently fire PreToolUse on edits (upstream
#          openai/codex #20204), so codex coordination is voluntary
#          (playbook-driven `locks:*`) until that lands.
#      Claude and Codex share one hook-script pair (same hook wire format).
#   5. Verifies HTTP 200 against the running operator
#
# Re-running REUSES the existing token (so live shells keep working),
# updates the MCP entry, and refreshes the playbook, the coordination
# extension, and `psu`. To rotate the token deliberately, delete
# ~/.papercusp/superuser-token first, then re-run.
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
# Separate PostToolUse hook: surface NEW coord:inbox messages mid-turn
# (psu sessions only). Independent of the lock hooks, wired under its own
# settings.json entry so the two never collide.
CC_COORD_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-coord-inbox.sh"
# Separate PostToolUse hook: mirror every native tool call into the cross-CLI
# ACTIVITY BRIDGE (papercusp-worker-integration-2026-06-04) → the pui fleet view
# + curator. psu sessions only (scopes itself via PAPERCUSP_SID). Fire-and-forget
# + detached, so it adds no latency; its own settings.json entry, matcher "*".
CC_ACTIVITY_HOOK="${CC_HOOK_DEST_DIR}/posttooluse-activity-report.sh"
# SessionStart/SessionEnd hook: report a worker's session LIFECYCLE (appeared/left)
# into the activity bridge — a kind='lifecycle' marker for the fleet view.
CC_LIFECYCLE_HOOK="${CC_HOOK_DEST_DIR}/lifecycle-report.sh"
# Claude-only progressive enhancement (papercusp-worker-integration D-005): a
# statusline rendering the cross-CLI fleet glance from the activity bridge.
# Registered NON-destructively (only when the user has no existing statusLine) so
# it never clobbers a personal statusline; trivially removable.
CC_STATUSLINE="${CC_HOOK_DEST_DIR}/statusline-fleet.sh"
# PreToolUse Bash gate: refuse a raw destructive command (systemctl restart /
# psql -f / …) that collides with an in-flight EXCLUSIVE hold on a registered
# named resource (plan named-resource-locks-drain, P-026). Its own settings
# entry, matcher "Bash"; fail-open + a local keyword pre-filter so the vast
# majority of commands never hit the operator.
CC_BASH_GATE_HOOK="${CC_HOOK_DEST_DIR}/pretooluse-bash-resource-gate.sh"

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

# Merge the coord-inbox PostToolUse hook into a settings.json as its OWN
# entry (matcher "*" — every tool, so new coord messages reach the agent
# mid-turn). Idempotent: drops any prior entry pointing at our script,
# preserves all other hooks (incl. the lock entries), then appends fresh.
#   $1 = settings.json path
merge_coord_hook() {
  python3 - "$1" "$CC_COORD_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, coord, workspace_root = sys.argv[1:4]
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

ours = {coord, os.path.basename(coord)}

def is_ours(entry):
    for h in (entry.get('hooks') or []):
        if any(o in h.get('command', '') for o in ours):
            return True
    return False

# The hook scopes itself to psu sessions via PAPERCUSP_SID, but pass the
# workspace root through too for parity with the lock hooks.
cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {coord}"

hooks = cfg.setdefault('hooks', {})
arr = [e for e in hooks.get('PostToolUse', []) if not is_ours(e)]
arr.append({'matcher': '*',
            'hooks': [{'type': 'command', 'command': cmd}]})
hooks['PostToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the activity-report PostToolUse hook as its OWN entry (matcher "*" —
# every tool, so each native tool call is mirrored into the activity bridge).
# Idempotent: drops any prior entry pointing at our script, preserves all other
# hooks, then appends fresh. The hook scopes itself to psu sessions via
# PAPERCUSP_SID + is fire-and-forget, so it's inert/cheap outside a psu session.
#   $1 = settings.json path
merge_activity_hook() {
  python3 - "$1" "$CC_ACTIVITY_HOOK" <<'PYEOF'
import json, os, sys, time
path, activity = sys.argv[1:3]
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

ours = {activity, os.path.basename(activity)}

def is_ours(entry):
    for h in (entry.get('hooks') or []):
        if any(o in h.get('command', '') for o in ours):
            return True
    return False

# The hook reads PAPERCUSP_SID + cwd from the session env (Claude passes the
# session env to hooks), so no baking is needed — just the script path.
hooks = cfg.setdefault('hooks', {})
arr = [e for e in hooks.get('PostToolUse', []) if not is_ours(e)]
arr.append({'matcher': '*',
            'hooks': [{'type': 'command', 'command': activity}]})
hooks['PostToolUse'] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the lifecycle hook as SessionStart + SessionEnd entries (no tool matcher —
# these are session events). Idempotent: drops any prior entry pointing at our
# script, preserves all others. The hook self-gates on PAPERCUSP_SID + reads the
# event name from stdin, so one script serves both events.
#   $1 = settings.json path
merge_lifecycle_hooks() {
  python3 - "$1" "$CC_LIFECYCLE_HOOK" <<'PYEOF'
import json, os, sys, time
path, lifecycle = sys.argv[1:3]
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

ours = {lifecycle, os.path.basename(lifecycle)}

def is_ours(entry):
    for h in (entry.get('hooks') or []):
        if any(o in h.get('command', '') for o in ours):
            return True
    return False

hooks = cfg.setdefault('hooks', {})
for event in ('SessionStart', 'SessionEnd'):
    arr = [e for e in hooks.get(event, []) if not is_ours(e)]
    arr.append({'hooks': [{'type': 'command', 'command': lifecycle}]})
    hooks[event] = arr

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Register the fleet statusline NON-destructively: set cfg['statusLine'] only when
# the user has no existing statusLine (never clobber a personal one). Idempotent: a
# prior install of OUR statusline is overwritten in place; a foreign one is left
# untouched. Progressive — the baseline never depends on it.
#   $1 = settings.json path
merge_statusline() {
  python3 - "$1" "$CC_STATUSLINE" <<'PYEOF'
import json, os, sys, time
path, statusline = sys.argv[1:3]
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

existing = cfg.get('statusLine')
mine = isinstance(existing, dict) and statusline in str(existing.get('command', ''))
if existing and not mine:
    # A personal/foreign statusLine — leave it; the bridge degrades gracefully.
    sys.exit(0)
cfg['statusLine'] = {'type': 'command', 'command': statusline}

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
}

# Merge the named-resource Bash gate as its OWN PreToolUse entry (matcher
# "Bash"). Idempotent: drops any prior entry pointing at our script. The hook
# fail-opens + pre-filters locally, so it's inert until a registered resource
# is mid-exclusive.
#   $1 = settings.json path
merge_bash_gate_hook() {
  python3 - "$1" "$CC_BASH_GATE_HOOK" "$WORKSPACE_ROOT" <<'PYEOF'
import json, os, sys, time
path, gate, workspace_root = sys.argv[1:4]
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

ours = {gate, os.path.basename(gate)}

def is_ours(entry):
    for h in (entry.get('hooks') or []):
        if any(o in h.get('command', '') for o in ours):
            return True
    return False

cmd = f"PAPERCUSP_WORKSPACE_ROOT={workspace_root!r} {gate}"

hooks = cfg.setdefault('hooks', {})
arr = [e for e in hooks.get('PreToolUse', []) if not is_ours(e)]
arr.append({'matcher': 'Bash',
            'hooks': [{'type': 'command', 'command': cmd}]})
hooks['PreToolUse'] = arr

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
# locks:* can identify ownership without per-call args. That static
# machine id is the FALLBACK; the x-papercusp-client header below carries
# the PER-SESSION id (read header-first by the operator) when present.
profile_param = '&profile=power' if profile == 'power' else ''
cfg['mcpServers']['papercusp-su'] = {
    'type': 'http',
    'url': operator_url + '/api/mcp?superuser=1' + profile_param + '&client=' + agent_id,
    'headers': {
        'Authorization': 'Bearer ' + token,
        # Per-session coord/lock identity for OMP. OMP can't env-interpolate
        # the mcp.json URL (so the &client= above stays the static machine
        # id), but it DOES resolve header values at connect time
        # (config/resolve-config-value.ts): a leading "!" runs the rest in a
        # subshell that inherits the OMP process env. `psu` exports a
        # per-launch PAPERCUSP_SID, so this resolves to that per-session SID
        # — and is DROPPED (empty stdout => undefined) for a plain `omp` with
        # no SID, falling back to the static &client=. The operator reads
        # x-papercusp-client header-first (tooldef-http buildHttpSpawnContext),
        # so it overrides the static machine id. OMP's analogue of Claude's
        # ${PAPERCUSP_SID} URL interpolation + Codex's per-launch
        # `-c ...&client=<sid>` bake — see three-client-lock-enforcement plan.
        'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
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

# 4a-bis. Same migration cleanup for ~/.claude/AGENTS.md: an earlier version
# wrote an always-on managed playbook block here too. Strip it so the playbook
# reaches Claude ONLY via the claude-su wrapper's --append-system-prompt-file
# (not as an always-on copy that drifts — it had gone stale to the pre-Starlight
# fumadocs layout). Idempotent; content outside the BEGIN/END markers preserved.
CLAUDE_CTX="${HOME}/.claude/AGENTS.md"
if [ -f "$CLAUDE_CTX" ]; then
  STRIPPED_CLAUDE="$(python3 - "$CLAUDE_CTX" <<'PYEOF'
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
  if [ "$STRIPPED_CLAUDE" = "stripped" ]; then
    echo "✓ Removed legacy always-on playbook block from $CLAUDE_CTX"
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
  if [ -f "${CC_HOOK_SRC_DIR}/posttooluse-coord-inbox.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/posttooluse-coord-inbox.sh" "$CC_COORD_HOOK"
    chmod 755 "$CC_COORD_HOOK"
  fi
  if [ -f "${CC_HOOK_SRC_DIR}/posttooluse-activity-report.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/posttooluse-activity-report.sh" "$CC_ACTIVITY_HOOK"
    chmod 755 "$CC_ACTIVITY_HOOK"
  fi
  if [ -f "${CC_HOOK_SRC_DIR}/lifecycle-report.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/lifecycle-report.sh" "$CC_LIFECYCLE_HOOK"
    chmod 755 "$CC_LIFECYCLE_HOOK"
  fi
  if [ -f "${CC_HOOK_SRC_DIR}/statusline-fleet.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/statusline-fleet.sh" "$CC_STATUSLINE"
    chmod 755 "$CC_STATUSLINE"
  fi
  if [ -f "${CC_HOOK_SRC_DIR}/pretooluse-bash-resource-gate.sh" ]; then
    cp "${CC_HOOK_SRC_DIR}/pretooluse-bash-resource-gate.sh" "$CC_BASH_GATE_HOOK"
    chmod 755 "$CC_BASH_GATE_HOOK"
  fi
  echo "✓ Installed Claude/Codex lock + coord hooks to $CC_HOOK_DEST_DIR"
else
  echo "! Expected CC lock hooks at $CC_HOOK_SRC_DIR; skipping (Claude/Codex lock enforcement inactive)"
fi

# 4e-hooks. Merge the SU-locks Pre/PostToolUse hooks into Claude Code's
# USER settings (~/.claude/settings.json). User-level so both `claude`
# and `claude-su` enforce locks; the matcher limits them to file edits,
# and the hook itself scopes to the papercup workspace + no-ops when
# Papercusp isn't installed.
if [ -x "$CC_PRE_HOOK" ]; then
  CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
  merge_lock_hooks "$CLAUDE_SETTINGS" "Edit|Write|MultiEdit"
  [ -x "$CC_COORD_HOOK" ] && merge_coord_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_ACTIVITY_HOOK" ] && merge_activity_hook "$CLAUDE_SETTINGS"
  [ -x "$CC_LIFECYCLE_HOOK" ] && merge_lifecycle_hooks "$CLAUDE_SETTINGS"
  [ -x "$CC_STATUSLINE" ] && merge_statusline "$CLAUDE_SETTINGS"
  [ -x "$CC_BASH_GATE_HOOK" ] && merge_bash_gate_hook "$CLAUDE_SETTINGS"
  chmod 600 "$CLAUDE_SETTINGS"
  echo "✓ Merged SU-locks + coord + activity hooks (+ fleet statusline) into $CLAUDE_SETTINGS"
else
  echo "· Claude lock hooks not installed (no $CC_PRE_HOOK) — skipping settings merge"
fi

# 4g. Install the `psu` command — THE launcher (the *-su wrappers are gone).
# `psu` prompts for agent + harness + plan, records a tracked /adv session
# via the operator's bootstrap-su endpoint, then execs the RAW CLI with the
# playbook + MCP + flags assembled per-launch (buildLaunchSpec). It's a thin
# shim over the Node launcher in the repo (which resolves @inquirer/prompts
# from the operator's node_modules). Scripting escape:
#   psu --no-picker --agent=<claude|omp|codex> --harness=<slug> [--plan=<slug>|--no-plan]
PSU_LAUNCHER="${SCRIPT_DIR}/psu-launcher.mjs"
PSU_BIN_DIR="${HOME}/.local/bin"
PSU_PATH="${PSU_BIN_DIR}/psu"
if [ -f "$PSU_LAUNCHER" ]; then
  mkdir -p "$PSU_BIN_DIR"
  cat > "$PSU_PATH" <<WRAPEOF
#!/usr/bin/env bash
# papercusp tracked SU launcher (managed by install-standalone-mcp.sh).
# Picks agent + harness + plan, records a tracked /adv session, then execs
# the raw agent CLI with the playbook + MCP + flags assembled per-launch.
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

  Plain OMP / Claude Code / Codex — vanilla coding assistant, no playbook:
    \$ omp     \$ claude     \$ codex

  ${PROFILE^}-collaborator mode is launched by ONE command — \`psu\` (the
  *-su wrappers are retired). \`psu\` records a tracked /adv session, then
  execs the RAW CLI per-launch with the playbook + papercusp-su MCP + the
  right flags assembled for the chosen agent:
    \$ psu                                                          # interactive picker
    \$ psu --no-picker --agent=claude --harness=papercup --no-plan  # scripting
    \$ psu --resume          # or --resume=<session-id> / --resume <id>
    \$ psu --role=<role> --harness=<slug> [--feature=<id>]          # role-scoped session

  SU-locks coordination — an edit to a file another SU agent holds:
    - Claude → Pre/PostToolUse hooks in ~/.claude/settings.json (user-level,
      automatic — BLOCKS the edit with the holder's intent + expiry).
    - OMP    → coord-hook.ts loaded via \`-e\` by psu's omp launch (automatic).
    - Codex  → lock PreToolUse is INERT (codex doesn't fire it on edits —
      upstream openai/codex #20204), so codex coordinates LOCKS by calling
      \`locks:*\` itself, per its playbook; the lock hooks.json is ready and
      activates once codex fixes PreToolUse emission. BUT codex's PostToolUse
      DOES fire (Bash / apply_patch / MCP), so the per-session SU CODEX_HOME
      now also ships a coord-inbox PostToolUse hook — new coord:inbox messages
      are injected mid-turn, same as Claude.
  Enforcement scopes to the papercup workspace + fails open when the
  operator is down. /coord surfaces "enforcement offline".

  psu assembles the SAME base playbook with each client's tooling overlay
  spliced in, so OMP-only task-tool guidance never lands in the Claude or
  Codex playbook.

  One-off, by hand (psu does this for you):
    \$ omp    --approval-mode yolo --append-system-prompt ${PLAYBOOK_DEST} \\
             -e ~/.papercusp/papercusp-coord.ts
    \$ claude --dangerously-skip-permissions --append-system-prompt-file ${PLAYBOOK_DEST_CLAUDE}

  Switch profiles:
    \$ install-standalone-mcp.sh --profile=engineer   # full Papercusp-engineer playbook
    \$ install-standalone-mcp.sh --profile=power      # power-engineer subset (generic tools)

The papercusp-su MCP server is registered user-level for \`omp\` + \`claude\`
(entries in ~/.omp/agent/mcp.json and ~/.claude.json) so a raw launch sees
the SU tools; psu adds the playbook (+ for OMP the coordination extension)
per-launch. For Codex, psu mints a per-session CODEX_HOME with the superuser
MCP — plain \`codex\` (CODEX_HOME=~/.codex) stays fully vanilla.

OMP-native Hindsight memory is enabled by this installer:
  memory.backend=hindsight
  hindsight.apiUrl=${HINDSIGHT_URL}
  hindsight.scoping=per-project-tagged
Start a local server if you are not using Hindsight Cloud:
  docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest

Project docs — point the docs:* tools at YOUR project's docs (instead
of Papercusp engineering docs) by setting the env var below before
launching a session:
    \$ export PAPERCUSP_PROJECT_DOCS_ROOT=\$PWD/docs
The docs:* tools (outline/get/search) then read from that dir on every
no-harness call. Unset → docs:* returns no_docs_source for non-SU
callers (rather than silently leaking Papercusp's docs).

To rotate the token, delete $TOKEN_PATH and re-run. To revoke, delete:
  $TOKEN_PATH
  $PLAYBOOK_DEST
  $PLAYBOOK_DEST_CLAUDE
  $COORD_EXT_DEST
  $PSU_PATH   (the tracked picker launcher)
  $CC_HOOK_DEST_DIR   (the shared Claude/Codex lock hooks)
  ~/.papercusp/su-codex-homes   (per-session codex homes psu minted, if any)
  (remove the 'papercusp-su' entry from both $OMP_CONFIG_PATH and $CLAUDE_CONFIG_PATH,
   and the SU-locks Pre/PostToolUse entries from ${HOME}/.claude/settings.json)

EOF
