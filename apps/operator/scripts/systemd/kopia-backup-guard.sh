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

# A pressure gate with no floor does not delay a backup, it CANCELS it, and says
# nothing while doing so.  On a host whose memory PSI sits permanently above the
# budget, every scheduled cycle defers, the next cycle defers for the same
# reason, and coverage stops with the service still reporting healthy.  Measured
# on this box 2026-09-05: /proc/pressure/memory full avg10=23.84 against the
# default limit of 5 -- 4.8x over, sustained -- no Kopia snapshot for 6h43m, and
# the newest recoverable dump 19h old (WI-2146225 defect B).
#
# Raising the limit is NOT the repair: a larger constant has the same unbounded
# shape and fails the same way on the next busy day.  The invariant that was
# missing is that pressure may DELAY a cycle but may not CANCEL it.  Past
# max_defer seconds since the last recorded success, the cycle is admitted
# regardless of pressure -- bounded, because the unit that runs this pins
# MemoryMax/MemorySwapMax and Kopia to --parallel=1, so an admitted run is
# capped by its cgroup rather than free to consume the host.
max_defer="${KOPIA_BACKUP_MAX_DEFER_SEC:-21600}"
# ...and once escalated, do not escalate again on the very next timer tick.  A
# backup that fails for a non-pressure reason would otherwise ignore pressure on
# every 5-minute tick forever.  This is the retry floor between escalations.
escalation_retry="${KOPIA_BACKUP_ESCALATION_RETRY_SEC:-3600}"
is_number "$max_defer" || { echo "invalid KOPIA_BACKUP_MAX_DEFER_SEC=$max_defer" >&2; exit 64; }
is_number "$escalation_retry" || { echo "invalid KOPIA_BACKUP_ESCALATION_RETRY_SEC=$escalation_retry" >&2; exit 64; }

state_dir="${KOPIA_BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/papercusp/kopia-backup-guard}"
# The label reaches this from the command line and becomes a path segment.
state_key=$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')
# NOT named "last-success": this timestamp is also seeded on the first-ever
# evaluation, when no success has happened.  It is the instant staleness is
# measured FROM, and naming it for the thing it is not is how a later reader
# concludes a backup succeeded when none did.
deadline_base_path="$state_dir/$state_key.deadline-base"
escalation_path="$state_dir/$state_key.last-escalation"

# Every state read fails CLOSED to "unknown", and every state write is
# best-effort: a guard that cannot write its own bookkeeping must still run the
# backup.  Never let this bookkeeping fail a cycle.
read_stamp() {
  local recorded
  [ -r "$1" ] || return 1
  recorded=$(cat "$1" 2>/dev/null) || return 1
  is_number "$recorded" || return 1
  printf '%s' "$recorded"
}

write_stamp() {
  local path="$1" tmp
  mkdir -p "$state_dir" 2>/dev/null || return 0
  tmp="$path.tmp.$$"
  if printf '%s\n' "$(date +%s)" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

age_of() {
  local recorded
  recorded=$(read_stamp "$1") || return 1
  awk -v now="$(date +%s)" -v then="$recorded" 'BEGIN { printf "%d", now - then }'
}

# Arm the override for this whole cycle, BEFORE and INDEPENDENTLY of admission.
#
# Admission is not where most cycles die, and building the floor only into the
# admission check would have left the dominant failure untouched.  Measured over
# 48h on this host (label=hot, from this guard's own journal): 51 cycles STARTED
# and 46 of them were retired mid-run by `deferred-during-run`; only 6 ever
# reached `finished rc=0`, the last 30 hours before this was written.  Those 46
# passed admission cleanly during a lull and were then killed seconds in by a
# transient crossing -- typically by a hair (io 10.06 against a limit of 10,
# memory 5.09 against 5).  A sweep visits its sources in order with
# --parallel=1, so a cycle killed at 46s covers whichever sources happen to come
# first and silently leaves the rest uncovered; which sources those are depends
# on where the kill lands.  That is why the override has to cover the run, not
# just its admission: pressure may DELAY a cycle, and may not CANCEL it, in
# either half of the cycle.
staleness_override_reason=
pressure_escalated=0
arm_staleness_override() {
  local age escalated_age
  if ! age=$(age_of "$deadline_base_path"); then
    # No baseline yet.  Seed the clock from now rather than arming immediately:
    # enabling this must not make every label on the host ignore pressure at
    # once on its first tick.
    write_stamp "$deadline_base_path"
    staleness_override_reason="staleness_sec=unknown-seeded max_defer_sec=$max_defer"
    return 1
  fi
  staleness_override_reason="staleness_sec=$age max_defer_sec=$max_defer"
  [ "$age" -ge "$max_defer" ] || return 1
  # Once armed, do not arm again on the very next tick.  A backup failing for a
  # NON-pressure reason would otherwise ignore pressure on every tick forever.
  if escalated_age=$(age_of "$escalation_path") && [ "$escalated_age" -lt "$escalation_retry" ]; then
    staleness_override_reason="$staleness_override_reason escalation_retry_in_sec=$((escalation_retry - escalated_age))"
    return 1
  fi
  write_stamp "$escalation_path"
  pressure_escalated=1
  guard_log "result=staleness-override-armed $staleness_override_reason"
  return 0
}

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

    # This cycle is past the staleness deadline, so it is allowed to finish.
    # This branch -- not the admission one -- is the one that matters: 46 of the
    # 48h sample's 51 started cycles were killed HERE, after passing admission
    # cleanly, and the sweep therefore never reached its later sources.  The
    # cgroup limits on the unit (MemoryHigh/MemoryMax/MemorySwapMax) and Kopia's
    # --parallel=1 remain the brake for an overridden run; this only removes the
    # brake that was stopping the backup from ever completing.
    if [ "$pressure_escalated" = 1 ]; then
      continue
    fi

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
    # printf "%.3f", NOT a bare `print`: awk's default OFMT is %.6g, so a ~1.79e9 epoch
    # deadline prints as "1.78836e+09" — ~3700s SHORT of the real value. The deadline then
    # lands in the past, the grace loop below exits on its first evaluation, and the child is
    # SIGKILLed immediately no matter what KOPIA_BACKUP_STOP_GRACE_SEC says. That defeats the
    # child's EXIT trap, which is what reaps the root-owned Kopia PID (see the header note),
    # and it surfaces as a bash job-control notice on the guard's stderr.
    stop_deadline=$(awk -v now="$(date +%s.%N)" -v grace="$stop_grace" 'BEGIN { printf "%.3f", now + grace }')
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
  # Evaluate every admission signal first, then take ONE deferral decision, so
  # the staleness floor applies to all of them.  An unreadable PSI file defers
  # exactly like real pressure and so must escalate exactly like it: otherwise a
  # host that stops publishing pressure never backs up again either.
  admission_block_reason=
  memory_psi=$(read_full_avg10 "$memory_path") || memory_psi=
  io_psi=$(read_full_avg10 "$io_path") || io_psi=
  if [ -z "$memory_psi" ]; then
    admission_block_reason="pressure-unavailable signal=memory path=$memory_path"
  elif [ -z "$io_psi" ]; then
    admission_block_reason="pressure-unavailable signal=io path=$io_path"
  elif at_or_above "$memory_psi" "$memory_limit"; then
    admission_block_reason="memory-pressure full_avg10=$memory_psi limit=$memory_limit"
  elif at_or_above "$io_psi" "$io_limit"; then
    admission_block_reason="io-pressure full_avg10=$io_psi limit=$io_limit"
  fi

  arm_staleness_override || true
  if [ -n "$admission_block_reason" ]; then
    if [ "$pressure_escalated" = 1 ]; then
      guard_log "result=admitted-despite-pressure reason=$admission_block_reason $staleness_override_reason"
    else
      guard_log "result=deferred reason=$admission_block_reason $staleness_override_reason"
      exit 0
    fi
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
# Only a run that actually completed resets the staleness clock.  A deferral
# never reaches here, and the scheduled runtime-abort path returns above, so
# neither can be mistaken for coverage.
if [ "$rc" -eq 0 ]; then
  write_stamp "$deadline_base_path"
fi
return "$rc"
}

main "$@"; exit $?
