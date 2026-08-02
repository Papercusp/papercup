#!/usr/bin/env bash
# P-001 step 2 — run the REAL discrimination probe over mined candidates.
#
# For each (impl, oracle) pair co-changed in one commit: inside a pinned clone of
# the real repo, rewind ONLY impl to the joint commit's parent and run the real
# test (expect FAIL), then restore impl to the pin and run it again (expect PASS).
# Only that fail->pass shape admits a task (judgeDiscrimination, D-006).
#
# Scratch dir MUST be on the workspace device: `git clone --local` hardlinks the
# object store and fails "Invalid cross-device link" onto /tmp.
set -uo pipefail

# Derived, never hardcoded: a literal home path is wrong on every other machine
# AND reds the green-checkpoint identity-lint leg, freezing `main` fleet-wide.
SRC=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
# Sibling of the checkout, so the clone lands on the SAME filesystem (--local hardlinks).
BASE=$(dirname "$SRC")/.gym-probe
OUT=$BASE/results.jsonl
DEST=$BASE/substrate
WINDOW=${WINDOW:-60}

rm -rf "$BASE"; mkdir -p "$BASE"; : > "$OUT"
PIN=$(git -C "$SRC" rev-parse HEAD)
echo "PIN=$PIN"

echo "=== materialising pinned substrate ==="
git clone --quiet --local --no-checkout "$SRC" "$DEST"
git -C "$DEST" sparse-checkout init --cone
git -C "$DEST" sparse-checkout set packages libs apps scripts tools docs design-tokens
git -C "$DEST" checkout --detach -q "$PIN"
( cd "$SRC" && find . -name node_modules -type d -prune -not -path './.git/*' | sed 's|^\./||' ) | while read -r d; do
  mkdir -p "$DEST/$(dirname "$d")"
  [ -e "$DEST/$d" ] || ln -s "$SRC/$d" "$DEST/$d"
done
echo "substrate ready: $(du -sh --exclude=.git "$DEST" | cut -f1)"

run_test() {  # $1 = test path -> prints passed|failed
  ( cd "$DEST" && npm run test:file -- "$1" 2>&1 ) \
    | grep -o 'TEST_FILE_RESULT.*status=[a-z]*' | grep -o 'status=[a-z]*' | cut -d= -f2 | tail -1
}

echo "=== mining candidates (window=$WINDOW commits) ==="
i=0
git -C "$SRC" log --format=%H -"$WINDOW" | while read -r C; do
  P=$(git -C "$SRC" rev-parse "$C^" 2>/dev/null) || continue
  FILES=$(git -C "$SRC" show --stat --format= --name-only "$C" 2>/dev/null)
  echo "$FILES" | grep -E '^(packages|libs|apps)/' \
                | grep -vE '/_retired/|^_retired/|\.d\.ts$' \
                | grep -vE '\.(test|spec)\.[cm]?[jt]sx?$' | while read -r F; do
    STEM="${F%.*}"; EXT="${F##*.}"; T="$STEM.test.$EXT"
    echo "$FILES" | grep -qx "$T" || continue
    grep -q "\"implPath\":\"$F\"" "$OUT" 2>/dev/null && continue   # first (nearest) wins
    git -C "$DEST" cat-file -e "$P:$F" 2>/dev/null || continue      # existed at parent?

    git -C "$DEST" checkout -q "$PIN" -- "$F" 2>/dev/null
    git -C "$DEST" checkout -q "$P"   -- "$F" 2>/dev/null || continue
    REV=$(run_test "$T")
    git -C "$DEST" checkout -q "$PIN" -- "$F"
    RES=$(run_test "$T")

    if   [ "$REV" = failed ] && [ "$RES" = passed ]; then V=admitted; R=""
    elif [ "$REV" = passed ] && [ "$RES" = passed ]; then V=rejected; R=no-oracle
    elif [ "$REV" = failed ] && [ "$RES" = failed ]; then V=rejected; R=inverted
    else V=rejected; R=broken-baseline; fi

    printf '{"implPath":"%s","testPath":"%s","joint":"%s","parent":"%s","reverted":"%s","restored":"%s","verdict":"%s","reason":"%s"}\n' \
      "$F" "$T" "$C" "$P" "$REV" "$RES" "$V" "$R" >> "$OUT"
    echo "[$V${R:+:$R}] $F  (rev=$REV res=$RES)"
  done
done

echo "=== SUMMARY ==="
echo "candidates probed: $(wc -l < "$OUT")"
echo "admitted:          $(grep -c '"verdict":"admitted"' "$OUT")"
echo "rejected no-oracle:$(grep -c '"reason":"no-oracle"' "$OUT")"
echo "rejected inverted: $(grep -c '"reason":"inverted"' "$OUT")"
echo "rejected baseline: $(grep -c '"reason":"broken-baseline"' "$OUT")"
echo "results -> $OUT"
