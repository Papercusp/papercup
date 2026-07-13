#!/usr/bin/env bash
# flake-soak — run a vitest target R times under DETERMINISTIC CPU starvation so
# LOAD-SENSITIVE flakes redden on purpose instead of ambushing whoever runs the
# suite next.
#
# WHY THIS EXISTS (WI-4468 / WI-4481): the MugTab "resets Capacity" flake was
# ~60% red under CPU pressure and 100% green in isolation / unthrottled. A
# single green run cannot disprove that class — which is exactly how it survived
# TWO peer RED reports and the fixing agent's own dismissal ("I re-ran it once,
# it was green"). The detector gap — not the race — was the real lesson. This
# lane closes it: repeat the target under starvation and AGGREGATE, so a
# load-sensitive flake shows up as a red-rate, not a coin flip you happened to
# win.
#
# THE THROTTLE — taskset core-pinning, not systemd/cgroups. The parallel vitest
# suite (many worker processes) is pinned to a SMALL set of cores, so its
# workers timeshare heavily: event loops congest, throttled timers (nuqs URL
# flushes, React effect scheduling, RTL async) fire late, and same-tick
# remount-vs-flush races resolve the losing way — the exact mechanism behind the
# MugTab flake. systemd-run / cgroup delegation is deliberately NOT used: the
# agent host blocks it (native-scheduler lockout hook), and taskset needs no
# scheduler, no root, and no daemon.
#
# USAGE
#   scripts/flake-soak.sh [options] [-- <vitest args...>]
#     --repeats N      run the target N times            (default $FLAKE_SOAK_REPEATS or 6)
#     --cores M        pin the run to M cores            (default $FLAKE_SOAK_CORES or 2)
#     --cwd DIR        package dir holding node_modules  (default $FLAKE_SOAK_CWD or apps/operator-vite)
#     --self-test F    run flakeproof fixture F and PASS iff it reddens (proves the
#                      throttle can actually induce a load-flake — see below)
#     -- <args>        everything after -- is passed through to `vitest run`
#
#   # soak a specific suspect suite 8x on 2 cores:
#   scripts/flake-soak.sh --repeats 8 -- src/components/left-sidebar/MugTab.test.tsx
#
#   # prove the lane discriminates (fixture must be a *.flakeproof.test.tsx):
#   scripts/flake-soak.sh --self-test src/components/left-sidebar/SomeBug.flakeproof.test.tsx
#
# EXIT CODES
#   normal mode:    0 if ALL repeats passed; 1 if ANY repeat failed (the flake
#                   reddened — the point); 2 = usage / setup error.
#   --self-test:    0 if the fixture reddened at least once (throttle works); 1
#                   if it stayed all-green (the throttle FAILED to reproduce a
#                   known load-flake — the lane is not discriminating and must be
#                   fixed before it is trusted); 2 = usage / setup error.
#
# PROVE-IT-DISCRIMINATES. A guard that only ever shows green has proven nothing
# (agent-insights/prove-it-discriminates-before-it-acts). The `.flakeproof.test.tsx`
# naming is a reserved, gitignored, normally-EXCLUDED scratch convention: drop a
# known-flaky fixture next to the code under test, run it through --self-test,
# and watch this lane redden it. Normal `vitest run` never sees the fixture (the
# package vitest.config excludes it unless FLAKE_SOAK_SELFTEST=1), and git-sync
# never commits it (.gitignore), so it is a zero-landmine way to validate the
# lane itself.

set -uo pipefail

REPEATS="${FLAKE_SOAK_REPEATS:-6}"
CORES="${FLAKE_SOAK_CORES:-2}"
CWD="${FLAKE_SOAK_CWD:-apps/operator-vite}"
NICE="${FLAKE_SOAK_NICE:-19}"
SELFTEST_FIXTURE=""
declare -a VITEST_ARGS=()

# ---- arg parse -------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repeats) REPEATS="$2"; shift 2 ;;
    --cores)   CORES="$2";   shift 2 ;;
    --cwd)     CWD="$2";     shift 2 ;;
    --nice)    NICE="$2";    shift 2 ;;
    --self-test) SELFTEST_FIXTURE="$2"; shift 2 ;;
    --) shift; VITEST_ARGS+=("$@"); break ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) VITEST_ARGS+=("$1"); shift ;;
  esac
done

# Resolve repo root so the script works from any CWD.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/$CWD"

# Resolve the vitest binary. In this monorepo it is HOISTED to the repo root
# (apps/operator-vite has no local .bin/vitest), so a package-local-only lookup
# is dead on arrival — check the package first, then fall back to the root.
if [ -x "$PKG_DIR/node_modules/.bin/vitest" ]; then
  VITEST_BIN="$PKG_DIR/node_modules/.bin/vitest"
elif [ -x "$REPO_ROOT/node_modules/.bin/vitest" ]; then
  VITEST_BIN="$REPO_ROOT/node_modules/.bin/vitest"
else
  echo "flake-soak: no vitest binary (looked in $PKG_DIR and $REPO_ROOT)" >&2
  echo "            never run pnpm install in the shared tree (WI-4427)" >&2
  exit 2
fi

# ---- CPU pinning -----------------------------------------------------------
# Pick a core WINDOW rather than always cores 0-1, so concurrent soaks from
# different agents on the shared box don't all hammer the same two cores.
TOTAL_CORES="$(nproc 2>/dev/null || echo 4)"
if [ "$CORES" -lt 1 ]; then CORES=1; fi
if [ "$CORES" -gt "$TOTAL_CORES" ]; then CORES="$TOTAL_CORES"; fi
NWIN=$(( TOTAL_CORES / CORES ))
if [ "$NWIN" -lt 1 ]; then NWIN=1; fi
OFFSET=$(( (RANDOM % NWIN) * CORES ))
CPU_END=$(( OFFSET + CORES - 1 ))
CPUSET="${OFFSET}-${CPU_END}"

TASKSET_BIN="$(command -v taskset || true)"
if [ -z "$TASKSET_BIN" ]; then
  echo "flake-soak: taskset not found — running WITHOUT core-pinning (throttle" >&2
  echo "            weakened; a load-flake may not reproduce). Install util-linux." >&2
fi

# ---- one run ---------------------------------------------------------------
# Returns the vitest exit code. Pins to $CPUSET, nices, bypasses the pc-heavy
# admission gate (this wrapper already self-limits to $CORES cores), and — in
# self-test mode — sets FLAKE_SOAK_SELFTEST=1 so the package config includes the
# flakeproof fixture.
run_once() {
  local extra_env="$1"; shift
  (
    cd "$PKG_DIR" || exit 2
    # shellcheck disable=SC2086
    env PC_HEAVY_BYPASS=1 $extra_env \
      ${TASKSET_BIN:+"$TASKSET_BIN" -c "$CPUSET"} \
      nice -n "$NICE" \
      "$VITEST_BIN" run "$@" >/tmp/flake-soak-run.$$.log 2>&1
  )
}

pass=0; fail=0
declare -a RESULTS=()

banner() {
  echo "──────────────────────────────────────────────────────────────"
  echo " flake-soak: $1"
  echo "   pkg=$CWD  repeats=$REPEATS  cores=$CORES (cpuset $CPUSET)  nice=$NICE"
  echo "   target=${*:2}"
  echo "──────────────────────────────────────────────────────────────"
}

if [ -n "$SELFTEST_FIXTURE" ]; then
  # -------- self-test mode: the fixture MUST redden ------------------------
  case "$SELFTEST_FIXTURE" in
    *.flakeproof.test.tsx|*.flakeproof.test.ts) : ;;
    *) echo "flake-soak: --self-test fixture must be a *.flakeproof.test.tsx file" >&2; exit 2 ;;
  esac
  banner "SELF-TEST (expect RED) $SELFTEST_FIXTURE" "$SELFTEST_FIXTURE"
  for i in $(seq 1 "$REPEATS"); do
    if run_once "FLAKE_SOAK_SELFTEST=1" "$SELFTEST_FIXTURE"; then
      RESULTS+=("PASS"); pass=$((pass+1)); printf "  run %2d/%d  PASS\n" "$i" "$REPEATS"
    else
      RESULTS+=("FAIL"); fail=$((fail+1)); printf "  run %2d/%d  \033[31mFAIL\033[0m\n" "$i" "$REPEATS"
    fi
  done
  echo "──────────────────────────────────────────────────────────────"
  echo " self-test result: $fail/$REPEATS reddened (want >=1)"
  if [ "$fail" -ge 1 ]; then
    echo " ✅ throttle DISCRIMINATES — the lane can catch a load-flake."
    exit 0
  fi
  echo " ❌ fixture stayed ALL-GREEN under throttle — the lane failed to"
  echo "    reproduce a known load-flake. Do NOT trust it until fixed"
  echo "    (raise --repeats, lower --cores, or the fixture isn't load-sensitive)."
  exit 1
fi

# -------- normal mode: the target must stay ALL-green --------------------
banner "SOAK (expect all PASS)" "${VITEST_ARGS[*]:-<whole $CWD suite>}"
for i in $(seq 1 "$REPEATS"); do
  if run_once "" "${VITEST_ARGS[@]}"; then
    RESULTS+=("PASS"); pass=$((pass+1)); printf "  run %2d/%d  PASS\n" "$i" "$REPEATS"
  else
    RESULTS+=("FAIL"); fail=$((fail+1)); printf "  run %2d/%d  \033[31mFAIL\033[0m  (log: /tmp/flake-soak-run.$$.log)\n" "$i" "$REPEATS"
    # keep the failing log for inspection
    cp /tmp/flake-soak-run.$$.log "/tmp/flake-soak-fail-${i}.$$.log" 2>/dev/null || true
  fi
done

RED_RATE=$(( fail * 100 / REPEATS ))
echo "──────────────────────────────────────────────────────────────"
echo " soak result: $pass PASS / $fail FAIL over $REPEATS runs  (red-rate ${RED_RATE}%)"
if [ "$fail" -eq 0 ]; then
  echo " ✅ stable under $CORES-core starvation."
  exit 0
fi
echo " ❌ FLAKY under load — failing-run logs at /tmp/flake-soak-fail-*.$$.log"
exit 1
