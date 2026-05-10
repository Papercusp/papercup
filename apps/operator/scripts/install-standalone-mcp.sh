#!/usr/bin/env bash
# install-standalone-mcp.sh — set up papercusp's superuser MCP endpoint
# for an OMP shell launched outside papercusp.
#
# What this does:
#   1. Generates a 32-byte random token
#   2. Writes ~/.papercusp/superuser-token (mode 0600)
#   3. Writes ~/.config/omp/mcp.json pointing at /api/mcp?superuser=1
#      with the token in an Authorization header
#   4. Verifies HTTP 200 against the running operator
#
# Re-running rotates the token and overwrites both files.
#
# Threat model: friction, not enforcement. Any process running as the
# same user can read ~/.papercusp/superuser-token. See plan §"Honest
# enforcement" + /docs/endpoint-system/superuser-mode.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
OMP_CONFIG_DIR="${HOME}/.config/omp"
OMP_CONFIG_PATH="${OMP_CONFIG_DIR}/mcp.json"

mkdir -p "$(dirname "$TOKEN_PATH")"
mkdir -p "$OMP_CONFIG_DIR"

# 1+2. Generate token, write file with mode 0600.
TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32)
umask 077
printf '%s\n' "$TOKEN" > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"
echo "✓ Wrote $TOKEN_PATH (mode 0600)"

# 3. Write OMP MCP config.
cat > "$OMP_CONFIG_PATH" <<EOF
{
  "mcpServers": {
    "papercusp": {
      "type": "http",
      "url": "${OPERATOR_URL}/api/mcp?superuser=1",
      "headers": {
        "Authorization": "Bearer ${TOKEN}"
      }
    }
  }
}
EOF
chmod 600 "$OMP_CONFIG_PATH"
echo "✓ Wrote $OMP_CONFIG_PATH (mode 0600)"

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

Done. Test it from any shell:

  cd /tmp && omp run --task "list your tools, then call papercusp.list_workspaces"

To rotate the token, re-run this script. To revoke, delete:
  $TOKEN_PATH

EOF
