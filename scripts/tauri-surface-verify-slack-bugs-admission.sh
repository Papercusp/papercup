#!/usr/bin/env bash
# scripts/tauri-surface-verify-slack-bugs-admission.sh
# slack-messages-to-bug-reports-2026-10-05 P-008 (spec AUTO-BAR-R-8-P-008@2, D-011):
# boot the desktop shell headlessly against fixture admissions, read the per-channel
# Slack-bugs counts on /admin/admission, then write one more admission behind the
# page's back and require it to arrive without a reload (work_admissions trigger ->
# sync bridge -> admission.chatBugs refetch).
#
# WRITES to the database, so it refuses to run against anything but the verifier's
# throwaway isolated Postgres. Run it exactly like this (the two freshness guards are
# required: the first run of this check tested a bundle built before the edit):
#
#   VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
#   VERIFY_TAURI_REQUIRE_BUILT=apps/operator/app/admin/admission/ChatBugsHealth.tsx,apps/operator/app/admin/admission/page.tsx,apps/operator-vite/src/routes/admin/admission.tsx \
#   VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='Slack bug reports' \
#     scripts/verify-tauri-headless.sh -- bash scripts/tauri-surface-verify-slack-bugs-admission.sh
#
# Rows are compared as parsed JSON values, never as text: tauri-agent-tools eval may
# print the result pretty-printed or as a JSON string, and a text comparison then
# fails on rows that are in fact correct (the second run of this check did exactly that).
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"
: "${HARNESS_ADMIN_DATABASE_URL:?missing HARNESS_ADMIN_DATABASE_URL — run with VERIFY_TAURI_ISOLATED_DB=1}"
: "${PAPERCUSP_WORKSPACE_ID:?missing PAPERCUSP_WORKSPACE_ID}"
case "$PAPERCUSP_WORKSPACE_ID" in
  verify-tauri-isolated-*) ;;
  *) echo "SLACKBUGS_FAIL refusing: workspace '$PAPERCUSP_WORKSPACE_ID' is not a verifier-isolated workspace" >&2; exit 2 ;;
esac
command -v jq >/dev/null 2>&1 || { echo "SLACKBUGS_FAIL jq is required" >&2; exit 2; }

TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$TOOL" >/dev/null 2>&1 || TOOL="tauri-agent-tools"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${SLACKBUGS_OUT:-/tmp/slack-bugs-admission-$STAMP}"
mkdir -p "$OUT"
SLACK_VERIFY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SLACK_VERIFY_ROOT/libs/generic/verification-harness/bin/vh.sh"
vh_phase seed ""
vh_phase initial seed
vh_phase live-update initial
vh_init slack-bugs-admission "$OUT/harness"
vh_bracket_trap
vh_begin seed
WS="$PAPERCUSP_WORKSPACE_ID"

q() { psql "$HARNESS_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "$1"; }

# Normalize one JSON value to compact form. A result that is a JSON STRING holding
# JSON (eval returning JSON.stringify output verbatim) is decoded first. Non-JSON
# input normalizes to the empty string, which never equals an expected value.
norm() { jq -c 'if type == "string" then (try fromjson catch .) else . end' 2>/dev/null || true; }
same_json() { [ -n "$1" ] && [ "$(printf '%s' "$1" | norm)" = "$(printf '%s' "$2" | norm)" ]; }

echo "SLACKBUGS workspace=$WS out=$OUT"
DS=$(q "INSERT INTO harness_shared.data_sources (workspace_id, kind, status, provider_account_id) VALUES ('$WS', 'slack', 'connected', 'T-E2E') RETURNING id" | head -1)
echo "SLACKBUGS data_source=$DS"
q "INSERT INTO harness_shared.admission_rules (workspace_id, data_source_id, source_kind, title, match, harness_slug, work_kind, enabled, created_by)
   VALUES ('$WS', '$DS', 'chat-thread', 'bugs', '{\"channelId\":{\"eq\":\"CE2EBUGS\"}}', 'papercusp', 'bug', true, 'slack-bugs-e2e'),
          ('$WS', '$DS', 'chat-thread', 'quiet', '{\"channelId\":{\"eq\":\"CE2EQUIET\"}}', 'papercusp', 'bug', true, 'slack-bugs-e2e')" >/dev/null
adm() { # channel n outcome
  q "INSERT INTO harness_shared.work_admissions (workspace_id, work_item_id, harness_slug, data_source_id, source_kind, source_key, admitted_via, admitted_by, outcome)
     VALUES ('$WS', 'WI-slackbugs-e2e-$1-$2', 'papercusp', '$DS', 'chat-thread', '$DS:$1:thread:$2', 'person', 'slack-bugs-e2e', '$3')" >/dev/null
}
adm CE2EBUGS 1 created
adm CE2EBUGS 2 created
adm CE2EBUGS 3 folded
adm CE2ENORULE 1 created

"$TOOL" eval --pid "$VERIFY_TAURI_PID" "window.__TSR_ROUTER__?.navigate({ to: '/admin/admission' }); 'nav'" >/dev/null

READ_JS='(() => { const s = document.querySelector("section[aria-label=\"Slack bug reports\"]"); if (!s) return "NO_SECTION"; return JSON.stringify([...s.querySelectorAll("[data-channel]")].map(el => [...el.closest("tr").querySelectorAll("td")].map(td => td.textContent))); })()'

wait_for() { # expected-json label
  local got=""
  for _ in $(seq 1 45); do
    got=$("$TOOL" eval --pid "$VERIFY_TAURI_PID" "$READ_JS" 2>/dev/null || true)
    if same_json "$got" "$1"; then
      echo "SLACKBUGS PASS $2: $(printf '%s' "$got" | norm)"
      printf '%s\n' "$got" | norm >"$OUT/rows-$2.json"
      return 0
    fi
    sleep 2
  done
  echo "SLACKBUGS FAIL $2: expected $(printf '%s' "$1" | norm) got $(printf '%s' "$got" | norm || true) raw=$got" >&2
  return 1
}

EXPECT='[["T-E2E","CE2EBUGS","2","1","0","0","—","—"],["T-E2E","CE2EQUIET","0","0","0","0","—","—"],["T-E2E","CE2ENORULE (no rule)","1","0","0","0","—","—"]]'
vh_begin initial
wait_for "$EXPECT" initial || exit 1
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT/admission-initial.png" >/dev/null 2>&1 || echo "SLACKBUGS note: screenshot not captured"

vh_begin live-update
adm CE2EBUGS 4 created
EXPECT2='[["T-E2E","CE2EBUGS","3","1","0","0","—","—"],["T-E2E","CE2EQUIET","0","0","0","0","—","—"],["T-E2E","CE2ENORULE (no rule)","1","0","0","0","—","—"]]'
wait_for "$EXPECT2" live-update || exit 1
"$TOOL" screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT/admission-live-update.png" >/dev/null 2>&1 || true
echo "SLACKBUGS E2E OK"
