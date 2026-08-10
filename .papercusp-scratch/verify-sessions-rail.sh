#!/usr/bin/env bash
# WI-37776 live verification — the goal popup's Sessions rail.
#
# Runs INSIDE scripts/verify-tauri-headless.sh's isolated instance (own display,
# own devUrl port, own sidecar, frozen SPA snapshot). Never touches the owner's
# :0 window.
set -uo pipefail

GOAL='make-a-website-displaying-images-of-pandas-aa0205'
# hudgoalsessions=true FORCES the zone open, so the DOM contract is provable
# regardless of which seating the width picks. Without it the room-aware default
# (`param ?? !isNarrow`) legitimately keeps it closed below 1480px, and a first
# run read that correct behaviour as a mount failure.
URL="http://127.0.0.1:${VERIFY_TAURI_PORT}/adv?ws=papercusp-workspace&slug=papercusp&tab=hud&hudtab=goals&hudgoal=${GOAL}&hudgoalsessions=true"

# ── Widen the window BEFORE navigating ──────────────────────────────────────
# The rig's window opens at 1280x800, and at that width EVERY zone past the
# give-way ladder's first rung defaults CLOSED (`param ?? !isNarrow`) — which is
# the designed behaviour, and which makes 1280 the one width at which this rail
# is legitimately absent. A first run here reported exactly that and it read
# like a mount failure. Xvfb's screen is 1920x1080, and at 1920 the ladder seats
# Sessions (rung 1480) and Work as real COLUMNS, which is the path under test.
echo "=== widening the window so the zones seat as columns ==="
# The X window's name is NOT the webview's document.title (which is what
# `probe` prints), so searching for 'Papercusp Operator' finds nothing — the
# first run did exactly that and silently fell through to the 1280 path. Try
# the real identifiers in order and report which one answered.
WID=""
for strategy in "--class papercusp" "--classname papercusp" "--name .+"; do
  # shellcheck disable=SC2086
  CAND="$(DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool search --onlyvisible $strategy 2>/dev/null | tail -1)"
  if [ -n "$CAND" ]; then WID="$CAND"; echo "window found via: xdotool search $strategy -> $WID"; break; fi
done
[ -z "$WID" ] && echo "no strategy matched; windows on this display:" && \
  DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool search --onlyvisible --name '' 2>/dev/null | head
if [ -n "$WID" ]; then
  DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool windowsize "$WID" 1920 1040
  DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool windowmove "$WID" 0 0
  sleep 2
  echo "resized window $WID"
else
  echo "WARN: no window found to resize — the column assertions below will be" >&2
  echo "      about the OVERLAY path instead, so read them accordingly." >&2
fi
tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" 'JSON.stringify({innerWidth:window.innerWidth,innerHeight:window.innerHeight})'

echo "=== navigating to the goal popup ==="
tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" "location.href = ${URL@Q}" || exit 1

echo "=== waiting for the Sessions zone to mount ==="
"$VERIFY_TAURI_POLL" --selector '[data-testid="goal-sessions-rail"]' --no-errors || {
  echo "POLL FAILED — dumping what DID mount, so a miss is diagnosable rather than bare:"
  tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" '
    JSON.stringify({
      zones: [...document.querySelectorAll("[data-testid$=\"-rail\"],[data-testid=\"goal-chat\"]")]
        .map(n => n.getAttribute("data-testid")),
      noAgent: !!document.querySelector("[data-testid=\"goal-chat-no-agent\"]"),
    })'
  exit 1
}

echo "=== decisive read: placement, rows, sections, geometry ==="
tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" '
(() => {
  const q = (s) => document.querySelector(s);
  const sessions = q("[data-testid=\"goal-sessions-rail\"]");
  const work = q("[data-testid=\"goal-work-rail\"]");
  const chat = q("[data-testid=\"goal-chat\"]");
  const r = sessions ? sessions.getBoundingClientRect() : null;
  const wr = work ? work.getBoundingClientRect() : null;
  return JSON.stringify({
    mounted: !!sessions,
    // The owner-specified placement, asserted two independent ways: DOM
    // adjacency, and actual painted geometry (left of Work on screen).
    nextSiblingIsWork: !!sessions && sessions.nextElementSibling === work,
    leftOfWorkOnScreen: !!(r && wr) && r.left < wr.left,
    // A zone nested INSIDE the conversation would still render and still be
    // "left of work" at some widths; this is the layout contract itself.
    siblingOfChat: !!(chat && sessions) && !chat.contains(sessions) && !sessions.contains(chat),
    // Which SEATING the ladder picked. Reported, never assumed: the geometry
    // claim below is only meaningful in "column" mode, since both zones sit at
    // right:0 when they overlay.
    seating: sessions ? (getComputedStyle(sessions).position === "absolute" ? "overlay" : "column") : null,
    viewport: window.innerWidth + "x" + window.innerHeight,
    width: r ? Math.round(r.width) : null,
    height: r ? Math.round(r.height) : null,
    title: q("[data-testid=\"goal-sessions-zone-title\"]")?.textContent?.trim() ?? null,
    toggleLabel: q("[data-testid=\"goal-sessions-toggle\"]")?.textContent?.trim() ?? null,
    sections: [...sessions.querySelectorAll("[data-section]")].map(n => n.getAttribute("data-section")),
    rows: [...sessions.querySelectorAll("[data-testid=\"goal-session-row\"]")].map(n => ({
      owner: n.getAttribute("data-owner"),
      member: n.getAttribute("data-member") === "true",
      ended: n.getAttribute("data-ended") === "true",
      text: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70),
    })),
    // Borrowed-vocabulary check: the owner asked it to MIMIC the fleet pane, so
    // it must actually be using that pane classes, not a lookalike.
    usesPeerClasses: !!sessions.querySelector(".pc-peer"),
    zoneClass: sessions.className,
  }, null, 1);
})()'
RC=$?

echo "=== console errors (a rail that throws still leaves markup behind) ==="
tauri-agent-tools logs --pid "$VERIFY_TAURI_PID" --level error 2>/dev/null | tail -20

exit $RC
