#!/usr/bin/env bash
# Daily snapshot of the CURATED full home directory.
#
# Plan: kopia-curated-home-coverage-2026-08-16
#
# WHY THIS IS A SEPARATE SCRIPT AND TIMER, NOT ANOTHER SOURCE IN snapshot-all.sh:
# snapshot-all.sh runs every 30 MINUTES and discovers its sources dynamically, so a
# $HOME source would be swept every 30 minutes automatically. That walks
# the entire home tree and would undo the 2026-08-07 thermal fix that cut that timer
# from 5 min to 15 (this box idles at 90-92 C against a ~94 C limit). snapshot-all.sh
# filters this path out via its COLD_SOURCES array; this unit owns it instead, daily.
#
# The 12 existing in-home sources keep their 30-minute cadence and are NOT excluded
# from this snapshot — kopia dedups by content hash, so re-including them costs ~0
# bytes. The payoff is that ONE snapshot restores the whole home directory.

set -uo pipefail

HOME_SRC="$HOME"
# windows-vm REMOVED [owner 2026-09-16]: 23 daily snapshots of a
# LIVE 247GB image (98.7->247GB in one month) bought a crash-consistent copy that may
# not boot on restore. ~/.kopiaignore already excludes it from the curated HOME source,
# so this dedicated source was the only thing holding those blobs. Its
# PROTECTED_VM_REQUESTS assertion in kopia-healthcheck.sh was dropped in the same
# change, or the healthcheck would alarm forever on a source we deliberately retired.
VM_REQUESTED=( "$HOME_SRC/macos-vm" )
LOG_DIR="${KOPIA_HOME_SNAPSHOT_LOG_DIR:-$HOME/.cache/kopia}"
PID_FILE="$LOG_DIR/home-snapshot.kopia.pid"
PROC_ROOT="${KOPIA_HOME_SNAPSHOT_PROC_ROOT:-/proc}"
SUDO_BIN="${KOPIA_HOME_SNAPSHOT_SUDO:-/usr/bin/sudo}"
KILL_BIN="${KOPIA_HOME_SNAPSHOT_KILL:-/usr/bin/kill}"
KOPIA_BIN="${KOPIA_HOME_SNAPSHOT_BIN:-/usr/bin/kopia}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/home-snapshot.log"

# systemd's user manager cannot reliably kill a root-owned sudo child when it
# tears down this user unit (the historical OOM left PID 2701540 behind). Keep
# the PID file deliberately narrow: it names the one Kopia process started by
# this invocation, and cleanup validates both /proc/<pid>/exe and argv before
# using sudo to kill that exact PID. Never use pkill/killall here.
kopia_pid_matches() {
  local pid="$1" exe="" cmdline=""
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 1 ] 2>/dev/null || return 1
  exe="$(readlink -f "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
  [ "$exe" = "$KOPIA_BIN" ] || return 1
  cmdline="$(tr '\0' ' ' <"$PROC_ROOT/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == "$KOPIA_BIN snapshot create "* ]]
}

cleanup_kopia_pid() {
  local pid=""
  [ -s "$PID_FILE" ] || return 0
  pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"

  if kopia_pid_matches "$pid"; then
    if "$SUDO_BIN" -n -- "$KILL_BIN" -KILL "$pid" >>"$LOG" 2>&1; then
      echo "CLEANUP: killed exact Kopia PID $pid" >>"$LOG"
    else
      echo "WARN: failed to kill exact Kopia PID $pid" >>"$LOG"
    fi
  else
    echo "INFO: stale/non-Kopia PID file $PID_FILE; refusing to kill PID ${pid:-<empty>}" >>"$LOG"
  fi
  rm -f -- "$PID_FILE"
}

# ExecStopPost calls this same script after systemd-oomd or a stop kills the
# main shell. It is also the safe, non-snapshot test seam for the exact-PID
# guard. A normal run has already removed the PID file, so this is a no-op.
if [ "${1:-}" = "--cleanup" ]; then
  cleanup_kopia_pid
  exit 0
fi

# D-001: daily home/VM work waits for the SAME lock as the hot and protected
# entrypoints. The service enters it first; this self-wrap protects direct runs.
# Cleanup stays above this block so ExecStopPost can never wait on backup work.
if [ "${KOPIA_BACKUP_GUARD_ACTIVE:-0}" != 1 ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  guard="${KOPIA_BACKUP_GUARD_BIN:-$script_dir/kopia-backup-guard.sh}"
  exec "$guard" --mode wait --label daily-home-vm -- "$0" "$@"
fi

run_kopia_snapshot() {
  local output_file="$LOG_DIR/home-snapshot-output.$$" sudo_pid="" rc=0
  rm -f -- "$PID_FILE" "$output_file"

  # The root helper records its own PID before exec'ing Kopia. `$!` would be
  # sudo's unprivileged parent, not the root Kopia process that can be orphaned.
  "$SUDO_BIN" -n /usr/bin/bash -c '
    pid_file="$1"
    shift
    printf "%s\n" "$$" >"$pid_file"
    exec "$@"
  ' bash "$PID_FILE" "$KOPIA_BIN" snapshot create "--parallel=1" "$@" >"$output_file" 2>&1 &
  sudo_pid=$!
  wait "$sudo_pid"
  rc=$?
  cat "$output_file"
  rm -f -- "$output_file" "$PID_FILE"
  return "$rc"
}

# Background priority. Children inherit both. This walk is long and must never
# compete with agent sessions, git-sync, or the 30-minute hot sweep.
renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true

rc=0
{
  echo "=== $(date -Iseconds) home snapshot start ==="

  # ── GUARD: never snapshot home without its exclusion file ──────────────────
  # Without .kopiaignore this source walks ~1 TB — VM images (314 GB), Rust build
  # targets (77 GB), Android SDK (44 GB) — against 650 GB of free space on a disk
  # already 92% full. Failing loudly here beats filling the disk overnight and
  # discovering it from a wedged machine. This is the recurrence guard for the
  # whole "someone removed/renamed the ignore file" class.
  if [ ! -f "$HOME_SRC/.kopiaignore" ]; then
    echo "FATAL: $HOME_SRC/.kopiaignore is MISSING — refusing to snapshot."
    echo "       Restore it before this unit can run; see plan"
    echo "       kopia-curated-home-coverage-2026-08-16 (P-001) for its contents."
    echo "=== $(date -Iseconds) home snapshot ABORTED (no ignore file) ==="
    exit 78   # EX_CONFIG — distinguishes misconfiguration from a kopia failure
  fi

  VM_SRCS=()
  vm_missing=0
  for requested in "${VM_REQUESTED[@]}"; do
    if [ ! -d "$requested" ]; then
      echo "FATAL: owner-protected VM path is MISSING: $requested"
      vm_missing=1
    else
      VM_SRCS+=( "$(readlink -f "$requested")" )
    fi
  done

  if [ "$vm_missing" -ne 0 ]; then
    echo "FATAL: refusing the daily snapshot while an owner-protected VM path is missing"
    rc=78   # EX_CONFIG — the existence assertion must fail loudly
  else
    home_out=$(run_kopia_snapshot "$HOME_SRC")
    home_rc=$?
    printf '%s\n' "$home_out" | tail -6

    # The VM paths are explicit sources because .kopiaignore intentionally
    # excludes them from the curated HOME source. Keep them daily, not hot.
    vm_out=$(run_kopia_snapshot "${VM_SRCS[@]}")
    vm_rc=$?
    printf '%s\n' "$vm_out" | tail -6

    rc=0
    [ "$home_rc" -eq 0 ] || rc="$home_rc"
    [ "$vm_rc" -eq 0 ] || rc="$vm_rc"

    # Loud on failure. This system's recurring bug is the silent success-looking
    # failure (EI-10733: a healthcheck that exit-1'd every run for weeks unnoticed),
    # so say plainly which way it went rather than leaving it to be inferred.
    if [ "$rc" -ne 0 ]; then
      echo "ERROR: kopia snapshot create failed (home_rc=$home_rc vm_rc=$vm_rc) — protected sources are NOT fully backed up this cycle"
    else
      echo "OK: curated home and owner-protected VM snapshots created"
    fi
  fi

  echo "=== $(date -Iseconds) home snapshot end (rc=$rc) ==="
} >> "$LOG" 2>&1

exit "$rc"
