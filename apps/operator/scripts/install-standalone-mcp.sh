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
#   4. Injects the engineer-collaborator playbook (papercusp-su.tools.md)
#      as a managed block into each host agent's always-loaded context
#      file (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md,
#      ~/.omp/agent/CLAUDE.md), if the agent's dir already exists.
#      Existing content outside the BEGIN/END markers is preserved.
#   5. Verifies HTTP 200 against the running operator
#
# Re-running rotates the token, updates the MCP entry, and refreshes
# the injected playbook block in place.
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

# 4. Inject the engineer-collaborator playbook into each host agent's
# always-loaded context file. Idempotent: re-runs replace the block
# between the BEGIN/END markers, leaving everything else untouched.
#
# We only target an agent's context file if the agent's parent dir
# already exists — no point creating ~/.codex/ on a machine that
# doesn't have Codex installed.

if [ ! -f "$PLAYBOOK_PATH" ]; then
  echo "! Expected playbook at $PLAYBOOK_PATH; skipping context injection"
else
  PLAYBOOK_CONTENT="$(cat "$PLAYBOOK_PATH")"
  BEGIN_MARKER="<!-- BEGIN papercusp-su playbook (managed by install-standalone-mcp.sh) -->"
  END_MARKER="<!-- END papercusp-su playbook -->"
  HEADER_NOTE="<!-- Source of truth: apps/operator/prompts/papercusp-su.tools.md in the papercup repo. -->
<!-- Re-run apps/operator/scripts/install-standalone-mcp.sh after edits to refresh this block. -->"

  inject_block() {
    local target_path="$1"
    local parent_dir="$2"
    # Skip if the agent's parent dir isn't present — agent isn't installed.
    if [ ! -d "$parent_dir" ]; then
      return 0
    fi
    mkdir -p "$(dirname "$target_path")"
    python3 - "$target_path" "$PLAYBOOK_PATH" "$BEGIN_MARKER" "$END_MARKER" "$HEADER_NOTE" <<'PYEOF'
import sys, re
target, playbook, begin, end, header = sys.argv[1:6]
with open(playbook) as f:
    body = f.read().rstrip("\n")
block = f"{begin}\n{header}\n\n{body}\n{end}\n"
try:
    with open(target) as f:
        existing = f.read()
except FileNotFoundError:
    existing = ""
pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", re.DOTALL)
if pattern.search(existing):
    updated = pattern.sub(block, existing)
else:
    sep = "\n" if existing and not existing.endswith("\n") else ""
    gap = "\n" if existing else ""
    updated = existing + sep + gap + block
with open(target, "w") as f:
    f.write(updated)
PYEOF
    echo "✓ Injected papercusp-su playbook into $target_path"
  }

  while IFS=':' read -r target parent; do
    [ -z "$target" ] && continue
    inject_block "$target" "$parent"
  done <<EOF
${HOME}/.claude/CLAUDE.md:${HOME}/.claude
${HOME}/.codex/AGENTS.md:${HOME}/.codex
${HOME}/.gemini/GEMINI.md:${HOME}/.gemini
${HOME}/.omp/agent/CLAUDE.md:${HOME}/.omp/agent
EOF
fi

# 4c. Install the coordination extension into OMP.
#
# OMP's current runtime loads `pi.on(...)` factory modules via the
# EXTENSION runner (the legacy "hook" subsystem is deprecated — `--hook`
# is now an alias for `--extension`). Extensions are auto-discovered
# from `~/.omp/agent/extensions/` — any `*.ts` file there is loaded with
# no config edit. So delivery is a plain file copy.
#
# NOTE: agent-coordination-architecture-v2 §7.3 says "~/.omp/agent/hooks/"
# — that target is stale; the verified-correct directory for the modern
# extension runtime is ~/.omp/agent/extensions/.
COORD_EXT_SRC="${SCRIPT_DIR}/hooks/omp/coord-hook.ts"
OMP_EXT_DIR="${OMP_CONFIG_DIR}/extensions"
if [ -f "$COORD_EXT_SRC" ]; then
  mkdir -p "$OMP_EXT_DIR"
  cp "$COORD_EXT_SRC" "${OMP_EXT_DIR}/papercusp-coord.ts"
  echo "✓ Installed coordination extension into ${OMP_EXT_DIR}/papercusp-coord.ts"
else
  echo "! Expected coord extension at $COORD_EXT_SRC; skipping (coordination turn-start injection will be inactive)"
fi

# 4b. (removed) Claude Code PreToolUse/PostToolUse hook injection was
# deleted in file-locking-improvements #2. Enforcement now lives
# entirely in the OMP extension's tool_call/tool_result handlers
# (apps/operator/scripts/hooks/omp/coord-hook.ts) — Claude Code, Codex
# and Gemini are unsupported (see project_claude_code_unsupported).

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

Done. From any fresh shell:

  $ omp
  > what mcp tools do you have starting with mcp__papercusp-su__?
  > call mcp__papercusp-su__papercusp:list_workspaces

To rotate the token, re-run this script. To revoke, delete:
  $TOKEN_PATH
  (and remove the 'papercusp-su' entry from $OMP_CONFIG_PATH)

EOF
