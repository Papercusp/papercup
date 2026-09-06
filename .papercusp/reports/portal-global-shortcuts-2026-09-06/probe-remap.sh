#!/usr/bin/env bash
# Unit 6 live remap probe (rubric criterion R-7 / D-001): a combo saved on the portal's
# Settings › Keyboard shortcuts pane applies on :3081 after a full reload, and the default
# stops firing. Real key events via the verdict daemon (CDP). mod = Control on Linux headless.
# Rows: N0 control (default fires with no override) · N1 record mod+shift+o via the pane's
# Record button · N2 persisted in localStorage · N3 new chord fires after reload · N4 default
# no longer fires · N5 Reset restores the default. Every expectation is stated on its row.
set -u
REPORT_DIR="${REPORT_DIR:-$HOME/papercupai-workspace/papercusp/.papercusp/reports/portal-global-shortcuts-2026-09-06}"
mkdir -p "$REPORT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$REPORT_DIR/live-remap-$STAMP.txt"
BASE="${BASE:-http://127.0.0.1:3081}"
MOD="${MOD:-Control}"
KEY='pc:ws:default:papercusp.shortcuts.v1'
log() { printf '%s\n' "$*" | tee -a "$OUT"; }
js() { verdict js "$1" 2>&1 | head -c "${2:-400}"; }
url() { verdict url 2>&1 | tr -d '\n' | head -c 160; }
press() { verdict press "$1" >/dev/null 2>&1 || log "press-failed: $1"; verdict wait "${2:-2000}" >/dev/null 2>&1; }
goto() { verdict goto "$1" >/dev/null 2>&1 || log "goto-failed: $1"; verdict wait "${2:-5000}" >/dev/null 2>&1; }
focus_body() { verdict js 'if(document.activeElement)document.activeElement.blur();document.body.focus();"ok"' >/dev/null 2>&1; }
storage() { js "(()=>{const v=localStorage.getItem('$KEY');return JSON.stringify({key:'$KEY',val:v})})()"; }
SEL='input[aria-label="Combo for Open settings"]'

log "REMAP_PROBE_START $STAMP base=$BASE mod=$MOD"
PID=$(ss -ltnpH 'sport = :3801' | grep -oP 'pid=\K[0-9]+' | head -1)
log "origin-3801 pid=$PID release=$(readlink /proc/$PID/cwd 2>/dev/null | grep -o 'releases/[^/]*')"

goto "$BASE/?app=home"
log "N0 clear any override: $(js "localStorage.removeItem('$KEY');'cleared'")"
goto "$BASE/?app=home"; focus_body
press "$MOD+Comma"; log "N0 CONTROL default chord, no override (expect ?app=settings): $(url)"

goto "$BASE/?app=settings&settings=shortcuts" 8000
log "N1 pane: inputs=$(js 'document.querySelectorAll(".kbd-settings-input").length') value=$(js "document.querySelector('$SEL')?.value")"
js "(()=>{const i=document.querySelector('$SEL');const b=i&&i.parentElement.querySelector('button.kbd-settings-record');if(!b)return 'no-record-button';b.click();return 'recording'})()" >/dev/null
verdict wait 800 >/dev/null 2>&1
press "$MOD+Shift+o" 1500
log "N1 recorded (expect mod+shift+o, customized pill): value=$(js "document.querySelector('$SEL')?.value") pill=$(js "String(!!document.querySelector('$SEL')?.closest('.kbd-settings-row')?.querySelector('.kbd-settings-row-pill'))")"
log "N2 persisted (expect settings.open → mod+shift+o): $(storage)"

goto "$BASE/?app=home"; focus_body
press "$MOD+Shift+o"; log "N3 new chord after reload (expect ?app=settings): $(url)"
goto "$BASE/?app=home"; focus_body
press "$MOD+Comma"; log "N4 default with override (expect UNCHANGED ?app=home): $(url)"

goto "$BASE/?app=settings&settings=shortcuts" 8000
js "(()=>{const i=document.querySelector('$SEL');const b=i&&i.parentElement.querySelector('button.kbd-settings-reset');if(!b)return 'no-reset-button';b.click();return 'reset'})()" >/dev/null
verdict wait 1000 >/dev/null 2>&1
log "N5 reset (expect mod+comma, no override): value=$(js "document.querySelector('$SEL')?.value") $(storage)"
goto "$BASE/?app=home"; focus_body
press "$MOD+Comma"; log "N5 default restored (expect ?app=settings): $(url)"

log "console: $(verdict console 2>&1 | tail -5 | tr '\n' ' ' | head -c 400)"
log "REMAP_PROBE_END $(date -u +%Y%m%dT%H%M%SZ)"
