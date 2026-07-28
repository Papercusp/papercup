#!/usr/bin/env bash
# PreToolUse hook — MID-TURN CONTEXT PUSH
# (context-injection-audit-2026-07-28 P-015, decision D-026).
#
# Recall used to arrive at exactly ONE boundary per turn: UserPromptSubmit.
# A turn that submits one prompt and then makes fifty tool calls got a single
# injection and then silence — so an agent could burn twenty greps re-deriving
# something already sitting in memory, because nothing after the prompt ever
# asked. This hook is that missing boundary: before a tool dispatch it asks the
# local operator (/api/agent-mcp/mid-turn-context) whether anything in memory
# bears on THIS tool call, and injects the answer as additionalContext.
#
# DUMB TRANSPORT BY DESIGN — the same property that keeps its UserPromptSubmit
# sibling (userpromptsubmit-memory.sh) at 76 lines. It ships the tool name and
# tool input; the SERVER derives the query, applies the budget, enforces the cost
# ceiling, and runs the one admission pipeline under the session-epoch dedup
# (port 'mid-turn'). All of that is therefore fixable without reinstalling this
# script on every box.
#
# ⚠ THIS HOOK GRANTS NO PERMISSION. It emits `additionalContext` and nothing
# else — deliberately NO `permissionDecision`. Emitting `permissionDecision:
# 'allow'` (as pretooluse-bash-resource-gate.sh legitimately does, because it IS
# the gate that decided) would turn a context hook into a blanket auto-approver
# for every Bash/Grep/Read call, bypassing the permission system. A hook that
# only wants to say something must never also vote on whether the call runs.
#
# Posture (mirrors the turn-start memory hook): psu sessions only (PAPERCUSP_SID),
# FAIL-OPEN — never blocks a tool call, never exits non-zero. The wall is TIGHTER
# than turn-start's 2.5s because this sits in front of every tool dispatch rather
# than once per prompt: 1.2s, after which the tool proceeds un-augmented. A slow
# or down operator costs this hook's own silence and nothing else.
#
# PAPERCUSP_MID_TURN_CONTEXT=off disables it.

set -euo pipefail

if [ -z "${PAPERCUSP_SID:-}" ]; then
  exit 0
fi
if [ "${PAPERCUSP_MID_TURN_CONTEXT:-on}" = "off" ]; then
  exit 0
fi
INPUT=$(cat)

# Fail-open backstop: any uncaught crash injects nothing and allows the call.
python3 - "$PAPERCUSP_SID" "$INPUT" <<'PYEOF' || exit 0
import json, os, sys, urllib.request

sid, raw = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
except Exception:
    sys.exit(0)

tool = data.get('tool_name') or ''
tool_input = data.get('tool_input')
if not isinstance(tool, str) or not tool:
    sys.exit(0)

base = (os.environ.get('PAPERCUSP_OPERATOR_URL') or 'http://localhost:3070').rstrip('/')
body = json.dumps({
    'owner': sid,
    'tool': tool,
    'toolInput': tool_input,
    'workspace': os.environ.get('PAPERCUSP_WORKSPACE') or '',
    'harness': os.environ.get('PAPERCUSP_HARNESS_SLUG') or '',
}).encode('utf-8')

# localhost operator: never via egress http(s)_proxy (502s the local call).
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
req = urllib.request.Request(
    base + '/api/agent-mcp/mid-turn-context',
    data=body,
    headers={'Content-Type': 'application/json'},
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=1.2) as res:
        payload = json.loads(res.read().decode('utf-8'))
except Exception:
    sys.exit(0)

text = payload.get('text') if isinstance(payload, dict) else ''
if not isinstance(text, str) or not text.strip():
    sys.exit(0)

# additionalContext ONLY — no permissionDecision (see the header).
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'additionalContext': text,
    },
}))
PYEOF
