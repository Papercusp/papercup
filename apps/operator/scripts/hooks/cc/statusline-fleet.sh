#!/usr/bin/env bash
# Claude Code statusline — render a compact CROSS-CLI FLEET glance from
# `coord:glance` (papercusp-worker-integration-2026-06-04 D-005 + the
# coord-glance combined read, 2026-06-12). Two lines:
#
#   🔭 wire objective display · papercusp · ◇ su-9859e · ⏸ manual ✉2 · 🐝1 · 5 peers · ◆ su-074be ✎ catalog.ts
#   💡 Wake mode is manual — 2 staged wakes waiting; … /mcp__papercusp-su__tool:coord:wake-mode mode=auto
#   ⋯ run /mcp__papercusp-su__tool:coord:glance for detail
#
# Line 1 LEADS with this session's CURRENT objective (🔭 <objective> — its
# in-execution work-item title ?? declared coord intent, from the glance
# payload's `self.objective`; session-objective-display-2026-06-22) so the human
# sees WHAT this terminal is doing before the fleet shorthand. Then THIS agent's
# own papercusp shorthand id (◇ <id> — the coord ownerLabel
# form, e.g. ◇ su-9859e, so a human can correlate the terminal with coord/fleet
# tools; paired with the ◆ filled-diamond that marks the most-recent PEER),
# wake-gate state (▶ auto / ⏸ manual, ✉ staged wakes), bees in flight,
# governor pauses, peer count + most-recent peer action. Line 2 (only when the
# server has a tip for this state): the top contextual tip from the glance tips
# engine, usually with the slash command that resolves it. Line 3 (only when a
# tip is shown): a ⋯ affordance pointing at the full `coord:glance` dump — the
# statusline itself has no expand affordance and clips line 1 to fit, so this is
# how a human reaches the unabridged state.
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

python3 - "$OPERATOR_URL" "$TOKEN" "${PAPERCUSP_SID:-fixture}" "${PAPERCUSP_STATUSLINE_FIXTURE:-}" "$INPUT" <<'PYEOF' 2>/dev/null || exit 0
import json, os, sys, textwrap, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

operator_url, token, me, fixture = sys.argv[1:5]
stdin_raw = sys.argv[5] if len(sys.argv) > 5 else ''  # Claude's piped session JSON (model / cwd / …); '' in fixture/test mode
HTTP_TIMEOUT = 1.5
ACTIVITY_WINDOW = 12  # rows for the peer-glance scan
GATEWAY_URL = os.environ.get('PAPERCUSP_GATEWAY_URL', 'http://127.0.0.1:8788')
OBJECTIVE_MAX = 48  # clip a long objective so the 🔭 segment can't swallow line 1


def call_tool(name, args):
    """One MCP JSON-RPC tools/call → the inner tool payload (or None).

    `format=json` is REQUIRED on the URL (result-format negotiation, P-009): the
    fleet-wide tool-result default is TOON text, which json.loads() below cannot
    parse — without the pin every glance came back unparseable, this returned
    None, and the caller took the legacy double-call fallback on EVERY render
    (~4k wasted activity:recent calls/hour fleet-wide, EI-7029)."""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': name, 'arguments': args}}).encode()
    req = urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&format=json&client=' + urllib.parse.quote(me, safe=''),
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


def self_short(owner):
    """THIS agent's papercusp shorthand id, matching the coord ownerLabel form
    (role prefix + first 5 chars of the uuid body, e.g.
    su-9859ea5e-…→su-9859e) — the id a human sees in coord/fleet tools, so it
    correlates the terminal with the rest of the fleet. '' when there's no real
    session id (e.g. the 'fixture'/unset sentinel)."""
    owner = str(owner or '').strip()
    if not owner or owner == 'fixture':
        return ''
    bits = owner.split('-')
    if len(bits) >= 2 and bits[1]:
        return f'{bits[0]}-{bits[1][:5]}'
    return owner[:8]


def routed_account(owner):
    """The pool account that served THIS session's most-recent turn, from the inference gateway's
    GET /admin/route?owner=<id> (routed-account visibility, 2026-06-22). The gateway strips its routing
    headers before the caller sees them, so this read-back is how a session learns where its turn went.
    Cheap + fail-open: a short timeout, None on any trouble (gateway down / owner unseen / not a psu session)."""
    if not owner or owner == 'fixture':
        return None
    try:
        u = GATEWAY_URL.rstrip('/') + '/admin/route?owner=' + urllib.parse.quote(owner, safe='')
        raw = urllib.request.urlopen(u, timeout=0.6).read().decode('utf-8', 'replace')
        return (json.loads(raw) or {}).get('account')
    except Exception:
        return None


def objective_part(g):
    """The leading 🔭 <objective> segment from the glance payload's `self.objective`
    (session-objective-display-2026-06-22) — this session's CURRENT work-item title ??
    declared coord intent, the single client-agnostic source every CLI status display reads.
    ADDITIVE + FAIL-OPEN: None when the operator predates the field or the objective is
    blank/absent, so the existing render is untouched. Clipped so a verbose objective can't
    crowd out the fleet shorthand on line 1."""
    if not isinstance(g, dict):
        return None
    obj = (g.get('self') or {}).get('objective')
    if not isinstance(obj, str):
        return None
    obj = obj.strip()
    if not obj:
        return None
    if len(obj) > OBJECTIVE_MAX:
        obj = obj[:OBJECTIVE_MAX - 1].rstrip() + '…'
    return f'🔭 {obj}'


def fmt_interval(sec):
    """Compact interval label for the loop chip: 120→'2m', 30→'30s', 3600→'1h', 5400→'1h30m'."""
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


def loop_part(g):
    """The ⟳ <interval> loop chip when THIS session is on an engine loop (loop:arm), from the
    glance payload's `self.loop` (loop-status-display-2026-06-23). ADDITIVE + FAIL-OPEN: None when
    not on a loop, or the operator predates the field, so the existing render is untouched."""
    if not isinstance(g, dict):
        return None
    lp = (g.get('self') or {}).get('loop')
    if not isinstance(lp, dict) or not lp.get('active'):
        return None
    # WI-655: a loop that fired but reached nobody (no-session-now) / whose wake turn died
    # reads `reachable: False` — surface it LOUDLY so a black-holed loop isn't invisible in
    # the bottom display. `reachable` absent (older operator) ⇒ unknown ⇒ no scary text (fail-open).
    if lp.get('reachable') is False:
        return f'⟳ {fmt_interval(lp.get("intervalSec"))} loop ⚠unreachable'
    return f'⟳ {fmt_interval(lp.get("intervalSec"))} loop'


def _session_json(raw):
    """Parse Claude Code's piped session JSON (model / cwd / session_id / …). {} on any trouble — fail-open."""
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _user_settings():
    """~/.claude/settings.json — the persisted `model` + `effortLevel` (what /effort writes). {} fail-open.
    Read ONLY in a real session (the caller gates it off in fixture/test mode) so a dev's settings never
    leak into the deterministic render tests."""
    try:
        with open(os.path.join(os.path.expanduser('~'), '.claude', 'settings.json')) as f:
            v = json.load(f)
            return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _compact_model(*names):
    """A short model label from any candidate string (live model.display_name/id, settings `model`):
    the family word (opus/sonnet/haiku) + a `[1m]` marker for a 1M-context variant (e.g.
    'Opus 4.8 (1M context)' / 'opus[1m]' → 'opus[1m]'). '' when nothing usable."""
    onem = False
    fam = ''
    for n in names:
        s = str(n or '').lower()
        if not s:
            continue
        if '1m' in s:
            onem = True
        if not fam:
            for f in ('opus', 'sonnet', 'haiku'):
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


def model_bits(sj, settings):
    """(label, effort): the compact model label + reasoning-effort setting the human asked to see.
    Model from the live session JSON (model.display_name/id) with settings `model` as fallback; effort
    from settings `effortLevel` (the /effort default) or a session-JSON `effort` if present. Either may
    be '' (unknown) — fail-open."""
    m = sj.get('model') if isinstance(sj.get('model'), dict) else {}
    label = _compact_model(m.get('display_name'), m.get('id'), settings.get('model'))
    effort = str(settings.get('effortLevel') or sj.get('effort') or '').strip()
    return label, effort


def model_chip(label, effort):
    """Statusline-body chip — '🧠 opus[1m]·xhigh'. None when neither bit is known (fixture/test with no
    stdin), so the existing render + tests stay untouched (additive + fail-open)."""
    body = '·'.join(x for x in (label, effort) if x)
    return ('🧠 ' + body) if body else None


def model_title(label, effort):
    """Plain (emoji-free) OS-title segment — 'opus[1m]/xhigh'. '' when neither is known."""
    return '/'.join(x for x in (label, effort) if x)


def term_title(g, model_tag=''):
    """The OSC terminal-title string — LEADS with the loop chip (the surfaced autonomy signal: present ⇒
    a loop is armed, absent ⇒ none), then the model·effort tag (so the titlebar always shows which model
    + settings this terminal is on), the session shorthand id, and a clipped objective. '' when there's
    nothing meaningful (skip the write)."""
    me_id = self_short(me)
    bits = []
    lp = (g.get('self') or {}).get('loop') if isinstance(g, dict) else None
    if isinstance(lp, dict) and lp.get('active'):
        # WI-655: trailing '!' on the title loop chip when the loop is armed but not wake-reachable.
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


def set_title(title):
    """Write the OSC-0 terminal title straight to the controlling TTY (NOT via Claude's stdout,
    which it captures as the statusline body). Fail-open: no tty / not permitted → skip silently."""
    if not title:
        return
    try:
        with open('/dev/tty', 'w') as tty:
            tty.write(f'\033]0;{title}\a')
            tty.flush()
    except Exception:
        pass


def lead():
    """Line-1 prefix segments: 'papercusp', this agent's own ◇ id chip (◇ = self, paired with ◆ =
    most-recent peer), and — when the gateway knows it — ⇢ <account>, the pool account that served this
    session's most-recent turn. Both render paths share it. The 🔭 objective segment (objective_part) is
    prepended by the caller ahead of these, so it leads line 1."""
    me_id = self_short(me)
    parts = ['papercusp', f'◇ {me_id}'] if me_id else ['papercusp']
    acct = routed_account(me)
    if acct:
        parts.append(f'⇢ {acct}')
    return parts


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

# 🧠 <model>·<effort> chip — the model + settings the human asked to see (e.g. opus[1m]·xhigh). Settings
# are read ONLY in a real session (gated off in fixture/test mode) so a dev's ~/.claude/settings.json
# can't leak into the deterministic render tests; the model still comes from the piped session JSON
# there. ADDITIVE + FAIL-OPEN: both bits unknown ⇒ no chip.
_settings = _user_settings() if not fixture else {}
_sj = _session_json(stdin_raw)
_mlabel, _meffort = model_bits(_sj, _settings)
mchip = model_chip(_mlabel, _meffort)
mtitle = model_title(_mlabel, _meffort)

if not isinstance(glance, dict) or 'wake' not in glance:
    # No parseable glance. Fixture mode: an activity-shaped payload (no 'wake'
    # key) exercises the legacy single-line render below — stays testable.
    # LIVE mode: NO second network call. The old `activity:recent` fallback
    # existed for the pre-deploy window before coord:glance shipped
    # (2026-06-12); once the TOON result-format default landed, json.loads()
    # failed on every glance response and this branch silently DOUBLED the
    # statusline's MCP traffic fleet-wide while rendering the degraded legacy
    # line (EI-7029). call_tool now pins format=json, so an unparseable glance
    # means operator trouble — fail open and render nothing, per the header
    # contract.
    if not fixture:
        sys.exit(0)
    data = glance if isinstance(glance, dict) else None
    rows = (data or {}).get('activity')
    if not isinstance(rows, list) or not rows:
        sys.exit(0)
    n, peer = peer_glance(rows)
    # objective_part(glance) is None here (the legacy activity payload carries no
    # self.objective) — but prepend through the same path so the 🔭 segment leads
    # whenever the field IS present, with no special-casing.
    obj = objective_part(glance)
    parts = ([obj] if obj else []) + lead()
    if mchip:
        parts.append(mchip)
    parts.append(f'{n} peer{"" if n == 1 else "s"}' if n else 'solo')
    if peer is not None:
        p = peer_part(peer)
        if p:
            parts.append(p)
    set_title(term_title(glance if isinstance(glance, dict) else {}, mtitle))
    emit([' · '.join(parts)], cols)
    sys.exit(0)

# ── glance render (two lines) ──
wake = glance.get('wake') or {}
bees = (glance.get('bees') or {}).get('running') or 0
gov = glance.get('governor') or {}
tips = glance.get('tips') or []
n, peer = peer_glance(glance.get('activity'))

# 🔭 <objective> LEADS line 1 — what THIS terminal is working on, ahead of the
# fleet shorthand. None (absent/blank/old-operator) → segment simply omitted.
obj = objective_part(glance)
parts = ([obj] if obj else []) + lead()
# ⟳ <interval> loop chip — surfaces that THIS session is on an engine loop (loop:arm) right after
# the self id, so the human sees the autonomy cadence at a glance (loop-status-display-2026-06-23).
lpchip = loop_part(glance)
if lpchip:
    parts.append(lpchip)
# 🧠 <model>·<effort> — the model + settings (e.g. opus[1m]·xhigh) this terminal is running on.
if mchip:
    parts.append(mchip)
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
        # WRAP the tip across rows rather than truncating — the statusline has
        # no expand affordance, so a clipped tip is a lost tip. Long unbroken
        # tokens (the slash command) split rather than vanish. Capped so a
        # pathological tip can't swallow the pane.
        full = ('💡 ' + text + (f' {cmd}' if cmd else '')).rstrip()
        lines.extend(textwrap.wrap(full, width=cols, subsequent_indent='  ')[:4])
        # A statusline can't expand, and line 1 clips the governor list + peer
        # summary to fit — so whenever there's a tip worth surfacing, point at
        # the full structured glance the human can run for the unabridged state.
        lines.append('⋯ run /mcp__papercusp-su__tool:coord:glance for detail')
# Mirror the loop/objective state into the OS terminal title (written straight to /dev/tty so it
# bypasses Claude's stdout capture). Refreshed every statusline tick, so it tracks loop arm/end.
set_title(term_title(glance, mtitle))
emit(lines, cols)
PYEOF
