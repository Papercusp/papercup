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
#
# WHAT IT DOES NOT CHECK — do not over-trust an `ok`. It asks "did SOMETHING paint
# without crashing", not "did the RIGHT view paint": a flag-hidden id degrades to
# the default view by design (`?lview=gym` with FLAGS.TESTING off lands on
# Improvements — LearningTab's `view` fallback), and that reports ok here. Content
# correctness per view is the jsdom suites' job; this covers exactly the failure
# they are structurally blind to.
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

# EI-18818262219163661: both were hardcoded. 45s is comfortable for a small view
# and thin for the heaviest one (`improvements` aggregates the funnel plus the
# full idea/work lists), and a loaded box stretches every one of them.
PAINT_TIMEOUT_MS="${VERIFY_LEARNING_PAINT_TIMEOUT_MS:-45000}"
PAINT_ATTEMPTS="${VERIFY_LEARNING_PAINT_ATTEMPTS:-2}"

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
    #
    # EI-18818262219163661: the wait's exit status used to be thrown away with
    # `|| true`, so a view that simply had not painted YET at the deadline was
    # reported in the SAME words as a genuine crash ("NEVER PAINTED"), and the
    # run exited 1. That is the most expensive possible ambiguity: a one-view red
    # points at whatever you most recently edited, which is exactly when you can
    # least afford to wave it off. Observed 2026-07-27 — `improvements` came back
    # NEVER PAINTED, and a direct drive then painted it in 5s (nine times inside
    # the budget). Two runs of the SAME build failed DIFFERENT views. So: keep the
    # status, and RETRY in-session before believing it.
    #
    # The retry is inside the drive on purpose — the instance is already booted,
    # so a second attempt costs seconds, where a second harness run costs a full
    # ~2min boot. A real defect still fails every attempt; only a flake recovers.
    echo "V_PAINTED=0; V_TIMEDOUT=false"
    echo "for attempt in \$(seq 1 $PAINT_ATTEMPTS); do"
    echo "  [ \"\$attempt\" -gt 1 ] && tauri-agent-tools eval --pid \"\$P\" \"location.href='http://127.0.0.1:\$PORT/adv?tab=learning&ws=papercusp-workspace&scope=all&lview=$V'; 'go'\" >/dev/null 2>&1"
    echo "  if tauri-agent-tools wait --pid \"\$P\" --eval \"location.href.indexOf('lview=$V') >= 0 && (!!document.querySelector('.pc-learning__viewpane') || /hit an error/.test(document.body.innerText))\" --timeout $PAINT_TIMEOUT_MS >/dev/null 2>&1; then V_TIMEDOUT=false; else V_TIMEDOUT=true; fi"
    echo "  V_RESULT=\"\$(tauri-agent-tools eval --pid \"\$P\" \"JSON.stringify({view:'$V', painted: !!document.querySelector('.pc-learning__viewpane'), boundary: /hit an error/.test(document.body.innerText)})\" 2>&1)\""
    # The bridge PRETTY-PRINTS its JSON (`\"painted\": true`, across lines), so this
    # must de-newline AND de-space exactly like the verdict parser below does —
    # matching the compact form against pretty output silently never fires, which
    # would burn every retry and mislabel healthy views as \"recovered on attempt 2\".
    echo "  V_FLAT=\"\$(printf '%s' \"\$V_RESULT\" | tr -d ' \\n')\""
    echo "  case \"\$V_FLAT\" in *'\"painted\":true'*|*'\"boundary\":true'*) V_PAINTED=1 ;; esac"
    echo "  [ \"\$V_PAINTED\" = 1 ] && break"
    echo "done"
    # Emitted as bare tokens: the parser de-newlines the transcript, so a marker
    # survives concatenation intact while pretty-printed JSON does not.
    echo "echo \"TIMEDOUT:$V:\$V_TIMEDOUT ATTEMPTS:$V:\$attempt\""
    echo "echo \"\$V_RESULT\""
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
  # EI-18818262219163661: a check that never CONCLUDED must not be reported in
  # the same words as one that concluded negatively (the mirror of the
  # a-check-that-never-ran-must-not-read-as-passed insight). The drive emits its
  # own timeout marker because the verdict JSON cannot carry it.
  ATTEMPTS="$(grep -o "ATTEMPTS:$V:[0-9]*" "$FLAT" | tail -1 | sed "s/.*://")"
  RETRIED=""
  [ -n "$ATTEMPTS" ] && [ "$ATTEMPTS" -gt 1 ] 2>/dev/null && RETRIED=" (recovered on attempt $ATTEMPTS)"
  case "$LINE" in
    *'"boundary":true'*)
      printf '  %-16s CRASHED — the tab error boundary tripped\n' "$V"; FAILED=1 ;;
    *'"painted":true'*)
      printf '  %-16s ok%s\n' "$V" "$RETRIED" ;;
    *)
      if grep -q "TIMEDOUT:$V:true" "$FLAT"; then
        printf '  %-16s TIMED OUT after %ss x%s — never painted, never errored. NOT proof of a defect: re-drive this one view before believing it (fact: learning-view-sweep-single-view-flake).\n' \
          "$V" "$((PAINT_TIMEOUT_MS / 1000))" "${ATTEMPTS:-?}"
      else
        printf '  %-16s NEVER PAINTED — no view pane, no boundary\n' "$V"
      fi
      FAILED=1 ;;
  esac
done
rm -f "$RAW" "$FLAT"
echo "──────────────────────────────────────────────────────────────────────"
[ "$FAILED" -eq 0 ] && echo "ALL PROBED VIEWS PAINTED" || echo "AT LEAST ONE VIEW IS BROKEN — see above"
exit "$FAILED"
