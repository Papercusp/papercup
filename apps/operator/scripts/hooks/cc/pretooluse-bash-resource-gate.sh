#!/usr/bin/env bash
# PreToolUse hook — gate raw `Bash` commands against the named-resource lock
# registry (plan named-resource-locks-drain, P-026/D-013). When a command
# would collide with an in-flight EXCLUSIVE hold on a registered resource
# (e.g. a peer is mid `dev:restart`), block it; otherwise proceed.
#
# ALSO: the native-scheduler lockout (native-scheduler-lockout-2026-06-09
# P-010) — when this session is an AGENT session (PAPERCUSP_AGENT_SESSION=1:
# role panes, the brain/Queen — OR PAPERCUSP_FLEET_SLUG set, the backstop for
# a fleet member whose launch path dropped the marker, EI-18815668439722436;
# the owner's own plain sessions set neither), deny persistent OS schedulers
# (crontab/at/batch/systemd-run) at command position. Local regex, no HTTP.
# Catches the compound forms (`cd x && crontab …`) the launch-time
# Bash(crontab:*) prefix deny-patterns can't. Wakes belong in the harness
# routines table (hive:declare-wake) — the only scheduler that
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
import hashlib, json, os, re, sys, tempfile, time, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

raw, operator_url, token, agent_id = sys.argv[1:5]

# Soft advisory attached to an ALLOW verdict (coord-delivery-residual-gaps
# P-003). None = plain silent allow; a string rides out as additionalContext
# on an explicit permissionDecision:'allow' payload. Denies always win — the
# advisory only decorates commands every gate already passed.
ADVISORY = None

# ── Say-once advisory suppression (context-injection-audit P-020, D-030+D-031) ──
#
# This gate is a STATELESS function of the current command, so before this it
# had no dedup of any kind — every matching command re-emitted the FULL
# advisory verbatim. Measured 2026-07-28 in ONE session: the ~700-char SIGPIPE
# advisory fired 3x and the bash→tool routing advisory 4x, byte-identical,
# against a TURN_START_BUDGET_CHARS of 4,000 for ALL of memory. This file is
# 109KB carrying 29 distinct advisory classes and is subject to no budget at
# all — it outspends the one channel that IS disciplined.
#
# The fix is the coord rail's cursor semantics: say it once, then suppress.
# It is deliberately a HYBRID, because the two halves have different hot paths:
#
#   * the SUPPRESSION DECISION runs on EVERY guarded call (~10,216/day
#     fleet-wide) on the latency-critical path of every bash command, so it is
#     a LOCAL seen-set file — zero network, zero operator dependency;
#   * the DELIVERY RECORD is written only on an advisory's FIRST appearance in
#     a session (~590/day), so it can afford one fire-and-forget call. It goes
#     to activity:report, NOT coord (D-031): a coord row is a MESSAGE that
#     lands in agents' inboxes and fires migration 126's unconditional
#     pg_notify waking every live LISTEN connection (34 measured), whereas
#     agent_activity carries 1 trigger and already absorbs 58,764 rows/day
#     from this same hook family.
#
# FAIL-OPEN IN BOTH DIRECTIONS: any error resolving, reading or writing the
# seen-set means we EMIT — the legacy behaviour — never suppress. A dedup bug
# must never silently swallow a safety advisory.


def _session_key():
    """Stable per-session id, matching the precedence the file-lock hook uses."""
    sid = os.environ.get('PAPERCUSP_SID')
    if not (isinstance(sid, str) and sid):
        try:
            sid = payload.get('session_id')
        except Exception:
            sid = None
    if not (isinstance(sid, str) and sid):
        sid = agent_id
    return re.sub(r'[^A-Za-z0-9_.-]', '_', str(sid))[:120]


def _advisory_class_key(text):
    """A stable CLASS key for an advisory — deliberately NOT a hash of the text.

    The bash→tool routing advisory embeds the offending command, so the same
    advisory class arrives with different bytes every time (observed 4x in one
    session with 4 different commands). Hashing the raw text would therefore
    dedup nothing for exactly the advisory that repeats most. So: prefer the
    explicit EI tag when the advisory carries one (25 of the 29 classes do),
    and otherwise hash only the advisory's stable LEAD paragraph, with the
    spans that vary per fire normalised out.

    THE LEAD-PARAGRAPH RULE IS LOAD-BEARING, and was added after the first
    implementation was observed missing live (2026-08-01, three fires in one
    session). Every advisory here opens with a fixed self-identifying sentence
    and then interpolates a per-command body, so hashing the WHOLE text keys on
    that body:
      * bash→tool builds a bullet per detected substitution, so the same class
        hashed differently with one bullet (`sed`) vs two (`sed` + `tail`);
      * long-foreground-exec interpolates the timeout into its first sentence,
        so a 300s call and a 400s call were two different classes.
    Both re-fired in one session — the exact repetition P-020 exists to stop.
    Cutting at the first blank line, and normalising digit runs as well as
    backticked spans, makes both stable without needing a tag per class.
    """
    m = re.search(r'EI-\d+', text)
    if m:
        return m.group(0)
    lead = re.split(r'\n\s*\n', text.strip(), maxsplit=1)[0]
    norm = re.sub(r'`[^`]*`', '`X`', lead)
    norm = re.sub(r'\d+', 'N', norm)
    norm = re.sub(r'\s+', ' ', norm).strip()
    return 'adv-' + hashlib.sha1(norm.encode('utf-8', 'replace')).hexdigest()[:16]


# A session key must never suppress an advisory FOREVER. The seen-set is keyed
# on a session id, and session ids RECUR — a fixture/harness that reuses one, a
# long-lived pane, a plain collision. Without an expiry the first fire of a
# class is the ONLY one that box ever sees, which is exactly the "silently
# swallow a safety advisory" failure this dedup promises above not to be.
_ADVISORY_SEEN_TTL_SEC = 24 * 3600
# Bound the opportunistic prune's work — it must stay cheap, not be exhaustive.
_ADVISORY_SEEN_PRUNE_SCAN = 500


def _advisory_seen_dir():
    """Per-$HOME seen-set, alongside this hook's other state (_BG_TRACK_FILE).

    Deliberately NOT tempfile.gettempdir(): /tmp is machine-global — shared by
    every user, install and test run on the box — and invisible to anything
    that cleans up ~/.papercusp. Keying suppression there silently broke the
    hermetic-fake-$HOME contract every caller of this hook is tested against:
    state leaked in from unrelated runs and suppressed advisories that had
    never fired for that caller at all (WI-6671).
    """
    return os.path.join(os.path.expanduser('~'), '.papercusp', 'advisory-seen')


def _prune_advisory_seen(base):
    """Drop seen-sets past the TTL so the dir cannot grow without bound.

    Best-effort, and deliberately only on the FIRST-write path (~590/day) —
    never on the suppression decision (~10,216/day), which stays one stat plus
    one small read on the latency-critical path of every bash command.
    """
    try:
        now = time.time()
        for name in os.listdir(base)[:_ADVISORY_SEEN_PRUNE_SCAN]:
            p = os.path.join(base, name)
            try:
                if now - os.path.getmtime(p) > _ADVISORY_SEEN_TTL_SEC:
                    os.unlink(p)
            except OSError:
                pass
    except Exception:
        pass


def _claim_advisory(key):
    """True if THIS call is the first to say `key` in this session.

    Append-only file, one key per line. A short O_APPEND write is atomic on
    local filesystems, so two hook processes racing the same advisory can at
    worst both emit once — the race can never SUPPRESS a first emit, which is
    the only direction that would lose information.

    A seen-set older than _ADVISORY_SEEN_TTL_SEC is treated as a NEW session
    (re-armed by truncation, not appended to), so a recurring session id
    re-arms instead of suppressing for the life of the box. The re-arm race is
    the same safe direction: two racing processes can only make an advisory
    emit twice, never suppress its first emit.
    """
    try:
        base = _advisory_seen_dir()
        os.makedirs(base, exist_ok=True)
        path = os.path.join(base, _session_key())
        fresh = True  # no seen-set yet, or one old enough to have lapsed
        try:
            if time.time() - os.path.getmtime(path) <= _ADVISORY_SEEN_TTL_SEC:
                fresh = False
                with open(path, 'r', encoding='utf-8') as fh:
                    if key in {ln.strip() for ln in fh}:
                        return False
        except OSError:
            pass  # missing or unreadable — treat as a first fire, never suppress
        if fresh:
            _prune_advisory_seen(base)
        with open(path, 'w' if fresh else 'a', encoding='utf-8') as fh:
            fh.write(key + '\n')
        return True
    except Exception:
        return True  # fail-open: emit rather than risk swallowing an advisory


def _record_delivery(key):
    """Best-effort audit ledger: 'did the guard warn it, and when?' (P-020).

    Fires only on an advisory's FIRST appearance in a session. Never raises and
    never affects the verdict — a ledger write must not make a bash command
    slower to fail than to succeed.
    """
    if os.environ.get('PAPERCUSP_ADVISORY_LEDGER') == '0':
        return
    try:
        body = json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
            'params': {
                'name': 'activity:report',
                'arguments': {
                    'kind': 'lifecycle',
                    'owner': agent_id,
                    'session_id': _session_key(),
                    'status': 'advisory',
                    'summary': 'advisory delivered (say-once): ' + key,
                },
                '_meta': {'format': 'json'},
            },
        }).encode()
        req = urllib.request.Request(
            operator_url.rstrip('/') + '/api/mcp?superuser=1&client='
            + urllib.parse.quote(agent_id, safe=''),
            data=body,
            headers={
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
            },
            method='POST',
        )
        urllib.request.urlopen(req, timeout=2).close()
    except Exception:
        pass


def allow():
    global ADVISORY
    if ADVISORY:
        _key = _advisory_class_key(ADVISORY)
        if _claim_advisory(_key):
            _record_delivery(_key)
        else:
            ADVISORY = None  # already said this session — say it once
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

# ══ SCANNABLE COMMAND — the shared normalizer every DENY guard matches through ══
#
# EI-19294800751120438. Before this existed, every deny-guard in this file
# re-implemented its own matching on RAW text: split on [;&|\n], peel a
# hand-maintained wrapper NAME-list (_WRAP_STRIP), re.match an anchored pattern.
# Measured 4 DENY / 14 probes on the shared-tree git guard — `bash -c "..."`,
# `sh -c`, `eval`, `git "reset" "--hard"`, `$(echo git) reset --hard`,
# `x=git; $x reset --hard`, `echo "..." | bash`, `env -S "..."` and
# `timeout 60 ...` ALL sailed through, and the same held for the pkill,
# systemctl-exit and crontab guards. The wrapper name-list is what rotted:
# the 2026-07-06 `rtk git reset --hard` bypass was fixed by ADDING `rtk` to the
# list, which left `timeout` (and every future wrapper) open.
#
# The fix is structural, ported from yc-software/qm's src/policy/command-policy.ts
# (`scannableCommand`), which scored 13/14 on the same probes running OUR rules:
#
#   scannable = dequote(strip_written_heredocs(cmd))
#               + "\n" + scannable(each executed-shell payload)   [recursive]
#
# Two properties make it drop-in for the existing guards:
#   1. Payloads are joined with NEWLINES, and every guard already splits on
#      [;&|\n] — so a `bash -c "git reset --hard"` payload arrives as its own
#      segment for free, with no change to any guard's patterns.
#   2. Quoted spans that are a single BARE WORD are unquoted in place (catching
#      `git "reset" "--hard"`), while quoted spans holding a whole command
#      collapse to "" in the base and are recovered as a separate payload line.
#
# Wrapper handling is STRUCTURAL (parse the argv, find the real command word)
# rather than a name-list, so `timeout`/`nice`/`sudo`/`env -S` cannot rot again.
#
# Guards keep their own patterns; only the TEXT they match against changes.
# Regression table: __tests__/bash-resource-gate.test.ts.

_SCAN_BARE_WORD_RE = re.compile(r'^[\w@%+=:,./-]*$')
_SCAN_MAX_DEPTH = 8
_SCAN_SHELLS = ('bash', 'sh', 'dash', 'zsh', 'ksh')


def _scan_bare_word(inner):
    """qm's unquoteBareWord: the quoted span's content, iff it is one safe word."""
    return inner if _SCAN_BARE_WORD_RE.match(inner) else None


def _scan_decode_ansi_c(value):
    """Decode a $'...' ANSI-C span so \\x67\\x69\\x74 cannot hide a keyword."""
    def _hex(m):
        return chr(int(m.group(1), 16))

    def _octal(m):
        return chr(int(m.group(1), 8))

    simple = {'a': '\a', 'b': '\b', 'e': '\x1b', 'f': '\f',
              'n': '\n', 'r': '\r', 't': '\t', 'v': '\v'}
    value = re.sub(r'\\x([0-9a-fA-F]{1,2})', _hex, value)
    value = re.sub(r'\\u([0-9a-fA-F]{4})', _hex, value)
    value = re.sub(r'\\U([0-9a-fA-F]{8})', _hex, value)
    value = re.sub(r'\\([0-7]{1,3})', _octal, value)
    return re.sub(r'\\([\\\'"abefnrtv])',
                  lambda m: simple.get(m.group(1), m.group(1)), value)


def _scan_heredoc_runs_shell(command_line):
    """True when the heredoc on this line is PIPED INTO a shell (so its body is
    executed and must be scanned) rather than merely written to a file."""
    for m in re.finditer(r'(?:^|[|;&]\s*)(?:\S*/)?(?:ba|da|k|z)?sh((?:\s+[^|;&]*)?)',
                         command_line):
        if not re.search(r'(?:^|\s)-[^-\s]*c(?:\s|$)', m.group(1) or ''):
            return True
    return False


def _scan_strip_written_heredocs(cmd):
    """Drop heredoc BODIES that are only written to a file — their content is
    inert data (`cat <<EOF > notes.txt` describing a dangerous command is not
    running it). Bodies fed to a shell are KEPT so they stay scannable."""
    def _repl(m):
        pre, post = m.group(1), m.group(4)
        line = pre + post
        if '>' in line and not _scan_heredoc_runs_shell(line):
            return ''
        return m.group(0)

    return re.sub(
        r'^([^\n]*)<<-?\s*(["\']?)([A-Za-z_]\w*)\2([^\n]*)\n([\s\S]*?)^\s*\3\s*$',
        _repl, cmd, flags=re.M)


# Shell metacharacters neutralized when a MULTI-WORD quoted span is unwrapped.
# Blanking them keeps the span's words visible to a guard while guaranteeing the
# unwrap can never manufacture a separator/redirect that wasn't there.
_SCAN_INERT_METACHARS = re.compile(r'[;&|<>()`{}\n]')


def _scan_unquote_span(inner):
    """The scannable text for a quoted span.

    qm collapses a multi-word span to `""` — correct for qm, whose rules are
    UNANCHORED substrings, so the payload is recovered on its own line anyway.
    Here it LOSES information a guard needs: `pkill -f "npm run test"` became
    `pkill -f ""` and the pkill guard (which matches on the pattern ARGUMENT)
    stopped firing — a real regression caught by the existing suite.

    So keep the content and neutralize the metacharacters instead. The words stay
    matchable; `echo "done; ok" && crontab -e` cannot gain a fake `;` separator.
    Guards stay anchored (`re.match`), so surfacing inner words does NOT create
    false positives: `git commit -m "explain git reset --hard"` still starts its
    segment with `git commit`, which no destructive-git pattern matches."""
    word = _scan_bare_word(inner)
    if word is not None:
        return word
    return _SCAN_INERT_METACHARS.sub(' ', inner)


def _scan_dequote(cmd):
    """Unquote quoted spans, decode $'...', unescape backslashes.
    A quoted span containing a command substitution keeps the substitution."""
    def _dq(m):
        span = m.group(0)
        subs = re.findall(r'\$\([^)]*\)|`[^`]*`', span)
        if subs:
            return ' '.join(subs)
        return _scan_unquote_span(span[1:-1])

    def _ansi(m):
        return _scan_unquote_span(_scan_decode_ansi_c(m.group(1)))

    def _sq(m):
        return _scan_unquote_span(m.group(0)[1:-1])

    out = re.sub(r'"(?:[^"\\]|\\.)*"', _dq, cmd)
    out = re.sub(r"\$'((?:[^'\\]|\\.)*)'", _ansi, out)
    out = re.sub(r"'[^']*'", _sq, out)
    return re.sub(r'\\([\w@%+=:,./-])', r'\1', out)


def _scan_command_substitution(text, start):
    """Body + end offset of the $( ... ) beginning at `start`, honouring nesting
    and quotes. None when unterminated."""
    depth, quote, j = 1, '', start + 2
    while j < len(text):
        c = text[j]
        if c == '\\':
            j += 2
            continue
        if quote:
            if c == quote:
                quote = ''
            j += 1
            continue
        if c in ('"', "'"):
            quote = c
        elif c == '$' and j + 1 < len(text) and text[j + 1] == '(':
            depth += 1
            j += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return text[start + 2:j], j + 1
        j += 1
    return None


def _scan_shell(text):
    """Tokenize into command word-lists (split on shell operators/newlines) and
    collect the bodies of every $( ) / backtick substitution as `nested`."""
    commands, nested, words = [], [], []
    i, n = 0, len(text)

    def _flush():
        if words:
            commands.append(list(words))
            del words[:]

    while i < n:
        c = text[i]
        if c.isspace():
            if c == '\n':
                _flush()
            i += 1
            continue
        if c == '#' and not words:
            while i < n and text[i] != '\n':
                i += 1
            continue
        if c in ';|&(){}':
            _flush()
            while i < n and text[i] in ';|&(){}':
                i += 1
            continue
        word, started = '', False
        while i < n and not text[i].isspace() and (
                text[i] not in ';|&(){}' or (text[i] == '&' and word.endswith(('<', '>')))):
            c = text[i]
            if c == '\\':
                if i + 1 < n and text[i + 1] == '\n':
                    i += 2
                elif i + 1 < n:
                    started = True
                    word += text[i + 1]
                    i += 2
                else:
                    i += 1
                continue
            if c == "'":
                started = True
                end = text.find("'", i + 1)
                if end < 0:
                    word += text[i + 1:]
                    i = n
                else:
                    word += text[i + 1:end]
                    i = end + 1
                continue
            if c == '"':
                started = True
                i += 1
                while i < n and text[i] != '"':
                    if text[i] == '\\':
                        if i + 1 < n:
                            word += text[i + 1]
                            i += 2
                        else:
                            i += 1
                        continue
                    if text[i] == '$' and i + 1 < n and text[i + 1] == '(':
                        sub = _scan_command_substitution(text, i)
                        if sub is None:
                            word += text[i]
                            i += 1
                        else:
                            nested.append(sub[0])
                            i = sub[1]
                        continue
                    if text[i] == '`':
                        end = text.find('`', i + 1)
                        if end < 0:
                            i += 1
                        else:
                            nested.append(text[i + 1:end])
                            i = end + 1
                        continue
                    word += text[i]
                    i += 1
                if i < n and text[i] == '"':
                    i += 1
                continue
            if c == '$' and i + 1 < n and text[i + 1] == '(':
                started = True
                sub = _scan_command_substitution(text, i)
                if sub is None:
                    word += text[i]
                    i += 1
                else:
                    nested.append(sub[0])
                    i = sub[1]
                continue
            if c == '`':
                started = True
                end = text.find('`', i + 1)
                if end < 0:
                    i += 1
                else:
                    nested.append(text[i + 1:end])
                    i = end + 1
                continue
            word += c
            started = True
            i += 1
        if started or word:
            words.append(word)
    _flush()
    return commands, nested


def _scan_command_start(words):
    """Index of the real command word, skipping VAR=val assignments, shell
    keywords and redirections."""
    i = 0
    while i < len(words):
        w = words[i]
        if re.match(r'^[A-Za-z_]\w*=', w) or re.match(r'^(?:if|then|elif|else|while|until|do|!)$', w):
            i += 1
        elif re.match(r'^\d*(?:>>?|<<?|<>|>&|<&)$', w):
            i += 2
        elif re.match(r'^\d*(?:>>?|<<?|<>|>&|<&).+', w):
            i += 1
        else:
            break
    return i


def _scan_option_end(words, start, value_options):
    """Index just past a wrapper's own options — where its wrapped command begins."""
    i = start
    while i < len(words):
        w = words[i]
        if w == '--':
            return i + 1
        if not w.startswith('-') or w == '-':
            return i
        if w.split('=')[0] in value_options and '=' not in w:
            i += 1
        i += 1
    return i


def _scan_env_split_words(args):
    """`env -S 'cmd args'` / `env --split-string=...` — the payload is a shell string."""
    idx = -1
    for i, a in enumerate(args):
        if a == '-S' or a.startswith('-S') or a == '--split-string' or a.startswith('--split-string='):
            idx = i
            break
    if idx < 0:
        return None
    arg = args[idx]
    compact = arg.startswith('-S') and len(arg) > 2
    if '=' in arg:
        value = arg.split('=', 1)[1]
    elif compact:
        value = arg[2:]
    else:
        value = args[idx + 1] if idx + 1 < len(args) else None
    rest = args[idx + (1 if ('=' in arg or compact) else 2):]
    if value is None:
        return []
    cmds, _ = _scan_shell(' '.join([value] + rest))
    return cmds[0] if cmds else []


def _scan_unwrapped(inner):
    """Emit a structural wrapper's INNER command line as its own payload, then
    keep descending.

    This is the one place papercusp deliberately diverges from qm. qm's rules are
    UNANCHORED substring patterns, so `timeout 60 git reset --hard` matches their
    base text directly and peeling is only needed for nesting. Every guard here
    uses an ANCHORED `re.match` (stricter — far fewer false positives on prose
    like `rg -n 'pkill'`), which means the segment must actually START with the
    real command word. So the wrapper has to be stripped into its own line, or an
    anchored guard can never see it."""
    if not inner:
        return []
    return [' '.join(inner)] + _scan_segment_payloads(inner)


def _scan_segment_payloads(words):
    """Shell payloads executed BY this command: a `-c` script, or the wrapped
    command of a structural wrapper. Recurses so `timeout 60 sudo bash -c X`
    yields X. This replaces the hand-maintained wrapper NAME-list."""
    start = _scan_command_start(words)
    if start >= len(words):
        return []
    exe = words[start].split('/')[-1]
    args = words[start + 1:]

    if exe in _SCAN_SHELLS:
        for i, a in enumerate(args):
            if re.match(r'^-[^-]*c', a):
                # `-c` script is the next word (or glued, e.g. `-xc`).
                return [args[i + 1]] if i + 1 < len(args) else []
        return []
    if exe == 'eval':
        return [' '.join(args)] if args else []
    if exe == 'env':
        split = _scan_env_split_words(args)
        if split is not None:
            return _scan_unwrapped(split)
        nxt = _scan_option_end(args, 0, {'-u', '--unset', '-C', '--chdir', '-S', '--split-string'})
        while nxt < len(args) and re.match(r'^[A-Za-z_]\w*=', args[nxt]):
            nxt += 1
        return _scan_unwrapped(args[nxt:])
    if exe == 'sudo':
        nxt = _scan_option_end(args, 0, {
            '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
            '-C', '--chdir', '-T', '--command-timeout', '-R', '--chroot', '-t', '--type'})
        return _scan_unwrapped(args[nxt:])
    if exe == 'timeout':
        nxt = _scan_option_end(args, 0, {'-s', '--signal', '-k', '--kill-after'})
        return _scan_unwrapped(args[nxt + 1:])
    if exe == 'nice':
        return _scan_unwrapped(args[_scan_option_end(args, 0, {'-n', '--adjustment'}):])
    if exe == 'ionice':
        return _scan_unwrapped(args[_scan_option_end(args, 0, {'-c', '-n', '-p'}):])
    if exe == 'time':
        return _scan_unwrapped(args[_scan_option_end(args, 0, {'-o', '--output', '-f', '--format'}):])
    if exe == 'xargs':
        nxt = _scan_option_end(args, 0, {
            '-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace',
            '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'})
        return _scan_unwrapped(args[nxt:])
    if exe in ('command', 'exec', 'nohup', 'setsid', 'stdbuf', 'nocache', 'nocorrect', 'rtk', 'doas', 'coproc'):
        value_opts = {'-a'} if exe == 'exec' else ({'-i', '-o', '-e'} if exe == 'stdbuf' else set())
        return _scan_unwrapped(args[_scan_option_end(args, 0, value_opts):])
    return []


def _scan_segment_consumes_stdin(words):
    """True when this pipeline stage feeds its STDIN to a shell (so the upstream
    `echo "..."` is executed): `| bash`, `| sh -s`, `| sudo bash`, …"""
    start = _scan_command_start(words)
    if start >= len(words):
        return False
    exe = words[start].split('/')[-1]
    args = words[start + 1:]
    if exe in _SCAN_SHELLS:
        stdin_scripts = {'-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'}
        i = 0
        while i < len(args):
            a = args[i]
            if re.match(r'^-[^-]*c', a):
                return False
            if a == '-s':
                return True
            if a in ('-O', '-o', '--rcfile', '--init-file'):
                i += 2
                continue
            if a == '--':
                return i + 1 >= len(args) or args[i + 1] in stdin_scripts
            if not a.startswith('-') or a == '-':
                return a in stdin_scripts
            i += 1
        return True
    if exe == 'env':
        split = _scan_env_split_words(args)
        if split is not None:
            return _scan_segment_consumes_stdin(split)
        nxt = _scan_option_end(args, 0, {'-u', '--unset', '-C', '--chdir', '-S', '--split-string'})
        while nxt < len(args) and re.match(r'^[A-Za-z_]\w*=', args[nxt]):
            nxt += 1
        return _scan_segment_consumes_stdin(args[nxt:])
    if exe in ('sudo', 'command', 'exec', 'nohup', 'setsid', 'rtk', 'doas', 'nice', 'timeout'):
        return _scan_segment_consumes_stdin(args[_scan_option_end(args, 0, set()):])
    return False


def _scan_pipelines(text):
    """Split into pipelines of segments so `echo X | bash` can be recognized."""
    pipelines, pipeline, start, quote = [], [], 0, ''

    def _finish_segment(end):
        seg = text[start:end].strip()
        if seg:
            pipeline.append(seg)

    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\\':
            i += 2
            continue
        if quote:
            if ch == quote:
                quote = ''
            i += 1
            continue
        if ch in ('"', "'", '`'):
            quote = ch
            i += 1
            continue
        if ch in '|&' and i + 1 < len(text) and text[i + 1] == ch:
            _finish_segment(i)
            if len(pipeline) > 1:
                pipelines.append(list(pipeline))
            del pipeline[:]
            i += 2
            start = i
            continue
        if ch == '|':
            _finish_segment(i)
            i += 2 if (i + 1 < len(text) and text[i + 1] == '&') else 1
            start = i
            continue
        if ch in ';\n&':
            _finish_segment(i)
            if len(pipeline) > 1:
                pipelines.append(list(pipeline))
            del pipeline[:]
            i += 1
            start = i
            continue
        i += 1
    _finish_segment(len(text))
    if len(pipeline) > 1:
        pipelines.append(list(pipeline))
    return pipelines


def _scan_piped_payloads(text):
    """`echo "git reset --hard" | bash` — the upstream literal is executed."""
    out = []
    for pipeline in _scan_pipelines(text):
        for idx in range(1, len(pipeline)):
            cmds, _ = _scan_shell(pipeline[idx])
            if not cmds or not _scan_segment_consumes_stdin(cmds[0]):
                continue
            upstream = pipeline[idx - 1]
            up_cmds, _ = _scan_shell(upstream)
            if not up_cmds:
                continue
            words = up_cmds[0]
            s = _scan_command_start(words)
            if s < len(words) and words[s].split('/')[-1] in ('echo', 'printf', 'cat'):
                out.append(' '.join(words[s + 1:]))
            else:
                out.append(upstream)
    return out


def _scan_here_string_payloads(text):
    """`bash <<< "git reset --hard"` — the here-string body is executed. Strip the
    ENCLOSING quotes before emitting: left on, the recursive dequote would see a
    multi-word quoted span, reject it as a non-bare-word and collapse it to ""."""
    out = []
    for m in re.finditer(r'<<<\s*(.+)', text):
        body = m.group(1).strip()
        if len(body) >= 2 and body[0] == body[-1] and body[0] in ('"', "'"):
            body = body[1:-1]
        if body:
            out.append(body)
    return out


_SCAN_SUBST_RE = re.compile(r'\$\(([^()]*)\)|`([^`]*)`')


def _scan_inlined_substitutions(text):
    """Emit a variant with simple command substitutions INLINED in place.

    `$(echo git) reset --hard` must produce a line that literally STARTS with
    `git`, because every guard anchors with re.match. Appending the substitution
    body as its own segment (which _scan_shell already does) is not enough — that
    segment is `echo git`, which no guard matches. So substitute the value in:
    `echo|printf <word>` contributes <word>; anything else collapses to nothing
    (never to its own text, which would re-introduce the wrapper word)."""
    def _inline(m):
        body = (m.group(1) if m.group(1) is not None else m.group(2) or '').strip()
        words = body.split()
        if len(words) >= 2 and words[0].split('/')[-1] in ('echo', 'printf'):
            return ' '.join(w for w in words[1:] if not w.startswith('-'))
        return ''

    if not _SCAN_SUBST_RE.search(text):
        return []
    out = _SCAN_SUBST_RE.sub(_inline, text)
    out = re.sub(r'\s+', ' ', out).strip()
    return [out] if out and out != text.strip() else []


def _scan_variable_payloads(text):
    """`x=git; $x reset --hard` — substitute simple literal assignments so the
    keyword is visible. Only plain `name=word` at a command position."""
    assigns = dict(re.findall(r'(?:^|[;&|\n]\s*)([A-Za-z_]\w*)=([\w@%+=:,./-]+)', text))
    if not assigns:
        return []
    def _sub(m):
        return assigns.get(m.group(1) or m.group(2), m.group(0))
    out = re.sub(r'\$\{(\w+)\}|\$(\w+)', _sub, text)
    return [out] if out != text else []


def _scan_executed_payloads(text):
    cmds, nested = _scan_shell(text)
    out = list(nested)
    for words in cmds:
        out.extend(_scan_segment_payloads(words))
    out.extend(_scan_piped_payloads(text))
    out.extend(_scan_here_string_payloads(text))
    out.extend(_scan_variable_payloads(text))
    out.extend(_scan_inlined_substitutions(text))
    return [p for p in out if p and p.strip()]


def _scannable_command(cmd, _depth=0):
    """The text every DENY guard should match against. Newline-joined so guards
    that already split on [;&|\\n] pick up nested payloads as free segments."""
    try:
        stripped = _scan_strip_written_heredocs(cmd)
        base = _scan_dequote(stripped)
        if _depth >= _SCAN_MAX_DEPTH:
            return base
        payloads = _scan_executed_payloads(stripped)
        if not payloads:
            return base
        seen, parts = set(), [base]
        for p in payloads:
            if p in seen:
                continue
            seen.add(p)
            parts.append(_scannable_command(p, _depth + 1))
        return '\n'.join(parts)
    except Exception:
        # A normalizer fault must never wedge every Bash call, and must never
        # make a guard MORE permissive than it was before: fall back to raw.
        return cmd


_SCANNABLE_CACHE = {}


def _scannable():
    """Memoized scannable form of THIS invocation's command. Lazy so a call that
    exits early on an advisory never pays for the normalization.

    Use for an ANCHORED guard (`re.match` at command position). Such a guard is
    safe to hand unquoted inner words: prose lands mid-segment, never at command
    position, so `git commit -m "explain git reset --hard"` cannot match."""
    if 'v' not in _SCANNABLE_CACHE:
        _SCANNABLE_CACHE['v'] = _scannable_command(command)
    return _SCANNABLE_CACHE['v']


def _scannable_quote_stripped():
    """Scannable form for a guard that must NOT see quoted PROSE.

    Some guards match a subcommand anywhere in the text rather than at command
    position (the tauri-agent-tools target guard, the scheduler keyword guard).
    Those relied on `_strip_shell_quotes` DELETING quoted spans, so a sentence like
    `echo "you could run tauri-agent-tools eval ..."` was not read as an
    invocation — surfacing the words instead re-created exactly that false deny
    (caught by the existing suite, EI-10939 / EI-9937).

    So keep the original base treatment (quoted spans removed) and append only the
    EXECUTED payload lines, which are genuine code rather than prose. That closes
    the `bash -c "crontab -e"` hole without weakening the prose exemption."""
    if 'qs' not in _SCANNABLE_CACHE:
        try:
            payloads = _scan_executed_payloads(_scan_strip_written_heredocs(command))
            parts = [_strip_shell_quotes(command)]
            seen = set()
            for p in payloads:
                if p in seen:
                    continue
                seen.add(p)
                parts.append(_scannable_command(p))
            _SCANNABLE_CACHE['qs'] = '\n'.join(parts)
        except Exception:
            _SCANNABLE_CACHE['qs'] = _strip_shell_quotes(command)
    return _SCANNABLE_CACHE['qs']

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

# ── Background `;`-chain TRAILING-REPORTER exit-code advisory (WI-6944) ────
# The other half of the trap above. That guard matches only a PIPE (`cmd |
# tee`); this one matches the `;`-chain, where the masking stage is a separate
# trailing command rather than a pipeline stage:
#
#     cmd > /tmp/out.txt 2>&1; echo "===EXIT:$?==="
#
# A `;`-chain exits with its LAST command's status, so the trailing `echo`
# (which always succeeds) replaces cmd's status and the notification reports
# "completed (exit code 0)" for a run that FAILED.
#
# The irony that makes this worth its own detector: the trailing command is
# almost always an EXIT MARKER the caller added precisely so the log would
# carry a trustworthy verdict. The diagnostic you reach for when you care most
# about the answer is exactly what erases the failure from the notification.
# Proven end-to-end 2026-08-02 (job bnmntj9o4): `sleep 2; false; echo
# "===PROOF_EXIT:$?==="` -> artifact `===PROOF_EXIT:1===`, notification
# "completed (exit code 0)". Three real `lint:tsc` runs the same night all
# ended `===TSC_EXIT:1===` with "1 NEW file(s) have type errors" under a
# reported exit 0, and were nearly accepted as a green gate check.
#
# Deliberately NOT escaped by a bare `EXIT=$?` capture, unlike the pipe guard
# above: capturing the code into the LOG makes the artifact honest but does
# nothing for the NOTIFICATION, and here that very echo is the masking cause.
#
# Three things ARE excluded, each because the author has already shown they
# know about exit codes — advising them is noise, and the pipe guard's suite
# already encodes the first two as deliberate non-targets:
#   * `&&` — short-circuits, so a failure propagates; not a hazard at all.
#   * `||` — writing a failure branch (`npm test || echo failed`) IS awareness
#     of the failure path. It does mask, but it masks a case the author chose.
#   * `pipefail` / `PIPESTATUS` — an explicit exit-status-preservation idiom.
# The target is the UNAWARE case: a plain `;` chain ending in a reporter.
#
# EI-18861104217890085: the reporter list used to be echo/printf/ls/date/stat/
# true/pwd/wc/cat/tee only — missing tail/head/grep/sed/awk/… entirely, even
# though the PIPE guard above already treats every one of those as a masking
# stage. That gap let the EXACT idiom the pipe guard's own docstring
# recommends as the safe alternative ("redirect to a log file … and read that
# instead: `cmd > /tmp/x.log 2>&1; head -N /tmp/x.log`") walk straight through
# this guard unadvised: `npm run test:affected > /tmp/x.log 2>&1; echo
# "EXIT=$?"; tail -25 /tmp/x.log` ends in `tail`, not `echo`, so the old list
# never matched it — a real FAILED affected-sweep was reported "completed
# (exit code 0)" (hit live 2026-07-28 verifying WI-6522). Aligned to the same
# reporter set the pipe guard already uses, so a caller can't route around
# this guard just by adding one more `;`-segment before the trailing reader.
try:
    if (tool_name.lower() == 'bash'
            and tool_input.get('run_in_background')
            and not ADVISORY
            and not re.search(r'pipefail|PIPESTATUS', command)):
        _tr_cmd = _strip_shell_quotes(command)
        # Already correct? Check RAW too — the fix is usually quoted.
        _EXIT_RESTORE_RE = re.compile(
            r'\bexit\s+"?\$\{?(?:rc|RC|status|code|\?)\}?"?\s*$')
        if not (_EXIT_RESTORE_RE.search(_tr_cmd.strip())
                or _EXIT_RESTORE_RE.search(command.strip())):
            _tr_segs = [s.strip() for s in re.split(r';|\n', _tr_cmd)
                        if s.strip()]
            # Only a MULTI-command line can mask: a lone `echo` masks nothing.
            if len(_tr_segs) >= 2 and re.match(
                    r'^(?:\S*/)?(?:echo|printf|ls|date|stat|true|pwd|wc|cat|tee'
                    r'|tail|head|grep|egrep|fgrep|sed|awk|sort|uniq|cut|tr'
                    r'|jq|column|xargs|tac|nl|less|more)\b',
                    _tr_segs[-1]):
                ADVISORY = (
                    'background `;`-chain exit-code advisory (WI-6944): this '
                    'backgrounded command ENDS in `'
                    + _tr_segs[-1].split()[0]
                    + '`, and a `;`-chain exits with its LAST command\'s status '
                    '— so the completion notification will report THAT (almost '
                    'always 0), not your real command\'s, and a FAILED run reads '
                    'as "completed (exit code 0)". If the trailing command is an '
                    'exit marker, note the irony: it is the very thing erasing '
                    'the failure. Fix by restoring the code on the way out — '
                    '`cmd > /tmp/out 2>&1; rc=$?; echo "===EXIT:$rc===" >> '
                    '/tmp/out; exit "$rc"` — which makes BOTH the log and the '
                    'notification truthful. Otherwise read the VERDICT from the '
                    'artifact\'s content and never from the notification\'s exit '
                    'code. Advisory only; this command is proceeding as issued.'
                )
except Exception:
    pass  # advisory must never wedge a command

# ── Foreground `| head` SIGPIPE-kill advisory (EI-18787618439028592) ───────
# `cmd | head -N` is a DIFFERENT hazard from the background-pipe exit-code
# trap above, and it applies in the FOREGROUND too (that advisory only fires
# when `run_in_background` is set): once `head` reads its N lines and exits,
# the upstream writer gets SIGPIPE and is KILLED mid-run — not a masked exit
# code, the command genuinely stops executing. The truncated output is
# byte-identical to a successful run's first N lines, so nothing in it
# signals the kill. `tail` is comparatively safe (it must consume all input
# to find the last N lines); `head` is the one that kills. Live incident: an
# agent piped a long-running live-DB schema-pull into `| head -3`, concluded
# the run had completed, and recorded a false "verified end-to-end" work-item
# completion for a run that had in fact written nothing — retracted a wake
# later only because a peer independently noticed the inconsistency.
#
# Backgrounded `| head` is already covered by the exit-code advisory above
# (which lists head alongside tail/grep/tee/…) and takes the one ADVISORY
# slot first, so this block only adds the FOREGROUND case — the gap the
# incident actually fell through. UNLIKE the exit-code advisory (Claude-only:
# `run_in_background` is a Claude Bash feature), SIGPIPE is a real OS signal
# that applies equally to Codex's exec_command/local_shell/shell — no
# tool_name restriction here (the tool_name in ('bash', 'exec_command',
# 'local_shell', 'shell') gate already ran at the top of the script). Skipped
# when the writer is already protected (`cat >/dev/null` anywhere after head
# keeps the pipe drained so the writer never sees SIGPIPE).
try:
    if not tool_input.get('run_in_background') and not ADVISORY:
        if 'cat >/dev/null' not in command and 'cat > /dev/null' not in command:
            _head_cmd = _strip_shell_quotes(command)
            _HEAD_PIPE_RE = re.compile(r'(?<!\|)\|(?!\|)\s*(?:\S*/)?head\b[^|;&\n]*$')
            for _pseg in re.split(r'&&|\|\||;|\n', _head_cmd):
                if _HEAD_PIPE_RE.search(_pseg.strip()):
                    ADVISORY = (
                        'foreground `| head` SIGPIPE-kill advisory (EI-18787618439028592): '
                        'once `head` reads its N lines and exits, the upstream command gets '
                        'SIGPIPE and is KILLED mid-run — this is a genuine kill, not just a '
                        'masked exit code (that trap is covered separately for backgrounded '
                        "pipes). The truncated output looks byte-identical to a successful "
                        "run's first N lines, so nothing in it signals the kill — easy to "
                        'wrongly conclude the run completed, especially for a side-effecting '
                        'command (writes/migrations/deploys) where that conclusion becomes a '
                        'false verification claim. `tail` is safe here (it consumes all '
                        'input); redirect to a log file and read that instead (`cmd > '
                        '/tmp/x.log 2>&1; head -N /tmp/x.log`), or protect the writer '
                        '(`cmd | { head -N; cat >/dev/null; }`) if you need the live pipe. '
                        'Advisory only; this command is proceeding as issued.'
                    )
                    break
except Exception:
    pass  # advisory must never wedge a command

# ── Background-log-read-race advisory (EI-18764990059061608) ───────────────
# A backgrounded command's redirect-to-file output is, to a LATER `cat`/`head`/
# `wc`/etc. of that same file, indistinguishable between "the job finished and
# genuinely produced nothing" and "the job is still running and has not
# flushed/finished yet" — both read as an empty (or short, stale) file. Hit
# live 2026-07-27: an agent backgrounded a typecheck piped into a log file,
# read the file moments later while it was STILL BEING WRITTEN, saw "Bash
# completed with no output", and reported "typecheck clean" — five real type
# errors landed several tool calls later when the job actually finished. This
# is the READ-side sibling of the background-pipe exit-code advisory above
# (that one warns about a masked exit code on the WRITE side).
#
# Tracking is a tiny, best-effort, host-shared JSON file: every
# `run_in_background` command that redirects (`>`/`>>`/`| tee`) to a file
# records {path -> started_at, cmd}; every subsequent command (this one
# included) that mentions a tracked path has that path checked against a live
# `/proc/*/fd` scan — if ANY process still holds it open, the job that writes
# it has not finished, so a read right now proves nothing. No writer left open
# ⇒ nothing to warn about (and the entry is dropped). Fail-open throughout:
# any parse/IO/proc error silently skips the advisory and never blocks the
# command — this is pure bookkeeping, not a safety gate.
_BG_TRACK_FILE = os.path.expanduser('~/.papercusp/bg-output-tracking.json')
_BG_TRACK_MAX_AGE_SEC = 2 * 60 * 60  # prune anything older than 2h regardless of liveness
_BG_REDIRECT_RE = re.compile(r'(?<![<>&])\d*>{1,2}(?!&)\s*([^\s;&|)\n]+)')
_BG_TEE_RE = re.compile(r'\btee\b\s+(?:-a\s+)?([^\s;&|)\n]+)')


def _bg_track_load():
    try:
        with open(_BG_TRACK_FILE) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _bg_track_save(data):
    try:
        d = os.path.dirname(_BG_TRACK_FILE)
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d)
        with os.fdopen(fd, 'w') as fh:
            json.dump(data, fh)
        os.replace(tmp, _BG_TRACK_FILE)
    except Exception:
        pass  # tracking is advisory bookkeeping — never let it raise


def _bg_resolve(raw_path, cwd):
    p = raw_path.strip().strip('\'"')
    if not p or p.startswith('$') or '$(' in p or '`' in p or p.startswith('&'):
        return None  # can't safely resolve a substitution/fd-dup target
    if p in ('/dev/null', '/dev/stdout', '/dev/stderr'):
        return None
    if p.startswith('~/'):
        p = os.path.join(os.path.expanduser('~'), p[2:])
    if not os.path.isabs(p):
        p = os.path.join(cwd, p)
    return os.path.normpath(p)


def _bg_redirect_targets(cmd, cwd):
    out = set()
    for pattern in (_BG_REDIRECT_RE, _BG_TEE_RE):
        for m in pattern.finditer(cmd):
            r = _bg_resolve(m.group(1), cwd)
            if r:
                out.add(r)
    return out


def _bg_open_writer_pids(path):
    pids = []
    try:
        for pid_dir in os.listdir('/proc'):
            if not pid_dir.isdigit():
                continue
            fd_dir = '/proc/%s/fd' % pid_dir
            try:
                fd_names = os.listdir(fd_dir)
            except Exception:
                continue
            for fd_name in fd_names:
                try:
                    target = os.readlink(os.path.join(fd_dir, fd_name))
                except Exception:
                    continue
                if target == path:
                    pids.append(pid_dir)
                    break
    except Exception:
        pass
    return pids


try:
    _bg_cwd = os.path.realpath(payload.get('cwd') or os.getcwd())
    _bg_now = time.time()
    _bg_state = _bg_track_load()

    # Record side: this call backgrounds a command that redirects to a file.
    if tool_name.lower() == 'bash' and tool_input.get('run_in_background'):
        for _t in _bg_redirect_targets(command, _bg_cwd):
            _bg_state[_t] = {'started_at': _bg_now, 'cmd': command[:200]}

    # Bound growth regardless of whether anything below fires — age-based only;
    # liveness for a survivor is re-checked fresh on the next read-side pass.
    _bg_state = {
        k: v for k, v in _bg_state.items()
        if isinstance(v, dict) and (_bg_now - float(v.get('started_at', 0))) < _BG_TRACK_MAX_AGE_SEC
    }

    # Read side: does THIS command mention a tracked path? Deliberately a
    # substring match (not just cat/head/tail) so it also catches `wc -l`,
    # `grep`, `less`, `$(cat …)`, and so on — any way of looking at the file.
    if not ADVISORY:
        _bg_write_targets_this_call = _bg_redirect_targets(command, _bg_cwd)
        for _path, _rec in list(_bg_state.items()):
            if _path not in command:
                continue
            # Don't fire on the very call that is (re-)establishing the
            # redirect to this same path — that is a write, not a read.
            if _path in _bg_write_targets_this_call:
                continue
            _writers = _bg_open_writer_pids(_path)
            if _writers:
                _elapsed = int(_bg_now - float(_rec.get('started_at', _bg_now)))
                ADVISORY = (
                    'background-log-read-race advisory (EI-18764990059061608): `%s` is '
                    'still OPEN for writing by a running background job (pid %s, started '
                    '%ss ago via `%s`) — an empty or short read right now is NOT evidence '
                    "the job finished cleanly (or at all); it may simply be mid-run and not "
                    "yet flushed. Wait for that job's own completion notification (or check "
                    '`ps -p %s`) before treating this read as a clean/green result. Advisory '
                    'only; this command is proceeding as issued.'
                    % (_path, _writers[0], _elapsed, _rec.get('cmd', '?')[:120], _writers[0])
                )
                break
            # No writer left holding it open — the job that wrote it is done
            # (or was killed); nothing left to warn about, so stop tracking it.
            _bg_state.pop(_path, None)

    _bg_track_save(_bg_state)
except Exception:
    pass  # advisory (and its bookkeeping) must never wedge a command

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


# EI-18815668439722436 / WI-6147: this guard used to gate ONLY on
# PAPERCUSP_AGENT_SESSION=='1', with no backstop — unlike the two sibling
# guards in this same file (the destructive shared-tree git guard + the heavy-
# command admission control), which were hardened after EI-7872 established
# that the marker is silently ABSENT in some fleet-launched sessions (e.g. a
# `fleet:launch-on-plan` member whose spawn path never set it), leaving the
# ENTIRE guard inert — fail-OPEN — for exactly the sessions it must protect.
#
# The sibling guards' backstop (`_cmd_in_canonical_tree()`) does NOT fit here:
# it is cwd-scoped, but crontab/at/batch/systemd-run are not tied to a working
# directory at all — an agent session can run `crontab -e` from anywhere, so a
# cwd-keyed backstop would still miss it. This guard needs its own
# correctly-scoped secondary signal instead.
#
# PAPERCUSP_FLEET_SLUG is that signal: it is stamped into a fleet member's
# process env SERVER-SIDE (bootstrap-su.ts / operator-spawn.ts), independent
# of whichever client-side code path is responsible for (and can fail to set)
# PAPERCUSP_AGENT_SESSION — so a session that ends up fleet-slugged but
# marker-less is still caught. It never fires for the owner's own plain
# interactive terminal (D-003): that session is never launched with
# `--fleet=<slug>` and so never carries a fleet slug at all. (An owner who
# DOES deliberately launch into an existing fleet with `--fleet=<slug>`
# already inherits AUTO mode by default at launch — the platform already
# treats a fleet-slugged session as an automated/coordinated context, not a
# raw personal terminal, so gating on it here is consistent, not a new
# category of over-block.)
def _is_agent_or_fleet_session():
    if os.environ.get('PAPERCUSP_AGENT_SESSION') == '1':
        return True
    return bool((os.environ.get('PAPERCUSP_FLEET_SLUG') or '').strip())


# EI-19294800751120438: scan the QUOTE-STRIPPED scannable form — quoted spans stay
# deleted (EI-9937's `grep -E "at|batch"` exemption survives intact) while the
# EXECUTED payloads of `bash -c "crontab -e"` / `$(echo crontab) -e` are appended
# as their own lines and caught.
if _is_agent_or_fleet_session() and re.search(
        r'(?:^|[;&|\n]\s*|\bsudo\s+)(?:crontab|batch|systemd-run)\b'
        r'|(?:^|[;&|\n]\s*|\bsudo\s+)at\s+(?:now|midnight|noon|teatime|\+?\d)',
        _scannable_quote_stripped()):
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
# EI-19294800751120438: iterate the SCANNABLE form, so a `bash -c "systemctl
# --user exit"` payload arrives as its own newline-separated segment here.
for _seg in re.split(r'[;&|\n]', _scannable()):
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
# EI-19294800751120438: iterate the SCANNABLE form — `bash -c "pkill -f node"`
# and `eval "killall node"` were both ALLOWED while matching raw text.
for _seg in re.split(r'[;&|\n]', _scannable()):
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

# ── process-table wait-loop self-match guard (EI-19312699396945642) ──────────
# `until ! pgrep -f '<pat>' …; do sleep …; done` can NEVER exit when run from
# an agent shell: `pgrep -f` matches the FULL command line, and the loop's own
# `bash -c` argv contains the literal pattern text, so the poll matches ITSELF
# and the condition is permanently true. Observed live 2026-08-02: a peer
# session looped 27 minutes (silently — no error, no output) "waiting" on a
# lint-tsc run that had long finished. Same self-match class as the pkill
# guard above, in wait-loop form. `ps … | grep <pat>` loop conditions share
# the defect — and there `grep -v grep` does NOT save you, because the
# `bash -c` wrapper's own cmdline still contains the pattern and is not named
# grep. UNCONDITIONAL for the same reason as the pkill guard: the hazard is
# the process-table scope of the poll, not any particular tree. Scoped to the
# loop CONDITION (the unexitable form) — a one-shot `pgrep -f` merely includes
# itself in the result and still terminates, so it stays allowed.
_PGREP_LOOP_DENY = (
    'process-table wait-loop self-match guard (EI-19312699396945642): this '
    'loop can NEVER exit — `{op}` matches the FULL command line, and your own '
    "shell's argv contains the literal pattern, so the poll matches ITSELF "
    'and the condition stays true forever (a peer burned 27 silent minutes '
    'exactly here on 2026-08-02). `grep -v grep` does not help: the `bash -c` '
    'wrapper still matches. Fixes, best first: (1) do not poll — launch the '
    'job with capability:bash {{ run_in_background: true }} and read it with '
    'capability:bash_output {{ bash_id, filter }}; (2) wait on the PID, not a '
    'pattern: `tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>` in the '
    'loop; (3) if you MUST pattern-poll, bracket the first character so the '
    "pattern cannot match its own argv: pgrep -f '[l]int-tsc' (same trick as "
    "ps aux | grep '[f]oo')."
)

def _pgrep_short_flags_have_f(flags_str):
    # Case-sensitive: -f/--full is full-cmdline match; -F is pidfile (not it).
    for _g in re.findall(r'-([A-Za-z]+)', flags_str):
        if 'f' in _g:
            return True
    return False

for _lp in re.finditer(
        r'(?:^|[;&\n])\s*(?:until|while)\s+(?:!\s*)?([^;\n]{1,300})',
        _scannable()):
    _cond = _lp.group(1)
    _pg = re.search(r'\bpgrep\s+((?:-{1,2}[\w-]+\s+)*)([^\s|>;]+)', _cond)
    if _pg and '[' not in _pg.group(2) and (
            '--full' in _pg.group(1) or _pgrep_short_flags_have_f(_pg.group(1))):
        deny(_PGREP_LOOP_DENY.format(op=('pgrep -f … in: ' + _cond.strip())[:160]))
    _psg = re.search(
        r'\bps\s[^|;\n]*\|\s*grep\s+((?:-{1,2}[\w-]+\s+)*)([^\s|>;]+)', _cond)
    if _psg and '[' not in _psg.group(2):
        deny(_PGREP_LOOP_DENY.format(op=('ps | grep … in: ' + _cond.strip())[:160]))

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


# EI-19294800751120438: subcommand detection AND the --target check both read the
# SCANNABLE form. They must use the SAME text — reading the subcommand from a
# nested payload while checking --target on the raw string would manufacture a
# false deny for a wrapped command that DID aim explicitly.
_tat_sub = _tat_subcommand(_scannable_quote_stripped())
if _tat_sub in TAT_MUTATING or _tat_sub in TAT_BRIDGE_READ:
    _stripped_cmd = _scannable_quote_stripped()
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
    #
    # EI-19294800751120438: this NAME-LIST is exactly what rotted — the 2026-07-06
    # fix added `rtk` and left `timeout` open, which measured as an ALLOW on
    # `timeout 60 git reset --hard`. The structural descent in _scannable() is now
    # the real defense (it parses the argv rather than matching wrapper names);
    # the list is kept as a cheap belt-and-braces for the base segment.
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

    for _seg in re.split(r'[;&|\n]', _scannable()):
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


# EI-18760311552821358: a `NAME:PATH` target is a REMOTE/CONTAINER destination
# (`docker cp local.sh container:/tmp/c.sh`, `scp`/`rsync` `host:/path` — the
# `\bcp\b` scan above matches the `cp` inside `docker cp` too, so this leg
# needs to recognize it), not a host path at all. Treating the bit after the
# colon as a path and joining it against cwd resolves it INSIDE the tree
# whenever cwd happens to be in the tree — a false positive, since the write
# actually lands inside the container's filesystem and can never touch the
# host tree at that argument position. Same "unsafe/not-a-local-path, fail
# open" precedent as the `$`/backtick/`~`/glob checks below: a real local
# filename containing a colon (rare, but legal on Linux) is a false negative
# this trades away deliberately, same tradeoff already made for those.
_CONTAINER_REF_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]*:')


def _resolve_write_target(raw_target, cwd):
    if not raw_target or any(ch in raw_target for ch in ('$', '`', '~', '*', '?', '[')):
        return None
    if raw_target.startswith('/dev/') or raw_target in ('&1', '&2'):
        return None
    if _CONTAINER_REF_RE.match(raw_target):
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


# EI-18809538554039853: short flags BUNDLE, so the in-place flag is frequently not
# the first character of its token — `perl -0pi -e ...` is `-0` `-p` `-i`, and is the
# idiomatic slurp-mode in-place rewrite, i.e. exactly the multi-line edit reached for
# INSTEAD of Edit. The earlier `(?:^|\s)-i\S*` test required the token to BEGIN with
# `-i` and so missed every bundled spelling, silently letting those writes past the
# file-lock hook on a tree the whole fleet shares.
#
# Scanning for a bare `i` anywhere in the token is NOT correct either: it would deny
# `-Mstrict`, `-Ilib/inc`, `-Fpattern` — common, and none of them in-place. Short
# flags that take a VALUE consume the remainder of their token, so the scan stops at
# the first of those; anything after it is a value, not a flag.
_VALUE_CONSUMING_FLAGS = {
    'perl': set('eEMmIFxCD'),
    'ruby': set('eEIrKCFSx'),
    'sed': set('efl'),
}


def _has_inplace_flag(seg, kind):
    """True when any token in `seg` carries an in-place flag, bundled or not."""
    _consuming = _VALUE_CONSUMING_FLAGS.get(kind, set())
    for _tok in seg.split():
        # Long form (`sed --in-place`, `--in-place=.bak`).
        if _tok == '--in-place' or _tok.startswith('--in-place='):
            return True
        # Only short-flag clusters bundle; `--foo` and a bare `-` never do.
        if _tok.startswith('--') or not _tok.startswith('-') or _tok == '-':
            continue
        for _ch in _tok[1:]:
            if _ch == 'i':
                return True
            if _ch in _consuming:
                break  # the rest of this token is that flag's value, not more flags
    return False


# EI-18763270524857214: a `cd <dir>` earlier in the SAME compound command
# changes the cwd every later relative target actually resolves against — the
# guard was resolving every target against the session's STARTING cwd
# regardless, so `cd /tmp/probe && ... > relative.md` (the sanctioned
# out-of-tree scratch-work idiom) got told its target "resolves INSIDE the
# shared staging tree" as flat fact, when it plainly did not: the preceding
# `cd` moved cwd out of the tree first. Filed by an agent doing the CAREFUL
# thing (building a probe in /tmp specifically to avoid dirtying the tree) —
# a false reading stated as established fact sends the reader hunting a
# cwd-drift bug that never happened.
#
# Best-effort replay, not a real shell: walk every `cd <target>` occurring
# BEFORE a given position and fold it into a running cwd, same literal-path
# safety net as `_resolve_write_target` (an unresolvable target — expansion,
# unreadable — makes everything from there on UNKNOWN, at which point this
# bails to the ORIGINAL session cwd rather than guess, so it can only ever
# make the guard MORE accurate, never quietly disable it).
#
# Deliberately inert whenever the command contains ANY paren: a `cd` inside a
# `(subshell)` does not leak its cwd change past the closing `)`, and this
# replay has no paren-depth tracking to know that — folding a subshell-scoped
# `cd` into the outer cwd could turn a genuine in-tree write into a false
# ALLOW, which is a strictly worse failure than the stale-cwd false DENY this
# is fixing. `$(...)` command substitution shares the same `(`/`)` characters,
# so this also — harmlessly — sits out whenever one of those appears anywhere
# in the command; the guard just falls back to its original (correct, if
# occasionally over-cautious) behavior in that case.
#
# `cd` only counts as a REAL invocation when it starts a statement — preceded
# by nothing, a `;`, a newline, `&&`, or `||`. Without this a bare mention of
# the word (`echo cd /tmp`, `echo "please cd to /tmp first"`) would read as an
# actual directory change and could fold a FAKE cwd move into the replay —
# the same "worse than the false deny" shape as the subshell case above, just
# via ordinary text instead of a paren.
_CD_RE = re.compile(r'(?:\A|[;\n]|&&|\|\|)\s*cd\s+(\S+)')


def _effective_cwd_before(pos, base_cwd, clean, has_paren):
    if has_paren:
        return base_cwd
    _cwd = base_cwd
    for _m in _CD_RE.finditer(clean[:pos]):
        _target = _m.group(1)
        # A QUOTED cd argument containing a space (`cd "/tmp/some dir"`) was
        # already collapsed to a single space by quote-stripping upstream, so
        # `\S+` here can land on leftover operator debris instead (`&&`, `;`)
        # rather than the real target — bail rather than fold operator text
        # into the replayed cwd as if it were a directory.
        if not _target or re.fullmatch(r'[&|;<>]+', _target) or any(
            ch in _target for ch in ('$', '`', '~', '*', '?', '[')
        ):
            return base_cwd  # can't tell where cwd ended up — don't guess
        try:
            _cwd = _target if os.path.isabs(_target) else os.path.realpath(os.path.join(_cwd, _target))
        except Exception:
            return base_cwd
    return _cwd


def _shell_write_guard():
    _canon = _canonical_tree_root()
    if not _canon:
        return
    try:
        _cwd = os.path.realpath(payload.get('cwd') or os.getcwd())
    except Exception:
        return
    _clean = _strip_shell_quotes(_strip_heredoc_bodies(command))
    _has_paren = '(' in _clean or ')' in _clean
    _targets = []  # (raw_target, human-readable construct name, position in _clean)

    # `>`/`>>` redirects. The lookahead excludes fd-duplication/comparison
    # forms (`2>&1`, `>=`, `2>&2`) so those never get misread as file targets.
    #
    # EI-18899608047558048: the gap between the operator and its target is
    # `[^\S\n]*` (same-LINE whitespace only), NOT `\s*`. `_strip_shell_quotes`
    # replaces an ENTIRE quoted span — `"$OUT"`, `'literal.txt'` — with a
    # single blank space, with no marker left behind that anything was ever
    # there. So a redirect whose target was fully quoted (`: > "$OUT"`, `printf
    # ... >> "$OUT"`) leaves nothing but trailing whitespace after the
    # operator on that line — and a bare `\s*` happily crosses the following
    # newline to grab the FIRST TOKEN OF THE NEXT STATEMENT as if it were the
    # redirect's target (`URL=` from an unrelated following assignment, or
    # `done` closing a loop body). That is worse than a false negative: it
    # names a plausible-looking but WRONG path with the same confident wording
    # used for a real catch, sending the reader hunting a cwd-drift bug that
    # never happened. Restricting the gap to same-line whitespace makes the
    # match fail to find a target at all in that case — the correct fail-open,
    # matching this guard's existing "unsafe to resolve without actually
    # running the shell" policy for any other unresolvable target.
    for _m in re.finditer(r'\d*(>{1,2})(?![&=])[^\S\n]*([^\s;&|()<>]+)', _clean):
        if not _looks_like_redirect_path(_m.group(2)):
            continue
        _targets.append((_m.group(2), 'shell redirect (`%s`)' % _m.group(1), _m.start(2)))

    # `tee [-a] FILE...`
    for _m in re.finditer(r'\btee\b([^;&|\n]*)', _clean):
        if _segment_has_unsplittable_expansion(_m.group(1)):
            continue
        for _tok in _strip_redirect_tokens(_m.group(1).split()):
            if not _tok.startswith('-'):
                _targets.append((_tok, '`tee`', _m.start()))

    # `sed -i[.bak] ... FILE...` / `sed --in-place ... FILE...` — quote-
    # stripping already erased a quoted script, so treat every remaining
    # non-flag token as a target candidate (harmless if one is actually the
    # unquoted script text: a real target among them still triggers the deny).
    for _m in re.finditer(r'\bsed\b([^;&|\n]*)', _clean):
        _seg = _m.group(1)
        if not _has_inplace_flag(_seg, 'sed'):
            continue
        if _segment_has_unsplittable_expansion(_seg):
            continue
        for _tok in _strip_redirect_tokens(_seg.split()):
            if not _tok.startswith('-'):
                _targets.append((_tok, '`sed -i`', _m.start()))

    # `perl -i[.bak] FILE...` / `ruby -i[.bak] FILE...` — the same in-place
    # side door as `sed -i` above, just a different interpreter
    # (EI-18691482279179647: "the shell-write guard misses interpreter
    # writes" — this leg is the in-place-flag half of that fix; the other
    # half, an interpreter's OWN open()/writeFileSync() call inside inline
    # code, is a different shape and handled by _interpreter_write_guard
    # below since there is no shell-level flag to key on there).
    # `awk -i inplace ... FILE...` (EI-18809538554039853). gawk's in-place edit is
    # NOT a bundled flag like the others — `-i` is the generic "include a library"
    # option and the rewrite only happens for the `inplace` library specifically, so
    # this keys on that library NAME rather than on the flag. Keying on a bare `-i`
    # here would deny every unrelated `awk -i <lib>`. Also accepts the long spelling
    # (`--include inplace`) and the attached forms (`-iinplace`, `--include=inplace`).
    for _m in re.finditer(r'\b(?:g?awk)\b([^;&|\n]*)', _clean):
        _seg = _m.group(1)
        if not re.search(r'(?:^|\s)(?:-i\s*|--include(?:=|\s+))inplace\b', _seg):
            continue
        if _segment_has_unsplittable_expansion(_seg):
            continue
        for _tok in _strip_redirect_tokens(_seg.split()):
            # `inplace` is the library operand, not a target.
            if not _tok.startswith('-') and _tok != 'inplace':
                _targets.append((_tok, '`awk -i inplace`', _m.start()))

    for _m in re.finditer(r'\b(perl|ruby)\b([^;&|\n]*)', _clean):
        _seg = _m.group(2)
        if not _has_inplace_flag(_seg, _m.group(1)):
            continue
        if _segment_has_unsplittable_expansion(_seg):
            continue
        for _tok in _strip_redirect_tokens(_seg.split()):
            if not _tok.startswith('-'):
                _targets.append((_tok, '`perl -i`/`ruby -i`', _m.start()))

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
            _targets.append((_pos[-1], '`cp`', _m.start()))

    for _raw, _construct, _at in _targets:
        _effective_cwd = _effective_cwd_before(_at, _cwd, _clean, _has_paren)
        _resolved = _resolve_write_target(_raw, _effective_cwd)
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
                '(~/.papercusp/scratch or /tmp). NOTHING in this Bash call ran — the whole '
                'command was rejected before execution (EI-18760311552821358), including '
                'any earlier statement in a `&&`/`;`-chained compound command (e.g. a '
                'leading heredoc write) — re-issue the whole command after fixing the '
                'target, do not assume an earlier part of it already ran.'
                % (_construct, _raw)
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
# path substring appears as an ARGUMENT TO a recognized write-shaped/file-
# construct call (a `-c`/`-e` quoted argument, or a heredoc body that follows
# an interpreter invocation) — see EI-18814109122347052 below for why it is
# scoped to call arguments rather than the whole payload — AND that same
# payload contains a recognizable WRITE-shaped call. HONEST LIMIT (permanent,
# not a bug to fix later): an interpreter can always construct a path at
# runtime (string concatenation, an env var, a computed join), and a write
# call this heuristic doesn't recognize slips through too — no static scan of
# the command text can see either. The guard's value is catching the
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

# EI-18828567391761902 — FIFTH in the not-a-path-resolved-as-one family, and
# the narrowing the family's own through-line calls for: "every widening of
# what counts as a 'path' must be paid for by a matching narrowing of what
# counts as a candidate." The predecessor narrowed candidates to whitespace-
# separated TOKENS, which left the token test itself as bare `[./]` — so any
# prose word carrying a period still qualified.
#
# It did. A mutation-control script searching for a docstring sentence held the
# literal 'newly refuse an independent sibling."""'; the token `sibling."""`
# contains a `.`, does not start with `/`, and so was joined onto an in-tree cwd
# as `<canon>/sibling."""` — "inside the tree". The command's only write sink was
# `open(dst,'w')` with dst=/tmp/..., so the write-indicator test was satisfied
# LEGITIMATELY and could not save it: the whole error was in path detection.
# The cost is not just the refusal. It blocks the out-of-tree mutation-testing
# workflow this repo's guidance prescribes for exactly this kind of guard, and
# the fallback (a `sed` one-liner) silently produced a NO-OP mutant, so a fix
# was nearly reported as inert. A false positive here degrades verification.
#
# Two token narrowings, each verified against the only tree this gates:
#  (a) NO QUOTE CHARACTER. `git ls-files | grep -c '["'\'']'` -> 0. This also
#      covers the `/` branch, where prose can otherwise smuggle a hit: the
#      literal 'see "apps/operator" for details' yields the token
#      `"apps/operator"`, which contains a `/` and resolves in-tree.
#  (b) PATH SHAPE: contains `/`, OR its FINAL `.` is followed by a non-empty run
#      of filename-safe characters and nothing else. `sibling."""` fails (`"""`),
#      as do `sibling.`, `e.g.`, `etc.` — a trailing/prose period is not an
#      extension. Filename-safe is deliberately `[A-Za-z0-9_-]` rather than
#      alnum: an alnum-only rule would have dropped 5 real tracked paths
#      (.bash_profile, .gitnexusignore, .mcp.json.su-parked, and two dated
#      .mcp.json backups) — the only tracked dotted paths with no `/` to fall
#      back on. Measured, not assumed: of 3615 tracked paths whose final segment
#      is not an alnum extension, exactly those 5 lack a slash.
#
# RESIDUAL, accepted: a missing space after a period (`sentence.The`) and a
# quoted decimal ('1.5') are still path-shaped by this test. Both are rarer than
# what (b) removes, and the guard is coarse by design — see its honest-limit note.
_PATH_CANDIDATE_RE = re.compile(r'/|\.[A-Za-z0-9_-]+$')


def _looks_like_path_candidate(cand):
    if '"' in cand or "'" in cand:
        return False
    return bool(_PATH_CANDIDATE_RE.search(cand))


# EI-18814109122347052 — SIXTH in the not-a-path-resolved-as-one family, and
# the first to be fixed by narrowing WHERE the scan looks rather than what a
# candidate token is allowed to look like. Every predecessor (paired quotes,
# whitespace tokenizing, quote-char + path-shape exclusion) still scanned
# every quoted literal in the WHOLE inline-code body, regardless of what call
# (if any) it was an argument to. A print() label is a literal like any
# other: `print("postings/comments pulled:", len(texts), ...)` contains a
# `/`, carries no quote character inside it, and so cleared every prior
# filter — even though the body's only write target was a wholly unrelated
# `open('/tmp/hiring-blob.txt', 'w')` a line away.
#
# The fix: only scan literals that are ARGUMENTS TO a write-shaped/file-
# construct call (open(...), Path(...), write_text(...)/write_bytes(...),
# writeFileSync(...), etc. — the same call forms _WRITE_INDICATOR_RE /
# _FILE_OBJECT_RE already recognize as file-I/O shaped). A literal sitting
# anywhere else in the body — a print() label, a docstring, an error
# message, a bare variable assignment — is no longer a candidate at all, so
# it needs no path-shape/quote-char test to be excluded. This is still LITERAL
# PATHS ONLY (balanced-paren matching from a call site's `(`, not a real
# parse of the interpreted language) — same discipline as the rest of this
# guard, just scoped to the argument list instead of the whole payload.
_WRITE_CALL_SITE_RE = re.compile(
    r'\bopen\s*\('
    r'|\bwrite_(?:text|bytes)\s*\('
    r'|\.save\s*\('
    r'|(?:pickle|json|yaml)\.dump\s*\('
    r'|shutil\.(?:copy|move)\s*\('
    r'|os\.(?:rename|remove|replace)\s*\('
    r'|unlink\s*\('
    r'|Path\s*\('
    r'|fdopen\s*\('
    r'|NamedTemporaryFile\s*\('
    r'|writeFileSync\s*\('
    r'|appendFileSync\s*\('
    r'|createWriteStream\s*\('
)


def _write_call_arg_spans(body):
    # The parenthesized argument list of each recognized write/file-construct
    # call, found by balanced-paren matching from the call site's `(` —
    # rather than a regex capture, since arguments can themselves contain
    # nested parens (`open(os.path.join(a, b), 'w')`). Skips a call whose
    # parens never balance (truncated body, unterminated construct) — there
    # is nothing safe to scan past a call site like that.
    spans = []
    for _m in _WRITE_CALL_SITE_RE.finditer(body):
        _start = _m.end() - 1  # index of the call's opening '('
        _depth = 0
        _i = _start
        _n = len(body)
        while _i < _n:
            _ch = body[_i]
            if _ch == '(':
                _depth += 1
            elif _ch == ')':
                _depth -= 1
                if _depth == 0:
                    spans.append(body[_start:_i + 1])
                    break
            _i += 1
    return spans


# EI-18828866497684686 — is the write call's PATH argument (its first,
# top-level comma-separated argument) a plain literal at all, or a bare
# expression (a variable, `os.path.join(...)`, string concatenation, an
# f-string with no literal segment, …)? Deliberately NOT "does a literal
# resolve in-tree" (`_payload_literal_tree_path` already answers that, and a
# literal that resolves OUTSIDE the tree — e.g. `open('/tmp/x.log','w')` — is
# common and safe, so it must not trip this). This only asks "is there
# anything here for a literal-only scan to even look at" — no quote character
# before the first TOP-LEVEL comma (respecting nested parens/brackets/braces,
# so `open(os.path.join(a, b), 'w')`'s inner comma does not end the first
# argument early) means the path was constructed at runtime and is invisible
# to every literal-matching check in this guard, by the file's own documented
# "honest limit".
def _first_call_arg_has_no_literal(span):
    if not span or span[0] != '(':
        return False
    depth = 0
    in_quote = None
    first_arg_end = None
    i, n = 0, len(span)
    while i < n:
        ch = span[i]
        if in_quote:
            if ch == '\\' and i + 1 < n:
                i += 2
                continue
            if ch == in_quote:
                in_quote = None
            i += 1
            continue
        if ch in '\'"':
            in_quote = ch
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
            if depth == 0:
                first_arg_end = i
                break
        elif ch == ',' and depth == 1:
            first_arg_end = i
            break
        i += 1
    if first_arg_end is None:
        return False  # unbalanced — nothing safe to conclude
    first_arg = span[1:first_arg_end]
    return not any(c in first_arg for c in ('\'', '"'))


def _has_computed_write_path(body):
    return any(_first_call_arg_has_no_literal(_span) for _span in _write_call_arg_spans(body))


def _payload_literal_tree_path(body, canon, cwd):
    # Every quoted token inside a write-call argument span (see
    # _write_call_arg_spans above — EI-18814109122347052) that looks
    # path-like (contains `/` or a dotted extension) and carries no
    # shell/interpreter expansion syntax ($, `, {, }) — resolved the same
    # literal-only way as _resolve_write_target.
    for _span in _write_call_arg_spans(body):
        for _m in _QUOTED_LITERAL_RE.finditer(_span):
            raw = _m.group(1) if _m.group(1) is not None else _m.group(2)
            if any(ch in raw for ch in ('$', '`', '{', '}')):
                continue
            # EI-18800669297694465: test each WHITESPACE-SEPARATED TOKEN of
            # the literal, never the literal as a whole.
            #
            # A path candidate cannot contain whitespace — not as a general
            # truth about filesystems, but as a true one about the only
            # targets this guard gates: no tracked path in this repo has a
            # space (`git ls-files | grep -c ' '` -> 0), and `canon` is that
            # repo. So tokenizing cannot lose an in-tree hit, while testing
            # the whole literal actively manufactures false ones.
            #
            # It did. `open("wrote /tmp/x.mts", 'w')` is ONE literal
            # containing a `/` and a `.`, so it passed both filters; it does
            # not START with `/`, so it was treated as RELATIVE and joined
            # onto the cwd, yielding `<canon>/wrote /tmp/x.mts` — "inside the
            # tree". Returning the token fixes the message half too: the
            # agent is shown a path, not prose.
            #
            # Fourth in this family (EI-18683619680591304, -18692070370140239,
            # -18700825865251498): each was something that is not a path
            # being resolved as one. The through-line is that this scan is
            # deliberately coarse, so every widening of what counts as a
            # "path" must be paid for by a matching narrowing of what counts
            # as a candidate.
            for cand in raw.split():
                if not _looks_like_path_candidate(cand):
                    continue
                resolved = _resolve_write_target(cand, cwd)
                if resolved and (resolved == canon or resolved.startswith(canon + os.sep)):
                    return cand
    return None


def _interpreter_write_guard():
    global ADVISORY
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
    # EI-18828866497684686: a write whose PATH ARGUMENT is COMPUTED (joined
    # from a parsed log, a loop variable, an env var, string concatenation —
    # anything that is not a plain quoted literal) is structurally invisible
    # to `_payload_literal_tree_path`, same "honest limit" this guard's own
    # header comment already documents as permanent (no static scan of the
    # command text can see a runtime-constructed path). Silently allowing it
    # is the correct call — deny-by-default here would ALSO flag the
    # overwhelmingly common, SAFE case of a script writing an out-of-tree
    # scratch/log file via a LITERAL path (e.g. `open('/tmp/x.log','w')`),
    # reopening exactly the false-positive class this file has already paid
    # for six times over (see the family of EI-* comments above) — so the
    # advisory below fires ONLY when the path argument has NO literal at all
    # (`_has_computed_write_path`), never merely "no in-tree literal found".
    # A silent pass on a genuinely computed path still reads as an
    # endorsement an agent cannot tell apart from "checked, nothing wrong" —
    # so say so, once per session, non-blocking: the guard only sees literal
    # paths; a computed one inside the tree still bypasses locking and this
    # guard cannot catch it.
    _saw_computed_write = False
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
        elif _has_computed_write_path(_body):
            _saw_computed_write = True
    if _saw_computed_write and not ADVISORY:
        ADVISORY = (
            'shell-write guard notice (EI-18828866497684686): this `%s` invocation writes a '
            'file (open()/write_text()/writeFileSync()/etc.) but no LITERAL in-tree path was '
            'found among its write-call arguments. This guard only recognizes a plain quoted '
            'path string — it cannot see a COMPUTED path (joined from a parsed log, a loop '
            'variable, an env var, string concatenation, …). If the write actually lands '
            'inside the shared staging tree, no lock is being claimed and this guard cannot '
            'catch that. If you are rewriting tracked file(s) by a computed path, prefer '
            'Edit/Write per file (they claim the lock for you), or claim it yourself first: '
            'locks:acquire { paths, intent }. Advisory only; this command is proceeding as '
            'issued.' % _interp
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
# 1.0x cores (was 1.5x; EI-19296434833105508 — the herd forms BELOW 1.5x and
# operator liveness degrades from ~1.3x, and a denied caller's remedy queues
# politely rather than failing, so a lower bar costs nothing but a nice queue);
# kill-switch PC_HEAVY_ADMISSION=off; skipped when PC_HEAVY_BYPASS=1 (pc-heavy
# sets it) or the caller is not an agent/shared-tree session (owner exempt);
# every error path allows. PC_HEAVY_LOAD1_OVERRIDE lets tests inject a load.
# ══ BENIGN LEADING WRAPPERS — ONE definition, two consumers ══
#
# A "benign wrapper" is a token sequence that runs NO command of its own: it
# adjusts the environment / priority / time limit and then execs whatever
# follows. TWO places below need exactly this set, and they must agree:
#
#   1. the PEEL loop in _heavy_admission — strips them off the FRONT so the
#      start-anchored bypass checks (pc-heavy.sh, the root npm entrypoints) can
#      see the real command word hiding behind them;
#   2. the heavy-detection ANCHOR — recognizes command POSITION mid-string, so
#      `echo hi && timeout 60 npx vitest` is still read as a heavy at position.
#
# EI-19317242751258158: this concept was written TWICE and the copies had
# DIVERGED. The peel knew `timeout`; the anchor did not. NEITHER knew a bare
# `VAR=val` assignment prefix — only the `env VAR=val` spelling. Both halves of
# that divergence were measured live on 2026-08-02, and they fail in OPPOSITE
# and equally bad directions:
#
#   • BYPASS (the anchor's gap) — `FOO=1 npx tsc`, `PC_HEAVY_COALESCE=0 npx
#     vitest` and `echo hi && timeout 60 npx vitest` escaped heavy admission
#     ENTIRELY, i.e. the exact herd this gate exists to stop, with a two-token
#     prefix in front of it.
#   • FRICTION (the peel's gap) — `PC_HEAVY_COALESCE=0 scripts/pc-heavy.sh --
#     node_modules/.bin/vitest` was DENIED, with a message instructing the
#     caller to run it under scripts/pc-heavy.sh, which is what it WAS doing.
#     That is the EI-9634 / EI-10001 / WI-4547 "the guard blocks its own
#     prescribed remedy" trap for the fourth time — each previous fix added the
#     one missing wrapper to ONE of the two lists, which is precisely how they
#     drifted apart.
#
# So: keep this ONE definition. Adding a wrapper to only one consumer is how
# this bug is reintroduced, and the divergence is invisible until someone
# probes the exact right command shape.
# NAMED wrappers: each begins with a literal command word, so recognizing one
# mid-string costs essentially no false positives (prose rarely contains
# "sudo <heavy>").
_NAMED_WRAPPER_ALTS = (
    r'sudo(?:\s+(?:-[ugpUrCht]\s+\S+|-[A-Za-z]+|--[\w-]+(?:=\S*)?))*\s+',
    r'env(?:\s+[A-Za-z_]\w*=\S*)*\s+',
    r'nice(?:\s+-n\s*-?\d+)?\s+',
    r'ionice(?:\s+-\w+(?:\s+\d+)?)*\s+',
    r'rtk\s+',
    r'time\s+',
    r'timeout(?:\s+(?:-[a-zA-Z]\S*|--[\w-]+(?:=\S*)?))*\s+-?\d+\S*\s+',
)
# A bare `VAR=val ` prefix — the `env VAR=val` spelling minus the `env`. The
# shell parses a leading WORD=VALUE as an assignment, never as a command word,
# so peeling it can no more hide a command than peeling `env` can.
#
# It is kept SEPARATE from the named set because it is far more general: `\w+=`
# matches ordinary prose, so at an arbitrary mid-string offset it false-denies
# `echo "PC_HEAVY=1 vitest is the way"` (measured — this exact string denied
# during development of this fix). It is therefore honoured only at a REAL
# command position (start / just after a separator), never as a free-floating
# mid-string anchor the way the named words are.
_ASSIGN_PREFIX = r'[A-Za-z_]\w*=\S*\s+'
_BENIGN_WRAPPERS = '(?:' + '|'.join(_NAMED_WRAPPER_ALTS + (_ASSIGN_PREFIX,)) + ')'
_NAMED_WRAPPERS = '(?:' + '|'.join(_NAMED_WRAPPER_ALTS) + ')'


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
            # cd <dir> && / ; / NEWLINE. The newline arm matters as much as the
            # other two (EI-19300297240416558): a `cd` on its own line is one of
            # the most common shapes an agent writes, and without it the peel
            # stops at `cd`, the (a)/(a2) skip-checks below never match (both are
            # start-anchored), and the command falls through to heavy-detection —
            # which IS newline-anchored. That asymmetry denied the blessed
            # `npm run test:file` under exactly the load it exists to queue for.
            # Written `[ \t]*(?:&&|;|\n)` rather than `\s*(?:&&|;|\n)` so the
            # separator match cannot depend on backtracking a greedy `\s*` that
            # already swallowed the newline.
            r'cd\s+([\'"]?)[^&|;<>\s\'"]+\1[ \t]*(?:&&|;|\n)\s*'
            # `set -o pipefail && …` / `set -euo pipefail; …`. A `set` builtin only
            # flips shell options — it runs NO command — so peeling it can't hide a
            # heavy command, and NOT peeling it made this gate deny the very remedy its
            # own error message prescribes: `cd d && set -o pipefail && scripts/
            # pc-heavy.sh -- vitest` stopped peeling at `set`, missed the pc-heavy lead,
            # and got denied as a raw `vitest`. Same "the remedy doesn't work" trap
            # EI-9634 fixed for `cd`/subshell — and it punished exactly the right habit,
            # since pipefail is what stops `… | tail` from masking a real exit code.
            r'|set\s+(?:-o\s+[\w-]+|\+o\s+[\w-]+|[-+][A-Za-z]+)(?:\s+(?:-o\s+[\w-]+|\+o\s+[\w-]+|[-+][A-Za-z]+))*[ \t]*(?:&&|;|\n)\s*'
            r'|\(\s*'  # one subshell open: ( scripts/pc-heavy.sh … ) &
            # The shared benign-wrapper set (sudo/env/nice/ionice/rtk/time/
            # timeout/bare-assignment). Defined ONCE above so the peel and the
            # heavy-detection anchor below can never drift apart again.
            r'|' + _BENIGN_WRAPPERS +
            r')',
            '', _pc_lead, count=1)
        if _next == _pc_lead:
            break
        _pc_lead = _next
    if re.match(r'(?:bash\s+|sh\s+)?(?:\S*/)?pc-heavy\.sh(?:\s|$)', _pc_lead):
        return
    #   (a2) ROOT npm entrypoints that are ALREADY wrapped in scripts/pc-heavy.sh
    #       inside package.json (EI-19296434833105508): denying them would re-open
    #       the EI-10001 "the remedy doesn't work" trap — the agent runs the
    #       blessed self-throttling command and is denied before npm can spawn
    #       the wrapper, under exactly the load the wrapper exists to queue for.
    #       Exact script names only (these exist ONLY at the repo root); bare
    #       `npm test` / `npm run test` stay gated because a WORKSPACE cwd
    #       resolves those to its own raw vitest, not the wrapper.
    if re.match(
        r'npm\s+run\s+(?:test:affected(?::integration)?|test:all(?::integration)?'
        r'|test:file|lint:tsc(?::operator-vite)?|typecheck)(?=\s|$)',
        _pc_lead):
        return
    #   (b) a leading `PC_HEAVY_BYPASS=1` env-assignment prefix (bare, behind
    #       other assignments, or behind `env`) — mirrors the message's own
    #       `PC_HEAVY_BYPASS=1 <cmd>` remedy and the `env`-prefixed heavy form
    #       the anchor already recognizes. Same `cd <dir> &&` allowance as (a).
    _bypass_lead = re.sub(
        r'^cd\s+([\'"]?)[^&|;<>\s\'"]+\1[ \t]*(?:&&|;|\n)\s*', '', _lead, count=1)
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
    # The wrapper arms are built from the SHARED sets defined above rather than
    # from a second hand-maintained copy — that copy is exactly what had drifted
    # (EI-19317242751258158: the peel knew `timeout`, this anchor did not).
    # `{0,4}`/`{1,4}` mirror the peel's bounded loop so STACKED wrappers
    # (`… && nice -n 10 timeout 60 npx vitest`) are recognized at command
    # position too; `\b` keeps `nice` from matching inside `ionice`.
    anchor = (
        r'(?:'
        # A real command position — start of string, or just after a separator —
        # optionally behind stacked benign wrappers. This is the arm that admits
        # the bare-assignment prefix (`FOO=1 npx tsc`, `… && FOO=1 npx vitest`).
        r'(?:^|[;&|\n]\s*)(?:' + _BENIGN_WRAPPERS + r'){0,4}'
        # A NAMED wrapper anywhere, as before this fix. Kept as its own arm so
        # no coverage is lost relative to the previous anchor; the assignment
        # prefix is deliberately absent here (see _ASSIGN_PREFIX above).
        r'|(?:\b' + _NAMED_WRAPPERS + r'){1,4}'
        # A path-invoked executable: ../../node_modules/.bin/vitest
        r'|\S*/'
        r')'
    )
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
        # 1.0x cores, down from 1.5x (EI-19296434833105508, measured 2026-08-01):
        # under the old 192 threshold a 52-vitest + 35-tsc herd formed at load
        # ~111 and drove load1 to 216 — and the operator's heartbeat starts
        # failing from ~171 (EI-19294517824914302), so "healthy 1.0-1.3x" was
        # not in fact harmless. A denied caller loses nothing: the remedy
        # (pc-heavy / the wrapped root npm entrypoints, allowed above) QUEUES
        # for a slot instead of failing.
        max_load1 = float(_mx) if _mx not in (None, '') else round(1.0 * cores)
    except Exception:
        return  # can't read load/cores → fail-open
    if load1 > max_load1:
        deny(
            f'heavy-command admission (WI-3821): host load1={load1:.0f} is over the '
            f'{max_load1:.0f} threshold (~1x cores) — starting another bare vitest/tsc/'
            f'test build now piles onto a box whose operator liveness degrades past '
            f'~1.3x (this class melted the host to load 3000+ and triggered MCP-dark '
            f'cascades). Run it under `scripts/pc-heavy.sh -- <your command>` (waits '
            f'for a free build slot, runs niced), or use the self-throttling root '
            f'entrypoints (`npm run test:affected` / `test:file` / `lint:tsc`), which '
            f'pass this gate and queue politely. Kill-switch (prepend inline): '
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
    'grep',
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

# How to call a tool that is not in the caller's loaded set (EI-18810711449496523).
# On a trimmed launch most advised tools are absent from the session surface
# entirely — 8 of the 10 the registry names, measured live — so an agent reads
# the row, spends a ToolSearch discovering the dead end, and falls back to bash.
# A PreToolUse payload never carries the tool surface, so this cannot be fixed by
# suppressing the row; it is fixed by naming the convention that always works.
#
# Kept BYTE-IDENTICAL to TOOLS_INVOKE_FALLBACK_HINT in the OMP hook
# (scripts/hooks/omp/coord-hook.ts) — the two hooks are asserted to teach the
# same thing, and coord-hook.test.ts pins this exact wording.
_INVOKE_HINT = (
    'Not in your loaded tool set? `tools:invoke { name, args }` dispatches any '
    'catalog tool server-side — a ToolSearch miss is not a dead end.'
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
                'or because the prohibition already existed independently.)\n\n%s'
                % (_body, _INVOKE_HINT)
            )
        elif not ADVISORY:
            # SOFT: rides out as additionalContext on an explicit allow. The
            # command proceeds exactly as issued — this only teaches the routing.
            ADVISORY = (
                'bash→tool advisory: a tool already answers this question '
                'directly.\n\n%s\n\nThe tool call is cheaper (no shell round-trip, '
                'structured result) and is what the routing table points at. '
                'Advisory only; this command is proceeding as issued.\n%s'
                % (_body, _INVOKE_HINT)
            )
except Exception:
    pass  # advisory must never wedge a command

allow()
PYEOF
