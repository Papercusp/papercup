#!/usr/bin/env bash
# PostToolUse hook — report a psu worker's native tool call to the cross-CLI
# ACTIVITY BRIDGE (papercusp-worker-integration-2026-06-04, D-003), AND (by
# default) fold in the delta-aware coordination bundle (EI-11405 /
# coordination-hook-rpc-fanout-collapse-2026-07-16) that used to be a
# SEPARATE posttooluse-coord-inbox.sh round trip. Fires after EVERY tool call
# (matcher "*"), so each worker's native tool stream (Edit / Write / Bash /
# Read / apply_patch / Task-todos) is mirrored into harness_shared.agent_activity
# → the pui fleet-status view + the curator, AND any NEW coord:inbox messages
# reach the agent mid-turn — in ONE MCP round trip instead of two.
#
# SHARED by Claude AND Codex (D-002): the same `cc/` shell contract. Claude
# PostToolUse and Codex PostToolUse both deliver JSON on stdin with `tool_name` /
# `tool_input` / `tool_use_id` (or `tool_call_id`) / `session_id` / `cwd`; we read
# whichever shape is present. (Codex PreToolUse doesn't fire on edits — D-006 — but
# PostToolUse DOES, so the activity push works on both.)
#
# PAPERCUSP_COORD_FOLD (default "1" = ON): set to "0" to disable the coord fold
# entirely and fall back to the ORIGINAL plain-report contract — detached
# fire-and-forget (PAPERCUSP_ACTIVITY_SYNC=1 forces sync, for tests), no
# hook_bundle, no cursor file, never any stdout. Claude's global settings.json
# never sets this (every psu Claude session — su or role — wants mid-turn coord
# delivery). Codex's per-session hooks.json (role-codex-home.ts) sets it to "0"
# for a ROLE session with no coordSid (roles coordinate via messages:feature_*,
# not the SU coord bus) so that session keeps its original zero-added-latency
# report path; an SU codex session leaves the fold ON, same as Claude.
#
# WHY THE FOLD PATH IS SYNCHRONOUS (EI-11405 — was fire-and-forget-detached):
# the server's `activity:report` tool accepts an optional `hook_bundle` cursor
# (`{generation}`) and, ONLY when the coordination generation has
# actually advanced since our last call, folds a fresh coord:inbox snapshot
# into the SAME response (packages/operator-core/lib/agent-tools/activity/
# hook-bundle.ts). That is the fix for the RPC fanout this hook + the now-
# deleted posttooluse-coord-inbox.sh together caused: N manual tool calls used
# to pay ~2N automatic round trips (one detached activity report + one
# blocking coord:inbox poll, EVERY call); a coord-folding call now pays exactly
# ONE blocking round trip, and the SERVER performs an O(1) (no extra
# inbox/glance query) hydration whenever nothing changed. To read the folded
# result we must wait for the response — hence synchronous. Bounded by
# HTTP_TIMEOUT below so a slow/wedged operator degrades to "no injection this
# call" rather than stalling the agent's turn.
#
# Per-owner CURSOR (generation only) persists in
# $PAPERCUSP_LOCKS_CACHE_DIR/activity-hook-bundle-<owner>.json — the same
# cache dir + per-owner-file convention the old coord-inbox hook used for its
# `coord-cursor-<owner>.json`. The server owns the inbox floor now; the client
# sends only the generation, so a first call cannot seed itself past unread mail.
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID set + su-token present),
# exactly like the deleted coord-inbox hook. A plain `claude`/`codex` elsewhere has no
# PAPERCUSP_SID and bails instantly. owner == PAPERCUSP_SID (the same id baked
# into the agent's MCP `?client=`), so activity is grouped AND coord is folded
# under the worker's coordination identity.
#
# Output contract (Claude Code PostToolUse), unchanged from the old coord-inbox
# hook: exit 0 with
#   { "hookSpecificOutput": { "hookEventName": "PostToolUse",
#       "additionalContext": "..." } }
# injects context for the model's next step WITHOUT a `decision` (so the
# tool result stands and the model is not stopped). Exit 0 + no stdout =
# no-op. We NEVER block a tool and NEVER exit non-zero on a coord/report
# blip — a reporting or coordination failure fails OPEN.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
CACHE_DIR="${PAPERCUSP_LOCKS_CACHE_DIR:-${HOME}/.papercusp/locks-cache}"
COORD_FOLD="${PAPERCUSP_COORD_FOLD:-1}"

# psu-session gate + install gate.
if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR" 2>/dev/null || true

TOKEN=$(cat "$TOKEN_PATH")
INPUT=$(cat)
AGENT="${PAPERCUSP_AGENT:-}"

# The reporter: build the activity:report args from the hook stdin, POST, and
# — when COORD_FOLD is on — parse the folded coordination bundle from the
# response. Kept in a function so the coord-folding (always sync) and legacy
# plain-report (detached-by-default) call sites share one body. Any crash
# inside fails open (the `|| true` at the call sites) — a reporting/coord blip
# must never affect a tool.
report() {
  python3 - "$INPUT" "$OPERATOR_URL" "$TOKEN" "$PAPERCUSP_SID" "$AGENT" "$CACHE_DIR" "$COORD_FOLD" "${PAPERCUSP_HARNESS_SLUG:-}" "$(dirname "$0")" <<'PYEOF'
import json, os, re, sys, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

raw, operator_url, token, owner, agent, cache_dir, coord_fold_flag, harness_slug, hook_dir = sys.argv[1:10]
sys.path.insert(0, hook_dir)
from mcp_response import parse_mcp_response  # noqa: E402
coord_fold = coord_fold_flag != '0'
HTTP_TIMEOUT = 4
STR_CAP = 500
ACTIVITY_HOOK_BUNDLE_SCHEMA = 'activity-hook-bundle-v1'

try:
    ev = json.loads(raw)
except Exception:
    sys.exit(0)
if not isinstance(ev, dict):
    sys.exit(0)


def first(*keys):
    for k in keys:
        v = ev.get(k)
        if v not in (None, ''):
            return v
    return None


tool_name = first('tool_name', 'toolName') or ''
tool_input = first('tool_input', 'toolInput')
if not isinstance(tool_input, dict):
    tool_input = {}
tool_use_id = first('tool_use_id', 'toolCallId', 'tool_call_id') or ''
session_id = first('session_id', 'sessionId') or ''
cwd = first('cwd') or ''
tool_response = first('tool_response', 'toolResponse')

# Best-effort status from the tool response (shape is tool-specific; only set when
# clearly determinable so we never mislabel).
status = None
if isinstance(tool_response, dict):
    if tool_response.get('is_error') is True or tool_response.get('error'):
        status = 'error'
    else:
        status = 'ok'

# A todo snapshot (Claude TodoWrite / TaskCreate-TaskUpdate, OMP todo_write) rides in
# tool_input.todos — forward it as `todos` so the server summarises it as kind=todos.
todos = tool_input.get('todos') if isinstance(tool_input.get('todos'), list) else None


def cap(v):
    if isinstance(v, str):
        return v if len(v) <= STR_CAP else v[:STR_CAP] + '…'
    if isinstance(v, list):
        return '[%d items]' % len(v)
    if isinstance(v, dict):
        return '[object]'
    return v


args = {
    'owner': owner,
    'phase': 'post',
    'tool_name': tool_name,
    'tool_use_id': tool_use_id,
    'session_id': session_id,
    'cwd': cwd,
}
if agent:
    args['agent'] = agent
if status:
    args['status'] = status
if todos is not None:
    args['todos'] = todos[:100]
else:
    # Cap string fields so a full Write `content` / patch body never bloats the POST.
    args['tool_input'] = {k: cap(v) for k, v in tool_input.items()}
if harness_slug:
    args['harness_slug'] = harness_slug

# ── delta-aware coordination fold (EI-11405) — only when COORD_FOLD is on ──
# Cursor is keyed by PAPERCUSP_SID (per-launch), so a fresh session never
# re-shows old mail and never inherits a stale generation from a prior host.

if coord_fold:
    def cursor_path():
        safe = re.sub(r'[^A-Za-z0-9._-]', '_', owner)[:120]
        return os.path.join(cache_dir, f'activity-hook-bundle-{safe}.json')

    def read_cursor():
        try:
            with open(cursor_path()) as f:
                v = json.load(f)
            gen = v.get('generation')
            return gen if isinstance(gen, str) and gen else None
        except Exception:
            return None

    def write_cursor(gen):
        try:
            p = cursor_path()
            tmp = p + '.tmp-' + str(os.getpid())
            with open(tmp, 'w') as f:
                f.write(json.dumps({'generation': gen}))
            os.replace(tmp, p)
        except Exception:
            pass

    generation = read_cursor()

    args['hook_bundle'] = {
        'generation': generation,
    }

body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'activity:report', 'arguments': args},
}).encode()
req = urllib.request.Request(
    operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&client='
    + urllib.parse.quote(owner, safe=''),
    data=body,
    headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    },
    method='POST',
)
try:
    raw_resp = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read().decode('utf-8', errors='replace')
except Exception:
    sys.exit(0)  # operator unreachable / slow → fail open; a missed report+fold is retried next call.

if not coord_fold:
    sys.exit(0)  # plain report — no response parsing, no output (legacy contract).

inner, _rpc_error, phase = parse_mcp_response(raw_resp)
if phase != 'ok' or not isinstance(inner, dict):
    sys.exit(0)

bundle = inner.get('hook_bundle')
if not isinstance(bundle, dict) or bundle.get('schemaVersion') != ACTIVITY_HOOK_BUNDLE_SCHEMA:
    # No usable bundle (server predates the fold, or errored) — never advance
    # the cursor on a guess; next call retries from the same baseline.
    sys.exit(0)

new_generation = bundle.get('generation')
if not isinstance(new_generation, str) or not new_generation:
    new_generation = None
complete = bundle.get('complete') is True
changed = bundle.get('changed') is True

out_text = None

if changed:
    surfaces = bundle.get('surfaces') if isinstance(bundle.get('surfaces'), dict) else {}
    inbox = surfaces.get('inbox') if isinstance(surfaces, dict) else None
    if isinstance(inbox, dict):
        summ = inbox.get('summary') if isinstance(inbox.get('summary'), dict) else {}
        injection = inbox.get('injection')
        if isinstance(injection, str) and injection.strip():
            out_text = injection
        else:
            # DUMB PIPE parity with the deleted coord-inbox hook (P-015): no new
            # entries, but still surface the ≥80% LOUD context gauge so a
            # heads-down session sees its own usage even on a quiet fold.
            entries = inbox.get('entries')
            if isinstance(entries, list) and not entries:
                gauge = inbox.get('context_gauge')
                if isinstance(gauge, str) and gauge.strip():
                    out_text = gauge

# Only a COMPLETE fold advances the generation — an incomplete one (partial
# hydrate failure) must retry the FULL hydrate next call, mirroring the OMP
# consumer (consumeActivityHookBundle: `bundle.complete ? bundle.generation : null`).
write_cursor(new_generation if complete else None)

if not out_text:
    sys.exit(0)

json.dump({'hookSpecificOutput': {
    'hookEventName': 'PostToolUse',
    'additionalContext': out_text,
}}, sys.stdout)
sys.exit(0)
PYEOF
}

if [ "$COORD_FOLD" = "0" ]; then
  # Legacy plain-report contract: detached fire-and-forget (never any stdout),
  # unless a test forces sync via PAPERCUSP_ACTIVITY_SYNC.
  if [ -n "${PAPERCUSP_ACTIVITY_SYNC:-}" ]; then
    report >/dev/null 2>&1 || true
  else
    ( report >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
  fi
else
  # Coord-folding contract: always synchronous — the response IS the point.
  report || true
fi
exit 0
