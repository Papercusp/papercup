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
# an arbitrary entry. The packaged desktop app has shipped the full
# host-handler/host-bootstrap graph this way for weeks, so the graph is known
# bundle-safe. If you change the banner/externals here, check whether
# build-desktop-sidecar.sh needs the same change (and vice versa); unifying the
# two into one shared script is a welcome follow-up (the sidecar side is
# release-critical and needs a full packaged-build verify, so it was not churned
# in the WI-3336 pass).
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
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENTRY="${1:-bin/hono-host.ts}"
OUTFILE="${2:-dist-host/hono-host.mjs}"

# ESM output: the host graph contains `import.meta.url` (a CJS bundle rejects
# it). ESM has no `__dirname`/`__filename`/`require`, so the banner re-creates
# them. The dummy `module`/`exports` neutralise the CJS
# `if (require.main === module)` CLI-guard idiom inside bundled files (always
# false → guard body skipped, correct: they are not the entrypoint).
HOST_BANNER="import{createRequire as __pcr}from'module';import{fileURLToPath as __pftu}from'url';import{dirname as __pdn}from'path';const require=__pcr(import.meta.url);const __filename=__pftu(import.meta.url);const __dirname=__pdn(__filename);const module={exports:{}};const exports=module.exports;"

# Native (.node-addon) packages esbuild cannot inline — they resolve platform
# binaries relative to their real package dir. On the dev host they resolve
# from the tree's node_modules at runtime (bare-specifier imports stay
# external). Same list as build-desktop-sidecar.sh.
NATIVE_PKGS=(
  sodium-native udx-native rocksdb-native quickbit-native rabin-native
  simdle-native fs-native-extensions
  bare-fs bare-os bare-url bare-inspect bare-type
  better-sqlite3
  ssh2
)
HOST_EXTERNALS=(
  --external:@lydell/*
  --external:bufferutil
  --external:utf-8-validate
  --external:fsevents
  --external:cpu-features
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
  # @opentelemetry/* SDK packages — @dbos-inc/dbos-sdk lazily require()s these
  # only behind tracingEnabled (never enabled here); they are not installed.
  --external:@opentelemetry/context-async-hooks
  --external:@opentelemetry/core
  --external:@opentelemetry/resources
  --external:@opentelemetry/sdk-trace-base
  --external:@opentelemetry/sdk-trace-node
  --external:@opentelemetry/sdk-logs
  --external:@opentelemetry/sdk-metrics
  --external:@opentelemetry/exporter-trace-otlp-proto
  --external:@opentelemetry/exporter-logs-otlp-proto
  --external:@opentelemetry/exporter-metrics-otlp-proto
)
for np in "${NATIVE_PKGS[@]}"; do HOST_EXTERNALS+=( "--external:$np" ); done

# __PAPERCUSP_BUNDLED_SIDECAR__: every inlined module shares ONE
# import.meta.url (the bundle's own, == process.argv[1]), so library-CLI ESM
# self-exec guards would all fire at boot. isCliEntry()
# (operator-core/lib/util/cli-entry.ts) returns false under this define — its
# ONLY consumer (verified 2026-07-07). Unlike the sidecar build we bake NO
# version/dogfood-ref defines: the dev host reads live process.env.
echo "→ esbuild-bundling $ENTRY → $OUTFILE (plain-node host entry, no tsx loader)"
npx --yes esbuild@0.25.0 "$ENTRY" \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile="$OUTFILE" \
  --banner:js="$HOST_BANNER" \
  --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
  --log-limit=20 \
  "${HOST_EXTERNALS[@]}"

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
rm -rf "$OUTDIR/blueprints"
mkdir -p "$OUTDIR/blueprints"
cp -R "$HARNESS_BLUEPRINTS_SRC"/. "$OUTDIR/blueprints/"
if [[ ! -f "$OUTDIR/blueprints/base/blueprint.yaml" ]]; then
  echo "ERROR: bundled $OUTDIR/blueprints is missing base/blueprint.yaml"
  exit 1
fi
echo "    ✓ bundled @papercusp/harness blueprints include base/blueprint.yaml"

LOCKS_SQL_SRC="${PAPERCUSP_LOCKS_SQL_DIR:-../../libs/papercusp/packages/locks/src/sql}"
if [[ ! -d "$LOCKS_SQL_SRC" ]]; then
  echo "ERROR: @papercusp/locks SQL dir not found at $LOCKS_SQL_SRC"
  exit 1
fi

echo "→ bundling @papercusp/locks DDL → $OUTDIR/sql"
rm -rf "$OUTDIR/sql"
mkdir -p "$OUTDIR/sql"
cp "$LOCKS_SQL_SRC/"*.sql "$OUTDIR/sql/"

_locks_sql_max="$(ls "$LOCKS_SQL_SRC/"*.sql 2>/dev/null | xargs -n1 basename | grep -oE '^[0-9]+' | sort -n | tail -1)"
_locks_sql_count="$(ls "$LOCKS_SQL_SRC/"*.sql 2>/dev/null | wc -l | tr -d ' ')"
_bundled_locks_sql_max="$(ls "$OUTDIR/sql/"*.sql 2>/dev/null | xargs -n1 basename | grep -oE '^[0-9]+' | sort -n | tail -1)"
_bundled_locks_sql_count="$(ls "$OUTDIR/sql/"*.sql 2>/dev/null | wc -l | tr -d ' ')"
if [[ -z "$_locks_sql_max" || "$_locks_sql_max" != "$_bundled_locks_sql_max" || "$_locks_sql_count" != "$_bundled_locks_sql_count" ]]; then
  echo "ERROR: bundled $OUTDIR/sql/ (highest=$_bundled_locks_sql_max, count=$_bundled_locks_sql_count) does not match"
  echo "       source $LOCKS_SQL_SRC (highest=$_locks_sql_max, count=$_locks_sql_count)"
  exit 1
fi
echo "    ✓ bundled @papercusp/locks DDL matches the tree (highest migration $_locks_sql_max, $_locks_sql_count files)"
