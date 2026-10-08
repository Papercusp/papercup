#!/usr/bin/env bash
# Maintained isolated desktop leg; synthetic transports never enter product code.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$(mktemp -d /tmp/dao-workbench-identity.XXXXXX)"
trap 'rm -rf -- "$FIXTURE_DIR"' EXIT
node "$ROOT/scripts/fixtures/dao-workbench-identity.mjs" --prepare "$FIXTURE_DIR" >/dev/null
node --import tsx "$ROOT/scripts/tauri-surface-verify-dao-workbench.mts" --check-imports
VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
  VERIFY_TAURI_REQUIRE_BUILT='apps/operator-vite/src/components/dao/DaoWorkspace.tsx apps/operator-vite/src/components/dao/DaoGovernance.tsx apps/operator/app/_components/ChromeShell.tsx packages/operator-core/lib/chromeless-routes.ts packages/operator-core/lib/agent-tools/plans/governance-event.ts' \
  DAO_WORKBENCH_IDENTITY_FIXTURE="$FIXTURE_DIR/identity.json" \
  PAPERCUSP_VERIFY_TAURI_ISOLATED=1 \
  NODE_OPTIONS="${NODE_OPTIONS:-} --import=$ROOT/scripts/fixtures/dao-workbench-identity.mjs" \
  "${TAURI_SURFACE_VERIFY_SUITE_VERIFIER:-$ROOT/scripts/verify-tauri-headless.sh}" -- \
  node --import tsx "$ROOT/scripts/tauri-surface-verify-dao-workbench.mts"
