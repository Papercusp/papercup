#!/usr/bin/env bash
# P-001 / D-008 refinement — capture WHICH oracle requirements the rewind breaks.
#
# buildDescriptorsFromProbe takes the spec from every `it()` title in the oracle
# file. Measured, that is wrong for big test files: the worst admitted candidate
# has 232 titles while the rewind breaks only a handful. A spec of 229 already-
# passing requirements plus a few real ones is a haystack — it measures needle-
# finding, not implementation, and blows the agent's context budget.
#
# So: rewind each admitted impl, run its oracle, and record the FAILING test
# names. Those are the requirements the task must actually satisfy.
set -uo pipefail

SRC=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
BASE=$(dirname "$SRC")/.gym-probe
DEST=$BASE/substrate
WORK=$BASE/work   # fresh per-candidate clone of DEST
IN=$BASE/results.jsonl
OUT=$BASE/failing-its.jsonl
LOGS=$BASE/run-logs
mkdir -p "$LOGS"
: > "$OUT"

PIN=$(git -C "$DEST" rev-parse HEAD)
echo "PIN=$PIN  substrate=$DEST"

# NOT `grep … | while read`: the loop body runs npm/vitest, which inherits the
# PIPE as its stdin and consumes the remaining candidate lines. Measured — that
# form reported "[0 failing]" for candidates that provably fail 5 of 13 when the
# same commands are run by hand. `mapfile` + a plain for-loop keeps the body in
# THIS shell (so the summary sees the real counts too), and every child gets
# </dev/null so nothing can eat the driver's input again.
mapfile -t LINES < <(grep '"verdict":"admitted"' "$IN")
echo "candidates to measure: ${#LINES[@]}"

for LINE in "${LINES[@]}"; do
  F=$(echo "$LINE"  | grep -o '"implPath":"[^"]*"' | sed 's/.*://;s/"//g')
  T=$(echo "$LINE"  | grep -o '"testPath":"[^"]*"' | sed 's/.*://;s/"//g')
  P=$(echo "$LINE"  | grep -o '"parent":"[^"]*"'   | sed 's/.*://;s/"//g')

  # A FRESH substrate per candidate. Restoring files in a shared one was not
  # enough — measured: after a restore-all pass, the very first candidate still
  # reported PASSED-when-reverted, i.e. the shared world stayed contaminated in a
  # way that is invisible to `git status`. Chasing that further is a rabbit hole;
  # eliminating shared state is a one-line design change.
  #
  # It is affordable precisely because of D-006's measurement: a --local clone
  # hardlinks the object store (0.2s) and node_modules is symlinked, never
  # installed — a few seconds per candidate against a ~20s test run.
  rm -rf "$WORK"
  git clone --quiet --local --no-checkout "$DEST" "$WORK"
  git -C "$WORK" sparse-checkout init --cone
  git -C "$WORK" sparse-checkout set packages libs apps scripts tools docs design-tokens
  git -C "$WORK" checkout --detach -q "$PIN"
  ( cd "$SRC" && find . -name node_modules -type d -prune -not -path './.git/*' | sed 's|^\./||' ) \
    | while read -r d; do mkdir -p "$WORK/$(dirname "$d")"; [ -e "$WORK/$d" ] || ln -s "$SRC/$d" "$WORK/$d"; done
  DEST_RUN=$WORK

  # None of the four commands above is error-checked, and `set -e` is off. A
  # clone/sparse-checkout that half-fails leaves an EMPTY tree in which the
  # oracle cannot run -- and an oracle that never ran reports zero failures,
  # which is exactly the "0" this whole script exists to distinguish from a
  # real measurement. Observed: a leftover $WORK containing only .git, with an
  # empty index, after a run that had recorded four confident CONTRADICTIONs.
  # So assert the substrate is real before trusting anything measured in it.
  TRACKED=$(git -C "$WORK" ls-files | wc -l)
  if [ "$TRACKED" -lt 1000 ]; then
    echo "[FATAL] $F -- substrate clone is EMPTY ($TRACKED tracked files); aborting rather than measuring nothing"
    printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"substrate-clone-empty"}\n' "$F" "$T" >> "$OUT"
    exit 1
  fi

  git -C "$DEST_RUN" checkout -q "$P" -- "$F" 2>/dev/null || continue

  # The oracle must exist on disk, or vitest matches zero files and the router
  # reports a status this script would otherwise read as "nothing failed".
  if [ ! -f "$DEST_RUN/$T" ]; then
    echo "[UNMEASURED] $F -- oracle $T absent from the substrate"
    printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"oracle-absent"}\n' "$F" "$T" >> "$OUT"
    continue
  fi

  # The rewind must actually CHANGE the file. If parent and pin agree on this
  # path, the "task" is a no-op the agent has already solved — and its test would
  # pass, recording a truthful-looking 0. Measured: this is exactly how a dirty
  # substrate produced "[0 failing]" for a candidate that fails 5 of 13.
  if git -C "$DEST_RUN" diff --cached --quiet "$PIN" -- "$F"; then
    echo "[UNMEASURED] $F — rewind is a NO-OP against the pin"
    printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"rewind-noop"}\n' "$F" "$T" >> "$OUT"
    continue
  fi

  RAW=$( cd "$DEST_RUN" && npm run test:file -- "$T" 2>&1 </dev/null )
  # Keep every run's output. A verdict I cannot re-read is a verdict I cannot
  # audit, and this script has already produced four I could not explain.
  printf '%s\n' "$RAW" > "$LOGS/$(echo "$F" | tr / _).log"

  # A run that produced no verdict line at all did not measure anything — say so
  # rather than recording it as "0 failing", which is indistinguishable from a
  # candidate that genuinely passes and would silently drop a real task.
  if ! printf '%s\n' "$RAW" | grep -q 'TEST_FILE_RESULT'; then
    echo "[UNMEASURED] $F — no TEST_FILE_RESULT in output"
    printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"no-verdict-line"}\n' "$F" "$T" >> "$OUT"
    continue
  fi

  # ...but the MARKER is not the VERDICT. `grep -q TEST_FILE_RESULT` is true for
  # `matched=0 executed=0 status=passed` -- a run that executed NOTHING -- and
  # that line then yields zero FAIL lines and reads as "this candidate passes".
  # This is the same defect as recording a 0 for an unmeasured candidate, one
  # layer down: I guarded the FAIL count and left the runner's own status
  # unguarded. Read the numbers, not the string.
  VERDICT=$(printf '%s\n' "$RAW" | grep -o 'TEST_FILE_RESULT.*' | tail -1)
  EXECUTED=$(printf '%s' "$VERDICT" | grep -o 'executed=[0-9]*' | cut -d= -f2)
  MATCHED=$(printf '%s'  "$VERDICT" | grep -o 'matched=[0-9]*'  | cut -d= -f2)
  STATUS=$(printf '%s'   "$VERDICT" | grep -o 'status=[a-z]*'   | cut -d= -f2)
  if [ "${EXECUTED:-0}" -lt 1 ] || [ "${MATCHED:-0}" -lt 1 ]; then
    echo "[UNMEASURED] $F — router executed nothing ($VERDICT)"
    printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"executed-zero"}\n' "$F" "$T" >> "$OUT"
    continue
  fi

  # Vitest's failure summary prints `FAIL  <file> > <describe…> > <it>` (verified
  # against a live run). Take the LAST ` > ` segment — the requirement title.
  # Known limit: an `it` title that itself contains " > " would be clipped. Titles
  # here use → / >= rather than a bare " > ", and a clipped line costs a slightly
  # short requirement, never a broken task — so this is not worth a parser.
  FAILING=$(printf '%s\n' "$RAW" \
    | grep -oE '^[[:space:]]*FAIL[[:space:]]+.* > .*$' \
    | sed -E 's/.* > //' | sed 's/[[:space:]]*$//' | sort -u)

  N=$(printf '%s' "$FAILING" | grep -c . )

  # Every candidate here was ADMITTED, i.e. the probe proved it FAILS when
  # reverted. A reverted run that passes therefore contradicts the probe and
  # means the environment is wrong, not that the task has zero requirements.
  # Recording it as 0 would silently drop a real task; say so instead.
  if [ "${N:-0}" -eq 0 ]; then
    # Two very different causes, and collapsing them cost a whole session.
    # status=failed + zero parsed FAIL lines  => my PARSER is wrong.
    # status=passed                           => the run really did pass, which
    #                                            contradicts the probe.
    if [ "${STATUS:-}" = "failed" ]; then
      echo "[UNMEASURED] $F — run FAILED but no FAIL line parsed; parser is wrong (see $LOGS)"
      printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"parser-missed-failures"}\n' "$F" "$T" >> "$OUT"
    else
      echo "[CONTRADICTION] $F — admitted candidate PASSED when reverted ($VERDICT)"
      printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"passed-when-reverted"}\n' "$F" "$T" >> "$OUT"
    fi
    continue
  fi
  # JSON-escape each title and emit one array (node, not python — guaranteed here).
  ARR=$(printf '%s\n' "$FAILING" | grep . | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))' 2>/dev/null || echo '[]')
  [ -z "$ARR" ] && ARR='[]'
  printf '{"implPath":"%s","testPath":"%s","failingCount":%s,"failing":%s}\n' "$F" "$T" "${N:-0}" "$ARR" >> "$OUT"
  echo "[$N failing] $F"
done

echo "=== SUMMARY ==="
echo "candidates: $(wc -l < "$OUT")"
echo "results -> $OUT"
