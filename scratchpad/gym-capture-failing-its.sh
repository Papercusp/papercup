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
  git -C "$DEST_RUN" checkout -q "$P" -- "$F" 2>/dev/null || continue

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

  # A run that produced no verdict line at all did not measure anything — say so
  # rather than recording it as "0 failing", which is indistinguishable from a
  # candidate that genuinely passes and would silently drop a real task.
  if ! printf '%s\n' "$RAW" | grep -q 'TEST_FILE_RESULT'; then
    echo "[UNMEASURED] $F — no TEST_FILE_RESULT in output"
    printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[]}\n' "$F" "$T" >> "$OUT"
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
    echo "[CONTRADICTION] $F — admitted candidate PASSED when reverted; environment suspect"
    printf '{"implPath":"%s","testPath":"%s","failingCount":-1,"failing":[],"why":"passed-when-reverted"}\n' "$F" "$T" >> "$OUT"
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
