#!/usr/bin/env bash
# Claude Code statusline — render a compact CROSS-CLI FLEET line from the activity
# bridge (papercusp-worker-integration-2026-06-04, D-005, a Claude-only progressive
# enhancement). Shows what the rest of the worker fleet is doing — the "watch the
# fleet" glance, without leaving the session:
#
#   papercusp · 4 agents · ◆ su-074be ✎ catalog.ts · ▶ npm test
#
# Claude invokes a statusline command frequently, so this is CHEAP + FAIL-OPEN:
# one `activity:recent` query with a short timeout; on any trouble (operator down,
# not a psu session, no activity) it prints a minimal fallback (or nothing) and
# exits 0. NEVER blocks, never errors. The statusline is registered NON-destructively
# by install-standalone-mcp.sh (only when the user has no existing statusLine) and is
# trivially removable — it is a progressive enhancement, never the baseline.
#
# Claude passes a session JSON object on stdin (model / cwd / session_id / …); we
# read PAPERCUSP_SID from the env (the psu launch exports it, same as the hooks) and
# don't depend on the stdin shape.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# Drain stdin (Claude pipes session JSON) so the pipe closes cleanly; we don't need it.
INPUT="$(cat 2>/dev/null || true)"

# Not a psu session / not installed → print nothing (Claude falls back to its default).
if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

TOKEN=$(cat "$TOKEN_PATH")

# In SYNC/test mode read the activity JSON from $PAPERCUSP_STATUSLINE_FIXTURE instead
# of the operator, so the render logic is testable without a live operator.
python3 - "$OPERATOR_URL" "$TOKEN" "$PAPERCUSP_SID" "${PAPERCUSP_STATUSLINE_FIXTURE:-}" <<'PYEOF' 2>/dev/null || exit 0
import json, sys, urllib.request, urllib.parse

operator_url, token, me, fixture = sys.argv[1:5]
HTTP_TIMEOUT = 1.5
WINDOW = 12  # rows to scan for the fleet glance


def fetch():
    if fixture:
        with open(fixture) as f:
            return json.load(f)
    args = {'limit': WINDOW}
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': 'activity:recent', 'arguments': args}}).encode()
    req = urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&client=' + urllib.parse.quote(me, safe=''),
        data=body,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream'},
        method='POST')
    raw = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read().decode('utf-8', 'replace')
    # Parse a JSON or SSE-framed JSON-RPC result → the inner tool payload.
    result = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith('data:'):
            line = line[5:].strip()
        if not line:
            continue
        try:
            cand = json.loads(line)
            if isinstance(cand, dict) and 'result' in cand:
                result = cand['result']
                break
        except Exception:
            pass
    if not result:
        return None
    for item in (result.get('content') or []):
        if item.get('type') == 'text':
            try:
                return json.loads(item['text'])
            except Exception:
                pass
    return None


try:
    data = fetch()
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
rows = data.get('activity')
if not isinstance(rows, list) or not rows:
    sys.exit(0)

# rows are newest-first. Count DISTINCT other workers (the fleet size glance) and
# pick the most-recent PEER action (not my own — I already see mine).
others = []
peer = None
for r in rows:
    owner = r.get('owner_id')
    if not owner or owner == me:
        continue
    if owner not in others:
        others.append(owner)
    if peer is None:
        peer = r

n = len(others)
parts = ['papercusp']
parts.append(f'{n} peer{"" if n == 1 else "s"}' if n else 'solo')
if peer is not None:
    # Short owner label (last 6 of the id) + its summary.
    owner = str(peer.get('owner_id') or '?')
    short = owner[-6:] if len(owner) > 6 else owner
    summ = (peer.get('summary') or '').strip()
    if summ:
        parts.append(f'◆ {short} {summ}'[:60])

sys.stdout.write(' · '.join(parts))
PYEOF
