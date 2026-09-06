#!/usr/bin/env bash
# Unit 4 live re-probe: portal deep links keep DEV `tab` and Cloud `step` across the operator bridge
# (plan portal-deep-link-tab-step-2026-09-06 D-003 pin rule / D-004 keep selection). Drives the
# :3081 portal with the verdict daemon and writes one evidence file.
set -u
OUT_DIR="${OUT_DIR:-$HOME/papercupai-workspace/papercusp/.papercusp/scratch/e8071-parity-u4}"
mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$OUT_DIR/probe-$STAMP.txt"
BASE="${BASE:-http://127.0.0.1:3081}"
WAIT_MS="${WAIT_MS:-4000}"

log() { printf '%s\n' "$*" | tee -a "$OUT"; }
active_js='Array.from(document.querySelectorAll(".pc-dev-tab.is-active,[role=tab][aria-selected=true],[aria-current],[class*=is-active],[data-active=true]")).map(e=>(e.className||"").toString().slice(0,50)+" | "+(e.textContent||"").trim().replace(/\s+/g," ").slice(0,50)).slice(0,10).join(" || ")'
home_click_js='(()=>{const els=[...document.querySelectorAll("nav a,nav button,[class*=rail] a,[class*=rail] button,a[href*=\"app=home\"]")];const el=els.find(e=>/app=home/.test(e.getAttribute("href")||"")||/^home$/i.test((e.getAttribute("aria-label")||"").trim())||/^home$/i.test((e.textContent||"").trim()));if(!el)return "NO-HOME-RAIL";el.click();return "clicked:"+(el.tagName)+":"+(el.getAttribute("href")||el.getAttribute("aria-label")||el.textContent.trim().slice(0,20));})()'

probe() { # name url
  local name="$1" url="$2"
  log "=== $name"
  log "goto: $url"
  verdict goto "$url" >/dev/null 2>&1 || log "goto-failed"
  verdict wait "$WAIT_MS" >/dev/null 2>&1
  log "url: $(verdict url 2>&1)"
  log "title: $(verdict title 2>&1)"
  log "active: $(verdict js "$active_js" 2>&1 | head -c 700)"
}

log "PROBE_START $STAMP base=$BASE"
PID=$(ss -ltnpH 'sport = :3801' | grep -oP 'pid=\K[0-9]+' | head -1)
log "backend-3801 pid=$PID release=$(readlink /proc/$PID/cwd 2>/dev/null | grep -o 'releases/[^/]*')"
log "health-3081: $(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/health")"

probe "A dev tab=pg" "$BASE/?app=dev&tab=pg"
probe "B dev tab=terminal" "$BASE/?app=dev&tab=terminal"
probe "C cloud step=connect" "$BASE/?app=cloud&step=connect"
probe "D desktops pin" "$BASE/?app=desktops"

log "=== E hop dev(tab=pg) -> Home rail clears tab"
verdict goto "$BASE/?app=dev&tab=pg" >/dev/null 2>&1; verdict wait "$WAIT_MS" >/dev/null 2>&1
log "before-url: $(verdict url 2>&1)"
log "home-click: $(verdict js "$home_click_js" 2>&1 | head -c 200)"
verdict wait 2500 >/dev/null 2>&1
log "after-url: $(verdict url 2>&1)"

log "=== console (errors)"
verdict console 2>&1 | grep -iE 'error|uncaught' | head -10 | tee -a "$OUT" >/dev/null
log "PROBE_END $(date -u +%Y%m%dT%H%M%SZ)"
echo "EVIDENCE=$OUT"
