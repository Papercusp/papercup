#!/usr/bin/env bash
# Build the companion zellij plugin (wasm) and install it where `pui` looks for
# it. (SP-TUI P-004 / D-008.)
#
#   ./scripts/build-install.sh
#
# Produces pui_companion.wasm under the EFFECTIVE cargo target dir (crate-local
# target/ unless $CARGO_TARGET_DIR or a [build] target-dir config redirects it —
# this box shares one cache at ~/.cargo-target) and copies it to
# ~/.papercusp/pui-companion.wasm — the path `pui` resolves by default (override
# with $PUI_COMPANION_WASM). Run `rustup target add wasm32-wasip1` once first.
#
# NOTE on the build target: this crate is a `bin`, not a `cdylib`. zellij's
# loader requires a callable `_start` export; a wasm32-wasip1 *cdylib* is a
# "reactor" (no `_start`) and zellij rejects it with "could not find exported
# function". A `bin` is a "command" module and exports `_start`. (See the crate
# doc-comment / Cargo.toml.)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ building pui_companion.wasm (release, wasm32-wasip1)…"
cargo build --release --target wasm32-wasip1

# Resolve the EFFECTIVE target dir: a $CARGO_TARGET_DIR env or a [build]
# target-dir config (this box: shared ~/.cargo-target cache, ~/.cargo/config.toml)
# redirects artifacts away from crate-local target/. Hardcoding `target/` broke
# the install ("cannot stat") while the build itself was green (P-002 2026-08-24).
TARGET_DIR="$(cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
TARGET_DIR="${TARGET_DIR:-target}"

DEST="${PUI_COMPANION_WASM:-$HOME/.papercusp/pui-companion.wasm}"
mkdir -p "$(dirname "$DEST")"
cp "$TARGET_DIR/wasm32-wasip1/release/pui_companion.wasm" "$DEST"
echo "→ installed to $DEST"

cat <<'EOF'

Done. `pui`, when run inside a zellij session, will spawn the companion over
`zellij pipe`. The FIRST load shows a one-time zellij permission prompt — press
`y` in the plugin pane to grant (ReadApplicationState / ChangeApplicationState /
RunCommands / ReadCliPipes). zellij then caches the grant in
~/.cache/zellij/permissions.kdl keyed by the BARE wasm path (no `file:` prefix).

To verify the live duplex end-to-end (own isolated zellij session, no prompt):
  python3 scripts/live-smoke.py
EOF
