#!/usr/bin/env bash
# P-010 (WI-10004023) live check of R-26 / R-40 / R-41 in the headless Tauri shell.
# Re-run from the repo root:
#   VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
#   VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='remote-access-entry-actions' \
#   scripts/verify-tauri-headless.sh -- bash docs/evidence/p010-remote-access-live-2026-09-30/p010-headless-assert.sh
set -uo pipefail
OUT="${P010_OUT:-${TMPDIR:-/tmp}/p010-headless-$$}"
mkdir -p "$OUT"
PID="$VERIFY_TAURI_PID"
FAIL=0
log() { echo "P010 $*"; }
bad() { echo "P010_FAIL $*"; FAIL=1; }
ev() { tauri-agent-tools eval --pid "$PID" "$1" 2>>"$OUT/eval.err"; }
# Normalize eval output: strip one layer of JSON string quoting if present.
evs() { local v; v="$(ev "$1")"; if [[ "$v" == \"*\" ]]; then printf '%s' "$v" | jq -r . 2>/dev/null || printf '%s' "$v"; else printf '%s' "$v"; fi; }
wait_true() { local expr="$1" t="${2:-60}" i=0; while [ "$i" -lt "$t" ]; do [ "$(evs "$expr")" = "true" ] && return 0; sleep 1; i=$((i + 1)); done; return 1; }
# Run an async JS body in the webview; its return value lands in window.__p010[name] as JSON.
async_js() {
  local name="$1" body="$2" v i=0
  ev "(window.__p010=window.__p010||{}, window.__p010['$name']='', (async()=>{ $body })().then(v=>{window.__p010['$name']=JSON.stringify({ok:true,v})}).catch(e=>{window.__p010['$name']=JSON.stringify({ok:false,e:String(e)})}), 'started')" >/dev/null
  while [ "$i" -lt 60 ]; do
    v="$(evs "window.__p010['$name'] || ''")"
    if [ -n "$v" ] && [ "$v" != "null" ] && [ "$v" != "undefined" ]; then printf '%s' "$v"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  echo '{"ok":false,"e":"timeout"}'; return 1
}

log "pid=$PID display=${VERIFY_TAURI_DISPLAY:-} devport=${VERIFY_TAURI_PORT:-} seed=${VERIFY_TAURI_SEED:-}"

# --- the sidecar's own HTTP listener: the address an outside app calls ---------------------
# The verifier's sidecar serves /api on the dev URL (OPERATOR_DEV_PORT). Do not discover it by
# pid: the sidecar's workers carry PORT=0 (EI-24686357322684790).
API="$VERIFY_TAURI_DEV_URL"
code="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/health")"
[ "$code" = "200" ] || bad "sidecar /api/health at $API returned $code"
log "api=$API health=$code"

# --- open Settings -> Remote access ---------------------------------------------------------
ev "window.location.assign('/settings/remote-access')" >/dev/null
wait_true "!!document.querySelector('[data-testid=remote-access-state]')" 90 || bad "remote-access page did not render"
WS="$(evs "new URLSearchParams(location.search).get('ws') || ''")"
if [ -z "$WS" ]; then
  WS="$(async_js ws "const r = await fetch('/api/workspaces'); const b = await r.json(); return b.current ?? b.workspaces?.[0]?.id ?? 'default';" | jq -r '.v')"
fi
log "workspace=$WS url=$(evs 'location.href')"

# --- three app keys (the same POST the Connect-an-app wizard makes, same origin) -------------
mk() { async_js "mk_$1" "const r = await fetch('/api/connected-apps', {method:'POST', cache:'no-store', headers:{'content-type':'application/json'}, body: JSON.stringify({label:'$1', workspaceId:'$WS', kind:'app', tools:[]})}); const j = await r.json(); return {status:r.status, key:j.key, id:j.id ?? j.app?.id ?? null};"; }
KA_J="$(mk p010-app-A)"; KB_J="$(mk p010-app-B)"; KC_J="$(mk p010-app-C)"
KA="$(jq -r '.v.key' <<<"$KA_J")"; KB="$(jq -r '.v.key' <<<"$KB_J")"; KC="$(jq -r '.v.key' <<<"$KC_J")"
for k in "$KA" "$KB" "$KC"; do [[ "$k" == pca* ]] || bad "key not issued: $KA_J $KB_J $KC_J"; done
log "keys issued: ${KA:0:18}… ${KB:0:18}… ${KC:0:18}…"

# --- one paired phone: mint on the desktop, claim as the phone would -------------------------
PT_J="$(async_js mint "const r = await fetch('/api/device/desktop/mint-pair-token', {method:'POST', cache:'no-store', headers:{'content-type':'application/json'}, body: JSON.stringify({workspaceId:'$WS'})}); return await r.json();")"
PTOK="$(jq -r '.v.pairToken // .v.qrPayload.pairToken // empty' <<<"$PT_J")"
PAIR_CODE="$(curl -s -o "$OUT/pair.body" -w '%{http_code}' -X POST "$API/api/device/pair" -H 'content-type: application/json' --data "{\"pairToken\":\"$PTOK\"}")"
log "phone pair: mint=$(jq -c '.ok' <<<"$PT_J") claim=$PAIR_CODE"
[ "$PAIR_CODE" = "200" ] || bad "phone pairing claim returned $PAIR_CODE: $(head -c 300 "$OUT/pair.body")"

# --- R-26: the list shows every app and device with pause / rotate / revoke -----------------
# No reload: the list is sync-backed, so wait for it to converge on the database's row count.
db_rows() { psql "$HARNESS_ADMIN_DATABASE_URL" -At -c "SELECT count(*) FROM harness_shared.connected_apps WHERE workspace_id='$WS' AND kind IN ('mobile','app','service') AND revoked_at IS NULL" 2>&1; }
i=0; CONVERGED=0
while [ "$i" -lt 60 ]; do
  want="$(db_rows)"; have="$(evs "String(document.querySelectorAll('[data-testid=remote-access-entry]').length)")"
  if [ "$have" = "$want" ] && [ "$have" -ge 4 ] 2>/dev/null; then CONVERGED=1; break; fi
  sleep 1; i=$((i + 1))
done
log "R26 converged=$CONVERGED after ${i}s (ui=$have db=$want)"
[ "$CONVERGED" = 1 ] || bad "R-26 list did not converge on the database (ui=$have db=$want)"
ENTRIES="$(evs "JSON.stringify([...document.querySelectorAll('[data-testid=remote-access-entry]')].map(li => ({id: li.dataset.entryId, kind: li.dataset.kind, text: li.innerText.replace(/\\s+/g,' ').slice(0,220), pause: !!li.querySelector('[data-action=pause]'), rotate: !!li.querySelector('[data-action=rotate]'), revoke: !!li.querySelector('[data-action=revoke]')})))")"
printf '%s\n' "$ENTRIES" >"$OUT/r26-entries.json"
DB_ROWS="$(db_rows)"
N_UI="$(jq 'length' <<<"$ENTRIES")"
N_CTRL="$(jq '[.[] | select(.pause and .rotate and .revoke)] | length' <<<"$ENTRIES")"
N_MOBILE="$(jq '[.[] | select(.kind=="mobile")] | length' <<<"$ENTRIES")"
N_APPS="$(jq '[.[] | select(.kind=="app")] | length' <<<"$ENTRIES")"
N_CREATOR="$(jq '[.[] | select(.text | test("Added by .+ last used"))] | length' <<<"$ENTRIES")"
log "R26 ui_entries=$N_UI db_rows=$DB_ROWS with_all_controls=$N_CTRL mobile=$N_MOBILE apps=$N_APPS creator_and_last_use=$N_CREATOR"
[ "$N_UI" = "$DB_ROWS" ] && [ "$N_CTRL" = "$N_UI" ] && [ "$N_MOBILE" -ge 1 ] && [ "$N_APPS" -ge 3 ] && [ "$N_CREATOR" = "$N_UI" ] \
  && echo "P010_R26_RESULT verdict=pass entries=$N_UI db=$DB_ROWS" || bad "R26 entries=$N_UI db=$DB_ROWS controls=$N_CTRL mobile=$N_MOBILE apps=$N_APPS creator=$N_CREATOR"
tauri-agent-tools dom --pid "$PID" '[data-testid=remote-access-page]' >"$OUT/r26-dom.txt" 2>&1 || true
DISPLAY="$VERIFY_TAURI_DISPLAY" import -window root "$OUT/r26-screen.png" 2>>"$OUT/eval.err" || true
# Layout in the real webview: an entry's controls must not overlap its label and must stay inside the row.
LAYOUT="$(evs "JSON.stringify([...document.querySelectorAll('[data-testid=remote-access-entry]')].map(li => { const t = li.querySelector('[data-testid=remote-access-entry-row] > div:first-child').getBoundingClientRect(); const a = li.querySelector('[data-testid=remote-access-entry-actions]').getBoundingClientRect(); const r = li.getBoundingClientRect(); const overlap = !(a.right <= t.left || a.left >= t.right || a.bottom <= t.top || a.top >= t.bottom); const clipped = [...li.querySelectorAll('[data-testid=remote-access-entry-actions] button')].some(b => { const q = b.getBoundingClientRect(); return q.right > r.right + 0.5 || q.left < r.left - 0.5; }); return {id: li.dataset.entryId, width: Math.round(r.width), overlap, clipped}; }))")"
printf '%s\n' "$LAYOUT" >"$OUT/r26-layout.json"
N_BADLAYOUT="$(jq '[.[] | select(.overlap or .clipped)] | length' <<<"$LAYOUT" 2>/dev/null || echo parse-error)"
log "R26 layout rows=$(jq length <<<"$LAYOUT" 2>/dev/null) overlapping_or_clipped=$N_BADLAYOUT widths=$(jq -c '[.[].width] | unique' <<<"$LAYOUT" 2>/dev/null)"
[ "$N_BADLAYOUT" = "0" ] && echo "P010_R26_LAYOUT verdict=pass" || bad "R26 layout: $N_BADLAYOUT entries overlap or clip their controls: $LAYOUT"
ev "document.querySelector('[data-testid=remote-access-entry]').scrollIntoView({block:'start'}), 'ok'" >/dev/null; sleep 1
DISPLAY="$VERIFY_TAURI_DISPLAY" import -window root "$OUT/r26-list-screen.png" 2>>"$OUT/eval.err" || true

# --- a call with each key, the way an outside MCP client makes it --------------------------
mcp() {
  curl -s -o "$OUT/$2.body" -D "$OUT/$2.hdr" -w '%{http_code}' -X POST "$API/api/mcp" \
    -H "authorization: Bearer $1" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p010-verify","version":"1"}}}'
}
code_of() { jq -r '.code // empty' "$OUT/$1.body" 2>/dev/null; }
named() { curl -s -o "$OUT/$2.body" -w '%{http_code}' "$API/api/admin/tasks/inventory" -H "authorization: Bearer $1"; }
A0="$(mcp "$KA" a-before)"; B0="$(mcp "$KB" b-before)"; C0="$(mcp "$KC" c-before)"
log "baseline mcp: A=$A0 B=$B0 C=$C0"
[ "$A0" = "200" ] && [ "$B0" = "200" ] && [ "$C0" = "200" ] || bad "baseline keys did not authenticate: A=$A0 B=$B0 C=$C0 ($(head -c 200 "$OUT/a-before.body"))"

# --- R-40: revoke key A with the screen's Revoke button and its confirmation ----------------
AID="$(jq -r '[.[] | select(.text | startswith("p010-app-A"))][0].id' <<<"$ENTRIES")"
tauri-agent-tools click --pid "$PID" "[data-entry-id=\"$AID\"] [data-action=revoke]" >/dev/null 2>>"$OUT/eval.err"
wait_true "[...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].some(b => b.innerText.trim() === 'Revoke')" 20 || bad "R40 confirmation did not open"
ev "[...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].find(b => b.innerText.trim() === 'Revoke').click(), 'clicked'" >/dev/null
wait_true "!document.querySelector('[data-entry-id=\"$AID\"]')" 30 || bad "R40 revoked entry still listed"
A1="$(mcp "$KA" a-after-revoke)"; B1="$(mcp "$KB" b-after-revoke)"; AN="$(named "$KA" a-after-revoke-named)"
log "after revoke: A=$A1 code=$(code_of a-after-revoke) named=$AN $(head -c 160 "$OUT/a-after-revoke-named.body") | B=$B1"
[ "$A1" = "401" ] && [ "$(code_of a-after-revoke)" = "connected_app_invalid_key:revoked" ] && [ "$B1" = "200" ] \
  && echo "P010_R40_RESULT verdict=pass status=$A1 code=$(code_of a-after-revoke) control_B=$B1" || bad "R40 A=$A1 code=$(code_of a-after-revoke) B=$B1"

# --- R-41: turn remote access off on the screen; both remaining keys are refused ------------
[ "$(evs "document.querySelector('[data-testid=remote-access-state]').dataset.enabled")" = "true" ] || bad "R41 switch not on before the test"
tauri-agent-tools click --pid "$PID" '[data-testid=remote-access-toggle]' >/dev/null 2>>"$OUT/eval.err"
wait_true "document.querySelector('[data-testid=remote-access-state]').dataset.enabled === 'false'" 30 || bad "R41 switch did not turn off"
DISPLAY="$VERIFY_TAURI_DISPLAY" import -window root "$OUT/r41-off-screen.png" 2>>"$OUT/eval.err" || true
B2="$(mcp "$KB" b-off)"; C2="$(mcp "$KC" c-off)"; BN="$(named "$KB" b-off-named)"
log "switch off: B=$B2 code=$(code_of b-off) | C=$C2 code=$(code_of c-off) | B named=$BN $(head -c 160 "$OUT/b-off-named.body")"
[ "$B2" = "401" ] && [ "$C2" = "401" ] && [ "$(code_of b-off)" = "connected_app_invalid_key:remote_access_off" ] && [ "$(code_of c-off)" = "connected_app_invalid_key:remote_access_off" ] \
  && echo "P010_R41_RESULT verdict=pass B=$B2:$(code_of b-off) C=$C2:$(code_of c-off)" || bad "R41 B=$B2:$(code_of b-off) C=$C2:$(code_of c-off)"

# --- control: turning it back on restores the keys (the switch, not a side effect, refused them)
tauri-agent-tools click --pid "$PID" '[data-testid=remote-access-toggle]' >/dev/null 2>>"$OUT/eval.err"
wait_true "document.querySelector('[data-testid=remote-access-state]').dataset.enabled === 'true'" 30 || bad "switch did not turn back on"
B3="$(mcp "$KB" b-on-again)"; A3="$(mcp "$KA" a-on-again)"
log "switch on again: B=$B3 (expect 200) A=$A3 code=$(code_of a-on-again) (expect revoked)"
[ "$B3" = "200" ] && [ "$(code_of a-on-again)" = "connected_app_invalid_key:revoked" ] || bad "control B=$B3 A=$A3"

echo "P010_HEADLESS_DONE fail=$FAIL out=$OUT"
exit "$FAIL"
