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

SRC=$(node -e "console.log(require.resolve('onnxruntime-web/package.json'))" 2>/dev/null \
      | xargs dirname 2>/dev/null \
      | sed 's|$|/dist|')

# Fallback to the openwakeword-js nested copy if root onnxruntime-web isn't
# hoisted (npm doesn't always hoist when versions diverge).
if [ ! -d "$SRC" ]; then
  SRC="$(pwd)/../../node_modules/openwakeword-js/node_modules/onnxruntime-web/dist"
fi

if [ ! -d "$SRC" ]; then
  echo "ERR: can't find onnxruntime-web/dist; install openwakeword-js first" >&2
  exit 1
fi

DEST="public/wake-runtime"
mkdir -p "$DEST"
cp "$SRC"/*.wasm "$DEST/" 2>/dev/null || true
cp "$SRC"/ort.bundle.min.mjs "$DEST/" 2>/dev/null || true

echo "Copied $(ls "$DEST" | wc -l) files to $DEST/"
ls "$DEST"
