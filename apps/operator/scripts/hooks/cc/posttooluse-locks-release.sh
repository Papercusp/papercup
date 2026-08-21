#!/usr/bin/env bash
# PostToolUse hook — release the lock the matching PreToolUse hook
# acquired. SHARED by Claude Code and Codex (same hook wire format).
#
# Reads the cached lock_id from
#   $PAPERCUSP_LOCKS_CACHE_DIR/<tool_use_id>.lock
# and calls locks:release. If the cache is missing (Pre didn't run, or
# already released) we no-op. Always exit 0 — surfacing release noise to
# the agent changes nothing, and the lock's TTL covers any missed
# release anyway.
#
# EI-63: ALSO reads the sidecar $PAPERCUSP_LOCKS_CACHE_DIR/<tool_use_id>.paths
# (written by the matching PreToolUse's _grant()) and, when present, passes it
# as `paths` alongside `lock_id` — scoping the release to exactly the path(s)
# this edit's acquire covered, rather than every path under that lock_id. This
# matters when the server REUSED an existing explicit multi-file lock_id for
# this grant (the owner already held one of these paths under a separate
# deliberate locks:acquire): a bare lock_id release would otherwise delete the
# whole explicit hold, not just this one path. Missing/unreadable sidecar
# falls back to the prior lock_id-only release (unchanged behavior).

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
# Managed sessions may receive either the operator origin or its full MCP
# endpoint. Normalize to the origin because the hook appends /api/mcp below.
OPERATOR_URL="${OPERATOR_URL%%/api/mcp*}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
CACHE_DIR="${PAPERCUSP_LOCKS_CACHE_DIR:-${HOME}/.papercusp/locks-cache}"

if [ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]; then
  exit 0
fi

TOKEN=$(cat "$TOKEN_PATH")
AGENT_ID=$(cat "$AGENT_ID_PATH")
INPUT=$(cat)

# Fail-open backstop: release is best-effort (TTL covers a missed one), so
# never let a Python error exit non-zero from this hook.
python3 - "$INPUT" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" "$CACHE_DIR" <<'PYEOF' || exit 0
import json, os, re, sys, time, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

raw, operator_url, token, agent_id, cache_dir = sys.argv[1:6]


def write_marker(name, value):
    try:
        path = os.path.join(cache_dir, name)
        tmp = path + '.tmp-' + str(os.getpid())
        with open(tmp, 'w') as f:
            f.write(json.dumps(value))
        os.replace(tmp, path)
    except Exception:
        pass


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


try:
    payload = json.loads(raw)
except Exception:
    sys.exit(0)

tool_use_id = payload.get('tool_use_id', '')
if not isinstance(tool_use_id, str) or not tool_use_id:
    sys.exit(0)

# Claude's PreToolUse batch path writes a marker for every native edit before
# allowing any member of the batch to run.  Those edits share one union lock;
# releasing one member here would reopen the union while sibling edits are
# still in flight.  The matching PostToolBatch hook owns the single release.
# Codex has no .batch marker and keeps the original per-call lifecycle.
batch_marker_path = os.path.join(cache_dir, tool_use_id + '.batch')
if os.path.exists(batch_marker_path):
    sys.exit(0)

# Identity MUST match the acquirer (the release owner-check requires
# owner == acquirer). PreToolUse resolves PAPERCUSP_SID → session_id →
# agent_id, in that order; mirror it exactly so release matches acquire.
env_sid = os.environ.get('PAPERCUSP_SID')
lock_sid = os.environ.get('PAPERCUSP_LOCK_SID')
session_id = payload.get('session_id')


def diagnostic_lock_sid():
    try:
        codex_home = os.environ.get('CODEX_HOME')
        if not codex_home:
            return None
        with open(os.path.join(codex_home, 'papercusp-diagnostics.json')) as f:
            value = json.load(f).get('lockOwnerSid')
        return value if isinstance(value, str) and value else None
    except Exception:
        return None


owner = (
    lock_sid if isinstance(lock_sid, str) and lock_sid
    else diagnostic_lock_sid() or (
    env_sid if isinstance(env_sid, str) and env_sid
    else session_id if isinstance(session_id, str) and session_id
    else agent_id)
)


def owner_marker_name(kind):
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', owner)[:160] or 'unknown'
    return 'owner-' + safe + '-last-' + kind + '.json'

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

# EI-63: scope the release to the SPECIFIC path(s) this edit's matching
# PreToolUse acquire covered, when cached (see _grant() in
# pretooluse-locks-acquire.sh). Releasing by lock_id ALONE deletes every path
# under that lock_id — harmless when the lock_id is fresh/unshared (today's
# common case), but WRONG when the server reused an existing EXPLICIT
# multi-file lock_id for this grant (the owner already held one of these
# paths): a bare lock_id release would then silently drop the rest of that
# explicit hold too. Missing/unreadable sidecar (e.g. a cache entry written
# before this fix) falls back to the prior lock_id-only release — unchanged
# behavior, never a regression.
paths_cache_path = os.path.join(cache_dir, tool_use_id + '.paths')
release_paths = None
try:
    with open(paths_cache_path) as f:
        loaded = json.load(f)
    if isinstance(loaded, list) and loaded and all(isinstance(p, str) for p in loaded):
        release_paths = loaded
except Exception:
    pass

# The matching PreToolUse may have acquired through an operator serving a
# different checkout than the edited tree. Carry its physical repo domain
# across the release call; otherwise the release would look in the operator's
# own domain and strand the real lock until TTL.
domain_cache_path = os.path.join(cache_dir, tool_use_id + '.domain')
coordination_domain = None
try:
    with open(domain_cache_path) as f:
        loaded_domain = f.read().strip()
    if loaded_domain:
        coordination_domain = loaded_domain
except Exception:
    pass

release_args = {'lock_id': lock_id}
if release_paths:
    release_args['paths'] = release_paths
if coordination_domain:
    release_args['coordination_domain'] = coordination_domain

body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'locks:release', 'arguments': release_args},
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


# EI-1400: a single-shot release used to give up instantly on ANY transport
# error (including a transient connection-refused during the :3070 restart
# window that follows a lib/** edit — the host has no hot-reload, so an
# operator-code change forces exactly this few-second refuse-then-accept
# window per repo-conventions' two-port model). Silently dropping the
# release there strands the lock SERVER-SIDE for the full 1200s acquire TTL
# (ttl_sec=1200 in the matching PreToolUse hook) even though the edit itself
# finished instantly — to a second agent editing a disjoint file in the same
# directory this reads as prolonged "coarse" blocking on a specific file,
# not a one-off miss. Mirror the PreToolUse hook's own bounded
# connection-refused retry (same backoff shape) so a short restart window
# doesn't turn into a ~20-minute stray lock. Any non-refused error still
# fails open immediately (best-effort; TTL still covers a genuine miss).
def _is_conn_refused(exc):
    if isinstance(exc, ConnectionRefusedError):
        return True
    if isinstance(getattr(exc, 'reason', None), ConnectionRefusedError):
        return True
    s = str(exc)
    return 'Connection refused' in s or 'Errno 111' in s


RETRY_BACKOFFS = (0.4, 0.8, 1.2)
_last_exc = None
_released = False
for _attempt in range(len(RETRY_BACKOFFS) + 1):
    try:
        urllib.request.urlopen(req, timeout=10).read()
        _released = True
        break
    except Exception as e:
        _last_exc = e
        if _is_conn_refused(e) and _attempt < len(RETRY_BACKOFFS):
            time.sleep(RETRY_BACKOFFS[_attempt])
            continue
        break

if _released:
    value = {'ts': now_iso(), 'owner': owner}
    write_marker('last-success.json', value)
    write_marker(owner_marker_name('success'), value)
else:
    # Best-effort; TTL covers a missed release. Record for /coord health.
    value = {
        'ts': now_iso(), 'handler': 'posttooluse', 'phase': 'connect',
        'detail': str(_last_exc)[:200], 'operator_url': operator_url,
        'owner': owner,
    }
    write_marker('last-error.json', value)
    write_marker(owner_marker_name('error'), value)

try:
    os.remove(cache_path)
except Exception:
    pass
try:
    os.remove(paths_cache_path)
except Exception:
    pass
try:
    os.remove(domain_cache_path)
except Exception:
    pass

sys.exit(0)
PYEOF
