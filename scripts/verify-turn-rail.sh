#!/usr/bin/env bash
# Live Tauri-shell verification for the conversation popup's TURN RAIL
# (chat-popup-turn-rail-2026-08-31 P-007).
#
# Run it as:
#   scripts/verify-tauri-headless.sh -- scripts/verify-turn-rail.sh
#
# WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. TurnRail.test.tsx already
# proves the click contract, the densities and the fallbacks — in jsdom, which
# applies NO CSS and where ChatConversation's virtualizer is mocked. Three of
# this feature's real failure modes are invisible there by construction:
#
#   1. WebKitGTK ignores `display:flex` on a <button>. The vitest guard is a
#      SOURCE assertion (it greps the stylesheet); only a real webview can say
#      what the browser actually computed and whether the row laid out.
#   2. The jump lands through a REAL virtualizer. A mocked one renders every
#      message, so "scrolled to the answer" is trivially satisfiable in jsdom
#      and means nothing about the shipping path.
#   3. The rail↔transcript agreement is a scroll-driven feedback loop. Nothing
#      in jsdom scrolls.
#
# Every assertion below is `tauri-agent-tools check`, which EXITS 1 when false.
# `dom`, `eval`, `click` and `screenshot` all exit 0 no matter what happened, so
# they appear here only to set up or to narrate — never as the evidence itself.
set -euo pipefail

TAT="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
PORT="${VERIFY_TAURI_PORT:?verify-tauri-headless.sh must export VERIFY_TAURI_PORT}"
# A real session with a real multi-turn transcript. Read-only: this script
# clicks rail rows (which only scroll) and never touches the composer.
SESSION="${TURN_RAIL_SESSION:-su-8c533785-2657-4229-a19a-68b19c5cca3f}"
URL="/adv?tab=hud&hudtab=sessions&hudsession=${SESSION}&chatTurns=true"

say() { printf '\n=== %s ===\n' "$1"; }

say "navigating to the HUD sessions popup"
"$TAT" --port "$PORT" eval --expr "window.location.href = '${URL}'" >/dev/null
# A settle guard, not an assertion — followed by real checks below (§1.4).
"$TAT" --port "$PORT" wait --selector '[data-testid="session-chat-turn-rail"]' --timeout 30000

say "1. the rail mounts as a SIBLING of the conversation, not inside it (D-002/P-015)"
# The layout invariant the plan is built on: if the rail ever moves inside the
# conversation element it inherits the transcript's scroll and stops being a
# fixed position indicator — and nothing about that would look wrong in a
# screenshot.
"$TAT" --port "$PORT" check --eval '
  const rail = document.querySelector("[data-testid=session-chat-turn-rail]");
  const conv = document.querySelector("[data-testid=session-chat-conversation]");
  !!rail && !!conv && !conv.contains(rail) && rail.parentElement === conv.parentElement
'

say "2. rows rendered from the REAL transcript, previewing real questions"
"$TAT" --port "$PORT" check --eval '
  const rows = document.querySelectorAll("[data-testid=turn-rail-row]");
  rows.length > 0 && [...rows].every(r => (r.textContent || "").trim().length > 0)
'

say "3. THE WEBKITGTK TRAP — what the browser actually COMPUTED, not what the CSS says"
# The vitest guard reads chat-controls.css. This reads getComputedStyle inside
# the only shipping webview. `display:block` on the button, `flex` on the inner
# span that does the laying out — the exact split EI-18135716653974462 is about.
"$TAT" --port "$PORT" check --eval '
  const row = document.querySelector("[data-testid=turn-rail-row]");
  const top = row.querySelector(".pc-turn__top");
  getComputedStyle(row).display === "block" && getComputedStyle(top).display === "flex"
'

say "4. ...and that the row did not STACK — the visible symptom of the trap"
# The failure mode is icon-over-label stacking, so assert the geometry rather
# than the style: the turn number and the timestamp share a line (same top),
# and the question sits BELOW them. A stacked row fails both halves.
"$TAT" --port "$PORT" check --eval '
  const row = document.querySelector("[data-testid=turn-rail-row]");
  const n = row.querySelector(".pc-turn__n");
  const t = row.querySelector(".pc-turn__time");
  const q = row.querySelector(".pc-turn__q");
  const nb = n.getBoundingClientRect(), qb = q.getBoundingClientRect();
  const sameLine = !t || Math.abs(nb.top - t.getBoundingClientRect().top) < 6;
  sameLine && qb.top >= nb.bottom - 2 && qb.width > 40
'

say "5. THE OWNER'\''S ASK — a click scrolls the transcript to that turn'\''s ANSWER"
# Through the REAL virtualizer, which is the half jsdom cannot exercise. The
# scroller is captured BEFORE the click so a rail that scrolls nothing fails
# rather than silently passing.
"$TAT" --port "$PORT" eval --expr '
  const conv = document.querySelector("[data-testid=session-chat-conversation]");
  const sc = [...conv.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 40);
  window.__turnRailProbe = { el: sc, before: sc ? sc.scrollTop : null };
  window.__turnRailProbe.before
' >/dev/null
# Click the FIRST row: on a long transcript the reader is at the bottom, so
# turn 1 is the longest possible jump and the least likely to pass by accident.
"$TAT" --port "$PORT" click --selector '[data-testid=turn-rail-row]'
"$TAT" --port "$PORT" wait --eval '
  const p = window.__turnRailProbe;
  p && p.el && p.el.scrollTop !== p.before
' --timeout 10000
"$TAT" --port "$PORT" check --eval '
  const p = window.__turnRailProbe;
  // Scrolled, and UPWARD — a jump to turn 1 that moved the transcript DOWN
  // would be the "landed on the wrong index" bug passing a mere "it moved" test.
  p && p.el && p.el.scrollTop !== p.before && p.el.scrollTop < p.before
'

say "6. the rail marks WHERE YOU ARE after the jump — exactly one live row"
"$TAT" --port "$PORT" check --eval '
  document.querySelectorAll("[data-testid=turn-rail-row][data-live=true]").length === 1
'

say "7. under width pressure it DEGRADES TO A SPINE rather than becoming an overlay (D-003)"
# The whole point of D-003: an overlay you must open to see where you are
# defeats a position indicator. Narrow the window and assert the density flips
# AND that ticks — not rows — are what render.
"$TAT" --port "$PORT" eval --expr 'window.resizeTo(900, 900)' >/dev/null
"$TAT" --port "$PORT" wait --selector '[data-testid=turn-rail][data-density=spine]' --timeout 10000
"$TAT" --port "$PORT" check --eval '
  const rail = document.querySelector("[data-testid=turn-rail]");
  const ticks = document.querySelectorAll("[data-testid=turn-rail-tick]");
  const rows = document.querySelectorAll("[data-testid=turn-rail-row]");
  rail.getAttribute("data-density") === "spine" && ticks.length > 0 && rows.length === 0
'

say "8. the tick heights actually vary — a spine of identical marks is decoration"
"$TAT" --port "$PORT" check --eval '
  const hs = [...document.querySelectorAll("[data-testid=turn-rail-tick] .pc-turn-tick__bar")]
    .map(b => b.getBoundingClientRect().height);
  hs.length > 1 && new Set(hs.map(h => Math.round(h))).size > 1
    && Math.min(...hs) >= 11 && Math.max(...hs) <= 45
'

say "9. no console errors were raised while driving it"
"$TAT" --port "$PORT" check --no-errors

say "ALL TURN-RAIL LIVE ASSERTIONS PASSED"
