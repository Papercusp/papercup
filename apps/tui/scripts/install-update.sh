#!/usr/bin/env bash
# Canonical pui install/update path: one source generation produces the native
# pui binary, companion WASM, their embedded identities, and one manifest.
# This script never kills a process or zellij session. `pui doctor` reports any
# stale long-lived pane and gives a session-scoped relaunch instruction.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: ./apps/tui/scripts/install-update.sh

Build and install one matched pui generation:
  ~/.cargo/bin/pui
  ~/.papercusp/pui-companion.wasm
  ~/.papercusp/pui-install.json

The installer never stops a process or zellij session. It finishes by running
`pui doctor`, which reports stale panes and prints a narrowly-scoped relaunch.
EOF
  exit 0
fi

for tool in cargo git python3 sha256sum; do
  command -v "$tool" >/dev/null || {
    echo "missing required tool: $tool" >&2
    exit 1
  }
done

SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=normal -- apps/tui apps/pui-zellij-plugin apps/pui-companion-proto)" ]]; then
  SOURCE_DIRTY=1
else
  SOURCE_DIRTY=0
fi
BUILD_EPOCH="$(date +%s)"
export PUI_BUILD_SHA="$SOURCE_SHA"
export PUI_BUILD_DIRTY="$SOURCE_DIRTY"
export PUI_BUILD_EPOCH="$BUILD_EPOCH"

echo "→ building pui companion (source ${SOURCE_SHA:0:12}, dirty=$SOURCE_DIRTY)…"
cargo build \
  --manifest-path "$ROOT/apps/pui-zellij-plugin/Cargo.toml" \
  --release \
  --locked \
  --target wasm32-wasip1

PLUGIN_TARGET_DIR="$(cargo metadata \
  --manifest-path "$ROOT/apps/pui-zellij-plugin/Cargo.toml" \
  --format-version 1 \
  --no-deps \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
WASM_SOURCE="$PLUGIN_TARGET_DIR/wasm32-wasip1/release/pui_companion.wasm"
[[ -f "$WASM_SOURCE" ]] || {
  echo "companion build did not produce $WASM_SOURCE" >&2
  exit 1
}
PUI_COMPANION_SHA256="$(sha256sum "$WASM_SOURCE" | awk '{print $1}')"
export PUI_COMPANION_SHA256

echo "→ building + installing pui with the same generation…"
cargo install --path "$ROOT/apps/tui" --locked --force

CARGO_BIN_DIR="${CARGO_HOME:-$HOME/.cargo}/bin"
BINARY_PATH="$CARGO_BIN_DIR/pui"
WASM_PATH="${PUI_COMPANION_WASM:-$HOME/.papercusp/pui-companion.wasm}"
MANIFEST_PATH="${PUI_INSTALL_MANIFEST:-$HOME/.papercusp/pui-install.json}"
mkdir -p "$(dirname "$WASM_PATH")" "$(dirname "$MANIFEST_PATH")"
WASM_TMP="$WASM_PATH.tmp.$$"
install -m 0644 "$WASM_SOURCE" "$WASM_TMP"
mv -f "$WASM_TMP" "$WASM_PATH"

BINARY_SHA256="$(sha256sum "$BINARY_PATH" | awk '{print $1}')"
WASM_SHA256="$(sha256sum "$WASM_PATH" | awk '{print $1}')"

python3 - \
  "$MANIFEST_PATH" \
  "$SOURCE_SHA" \
  "$SOURCE_DIRTY" \
  "$BUILD_EPOCH" \
  "$BINARY_PATH" \
  "$BINARY_SHA256" \
  "$WASM_PATH" \
  "$WASM_SHA256" <<'PY'
import json
import os
import sys

(
    manifest_path,
    source_sha,
    source_dirty,
    built_at_epoch,
    binary_path,
    binary_sha256,
    companion_path,
    companion_sha256,
) = sys.argv[1:]
payload = {
    "schemaVersion": 1,
    "sourceSha": source_sha,
    "sourceDirty": source_dirty == "1",
    "builtAtEpoch": int(built_at_epoch),
    "binaryPath": binary_path,
    "binarySha256": binary_sha256,
    "companionPath": companion_path,
    "companionSha256": companion_sha256,
}
tmp = f"{manifest_path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.replace(tmp, manifest_path)
PY

echo "→ installed pui generation ${SOURCE_SHA:0:12}"
echo "  binary:    $BINARY_PATH"
echo "  companion: $WASM_PATH"
echo "  manifest:  $MANIFEST_PATH"
echo "→ verifying with pui doctor (guidance only; no process/session is killed)…"
"$BINARY_PATH" doctor
