#!/usr/bin/env bash
# scripts/verify-learning-tab-views.sh — WI-6383.
#
# Opens EVERY Learning-tab view in a real webview and reports, per view, whether
# it actually painted or tripped the tab's error boundary.
#
# WHY THIS EXISTS. On 2026-07-27 the Throughput view crashed the whole Learning
# tab with React #185 ("Maximum update depth exceeded") while 86 jsdom tests —
# including render tests asserting that exact view mounted — were green. jsdom
# cannot see a render LOOP: it reports zero layout (scrollWidth === clientWidth
# === 0) and our suites install a no-op ResizeObserver, so every
# measure -> setState -> re-measure path is inert there. A passing render test
# proves a view renders ONCE, not that it renders.
#
# The second half of that lesson is why this script asserts what it does. An
# error-boundary trip is INVISIBLE to "is my element on screen" probing:
# querySelector returns null and getByRole throws whether the view is broken or
# merely absent. So the check is two-sided — the view's own root must be PRESENT
# *and* the boundary's text must be ABSENT.
#
# USAGE
#   scripts/verify-learning-tab-views.sh                 # every view
#   scripts/verify-learning-tab-views.sh throughput ekg  # just these
#
# It boots its OWN isolated instance via scripts/verify-tauri-headless.sh (own X
# display, own port, own sidecar) and tears it down after. It never touches the
# owner's desktop or a peer's shell — see apps/operator-docs/.../testing/agent-e2e.mdx
# §1.3. READS ONLY: it navigates and inspects, it clicks nothing.
#
# EXIT: 0 when every probed view painted, 1 when any crashed or never appeared
# (so it is usable as a release gate, not just an eyeball check).
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The `?lview=` values, kept in the SAME order the stage catalog offers them.
# Deliberately a literal list rather than a parse of LearningTab.tsx: this script
# is the independent check, and a checker that derives its expectations from the
# thing it is checking cannot catch a view being dropped from the catalog. The
# reachability guard (learning-view-reachability.guard.test.ts) is what keeps the
# two lists honest in the other direction.
ALL_VIEWS=(
  signals observations rubrics
  pipeline
  gym improvements
  learnings
  benchmark orchestration bakeoff wake-efficiency ekg red-queen experiments frontier throughput
)

VIEWS=("$@")
[ ${#VIEWS[@]} -eq 0 ] && VIEWS=("${ALL_VIEWS[@]}")

DRIVE="$(mktemp -t learning-views-drive.XXXXXX.sh)"
trap 'rm -f "$DRIVE"' EXIT

{
  echo 'set -u'
  echo 'P="$VERIFY_TAURI_PID"; PORT="$VERIFY_TAURI_PORT"'
  # Wait for the SPA to mount at all before judging any view, or the first probe
  # measures a blank document and reports a false crash.
  echo 'tauri-agent-tools wait --pid "$P" --eval "document.querySelectorAll('"'"'[role=tab]'"'"').length > 0" --timeout 120000 >/dev/null 2>&1 || echo "MOUNT-TIMEOUT"'
  for V in "${VIEWS[@]}"; do
    echo "tauri-agent-tools eval --pid \"\$P\" \"location.href='http://127.0.0.1:\$PORT/adv?tab=learning&ws=papercusp-workspace&scope=all&lview=$V'; 'go'\" >/dev/null 2>&1"
    # Settle on EITHER outcome — painted or boundary — so a crash is observed
    # promptly instead of burning the whole timeout. Never `sleep` between drive
    # steps (agent-e2e §1.6: the harness blocks foreground sleep, and a fixed
    # delay is a flake either way).
    #
    # The `lview=` clause is load-bearing, not belt-and-braces. Navigation here is
    # a FULL reload, so for a moment the PREVIOUS view's pane is still in the DOM;
    # a wait on the pane alone is satisfied by the outgoing page and the verdict
    # then measures whatever the reload happens to be mid-way through. Observed
    # doing exactly that: the same view probed twice in a row returned a clean
    # verdict and then a blank one. Pin the URL first, so "painted" and "boundary"
    # are both being asked about the view actually under test.
    echo "tauri-agent-tools wait --pid \"\$P\" --eval \"location.href.indexOf('lview=$V') >= 0 && (!!document.querySelector('.pc-learning__viewpane') || /hit an error/.test(document.body.innerText))\" --timeout 45000 >/dev/null 2>&1 || true"
    echo "tauri-agent-tools eval --pid \"\$P\" \"JSON.stringify({view:'$V', painted: !!document.querySelector('.pc-learning__viewpane'), boundary: /hit an error/.test(document.body.innerText)})\""
  done
} > "$DRIVE"

RAW="$(mktemp -t learning-views-raw.XXXXXX)"
"$REPO_DIR/scripts/verify-tauri-headless.sh" -- bash "$DRIVE" 2>&1 | tee "$RAW"

# The bridge PRETTY-PRINTS its JSON result across several lines, so the verdicts
# have to be de-newlined before they can be matched as objects. (Grepping the raw
# lines instead silently matches nothing and reports every view INCONCLUSIVE —
# which reads like a broken app rather than a broken parser.)
FLAT="$(mktemp -t learning-views-flat.XXXXXX)"
tr -d ' \n' < "$RAW" > "$FLAT"

echo
echo "── Learning tab: per-view render verdict ─────────────────────────────"
FAILED=0
for V in "${VIEWS[@]}"; do
  LINE="$(grep -o "{\"view\":\"$V\"[^}]*}" "$FLAT" | tail -1)"
  if [ -z "$LINE" ]; then
    printf '  %-16s INCONCLUSIVE — no verdict captured\n' "$V"
    FAILED=1
    continue
  fi
  case "$LINE" in
    *'"boundary":true'*)
      printf '  %-16s CRASHED — the tab error boundary tripped\n' "$V"; FAILED=1 ;;
    *'"painted":true'*)
      printf '  %-16s ok\n' "$V" ;;
    *)
      printf '  %-16s NEVER PAINTED — no view pane, no boundary\n' "$V"; FAILED=1 ;;
  esac
done
rm -f "$RAW" "$FLAT"
echo "──────────────────────────────────────────────────────────────────────"
[ "$FAILED" -eq 0 ] && echo "ALL PROBED VIEWS PAINTED" || echo "AT LEAST ONE VIEW IS BROKEN — see above"
exit "$FAILED"
