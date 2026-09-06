#!/usr/bin/env bash
# Unit 5 live probe, part 2: sections C, D, G re-run with a REAL tab activation.
# Radix Tabs.Trigger activates on mousedown (not click), so probe.sh's synthetic
# `.click()` never switched tabs — this script dispatches mousedown+mouseup+click.
set -u
REPORT_DIR="${REPORT_DIR:-$HOME/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$REPORT_DIR/live-probe2-$STAMP.txt"
BASE="${BASE:-http://127.0.0.1:3081}"
WAIT_MS="${WAIT_MS:-5000}"
log() { printf '%s\n' "$*" | tee -a "$OUT"; }
js() { verdict js "$1" 2>&1 | head -c "${2:-900}"; }
goto() { verdict goto "$1" >/dev/null 2>&1 || log "goto-failed: $1"; verdict wait "$WAIT_MS" >/dev/null 2>&1; }
activate_tab() { verdict js "(()=>{const b=[...document.querySelectorAll('.pc-qp__tab')].find(t=>/$1/i.test(t.textContent));if(!b)return 'NO-TAB';for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){b.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type.endsWith('down')?1:0}))}return 'activated:'+b.textContent.trim()})()" 2>&1 | head -c 120; }
tabs_state='(()=>{const d=document.querySelector("section.shell-panel--quick");if(!d)return "NO-QUICK-DIALOG";return JSON.stringify({tabs:[...d.querySelectorAll(".pc-qp__tab")].map(t=>t.textContent.trim()+(t.getAttribute("data-state")==="active"?"*":"")),pane:!!d.querySelector(".pc-qp__brainstorm"),bsbar:!!d.querySelector(".pc-qp__bsbar"),iframe:(f=>f?{src:f.getAttribute("src"),w:f.clientWidth,h:f.clientHeight}:null)(d.querySelector("iframe")),empty:[...d.querySelectorAll(".pc-qp__empty")].map(e=>e.textContent.trim().slice(0,80))})})()'

log "PROBE2_START $STAMP base=$BASE"
PID=$(ss -ltnpH 'sport = :3801' | grep -oP 'pid=\K[0-9]+' | head -1)
log "backend-3801 pid=$PID release=$(readlink /proc/$PID/cwd 2>/dev/null | grep -o 'releases/[^/]*')"

log "=== C' brainstorm tab mounts via real mousedown; its key is qp-prefixed (D-003)"
goto "$BASE/?app=home&panel=quick"
log "activate: $(activate_tab Brainstorm)"
verdict wait 4000 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "state: $(js "$tabs_state")"
verdict screenshot "$REPORT_DIR/screenshot-panel-brainstorm.png" >/dev/null 2>&1 && log "screenshot: $REPORT_DIR/screenshot-panel-brainstorm.png"

log "=== D' docs tab: iframe on this origin (D-004)"
log "activate: $(activate_tab Docs)"
verdict wait 4000 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "state: $(js "$tabs_state")"
log "iframe-doc: $(js '(()=>{const f=document.querySelector("section.shell-panel--quick iframe");if(!f)return "NO-IFRAME";try{const d=f.contentDocument;return JSON.stringify({sameOrigin:!!d,title:d&&d.title,hasSearch:!!(d&&d.querySelector("input,[type=search],.pagefind-ui__search-input")),ready:d&&d.readyState})}catch(e){return "ERR:"+e.message}})()')"
verdict screenshot "$REPORT_DIR/screenshot-panel-docs.png" >/dev/null 2>&1 && log "screenshot: $REPORT_DIR/screenshot-panel-docs.png"

log "=== D'' deep link with qptab=docs opens straight on the docs tab"
goto "$BASE/?app=home&panel=quick&qptab=docs"
log "url: $(verdict url 2>&1)"
log "state: $(js "$tabs_state")"

log "=== G' no key collision: dev console keeps tab=pg while the palette switches to Brainstorm (D-003)"
goto "$BASE/?app=dev&tab=pg&panel=quick"
log "activate: $(activate_tab Brainstorm)"
verdict wait 3000 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "state: $(js "$tabs_state")"
log "dev-active: $(js 'JSON.stringify([...document.querySelectorAll(".pc-dev-tab.is-active,[role=tab][aria-selected=true]")].map(e=>e.textContent.trim().slice(0,30)))')"

log "=== console (errors)"
verdict console 2>&1 | grep -iE 'error|uncaught' | head -10 | tee -a "$OUT" >/dev/null
log "PROBE2_END $(date -u +%Y%m%dT%H%M%SZ)"
echo "EVIDENCE=$OUT"
