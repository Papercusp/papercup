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
  echo "usage: $0 --mode scheduled|wait [--label NAME] [--no-restart-safe] -- COMMAND [ARG ...]" >&2
  exit 64
}

mode=
label=kopia
# The priority-waiter handoff below TERMINATES a running scheduled child. That is
# only sound when the child is restart-safe: a content-addressed Kopia snapshot
# resumes cheaply, so preempting it costs almost nothing and unblocks a
# higher-priority producer. Default 1 keeps that behaviour byte-identical.
#
# --no-restart-safe marks a child for which the assumption is FALSE. The db-dump
# is the measured case (WI-10001467): `pg_dump -Fd` has no resume, and its only
# success record -- the `backup OK in Ns` log line and the STATUS.json write --
# lands at the very END. Preempting it discards the entire cycle and records
# nothing, so the failure is invisible to every artifact-based health check (a
# killed run still writes its dump directories, so mtime reads FRESH on exactly
# the runs that were killed). Measured 2026-09-16: the 00:00 cycle dumped
# papercusp-state (19G) and papercusp-transcript (83G), then was killed at
# 00:21:19 before recording success; hourly cadence had collapsed to 4-17h gaps.
restart_safe=1
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
    --no-restart-safe)
      restart_safe=0
      shift
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
# Keep the override ahead of the primary six-hour freshness alarm. Pressure may
# defer a cycle, but it must not defer every cycle until the alarm fires.
max_defer="${KOPIA_BACKUP_MAX_DEFER_SEC:-3600}"
# A scheduled cycle that did not run is retryable, not successful. EX_TEMPFAIL
# makes the skipped work visible in systemd's recorded exit status while the
# scheduled units' SuccessExitStatus=75 keeps expected retries out of OnFailure;
# a completed child still returns its own status below.
scheduled_defer_exit=75
# A scheduled child may itself use EX_TEMPFAIL (for example, the immutable
# script snapshot wrapper). Do not let the unit-level SuccessExitStatus=75
# mistake that real failure for a guard deferral; normalize the collision to a
# distinct non-success status after retaining the original in the guard log.
scheduled_child_tempfail_exit=74
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

priority_request_path=
cleanup_priority_request() {
  [ -z "$priority_request_path" ] || rm -f "$priority_request_path" 2>/dev/null || true
}

# A blocking waiter must be able to hand the shared lock back from a long hot
# sweep. POSIX flock does not promise that a waiter will outrank a holder's
# next work, and a single multi-hour `kopia snapshot create` otherwise leaves
# the hourly DB backup parked indefinitely. The marker is adjacent to the
# shared lock so user and root guards use the same request namespace.
register_priority_request() {
  priority_request_path="${lock_path}.${state_key}.$$.wait"
  if ! printf '%s\n' "$$" >"$priority_request_path" 2>/dev/null; then
    priority_request_path=
    return 0
  fi
  trap cleanup_priority_request EXIT
}

# Validate the marker's owner before honoring it. A SIGKILL can bypass the EXIT
# trap, and a stale PID must never make every scheduled snapshot self-cancel.
has_live_priority_waiter() {
  local request pid cmd
  for request in "${lock_path}".*.wait; do
    [ -f "$request" ] || continue
    pid=$(cat "$request" 2>/dev/null || true)
    if ! [[ "$pid" =~ ^[0-9]+$ ]] || [ ! -r "/proc/$pid/cmdline" ]; then
      rm -f "$request" 2>/dev/null || true
      continue
    fi
    cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    # A scheduled-mode marker is only written after the staleness floor arms;
    # it is therefore a priority waiter too. Ignoring it lets a hot sweep keep
    # the lock while the recovery-point-critical DB dump is already waiting.
    if [[ "$cmd" == *kopia-backup-guard.sh*--mode\ wait* ||
          "$cmd" == *kopia-backup-guard.sh*--mode\ scheduled* ]]; then
      return 0
    fi
    rm -f "$request" 2>/dev/null || true
  done
  return 1
}

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
  # FD 9 is the guard's ownership token, not part of the command contract.
  # Never let the child inherit it. If this wrapper is SIGKILLed, an otherwise
  # healthy/blocked child can outlive us; inheriting the open file description
  # made that orphan retain the global flock indefinitely (WI-10000839).
  # Keeping the descriptor only in this supervising shell makes wrapper death
  # release the lock immediately, while normal runs remain serialized for the
  # full child lifetime because this shell waits below.
  "$@" 9>&- &
  child_pid=$!

  local declined_handoff_logged=0

  while kill -0 "$child_pid" 2>/dev/null; do
    sleep "$monitor_interval"
    kill -0 "$child_pid" 2>/dev/null || break

    # A wait-mode producer (the daily home snapshot or a protected/manual
    # snapshot) has priority over a hot sweep. Terminate only
    # this scheduled child and release the flock; content-addressed Kopia
    # snapshots are restart-safe, while leaving the waiter blocked is not.
    #
    # ...but ONLY when this child really is restart-safe. For a
    # --no-restart-safe child (see restart_safe above) the trade inverts: the
    # waiter loses at most this child's remaining runtime, which is bounded,
    # whereas the child loses ALL of its work and writes no success record. We
    # hold the lock and log it ONCE, so declining to yield stays observable
    # instead of looking like a guard that forgot to check.
    if has_live_priority_waiter; then
      if [ "$restart_safe" -eq 1 ]; then
        runtime_abort_reason="priority-waiter shared-guard handoff"
        break
      fi
      if [ "$declined_handoff_logged" -eq 0 ]; then
        declined_handoff_logged=1
        guard_log "result=holding-against-priority-waiter reason=child-not-restart-safe child_pid=$child_pid"
      fi
    fi

    # NO MID-RUN PRESSURE CANCELLATION.  Both candidate signals were measured on
    # this host 2026-09-05 and NEITHER describes a harm this backup can relieve:
    #
    #   HOST-WIDE /proc/pressure/memory is fleet-driven, not backup-driven.
    #   Sampled at 2s for 2.7 minutes with ZERO kopia processes running it ranged
    #   0.02-41.91 and sat at or above the limit of 5 in 52.4% of 82 samples.  The
    #   mid-run check aborts on the FIRST crossing, so a run needs an unbroken
    #   sub-limit streak for its whole duration: 1024s-2332s required against a
    #   40s longest observed.  Result: 20 of 20 ordinary cycles killed after
    #   passing admission (10s-426s in), zero coverage.
    #
    #   PER-CGROUP memory.pressure is real and isolated -- a fresh cgroup starts
    #   at total=0 and tracks only its own stalls -- but what it measures is the
    #   backup's OWN page-cache reclaim, which is what reading the filesystem IS.
    #   Measured on the 23:00 cycle: the cgroup rose 1.71 -> 2.47 -> 5.36 in 25s
    #   at 1.4G RSS (nowhere near MemoryHigh=8G) while root read 19.50 -> 9.93,
    #   independent numbers, and the run was killed at 30s.  A threshold of 5 on
    #   that signal means "this job is doing I/O", not "the host is hurting".
    #
    # So a per-sample threshold cancels a data-safety job either for someone
    # else's load or for its own normal operation, and zero coverage is the larger
    # harm.  What actually bounds this backup is what always did: the unit's
    # MemoryHigh=8G / MemoryMax=12G with MemorySwapMax=0, Nice=10, ionice
    # best-effort 7, and Kopia's --parallel=1.  Direct evidence that running
    # ungated is safe here: the two cycles that skipped this check entirely (the
    # staleness-override path) both completed, with no host incident in either
    # window.  Admission still defers on the host-wide signal, so a genuinely
    # burning box still delays the START of a cycle; the priority-waiter handoff
    # above still preempts a hot sweep for a higher-priority producer.
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
    return "$scheduled_defer_exit"
  fi
  return "$child_rc"
}

if [ "$mode" = scheduled ]; then
  # Lock contention is another deferral path. Arm the staleness floor before
  # the nonblocking flock so a scheduled producer cannot defer forever without
  # ever recording that it has crossed its recovery-point deadline. Once the
  # floor is armed, become a priority waiter: the hot-sweep handoff recognizes
  # this marker and yields the shared lock instead of starving this producer.
  arm_staleness_override || true
  if ! flock -n 9; then
    if [ "$pressure_escalated" = 1 ]; then
      register_priority_request
      guard_log "result=waiting reason=staleness-override-lock $staleness_override_reason"
      flock 9 || exit "$scheduled_defer_exit"
      cleanup_priority_request
    else
      guard_log "result=deferred reason=lock-held $staleness_override_reason"
      exit "$scheduled_defer_exit"
    fi
  fi

  # WHY THE CGROUP AND NOT /proc/pressure -- measured on this host 2026-09-05.
  #
  # The host-wide files do not measure this backup.  They measure the box, and
  # this box runs a large agent fleet: sampled at 2s for 2.7 minutes with ZERO
  # kopia processes running, /proc/pressure/memory full avg10 swung 0.02 -> 41.91
  # and sat AT OR ABOVE the limit of 5 for 52.4% of samples, at load average 162
  # across 128 cores with 79 agent processes alive.
  #
  # The mid-run gate aborts on the FIRST sample at or above the limit, so a run
  # survives only on an unbroken sub-limit streak lasting its whole duration.
  # Required: 1024s and 2332s -- the two runtimes that actually completed.
  # Longest sub-limit window observed: 40 SECONDS.  That 25-58x gap is why 19 of
  # 19 ordinary cycles died on 2026-09-05 (10s-426s each) while the only two
  # successes were both staleness-override-armed: the escape hatch had become
  # the schedule.
  #
  # Raising the limit was rejected above for the right reason (a larger constant
  # has the same unbounded shape).  Hysteresis was considered and rejected too:
  # the crossings are real and sustained, not transient hair-crossings, so
  # smoothing cannot help when the signal itself is the wrong one.  The defect is
  # that the backup was CANCELLED for pressure it did not create, cannot relieve,
  # and is already isolated from -- it runs at nice 19, ionice idle, capped by the
  # unit at MemoryHigh=8G/MemoryMax=12G with MemorySwapMax=0.  Those caps, not a
  # host-wide reading, are what protect the host from the backup.  The question
  # the gate should ask is "is THIS BACKUP thrashing", and the cgroup answers it.
  # ADMISSION reads the HOST-WIDE files deliberately, and the per-cgroup files
  # are not a usable substitute HERE even though they are real.  This unit is
  # Type=oneshot, so at admission its cgroup is seconds old and reads
  # "full avg10=0.00 total=0" every time -- an admission gate gated on it would
  # never defer anything, which is worse than no gate because it would still
  # LOOK like one.  Admission asks "is the box already in trouble before we add
  # load", and only /proc/pressure answers that.  (The per-cgroup signal is
  # genuinely isolated and does describe this backup once it is running -- see
  # the mid-run note in run_scheduled_command for why acting on it there is
  # still wrong.)
  psi_scope=host
  default_memory_path=/proc/pressure/memory
  default_io_path=/proc/pressure/io
  memory_path="${KOPIA_BACKUP_MEM_PSI_PATH:-$default_memory_path}"
  io_path="${KOPIA_BACKUP_IO_PSI_PATH:-$default_io_path}"
  # Report the scope we ACTUALLY read, not the one we would have picked.  An
  # explicit override (the test harness, or a host-specific unit drop-in) means
  # the reading is neither this cgroup's nor the host's, and a log line claiming
  # otherwise would be a label that does not mean what it says.
  if [ "$memory_path" != "$default_memory_path" ] || [ "$io_path" != "$default_io_path" ]; then
    psi_scope=override
  fi
  guard_log "result=psi-scope scope=$psi_scope memory_path=$memory_path io_path=$io_path"

  # Evaluate every admission signal before taking ONE deferral decision. The
  # staleness floor was armed once before lock acquisition and applies to all of
  # them. An unreadable PSI file defers exactly like real pressure and so must
  # escalate exactly like it: otherwise a host that stops publishing pressure
  # never backs up again either.
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

  if [ -n "$admission_block_reason" ]; then
    if [ "$pressure_escalated" = 1 ]; then
      guard_log "result=admitted-despite-pressure reason=$admission_block_reason $staleness_override_reason"
    else
      guard_log "result=deferred reason=$admission_block_reason $staleness_override_reason"
      exit "$scheduled_defer_exit"
    fi
  fi
else
  register_priority_request
  guard_log "result=waiting reason=lock"
  flock 9 || exit 75
  cleanup_priority_request
fi

export KOPIA_BACKUP_GUARD_ACTIVE=1
guard_log "result=started mode=$mode"
if [ "$mode" = scheduled ]; then
  run_scheduled_command "$@"
  rc=$?
  # Same contract as an admission-time pressure deferral: the scheduled cycle
  # intentionally did no complete snapshot, so preserve its retryable
  # EX_TEMPFAIL status for systemd. The scheduled units classify that code as an
  # expected retry; a completed child keeps its own status, including genuine
  # failures that must still reach OnFailure.
  if [ -n "$runtime_abort_reason" ]; then
    return "$rc"
  fi
  if [ "$rc" -eq "$scheduled_defer_exit" ]; then
    guard_log "result=finished mode=$mode rc=$rc normalized_rc=$scheduled_child_tempfail_exit"
    rc="$scheduled_child_tempfail_exit"
  else
    guard_log "result=finished mode=$mode rc=$rc"
  fi
else
  # Same ownership boundary as the scheduled path above. In particular, the
  # workspace pg_dump hook has its own watchdog; killing this wait-mode wrapper
  # must not leave pg_dump holding our flock after it is reparented to systemd.
  "$@" 9>&-
  rc=$?
  guard_log "result=finished mode=$mode rc=$rc"
fi
# Only a run that actually completed resets the staleness clock.  A deferral
# never reaches here, and the scheduled runtime-abort path returns above, so
# neither can be mistaken for coverage.
if [ "$rc" -eq 0 ]; then
  write_stamp "$deadline_base_path"
fi
return "$rc"
}

main "$@"; exit $?
