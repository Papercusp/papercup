#!/usr/bin/env bash
# Unit 6 live probe: the operator's global keyboard shortcuts on the cloud portal (:3081)
# (plan portal-global-shortcuts-2026-09-06 P-005; D-001 registry ids on the bus, D-002 panel.quick,
# D-003 host-navigation ids bound by the portal, D-004 voice ids inert / cheat-sheet CSS travels).
# Real key events via the verdict daemon (CDP), so preventDefault + browser defaults are exercised.
set -u
REPORT_DIR="${REPORT_DIR:-$HOME/papercupai-workspace/papercusp/.papercusp/reports/portal-global-shortcuts-2026-09-06}"
mkdir -p "$REPORT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$REPORT_DIR/live-probe-$STAMP.txt"
BASE="${BASE:-http://127.0.0.1:3081}"
MOD="${MOD:-Control}"          # headless Chromium on Linux: mod = Control
WAIT_MS="${WAIT_MS:-5000}"
log() { printf '%s\n' "$*" | tee -a "$OUT"; }
js() { verdict js "$1" 2>&1 | head -c "${2:-700}"; }
url() { verdict url 2>&1 | tr -d '\n' | head -c 200; }
press() { verdict press "$1" >/dev/null 2>&1 || log "press-failed: $1"; verdict wait "${2:-1200}" >/dev/null 2>&1; }
goto() { verdict goto "$1" >/dev/null 2>&1 || log "goto-failed: $1"; verdict wait "$WAIT_MS" >/dev/null 2>&1; }
focus_body() { verdict js 'if(document.activeElement)document.activeElement.blur();document.body.focus();"ok"' >/dev/null 2>&1; }
shot() { verdict screenshot "$REPORT_DIR/$1" >/dev/null 2>&1 && log "screenshot: $REPORT_DIR/$1"; }
state='(()=>JSON.stringify({q:location.search,cheat:!!document.querySelector(".kbd-cheat"),find:!!document.querySelector(".pc-find"),gsearch:!!document.querySelector("[aria-label=\"Search everywhere\"]"),quick:!!document.querySelector("section.shell-panel--quick"),dialogs:document.querySelectorAll("[role=dialog]").length,focus:document.activeElement?document.activeElement.tagName:null}))()'

log "PROBE_START $STAMP base=$BASE mod=$MOD"
PID=$(ss -ltnpH 'sport = :3801' | grep -oP 'pid=\K[0-9]+' | head -1)
log "backend-3801 pid=$PID release=$(readlink /proc/$PID/cwd 2>/dev/null | grep -o 'releases/[^/]*')"
log "health-3081: $(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/health")"

goto "$BASE/?app=home"
log "S0 home: $(js "$state")"

log "=== B shift+/ opens the cheat sheet (.kbd-cheat); Escape closes it"
focus_body; press "Shift+Slash" 1500
log "B open: $(js "$state")"
log "B rows: $(js '(()=>{const d=document.querySelector(".kbd-cheat");if(!d)return "NO-CHEAT";const t=d.textContent;return JSON.stringify({label:d.getAttribute("aria-label"),keys:d.querySelectorAll("kbd").length,quickPanel:/quick panel/i.test(t),settings:/settings/i.test(t),bg:getComputedStyle(d).backgroundColor,pos:getComputedStyle(d).position})})()')"
shot screenshot-cheat-sheet.png
press Escape 1200
log "B esc: $(js "$state")"

log "=== C mod+comma → Settings surface"
focus_body; press "$MOD+Comma" 2000
log "C url: $(url)"

log "=== D g > b sequence → Brainstorm"
goto "$BASE/?app=home"; focus_body; press "g" 250; press "b" 2000
log "D url: $(url)"

log "=== E mod+f → find bar (.pc-find); Escape closes"
goto "$BASE/?app=home"; focus_body; press "$MOD+f" 1500
log "E open: $(js "$state")"
shot screenshot-find-bar.png
press Escape 1000
log "E esc: $(js "$state")"

log "=== F mod+shift+f → global search dialog; Escape closes"
focus_body; press "$MOD+Shift+f" 1500
log "F open: $(js "$state")"
shot screenshot-global-search.png
press Escape 1000
log "F esc: $(js "$state")"

log "=== G mod+k / mod+p toggle the launcher panel (one exclusive slot)"
focus_body; press "$MOD+k" 1500; log "G mod+k: $(url)"
press "$MOD+k" 1500; log "G mod+k again: $(url)"
press "$MOD+p" 1500; log "G mod+p: $(url)"
press "$MOD+p" 1500; log "G mod+p again: $(url)"

log "=== H mod+j toggles the quick panel; from the launcher it SWITCHES"
press "$MOD+j" 2000; log "H mod+j: $(url) quick=$(js 'String(!!document.querySelector("section.shell-panel--quick"))')"
press "$MOD+j" 1500; log "H mod+j again: $(url)"
press "$MOD+k" 1500; log "H mod+k: $(url)"
press "$MOD+j" 1500; log "H switch mod+j: $(url)"
press Escape 1000; log "H esc: $(url)"

log "=== I alt+ArrowDown / alt+ArrowUp cycle the visible rail"
goto "$BASE/?app=home"; focus_body
log "I rail: $(js '(()=>JSON.stringify([...document.querySelectorAll("nav [data-app], nav a[href*=\"app=\"], .rail [data-kind]")].slice(0,12).map(e=>e.getAttribute("data-app")||e.getAttribute("data-kind")||e.getAttribute("href"))))()')"
press "Alt+ArrowDown" 1500; log "I down: $(url)"
press "Alt+ArrowDown" 1500; log "I down2: $(url)"
press "Alt+ArrowUp" 1500; log "I up: $(url)"

log "=== J mod+i → Inbox"
focus_body; press "$MOD+i" 2000; log "J url: $(url)"

log "=== K mod+u toggles the agents panel"
press "$MOD+u" 1500; log "K mod+u: $(url)"
press "$MOD+u" 1500; log "K mod+u again: $(url)"

log "=== L alt+ArrowLeft → history back (navigation.back)"
goto "$BASE/?app=home"; press "$MOD+Comma" 1500; log "L before: $(url)"
press "Alt+ArrowLeft" 2000; log "L back: $(url)"

log "=== M mod+shift+n → Overview + create=1 (harness.create root fallback)"
goto "$BASE/?app=home"; focus_body; press "$MOD+Shift+n" 2000; log "M url: $(url)"
shot screenshot-create-pot.png

log "=== console"
verdict console 2>&1 | tail -15 | tee -a "$OUT"
log "PROBE_END $(date -u +%Y%m%dT%H%M%SZ)"
