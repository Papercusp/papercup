#!/usr/bin/env bash
# Run pre-snapshot DB hook ONCE per cycle, then snapshot every registered source.
set -uo pipefail
LOG_DIR="${KOPIA_SNAPSHOT_LOG_DIR:-$HOME/.cache/kopia}"
PID_FILE="$LOG_DIR/snapshot-all.kopia.pid"
PROC_ROOT="${KOPIA_SNAPSHOT_PROC_ROOT:-/proc}"
SUDO_BIN="${KOPIA_SNAPSHOT_SUDO:-/usr/bin/sudo}"
KILL_BIN="${KOPIA_SNAPSHOT_KILL:-/usr/bin/kill}"
KOPIA_BIN="${KOPIA_SNAPSHOT_BIN:-/usr/bin/kopia}"
mkdir -p "$LOG_DIR"

# A user manager cannot reliably kill a root-owned sudo child after oomd tears
# down the user unit. Validate the exact PID and command before cleanup; never
# scan for or kill unrelated Kopia processes.
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
    if "$SUDO_BIN" -n -- "$KILL_BIN" -KILL "$pid" >>"$LOG_DIR/snapshot-all.log" 2>&1; then
      echo "CLEANUP: killed exact Kopia PID $pid" >>"$LOG_DIR/snapshot-all.log"
    else
      echo "WARN: failed to kill exact Kopia PID $pid" >>"$LOG_DIR/snapshot-all.log"
    fi
  else
    echo "INFO: stale/non-Kopia PID file $PID_FILE; refusing to kill PID ${pid:-<empty>}" >>"$LOG_DIR/snapshot-all.log"
  fi
  rm -f -- "$PID_FILE"
}

# ExecStopPost calls this after a kill. Keep it above the guard self-wrap so
# cleanup cannot wait on a backup lock whose owner is being torn down.
if [ "${1:-}" = "--cleanup" ]; then
  cleanup_kopia_pid
  exit 0
fi

# D-001: this script is safe both from systemd and when invoked directly. The
# outer service already enters the same guard; KOPIA_BACKUP_GUARD_ACTIVE avoids
# recursively reacquiring it. Scheduled mode skips on overlap or unsafe PSI.
if [ "${KOPIA_BACKUP_GUARD_ACTIVE:-0}" != 1 ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  guard="${KOPIA_BACKUP_GUARD_BIN:-$script_dir/kopia-backup-guard.sh}"
  exec "$guard" --mode scheduled --label hot -- "$0" "$@"
fi

# Background priority. Children inherit both.
renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true

run_kopia_snapshot() {
  local output_file="$LOG_DIR/snapshot-all-output.$$" sudo_pid="" rc=0
  rm -f -- "$PID_FILE" "$output_file"

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

trap cleanup_kopia_pid EXIT

{
  echo "=== $(date -Iseconds) run start ==="
  "$HOME/.config/kopia/hooks/pre-snapshot.sh"
  # ── BATCHED INVOCATION (2026-08-07, fan/thermal investigation) ──────────────
  # Was: one `kopia snapshot create` per source inside a while-read loop — 13
  # separate kopia processes every cycle. Measured on this host, a kopia
  # invocation costs ~4.2 CPU-SECONDS before it looks at any data: snapshotting a
  # 40 KB directory with ZERO changed files took real 3.8s / user 2.8s / sys 1.8s,
  # and a bare `snapshot list -n 1` cost 3.4 CPU-s. That is fixed index-load
  # overhead from the repo's ~5,300 index blobs, paid once PER PROCESS — and each
  # invocation also fires its own opportunistic "Running quick maintenance..." pass.
  #
  # `kopia snapshot create` accepts multiple sources (usage: [<source>...]), so one
  # invocation loads the index once instead of 13 times: ~50 CPU-s of the measured
  # 572 CPU-s/cycle. Deliberately noting what this does NOT fix: 82% of the cost
  # (469 CPU-s) is walking .papercusp-workspaces / papercupai-workspace / .papercusp.
  # ── COLD SOURCES: discovered, but NOT snapshotted on this 30-minute timer ────
  # Source discovery below is DYNAMIC (`kopia snapshot list --all`), so any source
  # that has ever been snapshotted gets swept every 30 minutes. $HOME
  # is a deliberately DAILY source (plan kopia-curated-home-coverage-2026-08-16):
  # it walks the whole home tree, and doing that every 30 min would undo the
  # 2026-08-07 thermal fix that first cut this timer from 5 min to 15. It has its own
  # unit — kopia-home-snapshot.timer — and must be filtered out HERE, or it would
  # silently rejoin the hot sweep the moment its first snapshot exists.
  #
  # Exact-match (`grep -vxF`) on purpose: this must remove $HOME
  # itself WITHOUT removing its children ($HOME/.papercusp etc.),
  # which ARE hot sources and must keep their 30-minute cadence. The two
  # owner-protected VM sources are also daily: their images are hundreds of GB,
  # so registering them must never make the 30-minute sweep walk them.
  # windows-vm is a symlink today; keep both spellings cold so a source created
  # from its resolved target cannot accidentally re-enter the hot sweep.
  COLD_SOURCES=(
    "$HOME"
    "$HOME/windows-vm"
    "$HOME/macos-vm"
    /mnt/data/offload/windows-vm
  )
  # ── REQUIRED SOURCES: the fix for a blind spot in the discovery above ───────
  # Discovery is self-referential: it enumerates sources that ALREADY HAVE a
  # snapshot, so a directory that has never been snapshotted CANNOT ENTER IT, by
  # construction. There is no registration path. That is not a corner case — it
  # is what happened on 2026-09-05 (WI-2146225): WI-2145150 relocated the
  # Postgres dumps from /mnt/data/Backup/db-dumps to /mnt/backup/db-dumps
  # because /mnt/data hit 97%, the new directory had no snapshot, so discovery
  # never returned it, so it never got one. The dumps kept being produced
  # perfectly and stopped leaving the box entirely, and every existing check
  # stayed green: the freshness checks read LOCAL files, and check 2 takes the
  # newest snapshot across ALL sources, so 16 healthy sources kept it green.
  #
  # Silent, self-perpetuating, and unbounded in time — the exact shape of
  # EI-10733. So the paths that MUST be covered are named here and unioned in
  # unconditionally: relocating a backup directory now costs one sweep of
  # latency instead of forever. Only paths that exist on disk are added, so a
  # box that does not have one is not spammed with errors for it.
  REQUIRED_SOURCES=(
    "${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/backup/db-dumps}"
  )
  mapfile -t SRCS < <({ "$SUDO_BIN" -n "$KOPIA_BIN" snapshot list --all 2>/dev/null \
      | awk -F'@' '/^[a-zA-Z]/' \
      | grep -oE ':/[^ ]+' \
      | sed 's/^://'
    for r in ${REQUIRED_SOURCES[@]+"${REQUIRED_SOURCES[@]}"}; do
      [ -d "$r" ] && printf '%s\n' "$r"
    done
    } | sort -u \
    | grep -vxF "$(printf '%s\n' "${COLD_SOURCES[@]}")")
  # Guard: the old loop snapshotted NOTHING, silently, if discovery came back empty
  # — the same shape as the `--max-results-per-source` flag breakage that made
  # healthcheck.sh exit 1 on every run for weeks before anyone noticed. Silent
  # success-looking failure is this system's recurring bug; log it loudly instead.
  if [ "${#SRCS[@]}" -eq 0 ]; then
    echo "WARNING: source discovery returned NOTHING — no sources snapshotted this cycle"
  else
    echo "snapshotting ${#SRCS[@]} sources in ONE kopia invocation"
    run_kopia_snapshot "${SRCS[@]}" 2>&1 | tail -5
  fi
  echo "=== $(date -Iseconds) run end ==="
} >> "$LOG_DIR/snapshot-all.log" 2>&1
