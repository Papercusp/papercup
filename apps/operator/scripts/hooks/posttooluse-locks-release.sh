#!/usr/bin/env bash
# PostToolUse hook — release the lock acquired by the matching
# PreToolUse hook.
#
# We read the cached lock_id from ~/.papercusp/locks-cache/<tool_use_id>.lock
# and call locks:release. If the cache is missing (Pre hook didn't run,
# or already released), we no-op silently. Exit non-zero would surface
# noise to the agent without changing the outcome.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
CACHE_DIR="${HOME}/.papercusp/locks-cache"

if [ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]; then
  exit 0
fi

TOKEN=$(cat "$TOKEN_PATH")
AGENT_ID=$(cat "$AGENT_ID_PATH")
INPUT=$(cat)

python3 - "$INPUT" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$CACHE_DIR" <<'PYEOF'
import json, os, sys, urllib.request, urllib.parse

raw, operator_url, token, agent_id, cache_dir = sys.argv[1:6]

try:
    payload = json.loads(raw)
except Exception:
    sys.exit(0)

tool_use_id = payload.get('tool_use_id', '')
# Defensive type check (matches PreToolUse's bug-#18 fix). Non-string
# tool_use_id → exit 0, no release attempted.
if not isinstance(tool_use_id, str) or not tool_use_id:
    sys.exit(0)

# Identity MUST match what PreToolUse used to acquire — the release
# owner-check (bug #16) requires owner == acquirer. PreToolUse keys on
# the per-session session_id, so PostToolUse must too.
session_id = payload.get('session_id')
owner = session_id if isinstance(session_id, str) and session_id else agent_id

cache_path = os.path.join(cache_dir, tool_use_id + '.lock')
if not os.path.exists(cache_path):
    sys.exit(0)

try:
    with open(cache_path) as f:
        lock_id = f.read().strip()
except Exception:
    sys.exit(0)

if not lock_id:
    try:
        os.remove(cache_path)
    except Exception:
        pass
    sys.exit(0)

body = json.dumps({
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
        "name": "locks:release",
        "arguments": {"lock_id": lock_id},
    },
}).encode()

req = urllib.request.Request(
    operator_url.rstrip('/') + '/api/mcp?superuser=1&client=' + urllib.parse.quote(owner, safe=''),
    data=body,
    headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    },
    method='POST',
)
try:
    urllib.request.urlopen(req, timeout=10).read()
except Exception:
    pass  # Best-effort; TTL will cover any missed release.

# Always clean up the cache file.
try:
    os.remove(cache_path)
except Exception:
    pass

sys.exit(0)
PYEOF
