#!/usr/bin/env bash
# PreToolUse hook — claim file locks before Edit/Write/MultiEdit.
#
# Claude Code passes hook input as JSON on stdin. Shape (only the
# fields we care about):
#   { "tool_name": "Edit", "tool_input": { "file_path": "..." } }
#   { "tool_name": "MultiEdit", "tool_input": { "file_path": "..." } }
#   { "tool_name": "Write", "tool_input": { "file_path": "..." } }
#
# Exit 0 → allow the tool call. Exit non-zero → deny; Claude Code
# surfaces stderr to the agent so it can re-plan.
#
# We try `locks:acquire { wait: { max_sec: 0 } }`. If the file is
# contested, we refuse the edit and tell the agent what's holding it.
# If acquire succeeds, the lock_id is saved to a per-session cache
# under ~/.papercusp/locks-cache/ keyed by tool_use_id so the
# matching PostToolUse hook can release it.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
CACHE_DIR="${HOME}/.papercusp/locks-cache"

# Bail out fast if Papercusp isn't installed — don't break Edit for
# users who haven't run install-standalone-mcp.sh.
if [ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]; then
  exit 0
fi

mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR" 2>/dev/null || true

TOKEN=$(cat "$TOKEN_PATH")
AGENT_ID=$(cat "$AGENT_ID_PATH")
INPUT=$(cat)

python3 - "$INPUT" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$CACHE_DIR" <<'PYEOF'
import json, os, sys, urllib.request, urllib.parse

raw, operator_url, token, agent_id, cache_dir = sys.argv[1:6]

try:
    payload = json.loads(raw)
except Exception:
    # Malformed input — don't block.
    sys.exit(0)

tool_name = payload.get('tool_name', '')
tool_input = payload.get('tool_input', {}) or {}
tool_use_id = payload.get('tool_use_id', '')

# Identity: use Claude Code's per-SESSION session_id, NOT the
# machine-wide su-agent-id. Two Claude Code sessions on one machine
# share the same su-agent-id (one file, baked into the MCP config) —
# so keying locks on it would treat both sessions as the same owner
# and they'd never conflict. session_id is unique per Claude Code
# session; PreToolUse and PostToolUse within the same session share
# it, so release still matches acquire. Fall back to the machine
# agent_id only if session_id is somehow absent.
session_id = payload.get('session_id')
owner = session_id if isinstance(session_id, str) and session_id else agent_id

# Pick paths based on tool.
paths = []
if tool_name in ('Edit', 'Write', 'MultiEdit'):
    fp = tool_input.get('file_path')
    # Bug-#18 fix: defensively type-check file_path. If Claude Code
    # ever sends a non-string (null, number, list) we MUST NOT crash —
    # crashing would block the Edit with a Python traceback. Treat
    # malformed input as "no path to claim" → allow.
    if isinstance(fp, str) and fp:
        paths.append(fp)
else:
    # Not a file-editing tool. Allow.
    sys.exit(0)

if not paths:
    sys.exit(0)

# Normalize: only claim paths under the papercup repo. Skip files
# outside it (e.g. ~/.bashrc) since the lock system is workspace-
# scoped and we'd just spam errors.
PAPERCUP_ROOT = os.path.expanduser('~/papercupai-workspace/papercup')
repo_relative = []
for p in paths:
    abs_p = os.path.abspath(p)
    if not abs_p.startswith(PAPERCUP_ROOT + '/'):
        # Outside the repo — let the edit through unguarded.
        continue
    repo_relative.append(os.path.relpath(abs_p, PAPERCUP_ROOT))

if not repo_relative:
    sys.exit(0)

intent = f"PreToolUse:{tool_name}"
body = json.dumps({
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
        "name": "locks:acquire",
        "arguments": {
            "paths": repo_relative,
            "intent": intent,
            "ttl_sec": 1200,
        },
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
    resp = urllib.request.urlopen(req, timeout=10)
    raw_resp = resp.read().decode('utf-8', errors='replace')
except Exception as e:
    # Operator down — DON'T block edits. Cooperative discipline only
    # works when the system is up; better to allow than to wedge.
    print(f"[locks] could not reach operator ({e}); allowing edit", file=sys.stderr)
    sys.exit(0)

# The HTTP MCP transport may return either JSON or text/event-stream.
# Find the first JSON-RPC response in the body.
result = None
for line in raw_resp.splitlines():
    line = line.strip()
    if not line or line.startswith('event:'):
        continue
    if line.startswith('data:'):
        line = line[5:].strip()
    try:
        candidate = json.loads(line)
        if isinstance(candidate, dict) and 'result' in candidate:
            result = candidate['result']
            break
    except Exception:
        pass

if not result:
    # No usable response — allow.
    print(f"[locks] no parseable response from operator; allowing edit", file=sys.stderr)
    sys.exit(0)

# Inner JSON-RPC content array. Tool returns text content with our payload.
content = result.get('content') or []
inner = None
for item in content:
    if item.get('type') == 'text':
        try:
            inner = json.loads(item['text'])
            break
        except Exception:
            continue

if not inner:
    sys.exit(0)

if inner.get('ok') is True:
    # Acquired. Cache lock_id for PostToolUse.
    lock_id = inner.get('lock_id')
    if lock_id and tool_use_id:
        cache_path = os.path.join(cache_dir, tool_use_id + '.lock')
        with open(cache_path, 'w') as f:
            f.write(lock_id)
    sys.exit(0)

# Busy or another failure mode — refuse the edit.
busy = inner.get('busy') or []
reason = inner.get('reason')
lines = []
if reason:
    lines.append(f"locks: refused — {reason}")
else:
    lines.append("locks: refused — file(s) held by another SU agent:")
for b in busy[:5]:
    lines.append(
        f"  - {b.get('path')}: held by {b.get('owner_label')} for "
        f"{b.get('intent')!r} (expires {b.get('expires_ts')})"
    )
if len(busy) > 5:
    lines.append(f"  ... and {len(busy) - 5} more")
lines.append("")
lines.append("Options: (1) wait and retry, (2) work on something else,")
lines.append("(3) call locks:acquire with wait={max_sec:300} to queue.")

print("\n".join(lines), file=sys.stderr)
sys.exit(2)  # Non-zero exit blocks the tool. CC convention: 2 = soft-block.
PYEOF
