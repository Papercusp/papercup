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
IN=$BASE/results.jsonl
OUT=$BASE/failing-its.jsonl
: > "$OUT"

PIN=$(git -C "$DEST" rev-parse HEAD)
echo "PIN=$PIN  substrate=$DEST"

grep '"verdict":"admitted"' "$IN" | while read -r LINE; do
  F=$(echo "$LINE"  | grep -o '"implPath":"[^"]*"' | sed 's/.*://;s/"//g')
  T=$(echo "$LINE"  | grep -o '"testPath":"[^"]*"' | sed 's/.*://;s/"//g')
  P=$(echo "$LINE"  | grep -o '"parent":"[^"]*"'   | sed 's/.*://;s/"//g')

  git -C "$DEST" checkout -q "$PIN" -- "$F" 2>/dev/null
  git -C "$DEST" checkout -q "$P"   -- "$F" 2>/dev/null || continue

  RAW=$( cd "$DEST" && npm run test:file -- "$T" 2>&1 )
  git -C "$DEST" checkout -q "$PIN" -- "$F"

  # Vitest's failure summary prints `FAIL  <file> > <describe…> > <it>` (verified
  # against a live run). Take the LAST ` > ` segment — the requirement title.
  # Known limit: an `it` title that itself contains " > " would be clipped. Titles
  # here use → / >= rather than a bare " > ", and a clipped line costs a slightly
  # short requirement, never a broken task — so this is not worth a parser.
  FAILING=$(printf '%s\n' "$RAW" \
    | grep -oE '^[[:space:]]*FAIL[[:space:]]+.* > .*$' \
    | sed -E 's/.* > //' | sed 's/[[:space:]]*$//' | sort -u)

  N=$(printf '%s' "$FAILING" | grep -c . )
  # JSON-escape each title and emit one array (node, not python — guaranteed here).
  ARR=$(printf '%s\n' "$FAILING" | grep . | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))' 2>/dev/null || echo '[]')
  [ -z "$ARR" ] && ARR='[]'
  printf '{"implPath":"%s","testPath":"%s","failingCount":%s,"failing":%s}\n' "$F" "$T" "${N:-0}" "$ARR" >> "$OUT"
  echo "[$N failing] $F"
done

echo "=== SUMMARY ==="
echo "candidates: $(wc -l < "$OUT")"
echo "results -> $OUT"
