#!/usr/bin/env bash
# Run all the bun-based smoke tests for the plugin runtime. These are
# in addition to the vitest suite (which the local node_modules
# symlink loop blocks); CI runs both.
#
# Each test file is self-contained — no fixtures, no PG, no network.
# bun is required (npm install -g bun, or use the workspace's bunx).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
for f in "$here"/*.test.mjs "$here/../../plugin-sdk/test"/*.test.mjs "$here/../../../apps/operator/test"/iframe-navigate-cap.test.mjs; do
  [[ -f $f ]] || continue
  echo "=== $(basename "$f") ==="
  if ! bun "$f"; then
    fail=$((fail+1))
    echo "FAIL: $f"
  fi
done
echo
if [[ $fail -gt 0 ]]; then
  echo "$fail test files failed"
  exit 1
fi
echo "all bun smoke tests passed"
