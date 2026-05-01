#!/usr/bin/env bash
# Integration smoke for multi-harness-spawning v1.
#
# Smoke A — papercup-org happy path: directive → director → spawn child → completion
# Smoke B — generic non-papercup-org harness can also spawn children
# Smoke C — tiered visibility + cross-harness messaging (no LLM; substrate only)
# Smoke D — auth model holds against forgery attempts
#
# Designed to run end-to-end on a clean machine. Parallel state mutations
# (other agents, paperclip) may cause flake; re-run from a fresh prune.

set -uo pipefail

OPERATOR_BASE="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
PASS=0; FAIL=0
results=()

note() { echo; echo "════ $* ════"; }
ok()   { PASS=$((PASS+1)); results+=("PASS  $*"); echo "  ✓ $*"; }
bad()  { FAIL=$((FAIL+1)); results+=("FAIL  $*"); echo "  ✗ $*"; }

token_for() {
  local slug="$1"
  local cfg
  for cfg in \
    "/home/marsh-office/.papercusp-workspaces/default/.papercusp/projects/$slug/.harness/config.json" \
    "/home/marsh-office/.papercusp/projects/$slug/.harness/config.json" \
    "/home/marsh-office/$slug/.harness/config.json" \
    "/home/marsh-office/.restart-org/.harness/config.json" \
    "/home/marsh-office/sheets-clone/.harness/config.json"; do
    if [ -f "$cfg" ]; then
      jq -r '.harness_token // empty' "$cfg" 2>/dev/null && return 0
    fi
  done
  echo ""
}

uuid() { uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())'; }

# ── Smoke D — auth model (cheap, no LLM, run first to fail-fast on infra) ──
note "Smoke D — auth model holds"

S=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$OPERATOR_BASE/api/admin/execute-action" -H 'content-type: application/json' -d '{}')
[ "$S" = "401" ] && ok "D1 no-auth → 401" || bad "D1 expected 401, got $S"

S=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$OPERATOR_BASE/api/admin/execute-action" \
  -H 'Authorization: Bearer not-a-token' -H 'content-type: application/json' -d '{}')
[ "$S" = "401" ] && ok "D2 bogus-token → 401" || bad "D2 expected 401, got $S"

ORG_TOKEN="$(token_for papercup-org)"
if [ -z "$ORG_TOKEN" ]; then bad "D-prep papercup-org token not found"; else
  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d '{"actionId":"d3-test-id","callingHarness":"sheets","action":{"op":"send_message","to":["sheets"],"kind":"X","subject":"x","reason":"D3 mismatch test should be rejected by middleware"}}')
  echo "$S" | jq -er '.error == "identity_mismatch"' >/dev/null 2>&1 && ok "D3 callingHarness mismatch → identity_mismatch" || bad "D3 unexpected: $S"

  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d '{"actionId":"d4-test-id","action":{"op":"send_message","to":["sheets"],"kind":"X","subject":"x","reason":"D4 from-mismatch test","from":"sheets"}}')
  echo "$S" | jq -er '.error == "identity_mismatch"' >/dev/null 2>&1 && ok "D4 from mismatch → identity_mismatch" || bad "D4 unexpected: $S"

  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d '{"actionId":"d5-test-id","action":{"op":"scaffold_harness","projectSlug":"d5-attempt","template":"papercup-coding","spec":"x","goal":"y","parent_slug":"attacker"}}')
  echo "$S" | jq -er '.error == "parent_slug_not_caller_controlled"' >/dev/null 2>&1 && ok "D5 body parent_slug → 400" || bad "D5 unexpected: $S"

  D6_ID=$(uuid)
  S=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$D6_ID\",\"action\":{\"op\":\"send_message\",\"to\":[\"sheets\"],\"kind\":\"X\",\"subject\":\"x\",\"reason\":\"asdf\"}}")
  echo "$S" | jq -er '.error == "validation_error"' >/dev/null 2>&1 && ok "D6 short reason → validation_error" || bad "D6 unexpected: $S"
fi

# ── Smoke C — tiered visibility + cross-harness messaging (substrate only) ──
note "Smoke C — tiered visibility + cross-harness messaging"

ORG_TOKEN="$(token_for papercup-org)"
BUS_TOKEN="$(token_for papercup-org-business)"
if [ -z "$ORG_TOKEN" ] || [ -z "$BUS_TOKEN" ]; then
  bad "C-prep tokens missing — papercup-org install may not be complete"
else
  # Send Priority message from parent → child
  ACT=$(uuid)
  R=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$ACT\",\"action\":{\"op\":\"send_message\",\"to\":[\"papercup-org-business\"],\"kind\":\"Priority\",\"subject\":\"smoke C: focus on auth\",\"reason\":\"smoke C: testing supervisor-channel from parent to child\"}}")
  echo "$R" | jq -er '.ok == true' >/dev/null && ok "C1 parent → child send_message accepted" || bad "C1 unexpected: $R"

  # Verify message landed in business inbox
  sleep 1
  MSG=$(curl -sS "$OPERATOR_BASE/api/harness/papercup-org-business/inbox?status=pending&limit=10" | jq -e '.messages[] | select(.from_slug=="papercup-org" and .subject == "smoke C: focus on auth")' 2>&1 | head -10)
  [ -n "$MSG" ] && ok "C2 message landed in child inbox" || bad "C2 missing: $MSG"

  # Tier 2 substrate context for parent
  if [ -f /home/marsh-office/papercupai-workspace/papercup/libs/papercusp/packages/orchestrator/src/tiered-context.ts ]; then
    cat > /tmp/smoke-tiered-parent.mjs <<EOFJ
import { fetchSubstrateContext } from '/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/packages/orchestrator/src/tiered-context.ts';
const ctx = await fetchSubstrateContext({ selfSlug: 'papercup-org', parentSlug: null });
process.stdout.write(ctx);
EOFJ
    P=$(node --experimental-strip-types /tmp/smoke-tiered-parent.mjs 2>/dev/null)
    echo "$P" | grep -q "## About Papercusp" && ok "C3 parent prompt has Tier 1 preamble" || bad "C3 missing preamble"
    echo "$P" | grep -q "Children (6)" && ok "C4 parent prompt has Children (6)" || bad "C4 missing 6 children: $(echo "$P" | grep Children | head -1)"
    echo "$P" | grep -q "Available read capabilities" && ok "C5 parent prompt has Tier 3 capabilities" || bad "C5 missing capabilities"
    LEN=$(echo -n "$P" | wc -c)
    [ "$LEN" -lt 4000 ] && ok "C6 parent substrate framing < 4000 chars (got $LEN)" || bad "C6 too large ($LEN)"
  fi

  # Tier 2 substrate context for child should show parent + 5 siblings
  cat > /tmp/smoke-tiered-child.mjs <<EOFJ
import { fetchSubstrateContext } from '/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/packages/orchestrator/src/tiered-context.ts';
const ctx = await fetchSubstrateContext({ selfSlug: 'papercup-org-business', parentSlug: 'papercup-org' });
process.stdout.write(ctx);
EOFJ
  C=$(node --experimental-strip-types /tmp/smoke-tiered-child.mjs 2>/dev/null)
  echo "$C" | grep -q "Parent: papercup-org" && ok "C7 child prompt has parent" || bad "C7 missing parent"
  echo "$C" | grep -q "Siblings (5" && ok "C8 child prompt has 5 siblings" || bad "C8 missing siblings: $(echo "$C" | grep Siblings | head -1)"

  # Bounded supervisor inbox should contain the Priority message
  echo "$C" | grep -q "smoke C: focus on auth" && ok "C9 child prompt has supervisor message in inbox" || bad "C9 missing supervisor msg"
fi

# ── Smoke A — papercup-org happy path (substrate-only; no full LLM run) ──
note "Smoke A — papercup-org happy path (no LLM, executes the verbs directly)"

ORG_TOKEN="$(token_for papercup-org)"
if [ -z "$ORG_TOKEN" ]; then
  bad "A-prep papercup-org token not found"
else
  # 1. Drop directive into parent inbox
  ACT=$(uuid)
  R=$(curl -sS -X POST "$OPERATOR_BASE/api/harness/papercup-org/messages" \
    -H 'content-type: application/json' \
    -d "{\"to\":[\"papercup-org\"],\"kind\":\"Directive\",\"subject\":\"smoke A: ship a hello-world page\",\"body\":\"single static index.html\",\"reason\":\"smoke A directive submission via user-curl wrapper\",\"actionId\":\"$ACT\"}")
  echo "$R" | jq -er '.ok == true' >/dev/null && ok "A1 directive landed via user-curl wrapper" || bad "A1 unexpected: $R"

  # 2. Director (simulated): emit spinup_project + scaffold_harness via direct executeAction
  ACT_SP=$(uuid)
  SPINUP=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    -d "{\"actionId\":\"$ACT_SP\",\"action\":{\"op\":\"spinup_project\",\"directiveId\":\"D-SMOKE-A\",\"projectName\":\"smoke A hello world\",\"projectVertical\":\"apps\",\"projectBudgetCents\":10000,\"departments\":[\"papercup-org-technology\"]}}")
  echo "$SPINUP" | jq -er '.ok == true' >/dev/null && ok "A2 spinup_project ok" || bad "A2 unexpected: $SPINUP"
  PROJ_ID=$(echo "$SPINUP" | jq -r '.result.projectId // empty')
  [ -n "$PROJ_ID" ] && ok "A2b projectId returned: $PROJ_ID" || bad "A2b no projectId"

  # 3. scaffold_harness for a child
  CHILD_SLUG="smoke-a-child-$(date +%s)"
  ACT_SC=$(uuid)
  SCAFFOLD=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_TOKEN" -H 'content-type: application/json' \
    --max-time 300 \
    -d "{\"actionId\":\"$ACT_SC\",\"action\":{\"op\":\"scaffold_harness\",\"projectSlug\":\"$CHILD_SLUG\",\"template\":\"papercup-coding\",\"spec\":\"# Hello World\\n\\nWrite a single static index.html file containing the text 'hello world'.\",\"goal\":\"Create one static HTML page.\"}}")
  echo "$SCAFFOLD" | jq -er '.ok == true' >/dev/null && ok "A3 scaffold_harness ok" || bad "A3 unexpected: $SCAFFOLD"

  # 4. Verify child appears in registry with parent_slug
  sleep 1
  CHILD_ROW=$(curl -sS "$OPERATOR_BASE/api/harness/projects?parent_slug=papercup-org" | jq -e ".projects[] | select(.slug == \"$CHILD_SLUG\")" 2>&1)
  [ -n "$CHILD_ROW" ] && ok "A4 child registered with parent_slug=papercup-org" || bad "A4 missing: $CHILD_ROW"

  # 5. Verify child PG schema
  CHILD_SCHEMA="harness_$(echo "$CHILD_SLUG" | tr '-' '_')"
  HAVE=$(PGUSER=postgres_app PGPASSWORD=postgres PGHOST=localhost PGDATABASE=papercusp psql -At -c \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='$CHILD_SCHEMA' AND table_name='messages'" 2>&1)
  [ "$HAVE" = "1" ] && ok "A5 child PG schema $CHILD_SCHEMA has messages table" || bad "A5 schema missing: $HAVE"

  # 6. Verify child has token
  CHILD_TOKEN="$(token_for "$CHILD_SLUG")"
  [ -n "$CHILD_TOKEN" ] && ok "A6 child has harness_token" || bad "A6 no token"

  # 7. Fire afterDone hook directly to simulate child completion (no LLM run needed)
  if [ -n "$CHILD_TOKEN" ]; then
    CHILD_PATH=$(curl -sS "$OPERATOR_BASE/api/harness/projects" | jq -r ".projects[] | select(.slug == \"$CHILD_SLUG\") | .path")
    if [ -d "$CHILD_PATH" ]; then
      cd "$CHILD_PATH"
      PROJECT_DIR="$CHILD_PATH" STATE_DIR="$CHILD_PATH/.harness" PAPERCUSP_OPERATOR_BASE="$OPERATOR_BASE" \
        bash /home/marsh-office/papercupai-workspace/papercup/libs/papercusp/packages/harness/hooks/builtins/afterDone.sh
      sleep 1
      DONE=$(curl -sS "$OPERATOR_BASE/api/harness/papercup-org/inbox?status=all" | jq -e ".messages[] | select(.from_slug == \"$CHILD_SLUG\" and .kind == \"Completion\")" 2>&1)
      [ -n "$DONE" ] && ok "A7 afterDone fired; Completion in parent inbox" || bad "A7 missing: $DONE"
    else
      bad "A7 child path doesn't exist on disk: $CHILD_PATH"
    fi
  fi
fi

# ── Smoke B — generic non-papercup-org harness spawns children ──
note "Smoke B — generic harness spawning"

# Pick a non-papercup-org harness with scaffold_harness allowedActions.
# `org` (the legacy ~/.restart-org) IS a generic harness with role configs.
# Verify it has the allowedAction; if not, we'd need to add it.
ORG_LEGACY_TOKEN="$(token_for org)"
if [ -z "$ORG_LEGACY_TOKEN" ]; then
  bad "B-prep no legacy 'org' token; can't run Smoke B"
else
  # Test that scaffold_harness from the legacy org token works.
  CHILD_B="smoke-b-child-$(date +%s)"
  ACT_B=$(uuid)
  SCAFFOLD_B=$(curl -sS -X POST "$OPERATOR_BASE/api/admin/execute-action" \
    -H "Authorization: Bearer $ORG_LEGACY_TOKEN" -H 'content-type: application/json' \
    --max-time 300 \
    -d "{\"actionId\":\"$ACT_B\",\"action\":{\"op\":\"scaffold_harness\",\"projectSlug\":\"$CHILD_B\",\"template\":\"coding-project\",\"spec\":\"# smoke b\\n\\nGeneric spawn test.\",\"goal\":\"Verify substrate is generic.\"}}")
  echo "$SCAFFOLD_B" | jq -er '.ok == true' >/dev/null && ok "B1 generic harness 'org' can spawn (scaffold_harness ok)" || bad "B1 unexpected: $SCAFFOLD_B"

  if echo "$SCAFFOLD_B" | jq -er '.ok == true' >/dev/null; then
    sleep 1
    PARENT=$(curl -sS "$OPERATOR_BASE/api/harness/projects?parent_slug=org" | jq -e ".projects[] | select(.slug == \"$CHILD_B\") | .parent_slug" 2>&1)
    [ "$PARENT" = "\"org\"" ] && ok "B2 child parent_slug=org" || bad "B2 unexpected parent_slug: $PARENT"
  fi
fi

# ── Summary ──
echo
echo "════ SUMMARY ════"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
printf '%s\n' "${results[@]}"
exit $FAIL
