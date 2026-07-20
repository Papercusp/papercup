#!/usr/bin/env bash
# PreToolUse hook — teach `plans:get` at the point of failure (P-003(b) of
# kickoff-prompt-absorption-2026-07-17).
#
# WHY THIS EXISTS: a plan's on-disk `docs/plans/<slug>.md` file is a
# PROJECTION of the live plan store — `plans:get` computes each item's
# effectiveStatus (todo/wip/blocked/done, folding in blockedBy resolution),
# decisions, and cross-plan links that the raw markdown bytes do not carry.
# An agent that reaches for `cat` / `Read` / `grep` on that file gets a stale,
# unresolved view AND misses the structured tool entirely — the exact
# failure this hook's sibling absorbers exist to eliminate (see the plan's
# Background section: an ornith session `cat`-ed a plan file 4x, ran `find`,
# then `node -e`, all before ever calling `plans:get`).
#
# SCOPE (deliberately narrow — the feasible subset, per the plan item):
#   - Read: tool_input.file_path is a docs/plans/**/*.md path.
#   - Grep: tool_input.path is EXPLICITLY scoped to a docs/plans (or
#     docs/plans/archive) directory, or a single *.md file under it. A
#     repo-wide/undirected grep (no `path`, or a `path` outside docs/plans)
#     is NEVER blocked here — Grep's flexible glob/path semantics make a
#     broader match too easy to get wrong and would false-positive on
#     legitimate cross-repo searches that merely happen to recurse through
#     docs/plans along the way.
#   - Bash (`cat`/`grep`/`find` targeting docs/plans/*.md by shell text) is
#     NOT covered — matching arbitrary shell command TEXT safely (without
#     false-positiving on an unrelated command that merely mentions the
#     string "docs/plans") needs much more careful parsing than a single
#     hook script can safely do; left as an explicit follow-up rather than a
#     silent gap (recorded on the plan item's completion evidence).
#
# Hint, not a hard wall: this is advisory (deny + teach), same posture as
# the sibling PreToolUse guards in this file (pretooluse-locks-acquire.sh's
# worktree/foreign-workspace guards) — the agent reads
# `permissionDecisionReason`, calls `plans:get`, and moves on; nothing is
# lost, since `plans:get { includeRaw: true }` returns the exact same bytes
# when a caller genuinely needs them.
#
# Fail-open: any parse/path error, or Papercusp not installed, ALWAYS allows
# the read — this hook only ever narrows an otherwise-allowed call.

set -euo pipefail

TOKEN_PATH="${HOME}/.papercusp/superuser-token"
if [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

INPUT=$(cat)

python3 - "$INPUT" <<'PYEOF' || exit 0
import json, os, re, sys

raw = sys.argv[1]


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
if not isinstance(tool_input, dict):
    allow()

# A docs/plans path, POSIX-normalized, whose LAST two-to-three segments are
# `docs/plans/<file>.md` or `docs/plans/archive/<file>.md`.
PLAN_FILE_RE = re.compile(r'(^|/)docs/plans(/archive)?/[^/]+\.md$')
# A directory scoped EXACTLY to docs/plans or docs/plans/archive (trailing
# slash optional) — the narrow Grep `path` case.
PLAN_DIR_RE = re.compile(r'(^|/)docs/plans(/archive)?/?$')


def as_posix(p):
    return p.replace(os.sep, '/') if p else p


def hint(matched_path):
    return (
        f"'{matched_path}' is a plan-file PROJECTION, not the plan's live state — "
        "reading the raw markdown misses computed effectiveStatus (blockedBy "
        "resolution), decisions, and cross-plan links. Call plans:get "
        "{ slug, harness } instead (mode:'full', includeRaw:true if you need the "
        "exact bytes for some other reason)."
    )


if tool_name == 'Read':
    fp = tool_input.get('file_path')
    if isinstance(fp, str) and PLAN_FILE_RE.search(as_posix(fp)):
        deny(hint(fp))
    allow()

if tool_name == 'Grep':
    p = tool_input.get('path')
    if isinstance(p, str):
        norm = as_posix(p)
        if PLAN_FILE_RE.search(norm) or PLAN_DIR_RE.search(norm):
            deny(hint(p))
    allow()

allow()
PYEOF
