#!/usr/bin/env bash
# install-standalone-mcp.sh — set up papercusp's superuser MCP endpoint
# for an OMP shell launched outside papercusp.
#
# What this does:
#   1. Generates a 32-byte random token
#   2. Writes ~/.papercusp/superuser-token (mode 0600)
#   3. MERGES a `papercusp-su` server entry into ~/.omp/agent/mcp.json
#      (preserves any other MCP servers the user already has)
#   4. Verifies HTTP 200 against the running operator
#
# Re-running rotates the token and updates the existing entry in place.
#
# Threat model: friction, not enforcement. Any process running as the
# same user can read ~/.papercusp/superuser-token. See
# /docs/endpoint-system/superuser-mode.

set -euo pipefail

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

# 3. Merge `papercusp-su` into the existing OMP MCP config.
# We use python because jq is not guaranteed and the merge needs to be
# idempotent (re-runs just rotate the token, don't duplicate the entry).
python3 - "$OMP_CONFIG_PATH" "$OPERATOR_URL" "$TOKEN" <<'PYEOF'
import json, os, sys
path, operator_url, token = sys.argv[1], sys.argv[2], sys.argv[3]
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
cfg['mcpServers']['papercusp-su'] = {
    'type': 'http',
    'url': operator_url + '/api/mcp?superuser=1',
    'headers': {
        'Authorization': 'Bearer ' + token,
    },
}
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PYEOF
chmod 600 "$OMP_CONFIG_PATH"
echo "✓ Merged 'papercusp-su' into $OMP_CONFIG_PATH (mode 0600)"

# 4. Verify the endpoint accepts the token.
echo
echo "→ Verifying loopback access at ${OPERATOR_URL}/api/mcp?superuser=1"
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -X POST "${OPERATOR_URL}/api/mcp?superuser=1" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  --max-time 5 || echo "000")

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
