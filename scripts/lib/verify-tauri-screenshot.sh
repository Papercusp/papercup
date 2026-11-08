#!/usr/bin/env bash
# Shared native capture adapter, extracted from the ticket-integrations leg.
# A bridge PID alone is not a screenshot target; title fallback can capture a
# different process. Resolve the verifier's visible Tauri window explicitly.
capture_screenshot() {
  local target="$1" status window_id capture_tool
  capture_tool="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
  window_id="$(
    "$capture_tool" list-windows --json |
      node - "$VERIFY_TAURI_PID" 3<&0 <<'NODE'
const fs = require('node:fs');
const [pidText] = process.argv.slice(2);
const pid = Number(pidText);
let windows;
try {
  windows = JSON.parse(fs.readFileSync(3, 'utf8'));
} catch (error) {
  console.error(`window-inventory-json:${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!Array.isArray(windows) || !Number.isInteger(pid) || pid <= 0) {
  console.error('window-inventory-shape');
  process.exit(1);
}
const candidates = windows
  .filter((window) => Number(window?.pid) === pid && window?.tauri === true)
  .filter((window) => Number.isFinite(window?.width) && Number.isFinite(window?.height))
  .filter((window) => window.width > 0 && window.height > 0)
  .sort((a, b) => (b.width * b.height) - (a.width * a.height));
if (candidates.length === 0 || !/^[0-9]+$/.test(String(candidates[0].windowId))) {
  console.error(`no-owned-tauri-window:pid=${pidText}`);
  process.exit(1);
}
process.stdout.write(String(candidates[0].windowId));
NODE
  )" || {
    echo "Could not resolve a visible Tauri window for verifier PID $VERIFY_TAURI_PID" >&2
    return 1
  }
  "$capture_tool" screenshot --window-id "$window_id" --output "$target" >"$target.stdout.log" 2>"$target.stderr.log"
  status=$?
  if [ "$status" -ne 0 ]; then
    cat "$target.stderr.log" >&2
    cat "$target.stdout.log" >&2
    return "$status"
  fi
  [ -s "$target" ] || { echo "Screenshot command produced no image: $target" >&2; return 1; }
}
