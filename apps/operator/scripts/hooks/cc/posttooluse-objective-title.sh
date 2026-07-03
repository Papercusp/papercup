#!/usr/bin/env bash
# PostToolUse hook — set the TERMINAL TITLE to this session's FULL fleet identity
# (session-objective-display-2026-06-22 P-003/P-004; extended to full title parity
# 2026-07-03, WI-1963 #3). Codex and OMP have no bottom status pane (that's a
# Claude-Code-only TUI feature), but they DO own a tty — so we emit an OSC-0 title
# escape (ESC ] 0 ; <title> BEL) carrying the SAME `term_title` the Claude statusline
# writes: fleets (👑/👤 + colour squares) · loop chip · model·effort · id · objective,
# all from `coord:glance` (+ the launch model spec in PAPERCUSP_MODEL, since these CLIs
# have no live model object like Claude's statusline stdin). So a human reading the tab /
# window title sees the full fleet/model/loop/objective state — parity with Claude's
# title — with no LLM file-writing. The render (term_title) is kept byte-identical to
# statusline-fleet.sh; objective-title-parity.test.ts guards the two against drift.
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
  python3 - "$OPERATOR_URL" "$TOKEN" "${PAPERCUSP_SID:-fixture}" "${PAPERCUSP_OBJECTIVE_FIXTURE:-}" "$TITLE_TTY" "${PAPERCUSP_MODEL:-}" <<'PYEOF'
import json, sys, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

operator_url, token, me, fixture, title_tty = sys.argv[1:6]
model_spec = sys.argv[6] if len(sys.argv) > 6 else ''  # PAPERCUSP_MODEL launch spec — codex/omp have no live model object
HTTP_TIMEOUT = 1.5


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


# ── Title assembly — kept BYTE-IDENTICAL to statusline-fleet.sh's term_title so a codex/omp
#    title and a Claude title render the SAME for the same glance + model (WI-1963 full title
#    parity). Guarded by objective-title-parity.test.ts (a drift there fails CI). The Claude
#    side sources the model from its LIVE stdin object; this side from the launch spec env —
#    but the RENDER (term_title) is one shared shape. ──
def self_short(owner):
    owner = str(owner or '').strip()
    if not owner or owner == 'fixture':
        return ''
    bits = owner.split('-')
    if len(bits) >= 2 and bits[1]:
        return f'{bits[0]}-{bits[1][:5]}'
    return owner[:8]


def fmt_interval(sec):
    try:
        s = int(sec)
    except Exception:
        return '?'
    if s < 60:
        return f'{s}s'
    m = s // 60
    if m < 60:
        return f'{m}m'
    h, rm = m // 60, m % 60
    return f'{h}h' if rm == 0 else f'{h}h{rm}m'


def fleets_part(g):
    if not isinstance(g, dict):
        return ''
    fleets = (g.get('self') or {}).get('fleets')
    if not isinstance(fleets, list) or not fleets:
        return ''
    chips = []
    for f in fleets[:4]:
        if not isinstance(f, dict):
            continue
        label = str(f.get('label') or f.get('slug') or '').strip()
        if not label:
            continue
        if len(label) > 16:
            label = label[:15] + '…'
        glyph = '👑' if f.get('role') == 'leader' else '👤'
        square = str(f.get('square') or '').strip()
        chips.append(f'{glyph} {label}{(" " + square) if square else ""}')
    if not chips:
        return ''
    seg = ' · '.join(chips)
    more = len(fleets) - len(chips)
    if more > 0:
        seg += f' +{more}'
    return seg


def _compact_model(*names):
    onem = False
    fam = ''
    for n in names:
        s = str(n or '').lower()
        if not s:
            continue
        if '1m' in s:
            onem = True
        if not fam:
            for f in ('opus', 'sonnet', 'haiku', 'fable'):
                if f in s:
                    fam = f
                    break
    if not fam:
        for n in names:
            s = str(n or '').strip()
            if s:
                fam = s.split()[0].split('-')[0].lower()
                break
    return (fam + ('[1m]' if onem else '')) if fam else ''


def model_title(label, effort):
    return '/'.join(x for x in (label, effort) if x)


def model_tag_from_spec(spec):
    """Compact model tag ('opus[1m]/xhigh') from the psu --model SPEC (e.g. 'opus[1m]:xhigh').
    Mirrors the Claude statusline's model_title(_compact_model(display_name/id), effort) so both
    CLIs render the SAME tag — the Claude side sources the model from its live stdin object, the
    codex/omp side from the launch spec env, but the model RENDER is identical."""
    s = str(spec or '').strip()
    if not s:
        return ''
    c = s.rfind(':')
    effort = ''
    base = s
    if c > 0 and s[c + 1:] in ('low', 'medium', 'high', 'xhigh', 'max'):
        effort = s[c + 1:]
        base = s[:c]
    return model_title(_compact_model(base), effort)


def term_title(g, model_tag=''):
    me_id = self_short(me)
    bits = []
    fl = fleets_part(g)
    if fl:
        bits.append(fl)
    lp = (g.get('self') or {}).get('loop') if isinstance(g, dict) else None
    if isinstance(lp, dict) and lp.get('active'):
        tag = f'⟳{fmt_interval(lp.get("intervalSec"))}'
        if lp.get('reachable') is False:
            tag += '!'
        bits.append(tag)
    if model_tag:
        bits.append(model_tag)
    if me_id:
        bits.append(me_id)
    obj = (g.get('self') or {}).get('objective') if isinstance(g, dict) else None
    if isinstance(obj, str) and obj.strip():
        o = obj.strip()
        bits.append(o[:40] + ('…' if len(o) > 40 else ''))
    return ' · '.join(bits)


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

    # Full title = the SAME assembly the Claude statusline writes (fleets 👑/👤 + colour
    # squares, loop chip, model·effort, id, objective) — WI-1963 title parity. The model
    # comes from the launch spec env (codex/omp have no live model object like CC's stdin).
    title = term_title(glance, model_tag_from_spec(model_spec))
    # Strip control chars that could break out of the OSC string (defensive).
    title = ''.join(c for c in title if ord(c) >= 32 and c not in '\x07\x1b')
    if not title:
        sys.exit(0)
    # OSC 0 sets BOTH the icon name and the window title: ESC ] 0 ; <text> BEL.
    osc = '\033]0;' + title + '\007'
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
