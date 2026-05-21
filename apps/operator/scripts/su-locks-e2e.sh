#!/usr/bin/env bash
# SU-locks end-to-end test suite.
#
# Drives the LIVE operator at :3055 via real HTTP MCP transport, the
# actual hook scripts via stdin, and spawned subprocesses for
# cross-process concurrency. Each scenario reports PASS/FAIL with a
# short reason; final exit is non-zero on any failure.
#
# Prereqs:
#   - Operator running at $PAPERCUSP_OPERATOR_URL (default localhost:3055).
#   - ~/.papercusp/superuser-token and ~/.papercusp/su-agent-id present
#     (run install-standalone-mcp.sh first).
#
# Usage:
#   bash apps/operator/scripts/su-locks-e2e.sh

set -uo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3055}"
TOKEN="$(cat ~/.papercusp/superuser-token)"
AGENT_A="agent-A-$$-$(date +%s)"
AGENT_B="agent-B-$$-$(date +%s)"
AGENT_C="agent-C-$$-$(date +%s)"
HOOK_DIR="$(dirname "$0")/hooks"

PASS=0
FAIL=0
FAILED_TESTS=()

# ─── call_tool <agent_id> <tool_name> <json_args> [--max-time N] ────
call_tool() {
  local agent="$1" tool="$2" args="$3" maxt="${4:-10}"
  local body
  body=$(jq -nc --arg n "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  curl -sS -X POST "${OPERATOR_URL}/api/mcp?superuser=1&client=${agent}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body" \
    --max-time "$maxt" 2>&1
}

# Extract the inner JSON payload from the MCP response.
extract() {
  # event-stream wraps the JSON-RPC response in "event: message\ndata: {...}".
  # Pull the data: line, parse, then dig into result.content[0].text (also JSON).
  sed -n 's/^data: //p' \
    | jq -r 'if .result.isError then .result.content[0].text else .result.content[0].text end' 2>/dev/null \
    || echo "{}"
}

assert_pass() {
  local name="$1"
  PASS=$((PASS+1))
  printf "  \033[32m✓\033[0m %s\n" "$name"
}

assert_fail() {
  local name="$1" reason="${2:-}"
  FAIL=$((FAIL+1))
  FAILED_TESTS+=("$name: $reason")
  printf "  \033[31m✗\033[0m %s — %s\n" "$name" "$reason"
}

# Unique workspace for E2E (the default workspace is 'default' for SU);
# tools accept whatever the agent says — there's no scoping check here.
# All these tests share the 'default' SU workspace.

# ────────────────────────────────────────────────────────────────────
# §1. All 5 tools — basic shape over HTTP MCP transport
# ────────────────────────────────────────────────────────────────────
section() { printf "\n\033[1m%s\033[0m\n" "$1"; }

section "§1. Five tools over real HTTP MCP transport"

# Use a unique path per E2E run so we don't collide with leftover state.
P1="e2e/$$/$(date +%s)/p1.ts"
P2="e2e/$$/$(date +%s)/p2.ts"
P3="e2e/$$/$(date +%s)/p3.ts"

# acquire
RESP=$(call_tool "$AGENT_A" "locks:acquire" \
  "{\"paths\":[\"$P1\"],\"intent\":\"E2E A acquires p1\",\"ttl_sec\":60}" \
  | extract)
LOCK_ID_A=$(echo "$RESP" | jq -r '.lock_id // empty')
if [ -n "$LOCK_ID_A" ] && [ "$(echo "$RESP" | jq -r '.ok')" = "true" ]; then
  assert_pass "acquire: A gets lock_id for p1"
else
  assert_fail "acquire: A gets lock_id for p1" "resp=$RESP"
fi

# queue (read-only inspection)
RESP=$(call_tool "$AGENT_A" "locks:queue" "{\"paths\":[\"$P1\"]}" | extract)
HELD=$(echo "$RESP" | jq -r ".active_locks[] | select(.path == \"$P1\") | .owner")
if [ "$HELD" = "$AGENT_A" ]; then
  assert_pass "queue: active_locks shows A holding p1"
else
  assert_fail "queue: active_locks shows A holding p1" "owner=$HELD resp=$RESP"
fi

# heartbeat
RESP=$(call_tool "$AGENT_A" "locks:heartbeat" "{\"lock_id\":\"$LOCK_ID_A\",\"ttl_sec\":120}" | extract)
EXT=$(echo "$RESP" | jq -r '.extended')
if [ "$EXT" = "true" ]; then
  assert_pass "heartbeat: extended=true on own lock"
else
  assert_fail "heartbeat: extended=true on own lock" "resp=$RESP"
fi

# release
RESP=$(call_tool "$AGENT_A" "locks:release" "{\"lock_id\":\"$LOCK_ID_A\"}" | extract)
REL=$(echo "$RESP" | jq -r '.released | length')
if [ "$REL" = "1" ]; then
  assert_pass "release: frees 1 path"
else
  assert_fail "release: frees 1 path" "released=$REL resp=$RESP"
fi

# cancel_wait (without an active waiter — should return cancelled:false)
FAKE_TICKET="00000000-0000-0000-0000-000000000000"
RESP=$(call_tool "$AGENT_A" "locks:cancel_wait" "{\"ticket_id\":\"$FAKE_TICKET\"}" | extract)
CANC=$(echo "$RESP" | jq -r '.cancelled')
if [ "$CANC" = "false" ]; then
  assert_pass "cancel_wait: returns false for non-existent ticket"
else
  assert_fail "cancel_wait: returns false for non-existent ticket" "resp=$RESP"
fi

# ────────────────────────────────────────────────────────────────────
# §2. Cross-owner attack defense (audit 8 / bugs #16, #17)
# ────────────────────────────────────────────────────────────────────
section "§2. Cross-owner attack defense"

RESP=$(call_tool "$AGENT_A" "locks:acquire" \
  "{\"paths\":[\"$P2\"],\"intent\":\"A holds p2\",\"ttl_sec\":60}" | extract)
LOCK_ID_A2=$(echo "$RESP" | jq -r '.lock_id // empty')
if [ -z "$LOCK_ID_A2" ]; then
  assert_fail "setup: A acquires p2" "$RESP"
else
  # B attempts release using A's lock_id
  RESP=$(call_tool "$AGENT_B" "locks:release" "{\"lock_id\":\"$LOCK_ID_A2\"}" | extract)
  REL=$(echo "$RESP" | jq -r '.released | length')
  if [ "$REL" = "0" ]; then
    assert_pass "release: B with A's lock_id releases 0 paths (owner check)"
  else
    assert_fail "release: B with A's lock_id releases 0 paths (owner check)" "B released $REL resp=$RESP"
  fi

  # B attempts heartbeat using A's lock_id (ttl_sec within zod max of 3600)
  RESP=$(call_tool "$AGENT_B" "locks:heartbeat" "{\"lock_id\":\"$LOCK_ID_A2\",\"ttl_sec\":3000}" | extract)
  EXT=$(echo "$RESP" | jq -r '.extended')
  if [ "$EXT" = "false" ]; then
    assert_pass "heartbeat: B with A's lock_id gets extended=false (owner check)"
  else
    assert_fail "heartbeat: B with A's lock_id gets extended=false (owner check)" "extended=$EXT"
  fi

  # Cleanup
  call_tool "$AGENT_A" "locks:release" "{\"lock_id\":\"$LOCK_ID_A2\"}" >/dev/null
fi

# ────────────────────────────────────────────────────────────────────
# §3. Same-owner refresh preserves lock_id (audit 4)
# ────────────────────────────────────────────────────────────────────
section "§3. Same-owner refresh preserves lock_id"

R1=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$P3\"],\"intent\":\"first\",\"ttl_sec\":60}" | extract)
L1=$(echo "$R1" | jq -r '.lock_id // empty')
R2=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$P3\"],\"intent\":\"second\",\"ttl_sec\":60}" | extract)
L2=$(echo "$R2" | jq -r '.lock_id // empty')
if [ -n "$L1" ] && [ "$L1" = "$L2" ]; then
  assert_pass "acquire: same-owner same-path refresh keeps lock_id ($L1)"
else
  assert_fail "acquire: same-owner same-path refresh keeps lock_id" "L1=$L1 L2=$L2"
fi
call_tool "$AGENT_A" "locks:release" "{\"lock_id\":\"$L1\"}" >/dev/null

# ────────────────────────────────────────────────────────────────────
# §4. Multi-path acquire unification (audit 5 / bug #11)
# ────────────────────────────────────────────────────────────────────
section "§4. Multi-path acquire unifies lock_ids"

PA="e2e/$$/u/a.ts"
PB="e2e/$$/u/b.ts"
PC="e2e/$$/u/c.ts"
R1=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$PA\"],\"intent\":\"u1\",\"ttl_sec\":60}" | extract)
K1=$(echo "$R1" | jq -r '.lock_id')
R2=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$PB\"],\"intent\":\"u2\",\"ttl_sec\":60}" | extract)
K2=$(echo "$R2" | jq -r '.lock_id')
R3=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$PA\",\"$PB\",\"$PC\"],\"intent\":\"u3\",\"ttl_sec\":60}" | extract)
K3=$(echo "$R3" | jq -r '.lock_id')

# Release K3 should free all 3 paths.
REL=$(call_tool "$AGENT_A" "locks:release" "{\"lock_id\":\"$K3\"}" | extract)
RC=$(echo "$REL" | jq -r '.released | length')
if [ "$RC" = "3" ]; then
  assert_pass "acquire: extending across 2 prior lock_ids unifies (release($K3) frees 3)"
else
  assert_fail "acquire: extending across 2 prior lock_ids unifies" "released=$RC K1=$K1 K2=$K2 K3=$K3"
fi

# ────────────────────────────────────────────────────────────────────
# §5. Failed multi-path acquire is side-effect free (audit 5 / bug #12)
# ────────────────────────────────────────────────────────────────────
section "§5. Failed multi-path acquire leaves caller's locks untouched"

PHELD="e2e/$$/se/kept.ts"
PBLOCK="e2e/$$/se/blocked.ts"
R1=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$PHELD\"],\"intent\":\"original\",\"ttl_sec\":60}" | extract)
KA=$(echo "$R1" | jq -r '.lock_id')
call_tool "$AGENT_B" "locks:acquire" "{\"paths\":[\"$PBLOCK\"],\"intent\":\"B\",\"ttl_sec\":60}" >/dev/null

# A tries [kept, blocked] with different intent. Must fail; PHELD intent unchanged.
RESP=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$PHELD\",\"$PBLOCK\"],\"intent\":\"A retry\",\"ttl_sec\":600}" | extract)
OK=$(echo "$RESP" | jq -r '.ok')
if [ "$OK" = "false" ]; then
  # Now verify A's PHELD intent is still "original"
  Q=$(call_tool "$AGENT_A" "locks:queue" "{\"paths\":[\"$PHELD\"]}" | extract)
  INT=$(echo "$Q" | jq -r ".active_locks[] | select(.path==\"$PHELD\") | .intent")
  if [ "$INT" = "original" ]; then
    assert_pass "failed acquire: PHELD intent stays 'original' (not mutated to 'A retry')"
  else
    assert_fail "failed acquire: PHELD intent stays 'original'" "actual='$INT'"
  fi
else
  assert_fail "failed acquire: A's overlap call should fail (B holds blocked.ts)" "got ok=true"
fi
call_tool "$AGENT_A" "locks:release" "{\"all_mine\":true}" >/dev/null
call_tool "$AGENT_B" "locks:release" "{\"all_mine\":true}" >/dev/null

# ────────────────────────────────────────────────────────────────────
# §6. Concurrent contention — only one winner (real cross-process)
# ────────────────────────────────────────────────────────────────────
section "§6. Concurrent contention (5 parallel curls)"

PHOT="e2e/$$/race/hot.ts"
TMPDIR_RACE="$(mktemp -d)"
for i in 1 2 3 4 5; do
  (
    R=$(call_tool "agent-race-$i-$$" "locks:acquire" \
      "{\"paths\":[\"$PHOT\"],\"intent\":\"race-$i\",\"ttl_sec\":60}" | extract)
    echo "$R" > "$TMPDIR_RACE/r$i.json"
  ) &
done
wait
WINNERS=0
LOCK_ID_WIN=""
WIN_AGENT=""
for i in 1 2 3 4 5; do
  OK=$(jq -r '.ok' < "$TMPDIR_RACE/r$i.json")
  if [ "$OK" = "true" ]; then
    WINNERS=$((WINNERS+1))
    LOCK_ID_WIN=$(jq -r '.lock_id' < "$TMPDIR_RACE/r$i.json")
    WIN_AGENT="agent-race-$i-$$"
  fi
done
if [ "$WINNERS" = "1" ]; then
  assert_pass "concurrent acquire: exactly 1 winner of 5"
else
  assert_fail "concurrent acquire: exactly 1 winner of 5" "winners=$WINNERS"
fi
if [ -n "$LOCK_ID_WIN" ]; then
  call_tool "$WIN_AGENT" "locks:release" "{\"lock_id\":\"$LOCK_ID_WIN\"}" >/dev/null
fi
rm -rf "$TMPDIR_RACE"

# ────────────────────────────────────────────────────────────────────
# §7. PreToolUse / PostToolUse hook end-to-end
#
# All hook payloads carry an explicit `session_id` so the hook keys
# identity on that — it never reads or mutates ~/.papercusp/su-agent-id.
# (An earlier version of this suite swapped that real machine file to
# fake two agents; a crash mid-swap corrupted the machine's identity.
# Never mutate real system files in a test — fake identity via the
# session_id field the hook already supports.)
# ────────────────────────────────────────────────────────────────────
section "§7. PreToolUse / PostToolUse hook end-to-end"

PAPERCUP_FILE="/home/marsh-office/papercupai-workspace/papercup/apps/operator/lib/E2E_HOOK_FILE.txt"
HSESS="e2e-hooksess-$"
rm -rf ~/.papercusp/locks-cache
export PAPERCUSP_OPERATOR_URL="$OPERATOR_URL"

# First Pre — should succeed and cache lock_id
out1=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PAPERCUP_FILE\"},\"tool_use_id\":\"e2e-hook-1\",\"session_id\":\"$HSESS\"}" \
  | bash "$HOOK_DIR/pretooluse-locks-acquire.sh" 2>&1)
ec1=$?
if [ "$ec1" = "0" ] && [ -f ~/.papercusp/locks-cache/e2e-hook-1.lock ]; then
  assert_pass "PreToolUse hook acquires + caches lock_id"
else
  assert_fail "PreToolUse hook acquires + caches lock_id" "exit=$ec1 out=$out1"
fi

# Second Pre, same session_id, same file — same owner, refreshes own.
out2=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PAPERCUP_FILE\"},\"tool_use_id\":\"e2e-hook-1b\",\"session_id\":\"$HSESS\"}" \
  | bash "$HOOK_DIR/pretooluse-locks-acquire.sh" 2>&1)
ec2=$?
if [ "$ec2" = "0" ]; then
  assert_pass "PreToolUse hook: same-session re-acquire on same file allowed (audit 1)"
else
  assert_fail "PreToolUse hook: same-session re-acquire" "exit=$ec2 out=$out2"
fi

# PostToolUse — should release the cached lock
out3=$(echo "{\"tool_use_id\":\"e2e-hook-1\",\"session_id\":\"$HSESS\"}" | bash "$HOOK_DIR/posttooluse-locks-release.sh" 2>&1)
ec3=$?
if [ "$ec3" = "0" ] && [ ! -f ~/.papercusp/locks-cache/e2e-hook-1.lock ]; then
  assert_pass "PostToolUse hook releases + clears cache file"
else
  assert_fail "PostToolUse hook releases + clears cache file" "exit=$ec3"
fi

# Hook with malformed file_path (audit 9 / bug #18)
out4=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":42},\"tool_use_id\":\"e2e-hook-bad\",\"session_id\":\"$HSESS\"}" \
  | bash "$HOOK_DIR/pretooluse-locks-acquire.sh" 2>&1)
ec4=$?
if [ "$ec4" = "0" ]; then
  assert_pass "PreToolUse hook handles non-string file_path without crashing"
else
  assert_fail "PreToolUse hook handles non-string file_path" "exit=$ec4 out=$out4"
fi

# Hook with path outside papercup repo — must allow (exit 0, no cache)
out5=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/foo\"},\"tool_use_id\":\"e2e-hook-out\",\"session_id\":\"$HSESS\"}" \
  | bash "$HOOK_DIR/pretooluse-locks-acquire.sh" 2>&1)
ec5=$?
if [ "$ec5" = "0" ] && [ ! -f ~/.papercusp/locks-cache/e2e-hook-out.lock ]; then
  assert_pass "PreToolUse hook allows paths outside papercup repo (no claim)"
else
  assert_fail "PreToolUse hook allows paths outside papercup repo" "exit=$ec5"
fi

# Cleanup: release the second pre's lock (same session_id).
echo "{\"tool_use_id\":\"e2e-hook-1b\",\"session_id\":\"$HSESS\"}" | bash "$HOOK_DIR/posttooluse-locks-release.sh" >/dev/null

# NOTE: hook conflict between two distinct sessions is covered by §12
# ("identity: hook keys owner on session_id ..."), which fakes two
# agents cleanly via the session_id field — no system-file mutation.

# ────────────────────────────────────────────────────────────────────
# §9. Wait subsystem — LISTEN/NOTIFY wake latency
#
# Direct-DB wake is ~8ms (see scripts/su-locks-wait-smoke.ts). Over
# the full HTTP MCP transport, baseline is ~700ms and Next.js dev
# adds a one-time JIT tax of several seconds on the first route hit.
# We do a warm-up call below before the timed measurement, and set
# the threshold to 5s to allow for transport overhead + tail latency.
# ────────────────────────────────────────────────────────────────────
section "§9. Wait subsystem — LISTEN/NOTIFY wake latency"

PWAIT="e2e/$/wait/file.ts"
call_tool "$AGENT_A" "locks:release" "{\"all_mine\":true}" >/dev/null
call_tool "$AGENT_B" "locks:release" "{\"all_mine\":true}" >/dev/null

# Warm-up: ensures the MCP route is JIT-compiled and any first-hit
# costs are paid before we measure.
call_tool "$AGENT_A" "locks:queue" "{}" >/dev/null
call_tool "$AGENT_B" "locks:queue" "{}" >/dev/null

# A acquires
RA=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$PWAIT\"],\"intent\":\"A holds\",\"ttl_sec\":60}" | extract)
LA=$(echo "$RA" | jq -r '.lock_id')

# B starts a wait in the background; we'll release A 2s into it.
TMPB="$(mktemp)"
START=$(date +%s%N)
( call_tool "$AGENT_B" "locks:acquire" \
  "{\"paths\":[\"$PWAIT\"],\"intent\":\"B waits\",\"ttl_sec\":60,\"wait\":{\"max_sec\":20}}" 30 \
  > "$TMPB" 2>&1 ) &
B_PID=$!

# Give B time to subscribe + INSERT waiter.
sleep 2
# A releases
RELEASE_TS=$(date +%s%N)
call_tool "$AGENT_A" "locks:release" "{\"lock_id\":\"$LA\"}" >/dev/null

# Wait for B's curl to return
wait $B_PID
B_DONE=$(date +%s%N)

# Parse B's response
BRESP=$(cat "$TMPB" | extract)
BOK=$(echo "$BRESP" | jq -r '.ok // empty')
BWAIT=$(echo "$BRESP" | jq -r '.waited_sec // empty')
WAKE_MS=$(( (B_DONE - RELEASE_TS) / 1000000 ))

# Correctness assertion: B MUST wake and acquire the lock after A's
# release. Wake LATENCY is a perf characteristic, not a correctness
# property — it's measured cleanly direct-DB by su-locks-wait-smoke.ts
# (~8ms); over a loaded HTTP dev server it varies widely (0.7s–16s).
# We report it but don't fail on it.
if [ "$BOK" = "true" ]; then
  assert_pass "wait: B wakes + acquires after A's release (latency ${WAKE_MS}ms, waited_sec=${BWAIT}s)"
  if [ "$WAKE_MS" -gt 5000 ]; then
    printf "    \033[33m(note: wake latency %dms is high — dev-server load; direct-DB is ~8ms)\033[0m\n" "$WAKE_MS"
  fi
else
  assert_fail "wait: B wakes + acquires after A's release" "ok=$BOK resp=$BRESP"
fi
BLOCK=$(echo "$BRESP" | jq -r '.lock_id // empty')
if [ -n "$BLOCK" ]; then
  call_tool "$AGENT_B" "locks:release" "{\"lock_id\":\"$BLOCK\"}" >/dev/null
fi
rm -f "$TMPB"

# ────────────────────────────────────────────────────────────────────
# §10. Path validation surface
# ────────────────────────────────────────────────────────────────────
section "§10. Path validation"

# Absolute path
RESP=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"/etc/passwd\"],\"intent\":\"x\",\"ttl_sec\":60}" | extract)
ERR=$(echo "$RESP" | jq -r '.error // empty')
if echo "$ERR" | grep -q "absolute"; then
  assert_pass "path validation: rejects absolute path"
else
  assert_fail "path validation: rejects absolute path" "resp=$RESP"
fi

# Traversal
RESP=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"../etc/passwd\"],\"intent\":\"x\",\"ttl_sec\":60}" | extract)
ERR=$(echo "$RESP" | jq -r '.error // empty')
if echo "$ERR" | grep -q "traversal"; then
  assert_pass "path validation: rejects traversal"
else
  assert_fail "path validation: rejects traversal" "resp=$RESP"
fi

# Null byte (audit 7 / bug #15)
RESP=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"foo\\u0000bar\"],\"intent\":\"x\",\"ttl_sec\":60}" | extract)
ERR=$(echo "$RESP" | jq -r '.error // empty')
if echo "$ERR" | grep -q "null byte"; then
  assert_pass "path validation: rejects null byte in path"
else
  assert_fail "path validation: rejects null byte in path" "resp=$RESP"
fi

# Backslash (file-locking #1 — POSIX slashes only)
RESP=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"apps\\\\\\\\foo.ts\"],\"intent\":\"x\",\"ttl_sec\":60}" | extract)
ERR=$(echo "$RESP" | jq -r '.error // empty')
if echo "$ERR" | grep -q "backslash"; then
  assert_pass "path validation: rejects Windows backslashes"
else
  assert_fail "path validation: rejects Windows backslashes" "resp=$RESP"
fi

# Equivalent-but-non-identical spellings must collide (file-locking #1).
# A holds 'apps/canon-test.ts'; B acquires './apps/canon-test.ts' —
# canonicalization must make B see busy.
EQP="apps/canon-$-test.ts"
call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"$EQP\"],\"intent\":\"A canon\",\"ttl_sec\":60}" >/dev/null
RESP=$(call_tool "$AGENT_B" "locks:acquire" "{\"paths\":[\"./$EQP\"],\"intent\":\"B canon\",\"ttl_sec\":60,\"max_wait_sec\":0}" | extract)
OKV=$(echo "$RESP" | jq -r '.ok // empty')
if [ "$OKV" = "false" ]; then
  assert_pass "canonicalization: './x' collides with 'x'"
else
  assert_fail "canonicalization: './x' collides with 'x'" "resp=$RESP"
fi
call_tool "$AGENT_A" "locks:release" "{\"all_mine\":true}" >/dev/null

# ────────────────────────────────────────────────────────────────────
# §11. zod input validation
# ────────────────────────────────────────────────────────────────────
section "§11. Input validation"

# Empty paths array
RESP=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[],\"intent\":\"x\",\"ttl_sec\":60}")
if echo "$RESP" | grep -q "invalid_args\|Too small"; then
  assert_pass "zod: rejects empty paths array"
else
  assert_fail "zod: rejects empty paths array" "resp=$RESP"
fi

# wait.max_sec > 300
RESP=$(call_tool "$AGENT_A" "locks:acquire" "{\"paths\":[\"e2e/cap.ts\"],\"intent\":\"x\",\"wait\":{\"max_sec\":9999}}")
if echo "$RESP" | grep -q "invalid_args\|too_big\|Too big\|less than"; then
  assert_pass "zod: rejects wait.max_sec > 300"
else
  assert_fail "zod: rejects wait.max_sec > 300" "resp=$RESP"
fi

# ────────────────────────────────────────────────────────────────────
# §12. Per-session identity (the fix for the per-machine-identity bug)
#
# Two SU shells on one machine read the SAME ?client= from the shared
# MCP config. Without per-session identity they'd be the same owner
# and never conflict. The route now prefers the per-connection
# Mcp-Session-Id header; the hooks use Claude Code's per-session
# session_id. This section proves both.
# ────────────────────────────────────────────────────────────────────
section "§12. Per-session identity"

# call_tool_session <client> <mcp-session-id> <tool> <args>
call_tool_session() {
  local client="$1" sess="$2" tool="$3" args="$4"
  local body
  body=$(jq -nc --arg n "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  curl -sS -X POST "${OPERATOR_URL}/api/mcp?superuser=1&client=${client}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: ${sess}" \
    -d "$body" --max-time 10 2>&1
}

IDENT_PATH="e2e/$/identity/shared.ts"
SHARED_CLIENT="e2e-shared-machine-id-$"

# Two distinct Mcp-Session-Id values, SAME ?client=. Session 1 acquires.
R=$(call_tool_session "$SHARED_CLIENT" "e2e-sess-1-$" "locks:acquire" \
  "{\"paths\":[\"$IDENT_PATH\"],\"intent\":\"session 1\",\"ttl_sec\":60}" | extract)
S1_OK=$(echo "$R" | jq -r '.ok')
S1_LOCK=$(echo "$R" | jq -r '.lock_id // empty')

# Session 2 — same ?client=, different Mcp-Session-Id — must be BUSY.
R=$(call_tool_session "$SHARED_CLIENT" "e2e-sess-2-$" "locks:acquire" \
  "{\"paths\":[\"$IDENT_PATH\"],\"intent\":\"session 2\",\"ttl_sec\":60}" | extract)
S2_OK=$(echo "$R" | jq -r '.ok')
S2_BUSY=$(echo "$R" | jq -r '.busy | length')

if [ "$S1_OK" = "true" ] && [ "$S2_OK" = "false" ] && [ "$S2_BUSY" = "1" ]; then
  assert_pass "identity: same ?client=, different Mcp-Session-Id → distinct owners (session 2 busy)"
else
  assert_fail "identity: distinct Mcp-Session-Id → distinct owners" "s1_ok=$S1_OK s2_ok=$S2_OK s2_busy=$S2_BUSY"
fi

# Fallback: same ?client=, NO Mcp-Session-Id on either → same owner (refresh).
R1=$(call_tool "$SHARED_CLIENT" "locks:acquire" \
  "{\"paths\":[\"e2e/$/identity/fb.ts\"],\"intent\":\"fb1\",\"ttl_sec\":60}" | extract)
FB1=$(echo "$R1" | jq -r '.lock_id // empty')
R2=$(call_tool "$SHARED_CLIENT" "locks:acquire" \
  "{\"paths\":[\"e2e/$/identity/fb.ts\"],\"intent\":\"fb2\",\"ttl_sec\":60}" | extract)
FB2=$(echo "$R2" | jq -r '.lock_id // empty')
if [ -n "$FB1" ] && [ "$FB1" = "$FB2" ]; then
  assert_pass "identity: same ?client=, no Mcp-Session-Id → same owner (refresh, stable lock_id)"
else
  assert_fail "identity: no-session fallback → same owner" "fb1=$FB1 fb2=$FB2"
fi

# Cleanup
[ -n "$S1_LOCK" ] && call_tool_session "$SHARED_CLIENT" "e2e-sess-1-$" "locks:release" "{\"lock_id\":\"$S1_LOCK\"}" >/dev/null
[ -n "$FB1" ] && call_tool "$SHARED_CLIENT" "locks:release" "{\"lock_id\":\"$FB1\"}" >/dev/null

# Hook path: two PreToolUse invocations with different session_id on
# the same file must conflict (the hook keys owner on session_id).
rm -rf ~/.papercusp/locks-cache
export PAPERCUSP_OPERATOR_URL="$OPERATOR_URL"
HOOK_IDENT_FILE="/home/marsh-office/papercupai-workspace/papercup/apps/operator/lib/E2E_IDENT_HOOK.txt"

ha_out=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$HOOK_IDENT_FILE\"},\"tool_use_id\":\"e2e-ha\",\"session_id\":\"e2e-hooksess-A\"}" \
  | bash "$HOOK_DIR/pretooluse-locks-acquire.sh" 2>&1)
ha_ec=$?
hb_out=$(echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$HOOK_IDENT_FILE\"},\"tool_use_id\":\"e2e-hb\",\"session_id\":\"e2e-hooksess-B\"}" \
  | bash "$HOOK_DIR/pretooluse-locks-acquire.sh" 2>&1)
hb_ec=$?

if [ "$ha_ec" = "0" ] && [ "$hb_ec" = "2" ] && echo "$hb_out" | grep -q "refused"; then
  assert_pass "identity: hook keys owner on session_id (A acquires, B with different session_id refused)"
else
  assert_fail "identity: hook per-session_id" "ha_ec=$ha_ec hb_ec=$hb_ec hb_out=$hb_out"
fi
# Cleanup
echo '{"tool_use_id":"e2e-ha","session_id":"e2e-hooksess-A"}' | bash "$HOOK_DIR/posttooluse-locks-release.sh" >/dev/null 2>&1

# ────────────────────────────────────────────────────────────────────
# Final
# ────────────────────────────────────────────────────────────────────
echo ""
printf "\033[1m=== E2E SUMMARY ===\033[0m\n"
printf "  PASS: %d\n" "$PASS"
printf "  FAIL: %d\n" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  printf "\033[31mFailed tests:\033[0m\n"
  for t in "${FAILED_TESTS[@]}"; do
    printf "  - %s\n" "$t"
  done
  exit 1
fi
echo ""
printf "\033[32mAll %d E2E checks passed.\033[0m\n" "$PASS"
exit 0
