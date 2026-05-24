#!/usr/bin/env bash
# install-standalone-mcp.sh — set up papercusp's superuser MCP endpoint
# for an OMP / Claude Code / Codex / Gemini shell launched outside
# papercusp.
#
# What this does:
#   1. Generates a 32-byte random token
#   2. Writes ~/.papercusp/superuser-token (mode 0600)
#   3. MERGES a `papercusp-su` server entry into ~/.omp/agent/mcp.json
#      (preserves any other MCP servers the user already has)
#   4. Writes the engineer-collaborator playbook + coordination extension
#      as standalone OPT-IN files under ~/.papercusp/, and installs an
#      `omp-su` wrapper that launches OMP with them. Plain `omp` is left
#      untouched — engineer-collaborator mode is no longer always-on.
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

PLAYBOOK_PATH="${SCRIPT_DIR}/../prompts/papercusp-su-${PROFILE}.tools.md"

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

# 4. Install the profile-specific playbook as a standalone OPT-IN file.
# It used to be injected as a managed block into OMP's always-loaded
# context file (~/.omp/agent/CLAUDE.md), which made engineer-collaborator
# mode unconditional on every `omp` launch. It now lives at
# ~/.papercusp/<profile>-collaborator.md and is loaded only when the
# `omp-su` wrapper (step 4d) passes it via `--append-system-prompt`.
#
# Profile destinations:
#   engineer → ~/.papercusp/engineer-collaborator.md
#   power    → ~/.papercusp/power-collaborator.md
PLAYBOOK_DEST="${HOME}/.papercusp/${PROFILE}-collaborator.md"
if [ ! -f "$PLAYBOOK_PATH" ]; then
  echo "! Expected playbook at $PLAYBOOK_PATH; skipping playbook install"
else
  cp "$PLAYBOOK_PATH" "$PLAYBOOK_DEST"
  chmod 644 "$PLAYBOOK_DEST"
  echo "✓ Wrote ${PROFILE} playbook to $PLAYBOOK_DEST"
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

  Plain OMP — vanilla coding assistant, no papercusp playbook:
    \$ omp

  ${PROFILE^}-collaborator mode — playbook + coordination extension:
    \$ omp-su
    > call mcp__papercusp-su__papercusp:list_workspaces

  One-off, without the wrapper:
    \$ omp --append-system-prompt ${PLAYBOOK_DEST} \\
          -e ~/.papercusp/papercusp-coord.ts

  Switch profiles:
    \$ install-standalone-mcp.sh --profile=engineer   # full Papercusp-engineer playbook
    \$ install-standalone-mcp.sh --profile=power      # power-engineer subset (generic tools)

The papercusp-su MCP server is registered for BOTH plain omp and omp-su
(it lives in ~/.omp/agent/mcp.json) — only the playbook and the
coordination extension are gated behind omp-su.

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
  $COORD_EXT_DEST
  $WRAPPER_PATH
  (and remove the 'papercusp-su' entry from $OMP_CONFIG_PATH)

EOF
