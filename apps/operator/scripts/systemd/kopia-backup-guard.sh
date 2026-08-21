#!/usr/bin/env bash
# Serialize every managed Kopia snapshot and keep scheduled work off an already
# pressured host. See serialize-and-slow-kopia-backups-2026-08-20#D-001.
set -uo pipefail

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
is_number "$memory_limit" || { echo "invalid KOPIA_BACKUP_MEM_FULL_AVG10_MAX=$memory_limit" >&2; exit 64; }
is_number "$io_limit" || { echo "invalid KOPIA_BACKUP_IO_FULL_AVG10_MAX=$io_limit" >&2; exit 64; }

runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
lock_path="${KOPIA_BACKUP_LOCK_PATH:-$runtime_dir/papercusp-kopia-global.lock}"
mkdir -p "$(dirname "$lock_path")" || exit 73
exec 9>"$lock_path" || exit 73

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
"$@"
rc=$?
guard_log "result=finished mode=$mode rc=$rc"
exit "$rc"

