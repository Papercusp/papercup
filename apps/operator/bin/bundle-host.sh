#!/usr/bin/env bash
# bundle-host.sh — esbuild-bundle a Hono-host entry into ONE plain-ESM file so
# it runs under plain `node`, with NO tsx register-loader (WI-3336).
#
# WHY: `npx tsx bin/hono-host.ts` installs tsx's module.register() worker
# loader — EVERY runtime import resolution becomes a synchronous Atomics.wait
# RPC to the hooks thread, blocking the main event loop. On bg-host boots the
# import storm wedged the loop for multi-second windows (worst measured single
# stall post-WI-3333: 6.1s; historic amplified case: 119s p95). tsx 4.21 has no
# sync-hooks (module.registerHooks) mode, and Node's native type-stripping
# can't resolve this repo's extensionless/path-alias imports — so precompiling
# the graph is the durable fix: plain `node dist-host/hono-host.mjs` pays zero
# loader RPCs.
#
# RECIPE PROVENANCE: this is the PROVEN sidecar recipe from
# papercusp-desktop/bin/build-desktop-sidecar.sh ("esbuild-bundling the serve
# entry") — same banner, same native/externals list, same define — pointed at
# an arbitrary entry. Shared inputs are sourced from bundle-host-common.sh;
# callers retain only their output- and platform-specific steps.
#
# Usage:
#   apps/operator/bin/bundle-host.sh [entry] [outfile]
#     entry    default bin/hono-host.ts   (relative to apps/operator)
#     outfile  default dist-host/hono-host.mjs
#
# Consumers:
#   - papercup-bg-host.service drop-in 95-bundled-entry.conf: ExecStartPre runs
#     this, ExecStart runs `node dist-host/hono-host.mjs`. Rebuilt on EVERY
#     service restart so a restart still picks up integration-tree edits
#     (same contract as the old tsx boot — do NOT cache across restarts, a
#     stale bundle silently runs old code, see
#     internal-docs/agent-insights/bg-host-runs-stale-routine-code.md).
set -euo pipefail
# EI-18808640677734527: resolve THIS script's directory ONCE, to an absolute
# path, BEFORE the cd below. `${BASH_SOURCE[0]}` holds the path AS INVOKED, so
# re-running `dirname` on it after a `cd` re-resolves a RELATIVE invocation
# against the new cwd — which broke the `source` at the bottom of this header
# for exactly the invocation this script's own Usage line documents
# (`apps/operator/bin/bundle-host.sh` from the repo root):
#   line 44: apps/operator/bin/bundle-host-common.sh: No such file or directory
# systemd never hit it because the three ExecStartPre users (:3270 bg-host,
# :3170 staging, :3070 dev) invoke it by absolute path — but a human or agent
# following the docs did, and the failure is quiet in the way that matters:
# the script exits non-zero having left `dist-host/hono-host.mjs` UNTOUCHED, so
# a restart afterwards silently runs the STALE bundle
# (internal-docs/agent-insights/bg-host-runs-stale-routine-code.md again).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

ENTRY="${1:-bin/hono-host.ts}"
OUTFILE="${2:-dist-host/hono-host.mjs}"

# ESM output: the host graph contains `import.meta.url` (a CJS bundle rejects
# it). ESM has no `__dirname`/`__filename`/`require`, so the banner re-creates
# them. The dummy `module`/`exports` neutralise the CJS
# `if (require.main === module)` CLI-guard idiom inside bundled files (always
# false → guard body skipped, correct: they are not the entrypoint).
source "$SCRIPT_DIR/bundle-host-common.sh"

# Native (.node-addon) packages esbuild cannot inline — they resolve platform
# binaries relative to their real package dir. On the dev host they resolve
# from the tree's node_modules at runtime (bare-specifier imports stay
# external). Same list as build-desktop-sidecar.sh.
HOST_EXTERNALS=(
  "${HOST_COMMON_EXTERNALS[@]}"
  # embedded-postgres platform packages: only the host platform is installed,
  # the rest are unresolvable dynamic imports.
  --external:@embedded-postgres/darwin-arm64
  --external:@embedded-postgres/darwin-x64
  --external:@embedded-postgres/linux-arm
  --external:@embedded-postgres/linux-arm64
  --external:@embedded-postgres/linux-ia32
  --external:@embedded-postgres/linux-ppc64
  --external:@embedded-postgres/windows-x64
  --external:@papercusp/embedded-postgres-server
)
for np in "${NATIVE_PKGS[@]}"; do HOST_EXTERNALS+=( "--external:$np" ); done

# self-exec guards would all fire at boot. isCliEntry()
# (operator-core/lib/util/cli-entry.ts) returns false under this define — its
# ONLY consumer (verified 2026-07-07). Unlike the sidecar build we bake NO
# version/dogfood-ref defines: the dev host reads live process.env.
# EI-9413: bundle-host.sh reruns on EVERY service restart (ExecStartPre), and
# systemd's restart-always can fire another attempt while a prior esbuild
# invocation's write to $OUTFILE hasn't finished flushing (or, on a wedged
# host, an orphaned esbuild child from an earlier attempt is still running) —
# two writers racing a non-atomic `--outfile` produces a torn/interleaved
# bundle that boots with a random `ReferenceError: X is not defined` for
# whichever symbol's bytes got clobbered (seen twice tonight: two DIFFERENT
# symbols on two DIFFERENT boots, same tree, same script — the signature of a
# write race, not a source bug). Two independent closures:
#  (1) flock serializes concurrent bundle-host.sh runs against the SAME
#      outfile instead of letting them race each other;
#  (2) esbuild writes to a private tmp file, then `mv` atomically renames it
#      into place — a reader (ExecStart) either sees the fully-old file or
#      the fully-new one, never a torn hybrid, even if step (1) is ever
#      bypassed (e.g. a killed/orphaned process holding the lock).
mkdir -p "$(dirname "$OUTFILE")"
LOCKFILE="$OUTFILE.build.lock"
TMPFILE="$OUTFILE.tmp.$$"
# EI-18119538868734274: the blueprints/ and sql/ asset directories below are
# published with the SAME tmp-then-atomic-swap discipline as $TMPFILE here —
# see the two "publish" comments further down for why (a live process's
# ensureBootstrap()/blueprint loader can call fs.readdirSync on these paths at
# ANY time, including mid-rebuild).
NEW_BLUEPRINTS_DIR=""
NEW_SQL_DIR=""
trap 'rm -f "$TMPFILE"; [[ -n "$NEW_BLUEPRINTS_DIR" ]] && rm -rf "$NEW_BLUEPRINTS_DIR"; [[ -n "$NEW_SQL_DIR" ]] && rm -rf "$NEW_SQL_DIR"' EXIT

echo "→ esbuild-bundling $ENTRY → $OUTFILE (plain-node host entry, no tsx loader)"
(
  flock -w 120 9 || { echo "ERROR: timed out waiting for bundle lock $LOCKFILE (another build stuck?)"; exit 1; }
  npx --yes esbuild@0.25.0 "$ENTRY" \
    --bundle --platform=node --format=esm --target=node22 \
    --outfile="$TMPFILE" \
    --banner:js="$HOST_BANNER" \
    --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
    --log-limit=20 \
    "${HOST_EXTERNALS[@]}"
  mv -f "$TMPFILE" "$OUTFILE"
) 9>"$LOCKFILE"

echo "✓ bundled: $(du -h "$OUTFILE" | cut -f1) $OUTFILE"

# @papercusp/locks is bundled into the host graph, so its su-lock-store resolves
# package-owned migrations relative to the bundle's import.meta.url:
#   dirname(dist-host/hono-host.mjs)/sql
# esbuild only emits JS, never sibling src/sql/*.sql assets. Keep this in sync
# with papercusp-desktop/bin/build-desktop-sidecar.sh's sidecar/sql copy.
OUTDIR="$(dirname "$OUTFILE")"

# @papercusp/harness is bundled into the host graph too. Its built-in blueprint
# resolver derives the package root from import.meta.url, so a plain-node bundle
# must carry the blueprint YAML/prompts beside the entry or an installed child
# blueprint such as oddsmith-prospector can resolve itself but fail its
# `extends: base` parent.
HARNESS_BLUEPRINTS_SRC="${PAPERCUSP_HARNESS_BLUEPRINTS_DIR:-../../libs/papercusp/packages/harness/blueprints}"
if [[ ! -d "$HARNESS_BLUEPRINTS_SRC" ]]; then
  echo "ERROR: harness blueprints dir not found at $HARNESS_BLUEPRINTS_SRC"
  exit 1
fi

echo "→ bundling @papercusp/harness blueprints → $OUTDIR/blueprints"
# EI-18119538868734274: publish via build-in-tmp-sibling + atomic `mv -T`
# rename, exactly like $TMPFILE above. The old rm-rf/mkdir/cp-in-place left a
# window (between the rm -rf and the cp finishing) where $OUTDIR/blueprints
# does not exist or is only partially populated — @papercusp/harness's
# blueprint resolver derives its root from import.meta.url and does a live
# fs.readdirSync/readFileSync against this exact path from an ALREADY-RUNNING
# process (a long-lived dev-api/bg-host process that hasn't loaded a blueprint
# yet), completely independent of this build's own process. `mv -T` performs a
# single same-filesystem rename() syscall, so any concurrent reader sees only
# the complete old tree or the complete new tree, never a torn one.
NEW_BLUEPRINTS_DIR="$OUTDIR/blueprints.new.$$"
rm -rf "$NEW_BLUEPRINTS_DIR"
mkdir -p "$NEW_BLUEPRINTS_DIR"
cp -R "$HARNESS_BLUEPRINTS_SRC"/. "$NEW_BLUEPRINTS_DIR/"
if [[ ! -f "$NEW_BLUEPRINTS_DIR/base/blueprint.yaml" ]]; then
  echo "ERROR: bundled $NEW_BLUEPRINTS_DIR is missing base/blueprint.yaml"
  exit 1
fi
# `mv -T` only performs a single-syscall atomic rename when the destination is
# ABSENT or an EMPTY directory — POSIX rename(2) itself refuses to replace a
# NON-empty directory (confirmed live: `mv -T new existing-nonempty-dir` fails
# "cannot overwrite: File exists"), and $OUTDIR/blueprints is non-empty on
# every rebuild after the first. So: rename the OLD tree out of the way first
# (freeing the name), then rename the NEW tree in — the same two-step swap
# already proven for this exact class of problem in
# papercusp-desktop/bin/build-desktop-sidecar.sh (EI-160/EI-200). This leaves
# a residual window of two back-to-back rename() syscalls (microseconds)
# instead of the original rm-rf+mkdir+`cp -R` window (however long the copy
# takes) — a many-orders-of-magnitude reduction, not a mathematical
# guarantee (POSIX cannot do better for a non-empty-directory swap).
if [[ -d "$OUTDIR/blueprints" ]]; then
  mv "$OUTDIR/blueprints" "$OUTDIR/blueprints.old.$$"
fi
mv "$NEW_BLUEPRINTS_DIR" "$OUTDIR/blueprints"
NEW_BLUEPRINTS_DIR=""
rm -rf "$OUTDIR/blueprints.old.$$" 2>/dev/null || true
echo "    ✓ bundled @papercusp/harness blueprints include base/blueprint.yaml"

LOCKS_SQL_SRC="${PAPERCUSP_LOCKS_SQL_DIR:-../../libs/papercusp/packages/locks/src/sql}"
if [[ ! -d "$LOCKS_SQL_SRC" ]]; then
  echo "ERROR: @papercusp/locks SQL dir not found at $LOCKS_SQL_SRC"
  exit 1
fi

echo "→ bundling @papercusp/locks DDL → $OUTDIR/sql"
# EI-18119538868734274: publish via build-in-tmp-sibling + atomic `mv -T`
# rename — same discipline as the blueprints/ publish above, and for the same
# reason. su-lock-store.ts's ensureBootstrap() is called LAZILY, on the first
# locks:* call of an already-running process's lifetime — that can happen at
# ANY wall-clock moment, including the split second an unrelated ExecStartPre
# rebuild is mid-way through `rm -rf $OUTDIR/sql; mkdir; cp`. Landed live:
# EI-18119538868734274 caught `ENOENT: no such file or directory, scandir
# '.../dist-host/sql'` from exactly that window (2 of 2259 calls — a narrow
# race, not a persistent misconfig). The old in-place rm-rf/mkdir/cp is the
# textbook non-atomic-publish bug (already fixed once for the sibling
# desktop-sidecar build under EI-160/EI-200 — see build-desktop-sidecar.sh);
# this closes the same class here instead of re-patching just this instance.
NEW_SQL_DIR="$OUTDIR/sql.new.$$"
rm -rf "$NEW_SQL_DIR"
mkdir -p "$NEW_SQL_DIR"
cp "$LOCKS_SQL_SRC/"*.sql "$NEW_SQL_DIR/"

_locks_sql_max="$(ls "$LOCKS_SQL_SRC/"*.sql 2>/dev/null | xargs -n1 basename | grep -oE '^[0-9]+' | sort -n | tail -1)"
_locks_sql_count="$(ls "$LOCKS_SQL_SRC/"*.sql 2>/dev/null | wc -l | tr -d ' ')"
_bundled_locks_sql_max="$(ls "$NEW_SQL_DIR/"*.sql 2>/dev/null | xargs -n1 basename | grep -oE '^[0-9]+' | sort -n | tail -1)"
_bundled_locks_sql_count="$(ls "$NEW_SQL_DIR/"*.sql 2>/dev/null | wc -l | tr -d ' ')"
if [[ -z "$_locks_sql_max" || "$_locks_sql_max" != "$_bundled_locks_sql_max" || "$_locks_sql_count" != "$_bundled_locks_sql_count" ]]; then
  echo "ERROR: bundled $NEW_SQL_DIR/ (highest=$_bundled_locks_sql_max, count=$_bundled_locks_sql_count) does not match"
  echo "       source $LOCKS_SQL_SRC (highest=$_locks_sql_max, count=$_locks_sql_count)"
  exit 1
fi
# Two-step rename-swap, not `mv -T` — see the blueprints publish above for
# why (mv -T cannot replace a non-empty existing directory; $OUTDIR/sql is
# non-empty on every rebuild after the first).
if [[ -d "$OUTDIR/sql" ]]; then
  mv "$OUTDIR/sql" "$OUTDIR/sql.old.$$"
fi
mv "$NEW_SQL_DIR" "$OUTDIR/sql"
NEW_SQL_DIR=""
rm -rf "$OUTDIR/sql.old.$$" 2>/dev/null || true
echo "    ✓ bundled @papercusp/locks DDL matches the tree (highest migration $_locks_sql_max, $_locks_sql_count files)"

# @papercusp/memory's local-embedder-worker.ts resolves its worker-thread
# script NEXT TO the executing module (dirname of import.meta.url) — inside a
# bundle that is $OUTDIR, and esbuild never emits sibling non-JS assets, so
# without this copy every embed silently falls back to INLINE main-thread ONNX
# inference (~6s/embed vs ~36ms via the worker; WI-4196). WARN instead of
# exiting: the runtime tolerates a missing worker (slow, not broken), and a
# hard failure here would block bg-host/sidecar boots over a perf asset.
EMBED_WORKER_SRC="${PAPERCUSP_EMBED_WORKER_SCRIPT:-../../libs/generic/memory/src/local-embedder-worker.script.mjs}"
if [[ -f "$EMBED_WORKER_SRC" ]]; then
  cp "$EMBED_WORKER_SRC" "$OUTDIR/local-embedder-worker.script.mjs"
  echo "    ✓ bundled @papercusp/memory embed-worker script beside the entry"
else
  echo "WARNING: embed-worker script not found at $EMBED_WORKER_SRC — embeds will run inline (slow; WI-4196)"
fi
