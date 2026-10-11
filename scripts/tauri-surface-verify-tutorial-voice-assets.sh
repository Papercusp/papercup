#!/usr/bin/env bash
# Read-only native audio-asset acceptance; reuse the owned bridge/source/test-ledger driver.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PAPERCUSP_TEST_RUNS_DB_URL="$(node --input-type=module -e 'import { resolveExecutedMapPgUrl } from "./scripts/lib/executed-source-map.mjs"; process.stdout.write(resolveExecutedMapPgUrl().url)')"
export PAPERCUSP_TEST_RUN_HARNESS="${PAPERCUSP_TEST_RUN_HARNESS:-papercusp}"
export PAPERCUSP_TEST_RUN_WORKSPACE="${PAPERCUSP_TEST_RUN_WORKSPACE:-${PAPERCUSP_WORKSPACE_ID:-${PAPERCUSP_WORKSPACE:-}}}"
: "${PAPERCUSP_TEST_RUN_WORKSPACE:?Native asset acceptance requires the caller workspace}"
export VERIFY_TAURI_SOURCE_INPUTS="${VERIFY_TAURI_SOURCE_INPUTS:+$VERIFY_TAURI_SOURCE_INPUTS,}packages/operator-core/lib/onboarding/tutorial-voice-assets-native.e2e.test.ts,apps/operator/scripts/setup-elevenlabs-runtime.mjs,scripts/tauri-surface-verify-tutorial-voice-assets.sh"
export VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS=rawAudioProcessor
exec bash "$ROOT/scripts/verify-tauri-headless.sh" -- node --import tsx --input-type=module -e '
  const { runNativeE2e } = await import("./scripts/tauri-surface-verify-reports.mts");
  await runNativeE2e(["packages/operator-core/lib/onboarding/tutorial-voice-assets-native.e2e.test.ts"],
    { runtimeUnit: "tutorial-voice-assets-native-desktop" });
'
