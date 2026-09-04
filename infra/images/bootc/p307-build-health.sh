#!/usr/bin/env bash
#
# P-307 — bounded health diagnostics for rootful Podman image builds.
#
# This is a detector, not a timeout or a repair.  A build that stops changing
# its log and process I/O can still be making progress in a filesystem request,
# so killing it would turn a transient fuse-overlayfs delay into a failed bake.
# Instead, after a bounded quiet interval this script records the process
# wait-channel and every fuse-overlayfs mount in the build's mount namespace,
# including the fuse-overlayfs process that owns each mount when it is
# discoverable.
#
# Usage:
#   p307-build-health.sh --pid PID --log PATH [options]
#
# Options:
#   --interval-sec N       sample interval (default: 15)
#   --stalled-after-sec N  quiet interval before a report (default: 120)
#   --snapshot             emit one diagnostic snapshot and exit
#
# The P307_BUILD_HEALTH_PROC_ROOT environment variable is a test seam only;
# production uses /proc.  P307_BUILD_HEALTH_STORAGE_ROOT defaults to the
# rootful Podman graph root and may be changed when a release host uses one.
#
# Exit: 0 when the monitored process exits or the snapshot is emitted; 2 for
# usage/setup errors.  A health finding never changes the build's exit status.

set -uo pipefail

PID=""
LOG=""
INTERVAL_SEC="${P307_BUILD_HEALTH_INTERVAL_SEC:-15}"
STALLED_AFTER_SEC="${P307_BUILD_HEALTH_STALLED_AFTER_SEC:-120}"
PROC_ROOT="${P307_BUILD_HEALTH_PROC_ROOT:-/proc}"
STORAGE_ROOT="${P307_BUILD_HEALTH_STORAGE_ROOT:-/var/lib/containers/storage}"
SNAPSHOT=0

usage() {
  sed -n '1,42p' "$0"
}

die() {
  echo "P307_BUILD_HEALTH_ERROR $*" >&2
  exit 2
}

is_uint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pid) PID="${2:-}"; shift 2 ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --interval-sec) INTERVAL_SEC="${2:-}"; shift 2 ;;
    --stalled-after-sec) STALLED_AFTER_SEC="${2:-}"; shift 2 ;;
    --proc-root) PROC_ROOT="${2:-}"; shift 2 ;;
    --storage-root) STORAGE_ROOT="${2:-}"; shift 2 ;;
    --snapshot) SNAPSHOT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
done

is_uint "$PID" || die "--pid must be a decimal process id"
is_uint "$INTERVAL_SEC" || die "--interval-sec must be a non-negative integer"
is_uint "$STALLED_AFTER_SEC" || die "--stalled-after-sec must be a non-negative integer"
[ "$INTERVAL_SEC" -gt 0 ] || die "--interval-sec must be greater than zero"
[ -d "$PROC_ROOT" ] || die "proc root does not exist: $PROC_ROOT"

PROC_ROOT="${PROC_ROOT%/}"
STORAGE_ROOT="${STORAGE_ROOT%/}"

proc_file() {
  # $1 is a decimal pid; $2 is a path beginning with /.
  printf '%s/%s%s' "$PROC_ROOT" "$1" "$2"
}

decode_mount_field() {
  # mountinfo escapes spaces, tabs, newlines, and backslashes as octal bytes.
  printf '%s' "$1" | sed \
    -e 's/\\040/ /g' \
    -e 's/\\011/	/g' \
    -e 's/\\012/\
/g' \
    -e 's/\\134/\\/g'
}

one_line() {
  # Diagnostic output must remain one record per line even if a fixture or
  # command line contains an unexpected newline.
  tr '\r\n' '  ' | cut -c1-240
}

read_process_state() {
  local pid="$1" stat_line
  stat_line="$(cat "$(proc_file "$pid" /stat)" 2>/dev/null || true)"
  [ -n "$stat_line" ] || return 1
  # The comm field may contain spaces and parentheses.  The state is the first
  # token after the final ')' in /proc/<pid>/stat.
  printf '%s\n' "${stat_line##*) }" | awk '{print $1}'
}

root_is_live() {
  local state
  state="$(read_process_state "$PID" 2>/dev/null || true)"
  # `kill -0` succeeds for a zombie, and a process can disappear between the
  # loop guard and the first sample after sleep. Neither state is a live build
  # that can become stalled, so stop without emitting a false finding.
  case "$state" in
    ""|Z|X) return 1 ;;
    *) return 0 ;;
  esac
}

read_io() {
  local pid="$1" io_file
  io_file="$(proc_file "$pid" /io)"
  [ -r "$io_file" ] || return 1
  awk '
    $1 == "rchar:"       { rchar = $2 }
    $1 == "wchar:"       { wchar = $2 }
    $1 == "read_bytes:"  { read_bytes = $2 }
    $1 == "write_bytes:" { write_bytes = $2 }
    END {
      if (rchar == "" || wchar == "" || read_bytes == "" || write_bytes == "")
        exit 1
      print rchar, wchar, read_bytes, write_bytes
    }
  ' "$io_file" 2>/dev/null
}

log_signature() {
  if [ -n "$LOG" ] && [ -e "$LOG" ]; then
    stat -c '%s:%Y' "$LOG" 2>/dev/null || echo missing
  else
    echo missing
  fi
}

process_tree() {
  local root="$1" head=0 pid child_file children child
  local -a queue=("$root")
  local -A seen=()

  while [ "$head" -lt "${#queue[@]}" ]; do
    pid="${queue[$head]}"
    head=$((head + 1))
    is_uint "$pid" || continue
    [ -r "$(proc_file "$pid" /stat)" ] || continue
    [ -z "${seen[$pid]+seen}" ] || continue
    seen["$pid"]=1
    printf '%s\n' "$pid"
    for child_file in "$(proc_file "$pid" /task)"/*/children; do
      [ -r "$child_file" ] || continue
      children="$(cat "$child_file" 2>/dev/null || true)"
      for child in $children; do
        [ -z "${seen[$child]+seen}" ] && queue+=("$child")
      done
    done
  done
}

mount_owner_pid() {
  local mountpoint="$1" comm_file owner_pid comm cmdline owner_mountinfo
  # fuse-overlayfs normally receives its mountpoint as the final argv element.
  # Matching that exact path is stronger than choosing an arbitrary process in
  # the same namespace when several builds are concurrent.
  for comm_file in "$PROC_ROOT"/*/comm; do
    [ -r "$comm_file" ] || continue
    owner_pid="${comm_file%/comm}"
    owner_pid="${owner_pid##*/}"
    is_uint "$owner_pid" || continue
    comm="$(cat "$comm_file" 2>/dev/null || true)"
    [ "$comm" = "fuse-overlayfs" ] || continue
    cmdline="$(tr '\0' ' ' < "$(proc_file "$owner_pid" /cmdline)" 2>/dev/null || true)"
    if [[ "$cmdline" == *"$mountpoint"* ]]; then
      printf '%s\n' "$owner_pid"
      return 0
    fi
    # Some fuse-overlayfs builds do not retain the mountpoint in argv.  A
    # mountinfo match in the owner's namespace is the next-best exact match.
    owner_mountinfo="$(proc_file "$owner_pid" /mountinfo)"
    if [ -r "$owner_mountinfo" ] && grep -Fq " $mountpoint " "$owner_mountinfo" 2>/dev/null; then
      printf '%s\n' "$owner_pid"
      return 0
    fi
  done
  printf '%s\n' "unknown"
}

mount_owner_comm() {
  local owner_pid="$1"
  [ "$owner_pid" != "unknown" ] || { printf '%s\n' "unknown"; return 0; }
  cat "$(proc_file "$owner_pid" /comm)" 2>/dev/null || printf '%s\n' "unknown"
}

report_mounts() {
  local pid="$1" mountinfo line before after mount_id parent major root mountpoint options rest
  local fs_type source superopts owner_pid owner_comm count=0
  mountinfo="$(proc_file "$pid" /mountinfo)"
  if [ ! -r "$mountinfo" ]; then
    echo "P307_BUILD_HEALTH fuse_overlay_mounts=unavailable pid=$pid"
    return 0
  fi

  while IFS= read -r line; do
    [[ "$line" == *" - "* ]] || continue
    before="${line%% - *}"
    after="${line#* - }"
    # mountinfo: id parent major:minor root mountpoint options optional...
    read -r mount_id parent major root mountpoint options rest <<<"$before"
    # post separator: filesystem source super-options optional...
    read -r fs_type source superopts rest <<<"$after"
    [ -n "$mountpoint" ] || continue
    mountpoint="$(decode_mount_field "$mountpoint")"
    if [ "$fs_type" != "fuse.fuse-overlayfs" ] \
      && [[ "$mountpoint" != "$STORAGE_ROOT"/overlay/*/merged ]]; then
      continue
    fi
    owner_pid="$(mount_owner_pid "$mountpoint")"
    owner_comm="$(mount_owner_comm "$owner_pid" | one_line)"
    echo "P307_BUILD_HEALTH fuse_overlay_mount mount_id=$mount_id target=$mountpoint fs=$fs_type source=$source owner_pid=$owner_pid owner_comm=$owner_comm"
    count=$((count + 1))
  done < "$mountinfo"

  [ "$count" -gt 0 ] || echo "P307_BUILD_HEALTH fuse_overlay_mounts=none pid=$pid"
}

report_waiters() {
  local pid="$1" task_dir tid wchan state
  for task_dir in "$(proc_file "$pid" /task)"/*; do
    [ -d "$task_dir" ] || continue
    tid="${task_dir##*/}"
    wchan="$(cat "$task_dir/wchan" 2>/dev/null || true)"
    [ -n "$wchan" ] || continue
    case "$wchan" in
      *fuse*|*request_wait_answer*|*newfstatat*)
        state="$(cat "$task_dir/status" 2>/dev/null | awk '$1 == "State:" {print $2; exit}')"
        echo "P307_BUILD_HEALTH waiter pid=$pid tid=$tid state=${state:-unknown} wchan=$wchan"
        ;;
    esac
  done
}

report_snapshot() {
  local status="$1" idle_sec="$2" now="$3" pids pid stats state log_state
  mapfile -t pids < <(process_tree "$PID")
  log_state="$(log_signature)"
  echo "P307_BUILD_HEALTH status=$status pid=$PID idle_sec=$idle_sec threshold_sec=$STALLED_AFTER_SEC log=${LOG:-none} log_signature=$log_state at_epoch=$now"
  if [ "${#pids[@]}" -eq 0 ]; then
    echo "P307_BUILD_HEALTH process_tree=unavailable pid=$PID"
  else
    for pid in "${pids[@]}"; do
      stats="$(read_io "$pid" 2>/dev/null || true)"
      state="$(read_process_state "$pid" 2>/dev/null || true)"
      echo "P307_BUILD_HEALTH process pid=$pid state=${state:-unknown} io=${stats:-unavailable}"
      report_waiters "$pid"
    done
  fi
  report_mounts "$PID"
}

if [ "$SNAPSHOT" -eq 1 ]; then
  report_snapshot SNAPSHOT 0 "$(date +%s)"
  exit 0
fi

last_log_signature="$(log_signature)"
last_progress_epoch="$(date +%s)"
last_report_epoch=0
declare -A previous_io=()

while kill -0 "$PID" 2>/dev/null && root_is_live; do
  sleep "$INTERVAL_SEC"
  # Re-check after sleeping: the monitored process may have exited (or become
  # a zombie that still passes `kill -0`) during the sampling interval.
  root_is_live || break
  now="$(date +%s)"
  activity=0
  mapfile -t current_pids < <(process_tree "$PID")

  for pid in "${current_pids[@]}"; do
    stats="$(read_io "$pid" 2>/dev/null || true)"
    [ -n "$stats" ] || continue
    if [ -n "${previous_io[$pid]+seen}" ]; then
      read -r rchar wchar read_bytes write_bytes <<<"$stats"
      read -r old_rchar old_wchar old_read_bytes old_write_bytes <<<"${previous_io[$pid]}"
      if (( rchar > old_rchar || wchar > old_wchar || read_bytes > old_read_bytes || write_bytes > old_write_bytes )); then
        activity=1
      fi
    fi
    previous_io["$pid"]="$stats"
  done

  current_log_signature="$(log_signature)"
  if [ "$current_log_signature" != "$last_log_signature" ]; then
    activity=1
    last_log_signature="$current_log_signature"
  fi
  if [ "$activity" -eq 1 ]; then
    last_progress_epoch="$now"
    last_report_epoch=0
    continue
  fi

  idle_sec=$((now - last_progress_epoch))
  if [ "$idle_sec" -ge "$STALLED_AFTER_SEC" ] \
    && { [ "$last_report_epoch" -eq 0 ] || [ $((now - last_report_epoch)) -ge "$STALLED_AFTER_SEC" ]; }; then
    report_snapshot STALLED "$idle_sec" "$now"
    last_report_epoch="$now"
  fi
done

exit 0
