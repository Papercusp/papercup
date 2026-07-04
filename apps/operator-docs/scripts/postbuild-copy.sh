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
# ── WI-1998: build elsewhere, publish atomically ────────────────────────────
# The old approach rsync'd dist/ STRAIGHT INTO the live DEST with --delete —
# an in-place mutation that, for a tree the size of the docs site, takes
# multiple seconds and deletes+rewrites files (incl. the pagefind search
# index shards) one at a time. Two concurrent readers of DEST race that
# window and lose: apps/operator-vite's Vite build copies its `publicDir`
# (which IS apps/operator/public, docs included) into its own dist/, and
# papercusp-desktop/bin/build-desktop-sidecar.sh separately `cp -a`s
# public/internal/docs/ into the packaged sidecar. Either copy can enumerate
# a pagefind shard via readdir, then ENOENT trying to read it a moment later
# once this script's rsync has already deleted/replaced it mid-run — failing
# the whole SPA build or the whole sidecar build on what is, from the
# operator's perspective, a routine docs regeneration.
#
# Fix: build the full mirror in an ISOLATED staging dir (a plain rsync/cp
# into an empty target, never touching the live DEST a reader might be
# mid-copy on), then PUBLISH it with two back-to-back rename() calls —
# swap the old DEST out of the way, swap the new tree in. This is the same
# "build a temp tree, publish atomically" pattern build-desktop-sidecar.sh
# itself already uses for its own SIDECAR_DIR (EI-160/P-056) — applied here
# to the docs deploy target that races it. The window a reader can lose in
# shrinks from "however long the rsync takes" (seconds, file-by-file) to the
# gap between two rename() syscalls (sub-millisecond): a reader that already
# opened DEST keeps reading the consistent pre-swap tree via its open file
# descriptor (Linux keeps an unlinked-but-open directory's contents alive);
# a reader that opens DEST after the swap sees the consistent new tree.
#
set -euo pipefail

SRC="dist"
DEST="../operator/public/internal/docs"
DEST_TMP="${DEST}.tmp.$$"
DEST_OLD="${DEST}.old.$$"

if [[ ! -d "$SRC" ]]; then
  echo "postbuild-copy: '$SRC' not found — run 'astro build' first" >&2
  exit 1
fi

# Clean up our own staging dirs on any exit (success, error, or interrupt) so
# a killed/failed run never leaves debris a later run has to reason about;
# after a successful publish these are already-removed no-ops.
trap 'rm -rf "$DEST_TMP" "$DEST_OLD"' EXIT

rm -rf "$DEST_TMP"
mkdir -p "$DEST_TMP"

# Mirror dist/ → the ISOLATED staging dir (not the live DEST). `--checksum`
# is kept as cheap insurance against a same-size/same-mtime re-emit (the
# original reason it was added, 2026-05-31) even though staging is always a
# fresh empty target now — belt-and-braces, not load-bearing here.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --checksum "$SRC"/ "$DEST_TMP"/
else
  cp -R "$SRC"/. "$DEST_TMP"/
fi

# Atomic-ish publish: swap the old tree out, swap the new tree in. A plain
# `mv "$DEST_TMP" "$DEST"` can't do this in one syscall when DEST already
# exists as a non-empty directory (rename(2) requires an empty target), hence
# the two-step swap via DEST_OLD.
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST_OLD"
if [[ -d "$DEST" ]]; then
  mv "$DEST" "$DEST_OLD"
fi
mv "$DEST_TMP" "$DEST"

echo "postbuild-copy: $(find "$DEST" -type f | wc -l | tr -d ' ') files → $DEST"
