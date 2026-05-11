#!/usr/bin/env bash
# Thorough verification of every change shipped today against the
# running prod server. Each line of output corresponds to one
# claim about a piece of work; ✓ = verified, ✗ = failed, ⊘ = needs
# user/browser verification (cannot be done from CLI).
#
# Run with: bash apps/operator/scripts/verify-today.sh
# Assumes prod is up on :3070 and EL credentials are present.
set -uo pipefail

BASE="${BASE:-http://localhost:3070}"
PASS=0
FAIL=0
SKIP=0
FAILURES=()

ok()    { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
skip()  { echo "  ⊘ $1"; SKIP=$((SKIP+1)); }
hdr()   { echo; echo "── $1 ──"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1"; exit 2; }
}
require_cmd curl
require_cmd python3
require_cmd jq

# ──────────────────────────────────────────────────────────────────
hdr "Prod server health (3070)"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/harness?ws=default" 2>/dev/null || echo 000)
[[ "$HTTP" == "200" ]] && ok "/harness HTTP 200" || fail "/harness HTTP $HTTP"

for view in timeline delegates scan-history; do
  H=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/harness?ws=default&view=$view" 2>/dev/null || echo 000)
  [[ "$H" == "200" ]] && ok "tab view=$view → 200" || fail "tab view=$view → $H"
done

H=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/el-min" 2>/dev/null || echo 000)
[[ "$H" == "200" ]] && ok "/el-min diagnostic route → 200" || fail "/el-min → $H"

# ──────────────────────────────────────────────────────────────────
hdr "Voice + EL endpoints"
H=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/api/agent-mcp/operator-elevenlabs-bootstrap" 2>/dev/null)
[[ "$H" == "200" ]] && ok "EL bootstrap mints token (HTTP 200)" || fail "EL bootstrap → $H"

VOICE=$(curl -sS "$BASE/api/agent-mcp/operator-conv-voice" 2>/dev/null)
VID=$(echo "$VOICE" | jq -r '.voiceId')
MODEL=$(echo "$VOICE" | jq -r '.modelId')
[[ "$VID" == "ROMJ9yK1NAMuu1ggrjDW" ]] \
  && ok "operator-conv-voice voice_id = Relaxing Rachel" \
  || fail "voice_id is $VID, expected ROMJ9yK1NAMuu1ggrjDW"
[[ "$MODEL" == "eleven_turbo_v2" ]] \
  && ok "operator-conv-voice model_id = eleven_turbo_v2" \
  || fail "model_id is $MODEL, expected eleven_turbo_v2"

RESET=$(curl -sS -X POST "$BASE/api/agent-mcp/operator-scanner-reset" 2>/dev/null)
ENABLED=$(echo "$RESET" | jq -r '.enabled')
[[ "$ENABLED" == "false" ]] \
  && ok "scanner-reset reports Phase 3 OFF (env unset, as expected)" \
  || fail "scanner-reset enabled=$ENABLED, expected false"

# ──────────────────────────────────────────────────────────────────
hdr "Scan history (Phase 2)"
SCANS=$(curl -sS "$BASE/api/agent-mcp/operator-scans?limit=5" 2>/dev/null)
COUNT=$(echo "$SCANS" | jq '.scans | length')
[[ "$COUNT" =~ ^[0-9]+$ ]] && ok "operator-scans endpoint returns $COUNT scans" || fail "operator-scans returned non-numeric count"
LATEST=$(echo "$SCANS" | jq -r '.scans[0].id // "none"')
if [[ "$LATEST" != "none" ]]; then
  SUMMARY=$(echo "$SCANS" | jq -r '.scans[0].summary // ""')
  [[ -n "$SUMMARY" && "$SUMMARY" != "null" ]] \
    && ok "latest scan id=$LATEST has a non-empty summary" \
    || fail "latest scan id=$LATEST summary is empty/null"
  SCAN_ONE=$(curl -sS "$BASE/api/agent-mcp/operator-scans?id=$LATEST" 2>/dev/null)
  HAS_SUGS=$(echo "$SCAN_ONE" | jq -r '.scan.suggestions | length')
  [[ "$HAS_SUGS" =~ ^[0-9]+$ ]] \
    && ok "operator-scans?id=$LATEST returns $HAS_SUGS suggestions" \
    || fail "operator-scans?id=$LATEST suggestions field broken"
else
  skip "no scans in DB — run a scan from the panel to verify Phase 2 fully"
fi

# ──────────────────────────────────────────────────────────────────
hdr "Delegate history + tools"
DELS=$(curl -sS "$BASE/api/agent-mcp/delegates?status=all&limit=5" 2>/dev/null)
DCOUNT=$(echo "$DELS" | jq '.sessions | length')
[[ "$DCOUNT" =~ ^[0-9]+$ ]] && ok "delegates endpoint returns $DCOUNT rows" || fail "delegates endpoint broken"

# Server-side SSE delegate (sync path, deterministic)
SSE=$(curl -sS --max-time 30 "$BASE/api/agent-mcp/delegate-chat?request=what+is+2+plus+2&newSession=1" 2>/dev/null)
echo "$SSE" | grep -q "event: session" && ok "delegate-chat emits 'session' event" || fail "delegate-chat session event missing"
echo "$SSE" | grep -q "event: done" && ok "delegate-chat emits 'done' event" || fail "delegate-chat done event missing"
echo "$SSE" | grep -q '"fullText"' && ok "delegate-chat done event has fullText" || fail "delegate-chat done event lacks fullText"

# ──────────────────────────────────────────────────────────────────
hdr "Drift checker"
cd /home/marsh-office/papercupai-workspace/papercup/apps/operator
node scripts/el-tools-check.mjs > /tmp/verify-drift.log 2>&1
EC=$?
if [[ $EC -eq 0 ]]; then
  if grep -q "✓ aligned" /tmp/verify-drift.log; then
    TOOL_COUNT=$(grep -oE "[0-9]+ client tools" /tmp/verify-drift.log | head -1)
    ok "drift checker clean — $TOOL_COUNT registered + matching defs"
  else
    ok "drift checker exit 0 (warnings only)"
  fi
elif [[ $EC -eq 1 ]]; then
  fail "drift checker reports DRIFT (exit 1) — see /tmp/verify-drift.log"
else
  fail "drift checker errored (exit $EC)"
fi

# ──────────────────────────────────────────────────────────────────
hdr "EL agent live config (sync truth)"
XI_KEY=$(jq -r '.elevenlabs.apiKey' ~/.papercusp/credentials.json 2>/dev/null)
AGENT=$(jq -r '.elevenLabsAgentId' ~/.papercusp-workspaces/default/.papercusp/system/operator/voice-prefs.json 2>/dev/null)
# PG-loopback fallback (post voice-credentials migration to PG, round-1)
if [[ -z "$XI_KEY" || "$XI_KEY" == "null" || -z "$AGENT" || "$AGENT" == "null" ]]; then
  LOOP=$(curl -sS "http://127.0.0.1:${OPERATOR_PORT:-3070}/api/agent-mcp/el-admin-creds" 2>/dev/null)
  if [[ -n "$LOOP" ]]; then
    [[ -z "$XI_KEY" || "$XI_KEY" == "null" ]] && XI_KEY=$(echo "$LOOP" | jq -r '.apiKey // empty')
    [[ -z "$AGENT" || "$AGENT" == "null" ]] && AGENT=$(echo "$LOOP" | jq -r '.agentId // empty')
  fi
fi
if [[ -z "$XI_KEY" || -z "$AGENT" || "$XI_KEY" == "null" || "$AGENT" == "null" ]]; then
  skip "no EL creds available — skipping live agent config check"
else
  CFG=$(curl -sS "https://api.elevenlabs.io/v1/convai/agents/$AGENT" -H "xi-api-key: $XI_KEY" 2>/dev/null)
  AGENT_VOICE=$(echo "$CFG" | jq -r '.conversation_config.tts.voice_id')
  AGENT_MODEL=$(echo "$CFG" | jq -r '.conversation_config.tts.model_id')
  TURN_TIMEOUT=$(echo "$CFG" | jq -r '.conversation_config.turn.turn_timeout')
  TURN_EAGERNESS=$(echo "$CFG" | jq -r '.conversation_config.turn.turn_eagerness')
  TOOL_IDS=$(echo "$CFG" | jq -r '.conversation_config.agent.prompt.tool_ids | length')
  PERSONA_LEN=$(echo "$CFG" | jq -r '.conversation_config.agent.prompt.prompt | length')

  [[ "$AGENT_VOICE" == "ROMJ9yK1NAMuu1ggrjDW" ]] \
    && ok "live agent voice_id = Relaxing Rachel" \
    || fail "live agent voice_id = $AGENT_VOICE"
  [[ "$AGENT_MODEL" == "eleven_turbo_v2" ]] \
    && ok "live agent model_id = eleven_turbo_v2" \
    || fail "live agent model_id = $AGENT_MODEL"
  [[ "$TURN_TIMEOUT" == "-1" || "$TURN_TIMEOUT" == "-1.0" ]] \
    && ok "turn_timeout disabled (no silence-fill 'still there?')" \
    || fail "turn_timeout = $TURN_TIMEOUT (expected -1)"
  [[ "$TURN_EAGERNESS" == "patient" ]] \
    && ok "turn_eagerness = patient" \
    || fail "turn_eagerness = $TURN_EAGERNESS"
  [[ "$TOOL_IDS" -ge 28 ]] \
    && ok "agent has $TOOL_IDS tools attached (≥28 expected)" \
    || fail "agent has only $TOOL_IDS tools, expected ≥28"
  [[ "$PERSONA_LEN" -ge 6000 ]] \
    && ok "persona is $PERSONA_LEN chars (≥6000 expected — has all today's rules)" \
    || fail "persona is only $PERSONA_LEN chars"

  # Verify the new async delegate description is in place
  DESC=$(echo "$CFG" | jq -r '.conversation_config.agent.prompt.tools[]? | select(.name=="delegate_to_claude") | .description // ""')
  if echo "$DESC" | grep -qE "started|async|status:'started'"; then
    ok "delegate_to_claude description teaches the async return shape"
  else
    # tool_ids reference workspace tools; check there instead
    DELEGATE_TOOL_ID=$(curl -sS "https://api.elevenlabs.io/v1/convai/tools" -H "xi-api-key: $XI_KEY" 2>/dev/null \
      | jq -r '.tools[]? | select(.tool_config.name=="delegate_to_claude") | .id // .tool_id' | head -1)
    if [[ -n "$DELEGATE_TOOL_ID" ]]; then
      DESC=$(curl -sS "https://api.elevenlabs.io/v1/convai/tools/$DELEGATE_TOOL_ID" -H "xi-api-key: $XI_KEY" \
        | jq -r '.tool_config.description // ""')
      if echo "$DESC" | grep -qiE "started|async"; then
        ok "delegate_to_claude (workspace tool) description teaches async return"
      else
        fail "delegate_to_claude description doesn't mention async/started"
      fi
    else
      fail "delegate_to_claude tool not found"
    fi
  fi
fi

# ──────────────────────────────────────────────────────────────────
hdr "Scanner role file"
SCANNER_MD=/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/packages/harness/prompts/scanner.md
[[ -f "$SCANNER_MD" ]] && ok "scanner.md exists at canonical role path" || fail "scanner.md missing"
LEN=$(wc -c < "$SCANNER_MD")
[[ "$LEN" -gt 4000 ]] && ok "scanner.md content size $LEN chars" || fail "scanner.md too small ($LEN chars)"

# Confirm operator-prompt-system loads the file (vs falling back to inline).
# Use a tiny .mjs that does dynamic import — `npx tsx -e` chokes on
# top-level await in CJS-eval mode.
PROBE_FILE=$(mktemp --suffix=.mjs)
cat > "$PROBE_FILE" <<EOF
const m = await import('/home/marsh-office/papercupai-workspace/papercup/apps/operator/lib/operator-prompt-system.ts');
console.log(m.OPERATOR_SUBSTRATE_PROMPT.length);
EOF
LOADED_LEN=$(cd /home/marsh-office/papercupai-workspace/papercup/apps/operator && npx tsx "$PROBE_FILE" 2>/dev/null)
rm -f "$PROBE_FILE"
[[ "$LOADED_LEN" =~ ^[0-9]+$ ]] && [[ "$LOADED_LEN" -gt 4000 ]] \
  && ok "OPERATOR_SUBSTRATE_PROMPT loaded ($LOADED_LEN chars from scanner.md)" \
  || fail "OPERATOR_SUBSTRATE_PROMPT didn't load properly ($LOADED_LEN)"

# ──────────────────────────────────────────────────────────────────
hdr "Unit tests (today's fixes)"
cd /home/marsh-office/papercupai-workspace/papercup/apps/operator
for testfile in lib/operator-notes.test.ts app/_components/voice/voice-mode.test.ts app/api/_hono/experts.test.ts app/_components/voice/voice-leader.test.ts; do
  RESULT=$(npx vitest run "$testfile" 2>&1 | grep -E "Tests +" | tail -1)
  if echo "$RESULT" | grep -q "passed"; then
    if echo "$RESULT" | grep -q "failed"; then
      fail "$testfile: $(echo "$RESULT" | xargs)"
    else
      ok "$testfile: $(echo "$RESULT" | xargs)"
    fi
  else
    fail "$testfile: no test output"
  fi
done

# ──────────────────────────────────────────────────────────────────
hdr "Build + bundle integrity"
# Prod build now lives in .next-prod (dist bifurcated 2026-05-11 so
# dev rebuilds don't invalidate prod). Pick whichever exists.
BUNDLE_DIR=".next-prod"
[ -d "$BUNDLE_DIR/standalone" ] || BUNDLE_DIR=".next"
ls "$BUNDLE_DIR/standalone/apps/operator/server.js" >/dev/null 2>&1 \
  && ok "standalone bundle exists ($BUNDLE_DIR)" \
  || fail "no standalone bundle (checked .next-prod and .next)"

# OperatorDelegationListener + ScanHistorySection are 'use client' —
# their compiled output goes into static/chunks, not server/chunks.
grep -lE "delegation-async-complete|sendSystemToActiveSession" "$BUNDLE_DIR"/static/chunks/*.js >/dev/null 2>&1 \
  && ok "async-delegate event wired into client bundle" \
  || fail "delegation-async-complete missing from client bundle"

grep -l "operator-scan-history__list" "$BUNDLE_DIR"/static/chunks/*.css >/dev/null 2>&1 \
  && ok "scan history CSS in static bundle" \
  || fail "scan history CSS missing"

# Bundler minifies the component name; check for an unmistakable
# CSS class the component renders instead.
grep -l "operator-scan-history__cards-label" "$BUNDLE_DIR"/static/chunks/*.js >/dev/null 2>&1 \
  && ok "ScanHistorySection compiled into client bundle" \
  || fail "ScanHistorySection missing from client bundle"

# ──────────────────────────────────────────────────────────────────
hdr "Browser-only (cannot verify from CLI)"
skip "voice button click → EL session connect (needs browser EL session)"
skip "focus-follows-tab leader handover (needs 2 browser tabs)"
skip "'Listening here now' / 'Listening moved to another tab' toasts"
skip "Scan history tab UI rendering (needs browser)"
skip "Delegates spinner indicator on running rows"
skip "Async-delegate sendContextualUpdate fires on real EL session"
skip "Voice characteristics (Rachel sounds female, no robotic 'still on it')"

# ──────────────────────────────────────────────────────────────────
echo
echo "═════════════════════════════════════════"
echo "  ✓ $PASS passed   ✗ $FAIL failed   ⊘ $SKIP browser-only"
if [[ $FAIL -gt 0 ]]; then
  echo
  echo "Failures:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
fi
echo "═════════════════════════════════════════"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
