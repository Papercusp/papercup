#!/usr/bin/env bash
# Run the operator Playwright suite inside the isolated verify-tauri-headless rig and keep
# its per-file results in the SHARED test_runs ledger.
# (WI-10006736; plan operator-e2e-standing-isolated-run-2026-10-06, P-001.)
#
# Usage: scripts/run-operator-e2e-isolated.sh [playwright test args...]
#   No args runs the whole default-config suite. Extra args are forwarded to
#   `playwright test` (spec filters, --grep, --workers, ...). `--reporter` is refused:
#   a CLI reporter REPLACES the config's reporters, which disables the ledger reporter
#   (EI-25232220211651248).
#
# Exit code: Playwright's own code. 2 = refused argument. A rig boot failure passes its
# own non-zero code through unchanged.
#
# Why the ledger URL is resolved HERE: with VERIFY_TAURI_ISOLATED_DB=1 the rig exports
# HARNESS_ADMIN_DATABASE_URL pointing at its throwaway database before it runs the
# assertion command. The ledger reporters resolve PAPERCUSP_TEST_RUNS_DB_URL first, so
# pinning it to the shared ledger before entering the rig keeps the results; without it
# every isolated result is written into the throwaway database and destroyed at teardown
# (measured 2026-10-06 17:13Z: a 37-pass run left no shared rows). The app under test
# still sees the isolated HARNESS_ADMIN_DATABASE_URL, so isolation is unchanged.
#
# Env:
#   PAPERCUSP_TEST_RUNS_DB_URL  shared ledger; default = the caller's
#                               HARNESS_ADMIN_DATABASE_URL, else the operator default.
#   PAPERCUSP_TEST_RUN_GROUP    run group stamped on every row; default
#                               operator-e2e-isolated-<utc>-<pid>.
#   OPERATOR_E2E_RIG            rig command (default scripts/verify-tauri-headless.sh).
#   OPERATOR_E2E_PLAYWRIGHT     playwright command (default "npx playwright test").
#   The last two are test seams (apps/operator/lib/__tests__/e2e-isolated-runner.test.ts).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
DEFAULT_LEDGER_URL='postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp'

for arg in "$@"; do
  case "$arg" in
    --reporter | --reporter=*)
      echo "run-operator-e2e-isolated: refusing '$arg': a CLI reporter replaces the config reporters and disables the test_runs ledger reporter (EI-25232220211651248)" >&2
      exit 2
      ;;
  esac
done

export PAPERCUSP_TEST_RUNS_DB_URL="${PAPERCUSP_TEST_RUNS_DB_URL:-${HARNESS_ADMIN_DATABASE_URL:-$DEFAULT_LEDGER_URL}}"
export PAPERCUSP_TEST_RUN_GROUP="${PAPERCUSP_TEST_RUN_GROUP:-operator-e2e-isolated-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
# Ledger identity, pinned from the CALLER before the rig rebinds PAPERCUSP_WORKSPACE_ID to
# its throwaway verify-tauri-isolated-<display> workspace. The reporters resolve these
# ledger-only overrides first (resolveTestRunWorkspaceId / resolveTestRunHarnessSlug), so
# rows stay readable by workspace-scoped consumers; the app still sees the isolated ids.
# This suite is the papercusp harness's own, hence that harness default.
export PAPERCUSP_TEST_RUN_HARNESS="${PAPERCUSP_TEST_RUN_HARNESS:-${HARNESS_SLUG:-${PAPERCUSP_HARNESS_SLUG:-papercusp}}}"
PAPERCUSP_TEST_RUN_WORKSPACE="${PAPERCUSP_TEST_RUN_WORKSPACE:-${PAPERCUSP_WORKSPACE_ID:-${PAPERCUSP_WORKSPACE:-}}}"
if [ -n "$PAPERCUSP_TEST_RUN_WORKSPACE" ]; then
  export PAPERCUSP_TEST_RUN_WORKSPACE
else
  unset PAPERCUSP_TEST_RUN_WORKSPACE
  echo "run-operator-e2e-isolated: WARNING no caller workspace (PAPERCUSP_TEST_RUN_WORKSPACE / PAPERCUSP_WORKSPACE_ID / PAPERCUSP_WORKSPACE); ledger rows will carry the rig's throwaway workspace id" >&2
fi
export OPERATOR_E2E_PLAYWRIGHT="${OPERATOR_E2E_PLAYWRIGHT:-npx playwright test}"
# Open signup for THIS throwaway rig operator only (WI-10006791). The rig always has
# its auto-signed-in default user, and /api/auth/signup refuses 403 signup_disabled
# whenever a user exists and papercusp-open-signup is off. That flag is an
# owner-authority DARK flag (internet-reachable signup), so it must never be flipped
# globally; the per-process env override reaches only the isolated rig's operator,
# which is what the ui-flow-login-prefs signup specs need. A caller may pass 0.
export PAPERCUSP_FLAG_PAPERCUSP_OPEN_SIGNUP="${PAPERCUSP_FLAG_PAPERCUSP_OPEN_SIGNUP:-1}"
# A caller-level opt-out would make the whole run evidence-free; the runner exists to record.
unset PAPERCUSP_DISABLE_TEST_RUNS_REPORTER
RIG="${OPERATOR_E2E_RIG:-$ROOT/scripts/verify-tauri-headless.sh}"

echo "OPERATOR_E2E_ISOLATED group=$PAPERCUSP_TEST_RUN_GROUP ledger=${PAPERCUSP_TEST_RUNS_DB_URL##*@} workspace=${PAPERCUSP_TEST_RUN_WORKSPACE:-<rig>} harness=$PAPERCUSP_TEST_RUN_HARNESS rig=$RIG"

# shellcheck disable=SC2016 # expanded by the inner shell, inside the rig
VERIFY_TAURI_ISOLATED_DB=1 "$RIG" -- bash -c '
  set -u
  cd "$1/apps/operator" || exit 97
  shift
  vite_log=$(mktemp "${TMPDIR:-/tmp}/operator-e2e-vite.XXXXXX") || exit 98
  env -u PORT -u OPERATOR_E2E_PORT \
    PAPERCUSP_BIND_HOST=127.0.0.1 \
    PAPERCUSP_ENABLE_HMR=1 \
    PAPERCUSP_FAKE_LLM=1 \
    PAPERCUSP_DEV_WATCH=0 \
    PAPERCUSP_API_TARGET="${VERIFY_TAURI_DEV_URL:-}" \
    npm run dev -- -- --host 127.0.0.1 --port 0 --strictPort >"$vite_log" 2>&1 &
  vite_pid=$!
  cleanup_vite() {
    if kill -0 "$vite_pid" 2>/dev/null; then
      kill "$vite_pid" 2>/dev/null || true
      wait "$vite_pid" 2>/dev/null || true
    fi
    rm -f "$vite_log"
  }
  trap cleanup_vite EXIT

  port=
  attempt=0
  while [ "$attempt" -lt 240 ]; do
    if ! kill -0 "$vite_pid" 2>/dev/null; then
      cat "$vite_log" >&2
      echo "run-operator-e2e-isolated: Vite exited before startup" >&2
      exit 98
    fi
    port=$(node -e "const fs=require(\"node:fs\");const lines=fs.readFileSync(process.argv[1],\"utf8\").split(String.fromCharCode(10));const line=lines.find(x=>x.trim().startsWith(\"Local:\"));if(line){const url=line.trim().split(\" \").filter(Boolean).pop();if(url)process.stdout.write(new URL(url).port)}" "$vite_log")
    if [ -n "$port" ] && node -e "fetch(\"http://127.0.0.1:$port/\").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
      break
    fi
    port=
    attempt=$((attempt + 1))
    sleep 0.5
  done
  if [ -z "$port" ]; then
    cat "$vite_log" >&2
    echo "run-operator-e2e-isolated: Vite did not serve its OS-assigned port" >&2
    exit 98
  fi
  echo "OPERATOR_E2E_ISOLATED vite-port=$port"
  # $OPERATOR_E2E_PLAYWRIGHT is a command line; word-splitting it is intended.
  OPERATOR_E2E_PORT="$port" \
    OPERATOR_E2E_BASE_URL="http://127.0.0.1:$port" \
    OPERATOR_E2E_REUSE_SERVER=1 \
    PAPERCUSP_API_TARGET="${VERIFY_TAURI_DEV_URL:-}" \
    $OPERATOR_E2E_PLAYWRIGHT "$@"
' operator-e2e-isolated "$ROOT" "$@"
rc=$?
echo "OPERATOR_E2E_ISOLATED exit=$rc group=$PAPERCUSP_TEST_RUN_GROUP"
exit "$rc"
