#!/usr/bin/env bash
# Claude Code statusline — render a compact CROSS-CLI FLEET glance from
# `coord:glance` (papercusp-worker-integration-2026-06-04 D-005 + the
# coord-glance combined read, 2026-06-12). Two lines:
#
#   papercusp · ⏸ manual ✉2 · 🐝1 · 5 peers · ◆ su-074be ✎ catalog.ts
#   💡 Wake mode is manual — 2 staged wakes waiting; … /papercusp:tool:coord:wake-mode mode=auto
#
# Line 1: wake-gate state (▶ auto / ⏸ manual, ✉ staged wakes), bees in flight,
# governor pauses, peer count + most-recent peer action. Line 2 (only when the
# server has a tip for this state): the top contextual tip from the glance tips
# engine, usually with the slash command that resolves it.
#
# Claude invokes a statusline command frequently, so this is CHEAP + FAIL-OPEN:
# ONE `coord:glance` call with a short timeout; if the operator predates the
# tool (pre-deploy window) it falls back to the legacy `activity:recent`
# single-line render; on any other trouble it prints nothing and exits 0.
# NEVER blocks, never errors. Registered NON-destructively by
# install-standalone-mcp.sh (only when the user has no existing statusLine).
#
# Claude passes a session JSON object on stdin (model / cwd / session_id / …); we
# read PAPERCUSP_SID from the env (the psu launch exports it, same as the hooks)
# and don't depend on the stdin shape. COLUMNS is set by Claude Code (≥2.1.153)
# and bounds the render width.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# Drain stdin (Claude pipes session JSON) so the pipe closes cleanly; we don't need it.
INPUT="$(cat 2>/dev/null || true)"

# In SYNC/test mode read a glance-shaped JSON payload from
# $PAPERCUSP_STATUSLINE_FIXTURE instead of the operator, so the render logic is
# testable without a live operator (or a token).
if [ -z "${PAPERCUSP_STATUSLINE_FIXTURE:-}" ]; then
  # Not a psu session / not installed → print nothing (Claude falls back to its default).
  if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
    exit 0
  fi
  TOKEN=$(cat "$TOKEN_PATH")
else
  TOKEN=""
fi

python3 - "$OPERATOR_URL" "$TOKEN" "${PAPERCUSP_SID:-fixture}" "${PAPERCUSP_STATUSLINE_FIXTURE:-}" <<'PYEOF' 2>/dev/null || exit 0
import json, os, sys, urllib.request, urllib.parse

operator_url, token, me, fixture = sys.argv[1:5]
HTTP_TIMEOUT = 1.5
ACTIVITY_WINDOW = 12  # rows for the peer-glance scan


def call_tool(name, args):
    """One MCP JSON-RPC tools/call → the inner tool payload (or None)."""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': name, 'arguments': args}}).encode()
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
    if not result or result.get('isError'):
        return None
    for item in (result.get('content') or []):
        if item.get('type') == 'text':
            try:
                return json.loads(item['text'])
            except Exception:
                pass
    return None


def peer_glance(rows):
    """(peer_count, latest_peer_row) from newest-first activity rows."""
    others, peer = [], None
    for r in rows or []:
        owner = r.get('owner_id')
        if not owner or owner == me:
            continue
        if owner not in others:
            others.append(owner)
        if peer is None:
            peer = r
    return len(others), peer


def peer_part(peer):
    owner = str(peer.get('owner_id') or '?')
    short = owner[-6:] if len(owner) > 6 else owner
    summ = (peer.get('summary') or '').strip()
    return f'◆ {short} {summ}'[:60] if summ else None


def emit(lines, cols):
    sys.stdout.write('\n'.join(l[:cols] for l in lines if l))


cols = 120
try:
    cols = max(40, int(os.environ.get('COLUMNS') or 120))
except Exception:
    pass

glance = None
try:
    if fixture:
        with open(fixture) as f:
            glance = json.load(f)
    else:
        glance = call_tool('coord:glance', {'audience': 'user', 'activity_limit': ACTIVITY_WINDOW})
except Exception:
    glance = None

if not isinstance(glance, dict) or 'wake' not in glance:
    # Operator predates coord:glance (pre-deploy window) → legacy single line.
    try:
        data = call_tool('activity:recent', {'limit': ACTIVITY_WINDOW}) if not fixture else None
    except Exception:
        data = None
    rows = (data or {}).get('activity')
    if not isinstance(rows, list) or not rows:
        sys.exit(0)
    n, peer = peer_glance(rows)
    parts = ['papercusp', f'{n} peer{"" if n == 1 else "s"}' if n else 'solo']
    if peer is not None:
        p = peer_part(peer)
        if p:
            parts.append(p)
    emit([' · '.join(parts)], cols)
    sys.exit(0)

# ── glance render (two lines) ──
wake = glance.get('wake') or {}
bees = (glance.get('bees') or {}).get('running') or 0
gov = glance.get('governor') or {}
tips = glance.get('tips') or []
n, peer = peer_glance(glance.get('activity'))

parts = ['papercusp']
mode = wake.get('default')
staged = wake.get('stagedTotal') or 0
if mode in ('auto', 'manual'):
    glyph = '▶ auto' if mode == 'auto' else '⏸ manual'
    parts.append(glyph + (f' ✉{staged}' if staged else ''))
if bees:
    parts.append(f'🐝{bees}')
if gov.get('anyPaused'):
    keys = ','.join(p.get('key', '?') for p in (gov.get('paused') or []))
    parts.append(f'⏳ {keys}'[:40])
parts.append(f'{n} peer{"" if n == 1 else "s"}' if n else 'solo')
if peer is not None:
    p = peer_part(peer)
    if p:
        parts.append(p)

lines = [' · '.join(parts)]
if tips:
    tip = tips[0]
    text = (tip.get('text') or '').strip()
    cmd = (tip.get('command') or '').strip()
    if text:
        lines.append(('💡 ' + text + (f' {cmd}' if cmd else '')).rstrip())
emit(lines, cols)
PYEOF
