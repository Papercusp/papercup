#!/usr/bin/env bash
# PostToolUse hook — set the TERMINAL TITLE to this session's CURRENT objective
# (session-objective-display-2026-06-22, P-003/P-004). The cross-CLI counterpart
# of the Claude statusline's leading 🔭 segment: Codex and OMP have no statusline,
# but they DO own a tty, so we emit an OSC-0 title escape (ESC ] 0 ; <obj> BEL)
# carrying the same `coord:glance` `self.objective` (this session's in-execution
# work-item title ?? declared coord intent). The human reading the terminal tab /
# window title sees what THIS session is working on, tracking coordination state
# with no LLM file-writing.
#
# SHARED by Codex AND OMP (the same `cc/` shell contract the lock/activity hooks
# use): both fire PostToolUse with a minimal env and own a controlling tty. We
# write the escape to the TTY directly (/dev/tty), NOT stdout — hook stdout goes
# to the harness, never the screen, so a title written there would be invisible
# (and could corrupt the tool result). The CLIENT owns the tty; this hook only
# nudges its title.
#
# FIRE-AND-FORGET + FAIL-OPEN: one short coord:glance read; on any trouble
# (operator down/slow, no objective, no tty) it emits nothing and exits 0. NEVER
# blocks the tool stream, NEVER writes to stdout. Set PAPERCUSP_OBJECTIVE_SYNC=1
# to run synchronously (tests).
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID set + su-token present),
# exactly like the coord-inbox / activity hooks; a plain codex/omp elsewhere has
# no PAPERCUSP_SID and bails instantly.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# psu-session + install gate (mirror posttooluse-activity-report.sh). In test mode
# a glance-shaped payload in $PAPERCUSP_OBJECTIVE_FIXTURE drives the render with no
# operator/token.
if [ -z "${PAPERCUSP_OBJECTIVE_FIXTURE:-}" ]; then
  if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
    exit 0
  fi
  TOKEN=$(cat "$TOKEN_PATH")
else
  TOKEN=""
fi

# Drain stdin (the PostToolUse event JSON) so the pipe closes cleanly; we key off
# the env + coord:glance, not the tool payload.
INPUT="$(cat 2>/dev/null || true)"

# Where the title escape goes. The client owns the tty; default to /dev/tty (the
# controlling terminal of the codex/omp process tree). Overridable for tests.
TITLE_TTY="${PAPERCUSP_OBJECTIVE_TTY:-/dev/tty}"

# Read coord:glance self.objective and (when present + non-blank) write the OSC-0
# title escape DIRECTLY to the tty from python — the title IO lives in python (the
# activity-hook pattern), NOT in a fragile `$(...)`-around-heredoc command
# substitution. Kept in a function so the SYNC + DETACHED paths share one body; the
# `|| true` at the call sites keeps any crash fail-open.
set_title() {
  python3 - "$OPERATOR_URL" "$TOKEN" "${PAPERCUSP_SID:-fixture}" "${PAPERCUSP_OBJECTIVE_FIXTURE:-}" "$TITLE_TTY" <<'PYEOF'
import json, sys, urllib.request, urllib.parse

operator_url, token, me, fixture, title_tty = sys.argv[1:6]
HTTP_TIMEOUT = 1.5
OBJECTIVE_MAX = 60  # a window/tab title is short — clip a verbose objective.


def call_glance():
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': 'coord:glance',
                                  'arguments': {'audience': 'user', 'activity_limit': 0}}}).encode()
    req = urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&client=' + urllib.parse.quote(me, safe=''),
        data=body,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream'},
        method='POST')
    raw = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read().decode('utf-8', 'replace')
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


try:
    glance = None
    try:
        if fixture:
            with open(fixture) as f:
                glance = json.load(f)
        else:
            glance = call_glance()
    except Exception:
        glance = None

    if not isinstance(glance, dict):
        sys.exit(0)
    obj = (glance.get('self') or {}).get('objective')
    if not isinstance(obj, str):
        sys.exit(0)
    obj = obj.strip()
    if not obj:
        sys.exit(0)
    if len(obj) > OBJECTIVE_MAX:
        obj = obj[:OBJECTIVE_MAX - 1].rstrip() + '…'
    # Strip control chars that could break out of the OSC string (defensive — the
    # objective is operator-controlled, but a title escape must stay well-formed).
    obj = ''.join(c for c in obj if ord(c) >= 32 and c not in '\x07\x1b')
    if not obj:
        sys.exit(0)
    # OSC 0 sets BOTH the icon name and the window title: ESC ] 0 ; <text> BEL.
    osc = '\033]0;🔭 ' + obj + '\007'
    # Write straight to the tty (the client owns it). A piped/headless session has
    # no controlling tty → the open fails and we fail open (no title set).
    try:
        with open(title_tty, 'w') as tty:
            tty.write(osc)
    except Exception:
        sys.exit(0)
except Exception:
    sys.exit(0)
PYEOF
}

if [ -n "${PAPERCUSP_OBJECTIVE_SYNC:-}" ]; then
  set_title >/dev/null 2>&1 || true
else
  ( set_title >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi
exit 0
