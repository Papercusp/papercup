#!/usr/bin/env bash
# PreToolUse hook — gate raw `Bash` commands against the named-resource lock
# registry (plan named-resource-locks-drain, P-026/D-013). When a command
# would collide with an in-flight EXCLUSIVE hold on a registered resource
# (e.g. a peer is mid `dev:restart`), block it; otherwise proceed.
#
# ALSO: the native-scheduler lockout (native-scheduler-lockout-2026-06-09
# P-010) — when this session is an AGENT session (PAPERCUSP_AGENT_SESSION=1:
# role panes, the brain/Queen; the owner's own sessions never set it), deny
# persistent OS schedulers (crontab/at/batch/systemd-run) at command position.
# Local regex, no HTTP. Catches the compound forms (`cd x && crontab …`) the
# launch-time Bash(crontab:*) prefix deny-patterns can't. Wakes belong in the
# harness routines table (hive:declare-wake) — the only scheduler that
# Pause/hive:status/the liveness backstop can see.
#
# Cheap by design: a local keyword pre-filter lets the overwhelming majority
# of commands (ls/git/grep/…) return immediately with NO HTTP call. Only a
# command that looks destructive (systemctl/overmind/psql/npm run dev) is
# checked against the operator via locks:check_command.
#
# Fail-open everywhere: not installed, operator unreachable, or any parse
# error → ALLOW (cooperative enforcement only works while the system is up).
# Only an explicit decision === 'block' denies.
#
# NOTE: the pre-filter tokens mirror the seeded resources' match_patterns; a
# new resource with a novel pattern needs a token added here (or drop the
# pre-filter to always-check). Decision logic is server-side (registry-driven).

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"

if [ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]; then
  exit 0
fi

TOKEN=$(cat "$TOKEN_PATH")
AGENT_ID=$(cat "$AGENT_ID_PATH")
INPUT=$(cat)

python3 - "$INPUT" "$OPERATOR_URL" "$TOKEN" "$AGENT_ID" <<'PYEOF' || { echo '[resource-gate] hook error — allowing (fail-open)' >&2; exit 0; }
import json, os, re, sys, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

raw, operator_url, token, agent_id = sys.argv[1:5]

def allow():
    sys.exit(0)

def deny(reason):
    json.dump({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': reason,
    }}, sys.stdout)
    sys.exit(0)

try:
    payload = json.loads(raw)
except Exception:
    allow()

tool_name = payload.get('tool_name', '') or ''
tool_input = payload.get('tool_input', {})
# 'Bash' is claude's name; exec_command/local_shell/shell are codex's shell
# tool names (the codex hooks.json attaches this script too — README table).
if tool_name.lower() not in ('bash', 'exec_command', 'local_shell', 'shell'):
    allow()

command = tool_input.get('command') if isinstance(tool_input, dict) else None
if not isinstance(command, str) or not command.strip():
    allow()

# Native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010): agent
# sessions must not create persistent OS schedules — a crontab entry outlives
# the hive as a zombie wake source that Pause/hive:status/the liveness
# backstop can't see. Command-position match (start / after ;&|/newline /
# sudo) so prose args ("look at this") never false-positive. Local decision,
# no HTTP; the owner's own sessions never carry the marker (D-003).
if os.environ.get('PAPERCUSP_AGENT_SESSION') == '1' and re.search(
        r'(?:^|[;&|\n]\s*|\bsudo\s+)(?:crontab|at|batch|systemd-run)\b', command):
    deny(
        'native-scheduler lockout: agent sessions must not create OS schedules '
        '(crontab / at / batch / systemd-run). Declare your wake via '
        'pot:declare-wake instead — the routines table is the only scheduler '
        "the hive's pause/status/liveness machinery can see."
    )

# Destructive tree-wide git guard (hive-loop-supervision-2026-06-21): a
# pathspec-less `git reset --hard` / `git checkout|restore .` (or `:/`) /
# `git clean -f*` / `git stash` on the SHARED staging checkout discards EVERY
# concurrent agent's UNCOMMITTED work — edits sit unstaged until the next
# git-sync tick, so the loss is UNRECOVERABLE (git never made a blob; kopia
# backs up workspace-state, ~14KB, NOT the code). Confirmed wiping a tested
# in-flight fix on 2026-06-21 (an agent "cleaning the tree" between commits) —
# the root of the recurring "my edits got reverted/overwritten" reports.
#
# GATE ON THE TREE, NOT THE MARKER (EI-7872, 2026-07-06): this block was gated
# on `PAPERCUSP_AGENT_SESSION == '1'`, but that env marker is silently ABSENT
# in fleet-launched sessions (fleet:launch-on-plan → the drain fleet) — VERIFIED
# unset in the Claude PROCESS env (env A, what THIS hook inherits — read from
# /proc/<pid>/environ, not just the Bash sub-shell), so the sole rail against
# fleet-wide uncommitted-work loss was INERT (fail-OPEN) for exactly the sessions
# it must protect. The resource being protected is the canonical SHARED staging
# checkout, so gate on THAT directly: fire when the command runs IN that tree
# (payload `cwd`, read the same way the sibling lock hook does), independent of
# any env marker. The owner's OWN separate checkouts (papercup-release, other
# worktrees) have a different cwd and stay exempt — the real D-003 intent, keyed
# by TREE not marker (and nobody, owner included, should reset --hard the shared
# concurrent tree). The marker is still honored as an OR-trigger, so any launch
# path that DOES set it stays covered even outside the tree. Local decision, no
# HTTP. Per-segment + start-anchored (re.match after splitting on ;&|newline and
# stripping wrappers) so `cd x && git reset --hard` is caught but `echo "…"` is not.
def _cmd_in_canonical_tree():
    # True when the command's working dir is the canonical shared staging tree
    # (or under it). cwd from the hook payload, falling back to the hook
    # process cwd for shells that don't pass one (codex). realpath-compared so
    # a symlinked checkout still matches; the `+ os.sep` guard stops a sibling
    # like `papercusp-staging` from matching `papercusp`. Fail-open on our own
    # error (a hook must never wedge every bash command).
    try:
        _cwd = os.path.realpath(payload.get('cwd') or os.getcwd())
        _ws_root = os.path.realpath(
            os.environ.get('PAPERCUSP_WORKSPACE_ROOT')
            or os.path.expanduser('~/papercupai-workspace'))
        _canon = os.path.realpath(
            os.environ.get('PAPERCUSP_CANONICAL_TREE')
            or os.path.join(_ws_root, 'papercusp'))
        return _cwd == _canon or _cwd.startswith(_canon + os.sep)
    except Exception:
        return False

if os.environ.get('PAPERCUSP_AGENT_SESSION') == '1' or _cmd_in_canonical_tree():
    _GIT = r'git\b(?:\s+-C\s+\S+|\s+-c\s+\S+|\s+--git-dir\S*|\s+--work-tree\S*)*\s+'
    _git_deny = (
        'shared-tree guard: `{op}` would discard EVERY concurrent agent\'s '
        'UNCOMMITTED work on the shared staging checkout — edits sit unstaged '
        'until the next git-sync tick, so the loss is UNRECOVERABLE (no git blob; '
        'kopia backs up workspace-state, not code). This wiped a tested in-flight '
        'fix on 2026-06-21. To discard only YOUR change to ONE file, re-edit it by '
        'hand or run `git checkout -- <that.one.file>` with an EXPLICIT path — '
        'never a pathspec-less reset/checkout/clean/stash. If you wanted a clean '
        "tree, you don't need one: stop editing and let git-sync commit."
    )
    # Peel leading command WRAPPERS so a wrapped destructive op can't bypass the
    # guard — PROVEN 2026-07-06: the guard denied `git reset --hard` but ALLOWED
    # `rtk git reset --hard` (rtk = the token-killer output filter, which rewrites
    # `git …`→`rtk git …`). `time`/`env`/`nice`/`command`/`nohup`/`sudo` were the
    # same latent class. Bounded loop peels nested wrappers (`time rtk git …`).
    _WRAP_STRIP = re.compile(
        r'^\s*(?:'
        r'sudo(?:\s+(?:-[ugpUrCht]\s+\S+|-[A-Za-z]+|--[\w-]+(?:=\S*)?))*'
        r'|env(?:\s+[A-Za-z_]\w*=\S*)*'
        r'|nice(?:\s+-n\s*-?\d+)?'
        r'|ionice(?:\s+-\w+(?:\s+\d+)?)*'
        r'|xargs(?:\s+-\w+)*'
        r'|rtk|time|command|nohup|exec|setsid|nocorrect|stdbuf|doas|nocache'
        r')\s+'
    )

    def _unwrap(_x):
        for _ in range(8):
            _y = _WRAP_STRIP.sub('', _x, count=1)
            if _y == _x:
                return _x
            _x = _y
        return _x

    for _seg in re.split(r'[;&|\n]', command):
        _s = _unwrap(_seg.strip())
        if re.match(_GIT + r'reset\b.*--hard\b', _s):
            deny(_git_deny.format(op='git reset --hard'))
        if re.match(_GIT + r'clean\b.*-\w*f', _s):
            deny(_git_deny.format(op='git clean -f'))
        if re.match(_GIT + r'(?:checkout|restore)\b.*\s(?:\.|:/)(?:\s|$)', _s):
            deny(_git_deny.format(op='git checkout/restore .'))
        if re.match(_GIT + r'stash\b(?!\s+(?:pop|apply|list|show|drop|branch|clear))', _s) and ' -- ' not in _s:
            deny(_git_deny.format(op='git stash'))

# Cheap local pre-filter — skip the HTTP round-trip for the 99% of commands
# that can't touch a registered resource. Tokens mirror the seeded patterns.
if not re.search(r'systemctl|overmind|psql|astro|build-desktop-sidecar|release-local|npm\s+run\s+(dev|build)', command):
    allow()

# Per-session owner (so the caller's OWN exclusive doesn't gate their own
# commands) — same precedence the file-lock hook uses.
env_sid = os.environ.get('PAPERCUSP_SID')
session_id = payload.get('session_id')
owner = (
    env_sid if isinstance(env_sid, str) and env_sid
    else session_id if isinstance(session_id, str) and session_id
    else agent_id
)

body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'locks:check_command', 'arguments': {'command': command}},
}).encode()

req = urllib.request.Request(
    operator_url.rstrip('/') + '/api/mcp?superuser=1&client='
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
    resp = urllib.request.urlopen(req, timeout=4)
    raw_resp = resp.read().decode('utf-8', errors='replace')
except Exception as e:
    print(f'[resource-gate] operator unreachable ({e}); allowing (fail-open)', file=sys.stderr)
    allow()

result = None
for line in raw_resp.splitlines():
    line = line.strip()
    if not line or line.startswith('event:'):
        continue
    if line.startswith('data:'):
        line = line[5:].strip()
    try:
        cand = json.loads(line)
        if isinstance(cand, dict) and 'result' in cand:
            result = cand['result']
            break
    except Exception:
        pass
if not result:
    allow()

inner = None
for item in (result.get('content') or []):
    if item.get('type') == 'text':
        try:
            inner = json.loads(item['text'])
            break
        except Exception:
            continue
if not inner or inner.get('decision') != 'block':
    allow()

matched = inner.get('matched') or []
names = ', '.join(m.get('resource', '?') for m in matched) or 'a registered resource'
deny(
    f"resource-gate: this command touches {names}, which has an exclusive hold "
    f"in flight (a peer is restarting/migrating it). Wait for the 'back up' "
    f"broadcast, or coordinate via locks:list / locks:acquire_resource. "
    f"Use the blessed wrapper (dev:restart / db:migrate) instead of a raw command."
)
PYEOF
