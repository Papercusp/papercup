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
import json, os, re, sys, tempfile, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

raw, operator_url, token, agent_id = sys.argv[1:5]

# Soft advisory attached to an ALLOW verdict (coord-delivery-residual-gaps
# P-003). None = plain silent allow; a string rides out as additionalContext
# on an explicit permissionDecision:'allow' payload. Denies always win — the
# advisory only decorates commands every gate already passed.
ADVISORY = None

def allow():
    if ADVISORY:
        json.dump({'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            # Generic on purpose: FOUR different guards now ride this channel
            # (long-foreground-exec, background-pipe exit code, tauri --token,
            # bash→tool substitution), so naming only the first one mislabels
            # the other three. The specific text is in additionalContext.
            'permissionDecisionReason': 'advisory (non-blocking)',
            'additionalContext': ADVISORY,
        }}, sys.stdout)
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

# ── Long-foreground-exec advisory (coord-delivery-residual-gaps P-003) ──────
# A foreground Bash run blocks the session's turn for its whole duration: coord
# messages, wakes, and yields cannot reach the agent until it returns — the
# mid-exec deafness window (see the coord-mid-turn-delivery insight). When the
# caller EXPLICITLY requests a foreground timeout past the 2-min default, that
# is a declared intent to hold the turn for minutes — nudge it toward the
# native background primitive instead. STRICTLY per-backend: only Claude's
# `Bash` tool has `run_in_background` (same-session detach — the harness
# re-invokes the SAME session on exit; no delegation, no context loss), so only
# tool_name 'bash' gets the nudge. Codex shells (exec_command/local_shell/
# shell) have no native background primitive in our integration — no nudge
# (their deafness window is covered by the wake + escalation-ladder legs); OMP
# nudges its own `job` primitive from its own hook, not this script. SOFT by
# design: sets the ADVISORY string only — the command always proceeds, and any
# later deny gate still wins.
try:
    if tool_name.lower() == 'bash':
        _t = tool_input.get('timeout')
        _bg = tool_input.get('run_in_background')
        if not _bg and isinstance(_t, (int, float)) and _t > 120_000:
            ADVISORY = (
                f'long-foreground-exec advisory: this Bash call requests a FOREGROUND '
                f'timeout of {int(_t / 1000)}s. A foreground run holds your turn for its whole '
                f'duration — coord messages, wakes, and yield requests cannot reach you '
                f'until it returns (the mid-exec deafness window). For anything expected '
                f'to run >2min, prefer `run_in_background: true`: it stays in THIS session '
                f'(no delegation, no context loss) — the command detaches, you keep taking '
                f'turns, and you are re-invoked when it exits. Advisory only; this command '
                f'is proceeding as issued.'
            )
except Exception:
    pass  # advisory must never wedge a command

# Native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010): agent
# sessions must not create persistent OS schedules — a crontab entry outlives
# the hive as a zombie wake source that Pause/hive:status/the liveness
# backstop can't see. Command-position match (start / after ;&|/newline /
# sudo) so prose args ("look at this") never false-positive. Local decision,
# no HTTP; the owner's own sessions never carry the marker (D-003).
#
# EI-9937: the ;&|/newline separators in the command-position anchor are SHELL
# operators — but a `;`/`&`/`|` INSIDE a quoted argument is literal data, not a
# separator. So a read-only `grep -E "at|batch" code-run-batch-nudge.ts` (a regex
# alternation naming these very tokens) or a `"...; batch..."` string was denied
# as if it created an OS schedule. Strip quoted spans BEFORE matching: quoted
# content can only ever REMOVE a would-be separator, so every genuine (unquoted)
# `crontab -e`/`batch < f`/`&& crontab`/`sudo crontab` deny is preserved.
def _strip_shell_quotes(s):
    # Replace single- and double-quoted spans with a single space so operators
    # (;&|) inside a quoted arg are not read as command separators, and adjacent
    # tokens are neither glued (a false negative) nor made adjacent to a
    # separator (a false positive). An unterminated quote drops the rest (only
    # ever more permissive). A backslash-escaped quote inside "..." doesn't close.
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == "'":
            j = s.find("'", i + 1)
            if j == -1:
                break
            out.append(' ')
            i = j + 1
        elif c == '"':
            j = i + 1
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == '"':
                    break
                j += 1
            if j >= n:
                break
            out.append(' ')
            i = j + 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)

# ── Piped background exit-code trap advisory (EI-8871/EI-14065) ────────────
# `cmd | tail -N` (or `| head` / `| grep`) run in the background reports the
# harness's completion notification with the PIPE's LAST STAGE exit code, not
# the real command's — tail/head/grep almost always exit 0 regardless of
# whether the upstream command failed, so a failing test/build/rsync/ssh
# silently reads as "completed (exit code 0)". Documented + recurring (first
# EI-8871 2026-07-09, hit again 2026-07-12 on rsync/ssh, filed a THIRD time as
# EI-14065 2026-07-17) — see agent-insights/background-test-pipe-exit-code-trap.
# SOFT by design (never denies): only Claude's `Bash` tool has
# `run_in_background` + a completion notification that summarizes an exit
# code this way, so only tool_name 'bash' is checked. Skipped when the caller
# already handles it (mentions pipefail/PIPESTATUS/an explicit EXIT capture
# anywhere in the command).
try:
    if tool_name.lower() == 'bash' and tool_input.get('run_in_background'):
        _pipe_cmd = _strip_shell_quotes(command)
        # Safety-escape check against the RAW command (not quote-stripped): a
        # real-world safe pattern is often itself inside quotes (e.g.
        # `echo "EXIT=${PIPESTATUS[0]}"`), which quote-stripping would erase.
        if not re.search(r'pipefail|PIPESTATUS|EXIT\s*=\s*\$\?', command):
            # A top-level `|` (not `||`) immediately followed by an
            # EXIT-CODE-MASKING stage (optionally via a path, with flags/args)
            # running to the end of its `;`/`&&`/`||`/newline-delimited segment.
            #
            # EI-18686555459167489: the original list was tail/head/grep only,
            # which let the most natural idiom for a LONG verification run walk
            # straight through — `tsc 2>&1 | tee build.log`, `… | wc -l`,
            # `… | sed -n '1,40p'`, `… | sort | uniq -c`. Every one of those
            # exits 0 no matter what the upstream did, so the notification still
            # reports a false green; the advisory just wasn't there to say so.
            # The underlying truth is that ANY downstream stage replaces the
            # upstream's status, so the stage list is only a heuristic for "the
            # caller probably cares about the upstream's exit code" — it should
            # cover the common text filters, not just the three first observed.
            # (`grep` is doubly hazardous: it exits 1 on NO MATCH, so it can also
            # INVERT a clean run into an apparent failure.)
            _PIPE_TAIL_RE = re.compile(
                r'(?<!\|)\|(?!\|)\s*(?:\S*/)?'
                r'(?:tail|head|grep|egrep|fgrep|tee|wc|sed|awk|sort|uniq|cut|tr'
                r'|jq|column|xargs|cat|tac|nl|less|more)'
                r'\b[^|;&\n]*$'
            )
            for _pseg in re.split(r'&&|\|\||;|\n', _pipe_cmd):
                if _PIPE_TAIL_RE.search(_pseg.strip()):
                    ADVISORY = (
                        'background-pipe exit-code advisory (EI-8871/EI-14065): this '
                        'backgrounded command pipes into tail/head/grep/tee/wc/sed/awk/sort '
                        "— the completion notification will report THAT stage's exit code, "
                        'not the real '
                        'command\'s (those stages exit 0 almost regardless of upstream '
                        'failure), so a failing test/build/rsync/ssh can read as "completed '
                        '(exit code 0)". Redirect to a log file instead (`cmd > '
                        '/tmp/x.log 2>&1`) and read the log/grep it separately, or add `set '
                        '-o pipefail` (and read `${PIPESTATUS[0]}`) if you need the pipe. '
                        'Never trust the notification\'s exit code alone here. Advisory '
                        'only; this command is proceeding as issued.'
                    )
                    break
except Exception:
    pass  # advisory must never wedge a command

# EI-10940: the refusal must answer the INTENT, not the token. `systemd-run` is
# BOTH the scheduler (`--on-calendar=…`) and the only stock way to ask for cgroup
# resource control (`-p CPUQuota=…`, `--scope`). An agent reaching for the SECOND
# one is not scheduling anything — pointing it at `pot:declare-wake` (a WAKE
# scheduler) is a non-sequitur that costs a real debugging detour before it works
# out that the tool it was told to use cannot do the thing it wanted. The deny
# itself is correct either way (agent sessions cannot create transient units), so
# branch only the REASON: name the actual alternatives (`taskset` / pc-heavy.sh).
# Mirrors isResourceLimitInvocation()/osSchedulerDenyReason() in the OMP hook
# (scripts/hooks/omp/coord-hook.ts) — a guard fixed in one path must be fixed in
# both, since Claude/Codex hit THIS one and OMP hits that one.
_SYSTEMD_RESOURCE_PROP_RE = (
    r'(?:-p|--property)[=\s]*'
    r'(?:CPUQuota|CPUWeight|AllowedCPUs|AllowedMemoryNodes|MemoryMax|MemoryHigh'
    r'|MemoryLimit|IOWeight|TasksMax)\b'
    r'|--scope\b'
)
_SYSTEMD_SCHEDULE_FLAG_RE = (
    r'--on-(?:calendar|active|boot|startup|unit-active|unit-inactive)\b'
    r'|--timer-property\b'
)


def _is_resource_limit_invocation(cmd):
    # True only for a `systemd-run` asking for RESOURCE CONTROL, not a schedule.
    # A schedule flag WINS (`systemd-run --on-calendar=… -p CPUQuota=…` really is
    # creating a timer) so the scheduling advice stays correct for the hybrid.
    c = _strip_shell_quotes(cmd)
    if not re.search(r'\bsystemd-run\b', c):
        return False
    if re.search(_SYSTEMD_SCHEDULE_FLAG_RE, c, re.I):
        return False  # scheduling wins
    return bool(re.search(_SYSTEMD_RESOURCE_PROP_RE, c, re.I))


def _os_scheduler_deny_reason(cmd):
    if _is_resource_limit_invocation(cmd):
        return (
            'native-scheduler lockout: agent sessions cannot create transient systemd '
            'units, so cgroup resource control via `systemd-run` is unavailable here. '
            'You are trying to LIMIT RESOURCES, not schedule a wake — use `taskset -c '
            '<cores> <cmd>` to pin CPUs (no scheduler, no root, no daemon), or run heavy '
            'commands through `scripts/pc-heavy.sh` (nice + a concurrency semaphore) on '
            'the shared box. (`pot:declare-wake` is for SCHEDULING and is not what you want.)'
        )
    return (
        'native-scheduler lockout: agent sessions must not create OS schedules '
        '(crontab / at / batch / systemd-run). Declare your wake via '
        'pot:declare-wake instead — the routines table is the only scheduler '
        "the hive's pause/status/liveness machinery can see."
    )


if os.environ.get('PAPERCUSP_AGENT_SESSION') == '1' and re.search(
        r'(?:^|[;&|\n]\s*|\bsudo\s+)(?:crontab|batch|systemd-run)\b'
        r'|(?:^|[;&|\n]\s*|\bsudo\s+)at\s+(?:now|midnight|noon|teatime|\+?\d)',
        _strip_shell_quotes(command)):
    deny(_os_scheduler_deny_reason(command))

# ── systemd user-manager exit/kill guard (EI-13135, 2026-07-17) ─────────────
# `systemctl --user exit` (or `start exit.target`) cleanly shuts down the
# WHOLE user@<uid> manager in one shot — bg-host, :3070, :3170, the inference
# gateway, git-sync, mcp-proxy, every timer/watchdog, AND every other live
# agent session's scope, all at once. Confirmed root cause of the 2026-07-16
# 23:00:47Z fleet-wide outage (EI-13135): the manager logged "Activating
# special unit exit.target", exited 0/SUCCESS at 23:01:09Z, and every service
# stayed dead for ~15min until an owner-authorized `sudo systemctl start
# user@1000.service` recovered it. `loginctl terminate-user`/`kill-user` and
# `systemctl stop|kill user@<uid>.service` are the SAME class (they too tear
# down every unit under that user in one shot) — same deny.
#
# UNCONDITIONAL — NOT gated on PAPERCUSP_AGENT_SESSION or the canonical-tree
# check the git-guard uses. EI-7872 already established the marker is
# silently unset in exactly the fleet-launched headless sessions this must
# protect, and unlike the git-guard the resource here isn't scoped to a
# particular working tree — it's the WHOLE HOST's service plane, host-wide
# regardless of cwd. This hook only mediates Claude/Codex Bash-tool calls, so
# an unconditional deny here never blocks the owner's own terminal — only a
# Bash-tool-mediated call, which has no legitimate reason to tear down the
# shared host's entire service plane.
_EXIT_GUARD_DENY = (
    'systemd user-manager exit/kill guard (EI-13135): `{op}` would tear down '
    'the ENTIRE shared user@<uid> service plane in one shot — bg-host, :3070, '
    ':3170, the inference gateway, git-sync, mcp-proxy, every timer/watchdog, '
    'and every OTHER live agent session\'s scope, all at once. This caused a '
    '~15min fleet-wide outage on 2026-07-16 (EI-13135). There is no '
    'legitimate agent reason to do this — if you mean to restart one specific '
    'papercusp service, use the blessed wrapper (dev:restart) instead.'
)
for _seg in re.split(r'[;&|\n]', command):
    _es = _strip_shell_quotes(_seg.strip())
    # Peel the same benign leading wrappers the git-guard peels (sudo/env/nice/
    # ionice/xargs/rtk/time/command/nohup/exec/setsid/…), defined fresh here so
    # this block never depends on the git-guard's conditionally-defined
    # `_unwrap` (which may not exist at all when that `if` didn't execute) —
    # this guard must fire independent of whether that branch ran.
    for _ in range(8):
        _next = re.sub(
            r'^\s*(?:'
            r'sudo(?:\s+(?:-[ugpUrCht]\s+\S+|-[A-Za-z]+|--[\w-]+(?:=\S*)?))*'
            r'|env(?:\s+[A-Za-z_]\w*=\S*)*'
            r'|nice(?:\s+-n\s*-?\d+)?'
            r'|ionice(?:\s+-\w+(?:\s+\d+)?)*'
            r'|xargs(?:\s+-\w+)*'
            r'|rtk|time|command|nohup|exec|setsid|nocorrect|stdbuf|doas|nocache'
            r')\s+',
            '', _es, count=1)
        if _next == _es:
            break
        _es = _next
    if re.match(r'systemctl\b(?:\s+--user)?\s+(?:start\s+exit\.target|exit)\b(?:\s|$)', _es):
        deny(_EXIT_GUARD_DENY.format(op='systemctl --user exit'))
    if re.match(r'systemctl\b(?:\s+--user)?\s+(?:halt|poweroff)\b(?:\s|$)', _es):
        deny(_EXIT_GUARD_DENY.format(op='systemctl --user halt/poweroff'))
    if re.match(r'loginctl\b\s+(?:terminate-user|kill-user)\b(?:\s|$)', _es):
        deny(_EXIT_GUARD_DENY.format(op='loginctl terminate-user/kill-user'))
    if re.match(r'systemctl\b\s+(?:stop|kill)\s+user@\d+\.service\b(?:\s|$)', _es):
        deny(_EXIT_GUARD_DENY.format(op='systemctl stop/kill user@<uid>.service'))

# ── pkill/killall host-wide dev-process guard (EI-18690252462401774) ───────
# `pkill -f <substring>` (and `killall <name>`) match by process cmdline/name
# SUBSTRING across the ENTIRE host process table — not scoped to the caller's
# own PID tree. Confirmed live: an agent cleaning up its OWN redundant
# backgrounded `npm run test:affected` job ran `pkill -f "test:affected"`,
# which matched and killed 5-6 OTHER agents' in-flight `test:affected` runs
# on this shared host at the same instant (2026-07-26) — each victim saw an
# unexplained process death, not an obvious self-inflicted footgun, so it
# cost every one of them a confused re-diagnosis instead of a one-line "oh,
# that was a pkill".
#
# UNCONDITIONAL — same rationale as the systemd exit-guard just above: the
# hazard is host-wide process-table scope, not tied to a particular working
# tree or an agent-session marker, and this hook only ever mediates Claude/
# Codex's own Bash-tool calls (never the owner's raw terminal), so firing
# unconditionally cannot over-block real interactive work.
#
# Curated dev/build/test substring list (same "best-effort common patterns"
# philosophy as the heavy-admission gate above) — this only fires when the
# pkill/killall argument plausibly names a shared command another agent on
# the box might be running right now, so a genuinely unique/caller-specific
# identifier is not blocked by this heuristic.
_PKILL_DEV_TOKEN_RE = re.compile(
    r'test:affected|test:file|test:all|\bvitest\b|\bjest\b|\bplaywright\b'
    r'|\bcargo\b|\brustc\b|npm\s+run|npm\s+test|npm\s+start|\btsc\b|ts-node'
    r'|\bpytest\b|turbo\s+run|next\s+dev|next\s+start|\bwebpack\b|\btauri\b'
    r'|\bnode\b|\bpython3?\b|\bgradle\b|\bmvn\b|\bmaven\b',
    re.IGNORECASE,
)
_PKILL_DENY = (
    'pkill/killall host-wide dev-process guard (EI-18690252462401774): `{op}` '
    'matches by SUBSTRING across the ENTIRE host process table — not scoped to '
    'your own PID tree. On this shared box this has already killed OTHER '
    "agents' in-flight test/build runs that happened to share the same command "
    'substring (5-6 peer `test:affected` runs died at once on 2026-07-26, each '
    'looking like an unrelated crash to its owner). Kill YOUR OWN process by its '
    'SPECIFIC PID instead: `kill <pid>` — the pid is printed when you '
    '`run_in_background`, or from `ps aux` filtered to a marker you can verify '
    'is really your own process (e.g. its /proc/<pid>/environ or full command '
    'line), never a bare pattern match. If you truly need pattern matching, '
    'scope it to your own process tree first (e.g. list children of $$ / your '
    'own shell PID) rather than a host-wide substring.'
)
for _seg in re.split(r'[;&|\n]', command):
    _pk = _seg.strip()
    for _ in range(8):
        _pk_next = re.sub(
            r'^\s*(?:'
            r'sudo(?:\s+(?:-[ugpUrCht]\s+\S+|-[A-Za-z]+|--[\w-]+(?:=\S*)?))*'
            r'|env(?:\s+[A-Za-z_]\w*=\S*)*'
            r'|nice(?:\s+-n\s*-?\d+)?'
            r'|ionice(?:\s+-\w+(?:\s+\d+)?)*'
            r'|xargs(?:\s+-\w+)*'
            r'|rtk|time|command|nohup|exec|setsid|nocorrect|stdbuf|doas|nocache'
            r')\s+',
            '', _pk, count=1)
        if _pk_next == _pk:
            break
        _pk = _pk_next
    _pk_m = re.match(r'(pkill|killall)\b(.*)$', _pk, re.IGNORECASE | re.DOTALL)
    if _pk_m and _PKILL_DEV_TOKEN_RE.search(_pk_m.group(2)):
        deny(_PKILL_DENY.format(op=_pk.strip()[:160]))

# ── tauri-agent-tools target guard (EI-10939) ────────────────────────────────
# SAFETY. `tauri-agent-tools` picks its target by scanning /tmp for
# `tauri-dev-bridge-<pid>.token` files and taking THE FIRST LIVE ONE IT HAPPENS
# TO READ (dist/bridge/tokenDiscovery.js: `if (!found) found = …`, over an
# unordered readdir; dist/commands/shared.js `resolveBridge()` falls into that
# path whenever `--pid` and `--port`+`--token` are all absent). There is no
# preference, no tie-break, and — this is the bug — NO WARNING when several
# bridges are alive. So a bare `tauri-agent-tools click …` drives WHICHEVER app
# readdir yielded first, which is very often NOT the throwaway instance the
# agent just spawned but the OWNER'S LIVE DESKTOP WINDOW. This nearly happened
# (an agent one keystroke from typing into the owner's real app).
#
# The package is a third-party global npm install (github.com/cesarandreslopez/
# tauri-agent-tools) — outside our repo, so we cannot fix `resolveBridge`. We CAN
# refuse to let an unaimed command through, which is the same protection.
#
# TWO TIERS, because ambiguity is not the only hazard:
#   • MUTATING (eval/click/type/…): an explicit target is required ALWAYS, even
#     when exactly one bridge is live. Verified 2026-07-13: the ONLY live bridge
#     on this box was the owner's own `papercusp-desktop` — so an ambiguity-only
#     rule would have sailed straight through and driven his window. If you are
#     about to DRIVE a webview, you must say which one. No exceptions.
#   • READ-ONLY bridge commands (dom/screenshot/page-state/…): required only when
#     the choice is genuinely AMBIGUOUS (2+ live bridges). Reading the wrong app
#     is how "I verified my fix" becomes a false green.
#   • Discovery + bridge-free commands (probe/list-windows/info/forensics/…) are
#     NEVER gated — `probe` is the ANSWER to this deny, so blocking it would be
#     perverse.
#
# NOT gated on PAPERCUSP_AGENT_SESSION: EI-7872 established that the marker is
# silently unset in fleet-launched sessions — exactly the ones doing unattended
# UI verification. The resource being protected is the owner's live app, not a
# tree, and the deny is satisfiable with one flag, so it applies to every session
# this hook runs in. Mirrors tauriTargetDenyReason() in the OMP hook.
TAT_MUTATING = frozenset((
    'eval', 'click', 'type', 'scroll', 'focus', 'navigate', 'select', 'invoke',
))
TAT_BRIDGE_READ = frozenset((
    'screenshot', 'dom', 'wait', 'ipc-monitor', 'page-state', 'storage',
    'console-monitor', 'mutations', 'snapshot', 'rust-logs', 'store-inspect',
    'check', 'capture', 'process-tree', 'capabilities', 'webview', 'health',
    'diagnose',
))
_TAT_BIN_RE = re.compile(r'(?:^|[\s;&|(])(?:[\w./-]*/)?tauri-agent-tools(?=\s|$)')


def _tat_subcommand(cmd):
    # The subcommand is the first non-flag token after the binary. Returns None
    # for a bare/`--help`/`--version` invocation (nothing to aim).
    m = _TAT_BIN_RE.search(cmd)
    if not m:
        return None
    rest = cmd[m.end():].split()
    for tok in rest:
        if tok.startswith('-'):
            continue
        return tok
    return None


def _tat_has_explicit_target(cmd):
    # `--pid N` is the aim. `--port N --token X` bypasses discovery entirely and
    # is equally explicit. Either satisfies the guard. (Quote-stripped: a quoted
    # VALUE disappears but the flag token itself survives, so this stays sound.)
    if re.search(r'--pid[=\s]', cmd):
        return True
    return bool(re.search(r'--port[=\s]', cmd) and re.search(r'--token[=\s]', cmd))


def _tat_live_bridges():
    # Same discovery the tool itself does — /tmp/tauri-dev-bridge-<pid>.token,
    # keeping only the ones whose pid is still alive — plus the process cmdline,
    # so the refusal can NAME the candidates instead of just asserting ambiguity.
    import glob
    out = []
    for path in sorted(glob.glob(os.path.join(tempfile.gettempdir(), 'tauri-dev-bridge-*.token'))):
        try:
            with open(path) as fh:
                data = json.load(fh)
            pid = int(data['pid'])
            os.kill(pid, 0)  # raises unless alive
        except Exception:
            continue  # dead / malformed — the tool skips these too
        try:
            with open('/proc/%d/cmdline' % pid, 'rb') as fh:
                exe = fh.read().replace(b'\x00', b' ').decode('utf-8', 'replace').strip()
        except Exception:
            exe = '(unknown process)'
        out.append({'pid': pid, 'port': data.get('port'), 'exe': exe[:100]})
    return out


def _tat_candidate_lines(bridges):
    return '\n'.join(
        '  --pid %-8d port %-6s %s' % (b['pid'], b['port'], b['exe']) for b in bridges
    ) or '  (none discoverable right now)'


def _tauri_target_deny_reason(sub, bridges, mutating):
    head = (
        'tauri-agent-tools target guard: this command DRIVES a webview but does not say WHICH one.'
        if mutating else
        'tauri-agent-tools target guard: %d bridges are live, so `%s` cannot tell which app you mean.'
        % (len(bridges), sub)
    )
    why = (
        'With no --pid, tauri-agent-tools attaches to the FIRST bridge token it finds in /tmp — '
        'an arbitrary readdir order, with no warning. That is frequently the OWNER\'S LIVE DESKTOP '
        'APP rather than the instance you spawned.'
    )
    return (
        '%s\n%s\n\nLive bridges right now:\n%s\n\nRe-run naming your target:\n'
        '  tauri-agent-tools %s --pid <PID> …\n\n'
        'Not sure which is yours? `tauri-agent-tools probe` (never blocked) lists the targets, '
        'and the PID of an app YOU spawned is the one you launched — if you did not spawn one, '
        'you are about to act on someone else\'s window.' % (
            head, why, _tat_candidate_lines(bridges), sub,
        )
    )


_tat_sub = _tat_subcommand(_strip_shell_quotes(command))
if _tat_sub in TAT_MUTATING or _tat_sub in TAT_BRIDGE_READ:
    _stripped_cmd = _strip_shell_quotes(command)
    if not _tat_has_explicit_target(_stripped_cmd):
        _mutating = _tat_sub in TAT_MUTATING
        _bridges = _tat_live_bridges()
        # Mutating: always require an aim. Read-only: only when ambiguous.
        # Zero bridges → nothing to hit; let the tool print its own error.
        if _bridges and (_mutating or len(_bridges) > 1):
            deny(_tauri_target_deny_reason(_tat_sub, _bridges, _mutating))

# ── tauri-agent-tools raw-JSON --token advisory (EI-15605) ─────────────────
# SOFT/ADVISORY (never blocks — same third-party-package rationale as the
# target guard above: the CLI is a third-party global npm install, so we
# cannot make it validate/error better itself). The dev-bridge token file
# (/tmp/tauri-dev-bridge-<pid>.token) is a JSON object
# `{"port":N,"token":"...","pid":N}`, NOT a bare token string. Piping its raw
# content straight into `--token` (e.g. `--token "$(cat /tmp/tauri-dev-bridge-
# <pid>.token)"`) silently fails auth ("Bridge authentication failed — check
# your token") even though the token itself is correct inside that JSON —
# cost 3 failed eval attempts (raw cat, trimmed cat, `require()` on a
# .token extension Node refuses to parse) before spotting the wrapper.
# Catches both the inline substitution form and the assign-then-use form
# (`TOK=$(cat …/*.token); … --token "$TOK"`); skipped whenever the same
# substitution already shows evidence of JSON extraction (jq/python/node/
# JSON.parse/json.load) — that's presumably already doing it right.
try:
    if not ADVISORY:
        _tok_hint_re = re.compile(r'(?:\bcat\s+|<\s*)\S*\.token\b')
        _tok_extracted_re = re.compile(r'\bjq\b|\bpython3?\b|\bnode\b|JSON\.parse|json\.load')
        _tok_flagged = False
        # (a) inline: --token "$(cat …/*.token)"
        for _tok_body in re.findall(r'--token[=\s]+"?\$\(([^)]*)\)"?', command):
            if _tok_hint_re.search(_tok_body) and not _tok_extracted_re.search(_tok_body):
                _tok_flagged = True
                break
        # (b) assign-then-use: VAR=$(cat …/*.token) ... --token "$VAR"
        if not _tok_flagged:
            for _tok_var, _tok_body in re.findall(r'\b([A-Za-z_]\w*)=\$\(([^)]*)\)', command):
                if _tok_hint_re.search(_tok_body) and not _tok_extracted_re.search(_tok_body):
                    if re.search(r'--token[=\s]+"?\$\{?' + re.escape(_tok_var) + r'\b', command):
                        _tok_flagged = True
                        break
        if _tok_flagged:
            ADVISORY = (
                'tauri-agent-tools --token advisory (EI-15605): the dev-bridge token file '
                '(/tmp/tauri-dev-bridge-<pid>.token) is JSON — {"port":N,"token":"...","pid":N} '
                '— not a bare token string. Passing its raw content as --token silently fails '
                'auth ("Bridge authentication failed — check your token") even though the '
                'token itself is correct. Extract the field first, e.g. '
                '`--token "$(jq -r .token /tmp/tauri-dev-bridge-<pid>.token)"` (or a '
                '`node -e \'process.stdout.write(JSON.parse(require("fs").readFileSync('
                'process.argv[1],"utf8")).token)\' /tmp/tauri-dev-bridge-<pid>.token` '
                'one-liner if jq is unavailable). Usually simplest: skip --port/--token '
                'entirely and let `tauri-agent-tools probe`/auto-discovery find the bridge '
                '(pass --pid <pid> to disambiguate multiple bridges). Advisory only; this '
                'command is proceeding as issued.'
            )
except Exception:
    pass  # advisory must never wedge a command

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
        def _in(p):
            return p == _canon or p.startswith(_canon + os.sep)
        if _in(_cwd):
            return True
        # Also honor a leading `cd <path> && …`: a marker-less fleet session
        # (EI-7872) running e.g. `cd <canonical> && git reset --hard` (or a heavy
        # build) carries the OUTER cwd in the payload, so the cwd check alone
        # misses it. Resolve ONLY a simple, unambiguous leading cd target (no
        # spaces, quotes, or shell operators/expansion) against the outer cwd;
        # anything fancier falls back to the cwd-only result, and accurate
        # realpath resolution means `cd /other/repo && …` stays outside canonical
        # — so this only ever gates MORE (never a false positive on another tree).
        _cd = re.match(r"\s*cd\s+(['\"]?)([^&|;<>\s'\"]+)\1\s*(?:&&|;|\||$)", command)
        if _cd and _in(os.path.realpath(os.path.join(_cwd, _cd.group(2)))):
            return True
        return False
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
        # EI-18215743778965613 (self-caught 2026-07-20): `pop`/`apply` used to be
        # exempted alongside the genuinely-read-only subcommands below, and a
        # `push -- <paths>` was exempted as "scoped" — but the stash is a SINGLE
        # shared LIFO stack across the whole tree, not scoped by a push's
        # pathspec: a scoped push followed by `pop` popped an UNRELATED ancient
        # stash entry, producing a merge conflict in files never touched by the
        # caller. `pop`/`apply` apply WHATEVER is on top of that shared stack to
        # the working tree — exactly the same "clobbers a peer's uncommitted
        # state" hazard as reset --hard/checkout .— so they're no safer than a
        # bare `git stash` and must be denied unconditionally, same as a
        # scoped `push` (no more ` -- ' exemption). `list`/`show` stay exempt
        # (read-only, no working-tree mutation); `drop`/`branch`/`clear` are
        # unchanged from before (not implicated in this incident).
        if re.match(_GIT + r'stash\b(?!\s+(?:list|show|drop|branch|clear))', _s):
            deny(_git_deny.format(op='git stash'))

# ── Shell-write file-target guard (EI-18664655909328670) ───────────────────
# `cat >> file` / `echo > file` / `tee file` / `sed -i file` / `cp x file` write
# tree files through a side door the Edit/Write PreToolUse hooks never see: no
# file lock is claimed (a peer editing the same file races unserialized), and
# when the session cwd has silently drifted, the redirect/tee/cp does not
# error — it CREATES A STRAY FILE with zero signal, and a subsequent test run
# against the real path then reports green, actively confirming the wrong
# conclusion. Repro'd live 2026-07-25: an agent believed cwd was a package
# subdir, appended via `cat >> tools/conversations-list.test.ts <<EOF`, cwd had
# actually drifted to the repo root (which also has a `tools/`), and the
# redirect silently created `papercusp/tools/conversations-list.test.ts` — an
# un-gitignored stray one git-sync tick from being committed, caught only by a
# manual diff against `git show HEAD:`.
#
# Detect a write target that resolves INSIDE the canonical shared staging tree
# and BLOCK it, pointing at Edit/Write instead — those tools already claim the
# lock and validate the worktree, so this closes the side door rather than
# reimplementing locking here.
#
# UNCONDITIONAL (not gated on PAPERCUSP_AGENT_SESSION or cwd-in-tree): this
# hook only ever mediates Claude/Codex's own Bash tool, never the owner's raw
# terminal, and the gate keys on the resolved TARGET path — so it cannot
# over-block real terminal work, only a Bash-tool write that lands in the tree.
#
# LITERAL PATHS ONLY: a target containing shell expansion ($VAR, $(...),
# backticks, `~`, a glob) is left alone — unsafe to resolve without actually
# running the shell, so fail-open there rather than guess.
def _canonical_tree_root():
    try:
        _ws_root = os.path.realpath(
            os.environ.get('PAPERCUSP_WORKSPACE_ROOT')
            or os.path.expanduser('~/papercupai-workspace'))
        return os.path.realpath(
            os.environ.get('PAPERCUSP_CANONICAL_TREE')
            or os.path.join(_ws_root, 'papercusp'))
    except Exception:
        return None


def _resolve_write_target(raw_target, cwd):
    if not raw_target or any(ch in raw_target for ch in ('$', '`', '~', '*', '?', '[')):
        return None
    if raw_target.startswith('/dev/') or raw_target in ('&1', '&2'):
        return None
    try:
        return os.path.realpath(
            raw_target if os.path.isabs(raw_target) else os.path.join(cwd, raw_target))
    except Exception:
        return None


_HEREDOC_START_RE = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")


def _strip_heredoc_bodies(s):
    # Remove heredoc BODY text — the lines between a `<<[-]DELIM` operator and
    # the line consisting of just DELIM (`<<-` allows leading whitespace on
    # that closing line) — before scanning for redirect operators. A
    # heredoc's payload is often an embedded script (python/node/SQL/…), and
    # an operator inside it (`v>100`, `x > y`, `=>`, `->`) is DATA, not real
    # shell syntax — scanning it as if it were is a false-positive generator
    # (EI-18683619680591304). Run BEFORE _strip_shell_quotes: quote-stripping
    # the raw heredoc body first risks mis-parsing an unbalanced quote inside
    # the payload and swallowing real command text that follows. This only
    # ever REMOVES characters — it can never manufacture a new match — so it
    # is safe even when a heredoc is malformed/unterminated.
    out = []
    i, n = 0, len(s)
    while i < n:
        m = _HEREDOC_START_RE.search(s, i)
        if not m:
            out.append(s[i:])
            break
        line_end = s.find('\n', m.end())
        if line_end == -1:
            out.append(s[i:])
            break
        out.append(s[i:line_end + 1])
        delim = m.group(2)
        close_re = re.compile(r'^[ \t]*' + re.escape(delim) + r'\s*$', re.MULTILINE)
        cm = close_re.search(s, line_end + 1)
        if not cm:
            i = n  # unterminated heredoc — drop the rest, nothing safe to scan
            break
        i = cm.end()
    return ''.join(out)


def _segment_has_unsplittable_expansion(seg):
    # EI-18691980588797795: `tee`/`sed -i`/`perl -i`/`ruby -i`/`cp` all identify
    # their target(s) by `.split()`-ing the raw command-tail segment on
    # whitespace. A `$(...)`/backtick command substitution containing an
    # INTERNAL space (e.g. `cp src.txt $(echo target dir)/dest.txt`) splits
    # across MULTIPLE resulting tokens — the substitution's tail then reads as
    # its own bare positional token (e.g. `dir)/dest.txt`), which usually
    # carries none of `_resolve_write_target`'s own expansion markers ($ ` ~ *
    # ? [) and so is NOT recognized as unsafe-to-resolve. That stray fragment
    # then gets resolved against cwd like any ordinary literal path — and when
    # cwd is INSIDE the canonical tree (the exact situation this guard exists
    # to protect), any such fragment resolves to a path that trivially starts
    # with the canonical root, producing a FALSE DENY on an otherwise-fine
    # command. Conservative fix: if `$(` or a backtick appears ANYWHERE in the
    # raw segment, the split is unsafe to trust at all — skip target detection
    # for this invocation entirely (fail-open), matching this guard's own
    # stated "unsafe to resolve without actually running the shell" policy for
    # expansions, just applied BEFORE the split loses the marker.
    return '$(' in seg or '`' in seg


def _looks_like_redirect_path(raw):
    # Defense-in-depth alongside the heredoc strip above: a bare comparison/
    # arrow operator can still appear unquoted OUTSIDE a heredoc (e.g. inside
    # `$(( … ))` arithmetic, which quote-stripping does not touch) and read as
    # a redirect whose "target" is just a number. Require the token to look
    # like an actual path — contains a separator, has a file extension, or is
    # not purely a decimal integer — before treating it as a write target.
    if '/' in raw:
        return True
    if re.search(r'\.[A-Za-z0-9]{1,10}$', raw):
        return True
    if re.fullmatch(r'-?\d+', raw):
        return False
    return True


# WI-6026 (EI-18664655909328670, 3rd instance): `tee`/`sed -i`/`perl -i`/
# `ruby -i`/`cp` all find their target(s) by `.split()`-ing the raw
# command-tail segment on whitespace, same as the substitution-fragment bug
# above — but here the stray token is a REDIRECT the caller wrote to silence
# output (`cmd ... 2>/dev/null`, `cmd ... > /tmp/out.log`), an extremely
# common idiom. Redirect syntax is not a positional argument: strip it BEFORE
# any of those legs treats "the last remaining token" as the destination, or
# a combined `2>/dev/null` reads as the `cp`/`tee`/`sed -i` target itself
# (repro: `cp a.txt /tmp/x/b.txt 2>/dev/null` denied with the guard naming
# `2>/dev/null` as the target — the give-away that its own parse was wrong).
# Handles both the combined form (`2>/dev/null`, `>>file`, `&>file`) and the
# split form where the operator and its target are separate tokens
# (`cp a b > out`), plus bare fd-duplication (`2>&1`, `>&2`) which carries no
# path target at all.
def _strip_redirect_tokens(toks):
    out = []
    skip_next = False
    for t in toks:
        if skip_next:
            skip_next = False
            continue
        if re.fullmatch(r'\d*>&\d*', t):
            continue
        _m = re.match(r'^\d*(?:>{1,2}|&>)(.*)$', t)
        if _m:
            if _m.group(1) == '':
                # bare operator token (`>`, `2>`, `>>`, `&>`) — its target, if
                # any, is the NEXT token; drop both.
                skip_next = True
            continue
        out.append(t)
    return out


def _shell_write_guard():
    _canon = _canonical_tree_root()
    if not _canon:
        return
    try:
        _cwd = os.path.realpath(payload.get('cwd') or os.getcwd())
    except Exception:
        return
    _clean = _strip_shell_quotes(_strip_heredoc_bodies(command))
    _targets = []  # (raw_target, human-readable construct name)

    # `>`/`>>` redirects. The lookahead excludes fd-duplication/comparison
    # forms (`2>&1`, `>=`, `2>&2`) so those never get misread as file targets.
    for _m in re.finditer(r'\d*(>{1,2})(?![&=])\s*([^\s;&|()<>]+)', _clean):
        if not _looks_like_redirect_path(_m.group(2)):
            continue
        _targets.append((_m.group(2), 'shell redirect (`%s`)' % _m.group(1)))

    # `tee [-a] FILE...`
    for _m in re.finditer(r'\btee\b([^;&|\n]*)', _clean):
        if _segment_has_unsplittable_expansion(_m.group(1)):
            continue
        for _tok in _strip_redirect_tokens(_m.group(1).split()):
            if not _tok.startswith('-'):
                _targets.append((_tok, '`tee`'))

    # `sed -i[.bak] ... FILE...` / `sed --in-place ... FILE...` — quote-
    # stripping already erased a quoted script, so treat every remaining
    # non-flag token as a target candidate (harmless if one is actually the
    # unquoted script text: a real target among them still triggers the deny).
    for _m in re.finditer(r'\bsed\b([^;&|\n]*)', _clean):
        _seg = _m.group(1)
        if not re.search(r'(?:^|\s)-i\S*|--in-place\b', _seg):
            continue
        if _segment_has_unsplittable_expansion(_seg):
            continue
        for _tok in _strip_redirect_tokens(_seg.split()):
            if not _tok.startswith('-'):
                _targets.append((_tok, '`sed -i`'))

    # `perl -i[.bak] FILE...` / `ruby -i[.bak] FILE...` — the same in-place
    # side door as `sed -i` above, just a different interpreter
    # (EI-18691482279179647: "the shell-write guard misses interpreter
    # writes" — this leg is the in-place-flag half of that fix; the other
    # half, an interpreter's OWN open()/writeFileSync() call inside inline
    # code, is a different shape and handled by _interpreter_write_guard
    # below since there is no shell-level flag to key on there).
    for _m in re.finditer(r'\b(?:perl|ruby)\b([^;&|\n]*)', _clean):
        _seg = _m.group(1)
        if not re.search(r'(?:^|\s)-i\S*\b', _seg):
            continue
        if _segment_has_unsplittable_expansion(_seg):
            continue
        for _tok in _strip_redirect_tokens(_seg.split()):
            if not _tok.startswith('-'):
                _targets.append((_tok, '`perl -i`/`ruby -i`'))

    # `cp SRC... DEST` — the last positional (non-flag) token is the
    # destination. Skipped for a recursive/archive copy (`-r`/`-R`/`-a`/
    # `--recursive`/`--archive`): a directory copy has no single-file
    # Edit/Write substitute, so there is nothing safe to redirect this to.
    for _m in re.finditer(r'\bcp\b([^;&|\n]*)', _clean):
        if _segment_has_unsplittable_expansion(_m.group(1)):
            continue
        _toks = _m.group(1).split()
        if any(re.match(r'-[a-zA-Z]*[rRa][a-zA-Z]*$|--recursive$|--archive$', t)
               for t in _toks if t.startswith('-')):
            continue
        _pos = [t for t in _strip_redirect_tokens(_toks) if not t.startswith('-')]
        if len(_pos) >= 2:
            _targets.append((_pos[-1], '`cp`'))

    for _raw, _construct in _targets:
        _resolved = _resolve_write_target(_raw, _cwd)
        if _resolved and (_resolved == _canon or _resolved.startswith(_canon + os.sep)):
            deny(
                'shell-write guard (EI-18664655909328670): this %s targets `%s`, which '
                'resolves INSIDE the shared staging tree. Raw shell writes to tree files '
                'skip the file-lock hook entirely, and if your session cwd has silently '
                'drifted they create a stray file with no error (a follow-up test run '
                'then reports green against the wrong path — exactly how a near-miss '
                'stray got one tick from being committed on 2026-07-25). Use the Edit or '
                'Write tool instead — they claim the lock and validate the worktree for '
                'you (for a copy: Read the source, then Write the destination). '
                'Genuinely a scratch/log file? Write it outside the tree '
                '(~/.papercusp/scratch or /tmp).' % (_construct, _raw)
            )


try:
    _shell_write_guard()
except Exception:
    pass  # guard must never wedge a command

# ── Interpreter inline-code write guard (EI-18691482279179647) ─────────────
# The shell-write guard above only knows SHELL write constructs (>, >>, tee,
# sed/perl/ruby -i, cp). An interpreter invoked with inline code — `python3
# -c "..."`, `node -e "..."`, or a `python3 - <<EOF ... EOF` stdin/heredoc
# script — does its own file I/O (open(...,'w'), fs.writeFileSync(...), …),
# which is not a shell redirect at all and is invisible to that guard.
#
# Self-caught 2026-07-26: rewriting a tree file via `python3 - <<EOF` (the
# target path spelled out literally inside the heredoc body) sailed straight
# through — no lock claimed, no worktree validation, exactly the state the
# shell-write guard exists to prevent. The interpreter rewrite ALSO mangled
# the file (a regex that dropped closing braces across 4 call sites) — Edit
# would have been both locked AND structurally safer, so this hole costs
# correctness, not just locking.
#
# LITERAL PATHS ONLY, same discipline as the shell-write guard: this never
# parses the interpreted language — it only checks whether a literal tree
# path substring appears anywhere in the code payload (a `-c`/`-e` quoted
# argument, or a heredoc body that follows an interpreter invocation), AND
# that same payload contains a recognizable WRITE-shaped call. HONEST LIMIT
# (permanent, not a bug to fix later): an interpreter can always construct a
# path at runtime (string concatenation, an env var, a computed join), and a
# write call this heuristic doesn't recognize slips through too — no static
# scan of the command text can see either. The guard's value is catching the
# ordinary, literal, accidental case — precisely the case that produced both
# this near-miss and EI-18664655909328670's stray-file incident — not
# achieving completeness.
#
# SELF-CAUGHT DURING THIS OWN FIX (2026-07-26): the first version of this
# guard flagged ANY literal tree path in an inline-code payload, full stop —
# and immediately denied its OWN verification command, a read-only
# `python3 -c "... open(<this file>).read() ..."` syntax check with no write
# call anywhere. A read needs no lock; blocking it is pure false-positive
# friction with no safety upside, and a guard that fires on ordinary reads
# trains agents to route around it. The WRITE-indicator requirement below is
# the fix — same shape as the mistake this whole item exists to catch (an
# agent walking through a hole without noticing), just caught inside the fix
# instead of downstream of it.
# EI-18692070370140239 — THE SAME MISTAKE ONE LEVEL DOWN. The note above
# records the first false-positive round (the guard denied its own read-only
# `open(...).read()` syntax check) and the WRITE-indicator requirement that
# fixed it. The indicator ITSELF then over-matched: `\bwrite\w*\s*\(` matches
# ANY `.write(`, including sinks that never touch the filesystem — so a
# read-only `python3 -c 'import sys; sys.stdout.write("<a tree path>")'`,
# which merely PRINTS a string that happens to look like a tree path, was
# denied as an "interpreter write". Caught the same way as its predecessor:
# it denied an ordinary agent command that wrote nothing to the tree.
#
# The split below is the fix. A write to stdout/stderr is not a file write,
# and a bare `.write(` is genuinely AMBIGUOUS (a file handle, an io.StringIO
# buffer, a socket, a response object — indistinguishable without dataflow
# this guard deliberately does not do). So a bare `.write(` counts only when
# the SAME inline body also shows a file object being opened. That is sound
# specifically because this guard only ever scans INLINE code (-c/-e/heredoc):
# a one-liner that writes a file has to open it in that same body. Named
# forms that are unambiguous on sight stay STANDALONE indicators below, so
# `Path("x").write_text(y)` and `fs.writeFileSync(...)` still deny.

# Sinks that are definitionally NOT the filesystem — removed from the body
# before any write-scan, so they can neither trip nor mask an indicator.
_NONFILE_WRITE_RE = re.compile(
    r'\b(?:sys|process)\s*\.\s*(?:stdout|stderr)\s*\.\s*write\w*\s*\('
)
# Unambiguous on sight — any one of these alone means a file write.
_WRITE_INDICATOR_RE = re.compile(
    r'\bopen\s*\([^)]*,\s*[\'"][waxWAX][b+t]?[\'"]'        # open(path, 'w'/'a'/'x'[b/t/+])
    r'|writeFileSync|appendFileSync|createWriteStream'      # node fs, common named forms
    r'|\bwrite_(?:text|bytes)\s*\('                         # pathlib Path.write_text/_bytes
    r'|\.save\s*\('                                        # common ORM/model .save(
    r'|(?:pickle|json|yaml)\.dump\s*\('                     # serialize-to-file idioms
    r'|shutil\.(?:copy|move)|os\.(?:rename|remove|replace)|unlink\s*\('
)
# Ambiguous alone — only a write indicator alongside a file-object construct.
_BARE_WRITE_CALL_RE = re.compile(r'\bwrite\w*\s*\(')
_FILE_OBJECT_RE = re.compile(
    r'\bopen\s*\(|\bPath\s*\(|\bfdopen\s*\(|\bNamedTemporaryFile\s*\('
)


def _body_indicates_file_write(body):
    # Non-file sinks are stripped FIRST: `sys.stdout.write(` must not satisfy
    # the bare-write test, and stripping it cannot hide a real write because
    # a real write is a separate call elsewhere in the body.
    scan = _NONFILE_WRITE_RE.sub('', body)
    if _WRITE_INDICATOR_RE.search(scan):
        return True
    return bool(_BARE_WRITE_CALL_RE.search(scan) and _FILE_OBJECT_RE.search(scan))
_INTERPRETER_RE = re.compile(r'(?:^|[\s;&|(])(?:[\w./-]*/)?(python3?|node|perl|ruby|deno|bun)(?=\s|$)')
_INLINE_CODE_FLAG_RE = re.compile(r'(?:^|\s)-[ce]\b')


def _extract_quoted_flag_bodies(cmd):
    # The quoted argument to a `-c`/`-e` flag (either quote style, DOTALL so
    # a multi-line script matches) — extracted from the RAW command, since
    # quote-stripping (used elsewhere to find command-position tokens) would
    # erase exactly the text this needs to scan.
    return [m.group(2) for m in re.finditer(r'-[ce]\s+([\'"])(.*?)\1', cmd, re.DOTALL)]


def _extract_heredoc_bodies(cmd):
    # The CAPTURED dual of _strip_heredoc_bodies above (which discards this
    # same text) — every heredoc BODY (between a `<<[-]DELIM` operator and
    # its closing DELIM line), for scanning instead of stripping.
    bodies = []
    i, n = 0, len(cmd)
    while i < n:
        m = _HEREDOC_START_RE.search(cmd, i)
        if not m:
            break
        line_end = cmd.find('\n', m.end())
        if line_end == -1:
            break
        delim = m.group(2)
        close_re = re.compile(r'^[ \t]*' + re.escape(delim) + r'\s*$', re.MULTILINE)
        cm = close_re.search(cmd, line_end + 1)
        if not cm:
            break  # unterminated — nothing safe to scan past here
        bodies.append(cmd[line_end + 1:cm.start()])
        i = cm.end()
    return bodies


# EI-18700825865251498: the quoted-literal scan below used to pair ANY quote
# CHARACTER with the next one of EITHER type (`['"]([^'"\n]+)['"]`), so it
# didn't recognize that a single `'` and a double `"` don't close each
# other's string. An apostrophe/contraction inside one string literal (or a
# nested differently-quoted literal, e.g. an f-string embedding `d['key']`)
# then paired with an unrelated quote character further along the SAME line,
# and the plain code text sitting between them — never a string literal at
# all — became the "matched path". Repro: a for-loop line whose real string
# literals were fine on their own produced the garbage capture
# " in ln: ln = ln.replace(" (a code fragment, not a path) purely because a
# quote of the other type appeared somewhere else on that line; that fragment
# contains a `.` (from `ln.replace`), which is all `_resolve_write_target`
# needs to resolve it — against a cwd inside the tree — into a false in-tree
# hit. Matching quotes of the SAME type only (two alternatives, not one
# type-agnostic class) fixes this: a stray apostrophe with no matching `'`
# later on the line simply fails to open a match at all, instead of being
# closed by an unrelated `"`.
_QUOTED_LITERAL_RE = re.compile(r'"([^"\n]*)"|\'([^\'\n]*)\'')


def _payload_literal_tree_path(body, canon, cwd):
    # Every quoted token inside `body` that looks path-like (contains `/` or
    # a dotted extension) and carries no shell/interpreter expansion syntax
    # ($, `, {, }) — resolved the same literal-only way as
    # _resolve_write_target. Intentionally coarse: no attempt to parse which
    # call the literal is an argument TO — an interpreter invocation with
    # inline code is unusual enough on its own that a literal tree path
    # anywhere in that code is signal, per the guard's own honest-limit note.
    for _m in _QUOTED_LITERAL_RE.finditer(body):
        raw = _m.group(1) if _m.group(1) is not None else _m.group(2)
        if any(ch in raw for ch in ('$', '`', '{', '}')):
            continue
        # EI-18800669297694465: test each WHITESPACE-SEPARATED TOKEN of the
        # literal, never the literal as a whole.
        #
        # A path candidate cannot contain whitespace — not as a general truth
        # about filesystems, but as a true one about the only targets this
        # guard gates: no tracked path in this repo has a space
        # (`git ls-files | grep -c ' '` -> 0), and `canon` is that repo. So
        # tokenizing cannot lose an in-tree hit, while testing the whole
        # literal actively manufactures false ones.
        #
        # It did. `print("wrote /tmp/x.mts")` is ONE literal containing a `/`
        # and a `.`, so it passed both filters; it does not START with `/`, so
        # it was treated as RELATIVE and joined onto the cwd, yielding
        # `<canon>/wrote /tmp/x.mts` — "inside the tree". A script whose every
        # real target was absolute under /tmp was denied, and the refusal
        # quoted the SENTENCE back as the offending path. Returning the token
        # fixes the message half too: the agent is shown a path, not prose.
        #
        # Fourth in this family (EI-18683619680591304, -18692070370140239,
        # -18700825865251498): each was something that is not a path being
        # resolved as one. The through-line is that this scan is deliberately
        # coarse, so every widening of what counts as a "path" must be paid
        # for by a matching narrowing of what counts as a candidate.
        for cand in raw.split():
            if not re.search(r'[./]', cand):
                continue
            resolved = _resolve_write_target(cand, cwd)
            if resolved and (resolved == canon or resolved.startswith(canon + os.sep)):
                return cand
    return None


def _interpreter_write_guard():
    _canon = _canonical_tree_root()
    if not _canon:
        return
    try:
        _cwd = os.path.realpath(payload.get('cwd') or os.getcwd())
    except Exception:
        return
    _clean = _strip_shell_quotes(_strip_heredoc_bodies(command))
    if not _INTERPRETER_RE.search(_clean):
        return  # no interpreter invocation at all — nothing to check
    _interp_m = _INTERPRETER_RE.search(_clean)
    _interp = _interp_m.group(1)
    _has_heredoc = bool(_HEREDOC_START_RE.search(command))
    _has_inline_flag = bool(_INLINE_CODE_FLAG_RE.search(_clean))
    if not (_has_heredoc or _has_inline_flag):
        return  # e.g. a plain `node script.js` — the code lives in a real
        # file, which Edit already locks; nothing new for this guard to see.
    _bodies = _extract_quoted_flag_bodies(command) + _extract_heredoc_bodies(command)
    for _body in _bodies:
        if not _body_indicates_file_write(_body):
            continue  # a read, a stdout/stderr print, or no recognized file
            # I/O at all — nothing to gate (EI-18692070370140239)
        _hit = _payload_literal_tree_path(_body, _canon, _cwd)
        if _hit:
            deny(
                'shell-write guard (EI-18691482279179647): this `%s` invocation runs inline '
                'code that references `%s`, which resolves INSIDE the shared staging tree. '
                'An interpreter write (open()/fs.writeFileSync()/etc.) is invisible to '
                'shell-redirect detection — it skips the file-lock hook entirely, the same '
                'side door as a raw `cat >>`/`tee`/`sed -i` (EI-18664655909328670). Use the '
                'Edit or Write tool instead — they claim the lock and validate the worktree '
                'for you (for a copy: Read the source, then Write the destination). '
                'Genuinely a scratch/log file? Write it outside the tree '
                '(~/.papercusp/scratch or /tmp).' % (_interp, _hit)
            )


try:
    _interpreter_write_guard()
except Exception:
    pass  # guard must never wedge a command

# ── Heavy-command admission control (WI-3821) ──────────────────────────────
# Fleet size now organically oversubscribes the 128-core box: each agent's
# vitest/tsc/test:affected is ALREADY per-suite worker-capped (affected-tests.mjs
# caps at 32) and runs its workspaces sequentially, so ONE run is fine — but N
# agents run their own simultaneously with zero cross-process coordination, and
# ~6 concurrent capped runs = ~185 workers = the load-245→3077 meltdowns seen
# twice this week. This hook is the only place that transparently sees EVERY raw
# agent heavy command, but it can only allow/deny (it exits before the command
# runs, so it cannot hold a slot) — so it DENIES a *new* heavy run when host
# load is already past the pathological threshold, pointing the caller at
# scripts/pc-heavy.sh (a flock counting-semaphore that WAITS for a free slot
# instead of failing) or a retry once load drops. The green-checkpoint gate and
# capability:inspect run server-side / as MCP tools and never reach this bash
# hook, so they are exempt by construction; only raw, uncoordinated agent shell
# runs get staggered.
#
# Safe-by-default & FAIL-OPEN: this hook lands fleet-wide via git-sync with no
# review, so a fail-closed bug would wedge every agent's bash. The threshold is
# 1.5x cores (catches the 1.9x=245 onset; never trips healthy 1.0-1.3x load);
# kill-switch PC_HEAVY_ADMISSION=off; skipped when PC_HEAVY_BYPASS=1 (pc-heavy
# sets it) or the caller is not an agent/shared-tree session (owner exempt);
# every error path allows. PC_HEAVY_LOAD1_OVERRIDE lets tests inject a load.
def _heavy_admission():
    if os.environ.get('PC_HEAVY_ADMISSION', 'on').strip().lower() in ('off', '0', 'false', 'no'):
        return
    if os.environ.get('PC_HEAVY_BYPASS') == '1':
        return
    # In-band bypasses (EI-9634): this hook decides BEFORE the wrapped command
    # runs, so neither the blessed wrapper's PC_HEAVY_BYPASS export nor a child
    # shell's inline `PC_HEAVY_BYPASS=1 …` assignment is in THIS process's env
    # yet — so both remedies the deny message itself recommends were themselves
    # denied under the exact high load they exist for. Read them from the
    # command TEXT instead (both are command-position, re.match-anchored):
    #   (a) a leading `scripts/pc-heavy.sh …` invocation — it runs its OWN flock
    #       counting-semaphore admission and exports PC_HEAVY_BYPASS=1 to its
    #       child, so gating it double-denies the wrapper for the check it
    #       already satisfies.
    #
    # EI-10001: this used to `re.match` the RAW `_lead` only — so the deny
    # message's own suggested remedy ("run it under `scripts/pc-heavy.sh --
    # <your command>`") silently didn't work the moment pc-heavy.sh wasn't the
    # literal first token: the everyday `cd <dir> && scripts/pc-heavy.sh --
    # <cmd>` (very common right after a prior command left you elsewhere) or a
    # `(… ) &` subshell wrapper around the invocation both got denied AGAIN
    # with the exact same message — reads as "the remedy doesn't work." Peel a
    # BOUNDED set of genuinely benign leading wrappers first (each one runs no
    # command of its own, so this can never let a REAL heavy command hiding
    # earlier in the string slip past ungated — `npm run build && scripts/
    # pc-heavy.sh -- true` still stops peeling at `npm`, which isn't one of
    # these, so it still hits the heavy_re check below as before).
    _lead = command.lstrip()
    _pc_lead = _lead
    for _ in range(8):
        _next = re.sub(
            r'^(?:'
            r'cd\s+([\'"]?)[^&|;<>\s\'"]+\1\s*(?:&&|;)\s*'  # cd <dir> && / ;
            # `set -o pipefail && …` / `set -euo pipefail; …`. A `set` builtin only
            # flips shell options — it runs NO command — so peeling it can't hide a
            # heavy command, and NOT peeling it made this gate deny the very remedy its
            # own error message prescribes: `cd d && set -o pipefail && scripts/
            # pc-heavy.sh -- vitest` stopped peeling at `set`, missed the pc-heavy lead,
            # and got denied as a raw `vitest`. Same "the remedy doesn't work" trap
            # EI-9634 fixed for `cd`/subshell — and it punished exactly the right habit,
            # since pipefail is what stops `… | tail` from masking a real exit code.
            r'|set\s+(?:-o\s+[\w-]+|\+o\s+[\w-]+|[-+][A-Za-z]+)(?:\s+(?:-o\s+[\w-]+|\+o\s+[\w-]+|[-+][A-Za-z]+))*\s*(?:&&|;)\s*'
            r'|\(\s*'  # one subshell open: ( scripts/pc-heavy.sh … ) &
            r'|sudo(?:\s+(?:-[ugpUrCht]\s+\S+|-[A-Za-z]+|--[\w-]+(?:=\S*)?))*\s+'
            r'|env(?:\s+[A-Za-z_]\w*=\S*)*\s+'
            r'|nice(?:\s+-n\s*-?\d+)?\s+'
            r'|ionice(?:\s+-\w+(?:\s+\d+)?)*\s+'
            r'|rtk\s+|time\s+'
            r'|timeout(?:\s+(?:-[a-zA-Z]\S*|--[\w-]+(?:=\S*)?))*\s+-?\d+\S*\s+'
            r')',
            '', _pc_lead, count=1)
        if _next == _pc_lead:
            break
        _pc_lead = _next
    if re.match(r'(?:bash\s+|sh\s+)?(?:\S*/)?pc-heavy\.sh(?:\s|$)', _pc_lead):
        return
    #   (b) a leading `PC_HEAVY_BYPASS=1` env-assignment prefix (bare, behind
    #       other assignments, or behind `env`) — mirrors the message's own
    #       `PC_HEAVY_BYPASS=1 <cmd>` remedy and the `env`-prefixed heavy form
    #       the anchor already recognizes. Same `cd <dir> &&` allowance as (a).
    _bypass_lead = re.sub(
        r'^cd\s+([\'"]?)[^&|;<>\s\'"]+\1\s*(?:&&|;)\s*', '', _lead, count=1)
    if re.match(r'(?:env\s+)?(?:[A-Za-z_]\w*=\S*\s+)*PC_HEAVY_BYPASS=1(?:\s|$)', _bypass_lead):
        return
    #   (c) a leading `PC_HEAVY_ADMISSION=off` env-assignment prefix (EI-10913):
    #       the deny message advertises `PC_HEAVY_ADMISSION=off` as the
    #       kill-switch, but the env read at the TOP of this function only sees
    #       it when it is ALREADY in this process's env — which an agent cannot
    #       set from a Bash call (the assignment applies to the CHILD, not to
    #       this hook). So the guard's own documented escape hatch was itself
    #       denied under the exact high load it exists for — the "guard blocks
    #       its own remedy" bug. Read it in-band from the command text too,
    #       accepting the same off-values the env read does (off/0/false/no,
    #       value case-insensitive; the env-var NAME stays literal since a shell
    #       assignment is case-sensitive). Same `cd <dir> &&` and leading-
    #       assignment/`env` allowance as the PC_HEAVY_BYPASS check above.
    if re.match(r'(?:env\s+)?(?:[A-Za-z_]\w*=\S*\s+)*PC_HEAVY_ADMISSION=(?i:off|0|false|no)(?:\s|$)',
                _bypass_lead):
        return
    # Only throttle agent / shared-tree sessions — never the owner's own box
    # work. Mirror the git-guard's marker-OR-tree gate so marker-less fleet
    # sessions (EI-7872) are still covered.
    if not (os.environ.get('PAPERCUSP_AGENT_SESSION') == '1' or _cmd_in_canonical_tree()):
        return
    # Heavy = the batch test/build commands that spawn worker pools. Anchored at
    # command position (start / after ;&|newline / a known wrapper / a path/) so
    # a prose arg, a config filename, or a docs path never false-positives; the
    # executable must be followed by whitespace or end so `vitest.config`,
    # `vitest-guide`, `testing` etc. don't match. Bare `tsx` is intentionally
    # NOT heavy (it runs light one-shot scripts far more often than builds).
    anchor = (r'(?:^|[;&|\n]\s*|\bsudo\s+|\bnice\s+(?:-n\s*-?\d+\s+)?'
              r'|\bionice\s+(?:-\S+\s*)*|\benv\s+(?:\S+=\S*\s+)+|\brtk\s+|\btime\s+|\S*/)')
    heavy_re = re.compile(
        anchor + r'(?:'
        r'(?:npx\s+|pnpm\s+|bunx\s+)?vitest(?=\s|$)'
        r'|(?:npx\s+)?tsc(?=\s|$)'
        r'|npm\s+(?:run\s+)?test(?::[\w-]+)?(?=\s|$)'
        r'|npm\s+run\s+build(?=\s|$)'
        r'|turbo\s+run\s+(?:test|build|typecheck)\b'
        r')',
        re.IGNORECASE,
    )
    # Use the same peeled command used for the pc-heavy bypass check so benign
    # wrappers such as `timeout 90` cannot hide a raw heavy command from the
    # admission gate while still allowing the blessed wrapper above through.
    if not heavy_re.search(_pc_lead):
        return
    # Local load signal — captures ALL contributors (vitest+tsc+onnx+…), more
    # robust than counting only wrapped runs. Env overrides for tests.
    try:
        _ov = os.environ.get('PC_HEAVY_LOAD1_OVERRIDE')
        load1 = float(_ov) if _ov not in (None, '') else os.getloadavg()[0]
        cores = os.cpu_count() or 1
        _mx = os.environ.get('PC_HEAVY_MAX_LOAD1')
        max_load1 = float(_mx) if _mx not in (None, '') else round(1.5 * cores)
    except Exception:
        return  # can't read load/cores → fail-open
    if load1 > max_load1:
        deny(
            f'heavy-command admission (WI-3821): host load1={load1:.0f} is over the '
            f'{max_load1:.0f} threshold (~1.5x cores) — starting another vitest/tsc/'
            f'test build now would pile onto an already-saturated box (this class '
            f'melted the host to load 3000+ twice this week). Either wait ~30-60s and '
            f're-run once load drops, or run it under `scripts/pc-heavy.sh -- <your '
            f'command>`, which waits for a free build slot (flock counting semaphore) '
            f'and runs niced instead of failing. Kill-switch (prepend inline): '
            f'`PC_HEAVY_ADMISSION=off <your command>`.'
        )

try:
    _heavy_admission()
except Exception:
    pass  # admission control must never wedge a command

# ── Substitution pre-filter (bash-to-tool-substitution-2026-07-26, P-016) ───
# The bash→tool substitution registry claims commands by the VERB at the head
# of a command atom (`sed -n '1,80p' f`, `cat f`, `psql -c "SELECT …"`). Testing
# those verbs as bare substrings would be a disaster: `re.search('cat', cmd)`
# matches "concatenate", "duplicate", "categories" — so nearly every command
# would pay the HTTP round-trip this pre-filter exists to avoid.
#
# So this is a direct port of the server's own atomizer
# (packages/operator-core/lib/bash-substitution/atomize.ts): split on the same
# separators, peel the same runner/env prefixes, take the first token with any
# leading path stripped. Matching the server's definition of an ATOM here is not
# tidiness — a pre-filter that disagrees with the matcher silently drops the
# very commands a rule was written for, and that failure is invisible (no error,
# just an advisory that never fires).
_SUBST_SPLIT_RE = re.compile(r'\|\||&&|\||;|\n')
_SUBST_RUNNER_RE = re.compile(
    r'^(?:sudo\s+(?:-n\s+)?|nohup\s+|timeout\s+\S+\s+|time\s+|env\s+|command\s+|exec\s+)+')
_SUBST_ENV_RE = re.compile(r'^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+')

# Atom heads any enabled registry row can claim. Kept as a SET (not a regex
# alternation) so it stays a cheap hash lookup on the hot path.
#
# DRIFT IS THE HAZARD HERE — the same one migration 665's comment names about
# the resource pre-filter ("a new resource with a novel pattern needs a token
# added here"). A row added to the registry whose verb is missing from this set
# is enforced nowhere and reports nothing. That is guarded mechanically rather
# than by memory: bash-resource-gate.test.ts replays every atom in the committed
# equivalence FIXTURES through this script and asserts each one reaches the
# operator, so adding a pair without adding its verb here fails that test.
#
# P-009 adds 'systemctl' and 'curl' (the service family). `systemctl` is ALSO
# matched by the resource regex below, so it reaches the operator either way
# today — it is listed here regardless, because the two pre-filters answer
# different questions and a future edit to the resource token list must not
# silently disable the substitution rules that depend on this verb.
#
# P-010 adds 'git' (the git-read family, `capability:git`). Reads only — the
# pair's own pattern decides which `git` atoms it claims; this set only decides
# which ones pay the operator round-trip at all.
#
# 'ss'/'netstat'/'lsof' serve `service.listening-ports` → `dev:listening_ports`.
# The pair's own bashPattern (/^(?:ss|netstat)(?:\s+-|\s*$)|^lsof\b[^\n]*\s-{1,2}i/)
# decides which atoms it actually claims — notably only `lsof` calls carrying an
# `-i`/`--i` socket selector. This set only decides which heads pay the operator
# round-trip at all, so it lists the bare verbs.
#
# P-021 adds 'npx'/'vitest' (the test family → `testing:run`): `tests.raw-vitest`
# claims `(npx )?vitest run <paths>`, so the head after runner/env stripping is
# either `npx` or the bare `vitest`. Its sibling `tests.router-files` claims
# `npm run test:file -- <paths>`, whose head is `npm` — deliberately NOT listed
# here, because `npm` fronts nearly every build/test/lint command in this repo
# and `npm run lint` must keep paying nothing. That shape is matched as a PHRASE
# by _SUBSTITUTION_PHRASE_RE below instead.
#
# P-023 adds 'journalctl' (the service-log family → `logs:read`). The pair's own
# pattern excludes the non-window shapes (follow, boot selection, kernel,
# cursors, maintenance verbs) and elevated reads, so this only decides which
# atoms pay the operator round-trip at all.
#
# P-026/P-027 add the AMBIENT-CONTEXT family ('date', 'uptime', 'nproc',
# 'free') — the four reads whose answer coord:orient already delivers in the
# agent's `host` block, so the substitution is "call nothing". Only a
# COMMAND-POSITION atom head is tested, so an inline `$(date …)` string
# interpolation inside a larger command is NOT claimed (its head is the outer
# verb) — which is exactly right: that shape has no tool form and the pairs
# deliberately exclude it.
_SUBSTITUTION_HEADS = frozenset((
    'sed', 'cat', 'head', 'tail', 'psql', 'systemctl', 'curl', 'git',
    'ss', 'netstat', 'lsof',
    'npx', 'vitest', 'journalctl',
    'date', 'uptime', 'nproc', 'free',
))

# Narrow phrases a substitution row claims whose bare head is too common for the
# set above (see the P-021 note). Byte-for-byte twin of the TS hook's
# SUBSTITUTION_PHRASE_RE; tested against the atom AFTER runner/env stripping.
#
# P-028 adds `npm install|ci|i` for the same reason `npm run test:file` is here
# rather than in the head set: `npm` fronts nearly every command in this repo,
# and `npm run lint` must keep paying nothing. The pair's own pattern is far
# narrower still (flags-only whole-tree reifies); this phrase only decides which
# atoms pay the operator round-trip at all.
_SUBSTITUTION_PHRASE_RE = re.compile(r'^npm\s+run\s+test:file\b|^npm\s+(?:install|ci|i)(?=\s|$)')


def _substitution_prefilter_hit(cmd):
    for part in _SUBST_SPLIT_RE.split(cmd):
        atom = part.strip()
        while True:
            stripped = _SUBST_ENV_RE.sub('', _SUBST_RUNNER_RE.sub('', atom))
            if stripped == atom:
                break
            atom = stripped
        if not atom:
            continue
        if _SUBSTITUTION_PHRASE_RE.search(atom):
            return True
        head = atom.split()[0].split('/')[-1].strip('({`$\'"')
        if head in _SUBSTITUTION_HEADS:
            return True
    return False


# Cheap local pre-filter — skip the HTTP round-trip for the commands that can
# touch neither a registered resource nor a substitution rule. Tokens mirror the
# seeded patterns.
try:
    _needs_check = bool(
        re.search(r'systemctl|overmind|psql|astro|build-desktop-sidecar|release-local|npm\s+run\s+(dev|build)', command)
    ) or _substitution_prefilter_hit(command)
except Exception:
    _needs_check = False  # a pre-filter bug must never wedge a command
if not _needs_check:
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

# `_meta.format = 'json'` is REQUIRED, not a nicety. `locks:check_command`
# returns a tabular `substitutions[]`, so the agent transport serializes the
# result as TOON by default — and the parse below is `json.loads`. Without this
# the parse throws, `inner` stays None, and the fail-open at the bottom of this
# block does exactly what it promises: every resource hold and every
# substitution row silently stops being enforced, with no error anywhere.
#
# That is not hypothetical — it is the state this call was in when P-028 tried
# to ship the registry's first `deny` and found the gate had been dead on BOTH
# hook paths. The suites never caught it because they stub the operator with
# JSON, which is the one thing it does not send. `_meta.format` is the
# documented negotiation channel for exactly this (a MACHINE parser declaring
# what it can decode); the OMP hook declares the same thing on its own call.
body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {
        'name': 'locks:check_command',
        'arguments': {'command': command},
        '_meta': {'format': 'json'},
    },
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
if not inner:
    allow()

# ── Substitution verdict (bash-to-tool-substitution-2026-07-26, P-016) ──────
# Same round-trip, second question: did a registry rule claim this command?
# This is a new matched CLASS inside the existing three-tier design, NOT a
# fourth mechanism (plan D-003) — `advise` reuses the ADVISORY channel three
# guards above already ride on, and `deny` reuses deny().
#
# The resource verdict is evaluated FIRST and wins: an exclusive hold means a
# peer is mid restart/migration right now, which is a live collision, whereas a
# substitution is a lasting suggestion about tool choice. Telling an agent
# "prefer capability:read" while its command would collide with a migration
# would bury the urgent message under the educational one.
#
# Wrapped whole in try/except: a malformed substitutions payload must degrade to
# the resource-only behaviour this file had before, never wedge a command.
try:
    _subs = inner.get('substitutions') or []
    _stier = inner.get('substitutionTier')
except Exception:
    _subs, _stier = [], None

if inner.get('decision') == 'block':
    matched = inner.get('matched') or []
    names = ', '.join(m.get('resource', '?') for m in matched) or 'a registered resource'
    deny(
        f"resource-gate: this command touches {names}, which has an exclusive hold "
        f"in flight (a peer is restarting/migrating it). Wait for the 'back up' "
        f"broadcast, or coordinate via locks:list / locks:acquire_resource. "
        f"Use the blessed wrapper (dev:restart / db:migrate) instead of a raw command."
    )

try:
    if _stier in ('advise', 'deny') and _subs:
        # One line per claimed intent: the advisory_text is authored per row and
        # is the whole point of the registry — a tier that fires without it
        # teaches nothing, which is the dev:processes outcome migration 665's
        # CHECK constraint exists to prevent.
        _lines = []
        for _s in _subs:
            _tool = _s.get('toolName') or '?'
            _text = (_s.get('advisoryText') or '').strip()
            _atom = (_s.get('atom') or '').strip()
            _lines.append(
                '  • `%s` → %s\n    %s' % (_atom[:160], _tool, _text) if _text
                else '  • `%s` → %s' % (_atom[:160], _tool)
            )
        _body = '\n'.join(_lines)

        if _stier == 'deny':
            deny(
                'substitution-gate: this command has a tool form that must be used '
                'instead.\n\n%s\n\nRe-run using the tool above. (This rule reached '
                '`deny` only by proving equivalence against real sampled commands, '
                'or because the prohibition already existed independently.)' % _body
            )
        elif not ADVISORY:
            # SOFT: rides out as additionalContext on an explicit allow. The
            # command proceeds exactly as issued — this only teaches the routing.
            ADVISORY = (
                'bash→tool advisory: a tool already answers this question '
                'directly.\n\n%s\n\nThe tool call is cheaper (no shell round-trip, '
                'structured result) and is what the routing table points at. '
                'Advisory only; this command is proceeding as issued.' % _body
            )
except Exception:
    pass  # advisory must never wedge a command

allow()
PYEOF
