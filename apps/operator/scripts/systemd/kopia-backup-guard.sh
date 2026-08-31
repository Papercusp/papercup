#!/usr/bin/env bash
# Serialize every managed Kopia snapshot and keep scheduled work off an already
# pressured host. See serialize-and-slow-kopia-backups-2026-08-20#D-001.
set -uo pipefail

# Parse the complete runtime before starting work. These scripts are installed as
# symlinks to this canonical file, so a repository update can replace the source
# while a multi-hour child is running. Top-level code would resume parsing the
# changed file after that child exits and can observe a torn old/new program. A
# function body is parsed as one compound command before main starts; keep the
# invocation and exit in one parsed list for the same reason.
main() {
usage() {
  echo "usage: $0 --mode scheduled|wait [--label NAME] -- COMMAND [ARG ...]" >&2
  exit 64
}

mode=
label=kopia
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      [ "$#" -ge 2 ] || usage
      mode="$2"
      shift 2
      ;;
    --label)
      [ "$#" -ge 2 ] || usage
      label="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *) usage ;;
  esac
done

[ "$#" -gt 0 ] || usage
case "$mode" in scheduled|wait) ;; *) usage ;; esac

is_number() {
  awk -v value="$1" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/) }'
}

memory_limit="${KOPIA_BACKUP_MEM_FULL_AVG10_MAX:-5}"
io_limit="${KOPIA_BACKUP_IO_FULL_AVG10_MAX:-10}"
monitor_interval="${KOPIA_BACKUP_MONITOR_INTERVAL_SEC:-5}"
stop_grace="${KOPIA_BACKUP_STOP_GRACE_SEC:-20}"
is_number "$memory_limit" || { echo "invalid KOPIA_BACKUP_MEM_FULL_AVG10_MAX=$memory_limit" >&2; exit 64; }
is_number "$io_limit" || { echo "invalid KOPIA_BACKUP_IO_FULL_AVG10_MAX=$io_limit" >&2; exit 64; }
is_number "$monitor_interval" || { echo "invalid KOPIA_BACKUP_MONITOR_INTERVAL_SEC=$monitor_interval" >&2; exit 64; }
is_number "$stop_grace" || { echo "invalid KOPIA_BACKUP_STOP_GRACE_SEC=$stop_grace" >&2; exit 64; }

# /run/lock is the host-global lock namespace shared by the user systemd units
# and root-launched maintenance (for example, sudo systemd-run). Keep the lock
# in a dedicated non-sticky subdirectory: fs.protected_regular rejects root
# opening a user-owned file directly in sticky /run/lock. Do not derive the
# default from XDG_RUNTIME_DIR: that silently creates one lock per effective UID
# and lets privileged maintenance bypass the user-service guard.
lock_path="${KOPIA_BACKUP_LOCK_PATH:-/run/lock/papercusp/kopia-global.lock}"
# Both a user service and root maintenance may create the file first. Keep the
# inode writable by either identity, and append-open so acquiring the flock does
# not truncate any diagnostic bytes a deployment may leave in the file.
lock_umask=$(umask)
umask 000
mkdir -p "$(dirname "$lock_path")" || exit 73
exec 9>>"$lock_path" || exit 73
umask "$lock_umask"

guard_log() {
  printf 'KOPIA_BACKUP_GUARD timestamp=%s label=%s %s\n' "$(date -Iseconds)" "$label" "$*"
}

read_full_avg10() {
  local path="$1"
  [ -r "$path" ] || return 1
  awk '
    $1 == "full" {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^avg10=/) {
          value = substr($i, 7)
          if (value ~ /^[0-9]+([.][0-9]+)?$/) {
            print value
            found = 1
            exit
          }
        }
      }
    }
    END { if (!found) exit 1 }
  ' "$path"
}

at_or_above() {
  awk -v value="$1" -v limit="$2" 'BEGIN { exit !(value >= limit) }'
}

# A scheduled backup can START on a quiet host and CREATE pressure minutes later.
# The admission check below cannot see that future state.  Keep watching the same
# authoritative PSI files for the child lifetime and retire only this scheduled
# invocation if it crosses either budget.  Kopia snapshots are content-addressed
# and restart-safe; the next timer run reuses uploaded content.  The child script's
# EXIT trap also kills its exact root-owned Kopia PID, so stopping the user-owned
# wrapper cannot leave an unbounded root process behind.
runtime_abort_reason=
run_scheduled_command() {
  "$@" &
  child_pid=$!

  while kill -0 "$child_pid" 2>/dev/null; do
    sleep "$monitor_interval"
    kill -0 "$child_pid" 2>/dev/null || break

    memory_psi=$(read_full_avg10 "$memory_path") || {
      runtime_abort_reason="pressure-unavailable signal=memory path=$memory_path"
      break
    }
    io_psi=$(read_full_avg10 "$io_path") || {
      runtime_abort_reason="pressure-unavailable signal=io path=$io_path"
      break
    }
    if at_or_above "$memory_psi" "$memory_limit"; then
      runtime_abort_reason="memory-pressure full_avg10=$memory_psi limit=$memory_limit"
      break
    fi
    if at_or_above "$io_psi" "$io_limit"; then
      runtime_abort_reason="io-pressure full_avg10=$io_psi limit=$io_limit"
      break
    fi
  done

  if [ -n "$runtime_abort_reason" ] && kill -0 "$child_pid" 2>/dev/null; then
    guard_log "result=stopping-during-run reason=$runtime_abort_reason child_pid=$child_pid"
    kill -TERM "$child_pid" 2>/dev/null || true
    stop_deadline=$(awk -v now="$(date +%s.%N)" -v grace="$stop_grace" 'BEGIN { print now + grace }')
    while kill -0 "$child_pid" 2>/dev/null &&
      awk -v now="$(date +%s.%N)" -v deadline="$stop_deadline" 'BEGIN { exit !(now < deadline) }'; do
      sleep 0.1
    done
    if kill -0 "$child_pid" 2>/dev/null; then
      guard_log "result=killing-after-grace reason=$runtime_abort_reason child_pid=$child_pid grace_sec=$stop_grace"
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  fi

  wait "$child_pid"
  child_rc=$?
  if [ -n "$runtime_abort_reason" ]; then
    guard_log "result=deferred-during-run reason=$runtime_abort_reason child_rc=$child_rc"
    return 75
  fi
  return "$child_rc"
}

if [ "$mode" = scheduled ]; then
  if ! flock -n 9; then
    guard_log "result=deferred reason=lock-held"
    exit 0
  fi

  memory_path="${KOPIA_BACKUP_MEM_PSI_PATH:-/proc/pressure/memory}"
  io_path="${KOPIA_BACKUP_IO_PSI_PATH:-/proc/pressure/io}"
  memory_psi=$(read_full_avg10 "$memory_path") || {
    guard_log "result=deferred reason=pressure-unavailable signal=memory path=$memory_path"
    exit 0
  }
  io_psi=$(read_full_avg10 "$io_path") || {
    guard_log "result=deferred reason=pressure-unavailable signal=io path=$io_path"
    exit 0
  }

  if at_or_above "$memory_psi" "$memory_limit"; then
    guard_log "result=deferred reason=memory-pressure full_avg10=$memory_psi limit=$memory_limit"
    exit 0
  fi
  if at_or_above "$io_psi" "$io_limit"; then
    guard_log "result=deferred reason=io-pressure full_avg10=$io_psi limit=$io_limit"
    exit 0
  fi
else
  guard_log "result=waiting reason=lock"
  flock 9 || exit 75
fi

export KOPIA_BACKUP_GUARD_ACTIVE=1
guard_log "result=started mode=$mode"
if [ "$mode" = scheduled ]; then
  run_scheduled_command "$@"
  rc=$?
  # Same contract as an admission-time pressure deferral: the scheduled cycle
  # intentionally did no complete snapshot, but the service is healthy and the
  # next timer tick is the retry.  Do not make systemd treat pressure control as
  # a unit failure.
  if [ -n "$runtime_abort_reason" ]; then
    return 0
  fi
else
  "$@"
  rc=$?
fi
guard_log "result=finished mode=$mode rc=$rc"
return "$rc"
}

main "$@"; exit $?
