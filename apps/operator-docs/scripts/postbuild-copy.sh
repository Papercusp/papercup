#!/usr/bin/env bash
#
# postbuild-copy.sh — deploy the built Starlight docs into the operator.
#
# Astro builds the engineering docs into ./dist with `base: '/internal/docs'`
# and `build.format: 'file'` (so pages are emitted as `<slug>.html`, not
# `<slug>/index.html`). The operator's Next app serves apps/operator/public/
# at the web root and next.config.js rewrites bare-slug requests to their
# `.html` twin — so deploying the docs is just mirroring dist/ into
# apps/operator/public/internal/docs/.
#
# This script is wired into `npm run build` (astro build && bash this).
# It runs with cwd = apps/operator-docs.
#
set -euo pipefail

SRC="dist"
DEST="../operator/public/internal/docs"

if [[ ! -d "$SRC" ]]; then
  echo "postbuild-copy: '$SRC' not found — run 'astro build' first" >&2
  exit 1
fi

mkdir -p "$DEST"

# Mirror dist/ → public/internal/docs/, deleting stale files so removed or
# renamed pages don't linger. rsync is preferred; fall back to rm+cp.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$SRC"/ "$DEST"/
else
  rm -rf "${DEST:?}"/*
  cp -R "$SRC"/. "$DEST"/
fi

echo "postbuild-copy: $(find "$DEST" -type f | wc -l | tr -d ' ') files → $DEST"
