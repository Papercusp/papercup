#!/usr/bin/env bash
# Copy onnxruntime-web's WASM binaries into apps/operator/public/wake-runtime/
# so the browser can load them when the user picks the openWakeWord engine.
#
# openwakeword-js bundles onnxruntime-web as a transitive dep; the runtime
# loads its WASM via runtime URLs that Turbopack/webpack can't resolve at
# compile time. Mirroring the binaries to a known public/ path lets us
# pass `wasmPaths: '/wake-runtime/'` to the Model constructor.
#
# Run after `npm install` (or whenever onnxruntime-web bumps).
set -euo pipefail

cd "$(dirname "$0")/.."

# require.resolve('pkg/package.json') fails for packages without ./package.json
# in their exports map (onnxruntime-web is one), and an empty pipeline trips
# xargs into running dirname with no args -> exit 123 under pipefail. Skip
# require.resolve and probe known node_modules paths directly.
SRC=""
for cand in \
  "$(pwd)/node_modules/onnxruntime-web/dist" \
  "$(pwd)/../../node_modules/onnxruntime-web/dist" \
  "$(pwd)/node_modules/openwakeword-js/node_modules/onnxruntime-web/dist" \
  "$(pwd)/../../node_modules/openwakeword-js/node_modules/onnxruntime-web/dist"; do
  if [ -d "$cand" ]; then
    SRC="$cand"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "ERR: can't find onnxruntime-web/dist; install openwakeword-js first" >&2
  exit 1
fi

DEST="public/wake-runtime"
mkdir -p "$DEST"
cp "$SRC"/*.wasm "$DEST/" 2>/dev/null || true
cp "$SRC"/ort.bundle.min.mjs "$DEST/" 2>/dev/null || true

echo "Copied $(ls "$DEST" | wc -l) files to $DEST/"
ls "$DEST"
