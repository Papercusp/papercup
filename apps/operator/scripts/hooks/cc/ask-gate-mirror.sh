#!/usr/bin/env bash
# Claude hook — the owner-gate CAPTURE + MIRROR layer (P-001 of
# owner-inbox-single-pane-2026-07-17). One script, FOUR hook_event_name
# branches (same combined-script shape as workitem-verify-nudge.sh), each
# registered as its own settings.json entry:
#
#   • PreToolUse  (matcher "AskUserQuestion|ExitPlanMode") — the dialog is
#     about to open: mirror question+options into the client-agnostic
#     blocked-session tracker (sessions:ingest-gate-event, P-002) so the
#     Inbox sees "this session is waiting on you" the moment the tool
#     dispatches, tagged with the asking session + owner. refId = the
#     native tool_use_id, so PostToolUse can close the SAME row.
#   • PostToolUse (same matcher) — the dialog closed (Claude only reaches
#     PostToolUse once it has a tool_result): auto-resolve the mirror
#     (kind:'cleared', same refId). Content of the answer is irrelevant here
#     — P-006 already wires the reply-routing side for answers that came
#     FROM the inbox; this is just closing the "still waiting" signal.
#   • Notification — Claude's generic notification channel. When the
#     message names a PERMISSION wait ("Claude needs your permission…"),
#     open a 'permission_wait' gate keyed on a fixed per-session refId
#     (`notify:<session_id>`) — idempotent-touch on repeats. Every OTHER
#     notification shape is ignored here (P-002's transcript watcher is the
#     general-purpose "no tool_result yet" detector; this is a fast-path
#     nicety for the one Claude-specific shape a watcher can't see faster).
#   • Stop — the ask-mirror + BOUNCE. First, best-effort-clear the
#     `notify:<session_id>` gate opened above (a turn ending means any
#     mid-turn permission wait is moot by construction). Then read the
#     turn's OWN final assistant text out of the transcript and:
#       1. an `<ask>{...}</ask>` tag (the @papercusp/chat-protocol P-003
#          AskBlock wire shape, parsed here with a python port of the same
#          validation contract — question required, options/refs optional,
#          malformed → ignored) → mirror it to `coord:escalate` (D-001's
#          preferred ask surface: a real card, answerable from the inbox)
#          and ALLOW the stop.
#       2. no `<ask>` tag, but the ending is QUESTION-SHAPED (last non-blank
#          line, ≤300 chars, ends in "?", not a code fence / quote line) →
#          BOUNCE: print `{"decision":"block","reason":…}` teaching the
#          agent to re-emit its ending through coord:escalate or an <ask>
#          block, then stop for real. NARROW (see question_shaped_ending)
#          and LOOP-GUARDED: Claude sets `stop_hook_active:true` on the
#          hook-triggered continuation that follows a block — we check it
#          FIRST and never bounce twice in the same turn no matter what the
#          re-emitted ending looks like.
#       3. neither → allow, empty stdout, exactly like every sibling Stop
#          hook in this directory.
#
# Deliberately SYNCHRONOUS (unlike the per-tool-call activity/lock hooks,
# which MUST be fire-and-forget because they run on every single tool call):
# every branch here fires on a rare, already-pausing event — a structured
# dialog opening/closing, a permission notification, or once per turn at
# Stop — so a bounded few-second HTTP round trip is imperceptible, and Stop
# in particular MUST run synchronously anyway (its JSON decision has to
# reach stdout before the hook process exits). Every network call is
# wrapped fail-open: an unreachable/slow operator costs nothing beyond its
# own timeout and NEVER blocks the turn or corrupts stdout.
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID + su-token present),
# exactly like every other cc/ hook; a plain claude session elsewhere has no
# PAPERCUSP_SID and bails before reading stdin (EPIPE-safe — see
# __tests__/spawn-hook.ts's header for why the ordering matters).

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

TOKEN=$(cat "$TOKEN_PATH")
INPUT=$(cat)

python3 - "$INPUT" "$OPERATOR_URL" "$TOKEN" "$PAPERCUSP_SID" "${PAPERCUSP_HARNESS_SLUG:-}" <<'PYEOF' || exit 0
import json, os, re, sys, urllib.request, urllib.parse

raw, operator_url, token, owner, harness = sys.argv[1:6]
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy
HTTP_TIMEOUT = 4
# Bound how much of a (possibly huge, long-running-session) transcript we
# ever read: only the tail can hold the CURRENT turn's final assistant text.
TRANSCRIPT_TAIL_BYTES = 300_000

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


def truthy(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ('1', 'true', 'yes')
    return bool(v)


name = (first('hook_event_name', 'hookEventName') or '').strip()
session_id = first('session_id', 'sessionId') or ''
tool_name = first('tool_name', 'toolName') or ''
tool_input = first('tool_input', 'toolInput')
if not isinstance(tool_input, dict):
    tool_input = {}
tool_use_id = first('tool_use_id', 'toolCallId', 'tool_call_id') or ''

GATE_TOOLS = ('AskUserQuestion', 'ExitPlanMode')


def call_tool(tool, args, timeout=HTTP_TIMEOUT):
    """POST one MCP tool call; return its parsed JSON result, or None on any
    failure (network, timeout, tool error, malformed response) — never raises."""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                        'params': {'name': tool, 'arguments': args}}).encode()
    req = urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&client=' + urllib.parse.quote(owner, safe=''),
        data=body,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream'},
        method='POST')
    try:
        raw_resp = urllib.request.urlopen(req, timeout=timeout).read().decode('utf-8', 'replace')
    except Exception:
        return None
    result = None
    for line in raw_resp.splitlines():
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


# ── shared: mirror-question extraction for AskUserQuestion / ExitPlanMode ──────

def report_str(v):
    """Trim + drop empties (mirrors chat-protocol's reportStr): non-blank str, or None."""
    if not isinstance(v, str):
        return None
    t = v.strip()
    return t if t else None


def build_ask_question(name_, tool_input_):
    """Returns (question, options|None, text|None) for the PreToolUse mirror,
    or (None, None, None) when the tool's input carries nothing usable."""
    if name_ == 'AskUserQuestion':
        qs = tool_input_.get('questions')
        if not isinstance(qs, list) or not qs:
            return None, None, None
        head = qs[0]
        if not isinstance(head, dict):
            return None, None, None
        question = report_str(head.get('question')) or report_str(head.get('header'))
        if not question:
            return None, None, None
        opts = []
        raw_opts = head.get('options')
        if isinstance(raw_opts, list):
            for o in raw_opts:
                if not isinstance(o, dict):
                    continue
                label = report_str(o.get('label'))
                if not label:
                    continue
                entry = {'label': label[:200]}
                desc = report_str(o.get('description'))
                if desc:
                    entry['description'] = desc[:2000]
                opts.append(entry)
        extra = len(qs) - 1
        if extra > 0:
            question += f' (+{extra} more question{"s" if extra > 1 else ""})'
        return question[:2000], (opts or None), None
    if name_ == 'ExitPlanMode':
        plan = report_str(tool_input_.get('plan'))
        return 'Approve this plan?', None, (plan[:4000] if plan else None)
    return None, None, None


# ── shared: `<ask>` tag detection (python port of chat-protocol's AskBlock
# validation contract — kept behaviorally aligned with parseAskBlock/
# parseAskTag in libs/generic/chat-protocol/src/index.ts; a hook script can't
# import that TS module at runtime, so this mirrors its shape by hand) ────────

ASK_TAG_RE = re.compile(r'<ask>(.*?)</ask>', re.IGNORECASE | re.DOTALL)


def parse_ask_block(value):
    if not isinstance(value, dict):
        return None
    question = report_str(value.get('question'))
    if not question:
        return None
    options = None
    raw_opts = value.get('options')
    if isinstance(raw_opts, list):
        parsed = []
        for o in raw_opts:
            if not isinstance(o, dict):
                continue
            oid = report_str(o.get('id'))
            if not oid:
                continue
            label = report_str(o.get('label')) or oid
            parsed.append({'id': oid, 'label': label})
        options = parsed or None
    refs = None
    raw_refs = value.get('refs')
    if isinstance(raw_refs, list):
        parsed = [report_str(r) for r in raw_refs]
        parsed = [r for r in parsed if r]
        refs = parsed or None
    out = {'question': question}
    if options:
        out['options'] = options
    if refs:
        out['refs'] = refs
    return out


def parse_ask_tag(text):
    if not text:
        return None
    m = ASK_TAG_RE.search(text)
    if not m:
        return None
    try:
        data = json.loads(m.group(1).strip())
    except Exception:
        return None
    return parse_ask_block(data)


# ── shared: "question-shaped ending" heuristic — deliberately NARROW so a
# routine rhetorical aside never trips a bounce: only the FINAL non-blank
# line counts, it must be short (a sentence, not a code dump), and it must
# not look like a code-fence / quote line. ────────────────────────────────────

def question_shaped_ending(text):
    t = (text or '').rstrip()
    if not t:
        return False
    lines = [ln for ln in t.splitlines() if ln.strip()]
    if not lines:
        return False
    last = lines[-1].strip()
    if not last or len(last) > 300:
        return False
    if last.startswith('```') or last.startswith('>') or last.startswith('#'):
        return False
    return last.endswith('?')


def last_assistant_text(transcript_path):
    """Tail-read the transcript JSONL and return the LAST assistant turn's
    concatenated text blocks (skipping pure tool_use turns with no text),
    or '' when unreadable / no assistant text is found in the tail window."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return ''
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, 'rb') as f:
            if size > TRANSCRIPT_TAIL_BYTES:
                f.seek(size - TRANSCRIPT_TAIL_BYTES)
            raw_bytes = f.read()
    except Exception:
        return ''
    text = raw_bytes.decode('utf-8', 'replace')
    lines = text.split('\n')
    if size > TRANSCRIPT_TAIL_BYTES:
        lines = lines[1:]  # drop a possibly-torn first line from the seek
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if not isinstance(obj, dict) or obj.get('type') != 'assistant':
            continue
        msg = obj.get('message')
        if not isinstance(msg, dict):
            continue
        content = msg.get('content')
        texts = []
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str):
                    texts.append(block['text'])
        elif isinstance(content, str):
            texts.append(content)
        if texts:
            return '\n'.join(texts)
        continue  # a tool-only assistant turn — keep scanning further back
    return ''


# ── PreToolUse: open the blocked-session gate before the dialog renders ────────
if name == 'PreToolUse':
    if tool_name not in GATE_TOOLS:
        sys.exit(0)
    question, options, text = build_ask_question(tool_name, tool_input)
    if not question:
        sys.exit(0)
    args = {
        'sessionId': session_id or (owner + ':' + tool_name),
        'client': 'claude',
        'kind': 'ask',
        'refId': tool_use_id or (session_id + ':' + tool_name),
        'question': question,
        'ownerId': owner,
    }
    if options:
        args['options'] = options
    if text:
        args['text'] = text
    if harness:
        args['harness'] = harness
    call_tool('sessions:ingest-gate-event', args)
    sys.exit(0)

# ── PostToolUse: the dialog resolved (a tool_result exists) — auto-resolve ──────
if name == 'PostToolUse':
    if tool_name not in GATE_TOOLS:
        sys.exit(0)
    call_tool('sessions:ingest-gate-event', {
        'sessionId': session_id or (owner + ':' + tool_name),
        'client': 'claude',
        'kind': 'cleared',
        'refId': tool_use_id or (session_id + ':' + tool_name),
    })
    sys.exit(0)

# ── Notification: capture a permission-wait (the one shape a watcher can't
# see any faster than the client telling us directly). ─────────────────────────
if name == 'Notification':
    message = report_str(first('message'))
    if not message or 'permission' not in message.lower():
        sys.exit(0)
    args = {
        'sessionId': session_id or owner,
        'client': 'claude',
        'kind': 'permission_wait',
        'refId': 'notify:' + (session_id or owner),
        'text': message[:4000],
        'ownerId': owner,
    }
    if harness:
        args['harness'] = harness
    call_tool('sessions:ingest-gate-event', args)
    sys.exit(0)

# ── Stop: ask-mirror + bounce ───────────────────────────────────────────────────
if name != 'Stop':
    sys.exit(0)

# Loop guard FIRST — Claude sets this true on the hook-triggered continuation
# that follows our own `decision:block`. Never bounce twice in one turn.
if truthy(first('stop_hook_active', 'stopHookActive')):
    sys.exit(0)

# Best-effort: a turn ending means any mid-turn permission wait is moot.
call_tool('sessions:ingest-gate-event', {
    'sessionId': session_id or owner,
    'client': 'claude',
    'kind': 'cleared',
    'refId': 'notify:' + (session_id or owner),
}, timeout=2)

transcript_path = first('transcript_path', 'transcriptPath') or ''
final_text = last_assistant_text(transcript_path)

ask = parse_ask_tag(final_text)
if ask:
    escalate_args = {
        'severity': 'question',
        'summary': ask['question'][:2000],
    }
    if ask.get('options'):
        escalate_args['options'] = [{'id': o['id'][:64], 'label': o['label'][:200]} for o in ask['options']]
    if ask.get('refs'):
        escalate_args['body'] = 'refs: ' + ', '.join(ask['refs'])
    call_tool('coord:escalate', escalate_args, timeout=5)
    sys.exit(0)  # structured mirror landed — allow the stop.

if question_shaped_ending(final_text):
    reason = (
        "This turn ended with what reads as a question to the owner, but no structured "
        "mirror was found. Per papercusp convention (owner-inbox-single-pane-2026-07-17 "
        "D-001 / D-004), an owner-directed question MUST ride a durable channel: call "
        "coord:escalate (preferred — a real card, answerable from the owner's Inbox), or "
        "at minimum wrap the question in an <ask>{\"question\":\"…\",\"options\":[...]}"
        "</ask> tag. Re-emit your ending through one of those, then stop for real."
    )
    print(json.dumps({'decision': 'block', 'reason': reason}))
    sys.exit(0)

sys.exit(0)  # a normal, non-question ending — nothing to mirror.
PYEOF
exit 0
