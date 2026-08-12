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
# :3170 staging, :3070 dev) invoke it by absolute path
# [MEASURED 2026-08-10, EI-20093985382484201 — that list is no longer accurate,
#  and it matters because it is what an agent reads to decide the blast radius
#  of an edit here:
#    :3170 staging  → THIS tree's copy (absolute path into papercupai-workspace/papercusp)
#    :3070 dev      → the RELEASE checkout's copy (papercup-release/...), so an
#                     edit here reaches it only after the deploy pipeline promotes it
#    :3270 bg-host  → has NO ExecStartPre at all today (`systemctl --user show
#                     papercup-bg-host.service -p ExecStartPre` prints nothing, and
#                     the service has no 95-bundled-entry.conf drop-in) — that
#                     missing drop-in is filed separately as EI-9408]
# — but a human or agent
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

# WI-38221 memory trim (measured 2026-08-12). Packages whose SOURCE the host
# pays for in every process but which a request-serving worker never executes.
# esbuild wraps CJS deps in a lazy __commonJS thunk, so these already never RUN
# — but the bundle still carries their full source, and V8 still parses it, in
# all 17 host processes on this box. Dropping them takes the bundle 61.2 -> 36.4
# MB and a host process 206.2 -> 140.9 MB RSS (~1.08 GB box-wide); with the
# ascii-escape pass below, 113.4 MB (~1.54 GB).
#
# The codebase ALREADY tried to get this with source-level `await import()`
# (agent-mcp/src/delta-eval-harness.ts:37 "ships multi-MB BPE rank tables",
# tooldef/parse-check.ts:32) and got ZERO benefit: esbuild INLINES dynamic
# imports into the same bundle unless --splitting. `--external:` is the lever
# that actually works.
#
# ⚠ EXTERNAL ⇒ RESOLVED FROM node_modules AT RUNTIME. Every entry below is
# verified to resolve to real .js (not .ts) from the bundle's own directory in
# BOTH this tree and papercup-release. Re-run
# `node .papercusp/scratch/verify-externals.mjs <bundle> <dir>` before adding
# one. Do NOT reach for the blanket `--packages=external`: it externalizes the
# @papercusp/* workspace packages too, 80 of which resolve to .ts SOURCE that
# plain node cannot load — precompiling exactly that graph is why this bundle
# exists (WI-3336, no tsx loader). It measures well and cannot boot.
#
# The packaged desktop app is NOT affected: papercusp-desktop/bin/build-desktop-sidecar.sh
# is an independent script with its own esbuild call, and MUST keep bundling its
# deps (it has no node_modules at runtime).
HOST_EXTERNALS+=(
  # 9.61 MB — the whole TypeScript compiler, reached via content-lint/registry
  # from git-sync/run-git-sync.ts, which a request worker never runs.
  --external:typescript
  # 5.34 MB of BPE rank tables; only the delta-eval harness tokenizes.
  --external:js-tiktoken
  # ~7 MB voice stack — not on the request path.
  --external:phonemizer
  --external:opusscript
  --external:@jitsi/rnnoise-wasm
  # test infrastructure, in production.
  --external:testcontainers
  --external:dockerode
  --external:esbuild
)

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

# EI-20093985382484201: A BUNDLE FAILURE MUST NOT TAKE THE SERVICE DOWN.
# ExecStartPre runs this on EVERY restart against the LIVE shared tree, which
# many agents edit continuously — so that tree is INVALID for the seconds
# between two keystrokes of any multi-part edit. Before this guard a transient
# syntax error made ExecStartPre exit non-zero, systemd refused to start the
# unit, and Restart=always + RestartSec=5 re-bundled the same broken tree every
# 5s (~14s CPU per attempt). Measured 2026-08-10: ONE unescaped apostrophe in a
# tool `description:` string took :3170 down fleet-wide for ~52s across 4
# attempts — the SECOND such outage that day, a different typo by a different
# agent. The typo is unremarkable and WILL recur; the outage is the defect.
#
# The fallback is cheap ONLY because of the atomic swap above (EI-9413):
# esbuild writes $TMPFILE and we rename it into place, so a FAILED build leaves
# the last-known-good $OUTFILE byte-intact on disk. We just boot it.
#
# Deliberately LOUD, never silent. Serving a stale bundle is its own hazard —
# an agent can verify against code that is not what is on disk — so we write
# $STALE_MARKER and /api/health surfaces it (see
# packages/operator-core/lib/bundle-staleness.ts). A VISIBLY-stale service is
# strictly better than a down one; an INVISIBLY-stale one is worse than both.
STALE_MARKER="$(dirname "$OUTFILE")/.bundle-stale.json"
BUILD_LOG="$OUTFILE.build-error.log"

echo "→ esbuild-bundling $ENTRY → $OUTFILE (plain-node host entry, no tsx loader)"
bundle_rc=0
# `if ! ( … )` rather than a bare call: `set -e` would otherwise kill the script
# at precisely the failure this block exists to survive. Output is captured to a
# file so it can be BOTH echoed to the journal and parsed into the marker.
if ! (
  flock -w 120 9 || { echo "ERROR: timed out waiting for bundle lock $LOCKFILE (another build stuck?)"; exit 1; }
  npx --yes esbuild@0.25.0 "$ENTRY" \
    --bundle --platform=node --format=esm --target=node22 \
    --outfile="$TMPFILE" \
    --banner:js="$HOST_BANNER" \
    --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
    --log-limit=20 \
    "${HOST_EXTERNALS[@]}"
  # WI-38221: widen-avoidance pass. Runs on $TMPFILE, BEFORE the atomic rename
  # below, so the swap stays atomic and a failure here leaves the last-known-good
  # $OUTFILE untouched. The helper never exits non-zero — a bundle that skipped
  # the escape is correct, just fatter, and is not worth failing a boot over.
  node "$SCRIPT_DIR/ascii-escape-bundle.mjs" "$TMPFILE"
  mv -f "$TMPFILE" "$OUTFILE"
) 9>"$LOCKFILE" >"$BUILD_LOG" 2>&1; then
  bundle_rc=1
fi
cat "$BUILD_LOG"

if [[ $bundle_rc -ne 0 ]]; then
  if [[ -f "$OUTFILE" ]]; then
    node "$SCRIPT_DIR/write-bundle-stale-marker.mjs" \
      "$STALE_MARKER" "$ENTRY" "$OUTFILE" "$BUILD_LOG" || true
    echo "🚨 ERROR: bundling $ENTRY FAILED — the esbuild error is above."
    echo "🚨 FALLING BACK to the last-known-good bundle already on disk:"
    echo "🚨   $OUTFILE (built $(date -r "$OUTFILE" -Iseconds 2>/dev/null || echo unknown))"
    echo "🚨 The service STARTS, but on STALE CODE. /api/health reports bundleStale."
    echo "🚨 Marker: $STALE_MARKER — fix the source error and restart to clear it."
    # NOTHING else on disk is touched. The blueprints/, sql/ and worker-script
    # publishes below are SKIPPED so dist-host/ stays exactly as the last
    # SUCCESSFUL build left it — a coherent bundle+assets set, rather than a
    # stale bundle sitting beside assets freshly published from a newer tree.
    exit 0
  fi
  echo "ERROR: bundling $ENTRY failed and there is NO previous bundle at $OUTFILE"
  echo "       to fall back to. Refusing to start rather than exec a missing entrypoint."
  exit 1
fi

# Success: the running code matches the tree again, so retract any stale claim.
rm -f "$STALE_MARKER"
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

# SAME CLASS AS WI-4196 ABOVE, missed for this worker: cpu-task-worker.ts resolves
# `cpu-task-worker.script.mjs` next to the executing module, which inside the bundle
# is $OUTDIR. Without this copy `serializeJsonResponse` catches the spawn failure,
# sets _workerDisabled, and every large batch falls back to INLINE synchronous
# JSON.stringify ON THE MAIN EVENT LOOP — precisely what that worker exists to
# prevent. It fails silently and looks like nothing is wrong. Measured 2026-08-04:
# :3170 (bundled) had no such file, and its loop profile at p95 1920ms was 87.5% GC
# with node:buffer/JSON frames on top (EI-19465075959589134). Plain ESM already, so
# a copy suffices — no esbuild pass needed.
CPU_WORKER_SRC="../../packages/operator-core/lib/cpu-task-worker.script.mjs"
if [[ -f "$CPU_WORKER_SRC" ]]; then
  cp "$CPU_WORKER_SRC" "$OUTDIR/cpu-task-worker.script.mjs"
  echo "    ✓ bundled cpu-task-worker script beside the entry"
else
  echo "WARNING: cpu-task-worker script not found at $CPU_WORKER_SRC — large batches will JSON.stringify inline on the event loop"
fi

# THIRD instance of the WI-4196 class (WI-37555): @papercusp/rerank's
# local-reranker-worker.ts resolves `local-reranker-worker.script.mjs` next to the
# executing module, which inside the bundle is $OUTDIR. Without this copy the
# worker spawn fails, the engine catches it and every rerank falls back to INLINE
# main-thread ONNX — which silently re-opens EI-20005411672741677: the caller's
# timeout bound stops being exact and degrades to bounded-by-one-batch (~720ms of
# overrun), and the corpus leg has only 500ms of headroom, so it times out to
# `empty('timed-out')` and the agent gets NO pointer section at all.
# `worker-scripts-bundled.test.ts` now fails if a FOURTH worker script is added
# without a copy here, so this class stops recurring by hand-memory.
RERANK_WORKER_SRC="../../libs/generic/rerank/src/local-reranker-worker.script.mjs"
if [[ -f "$RERANK_WORKER_SRC" ]]; then
  cp "$RERANK_WORKER_SRC" "$OUTDIR/local-reranker-worker.script.mjs"
  echo "    ✓ bundled @papercusp/rerank reranker-worker script beside the entry"
else
  echo "WARNING: reranker-worker script not found at $RERANK_WORKER_SRC — reranking will run inline (timeout bound degrades to one batch; WI-37555)"
fi

# Blocked-event-loop sentinel worker (EI-19465075959589134). Unlike the two above
# this one is TypeScript and imports the shared decider, so a plain copy cannot work:
# the bundled host runs `node dist-host/hono-host.mjs` with NO tsx loader, so a .ts
# worker would fail to load. esbuild it to a self-contained .mjs beside the entry;
# the host's workerPath() prefers the .mjs and falls back to the .ts for tsx runtimes
# (dev/desktop). Keeping ONE decider — bundled here, imported directly under tsx —
# is deliberate: a hand-maintained .mjs copy of this logic could drift, and this is
# the logic that SIGKILLs the host.
SENTINEL_WORKER_SRC="../../packages/operator-core/lib/event-loop-sentinel.worker.ts"
if [[ -f "$SENTINEL_WORKER_SRC" ]]; then
  npx --yes esbuild@0.25.0 "$SENTINEL_WORKER_SRC" \
    --bundle --platform=node --format=esm --target=node22 \
    --outfile="$OUTDIR/event-loop-sentinel.worker.mjs" \
    --log-limit=5 \
    && echo "    ✓ bundled event-loop sentinel worker beside the entry" \
    || echo "WARNING: sentinel worker bundle FAILED — the host will run with NO blocked-loop detection"
else
  echo "WARNING: sentinel worker not found at $SENTINEL_WORKER_SRC — the host will run with NO blocked-loop detection"
fi
