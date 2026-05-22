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
# Re-running rotates the token, updates the MCP entry, and refreshes
# the playbook, the coordination extension, and the omp-su wrapper.
#
# Threat model: friction, not enforcement. Any process running as the
# same user can read ~/.papercusp/superuser-token. See
# /docs/endpoint-system/superuser-mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYBOOK_PATH="${SCRIPT_DIR}/../prompts/papercusp-su.tools.md"
OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# OMP looks for its MCP server config at ~/.omp/agent/mcp.json. The
# directory may not exist on a fresh OMP install — create it.
OMP_CONFIG_DIR="${HOME}/.omp/agent"
OMP_CONFIG_PATH="${OMP_CONFIG_DIR}/mcp.json"

mkdir -p "$(dirname "$TOKEN_PATH")"
mkdir -p "$OMP_CONFIG_DIR"

# 1+2. Generate token, write file with mode 0600.
TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32)
umask 077
printf '%s\n' "$TOKEN" > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"
echo "✓ Wrote $TOKEN_PATH (mode 0600)"

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
python3 - "$OMP_CONFIG_PATH" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" <<'PYEOF'
import json, os, sys
path, operator_url, token, agent_id = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
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
# `?client=<agent_id>` surfaces as ctx.uiClientId in tool handlers so
# locks:* can identify ownership without per-call args.
cfg['mcpServers']['papercusp-su'] = {
    'type': 'http',
    'url': operator_url + '/api/mcp?superuser=1&client=' + agent_id,
    'headers': {
        'Authorization': 'Bearer ' + token,
    },
}
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
chmod 600 "$OMP_CONFIG_PATH"
echo "✓ Merged 'papercusp-su' into $OMP_CONFIG_PATH (mode 0600)"

# 4. Install the engineer-collaborator playbook as a standalone OPT-IN
# file. It used to be injected as a managed block into OMP's
# always-loaded context file (~/.omp/agent/CLAUDE.md), which made
# engineer-collaborator mode unconditional on every `omp` launch. It now
# lives at ~/.papercusp/engineer-collaborator.md and is loaded only when
# the `omp-su` wrapper (step 4d) passes it via `--append-system-prompt`.
PLAYBOOK_DEST="${HOME}/.papercusp/engineer-collaborator.md"
if [ ! -f "$PLAYBOOK_PATH" ]; then
  echo "! Expected playbook at $PLAYBOOK_PATH; skipping playbook install"
else
  cp "$PLAYBOOK_PATH" "$PLAYBOOK_DEST"
  chmod 644 "$PLAYBOOK_DEST"
  echo "✓ Wrote engineer-collaborator playbook to $PLAYBOOK_DEST"
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
cat > "$WRAPPER_PATH" <<'WRAPEOF'
#!/usr/bin/env bash
# papercusp engineer-collaborator launcher (managed by install-standalone-mcp.sh).
# Plain `omp` is a vanilla coding assistant; this wrapper opts into the
# engineer-collaborator playbook + the papercusp coordination extension.
exec omp \
  --append-system-prompt "${HOME}/.papercusp/engineer-collaborator.md" \
  -e "${HOME}/.papercusp/papercusp-coord.ts" \
  "$@"
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

Done.

  Plain OMP — vanilla coding assistant, no papercusp playbook:
    \$ omp

  Engineer-collaborator mode — playbook + coordination extension:
    \$ omp-su
    > call mcp__papercusp-su__papercusp:list_workspaces

  One-off, without the wrapper:
    \$ omp --append-system-prompt ~/.papercusp/engineer-collaborator.md \\
          -e ~/.papercusp/papercusp-coord.ts

The papercusp-su MCP server is registered for BOTH plain omp and omp-su
(it lives in ~/.omp/agent/mcp.json) — only the playbook and the
coordination extension are gated behind omp-su.

To rotate the token, re-run this script. To revoke, delete:
  $TOKEN_PATH
  $PLAYBOOK_DEST
  $COORD_EXT_DEST
  $WRAPPER_PATH
  (and remove the 'papercusp-su' entry from $OMP_CONFIG_PATH)

EOF
