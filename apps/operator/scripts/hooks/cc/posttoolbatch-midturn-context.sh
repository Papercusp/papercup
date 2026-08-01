#!/usr/bin/env bash
# PostToolBatch hook — MID-TURN CONTEXT PUSH
# (context-injection-audit-2026-07-28 P-015, decisions D-026 + D-027).
#
# Recall used to arrive at exactly ONE boundary per turn: UserPromptSubmit.
# A turn that submits one prompt and then makes fifty tool calls got a single
# injection and then silence — so an agent could burn twenty greps re-deriving
# something already sitting in memory, because nothing after the prompt ever
# asked. This hook is that missing boundary.
#
# ⚠ WHY PostToolBatch AND NOT PreToolUse (D-027 — do not "fix" this back):
# PreToolUse does NOT inject additionalContext unless it is accompanied by a
# `permissionDecision`, and emitting `permissionDecision: 'allow'` from a
# CONTEXT hook would blanket auto-approve every tool call it matches, bypassing
# the permission system. A hook that only wants to SAY something must never also
# vote on whether the call runs. PostToolBatch is the documented channel for
# this ("Return additionalContext via hookSpecificOutput to inject context once
# for the whole batch"), carries no permission semantics at all, and fires once
# after a batch resolves BEFORE THE NEXT MODEL REQUEST — exactly the moment the
# agent is about to decide what to do next. This was found by building the
# PreToolUse version first and watching it deliver nothing with every unit test
# green; see D-027 for the evidence and the verification method.
#
# PostToolBatch takes NO matcher (it is not in Claude's matcher-supporting event
# set), so it fires on every batch. That is affordable because the SERVER drops
# a batch with no recall signal before spending anything, and once-per-batch is
# far cheaper than once-per-tool-call.
#
# DUMB TRANSPORT BY DESIGN — the same property that keeps its UserPromptSubmit
# sibling (userpromptsubmit-memory.sh) at 76 lines. It ships a CLAMPED digest of
# the batch; the SERVER derives the query, applies the budget, enforces the cost
# ceiling, and runs the one admission pipeline under the session-epoch dedup
# (port 'mid-turn'). All of that stays fixable without reinstalling this script
# on every box in the fleet.
#
# Posture: psu sessions only (PAPERCUSP_SID), FAIL-OPEN — never breaks the
# agentic loop, never exits non-zero (exit 2 would STOP the loop, so every path
# here exits 0). 1.5s wall, after which the turn proceeds un-augmented.
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

# Fail-open backstop: any uncaught crash injects nothing and continues the loop.
python3 - "$PAPERCUSP_SID" "$INPUT" <<'PYEOF' || exit 0
import json, os, sys, urllib.request

sid, raw = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
except Exception:
    sys.exit(0)

calls = data.get('tool_calls')
if not isinstance(calls, list) or not calls:
    sys.exit(0)

# CLAMP HERE, not server-side: a tool_response can be megabytes (a big grep, a
# file read), and this hook runs on every batch. Shipping raw batches would make
# the transport itself the cost. The server only needs enough to form a query.
FIELD_CLAMP = 400
MAX_CALLS = 12


def clamp(value):
    if value is None:
        return ''
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text[:FIELD_CLAMP]


digest = []
for call in calls[:MAX_CALLS]:
    if not isinstance(call, dict):
        continue
    digest.append({
        'tool': call.get('tool_name') or '',
        'toolInput': clamp(call.get('tool_input')),
        'toolResponse': clamp(call.get('tool_response')),
    })
if not digest:
    sys.exit(0)

base = (os.environ.get('PAPERCUSP_OPERATOR_URL') or 'http://localhost:3070').rstrip('/')
body = json.dumps({
    'owner': sid,
    'toolCalls': digest,
    'workspace': os.environ.get('PAPERCUSP_WORKSPACE') or '',
    'harness': os.environ.get('PAPERCUSP_HARNESS_SLUG') or '',
    # EI-18893248175645463, mid-turn half (context-injection-audit P-038):
    # PAPERCUSP_HARNESS_SLUG is only exported for harness-scoped spawns, so an
    # operator/superuser-scope session never sends one and BOTH the harness and
    # hive pools go empty for that session's entire lifetime. The turn-start
    # sibling (userpromptsubmit-memory.sh) was fixed; this surface has the
    # IDENTICAL defect and was not — measured 2026-08-01 over 7d: 44.8% of
    # mid-turn recalls queried the harness pool with ZERO scopes, and in exactly
    # those the user pool alone filled all 12 slots (44.8%, a near-perfect
    # correlation). cwd lets the server run the same env→marker-file→meta-repo
    # fallback chain (detect-harness-slug.ts) instead of giving up outright.
    'cwd': os.getcwd(),
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
    with urllib.request.urlopen(req, timeout=1.5) as res:
        payload = json.loads(res.read().decode('utf-8'))
except Exception:
    sys.exit(0)

text = payload.get('text') if isinstance(payload, dict) else ''
if not isinstance(text, str) or not text.strip():
    sys.exit(0)

print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PostToolBatch',
        'additionalContext': text,
    },
}))
PYEOF
