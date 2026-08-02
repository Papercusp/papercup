#!/usr/bin/env bash
# Mirror vditor's runtime asset tree into apps/operator/public/vditor/ so the
# markdown surfaces load it from LOCALHOST instead of the public internet.
#
# WHY THIS EXISTS (WI-7088). Vditor resolves its runtime assets from an
# `options.cdn` base, defaulting to `https://unpkg.com/vditor@<version>`. We
# never set that option, so EVERY cold markdown render fetched ~4.9 MB across
# the internet before it could paint:
#
#     js/lute/lute.min.js                 3907 KB   (Go->WASM blob: slow to
#     js/highlight.js/highlight.min.js    1025 KB    fetch AND slow to parse)
#     js/icons/ant.js                       42 KB
#     js/highlight.js/third-languages.js    21 KB
#     js/i18n/en_US.js                       2 KB
#
# That is the "opening a plan takes several seconds" report — and it also meant
# markdown rendering silently required internet connectivity. Every one of those
# files already ships inside node_modules/vditor; nothing was ever missing but a
# local copy and a `cdn` pointing at it.
#
# WHY THE WHOLE dist/ AND NOT JUST THE FIVE MEASURED FILES. Those five are what
# one plan happened to request. Vditor lazily pulls mermaid / katex / echarts /
# graphviz / plantuml the moment a document contains one of those blocks, and
# our plans do contain mermaid. A partial mirror would turn "slow" into "404 —
# renders nothing" for exactly those documents: strictly worse than the bug, and
# intermittent enough to look fixed. Copying the tree wholesale (~23 MB into a
# public/ that is already ~491 MB, gitignored, generated) removes the whole
# class instead of the instance.
#
# Run after `npm install` (chained from apps/operator's postinstall hook next to
# setup-wake-runtime / setup-vad-runtime) and again from operator-vite's
# `prebuild`, so a build whose install was skipped still gets the assets.
# Idempotent: a version stamp makes a no-op re-run essentially free.
set -euo pipefail

cd "$(dirname "$0")/.."

# Same require.resolve('pkg/package.json') trap as the sibling setup scripts —
# probe paths directly instead of asking node to resolve them.
SRC=""
for cand in \
  "$(pwd)/node_modules/vditor/dist" \
  "$(pwd)/../../node_modules/vditor/dist"; do
  if [ -d "$cand" ]; then
    SRC="$cand"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "ERR: can't find vditor/dist; install vditor first" >&2
  exit 1
fi

VERSION="$(node -p "require('$SRC/../package.json').version" 2>/dev/null || echo unknown)"
DEST="public/vditor/dist"
STAMP="public/vditor/.version"

# Skip the copy when the mirror already matches the installed vditor. The stamp
# is written LAST, so an interrupted copy leaves it stale/absent and the next run
# redoes the work rather than trusting a half-populated tree.
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$VERSION" ] && [ -f "$DEST/js/lute/lute.min.js" ]; then
  echo "vditor-runtime: already current (v$VERSION) — skipping copy"
  exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/

# Sanity-check the one asset every single render needs. A silently-empty mirror
# would fall back to nothing (a 404, not the old CDN), so fail loudly here rather
# than at paint time in the desktop app.
if [ ! -f "$DEST/js/lute/lute.min.js" ]; then
  echo "ERR: vditor mirror is missing js/lute/lute.min.js after copy" >&2
  exit 1
fi

echo "$VERSION" > "$STAMP"
echo "vditor-runtime: mirrored vditor v$VERSION into $DEST/ ($(du -sh "$DEST" | cut -f1))"
