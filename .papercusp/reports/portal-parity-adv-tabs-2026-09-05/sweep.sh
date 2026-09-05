#!/usr/bin/env bash
# P-006 verdict sweep of the 15 new rail apps on :3081 + P-007 rail measurement.
# Usage: sweep.sh <previous-release chunk filename>   (continuity check: must still be 200)
# Evidence: .papercusp/scratch/e8071-parity-adv/{sweep-*.txt,<kind>.png,rail-*.png}
OUT="$HOME/papercupai-workspace/papercusp/.papercusp/scratch/e8071-parity-adv"
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUM="$OUT/sweep-$STAMP.txt"
BASE="http://127.0.0.1:3081"
POT=" prs insights adv-settings docs history git stats testing create "
KINDS="health prs insights conversations adv-settings docs history git stats testing create scheduled frames evals coord"
PREV_CHUNK="${1:-}"
CUR="$HOME/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/.portal-runtime/portal/current"
{
  echo "SWEEP_START $(date -u +%FT%TZ) release=$(readlink "$CUR")"
  echo "HEALTH_3081=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"
  if [ -n "$PREV_CHUNK" ]; then
    echo "PREV_CHUNK_HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/_next/static/chunks/$PREV_CHUNK") chunk=$PREV_CHUNK"
  fi
  verdict viewport 1280x800 >/dev/null 2>&1
} >> "$SUM" 2>&1

PROBE='(() => { const t = document.body.innerText || ""; const active = document.querySelector("nav.rail .rail-item.active"); const heads = [...document.querySelectorAll("h1, h2")].map(h => h.textContent.trim().slice(0, 60)).filter(Boolean).slice(0, 5); return JSON.stringify({ q: location.search, title: document.title, activeRail: active ? active.getAttribute("title") : null, notInPortal: /is not in the web portal yet/.test(t), potBar: !!document.querySelector(".pc-potbar"), heads, bodyLen: t.length, elements: document.querySelectorAll("*").length }); })()'

for K in $KINDS; do
  verdict goto "$BASE/?app=$K" >/dev/null 2>&1
  verdict wait 20000 >/dev/null 2>&1
  R="$(verdict js "$PROBE" 2>&1)"
  # The embedded operator pane loads lazily: give a slow pane one more settle.
  if printf '%s' "$R" | grep -qE '"notInPortal":true|"bodyLen":[0-9]{1,3}[,}]'; then
    verdict wait 15000 >/dev/null 2>&1
    R="$(verdict js "$PROBE" 2>&1)"
  fi
  verdict screenshot "$OUT/$K.png" >/dev/null 2>&1
  ERRS="$(verdict console 2>&1 | grep -ci 'error' || true)"
  case "$POT" in *" $K "*) EP=true ;; *) EP=false ;; esac
  printf 'KIND=%s expectPot=%s consoleErrorLines=%s probe=%s\n' "$K" "$EP" "$ERRS" "$R" >> "$SUM"
done

# P-007 — rail ergonomics at 34 apps: scroll-to-marked-item, keyboard reach, sections.
RAIL='(() => { const rail = document.querySelector("nav.rail"); const items = [...document.querySelectorAll("nav.rail .rail-item")]; const active = document.querySelector("nav.rail .rail-item.active"); const rr = rail.getBoundingClientRect(); const ar = active ? active.getBoundingClientRect() : null; let focusable = 0; for (const b of items) { b.focus(); if (document.activeElement === b) focusable++; } if (active) active.focus(); return JSON.stringify({ railItems: items.length, mainApps: document.querySelectorAll("nav.rail .rail-apps .rail-item").length, footItems: document.querySelectorAll("nav.rail .rail-foot .rail-item").length, railClient: rail.clientHeight, railScroll: rail.scrollHeight, clipped: rail.scrollHeight - rail.clientHeight, scrollTop: Math.round(rail.scrollTop), activeTitle: active && active.title, activeTop: ar && Math.round(ar.top), activeBottom: ar && Math.round(ar.bottom), activeVisible: ar ? (ar.top >= rr.top - 1 && ar.bottom <= rr.bottom + 1) : null, viewportH: innerHeight, focusable, dividers: document.querySelectorAll("nav.rail [role=separator], nav.rail hr, nav.rail .rail-divider, nav.rail .rail-section").length }); })()'
for VP in 1280x800 1366x768; do
  verdict viewport "$VP" >/dev/null 2>&1
  for K in home health coord; do
    verdict goto "$BASE/?app=$K" >/dev/null 2>&1
    verdict wait 8000 >/dev/null 2>&1
    printf 'RAIL vp=%s app=%s %s\n' "$VP" "$K" "$(verdict js "$RAIL" 2>&1)" >> "$SUM"
    verdict screenshot "$OUT/rail-$VP-$K.png" >/dev/null 2>&1
  done
done
echo "SWEEP_END $(date -u +%FT%TZ)" >> "$SUM"
echo "$SUM"
