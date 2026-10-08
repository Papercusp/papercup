#!/usr/bin/env bash
# Maintained isolated desktop leg; synthetic transports never enter product code.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/libs/generic/verification-harness/bin/vh.sh"
vh_phase preflight ""
vh_phase desktop preflight
vh_phase mobile desktop
vh_init dao-workbench "${DAO_WORKBENCH_HARNESS_EVIDENCE_ROOT:-/tmp/pcv/dao-workbench}"
vh_begin preflight
FIXTURE_DIR="$(mktemp -d /tmp/dao-workbench-identity.XXXXXX)"
trap 'rm -rf -- "$FIXTURE_DIR"' EXIT
vh_bracket_trap
node "$ROOT/scripts/fixtures/dao-workbench-identity.mjs" --prepare "$FIXTURE_DIR" >/dev/null
node --import tsx "$ROOT/scripts/tauri-surface-verify-dao-workbench.mts" --check-imports
# The maintained verifier applies geometry before mapping the native window.
# Each viewport owns a fresh isolated boot; no runtime window permissions needed.
for viewport in 1440x1000 390x844; do
  if [ "$viewport" = 1440x1000 ]; then vh_begin desktop; else vh_begin mobile; fi
  assertion_args=()
  if [ "$viewport" = 390x844 ]; then assertion_args+=(--viewport-only); fi
  VERIFY_TAURI_WINDOW="$viewport" DAO_WORKBENCH_VIEWPORT="$viewport" \
  VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
  VERIFY_TAURI_REQUIRE_BUILT='apps/operator-vite/src/components/dao/DaoWorkspace.tsx apps/operator-vite/src/components/dao/DaoGovernance.tsx apps/operator-vite/src/components/dao/DaoExecution.tsx apps/operator-vite/src/components/dao/dao-workspace.css apps/operator/app/_components/ChromeShell.tsx packages/operator-core/lib/chromeless-routes.ts packages/operator-core/lib/agent-tools/plans/governance-event.ts' \
  DAO_WORKBENCH_IDENTITY_FIXTURE="$FIXTURE_DIR/identity.json" \
  PAPERCUSP_VERIFY_TAURI_ISOLATED=1 \
  NODE_OPTIONS="${NODE_OPTIONS:-} --import=$ROOT/scripts/fixtures/dao-workbench-identity.mjs" \
  "${TAURI_SURFACE_VERIFY_SUITE_VERIFIER:-$ROOT/scripts/verify-tauri-headless.sh}" -- \
  node --import tsx "$ROOT/scripts/tauri-surface-verify-dao-workbench.mts" "${assertion_args[@]}"
done
