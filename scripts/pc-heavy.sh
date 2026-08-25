#!/usr/bin/env bash
# pc-heavy — run a heavy build/test command under a host-wide flock COUNTING
# semaphore so N agents' vitest / tsc / test:affected runs stagger instead of
# all landing on the shared 128-core box at once (WI-3821).
#
# Companion to the heavy-command admission gate in
# apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh: that gate
# DENIES a raw heavy command when the host is already saturated (load1 past the
# threshold). THIS wrapper is the "run it anyway, politely" path — it WAITS for
# a free build slot (up to a timeout) and runs the command niced, instead of
# failing. It exports PC_HEAVY_BYPASS=1 into the child so the admission gate
# does NOT also deny it (the wrapper already self-limits concurrency).
#
# Why a wrapper and not the hook: a PreToolUse hook decides allow/deny then
# exits BEFORE the command runs, so it cannot hold a slot for the command's
# lifetime. Holding a slot needs a process that lives as long as the command —
# this one. (Precedent: WI-3550 gave the kopia snapshot timer a flock guard +
# nice/ionice for the same class of problem at a smaller scope.)
#
# Usage:
#   scripts/pc-heavy.sh [--] <command> [args...]
#   scripts/pc-heavy.sh --exclusive-all-slots [--] <command> [args...]
#   scripts/pc-heavy.sh npm run test:affected
#   scripts/pc-heavy.sh -- ./node_modules/.bin/vitest run lib/x.test.ts
#
# Tunables (env):
#   PC_HEAVY_SLOTS        concurrent heavy runs allowed. Set = FIXED count (no load
#                         adaptation). Default: LOAD-ADAPTIVE (EI-19313096203661357) —
#                         floor max(2, cores/32) when the box is saturated (32 mirrors
#                         affected-tests.mjs's per-suite worker cap, so floor occupancy
#                         is ~1x the box even if every admitted job is a full sweep),
#                         widening by one slot per 16 cores of load1 headroom, capped
#                         at cores/8. The old fixed cores/32 modeled EVERY job as a
#                         32-worker sweep, so a 128-core box admitted 4 jobs even at
#                         load 20 while tsc/small test:file runs (~1-4 cores each)
#                         queued 57 deep behind them. Waiters recompute while polling,
#                         so the admitted count tracks load in both directions.
#   PC_HEAVY_LOAD1_OVERRIDE  inject load1 for the adaptive default (tests — same
#                         convention as pretooluse-bash-resource-gate.sh); non-numeric
#                         or unreadable load fails conservative, to the floor.
#   PC_HEAVY_MEM_CLAMP    "1"(default)/"0" — clamp the effective slot count to
#                         what MemAvailable can physically hold
#                         (EI-20336929607862174). The load-adaptive count above
#                         is anti-correlated with memory: reclaim stalls lower
#                         load1, which WIDENS admission exactly when memory is
#                         scarce. Applies to a FIXED PC_HEAVY_SLOTS too, never
#                         clamps below 1, and fails open on any unreadable
#                         input. off/false/no also disable.
#   PC_HEAVY_MEM_PER_SLOT_GIB  GiB budgeted per admitted heavy run (default 6 —
#                         a `tsc -p packages/operator-core` peaks 4.7-6.9 GiB,
#                         and it is the most-run heavy command here).
#   PC_HEAVY_MEM_PSI_BACKOFF  memory PSI full avg10 at or above which the
#                         budget is HALVED (default 5, the threshold
#                         infra-liveness already alerts on). A box in reclaim
#                         must not admit at its ceiling.
#   PC_HEAVY_MEMAVAIL_GIB_OVERRIDE / PC_HEAVY_MEM_PSI_OVERRIDE  inject
#                         MemAvailable-GiB / PSI for the clamp (tests — same
#                         convention as PC_HEAVY_LOAD1_OVERRIDE).
#   PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE /
#   PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE  inject the caller-cgroup
#                         envelope for tests. `max` means unlimited. In normal
#                         operation these are read from cgroup-v2 directly.
#   PC_HEAVY_SYSTEMD_RUN_BIN  test-only override for the detached user-scope
#                         runner. In normal operation `systemd-run` is resolved
#                         from PATH when a finite caller cgroup cannot hold tsc.
#   PC_HEAVY_TYPECHECK_OVERHEAD_MIB  non-V8 headroom required beside the
#                         configured TypeScript heap (default 1024). A full
#                         typecheck is refused when its finite caller cgroup
#                         cannot hold heap + overhead; use the detached
#                         capability:inspect/build:typecheck path instead.
#   PC_HEAVY_GATE_RESERVE "1"(default)/"0" — while a green-checkpoint run is in
#                         flight, clamp the effective slot count to a quarter of
#                         the steady-state target (min 1) so the gate's isolation
#                         re-run keeps host headroom (EI-19315056231449472; see
#                         the block by _gate_reserve_active). off/false/no also
#                         disable. Applies to a FIXED PC_HEAVY_SLOTS too.
#   PC_HEAVY_ALLOW_DURING_GATE  unset(default)/"1" — escape hatch for the REFUSAL
#                         (EI-19385714326170346, _gate_refuse_broad_sweep): a
#                         broad `test:affected` sweep is refused, not merely
#                         clamped, while the gate is in its `isolating`/
#                         `delivering` classifier phases, because contention
#                         there flips VERDICTS rather than costing time. Scoped
#                         `test:file` runs are never refused. Set to 1 when you
#                         genuinely need the full sweep during that window.
#   PAPERCUSP_CHECKPOINT_LOG_DIR  where green-checkpoint publishes its run lock
#                         (default ~/.papercusp/checkpoint-logs) — the SAME var
#                         release-config.ts resolves it from, so an alternate
#                         lineage or a test lines up without a second knob.
#   PC_HEAVY_DEBUG        "1" → print the computed slot count + inputs to stderr.
#   PC_HEAVY_TIMEOUT_SEC  max seconds to WAIT for a slot before running anyway
#                         (default 900). Running-anyway (never blocking forever)
#                         keeps a wedged holder from deadlocking the fleet; the
#                         kernel also frees a slot the instant its holder dies.
#                         If the caller TERM/HUPs this wrapper while it is still
#                         queued, it exits 75 (EX_TEMPFAIL) with retry context
#                         instead of surfacing an ambiguous signal exit.
#   PC_HEAVY_PREEMPTIBLE  "auto"(default)/"1"/"0" — on hosts with `setsid`,
#                         every ordinary holder cooperatively yields its whole
#                         child process group when an exclusive materializer
#                         appears. `1` requires setsid and fails closed when it
#                         is unavailable; `0`/off/false/no is the explicit
#                         escape hatch for a caller that cannot be interrupted.
#                         The default MUST cover coalesced leaders too: any
#                         ordinary command may outlive the exclusive 900s drain.
#   PC_HEAVY_PREEMPT_GRACE_SEC / PC_HEAVY_PREEMPT_TERM_GRACE_SEC /
#   PC_HEAVY_PREEMPT_POLL_SEC  finish-before-TERM grace, TERM-before-KILL
#                         grace, and writer-poll cadence (defaults 30/30/0.1).
#   PC_HEAVY_DURABLE_CALLER "1" — the caller is a confined background task
#                         whose workload is meant to outlive the process that
#                         launched it (for example, capability:bash across an
#                         operator-host recycle). Keeps exclusive-materializer
#                         preemption, but does not treat the launcher's PPID
#                         disappearing as proof that the workload is orphaned.
#   PC_HEAVY_PREEMPT_AFTER_READY "1" — opt in to an after-ready barrier for a
#                         command that publishes PC_HEAVY_PREEMPT_READY_FILE
#                         after its irreversible setup/derivation. While that
#                         marker exists, an exclusive materializer waits for
#                         the command to finish instead of preempting it, up to
#                         PC_HEAVY_PREEMPT_READY_MAX_SEC (default 600s; 0 opts
#                         into the legacy unbounded wait). The default stays
#                         below the materializer's 900s drain budget so a
#                         protected test cannot starve every release gate.
#                         The wrapper creates a unique marker path and exports
#                         it to the child; the child owns publication/cleanup.
#   PC_HEAVY_PREEMPT_READY_DIR  directory for those per-run marker paths
#                         (default ${TMPDIR:-/tmp}/pc-heavy-ready).
#   PC_HEAVY_SCOPED_TIMEOUT_SEC  bounded wait for `test:file`'s
#                         `scripts/test-files.mjs` command (default 30). Exact-file
#                         verification is deliberately narrow and must not inherit
#                         a broad sweep's 15-minute queue budget. An explicit
#                         PC_HEAVY_TIMEOUT_SEC still wins for callers that need a
#                         different bound.
#   PC_HEAVY_FOCUSED_SLOTS  concurrent focused `test:file` or explicitly scoped
#                         `lint:tsc* --files=…` runs allowed in the separate lane
#                         while a release-gate reserve or exclusive materialization
#                         barrier is live (default 1). This lane prevents the
#                         scoped verification recommended during gate classifier
#                         phases, or while materialization owns every ordinary
#                         slot, from waiting behind the reserve's last slot; it
#                         remains bounded so those critical paths retain headroom.
#   PC_HEAVY_DIR          slot-file dir (default ${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots)
#   PC_HEAVY_NICE         nice increment (default 10)
#   PC_HEAVY_IONICE       ionice spec: "best-effort N" | "idle" | "" to skip
#                         (default "best-effort 7"; UNSET uses the default,
#                         set-but-EMPTY skips ionice)
#   PC_HEAVY_COALESCE     "1"(default)/"0" — coalesce genuinely-CONCURRENT
#                         identical invocations (see below). off/false/no also
#                         disable.
#   PC_HEAVY_COALESCE_SEC result-freshness window in seconds (default 90) —
#                         how long an ALREADY-FINISHED result may be replayed.
#                         This is NOT how long a follower waits for a running
#                         leader; see below.
#   PC_HEAVY_FRESH_AFTER  epoch-seconds watermark. Replay a cached run only if
#                         it STARTED at/after this instant, and drop the
#                         tree-state token from the coalescing key. For a caller
#                         that knows WHICH files it is asking about: it answers
#                         the freshness question exactly (per file) where the
#                         token answers it conservatively (whole tree), which on
#                         a fleet-edited tree is the difference between
#                         coalescing always and never. See the long note at the
#                         barrier below. Opt-in; unset ⇒ unchanged behaviour.
#   PC_HEAVY_KEY_ENV      comma/space-separated NAMES of environment variables
#                         that change this command's RESULT, folded into the
#                         coalescing key. Required for any caller whose inputs
#                         arrive by env rather than argv (e.g. AFFECTED_BASE),
#                         since cwd+argv+token cannot see them and two callers
#                         would otherwise replay each other's verdict for a
#                         DIFFERENT question (EI-78). Unset and empty are folded
#                         distinctly. Declaring nothing leaves the key unchanged;
#                         declaring more can only ever coalesce LESS, never more.
#   PC_HEAVY_COALESCE_MAX_WAIT_SEC
#                         hard cap on how long a follower waits for a LIVE
#                         leader (default 1800). Leader liveness is OBSERVED
#                         (pid + start-time), so this only bounds a leader that
#                         is hung-but-alive; a dead leader is detected at once.
#   PC_HEAVY_RETRY_PREEMPTIONS
#                         opt-in number of bounded retries when an attempt is
#                         preempted by the exclusive materializer. Only the
#                         exact machine-readable
#                         `status=preempted reason=exclusive-materializer`
#                         result is retryable; unrelated exit 75 results are
#                         returned unchanged. Retry attempts disable coalescing
#                         so a preempted rc=75 cannot be replayed. The value is
#                         capped at 10 to keep the retry policy bounded.
#                         Default: 0.
#
# Crash-safe: the slot is an flock held on an open fd for the child's whole
# lifetime; the kernel releases it when this process exits for ANY reason
# (including SIGKILL), so a crashed run never leaks a slot. No daemon, no DB.
#
# Fail-open: if the slot dir can't be made or no slot machinery is available,
# the command still runs (unthrottled) — admission control must never be the
# reason a legitimate build can't start.
#
# ── Coalescing (EI-18685262961418231) ───────────────────────────────────────
# Slots stagger concurrency but do NOT stop a burst of agents each requesting
# the EXACT SAME command (same cwd + argv — e.g. many agents each running
# `npm run lint:tsc` to confirm the same gate) from each separately queueing
# for and consuming a slot: N agents still pay for N full tsc/vitest runs of
# what is very likely the same input, which is exactly how "~19 typecheck jobs
# queued" became a fleet-wide chokepoint delaying a critical-path lane's green
# confirmation. Coalescing fixes the WASTE, not the staggering: the first
# caller for a given (cwd, argv) key becomes the leader and runs it for real
# (through the normal slot machinery below, unchanged); any identical caller
# that shows up while the leader is running, or shortly after it finished
# (within PC_HEAVY_COALESCE_SEC), replays the leader's captured output +
# exit code instead of spawning a second copy — never waiting for a slot at
# all. This is deliberately SHORT-lived (default 90s, far shorter than the
# ~10min git-sync auto-commit cadence) and keyed only on command identity, not
# tree content: it is thundering-herd coalescing, not a content-addressed
# result cache — we do NOT want a second, home-rolled version of the tsc
# `--incremental` staleness bug EI-487 already burned this team on.
#
# A slow leader is never blocked on by a follower forever — but "is the leader
# still alive?" is answered by OBSERVING it, never by a timeout. See the
# leader-liveness note at the wait loop below (EI-19343301596011451): tying the
# follower's patience to PC_HEAVY_COALESCE_SEC made coalescing INVERT for every
# command slower than that window, which is precisely the set of commands it
# exists to protect. Kill-switch: PC_HEAVY_COALESCE=0.

# NOTE: deliberately no `set -e` — a non-blocking flock miss returns non-zero by
# design and must not abort the script.
set -uo pipefail

# Bash parses a function body in full before executing it. Keep the wrapper's
# dispatch path in one body so a git-sync rewrite cannot change the bytes bash
# reads between two top-level commands during a long-running invocation
# (EI-20227475180704442).
main() {

# Return Linux /proc's process start-time tick for PID. Pairing this with the
# numeric PID distinguishes a still-live caller from a later process that reused
# its PID. Fail closed to the caller of this helper; the liveness guard below is
# deliberately fail-open when /proc is unavailable or malformed.
_pc_heavy_proc_start_ticks() {
  local _pid="${1:-}" _stat='' _after_comm=''
  case "$_pid" in ''|*[!0-9]*) return 1 ;; esac
  IFS= read -r _stat < "/proc/$_pid/stat" 2>/dev/null || return 1
  # comm is parenthesized and may contain spaces. Strip through the LAST `) `,
  # after which token 1 is field 3 (state), making token 20 field 22 (starttime).
  _after_comm="${_stat##*) }"
  set -- $_after_comm
  [ "$#" -ge 20 ] || return 1
  printf '%s\n' "${20}"
}

# Internal command runner used by EVERY ordinary slot holder, including a
# coalescing leader. It is dispatched before the PC_HEAVY_BYPASS fast path so
# the outer wrapper can keep its slot/cache responsibilities while this child
# owns the interruptible process group. This is an implementation mode, not a
# public second semaphore: it never acquires a slot of its own.
_pc_heavy_internal_preempt_run() {
  local _outer_pid="$1"
  shift
  local _intent_path="$1"
  shift
  local _preempt_grace="${PC_HEAVY_PREEMPT_GRACE_SEC:-30}"
  local _preempt_term_grace="${PC_HEAVY_PREEMPT_TERM_GRACE_SEC:-30}"
  local _preempt_poll="${PC_HEAVY_PREEMPT_POLL_SEC:-0.1}"
  # Hysteresis: how long the intent signal must be continuously ABSENT before a
  # running grace clock is abandoned. Without it a single transient free poll
  # zeroes the clock, which is the second half of the starvation bug — the grace
  # is supposed to bound how long a materializer waits, so it must survive an
  # instant of noise rather than restart from zero.
  local _preempt_clear_after="${PC_HEAVY_PREEMPT_CLEAR_SEC:-5}"
  case "$_preempt_clear_after" in ''|*[!0-9]*) _preempt_clear_after=5 ;; esac
  local _preempt_pid_dir="${PC_HEAVY_PREEMPT_PID_DIR:-$(dirname "$_intent_path")}" 
  local _preempt_pid_file="$_preempt_pid_dir/preemptible.$$.pid"
  local _preempt_notify_fd="${PC_HEAVY_PREEMPT_NOTIFY_FD:-}"
  local _preempt_ready_file="${PC_HEAVY_PREEMPT_READY_FILE:-}"
  local _preempt_ready_max="${PC_HEAVY_PREEMPT_READY_MAX_SEC:-600}"
  local _preempt_caller_pid="${PC_HEAVY_CALLER_PID:-}"
  local _preempt_caller_start_ticks="${PC_HEAVY_CALLER_START_TICKS:-}"
  local _preempt_wait_pid='' _preempt_child_pid='' _preempt_seen_at='' _preempt_free_since=''
  local _preempt_ready_seen_at=''
  local _preempt_now='' _preempt_start_deadline='' _preempt_term_deadline=''
  local _preempt_result_emitted=0

  # Coalescing leaders route stdout/stderr through FIFOs whose readers belong
  # to the outer wrapper. If that wrapper is hard-killed, a diagnostic write to
  # the now-readerless stderr FIFO would deliver SIGPIPE and kill this detached
  # monitor before it can reap the workload group. Keep the monitor alive; a
  # failed write is harmless once the caller has gone away, and normal capture
  # is unchanged while the reader is present. The disposition is inherited by
  # the workload so a late diagnostic cannot defeat the same cleanup boundary.
  trap '' PIPE

  # The outer wrapper duplicates its original stderr before a coalescing
  # leader redirects fd 2 through a capture FIFO. Accept that descriptor only
  # when it is a valid, writeable numeric fd; an invalid inherited value must
  # never turn a cleanup diagnostic into a redirection error.
  case "$_preempt_notify_fd" in
    ''|0|1|2|*[!0-9]*) _preempt_notify_fd='' ;;
    *)
      if [ ! -e "/proc/self/fd/$_preempt_notify_fd" ] || ! { : >&"$_preempt_notify_fd"; } 2>/dev/null; then
        _preempt_notify_fd=''
      fi
      ;;
  esac

  case "$_preempt_grace" in ''|*[!0-9]*) _preempt_grace=30 ;; esac
  case "$_preempt_term_grace" in ''|*[!0-9]*) _preempt_term_grace=30 ;; esac
  case "$_preempt_poll" in ''|*[!0-9.]*) _preempt_poll=0.1 ;; esac
  case "$_preempt_ready_max" in ''|*[!0-9]*) _preempt_ready_max=600 ;; esac
  case "$_preempt_caller_pid" in ''|*[!0-9]*) _preempt_caller_pid=''; _preempt_caller_start_ticks='' ;; esac
  case "$_preempt_caller_start_ticks" in
    ''|*[!0-9]*) _preempt_caller_pid=''; _preempt_caller_start_ticks='' ;;
  esac
  mkdir -p "$_preempt_pid_dir" 2>/dev/null || true
  rm -f "$_preempt_pid_file" 2>/dev/null || true

  # The OUTER wrapper alone owns the semaphore slot. The monitor and real
  # command must not inherit it: if the wrapper is killed, its kernel flock is
  # the crash-safe lifetime boundary and releases immediately even while this
  # helper takes a moment to reap the child group. This also preserves the
  # coalescing capture invariant that passive helpers never retain a slot.
  local _inherited_fd_path='' _inherited_fd=''
  for _inherited_fd_path in /proc/self/fd/*; do
    _inherited_fd="${_inherited_fd_path##*/}"
    case "$_inherited_fd" in
      0|1|2|"$_preempt_notify_fd") ;;
      *) eval "exec ${_inherited_fd}>&-" 2>/dev/null || true ;;
    esac
  done
  # A coalescing leader routes this monitor's stdio through FIFO readers owned
  # by the outer wrapper. A caller-side process-group SIGKILL removes those
  # readers first; the monitor must survive the resulting broken pipe long
  # enough to reap the isolated workload. Reset PIPE to its normal disposition
  # in the workload launcher below so user commands do not inherit this
  # monitor-only policy.
  trap '' PIPE

  _preempt_notify() {
    local _message="$1"
    if [ -n "$_preempt_notify_fd" ]; then
      printf '%s\n' "$_message" >&"$_preempt_notify_fd" 2>/dev/null || true
    else
      printf '%s\n' "$_message" >&2 2>/dev/null || true
    fi
  }

  # The ordinary child owns publication, but the monitor owns the final cleanup
  # boundary as well. A SIGTERM/SIGKILL during the affected run may prevent
  # Node's `exit` handler from removing the marker; leaving it behind would
  # make a later reader mistake a dead run for a live after-ready barrier.
  _preempt_cleanup_ready_marker() {
    if [ -n "${_preempt_ready_file:-}" ]; then
      rm -f "${_preempt_ready_file}" 2>/dev/null || true
    fi
  }

  _preempt_ready_is_published() {
    [ -n "${_preempt_ready_file:-}" ] && [ -f "${_preempt_ready_file}" ]
  }

  # A signal can arrive in the small window after the supervisor publishes the
  # child pid but before the polling loop below copies it into the local. Read
  # the durable publication before deciding that there is no group to reap;
  # otherwise the signal trap waits on the supervisor while the workload keeps
  # running (and the terminal marker never reaches the caller).
  _preempt_refresh_child_pid() {
    local _candidate=''
    if [ -z "${_preempt_child_pid:-}" ] && [ -s "${_preempt_pid_file:-}" ]; then
      _candidate=$(head -1 "${_preempt_pid_file:-}" 2>/dev/null || true)
      case "$_candidate" in
        ''|*[!0-9]*) ;;
        *) _preempt_child_pid="$_candidate" ;;
      esac
    fi
  }

  # Signal delivery is allowed to race child startup. Give the publisher a
  # short, bounded chance to finish so cleanup can still target the isolated
  # process group; a failed supervisor is handled by the caller below.
  _preempt_wait_for_child_pid() {
    local _deadline=''
    _preempt_refresh_child_pid
    [ -n "${_preempt_child_pid:-}" ] && return 0
    [ -n "${_preempt_wait_pid:-}" ] || return 1
    _deadline=$(( $(date +%s) + 1 ))
    while [ -z "${_preempt_child_pid:-}" ] && kill -0 "${_preempt_wait_pid:-}" 2>/dev/null; do
      _preempt_refresh_child_pid
      [ -n "${_preempt_child_pid:-}" ] && return 0
      [ "$(date +%s)" -ge "$_deadline" ] && break
      sleep "${_preempt_poll:-0.1}"
    done
    _preempt_refresh_child_pid
    [ -n "${_preempt_child_pid:-}" ]
  }

  # A preemptible monitor can be the only process left after the outer wrapper
  # or its child-start path aborts. Emit one machine-readable terminal result
  # for those paths so callers can distinguish "could not measure" from a test
  # command that measured and failed. Route it through the preserved notify fd
  # so coalescing leaders do not lose the marker with their capture FIFO.
  _preempt_emit_result() {
    local _status="$1" _reason="$2" _exit_code="${3:-}"
    if [ "${_preempt_result_emitted:-0}" = 1 ]; then return 0; fi
    _preempt_result_emitted=1
    local _result_line="PC_HEAVY_RESULT status=$_status reason=$_reason"
    if [ -n "$_exit_code" ]; then
      _result_line="$_result_line exit=$_exit_code"
    fi
    # Preserve the established marker byte-for-byte on stderr while also
    # publishing one private, per-attempt result for the optional outer retry
    # loop. The atomic rename keeps the wrapper from observing a half-written
    # marker if the monitor and its parent finish at the same instant.
    _preempt_notify "$_result_line"
    if [ -n "${PC_HEAVY_PREEMPT_RESULT_FILE:-}" ]; then
      local _result_tmp="${PC_HEAVY_PREEMPT_RESULT_FILE}.$$"
      if printf '%s\n' "$_result_line" > "$_result_tmp" 2>/dev/null; then
        mv -f "$_result_tmp" "${PC_HEAVY_PREEMPT_RESULT_FILE}" 2>/dev/null || rm -f "$_result_tmp" 2>/dev/null || true
      else
        rm -f "$_result_tmp" 2>/dev/null || true
      fi
    fi
  }

  # NOTE (EI-21348799817176368): every expansion in the functions reachable from
  # the traps below is `:-` defaulted. Those handlers run on EXIT/TERM/INT/HUP,
  # and a trap can fire OUTSIDE this function's dynamic extent — at which point
  # bash's dynamically-scoped `local`s are gone and `set -u` (line 191) kills the
  # CLEANUP HANDLER on an unbound variable instead of reaping the workload group.
  # Observed live at load1=109: "line 277: _preempt_child_pid: unbound variable".
  # `"${x:-}"` is byte-identical to `"$x"` whenever x is set, so this is inert on
  # the normal path and only converts that crash into the no-op the guards below
  # already handle.
  _preempt_group_alive() {
    _preempt_refresh_child_pid
    [ -n "${_preempt_child_pid:-}" ] && kill -0 -- "-${_preempt_child_pid:-}" 2>/dev/null
  }
  _preempt_leader_alive() {
    [ -n "$_preempt_wait_pid" ] && kill -0 "$_preempt_wait_pid" 2>/dev/null
  }
  # EI-21399496097779784: the outer wrapper can outlive the shell/agent that
  # launched it because it is itself waiting on the detached monitor. Checking
  # only `_outer_pid` therefore misses the exact orphan class: the caller dies,
  # init adopts the wrapper, and an already-published after-ready marker exempts
  # the workload from preemption for the full 900-second exclusive drain. Pin
  # the original caller by PID + start tick so PID reuse cannot keep an orphan
  # alive. No usable identity means fail-open to the established outer-wrapper
  # guard (important on a non-/proc host).
  _preempt_caller_alive() {
    local _current_start=''
    [ -z "${_preempt_caller_pid:-}" ] && return 0
    _current_start="$(_pc_heavy_proc_start_ticks "$_preempt_caller_pid" 2>/dev/null)" || return 1
    [ "$_current_start" = "$_preempt_caller_start_ticks" ]
  }
  # EI-21355065353185484 — this probe MUST NOT perturb what it measures.
  # It runs every _preempt_poll (0.1s default) for the whole life of a heavy job,
  # so any lock it takes is effectively held continuously from the point of view
  # of anything else contending for that file. Two rules keep it inert:
  #   1. It polls the INTENT file, never the writer MUTEX. Probing the mutex
  #      stole it from the materializer that was trying to acquire it.
  #   2. It takes a SHARED lock (-s). A shared request still fails against the
  #      materializer's exclusive hold — which is the signal we want — but two
  #      concurrent probes no longer block each other, so ordinary holders cannot
  #      manufacture a phantom "materializer is waiting" by colliding.
  # Opened append-mode: `>` would truncate a file another process has locked, and
  # `<` would race the `[ -e ]` guard when no materializer has ever run.
  _preempt_writer_is_held() {
    local _probe_fd=''
    if ! { exec {_probe_fd}>>"$_intent_path"; } 2>/dev/null; then return 1; fi
    if flock -s -n "$_probe_fd"; then
      eval "exec ${_probe_fd}>&-" 2>/dev/null || true
      return 1
    fi
    eval "exec ${_probe_fd}>&-" 2>/dev/null || true
    return 0
  }
  _preempt_reap_group() {
    local _deadline=''
    if _preempt_group_alive; then
      kill -TERM -- "-${_preempt_child_pid:-}" 2>/dev/null || true
      _deadline=$(( $(date +%s) + ${_preempt_term_grace:-30} ))
      while _preempt_group_alive && [ "$(date +%s)" -lt "$_deadline" ]; do
        sleep "${_preempt_poll:-0.1}"
      done
      if _preempt_group_alive; then
        kill -KILL -- "-${_preempt_child_pid:-}" 2>/dev/null || true
      fi
    fi
    [ -n "${_preempt_wait_pid:-}" ] && wait "${_preempt_wait_pid:-}" 2>/dev/null || true
    [ -n "${_preempt_pid_file:-}" ] && rm -f "${_preempt_pid_file:-}" 2>/dev/null || true
    _preempt_cleanup_ready_marker
  }
  _preempt_forward_signal() {
    local _sig="$1" _code="$2"
    if ! _preempt_wait_for_child_pid; then
      # No group identity was published and the supervisor is still alive.
      # Stop that supervisor so the trap cannot wait forever for a child that
      # failed before publication; when a pid was published, the normal group
      # reap below remains the authoritative cleanup boundary.
      [ -n "${_preempt_wait_pid:-}" ] && kill -TERM "${_preempt_wait_pid:-}" 2>/dev/null || true
    fi
    [ -n "${_preempt_child_pid:-}" ] && kill "-${_sig}" -- "-${_preempt_child_pid:-}" 2>/dev/null || true
    _preempt_reap_group
    _preempt_emit_result undetermined signal "$_code"
    trap - EXIT TERM INT HUP
    exit "$_code"
  }
  trap '_preempt_reap_group' EXIT
  trap '_preempt_forward_signal TERM 143' TERM
  trap '_preempt_forward_signal INT 130' INT
  trap '_preempt_forward_signal HUP 129' HUP

  # Keep a waitable supervisor and publish the actual new-session/group leader.
  # The parent trap reaps that group on every catchable exit; the caller/test
  # must TERM before KILL so the cleanup path gets a chance to run.
  setsid --fork --wait bash -c '
    trap - PIPE
    _notify_fd="${PC_HEAVY_PREEMPT_NOTIFY_FD:-}"
    case "$_notify_fd" in
      ""|0|1|2|*[!0-9]*) ;;
      *) eval "exec ${_notify_fd}>&-" 2>/dev/null || true ;;
    esac
    unset PC_HEAVY_PREEMPT_NOTIFY_FD
    unset PC_HEAVY_CALLER_PID PC_HEAVY_CALLER_START_TICKS PC_HEAVY_DURABLE_CALLER
    _pid_file="$1"
    shift
    printf "%s\n" "$$" > "$_pid_file"
    exec "$@"
  ' _ "$_preempt_pid_file" "$@" &
  _preempt_wait_pid=$!
  _preempt_start_deadline=$(( $(date +%s) + 5 ))
  while [ ! -s "$_preempt_pid_file" ]; do
    if ! kill -0 "$_preempt_wait_pid" 2>/dev/null; then
      wait "$_preempt_wait_pid"
      local _early_rc=$?
      _preempt_emit_result undetermined child-start-failed "$_early_rc"
      trap - EXIT TERM INT HUP
      rm -f "$_preempt_pid_file" 2>/dev/null || true
      return "$_early_rc"
    fi
    if [ "$(date +%s)" -ge "$_preempt_start_deadline" ]; then
      echo "[pc-heavy] REFUSED preemptible heavy run: child process-group identity was not published" >&2
      _preempt_reap_group
      _preempt_emit_result undetermined child-start-timeout 75
      trap - EXIT TERM INT HUP
      return 75
    fi
    sleep 0.05
  done
  _preempt_child_pid=$(head -1 "$_preempt_pid_file" 2>/dev/null || true)
  case "$_preempt_child_pid" in
    ''|*[!0-9]*)
      echo "[pc-heavy] REFUSED preemptible heavy run: invalid child process-group identity" >&2
      _preempt_reap_group
      _preempt_emit_result undetermined invalid-child-process-group 75
      trap - EXIT TERM INT HUP
      return 75
      ;;
  esac

  # The waitable leader defines COMMAND completion. A command may deliberately
  # daemonize a stdio-detached descendant; waiting for the whole process group
  # would turn that legitimate pattern into a 20s+ wrapper hang. The group is
  # still the termination boundary on preemption/signal, while normal leader
  # exit preserves the established daemon-detach behavior.
  while _preempt_leader_alive; do
    if ! kill -0 "$_outer_pid" 2>/dev/null; then
      _preempt_notify "[pc-heavy] outer slot wrapper exited — reaping its interruptible child group"
      _preempt_reap_group
      _preempt_emit_result undetermined outer-wrapper-exited 143
      trap - EXIT TERM INT HUP
      return 143
    fi
    if ! _preempt_caller_alive; then
      _preempt_notify "[pc-heavy] original caller exited — reaping its orphaned heavy workload"
      _preempt_reap_group
      _preempt_emit_result undetermined caller-exited 143
      trap - EXIT TERM INT HUP
      return 143
    fi
    if _preempt_writer_is_held; then
      # Once the child has completed its irreversible derivation and published
      # the marker, give its protected execution phase a bounded lease before
      # the exclusive materializer wins. The marker is deliberately checked by
      # the monitor (rather than inferred from argv or elapsed time) so a slow
      # derivation remains preemptible and the protected phase is exact. The
      # lease is also deliberately shorter than the ordinary materializer's
      # 900-second drain budget: an after-ready test may finish atomically, but
      # it may not starve every release gate on the host indefinitely.
      if _preempt_ready_is_published; then
        _preempt_seen_at=''
        _preempt_free_since=''
        _preempt_now=$(date +%s)
        if [ -z "$_preempt_ready_seen_at" ]; then
          _preempt_ready_seen_at="$_preempt_now"
          if [ "$_preempt_ready_max" -gt 0 ]; then
            _preempt_notify "[pc-heavy] after-ready protection active — exclusive materializer may wait up to ${_preempt_ready_max}s"
          fi
        fi
        if [ "$_preempt_ready_max" -gt 0 ] && [ $(( _preempt_now - _preempt_ready_seen_at )) -ge "$_preempt_ready_max" ]; then
          _preempt_notify "[pc-heavy] after-ready protection expired after ${_preempt_ready_max}s — PREEMPTING ordinary holder for exclusive materialization (pid=$_preempt_child_pid)"
          _preempt_reap_group
          trap - EXIT TERM INT HUP
          _preempt_emit_result preempted exclusive-materializer
          return 75
        fi
        sleep "$_preempt_poll"
        continue
      fi
      _preempt_ready_seen_at=''
      _preempt_now=$(date +%s)
      _preempt_free_since=''
      if [ -z "$_preempt_seen_at" ]; then
        _preempt_seen_at="$_preempt_now"
        echo "[pc-heavy] exclusive materializer is waiting — ordinary holder has ${_preempt_grace}s to finish" >&2
      fi
      if [ $(( _preempt_now - _preempt_seen_at )) -ge "$_preempt_grace" ]; then
        echo "[pc-heavy] PREEMPTING ordinary holder for exclusive materialization after ${_preempt_grace}s grace (pid=$_preempt_child_pid)" >&2
        _preempt_reap_group
        trap - EXIT TERM INT HUP
        _preempt_emit_result preempted exclusive-materializer
        return 75
      fi
    elif [ -n "$_preempt_seen_at" ] || [ -n "$_preempt_ready_seen_at" ]; then
      # A grace clock is already running. Abandon it only after the intent signal
      # has stayed absent for _preempt_clear_after seconds — a single free poll is
      # noise, not evidence the materializer left.
      _preempt_now=$(date +%s)
      if [ -z "$_preempt_free_since" ]; then
        _preempt_free_since="$_preempt_now"
      elif [ $(( _preempt_now - _preempt_free_since )) -ge "$_preempt_clear_after" ]; then
        _preempt_seen_at=''
        _preempt_ready_seen_at=''
        _preempt_free_since=''
      fi
    fi
    sleep "$_preempt_poll"
  done

  wait "$_preempt_wait_pid"
  local _rc=$?
  rm -f "$_preempt_pid_file" 2>/dev/null || true
  _preempt_cleanup_ready_marker
  trap - EXIT TERM INT HUP
  return "$_rc"
}

if [ "${1:-}" = "--pc-heavy-internal-preempt-run" ]; then
  shift
  _pc_heavy_internal_preempt_run "$@"
  exit $?
fi

# `--exclusive-all-slots` is the reciprocal release-materialization admission
# path (WI-40774): drain every currently-held ordinary heavy slot, hold the whole
# slot domain for one command, then let queued work resume. It is intentionally a
# mode on THIS proven flock surface rather than a second semaphore that could drift
# from the jobs it is meant to drain.
_exclusive_all_slots=0
if [ "${1:-}" = "--exclusive-all-slots" ]; then
  _exclusive_all_slots=1
  shift
fi

# Strip an optional leading `--` separating flags from the command.
if [ "${1:-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then
  echo "pc-heavy: no command given" >&2
  echo "usage: pc-heavy.sh [--exclusive-all-slots] [--] <command> [args...]" >&2
  exit 2
fi

# Already inside a slot (nested pc-heavy, or the caller pre-bypassed): just run.
if [ "$_exclusive_all_slots" = 0 ] && [ "${PC_HEAVY_BYPASS:-}" = "1" ]; then
  exec "$@"
fi

# WI-6140 — the RELEASE GATE is never made to QUEUE. green-checkpoint's greenCmd is
# `npm run test:affected`, which now routes through this wrapper; without this exemption
# the hourly release gate would wait up to PC_HEAVY_TIMEOUT_SEC (900s) behind ad-hoc agent
# sweeps. It is already racing a 60-min wall-clock reaper measured from workflow CREATION,
# so 15 idle minutes come straight off that budget and resurface as a "stale routine" reap
# that reads as an infra flake (the 2026-06-29 incident shape) rather than as queueing.
# The gate still runs DEFERENTIALLY — green-checkpoint spawns it `heavy: true` (nice 10 +
# ionice 7, EI-78) — so this exempts it from ADMISSION, never from PRIORITY. The cap still
# does its job: it bounds the AGENT sweeps that are the actual load source (measured load
# 165 on a 128-core box, 2026-07-26), which is what was starving this gate.
# PC_HEAVY_RELEASE_GATE=1 is set by buildGreenCheckpointEnv (green-checkpoint.ts) and
# inherited by the whole child tree, so this covers the main suite AND its isolation re-runs.
# ⚠ It is a DEDICATED key, deliberately NOT the GREEN_CHECKPOINT marker: that one is
# double-duty (it also drives describe.skipIf in load-/network-sensitive tests), so agents
# legitimately export it by hand to reproduce the gate's skip-set — and keying admission off
# it meant `GREEN_CHECKPOINT=1 npm run test:affected` bypassed this semaphore at nice 0,
# re-opening the very hole this wrapper closes. Do not "simplify" these back into one var.
if [ "$_exclusive_all_slots" = 0 ] && [ "${PC_HEAVY_RELEASE_GATE:-}" = "1" ]; then
  export PC_HEAVY_BYPASS=1
  exec "$@"
fi

# ── Finite-cgroup typecheck admission (EI-21206772578500745) ────────────────
# Host-wide slot admission is necessary but not sufficient. A headless fleet
# member is itself confined: the measured incident scope had MemoryMax=6144 MiB
# while the repository's compiler policy gives tsc an 8192 MiB V8 heap. The
# member plus npm/node wrappers already occupied part of those 6144 MiB, so one
# correctly slot-admitted operator-core typecheck reached 5.86 GiB anon RSS,
# hit memory.max 463 times, and was OOM-killed. Host memory PSI full avg60 rose
# from 1.30 to 11.02 while it allocated. The semaphore answered "may another
# heavy job start on this HOST?" but never the prior question "can this CALLER
# cgroup hold even one?".
#
# Refuse only compiler-shaped commands, only when cgroup-v2 exposes a FINITE
# envelope, and fail open on every unreadable/legacy/unlimited shape. The
# established detached verifier is the escape route: it gives the compile its
# own tracked execution envelope rather than making the agent session and the
# compiler fight inside one 6 GiB bucket. Release-gate calls remain exempt above
# because that path owns its own scope and must never be blocked by agent
# admission policy.
_is_full_typecheck_command() {
  local _arg _base
  for _arg in "$@"; do
    _base="${_arg##*/}"
    case "$_base" in
      lint-tsc*.mjs|tsc|tsc.cmd) return 0 ;;
    esac
  done
  return 1
}

_caller_cgroup_headroom_mib() {
  local _max_mib="${PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE:-}"
  local _current_mib="${PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE:-}"
  local _rel _dir _raw

  if [ -z "$_max_mib" ] || [ -z "$_current_mib" ]; then
    _rel="$(awk -F: '$1 == "0" { print $3; exit }' /proc/self/cgroup 2>/dev/null)"
    [ -n "$_rel" ] || return 0
    _dir="/sys/fs/cgroup${_rel}"
    if [ -z "$_max_mib" ]; then
      _raw="$(head -1 "$_dir/memory.max" 2>/dev/null)"
      [ "$_raw" = "max" ] && return 0
      case "$_raw" in ''|*[!0-9]*) return 0 ;; esac
      _max_mib=$(( _raw / 1048576 ))
    fi
    if [ -z "$_current_mib" ]; then
      _raw="$(head -1 "$_dir/memory.current" 2>/dev/null)"
      case "$_raw" in ''|*[!0-9]*) return 0 ;; esac
      _current_mib=$(( _raw / 1048576 ))
    fi
  fi

  [ "$_max_mib" = "max" ] && return 0
  case "$_max_mib" in ''|*[!0-9]*) return 0 ;; esac
  case "$_current_mib" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$_current_mib" -ge "$_max_mib" ]; then
    echo 0
  else
    echo $(( _max_mib - _current_mib ))
  fi
}

_guard_typecheck_cgroup_headroom() {
  _is_full_typecheck_command "$@" || return 0

  local _headroom _heap _overhead _needed _runner _reexec_rc
  _headroom="$(_caller_cgroup_headroom_mib)"
  [ -n "$_headroom" ] || return 0  # unlimited / unreadable / cgroup-v1 → fail open

  _heap="${PAPERCUSP_TSC_HEAP_MB:-8192}"
  _overhead="${PC_HEAVY_TYPECHECK_OVERHEAD_MIB:-1024}"
  case "$_heap" in ''|*[!0-9]*) _heap=8192 ;; esac
  case "$_overhead" in ''|*[!0-9]*) _overhead=1024 ;; esac
  _needed=$(( _heap + _overhead ))
  [ "$_headroom" -ge "$_needed" ] && return 0

  # A direct lint:tsc invocation is common in agent sessions, but those sessions
  # are deliberately placed in a small cgroup. The old behavior stopped here and
  # made every caller hand-route to capability:inspect/build:typecheck. That was
  # safe for memory but operationally incomplete: the canonical verifier itself
  # could not run from the documented command. Re-enter in a sibling user scope so
  # the compiler gets the same detached envelope as the MCP verifier. The marker
  # prevents a broken/custom runner from recursively spawning scopes forever.
  if [ "${PC_HEAVY_CGROUP_REEXEC:-}" != "1" ]; then
    _runner="${PC_HEAVY_SYSTEMD_RUN_BIN:-}"
    if [ -z "$_runner" ]; then
      _runner="$(command -v systemd-run 2>/dev/null || true)"
    fi
    if [ -n "$_runner" ]; then
      echo "[pc-heavy] caller cgroup has ${_headroom} MiB headroom, below the ${_needed} MiB compiler floor; re-running typecheck in a detached user scope." >&2
      # Test overrides describe the OUTER cgroup and must not leak into the
      # detached child. In production these variables are absent and this branch
      # simply inherits the real child scope's memory.max/current values.
      local -a _scope_cmd=("$_runner" --user --scope --collect)
      if [ -n "${PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE:-}" ] || [ -n "${PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE:-}" ]; then
        _scope_cmd+=(env -u PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE -u PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE)
      fi
      _scope_cmd+=("$@")
      PC_HEAVY_CGROUP_REEXEC=1 "${_scope_cmd[@]}"
      _reexec_rc=$?
      # This guard runs at the script's top level. Once the detached child has
      # executed the requested command, the outer wrapper must terminate rather
      # than fall through and execute the same command a second time.
      exit "$_reexec_rc"
    fi
  fi

  echo "[pc-heavy] REFUSED typecheck: caller cgroup has ${_headroom} MiB headroom, below the ${_needed} MiB compiler floor (${_heap} MiB configured V8 heap + ${_overhead} MiB agent/wrapper overhead)." >&2
  echo "[pc-heavy] This is the EI-212067 memcg-OOM class, not a TypeScript verdict. Run the check outside the agent-session cgroup with tools:invoke { name: \"capability:inspect\", args: { check: \"typecheck\", package: \"packages/<workspace>\", onlyPaths: [\"<changed file>\"], run_in_background: true } }; package is a repository-relative directory path (not an npm package name), or use build:typecheck for a bounded foreground check." >&2
  return 75
}

_guard_typecheck_cgroup_headroom "$@"
_typecheck_guard_rc=$?
[ "$_typecheck_guard_rc" -eq 0 ] || exit "$_typecheck_guard_rc"

_dir="${PC_HEAVY_DIR:-${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots}"
_exclusive_writer_path="$_dir/exclusive-materialization.lock"
# EI-21355065353185484 — the INTENT lock is the signal an ordinary holder polls;
# the writer lock above stays the MUTEX that serializes materializers. They must
# be different files. When they were one file the observer perturbed the thing it
# measured: the preempt probe tested the writer lock by ACQUIRING it (exclusive
# flock) every 0.1s, so it repeatedly stole the lock from a materializer polling
# at 0.2s. The "materializer is waiting" signal then flapped, the 30s grace clock
# was zeroed on every transient free poll, and preemption was starved — measured
# 465 waiting-emissions against exactly 1 preemption across a 34-minute run.
# Intent is declared BEFORE the writer wait, so a materializer QUEUED behind
# another materializer is visible too — under the old scheme it held nothing and
# was therefore indistinguishable from "no materializer waiting".
# Like every other lock here it is a kernel flock held for the process lifetime
# and inherited through `exec`, so it needs no cleanup daemon and cannot leak the
# way a plain marker file would (see the stale preemptible.<pid>.pid files).
_exclusive_intent_path="$_dir/exclusive-materialization.intent"

_cores="$(nproc 2>/dev/null || echo 8)"
_floor=$(( _cores / 32 ))
[ "$_floor" -lt 2 ] && _floor=2
_ceil=$(( _cores / 8 ))
[ "$_ceil" -lt "$_floor" ] && _ceil="$_floor"

# Load-adaptive slot count (EI-19313096203661357): floor + one slot per 16 cores
# of load1 headroom, capped at cores/8. Saturated (load1 >= cores) = exactly the
# old fixed behavior; an idle 128-core box admits 12 instead of 4. load1 is the
# right signal because the observed starvation was UNGATED load (qemu/kopia)
# pinning the box while small gated jobs queued 57 deep — headroom, not slot
# occupancy, is what says whether another niced job fits.
_calc_slots() {
  local load1
  if [ -n "${PC_HEAVY_LOAD1_OVERRIDE:-}" ]; then
    load1="${PC_HEAVY_LOAD1_OVERRIDE%%.*}"
  else
    load1="$(awk '{ print int($1) }' /proc/loadavg 2>/dev/null)"
  fi
  case "$load1" in ''|*[!0-9]*) echo "$_floor"; return ;; esac
  local headroom=$(( _cores - load1 ))
  [ "$headroom" -lt 0 ] && headroom=0
  local n=$(( _floor + headroom / 16 ))
  [ "$n" -gt "$_ceil" ] && n="$_ceil"
  echo "$n"
}

# ── Release-gate reserve (EI-19315056231449472) ─────────────────────────────
# The slot count above is a STEADY-STATE target: the floor deliberately models
# every admitted job as a 32-worker sweep so full occupancy is ~1x the box, and
# the load-adaptive widening opens that up to cores/8 when the box looks idle.
# Both are correct — except while the release gate is JUDGING, when they are
# actively harmful, and for a reason that makes the two compound:
#
#   The gate's quiet cut is EXACTLY when the box looks idle, so at the moment a
#   run starts `_calc_slots` is at its most generous and the fleet can pile on
#   up to `ceil` concurrent sweeps — by design. Measured live 2026-08-02 07:47Z
#   while a run was judging: >= 6 heavy runs admitted, 16 vitest processes,
#   load1 125.6 on 128 cores.
#
# What that costs is NOT merely a slow gate. The gate re-runs each originally-
# failing file in ISOLATION at single concurrency to decide load-flake vs real
# break (load-flake-isolation-2026-06-23), and ABSORBS the ones that pass. Host
# contention during that phase therefore corrupts the gate's CLASSIFIER in both
# directions — a starved re-run fails a good file (false red on code that is
# fine, EI-18793581783459047; the same run's re-runs were starved to 209.7s and
# the gate itself blamed "ambient host load"), and the same pressure shapes
# which files get absorbed as flakes. The gate's flake/real discrimination
# becomes a function of who else is on the box.
#
# So: while a run is live, clamp the EFFECTIVE slot count to a quarter of the
# steady-state target (min 1). A /2 clamp is not enough — with adaptive slots
# reaching 16 here it still admits 8. The advisory for this already exists
# (dev:pipeline_position warns a human/agent who happens to call it); this is
# the ENFORCEMENT, at the one chokepoint every heavy run already passes through.
#
# Detection is pure shell — no daemon, no DB, no tool call (this runs before
# EVERY heavy command). green-checkpoint publishes a per-root run-lock DIRECTORY
# `<logDir>/.green-checkpoint-run-<hash>.lock/` containing `owner.json` with the
# run's pid and acquisition timestamp. `kill -0` alone is not enough: after PID
# reuse it can prove only that an unrelated process exists. When the timestamp
# is parseable, also reject a lock beyond the writer's stale horizon or a live
# PID whose procfs start time is newer than the lock. Unknown identity metadata
# keeps the old liveness path (fail-open) rather than turning a diagnostic gap
# into a false idle reading.
#
# Per-hive gates publish beneath
# `<defaultLogDir>/<hive>/`; ordinary agent commands do not carry that hive's
# `PAPERCUSP_CHECKPOINT_LOG_DIR`, so the default-root reader MUST inspect both
# the root and its immediate per-hive children. Otherwise the materializing
# phase cannot close new admission, the exclusive drain races an open front
# door for 15 minutes, and the hive gate records an infrastructure red. A
# crashed gate run's leftover lock is self-evidently dead and IGNORED, so this
# broader discovery can never wedge the fleet into permanent 1-slot mode.
#
# Fail-open on EVERY unexpected input: no dir, no lock, unparseable json,
# non-numeric pid, unparseable timestamp, unavailable procfs, dead pid, no
# `kill` → behave exactly as if no gate were running. A positive stale/identity
# mismatch is the only new reason to ignore an otherwise-live PID. Worst case
# degrades to today's behavior.
# Escape hatch: PC_HEAVY_GATE_RESERVE=0.
_CHECKPOINT_RUN_LOCK_STALE_SEC=$((190 * 60))
_CHECKPOINT_PROCESS_START_TOLERANCE_SEC=5

# Linux procfs start time in epoch seconds, or fail when the identity hint is
# unavailable. `/proc/<pid>/stat` field 22 is field 20 after the final `)`; the
# final delimiter keeps this correct for a process name containing `)`.
_checkpoint_process_start_sec() {
  local _pid="$1" _ticks _uptime
  _ticks=$(sed 's/.*) //' "/proc/$_pid/stat" 2>/dev/null | awk '{print $20}') || return 1
  case "$_ticks" in ''|*[!0-9]*) return 1 ;; esac
  _uptime=$(awk '{print $1}' /proc/uptime 2>/dev/null) || return 1
  case "$_uptime" in ''|*[!0-9.]*) return 1 ;; esac
  _uptime="${_uptime%%.*}"
  case "$_uptime" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$(( $(date +%s) - _uptime + _ticks / 100 ))"
}

_gate_reserve_active() {
  case "${PC_HEAVY_GATE_RESERVE:-1}" in
    0|off|OFF|false|FALSE|no|NO) return 1 ;;
  esac
  local _logdir="${PAPERCUSP_CHECKPOINT_LOG_DIR:-${HOME:-}/.papercusp/checkpoint-logs}"
  [ -d "$_logdir" ] || return 1
  local _owner _raw _pid _started_at _started_sec _process_started_sec _now_sec
  # No nullglob: a non-matching glob yields the literal pattern, which the
  # -f test below rejects — that IS the no-gate-running path.
  for _owner in \
    "$_logdir"/.green-checkpoint-run-*.lock/owner.json \
    "$_logdir"/*/.green-checkpoint-run-*.lock/owner.json; do
    [ -f "$_owner" ] || continue
    _raw=$(head -c 4096 "$_owner" 2>/dev/null | tr -d ' \n') || continue
    _pid=$(printf '%s' "$_raw" | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' | head -1)
    case "$_pid" in ''|*[!0-9]*) continue ;; esac
    _started_at=$(printf '%s' "$_raw" | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p' | head -1)
    _started_sec=""
    _process_started_sec=""
    if [ -n "$_started_at" ]; then
      # GNU date is present on the supported Linux hosts. If parsing is
      # unavailable, preserve the pre-guard kill -0 behavior (fail-open).
      _started_sec=$(date -d "$_started_at" +%s 2>/dev/null || true)
      case "$_started_sec" in
        ''|*[!0-9]*) _started_sec="" ;;
      esac
    fi
    # A dead pid means the run crashed and left its lock behind — ignore it.
    if kill -0 "$_pid" 2>/dev/null; then
      if [ -n "$_started_sec" ]; then
        _now_sec=$(date +%s)
        # Keep this in sync with green-checkpoint.ts's CHECKPOINT_LOCK_STALE_MS.
        # The writer reclaims at this age even when the PID still looks alive.
        if [ "$((_now_sec - _started_sec))" -gt "$_CHECKPOINT_RUN_LOCK_STALE_SEC" ]; then
          continue
        fi

        # A recycled PID can pass kill -0 while belonging to a process that
        # started after this lock. Procfs is best-effort; unavailable identity
        # data leaves the existing liveness result intact.
        _process_started_sec=$(_checkpoint_process_start_sec "$_pid" 2>/dev/null || true)
        case "$_process_started_sec" in
          ''|*[!0-9]*) ;;
          *)
            if [ "$_process_started_sec" -gt "$((_started_sec + _CHECKPOINT_PROCESS_START_TOLERANCE_SEC))" ]; then
              continue
            fi
            ;;
        esac
      fi
      # Remember WHICH lock dir won, so the phase read below looks at the same run.
      _gate_lockdir="${_owner%/owner.json}"
      return 0
    fi
  done
  return 1
}

# EI-19328677512071640 — phase-aware clamp DEPTH. v1 clamped for a run's whole
# lifetime; a gate run can be ~2.7h while the window that actually needs the
# headroom is minutes, so the fleet paid hours of throttle for a short reserve.
#
# green-checkpoint publishes `phase.json` beside `owner.json` in the SAME lock dir
# already globbed above, so this costs one more file read and no new coordination.
#
#   materializing -> 1 slot. The checkpoint is copying/refreshing its dependency
#                       snapshot and its exclusive slot drain needs a closed front
#                       door while pre-existing heavy jobs finish.
#   isolating  -> /4  the single-concurrency load-flake re-run. Contention here
#                     corrupts the CLASSIFIER, not just timing. The whole point.
#   delivering -> /4  NOT a safe phase despite the name: it re-runs every failing
#                     file at tip (green-checkpoint.ts `deps.runTestsAtRef`) and
#                     feeds classifyRedAgainstTip, so contention flips a VERDICT
#                     here exactly as it does in isolation.
#   suite      -> /2  the long main sweep — the hours. Relaxed, but NOT to zero:
#                     fleet load during the sweep is itself what MANUFACTURES the
#                     load-flakes the isolation phase then has to adjudicate.
#
# ⚠ The `suite` relaxation is gated on `phaseProtocol >= 2` and that gate is
# load-bearing, not defensive boilerplate. Protocol 1 (the field absent) folded
# the isolation re-run INSIDE `suite`, so relaxing `suite` against an OLD writer
# silently deletes the exact protection this clamp exists to provide. The gate
# runs from the RELEASE checkout, which LAGS staging — so a new reader genuinely
# does meet an old writer, and does so for as long as the release is behind.
#
# Every unknown — no phase.json, unparseable, unreadable, missing/older protocol,
# unrecognized phase name — degrades to /4, i.e. exactly v1's behavior. The
# failure direction is always "throttle more", never "protect less".
_gate_clamp_divisor() {
  [ -n "${_gate_lockdir:-}" ] || { echo 4; return; }
  local _pf="$_gate_lockdir/phase.json"
  [ -f "$_pf" ] || { echo 4; return; }
  local _raw _phase _proto
  _raw=$(head -c 4096 "$_pf" 2>/dev/null | tr -d ' \n') || { echo 4; return; }
  _proto=$(printf '%s' "$_raw" | sed -n 's/.*"phaseProtocol":\([0-9][0-9]*\).*/\1/p' | head -1)
  case "$_proto" in ''|*[!0-9]*) echo 4; return ;; esac
  [ "$_proto" -ge 2 ] || { echo 4; return; }
  _phase=$(printf '%s' "$_raw" | sed -n 's/.*"phase":"\([a-zA-Z]*\)".*/\1/p' | head -1)
  case "$_phase" in
    materializing)
      # Only protocol 3+ defines this phase. An older/unknown writer keeps the
      # conservative v1 /4 behavior rather than granting semantics it never published.
      [ "$_proto" -ge 3 ] && echo 999999 || echo 4
      ;;
    suite) echo 2 ;;
    *)     echo 4 ;;
  esac
}

# EI-19385714326170346 — REFUSE the broad sweep during the two phases where
# contention corrupts the gate's VERDICT rather than merely slowing it.
#
# The clamp above is the right tool for load; it is the wrong tool for this. Even
# at slots/4 a `test:affected` sweep still runs CONCURRENTLY with the isolation
# re-run, and that re-run is a single-concurrency CLASSIFIER: it decides whether a
# red is a real break or a load-flake. Contention there does not cost time, it
# flips verdicts — reddening the gate for the whole fleet on code that is fine,
# with the diagnosis cost landing on someone who never ran the suite.
#
# Why a guard here rather than a doc: `dev:pipeline_position` ALREADY warns about
# exactly this, and the warning did not reach the moment of action — the filer of
# this item read that note and ran the sweep minutes later in the same session,
# and so did I (12 suite iterations at 00:13Z against a manual run started
# 00:11:03Z). Same reasoning the repo applied to `bin/tauri-guarded`: put the
# claim at the chokepoint every caller already passes through, not in a
# convention each caller must remember.
#
# SCOPE — deliberately narrow, three independent conditions, all required:
#   1. phaseProtocol >= 2 AND phase is `isolating` or `delivering`. Those are the
#      classifier phases (see _gate_clamp_divisor). Their duration is BOUNDED BY
#      THE SIZE OF THE RED, not short: `delivering` RE-RUNS EVERY FAILING FILE to
#      separate a real break from a load flake, so it scales with the break set.
#      MEASURED 2026-08-12 (EI-20282438643454775): a genuine 4-file red held
#      `delivering` >=19 min (phase stamped 22:27:07Z, still delivering at
#      22:45Z) and had not cleared until between 22:45Z and 23:04Z — about half
#      an hour. An earlier version of this comment asserted these phases "last
#      MINUTES"; that is measured FALSE, and it mis-sizes waits. NEVER size a
#      wait from this comment — read the live phase.json under
#      ~/.papercusp/checkpoint-logs/.green-checkpoint-run-*.lock/.
#      The narrow scope still holds, because even a half-hour classifier phase is
#      far shorter than the run's ~2.7h. Protocol 1 folded isolation inside
#      `suite`, so refusing on `suite` would block the fleet for hours — the
#      clamp already covers that case by throttling everything to /4.
#   2. The wrapped command is the BROAD SWEEP (`affected-tests.mjs`). A scoped
#      `test:file` re-verify is NEVER refused — it is what this message tells you
#      to run instead, so refusing it would make the advice unusable.
#   3. Not the release gate itself. Structurally guaranteed: the
#      PC_HEAVY_RELEASE_GATE exemption `exec`s far above this, so the gate's own
#      suite and isolation re-runs can never reach here and cannot self-deadlock.
#
# FAILS OPEN, and the direction is deliberately OPPOSITE to the clamp's. The clamp
# answers every unknown with "throttle more"; a REFUSAL must answer every unknown
# with "allow", because a spurious refusal blocks routine work fleet-wide. Missing
# or unparseable phase.json, absent/old protocol, unrecognized phase name → run.
_gate_refuse_broad_sweep() {
  case "${PC_HEAVY_ALLOW_DURING_GATE:-}" in 1|on|ON|true|TRUE|yes|YES) return 0 ;; esac
  case "${_gate_proto:-}" in ''|*[!0-9]*) return 0 ;; esac
  [ "$_gate_proto" -ge 2 ] || return 0
  case "${_gate_phase:-}" in isolating|delivering) ;; *) return 0 ;; esac
  local _a _broad=0
  for _a in "$@"; do
    case "$_a" in *affected-tests.mjs*) _broad=1 ;; esac
  done
  [ "$_broad" = 1 ] || return 0
  echo "[pc-heavy] REFUSING test:affected — the release gate is in its '$_gate_phase' phase." >&2
  echo "[pc-heavy] That phase is the gate's single-concurrency CLASSIFIER: it re-runs failing" >&2
  echo "[pc-heavy] files to decide real-break vs load-flake. A broad sweep running alongside it" >&2
  echo "[pc-heavy] can flip that verdict and red the gate for the WHOLE fleet on code that is" >&2
  echo "[pc-heavy] fine — and you would not be the one paying the diagnosis. It lasts minutes." >&2
  echo "[pc-heavy]" >&2
  echo "[pc-heavy] DO THIS INSTEAD — scope the re-verify to what you actually changed:" >&2
  echo "[pc-heavy]     npm run test:file -- <the files you edited>" >&2
  echo "[pc-heavy] (never refused by this guard, and it is the faster check anyway)" >&2
  echo "[pc-heavy]" >&2
  echo "[pc-heavy] Genuinely need the full sweep now? PC_HEAVY_ALLOW_DURING_GATE=1 npm run test:affected" >&2
  exit 75
}

# EI-19970072096315178 — RE-CHECK the refusal after the slot wait, not only at
# admission. The check above runs BEFORE this script queues for a slot, and the
# queue is not short: PC_HEAVY_TIMEOUT_SEC defaults to 900s, and a clamped gate
# window (slots/2 during `suite`, /4 during the classifier phases) is exactly
# when waits are longest. So the phase reading the refusal acts on can be many
# minutes stale by the time the command actually starts.
#
# That staleness is not symmetric — it leaks in precisely the direction the
# guard exists to prevent. A sweep arriving during `suite` is NOT refused (only
# clamped), then waits; `suite` is the run's multi-hour bulk, and `isolating`/
# `delivering` follow it. So the natural trajectory of a queued sweep is to be
# admitted under the permissive phase and begin running under the classifier
# phase — the one where contention flips a VERDICT rather than costing time.
# Measured on this box 2026-08-09: waits of 60-90s were routine while a gate ran,
# and a peer observed a sweep live during `isolating` despite the guard.
#
# Re-running `_gate_reserve_active` (rather than reusing the admission-time
# result) also covers the case the admission check structurally CANNOT see: a
# gate run that STARTED while we sat in the queue. Both directions are handled —
# a gate that FINISHED during the wait leaves _gate_reserve_active false and the
# command runs, unrefused.
#
# Same fail-open direction as the admission check: every unknown → run. The
# refusal can only fire on a positive reading of a live run in a classifier
# phase with protocol >= 2.
_gate_recheck_refusal() {
  case "${PC_HEAVY_ALLOW_DURING_GATE:-}" in 1|on|ON|true|TRUE|yes|YES) return 0 ;; esac
  _gate_lockdir=""
  _gate_phase=""
  _gate_proto=""
  # Re-detect: sets _gate_lockdir to the live run's lock dir, or returns
  # non-zero when no live run holds one (or the reserve is switched off).
  _gate_reserve_active || return 0
  _gate_raw=$(head -c 4096 "${_gate_lockdir:-}/phase.json" 2>/dev/null | tr -d ' \n')
  _gate_phase=$(printf '%s' "$_gate_raw" | sed -n 's/.*"phase":"\([a-zA-Z]*\)".*/\1/p' | head -1)
  _gate_proto=$(printf '%s' "$_gate_raw" | sed -n 's/.*"phaseProtocol":\([0-9][0-9]*\).*/\1/p' | head -1)
  [ -n "$_gate_phase" ] || _gate_phase="unknown"
  _gate_refuse_broad_sweep "$@"
}

# ── Memory clamp (EI-20336929607862174) ────────────────────────────────────
# `_calc_slots` above admits on load1 alone. That is not merely BLIND to
# memory, it is ANTI-CORRELATED with it: memory pressure stalls processes in
# reclaim, which LOWERS load1, which WIDENS admission. The worse memory gets,
# the more heavy runs pc-heavy lets in — a positive feedback loop, which is why
# the recurring symptom is a memory-full PSI spike with the CPU looking idle.
#
# Measured 2026-08-13T19:30Z on this 128-core/251 GiB box: memory PSI full
# avg60 = 4.56 while cpu PSI some = 0.79 and load1 = 79 → 7 slots admitted,
# ceil 16. Cost per slot is not small — `lint:tsc` is one
# `tsc -p packages/operator-core` node process peaking 4.7–6.9 GiB RSS (two
# concurrent measured at 4741 + 6946 MiB, driving app.slice +5.1 GiB/20s), and
# every agent runs it after editing. 16 × ~6 GiB ≈ 96 GiB transient against
# 54 GiB MemAvailable, on a box already ~118 GiB resident (QEMU VMs, PG,
# dev-api). Slots stagger CONCURRENCY; nothing was staggering FOOTPRINT.
#
# Two signals, both fail-open:
#   1. BUDGET  — MemAvailable / PC_HEAVY_MEM_PER_SLOT_GIB is the most slots
#      that physically fit. This is the load-bearing one.
#   2. BACKOFF — memory PSI full avg10 >= PC_HEAVY_MEM_PSI_BACKOFF halves that
#      budget: a box already IN reclaim must not admit at its ceiling.
# Never clamps below 1 — pc-heavy must always make forward progress, and one
# heavy run is what a busy box does, not a deadlock. This is a safety reserve
# like the gate clamp, so (unlike load adaptation) it applies to an explicit
# PC_HEAVY_SLOTS too. Escape hatch: PC_HEAVY_MEM_CLAMP=0.
_mem_clamp_slots() {
  local _n="$1"
  case "${PC_HEAVY_MEM_CLAMP:-1}" in
    0|off|OFF|false|FALSE|no|NO) echo "$_n"; return ;;
  esac

  local _avail_gib
  if [ -n "${PC_HEAVY_MEMAVAIL_GIB_OVERRIDE:-}" ]; then
    _avail_gib="${PC_HEAVY_MEMAVAIL_GIB_OVERRIDE%%.*}"
  else
    _avail_gib="$(awk '/^MemAvailable:/ { print int($2 / 1048576); exit }' /proc/meminfo 2>/dev/null)"
  fi
  # Unreadable/garbage MemAvailable ⇒ fail open, exactly as if no clamp existed.
  case "$_avail_gib" in ''|*[!0-9]*) echo "$_n"; return ;; esac

  local _per="${PC_HEAVY_MEM_PER_SLOT_GIB:-6}"
  case "$_per" in ''|*[!0-9]*) _per=6 ;; esac
  [ "$_per" -lt 1 ] && _per=1

  local _budget=$(( _avail_gib / _per ))

  # PSI backoff. Reading avg10 (not avg60) so the clamp reacts within one
  # admission decision rather than a minute after the damage.
  local _psi
  if [ -n "${PC_HEAVY_MEM_PSI_OVERRIDE:-}" ]; then
    _psi="${PC_HEAVY_MEM_PSI_OVERRIDE%%.*}"
  else
    _psi="$(awk '/^full/ { for (i = 2; i <= NF; i++) if (substr($i, 1, 6) == "avg10=") { print int(substr($i, 7)); exit } }' /proc/pressure/memory 2>/dev/null)"
  fi
  local _backoff="${PC_HEAVY_MEM_PSI_BACKOFF:-5}"
  case "$_backoff" in ''|*[!0-9]*) _backoff=5 ;; esac
  case "$_psi" in
    ''|*[!0-9]*) : ;;                                    # no PSI ⇒ budget only
    *) [ "$_psi" -ge "$_backoff" ] && _budget=$(( _budget / 2 )) ;;
  esac

  [ "$_budget" -lt 1 ] && _budget=1
  [ "$_n" -gt "$_budget" ] && _n="$_budget"
  echo "$_n"
}

# Effective slot count: the steady-state target (fixed or load-adaptive), then
# the gate clamp. The clamp applies to an explicit PC_HEAVY_SLOTS too — it is a
# safety reserve, not load adaptation, and it has its own dedicated override.
_effective_slots() {
  local _n
  if [ "$_slots_fixed" = 1 ]; then _n="$_slots_base"; else _n="$(_calc_slots)"; fi
  case "$_n" in ''|*[!0-9]*) _n="$_floor" ;; esac
  if _gate_reserve_active; then
    # Depth depends on WHICH phase the live run is in (EI-19328677512071640).
    # _gate_reserve_active set _gate_lockdir for us; every unknown answers 4.
    local _div
    _div="$(_gate_clamp_divisor)"
    case "$_div" in ''|*[!0-9]*) _div=4 ;; esac
    [ "$_div" -lt 1 ] && _div=4
    local _clamped=$(( _n / _div ))
    [ "$_clamped" -lt 1 ] && _clamped=1
    [ "$_clamped" -lt "$_n" ] && _n="$_clamped"
  fi
  # Memory clamp LAST: it is a physical ceiling, so it must be able to cut a
  # count the gate clamp already lowered — and must apply to a fixed
  # PC_HEAVY_SLOTS, which the load-adaptive path never sees.
  _n="$(_mem_clamp_slots "$_n")"
  case "$_n" in ''|*[!0-9]*) _n=1 ;; esac
  echo "$_n"
}

_slots_base="${PC_HEAVY_SLOTS:-}"
_slots_fixed=1
if [ -z "$_slots_base" ]; then
  _slots_fixed=0
fi
_gate_active=0
_gate_reserve_active && _gate_active=1
_slots="$(_effective_slots)"
_gate_phase=""
_gate_proto=""
_gate_raw=""
_gate_div=4
if [ "$_gate_active" = 1 ]; then
  _gate_div="$(_gate_clamp_divisor)"
  case "$_gate_div" in ''|*[!0-9]*) _gate_div=4 ;; esac
  # Read phase.json ONCE and take both fields from it. The protocol is needed by
  # the refusal below, which must never fire against a protocol-1 writer (there
  # `suite` still contains the isolation re-run, so "isolating" never appears and
  # refusing on `suite` would block the fleet for the run's whole ~2.7h).
  _gate_raw=$(head -c 4096 "${_gate_lockdir:-}/phase.json" 2>/dev/null | tr -d ' \n')
  _gate_phase=$(printf '%s' "$_gate_raw" | sed -n 's/.*"phase":"\([a-zA-Z]*\)".*/\1/p' | head -1)
  _gate_proto=$(printf '%s' "$_gate_raw" | sed -n 's/.*"phaseProtocol":\([0-9][0-9]*\).*/\1/p' | head -1)
  [ -n "$_gate_phase" ] || _gate_phase="unknown"
  echo "[pc-heavy] release gate is JUDGING (phase=$_gate_phase) — heavy slots clamped to" \
       "$_slots to keep headroom for its isolation re-run (EI-19315056231449472)." \
       "Override with PC_HEAVY_GATE_RESERVE=0." >&2
  # Refuses + exits for the broad sweep in the classifier phases only; returns
  # (and we continue, merely clamped) in every other case. See the function.
  _gate_refuse_broad_sweep "$@"
fi

# A materialization barrier uses this flock as its writer marker before it drains
# the ordinary slot domain. Probe the marker without creating it: a stale path is
# fail-open, while a held flock means the barrier already owns all ordinary slots.
# This closes the gap where no green-checkpoint run-lock is live, so the focused
# verification lane remains available during an active exclusive materialization.
_exclusive_materialization_active=0
if [ "$_exclusive_all_slots" = 0 ] && [ -e "$_exclusive_writer_path" ] && command -v flock >/dev/null 2>&1; then
  if { exec {_exclusive_probe_fd}>"$_exclusive_writer_path"; } 2>/dev/null; then
    if ! flock -n "$_exclusive_probe_fd"; then
      _exclusive_materialization_active=1
    fi
    eval "exec ${_exclusive_probe_fd}>&-" 2>/dev/null || true
  fi
fi

# EI-20223200344608082 / EI-21239272593686546 — scoped verification is the safe
# path during the gate's classifier phases or an exclusive materialization, but
# the reserve clamp applies to every ordinary heavy command. On a saturated host
# that leaves one shared slot; an unrelated holder can therefore starve the
# exact-file test or typecheck the guard just prescribed. Give test-files.mjs and
# explicit `lint:tsc* --files=…` runs one small, independent lane while either
# critical path is live. The lane is intentionally bounded (default one slot) and
# only exists for scoped runners; broad sweeps continue to use the protected
# ordinary pool.
_is_focused_test=0
_is_scoped_tsc=0
_has_explicit_scope=0
for _arg in "$@"; do
  case "$_arg" in
    scripts/test-files.mjs|*/scripts/test-files.mjs) _is_focused_test=1 ;;
    scripts/lint-tsc*.mjs|*/scripts/lint-tsc*.mjs) _is_scoped_tsc=1 ;;
    lint:tsc|lint:tsc:*) _is_scoped_tsc=1 ;;
    --files=*|--files-from=*) _has_explicit_scope=1 ;;
  esac
done
_is_focused_command=0
if [ "$_is_focused_test" = 1 ] || { [ "$_is_scoped_tsc" = 1 ] && [ "$_has_explicit_scope" = 1 ]; }; then
  _is_focused_command=1
fi
_focused_lane=0
_focused_slots=0
if [ "$_is_focused_command" = 1 ]; then
  if [ "$_gate_active" = 1 ] || [ "$_exclusive_materialization_active" = 1 ]; then
    _focused_lane=1
    _focused_slots="${PC_HEAVY_FOCUSED_SLOTS:-1}"
    case "$_focused_slots" in ''|*[!0-9]*) _focused_slots=1 ;; esac
    [ "$_focused_slots" -ge 1 ] || _focused_slots=1
    _slots="$_focused_slots"
    if [ "$_exclusive_materialization_active" = 1 ] && [ "$_gate_active" = 0 ]; then
      echo "[pc-heavy] exclusive materialization barrier is active — scoped verification uses the focused lane." >&2
    fi
  fi
fi
if [ "${PC_HEAVY_DEBUG:-}" = "1" ]; then
  echo "[pc-heavy] slots=$_slots fixed=$_slots_fixed cores=$_cores floor=$_floor ceil=$_ceil gate=$_gate_active phase=${_gate_phase:-none} div=$_gate_div focused=$_focused_lane" >&2
fi
_slot_dir="$_dir"
if [ "$_focused_lane" = 1 ]; then
  _slot_dir="$_dir/focused"
fi
_timeout="${PC_HEAVY_TIMEOUT_SEC:-900}"
if [ -z "${PC_HEAVY_TIMEOUT_SEC:-}" ]; then
  for _arg in "$@"; do
    case "$_arg" in
      scripts/test-files.mjs|lint:tsc|lint:tsc:*)
      _timeout="${PC_HEAVY_SCOPED_TIMEOUT_SEC:-30}"
      break
      ;;
    esac
  done
fi

# Can't create the slot dir or flock is missing → fail-open (run unthrottled).
if ! mkdir -p "$_dir" "$_slot_dir" 2>/dev/null || ! command -v flock >/dev/null 2>&1; then
  if [ "$_exclusive_all_slots" = 1 ]; then
    echo "[pc-heavy] FATAL: cannot establish the exclusive materialization barrier in $_dir" >&2
    exit 75
  fi
  export PC_HEAVY_BYPASS=1
  exec "$@"
fi

# ── Blocked-barrier holder identity (EI-21322804786723906) ─────────────────
# Both refusals below used to report only a COUNT ("only 15/16 heavy slots
# drained"). That is precisely why this incident was first filed as a STALE
# writer lock and had to be retracted: with no holder named, the only way to
# tell a live materializer from an orphaned one is a hand-run fuser/process-tree
# walk, and the cheap wrong answer ("it's stale, clear it") is the one that
# looks right. Several sessions repeated that same manual archaeology on this
# one incident before anyone reached a correct diagnosis. Naming the holder
# turns a 15-minute mystery into a pid.
#
# DIAGNOSTIC ONLY — fail-open by construction, like the coalescing block below.
# `fuser` is only a cheap candidate enumerator: it reports every process with the
# path open, including writers queued in `flock`, so its output alone is NOT
# ownership evidence. A candidate is named only when one of its matching fds has
# a kernel FLOCK WRITE record in fdinfo. A missing `fuser`, an unreadable /proc,
# or a holder that exits between the probes must never change the barrier's
# outcome: every failure path yields a shorter/empty description and the caller
# simply prints less. It must also never be the thing that makes a gate run fail.
_exclusive_describe_holders() {
  local _file="$1" _target='' _pids='' _pid='' _fd='' _fd_target=''
  local _fd_number='' _owns=0 _cmd='' _out=''
  command -v fuser >/dev/null 2>&1 || return 0
  [ -e "$_file" ] || return 0
  _target="$(stat -Lc '%d:%i' "$_file" 2>/dev/null || true)"
  [ -n "$_target" ] || return 0
  _pids="$(fuser "$_file" 2>/dev/null | tr -s ' \t' '\n\n' | grep -E '^[0-9]+$' || true)"
  [ -n "$_pids" ] || return 0
  for _pid in $_pids; do
    _owns=0
    # A writer waiter opens the same inode before it blocks in `flock`, but its
    # fdinfo has no owning lock record. Conversely, every live process sharing
    # the owning open-file description exposes the kernel FLOCK record here —
    # including the materialization child after pc-heavy execs it.
    for _fd in "/proc/$_pid/fd"/*; do
      [ -e "$_fd" ] || continue
      _fd_target="$(stat -Lc '%d:%i' "$_fd" 2>/dev/null || true)"
      [ "$_fd_target" = "$_target" ] || continue
      _fd_number="${_fd##*/}"
      if grep -Eq '^lock:[[:space:]]+[0-9]+: FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE' "/proc/$_pid/fdinfo/$_fd_number" 2>/dev/null; then
        _owns=1
        break
      fi
    done
    [ "$_owns" = 1 ] || continue
    # A proven holder can still exit between fdinfo and cmdline. Keep the
    # ownership evidence while making the cmdline race explicit and quiet.
    _cmd="$(cat "/proc/$_pid/cmdline" 2>/dev/null | tr '\0' ' ' | cut -c1-100 || true)"
    [ -n "$_cmd" ] || _cmd='(cmdline unavailable after kernel lock proof)'
    _out="$_out pid $_pid [$_cmd];"
  done
  printf '%s' "$_out"
}

# A caller-side deadline can terminate an arbitrary command while this wrapper
# is still in the semaphore queue. Letting Bash report the raw signal (usually
# 143) makes that indistinguishable from a compiler that started and was then
# terminated. The queue is a retryable admission outcome, not a validation
# result, so make it explicit and include the live holder/event evidence needed
# to retry intelligently. This handler is installed only around the ordinary
# slot wait; once the slot-acquired marker is emitted, the real command owns the
# normal signal/exit contract again.
_pc_heavy_queue_abort() {
  local _signal="$1"
  local _exit_code="${2:-75}"
  local _queue_slots="${_slots:-1}"
  local _queue_i='' _queue_desc='' _queue_event=''
  local _queue_limit=''

  # Avoid a second signal re-entering the diagnostic path, and release any
  # coalescing leader marker before the retryable exit. The slot fd (if a race
  # won one just before the signal) is released by this shell's exit.
  trap - TERM HUP INT
  _queue_event="gate-phase=${_gate_phase:-none};gate-active=${_gate_active:-0};exclusive=${_exclusive_materialization_active:-0}"
  echo "[pc-heavy] QUEUE_ABORTED status=retryable reason=caller-signal signal=$_signal exit=$_exit_code — no heavy slot acquired; $_queue_event" >&2
  echo "[pc-heavy] queue retry context: $_queue_event" >&2

  case "$_queue_slots" in ''|*[!0-9]*) _queue_slots=1 ;; esac
  _queue_limit="$_queue_slots"
  [ "$_queue_limit" -ge 1 ] || _queue_limit=1
  [ "$_queue_limit" -le 8 ] || _queue_limit=8
  for _queue_i in $(seq 0 $(( _queue_limit - 1 ))); do
    _queue_desc="$(_exclusive_describe_holders "${_slot_dir:-}/slot.$_queue_i")"
    if [ -n "$_queue_desc" ]; then
      echo "[pc-heavy] queued slot.$_queue_i held by:$_queue_desc" >&2
    else
      echo "[pc-heavy] queued slot.$_queue_i holder unavailable" >&2
    fi
  done
  echo "[pc-heavy] PC_HEAVY_RESULT status=retryable reason=queue-signal signal=$_signal exit=$_exit_code" >&2
  if [ -n "${_c_lockdir:-}" ]; then
    rm -rf "$_c_lockdir" 2>/dev/null || true
  fi
  exit "$_exit_code"
}

# True only while an exclusive materializer OWNS the writer flock. Merely
# seeing the path is not enough: the file deliberately outlives its holder.
# Ordinary preemptible jobs poll this while running so an exclusive drain can
# reclaim the slot domain instead of waiting behind a multi-hour holder until
# its fixed 900-second budget expires (WI-41318 / D-013).
_exclusive_writer_is_held() {
  local _probe_fd=''
  [ -e "$_exclusive_writer_path" ] || return 1
  command -v flock >/dev/null 2>&1 || return 1
  if ! { exec {_probe_fd}>"$_exclusive_writer_path"; } 2>/dev/null; then
    return 1
  fi
  if flock -n "$_probe_fd"; then
    eval "exec ${_probe_fd}>&-" 2>/dev/null || true
    return 1
  fi
  eval "exec ${_probe_fd}>&-" 2>/dev/null || true
  return 0
}

# Report who still owns each slot this barrier could not drain. Bounded so a
# wide slot domain cannot turn one refusal into hundreds of log lines.
_exclusive_report_undrained() {
  local _i='' _desc='' _listed=0
  for _i in $(seq 0 $(( _exclusive_slot_count - 1 ))); do
    # The drain is all-or-nothing: partial acquisitions are released between
    # polls so a live holder on one slot cannot squat every other slot until
    # the full materialization timeout. Report only slots that actually failed
    # in the most recent probe; a slot that was acquired and then released is
    # available to ordinary queued work, not an undrained blocker.
    [ "${_exclusive_unavailable[$_i]:-0}" = 1 ] || continue
    if [ "$_listed" -ge 8 ]; then
      echo "[pc-heavy]   (further undrained slots not listed)" >&2
      break
    fi
    _desc="$(_exclusive_describe_holders "$_dir/slot.$_i")"
    if [ -n "$_desc" ]; then
      echo "[pc-heavy]   undrained slot.$_i held by:$_desc" >&2
    else
      echo "[pc-heavy]   undrained slot.$_i: holder could not be identified" >&2
    fi
    _listed=$(( _listed + 1 ))
  done
}

# ── Exclusive materialization barrier (WI-40774) ───────────────────────────
# A release run-lock only changes admission for jobs that START after the gate is
# visible. It cannot make an already-running `test:affected` give back the slot it
# holds, which is how the 12.56 GiB checkpoint copy overlapped a +6.73 GiB sweep and
# drove memory/I/O PSI critical. The gate side therefore drains the SAME slot files
# normal jobs already hold and keeps them locked for setup-release-checkout.sh.
#
# Slot 0 is acquired first. With a protocol-3 `materializing` phase, ordinary new
# callers clamp to exactly one slot, so taking slot 0 closes the front door; the
# remaining files only drain work admitted before the phase. `_ceil` covers every
# adaptive slot, while persisted slot files cover explicit fixed counts and the
# deployment transition where an older pc-heavy process is still alive. Kernel
# flocks release on every exit/signal, and exec inherits the fds, so no cleanup
# daemon or stale-lock reaper is needed.
if [ "$_exclusive_all_slots" = 1 ]; then
  # EI-212278 / WI-40916: serialize the EXCLUSIVE writers before either one
  # touches an ordinary slot. Per-hive checkpoint routines fire on the same
  # minute boundary; without this outer mutex, two barriers can each acquire a
  # disjoint subset of slot.0..N and wait forever for the other's subset until
  # both hit the 900s refusal. Ordinary slot flocks cannot solve that classic
  # hold-and-wait deadlock themselves. The writer lock is in the SAME runtime
  # dir, is inherited by the materialization child, and is kernel-released on
  # every exit/signal just like the slot locks below.
  # EI-21355065353185484 — DECLARE INTENT FIRST, before queuing for the writer
  # mutex below. Ordinary holders poll this file to decide whether anyone is
  # waiting on the barrier; declaring it here (rather than relying on the writer
  # lock as a proxy) is what makes a materializer QUEUED BEHIND ANOTHER
  # materializer visible at all — while it sits in the `while ! flock -n` loop it
  # holds the writer lock precisely never, so under the old scheme it was
  # indistinguishable from "nobody is waiting" and ordinary holders had no reason
  # to yield. Held for this process's whole lifetime and inherited through the
  # final `exec`, so the kernel releases it on exit/signal like every other lock
  # here. Best-effort: if it cannot be established we still materialize — losing
  # the yield hint is a slowdown, never a correctness failure.
  if { exec {_exclusive_intent_fd}>>"$_exclusive_intent_path"; } 2>/dev/null; then
    # Bounded wait: the only contenders are microsecond-long shared probes, so
    # this returns immediately in practice. -w rather than -n so a probe that
    # happens to hold the shared lock at this instant cannot make us skip the
    # declaration entirely.
    flock -w 5 "$_exclusive_intent_fd" 2>/dev/null || true
  fi

  if ! { exec {_exclusive_writer_fd}>"$_exclusive_writer_path"; } 2>/dev/null; then
    echo "[pc-heavy] FATAL: cannot establish the exclusive materialization writer lock in $_dir" >&2
    exit 75
  fi
  _exclusive_writer_started=$(date +%s)
  _exclusive_writer_deadline=$(( _exclusive_writer_started + _timeout ))
  _exclusive_writer_last_heartbeat="$_exclusive_writer_started"
  _exclusive_heartbeat_every="${PC_HEAVY_HEARTBEAT_SEC:-15}"
  case "$_exclusive_heartbeat_every" in ''|*[!0-9]*) _exclusive_heartbeat_every=15 ;; esac
  _exclusive_writer_announced=0
  _exclusive_writer_wait_pid=''
  _exclusive_writer_wait_rc=0
  _exclusive_writer_unbounded=0
  case "${PC_HEAVY_RELEASE_GATE:-}" in
    1|on|ON|true|TRUE|yes|YES) _exclusive_writer_unbounded=1 ;;
  esac
  if ! flock -n "$_exclusive_writer_fd"; then
    # WI-41318 recurrence (2026-08-25): polling `flock -n` every 200ms is a
    # mutex, but it is not a queue. Later materializers can repeatedly win the
    # free-lock race ahead of a release gate that has already waited for
    # minutes. Put one blocking waiter in the kernel queue instead. It locks
    # this parent's inherited open-file description, so the lock remains held
    # after the helper exits and through the final `exec` below.
    flock "$_exclusive_writer_fd" &
    _exclusive_writer_wait_pid=$!
  fi
  while [ -n "$_exclusive_writer_wait_pid" ] && kill -0 "$_exclusive_writer_wait_pid" 2>/dev/null; do
    _exclusive_writer_now=$(date +%s)
    if [ "$_exclusive_writer_announced" = 0 ]; then
      echo "[pc-heavy] another exclusive materializer owns the writer lock — waiting before touching heavy slots" >&2
      _exclusive_writer_holders="$(_exclusive_describe_holders "$_exclusive_writer_path")"
      if [ -n "$_exclusive_writer_holders" ]; then
        echo "[pc-heavy]   writer lock held by:$_exclusive_writer_holders" >&2
      fi
      _exclusive_writer_announced=1
    elif [ $(( _exclusive_writer_now - _exclusive_writer_last_heartbeat )) -ge "$_exclusive_heartbeat_every" ]; then
      echo "[pc-heavy] still waiting for the exclusive materialization writer ($((_exclusive_writer_now - _exclusive_writer_started))s elapsed)" >&2
      _exclusive_writer_last_heartbeat="$_exclusive_writer_now"
    fi
    # A release gate is already inside its separately bounded setup process.
    # Applying the ordinary 900s admission deadline here spends a one-shot
    # qualification on queueing and emits green:null before the suite. Keep
    # ordinary materializers bounded; the gate's outer setup timeout remains
    # its lifecycle bound while this healthy serialized queue drains.
    if [ "$_exclusive_writer_unbounded" = 0 ] && [ "$_exclusive_writer_now" -ge "$_exclusive_writer_deadline" ]; then
      kill "$_exclusive_writer_wait_pid" 2>/dev/null || true
      wait "$_exclusive_writer_wait_pid" 2>/dev/null
      _exclusive_writer_wait_rc=$?
      _exclusive_writer_wait_pid=''
      # The waiter may have acquired and exited between kill -0 and kill. A
      # successful wait means this parent owns the flock; do not misreport that
      # narrow race as a refusal.
      [ "$_exclusive_writer_wait_rc" -eq 0 ] && break
      echo "[pc-heavy] REFUSED materialization after ${_timeout}s: another exclusive materializer still owns the writer lock; no heavy slots were acquired" >&2
      _exclusive_writer_holders="$(_exclusive_describe_holders "$_exclusive_writer_path")"
      if [ -n "$_exclusive_writer_holders" ]; then
        echo "[pc-heavy]   writer lock held by:$_exclusive_writer_holders" >&2
        echo "[pc-heavy]   check that pid before assuming a stale lock — a live materializer is not orphaned." >&2
      else
        echo "[pc-heavy]   writer lock holder could not be identified" >&2
      fi
      exit 75
    fi
    sleep 0.2
  done
  if [ -n "$_exclusive_writer_wait_pid" ]; then
    wait "$_exclusive_writer_wait_pid" 2>/dev/null
    _exclusive_writer_wait_rc=$?
    _exclusive_writer_wait_pid=''
    if [ "$_exclusive_writer_wait_rc" -ne 0 ]; then
      echo "[pc-heavy] REFUSED materialization: exclusive writer queue wait ended without acquiring the lock" >&2
      exit 75
    fi
  fi
  echo "[pc-heavy] exclusive materialization writer acquired — beginning heavy-slot drain" >&2

  _exclusive_slot_count="$_ceil"
  if [ "$_slots_fixed" = 1 ]; then
    case "$_slots_base" in
      ''|*[!0-9]*) : ;;
      *) [ "$_slots_base" -gt "$_exclusive_slot_count" ] && _exclusive_slot_count="$_slots_base" ;;
    esac
  fi
  for _slot_file in "$_dir"/slot.*; do
    [ -e "$_slot_file" ] || continue
    _slot_suffix="${_slot_file##*.}"
    case "$_slot_suffix" in ''|*[!0-9]*) continue ;; esac
    # A corrupted/hostile filename must not turn one gate run into a million-fd loop.
    [ "$_slot_suffix" -le 4095 ] || continue
    _candidate_count=$(( _slot_suffix + 1 ))
    [ "$_candidate_count" -gt "$_exclusive_slot_count" ] && _exclusive_slot_count="$_candidate_count"
  done
  [ "$_exclusive_slot_count" -lt 1 ] && _exclusive_slot_count=1

  # A queued writer receives a fresh drain budget once it becomes the sole
  # slot-domain writer. Charging its writer-queue wait against this deadline
  # would make the second healthy materializer acquire the mutex and then
  # immediately refuse without ever giving pre-existing ordinary holders time
  # to finish.
  _exclusive_started=$(date +%s)
  _exclusive_deadline=$(( _exclusive_started + _timeout ))
  _exclusive_last_heartbeat="$_exclusive_started"
  declare -a _exclusive_fds=()
  declare -a _exclusive_locked=()
  declare -a _exclusive_unavailable=()
  _exclusive_held=0
  _exclusive_holders_reported=0

  # Never retain a partial drain across polls. Holding N-1 free slots while
  # waiting for one live holder starves ordinary writers that could use those
  # slots. A probe may briefly acquire several slots, but it must either claim
  # the whole domain or release every partial acquisition before sleeping.
  _exclusive_release_partial() {
    local _fd=''
    for _fd in "${_exclusive_fds[@]:-}"; do
      case "$_fd" in
        ''|*[!0-9]*) continue ;;
        *) eval "exec ${_fd}>&-" 2>/dev/null || true ;;
      esac
    done
    _exclusive_fds=()
    _exclusive_locked=()
    _exclusive_held=0
  }

  echo "[pc-heavy] exclusive materialization barrier waiting to drain $_exclusive_slot_count heavy slot(s)" >&2

  while [ "$_exclusive_held" -lt "$_exclusive_slot_count" ]; do
    for _i in $(seq 0 $(( _exclusive_slot_count - 1 ))); do
      [ "${_exclusive_locked[$_i]:-0}" = 1 ] && continue
      _exclusive_unavailable[$_i]=0
      if { exec {_fd}>"$_dir/slot.$_i"; } 2>/dev/null; then
        if flock -n "$_fd"; then
          _exclusive_fds+=("$_fd")
          _exclusive_locked[$_i]=1
          _exclusive_held=$(( _exclusive_held + 1 ))
        else
          _exclusive_unavailable[$_i]=1
          eval "exec ${_fd}>&-" 2>/dev/null || true
        fi
      else
        _exclusive_unavailable[$_i]=1
      fi
    done
    [ "$_exclusive_held" -ge "$_exclusive_slot_count" ] && break
    _exclusive_release_partial
    _exclusive_now=$(date +%s)
    if [ $(( _exclusive_now - _exclusive_last_heartbeat )) -ge "$_exclusive_heartbeat_every" ]; then
      echo "[pc-heavy] exclusive materialization barrier still draining ($((_exclusive_now - _exclusive_started))s elapsed, $_exclusive_held/$_exclusive_slot_count slots held)" >&2
      # Name the blocker on the FIRST heartbeat, not only at the refusal: this
      # wait can legitimately last 900s, and whoever is watching should be able
      # to see who they are waiting on while there is still time to act. Once
      # only — the identity does not change every 15s, and a 900s wait would
      # otherwise emit 60 copies of it.
      if [ "$_exclusive_holders_reported" = 0 ]; then
        _exclusive_report_undrained
        _exclusive_holders_reported=1
      fi
      _exclusive_last_heartbeat="$_exclusive_now"
    fi
    if [ "$_exclusive_now" -ge "$_exclusive_deadline" ]; then
      _exclusive_drained="$_exclusive_held"
      _exclusive_release_partial
      echo "[pc-heavy] REFUSED materialization after ${_timeout}s: only $_exclusive_drained/$_exclusive_slot_count heavy slots drained; refusing to overlap dependency copy with live heavy work" >&2
      _exclusive_report_undrained
      echo "[pc-heavy]   check those pids before assuming a stale slot — a live heavy job is not orphaned." >&2
      exit 75
    fi
    sleep 0.2
  done

  echo "[pc-heavy] exclusive materialization barrier acquired — all $_exclusive_slot_count heavy slot(s) drained" >&2
  export PC_HEAVY_BYPASS=1
  exec "$@"
fi

# ── Coalescing (EI-18685262961418231) — see header note ─────────────────────
# Fail-open by construction: any missing prerequisite (kill-switch, no
# sha1sum, can't make the cache dir) just leaves _coalesce_enabled=0 and every
# line below becomes a no-op — the script behaves EXACTLY as before.
_coalesce_enabled=0
_do_cache_write=0
case "${PC_HEAVY_COALESCE:-1}" in
  0|off|OFF|false|FALSE|no|NO) ;;
  *)
    _coalesce_dir="$_dir/coalesce"
    if command -v sha1sum >/dev/null 2>&1 && mkdir -p "$_coalesce_dir" 2>/dev/null; then
      _coalesce_enabled=1
    fi
    ;;
esac

if [ "$_coalesce_enabled" = 1 ]; then
  _coalesce_ttl="${PC_HEAVY_COALESCE_SEC:-90}"

  # ── Per-caller freshness barrier (EI-19340233074452707) ───────────────
  # PC_HEAVY_FRESH_AFTER=<epoch-seconds> lets a caller say: "replay a result
  # only if that run STARTED at/after this instant." It exists because the
  # tree-state token below, while correct, is far STRICTER than correctness
  # requires — and on a fleet-edited tree that difference is the whole
  # ballgame.
  #
  # The token asks "did ANY file in the tree change?". Measured on this repo
  # 2026-08-02: one change every ~18s (11 distinct tokens in 199s), against a
  # ~170s operator-core compile. So the key moves ~9 times DURING a single
  # compile and two callers arriving seconds apart never compute the same key
  # — they cannot even see each other's lock. Zero coalescing; N full
  # compiles. Observed three separate times that day: 5, then 3, then 4
  # byte-identical `tsc -p packages/operator-core/tsconfig.json` runs live at
  # once (load1 120-186). See fact
  # `pc-heavy-tree-token-churns-faster-than-a-compile` and WI-7017, which
  # closed having proved the token cannot be tuned into working.
  #
  # But the question the token is a PROXY for is per-caller and much narrower:
  #
  #     a run that started at S is a valid answer for file F  iff  mtime(F) < S
  #
  # A full compile reads the whole tree, so its output is sound for every file
  # that did not change after it began — no matter what changed ELSEWHERE. The
  # token conflates "MY file moved" with "somebody else's file moved", and only
  # the first can invalidate my answer. That conflation is why coalescing looked
  # impossible here.
  #
  # So a caller that knows which files it is asking about passes the barrier and
  # we drop the token: the caller has taken responsibility for the freshness
  # question the token was standing in for, and answers it exactly instead of
  # conservatively. A caller that does NOT set it keeps today's behaviour
  # unchanged (token in the key) — this is purely opt-in, and the EI-18688348461605365
  # hazard it guards against is preserved for everyone who does not opt in.
  #
  # Note this also makes the coalescer SERIALIZING for the opt-in case, which is
  # the actual win: a follower whose barrier the current leader cannot satisfy
  # does not replay it and does not race off to run its own — it waits out the
  # leader (liveness-observed below), then wins the lock and becomes the next
  # leader, and every peer that queued behind it replays THAT run. N concurrent
  # compiles collapse to one at a time with the arrivals batched behind it.
  _fresh_after="${PC_HEAVY_FRESH_AFTER:-}"
  case "$_fresh_after" in ''|*[!0-9]*) _fresh_after="" ;; esac

  # ── Tree-state token (EI-18688348461605365) ────────────────────────────
  # cwd+argv alone is a STALE key whenever the SOURCE the command exercises
  # changed between two identical invocations — the single most common way
  # these commands get re-run (edit, then re-run to check the fix). Without
  # this, a follower replays a pre-edit result: silent, confirmatory-looking
  # wrong answer, not just a wasted run. Fold two cheap signals into the key
  # so an edit busts the cache while genuine duplicate polls (nothing
  # changed) still coalesce — deliberately NOT a full tree hash (must stay
  # near-zero overhead; this runs on every pc-heavy call, not just leaders):
  #   (a) any argv token that resolves to an existing regular file gets its
  #       mtime+size folded in — covers `<tool> /path/to/script` directly,
  #       INCLUDING a script outside the git tree (e.g. /tmp/genfix.mts,
  #       the exact reported repro — git status can't see that edit at all).
  #   (b) if cwd is inside a git worktree, hash `git status --porcelain=v2
  #       --branch` together with the tracked worktree diff. Status covers HEAD,
  #       paths, and untracked-file creation; the diff content is load-bearing for
  #       a SECOND edit to an already-dirty file, whose status row does not change.
  #
  # (b) uses `--untracked-files=all`, NOT the cheaper-looking `=no` it carried
  # until EI-19424611266793426. `=no` made the token blind to file CREATION, and
  # that is not a niche gap — it is precisely inverted against the error class
  # agents loop on this command to fix. A missing-module / missing-declaration
  # error (TS7016, TS2307) is fixed BY CREATING A FILE, so the token could not
  # see the one mutation that changes the verdict, and coalescing then replayed
  # the pre-fix red for the full window. Measured 2026-08-03: a correct fix (add
  # the entry to tsconfig.declarations.json, run gen:declarations, which emits an
  # untracked `.d.mts`) re-ran and returned the byte-identical failure from a
  # 201s-old cached run. The agent-facing cost is the worst shape available: a
  # stale verdict is INDISTINGUISHABLE from a real one, so the natural next move
  # is to abandon the correct fix and try a worse one (a cast, a @ts-expect-error,
  # hand-writing a generated file this repo forbids editing).
  #
  # `=all` rather than `=normal` on BOTH counts, which is not the intuitive call:
  # `=normal` collapses an untracked DIRECTORY to one entry, so a second file
  # created inside a wholly-untracked dir does not move the token at all. And
  # measured over 5 runs on this repo it is not even cheaper — 398ms for `=all`
  # vs 441ms for `=normal` vs 309ms for `=no` (a single sample says the opposite;
  # it is noise). So `=all` is both the sound choice and the fast one: +89ms on a
  # wrapper whose whole purpose is guarding 150s+ compiles.
  # Fail-open: git/stat unavailable just yields an empty token, degrading to
  # the previous cwd+argv-only behavior rather than erroring — coalescing
  # was already best-effort, this doesn't change that contract.
  #
  # Skipped entirely when the caller supplied a freshness barrier: the token
  # would then be both redundant (the barrier answers the same question, per
  # file) and harmful (it re-fragments the key so the barrier never gets a
  # chance to match). Skipping also drops the `git status` call from those
  # callers' hot path.
  _tree_token=""
  if [ -z "$_fresh_after" ]; then
    for _a in "$@"; do
      if [ -f "$_a" ]; then
        _tree_token="$_tree_token|$(stat -c '%Y:%s' "$_a" 2>/dev/null)"
      fi
    done
    if command -v git >/dev/null 2>&1; then
      _git_state=$({
        git status --porcelain=v2 --branch --untracked-files=all 2>/dev/null
        git diff --no-ext-diff --binary HEAD -- 2>/dev/null
      } | sha1sum | cut -d' ' -f1)
      [ -n "$_git_state" ] && _tree_token="$_tree_token|$(printf '%s' "$_git_state" | sha1sum | cut -d' ' -f1)"
    fi
  fi

  # ── Result-affecting ENVIRONMENT (EI-18699972365875475; blocker filed by EI-78) ──
  # cwd+argv+token is a COLLIDING key for any command that takes result-changing
  # input through the ENVIRONMENT rather than argv, and that is not hypothetical:
  # it is why the entire `test:*` family was pinned to PC_HEAVY_COALESCE=0 until
  # its affected-test entrypoints declared these inputs explicitly.
  # EI-78 stated the original hazard exactly — "its key is cwd+argv+tree-state and does NOT include
  # the ENVIRONMENT — while the gate varies AFFECTED_BASE via env alone. Two runs
  # at the same HEAD with different bases would collide and hand one of them a
  # verdict computed for a different delta". That is the same
  # stale-verdict-is-byte-indistinguishable-from-a-fresh-one hazard the tree token
  # above exists to kill, arriving through the one input the token cannot see.
  #
  # pc-heavy cannot know WHICH variables matter — that is caller knowledge, and
  # guessing a list here would be wrong in both directions (missing a caller's real
  # input, while fragmenting every key on an irrelevant one). So the caller
  # DECLARES them:  PC_HEAVY_KEY_ENV="AFFECTED_BASE,AFFECTED_RETRY_FAILED".
  #
  # MONOTONIC SAFETY, which is what makes this cheap to reason about: folding more
  # inputs into a hash can only make keys MORE distinct. This can therefore never
  # CREATE a replay that would not already have happened — it can only remove one.
  # A caller that declares nothing computes byte-identically the same key as before.
  #
  # UNSET and EMPTY are folded DISTINCTLY (`name=u` vs `name=s:`). For a variable
  # like AFFECTED_BASE, "unset" (use the built-in default) and "set to empty" are
  # different requests with different verdicts, so collapsing them would reintroduce
  # the very collision this exists to remove, at exactly the boundary a caller is
  # most likely to hit. Names are sorted, so two callers declaring the same set in a
  # different order still share a key; a malformed name is skipped rather than
  # aborting (fail-open, like every other signal in this block).
  _key_env_pairs=()
  if [ -n "${PC_HEAVY_KEY_ENV:-}" ]; then
    for _n in $(printf '%s' "${PC_HEAVY_KEY_ENV}" | tr ',' ' ' | tr -s '[:space:]' '\n' | sort -u); do
      case "$_n" in
        [A-Za-z_][A-Za-z0-9_]*) ;;
        *) continue ;;
      esac
      if [ -n "${!_n+x}" ]; then
        _key_env_pairs+=("$_n=s:${!_n}")
      else
        _key_env_pairs+=("$_n=u")
      fi
    done
  fi

  # Key on cwd + full argv + tree-state token, NUL-separated so args
  # containing spaces can't collide two different commands into the same key.
  #
  # The trailing marker keeps barriered and unbarriered callers in SEPARATE cache
  # populations. Without it the two coincide exactly when the tree token comes out
  # empty (no file-like argv, cwd not in a git worktree) — so whether a barriered
  # caller could inherit an unbarriered entry would depend on a condition neither
  # caller can see. Both directions happen to be safe today (every write is stamped,
  # so the barrier is enforced on replay regardless of who wrote the entry), but
  # "safe because the token happened to be empty" is not an invariant anyone can
  # rely on while editing this later. Separate them explicitly, so the rule is
  # simply: a barriered caller only ever replays a barriered run, past its watermark.
  # The declared-env pairs are appended LAST and emitted only when non-empty, so a
  # caller that declares nothing hashes the byte-identical input it did before this
  # block existed — no cache-population flag day, and nothing to migrate.
  _key=$({ printf '%s\0' "$PWD"; printf '%s\0' "$@"; printf '%s\0' "$_tree_token"; printf '%s\0' "${_fresh_after:+barrier}"; if [ "${#_key_env_pairs[@]}" -gt 0 ]; then printf '%s\0' "${_key_env_pairs[@]}"; fi; } | sha1sum | cut -d' ' -f1)
  _c_out="$_coalesce_dir/$_key.out"
  _c_err="$_coalesce_dir/$_key.err"
  _c_exit="$_coalesce_dir/$_key.exit"
  _c_lockdir="$_coalesce_dir/$_key.lock"

  # $_c_exit holds "<rc>" or, since the freshness barrier, "<rc> <startedAtEpoch>".
  #
  # The start stamp is packed INTO the exit file rather than written beside it as
  # its own `.started` file, and that is a correctness requirement, not tidiness:
  # a leader publishes its result at the END of the run, so with two files there
  # is a window in which `.started` has been updated to the NEW run while `.exit`
  # still holds the PREVIOUS one's. A follower reading the pair in that window
  # replays an OLD result while believing it started at the NEW time — precisely
  # the pre-edit-answer hazard the barrier exists to prevent, reintroduced by the
  # bookkeeping. One write, one atomic fact.
  _c_rc=""
  _c_started=""
  _c_read_exit() {
    _c_rc=""; _c_started=""
    [ -f "$_c_exit" ] || return 1
    read -r _c_rc _c_started < "$_c_exit" 2>/dev/null || return 1
    case "$_c_rc" in ''|*[!0-9]*) return 1 ;; esac
    return 0
  }

  # True when $_c_exit exists and is fresh enough to reuse.
  _coalesce_fresh() {
    _c_read_exit || return 1
    _mt=$(stat -c %Y "$_c_exit" 2>/dev/null) || return 1
    _now=$(date +%s)
    _age=$(( _now - _mt ))
    [ "$_age" -ge 0 ] && [ "$_age" -le "$_coalesce_ttl" ] || return 1
    # Barrier: the cached run must have STARTED at/after the caller's watermark.
    # A result with no start stamp (written by a pre-barrier pc-heavy) is
    # unusable for a barrier caller — absence of the stamp is not evidence the
    # run was recent enough, so it must read as "cannot replay", never as "fine".
    if [ -n "$_fresh_after" ]; then
      case "$_c_started" in ''|*[!0-9]*) return 1 ;; esac
      [ "$_c_started" -ge "$_fresh_after" ] || return 1
    fi
    return 0
  }

  # Replays the cached run's stdout/stderr/exit-code and NEVER RETURNS.
  _coalesce_replay() {
    echo "[pc-heavy] coalesced: reusing a ${_age}s-old identical run (same cwd+argv)" \
         "instead of spawning another — see EI-18685262961418231." \
         "Disable via PC_HEAVY_COALESCE=0." >&2
    cat "$_c_out" 2>/dev/null
    cat "$_c_err" >&2 2>/dev/null
    exit "${_c_rc:-1}"
  }

  # ── Leader liveness (EI-19343301596011451) ────────────────────────────────
  # "May I reuse a FINISHED result?" and "is the leader still WORKING?" are
  # different questions. They used to share _coalesce_ttl, and the second one
  # has no correct constant: any command slower than the window had its LIVE
  # leader's lock reclaimed as 'abandoned', while every follower hit the
  # deadline and launched a duplicate. The heavier the command, the more
  # reliably coalescing inverted into the herd it exists to prevent —
  # operator-core's typecheck runs ~180s against a 90s window, and five
  # identical compiles were observed queued at once with none running.
  #
  # So liveness is now OBSERVED. The leader stamps its identity into the
  # lockdir; a follower waits for as long as that process is actually alive.
  # PID alone is insufficient (PID wrap is ~daily on this box under fleet
  # load), so the start-time from /proc/<pid>/stat is recorded alongside it and
  # must match — a recycled PID reads as dead, never as a live leader.
  _c_max_wait="${PC_HEAVY_COALESCE_MAX_WAIT_SEC:-1800}"

  # starttime (stat field 22), robust to a comm containing spaces/parens:
  # everything through the final ')' is pid + comm, so field 22 is the 20th
  # field of the remainder.
  _proc_start() {
    sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'
  }
  _leader_id() { printf '%s %s\n' "$$" "$(_proc_start "$$")"; }

  _leader_alive() {
    [ -d "$_c_lockdir" ] || return 1
    _pid=""; _pstart=""
    if [ -f "$_c_lockdir/pid" ]; then
      read -r _pid _pstart < "$_c_lockdir/pid" 2>/dev/null || true
    fi
    if [ -n "$_pid" ] && [ -n "$_pstart" ]; then
      _cur=$(_proc_start "$_pid")
      [ -n "$_cur" ] && [ "$_cur" = "$_pstart" ]
      return
    fi
    # No usable stamp — the leader wins the lock a moment before it can stamp,
    # or /proc is unavailable. Fall back to the previous age heuristic rather
    # than declaring a possibly-live leader dead: this path must never reclaim
    # MORE aggressively than the behaviour it replaced.
    _lm=$(stat -c %Y "$_c_lockdir" 2>/dev/null || echo 0)
    [ $(( $(date +%s) - _lm )) -le "$_coalesce_ttl" ]
  }

  # Fast path: an already-fresh result sitting from a just-finished run —
  # never even touch the slot machinery.
  if _coalesce_fresh; then _coalesce_replay; fi

  # Race for leadership; a loser polls for the leader's result up to the
  # coalescing window, then gives up and runs uncached (never hangs forever).
  #
  # ── Second-leader race (EI-18685262961418231 follow-up) ────────────────────
  # A follower must check freshness BEFORE attempting mkdir, not only after a
  # FAILED mkdir. The original ordering (mkdir first, freshness check only on
  # miss) let a follower become a genuine SECOND leader whenever its loop
  # iteration landed in the narrow gap after the first leader wrote its result
  # and removed its lock dir but before that follower's next freshness check:
  # mkdir on the now-empty dir SUCCEEDS, so the follower re-runs the command
  # for real instead of replaying the fresh cache that already exists —
  # defeating coalescing for exactly the latecomers it exists to help, and
  # reproducibly so (not a rare flake): 6 concurrent callers reliably produced
  # 2 real leaders. Checking freshness at the TOP of every iteration closes
  # the common case; re-checking immediately AFTER winning the lock closes the
  # remaining microsecond TOCTOU window between that check and the mkdir call
  # itself (the previous leader can finish + free the lock in that gap too).
  _c_deadline=$(( $(date +%s) + _c_max_wait ))
  while :; do
    if _coalesce_fresh; then _coalesce_replay; fi
    if mkdir "$_c_lockdir" 2>/dev/null; then
      # Re-check: a fresh result may have appeared between the freshness
      # check just above and winning the lock (e.g. the prior leader finished
      # and removed its lock in that exact gap). Defer to it instead of
      # redundantly re-running.
      if _coalesce_fresh; then
        rm -rf "$_c_lockdir" 2>/dev/null || true
        _coalesce_replay
      fi
      # Stamp identity so followers can OBSERVE this leader rather than time
      # it out. Written immediately after winning the lock; _leader_alive
      # tolerates the sub-millisecond gap where the dir exists unstamped.
      _leader_id > "$_c_lockdir/pid" 2>/dev/null || true
      _do_cache_write=1
      # Also sweep the leader's in-progress output temps and capture FIFOs
      # (EI-19368312145172418):
      # a leader killed mid-run would otherwise leave a `.part` behind. Both are
      # still UNSET at this point — they are assigned only once the leader
      # actually runs — and `set -u` (above) makes expanding an unset name an
      # ABORT, not the intended no-op. So they must be expanded with `:-`: a
      # leader killed while still QUEUED otherwise dies printing
      # "line 1: _c_out_tmp: unbound variable", which reads as a fault in the
      # caller's own command, and the trap aborts partway through its cleanup
      # list rather than running all of it (WI-38277, observed live).
      trap '
        if [ -n "${_c_out_tee_pid:-}" ]; then kill "${_c_out_tee_pid}" 2>/dev/null || true; fi
        if [ -n "${_c_err_tee_pid:-}" ]; then kill "${_c_err_tee_pid}" 2>/dev/null || true; fi
        rm -rf "$_c_lockdir" 2>/dev/null
        rm -f "${_c_out_tmp:-}" "${_c_err_tmp:-}" "${_c_out_fifo:-}" "${_c_err_fifo:-}" 2>/dev/null
      ' EXIT
      break
    fi
    # Reclaim an ABANDONED lock. Unlike the flock slots above, a plain mkdir
    # lock has no kernel-level auto-release — a leader that's SIGKILL'd (never
    # trappable) leaves it stuck forever otherwise, taxing every future
    # identical call with a full wait before it gives up. "Abandoned" is now a
    # liveness OBSERVATION, so a long-running leader is never evicted and a
    # dead one is reclaimed at once instead of after a full window.
    #
    # rm -rf, not rmdir: the lockdir carries the pid stamp, and rmdir only
    # removes EMPTY dirs — it would fail silently here and disable reclaim.
    if ! _leader_alive; then
      rm -rf "$_c_lockdir" 2>/dev/null || true
    fi
    # Deliberately fall through to the deadline check + sleep rather than
    # `continue`-ing straight back: if the reclaim ever fails (permissions, a
    # racing peer) an immediate retry would spin hot forever.
    [ "$(date +%s)" -ge "$_c_deadline" ] && break
    sleep 0.3
  done
fi

# Try each slot non-blocking; hold the first free one open on its own fd.
#
# NOTE: `exec` with NO command applies ALL of its own redirections PERSISTENTLY
# to the invoking shell (that's how it keeps `{_fd}` open past this statement)
# — so a bare `exec {_fd}>file 2>/dev/null` doesn't just silence THIS open
# attempt, it permanently redirects the whole script's stderr to /dev/null for
# the rest of its life the moment the open succeeds (found while adding the
# coalescing feature below: EI-18685262961418231 investigation). Wrapping the
# `exec` in a `{ …; }` group scopes the `2>/dev/null` to just that group —
# bash restores the real fd 2 once the group exits — while the group still
# runs in the CURRENT shell (unlike `( … )`), so `{_fd}` still persists as
# intended. This silently ate every heavy command's stderr whenever a slot was
# free on the first try (the common, uncontended case) — real errors from
# tsc/vitest/build runs were being dropped on the floor.
_held=""
for _i in $(seq 0 $(( _slots - 1 ))); do
  if { exec {_fd}>"$_slot_dir/slot.$_i"; } 2>/dev/null; then
    if flock -n "$_fd"; then _held=1; break; fi
    eval "exec ${_fd}>&-" 2>/dev/null || true   # not ours — close it
  fi
done

# All slots busy → poll round-robin across ALL slots (non-blocking) until one
# frees or the timeout elapses; run anyway once it elapses so a stuck holder
# can't wedge the fleet (its slot frees on death regardless).
#
# (EI: pc-heavy slot-0 convoy) The original fallback blocked on slot.0
# SPECIFICALLY (`flock -w "$_timeout" "$_fd"` against slot.0's fd alone), so
# every waiter that missed the initial non-blocking sweep funneled onto ONE
# mutex even when other slots (1..N-1) were completely idle — observed live:
# ~20 waiters queued on slot.0's flock while slot.2 and slot.3 had zero
# holders, on a 4-slot host. A blocking wait on a single slot can never
# notice a DIFFERENT slot freeing. Poll round-robin instead so whichever slot
# frees first is grabbed by whichever waiter next polls it — no single slot
# becomes a convoy point while siblings sit unused.
if [ -z "$_held" ]; then
  # A caller deadline is allowed to end a queued wrapper, but it must not erase
  # the distinction between "never got a slot" and "real work was terminated."
  # TERM/HUP are the common caller/session signals; both become EX_TEMPFAIL so
  # the caller can retry after the reported holder/event clears.
  trap '_pc_heavy_queue_abort TERM 75' TERM
  trap '_pc_heavy_queue_abort HUP 75' HUP
  # EI-19343041616234869 — the ONLY output pc-heavy printed before this fell
  # out entirely if a caller hit the fallback wait with the release gate NOT
  # active (the "release gate is JUDGING..." line above is gated on that, so
  # ordinary peer-slot contention alone produced it too, but never fired for
  # this branch). A caller backgrounding this whole run (the documented
  # ~150s+ idiom) then sees a genuinely empty log for the ENTIRE queued
  # duration — a 0-byte log is indistinguishable from "not started",
  # "died silently", and "queued for minutes", which is exactly the
  # inference this line + the heartbeat below restore. Fires once, the
  # instant queueing actually begins (never on the common uncontended
  # fast-path above, which never reaches this branch at all).
  if [ "$_focused_lane" = 1 ]; then
    echo "[pc-heavy] queued for a focused test lane slot (all $_slots slot(s) busy) —" \
         "pid $$, waiting up to ${_timeout}s" >&2
  else
    echo "[pc-heavy] queued for a heavy slot (all $_slots slot(s) busy) —" \
         "pid $$, waiting up to ${_timeout}s" >&2
  fi
  _wait_start=$(date +%s)
  _fallback_deadline=$(( _wait_start + _timeout ))
  # PC_HEAVY_HEARTBEAT_SEC: test-only override (default 15s in production) so a
  # suite can assert multiple heartbeats without actually waiting 15s+ per one.
  _heartbeat_every="${PC_HEAVY_HEARTBEAT_SEC:-15}"
  case "$_heartbeat_every" in ''|*[!0-9]*) _heartbeat_every=15 ;; esac
  _last_heartbeat="$_wait_start"
  while :; do
    # Re-resolve each sweep so a waiter's admitted count tracks the box: load
    # dropping widens the probe set mid-wait, rising load narrows it back
    # toward the floor (held slots are never revoked). This also re-checks the
    # release-gate clamp, so a gate run STARTING mid-wait narrows the set and
    # one FINISHING re-widens it — a waiter that queued before the gate began
    # must not walk into the run it is about to starve. Unlike load adaptation
    # this applies to a FIXED PC_HEAVY_SLOTS too (see _effective_slots).
    if [ "$_focused_lane" = 1 ]; then
      _slots="$_focused_slots"
    else
      _slots="$(_effective_slots)"
    fi
    for _i in $(seq 0 $(( _slots - 1 ))); do
      if { exec {_fd}>"$_slot_dir/slot.$_i"; } 2>/dev/null; then
        if flock -n "$_fd"; then _held=1; break 2; fi
        eval "exec ${_fd}>&-" 2>/dev/null || true   # not ours — close it
      fi
    done
    _now=$(date +%s)
    # Periodic "still alive, still queued" heartbeat so a long wait (the
    # normal case under a hard gate clamp) never goes silent for minutes at a
    # stretch — same rationale as the enqueue line above, just amortized
    # across the wait instead of a single point-in-time print.
    if [ $(( _now - _last_heartbeat )) -ge "$_heartbeat_every" ]; then
      echo "[pc-heavy] still queued ($(( _now - _wait_start ))s elapsed, pid $$," \
           "slots=$_slots)" >&2
      _last_heartbeat="$_now"
    fi
    [ "$_now" -ge "$_fallback_deadline" ] && break
    sleep 0.5
  done
  trap - TERM HUP
fi

# EI-19315037905600226 — a machine-readable landmark for "the wait is over, the
# real command is about to start", printed on stderr the instant this script
# stops waiting (whether it won a slot or fell through the timeout). Without
# this, a background job SIGKILLed by ITS OWN caller-side deadline (see
# capability:bash / bash-jobs.ts) while still queued here looks byte-identical
# to one killed mid-execution — the caller cannot tell "my task ran long" from
# "my task never got a turn". bash-jobs.ts greps a job's output for this exact
# string when its deadline fires; keep the two in sync
# (PC_HEAVY_SLOT_ACQUIRED_MARKER in
# packages/operator-core/lib/agent-tools/capability/bash-jobs.ts).
#
# The gate-phase refusal is re-evaluated HERE, against a fresh phase read, before
# the marker is printed (EI-19970072096315178) — the phase may have advanced into
# a classifier phase while we were queued. It must stay ABOVE the marker: the
# marker means "the real command is about to start", and bash-jobs.ts greps for
# it, so emitting it and then refusing would make a refusal indistinguishable
# from a command that ran.
_gate_recheck_refusal "$@"
echo "[pc-heavy] slot acquired — starting real work" >&2

# The child self-limits via the slot it now (or effectively) holds — tell the
# admission gate not to also deny it.
export PC_HEAVY_BYPASS=1

# Lower CPU (and IO, when available) priority so a held run yields to
# interactive work and the CPUWeight-protected critical services.
_runner=(nice -n "${PC_HEAVY_NICE:-10}")
_ionice="${PC_HEAVY_IONICE-best-effort 7}"
if [ -n "$_ionice" ] && command -v ionice >/dev/null 2>&1; then
  # shellcheck disable=SC2206
  _ic=($_ionice)
  case "${_ic[0]}" in
    best-effort) _runner=(ionice -c2 -n "${_ic[1]:-7}" "${_runner[@]}") ;;
    idle)        _runner=(ionice -c3 "${_runner[@]}") ;;
    *)           _runner=(ionice "${_ic[@]}" "${_runner[@]}") ;;
  esac
fi

# Cooperative yield is the DEFAULT on hosts that can isolate a child process
# group. The old opt-in fixed one known four-hour service while leaving the
# stated liveness class intact: a routine affected-tests run also exceeded the
# exclusive drain's 900-second budget minutes later. Wrap `_runner` itself so
# the behavior also covers coalescing leaders; their early exit below used to
# bypass the late opt-in block entirely.
_preemptible=0
_preempt_mode="${PC_HEAVY_PREEMPTIBLE:-auto}"
case "$_preempt_mode" in
  0|off|OFF|false|FALSE|no|NO) _preemptible=0 ;;
  1|on|ON|true|TRUE|yes|YES)
    if ! command -v setsid >/dev/null 2>&1; then
      echo "[pc-heavy] REFUSED preemptible heavy run: setsid is unavailable, so the child tree cannot be yielded safely" >&2
      exit 75
    fi
    _preemptible=1
    ;;
  auto|'')
    command -v setsid >/dev/null 2>&1 && _preemptible=1
    ;;
  *)
    echo "[pc-heavy] invalid PC_HEAVY_PREEMPTIBLE=$_preempt_mode; expected auto, 1, or 0" >&2
    exit 75
    ;;
esac
# Focused verification owns an independent slot domain, so an exclusive
# materializer cannot be blocked by its holder. Keep the default cooperative
# preemption monitor off for that lane; an explicit PC_HEAVY_PREEMPTIBLE=1
# remains an intentional caller opt-in.
if [ "$_focused_lane" = 1 ] && [ "$_preempt_mode" = auto ]; then
  _preemptible=0
fi

# The after-ready barrier is opt-in and fail-closed. The wrapper owns only the
# unique path; the child publishes the marker after its irreversible setup and
# the monitor removes it at every terminal/reap boundary. Never accept a caller
# supplied path here: accepting one would let cleanup remove an unrelated file
# and would let two concurrent runs share a barrier.
_preempt_after_ready="${PC_HEAVY_PREEMPT_AFTER_READY:-0}"
case "$_preempt_after_ready" in
  0|off|OFF|false|FALSE|no|NO)
    unset PC_HEAVY_PREEMPT_READY_FILE
    ;;
  1|on|ON|true|TRUE|yes|YES)
    _preempt_ready_dir="${PC_HEAVY_PREEMPT_READY_DIR:-${TMPDIR:-/tmp}/pc-heavy-ready}"
    if ! mkdir -p "$_preempt_ready_dir" 2>/dev/null; then
      echo "[pc-heavy] REFUSED after-ready barrier: cannot create marker directory $_preempt_ready_dir" >&2
      exit 75
    fi
    _preempt_ready_file="$(mktemp "$_preempt_ready_dir/ready.XXXXXX" 2>/dev/null || true)"
    if [ -z "$_preempt_ready_file" ] || ! rm -f "$_preempt_ready_file" 2>/dev/null; then
      echo "[pc-heavy] REFUSED after-ready barrier: cannot allocate a unique marker path" >&2
      exit 75
    fi
    export PC_HEAVY_PREEMPT_READY_FILE="$_preempt_ready_file"
    ;;
  *)
    echo "[pc-heavy] invalid PC_HEAVY_PREEMPT_AFTER_READY=$_preempt_after_ready; expected auto/off, 1, or 0" >&2
    exit 75
    ;;
esac

# A capability background job is enrolled in its own systemd service and is
# contractually durable across an operator-host recycle. Its shell still keeps
# the old host as PPID after cgroup migration, so PPID death is NOT orphan proof
# for that one class. Disable only caller-liveness coupling; the outer-wrapper
# and exclusive-materializer checks remain active.
_durable_caller="${PC_HEAVY_DURABLE_CALLER:-0}"
case "$_durable_caller" in
  0|off|OFF|false|FALSE|no|NO) _durable_caller=0 ;;
  1|on|ON|true|TRUE|yes|YES) _durable_caller=1 ;;
  *)
    echo "[pc-heavy] invalid PC_HEAVY_DURABLE_CALLER=$_durable_caller; expected 1 or 0" >&2
    exit 75
    ;;
esac
if [ "$_preemptible" = 1 ]; then
  # The monitor must follow the ORIGINAL caller, not only this wrapper. A dead
  # caller leaves the wrapper blocked in its wait and reparented to init, so the
  # wrapper PID alone is not an ownership signal. Start ticks make the identity
  # stable across PID reuse; if /proc cannot provide them, keep the established
  # outer-wrapper-only behaviour rather than guessing.
  unset PC_HEAVY_CALLER_PID PC_HEAVY_CALLER_START_TICKS
  if [ "$_durable_caller" != 1 ]; then
    _pc_heavy_caller_pid="${PPID:-}"
    _pc_heavy_caller_start_ticks="$(_pc_heavy_proc_start_ticks "$_pc_heavy_caller_pid" 2>/dev/null || true)"
    case "$_pc_heavy_caller_pid:$_pc_heavy_caller_start_ticks" in
      *[!0-9:]*|:*|*:) ;;
      *)
        export PC_HEAVY_CALLER_PID="$_pc_heavy_caller_pid"
        export PC_HEAVY_CALLER_START_TICKS="$_pc_heavy_caller_start_ticks"
        ;;
    esac
  fi
  # Keep the monitor outside the outer wrapper's process group. Do NOT use
  # `setsid --fork --wait` here: its waitable parent stays in the outer group,
  # and killing that group also tears down the forked monitor before it can reap
  # the workload. Bash already executes this external command in a child that
  # is not the existing process-group leader, so direct `setsid --wait` makes
  # the waitable monitor itself the new session leader. `_outer_pid` then lets
  # it detect wrapper death and reap the child group before returning.
  _runner=(setsid --wait bash "$0" --pc-heavy-internal-preempt-run "$$" "$_exclusive_intent_path" "${_runner[@]}")
fi

# Preserve the caller's original stderr for the detached monitor BEFORE the
# coalescing leader redirects fd 2 through a FIFO. The capture reader is owned
# by this outer wrapper and therefore disappears with it on a caller-side
# SIGKILL; this duplicate remains attached to the caller's stderr pipe until
# the monitor finishes its parent-death cleanup. Validate both the fd number
# and its target so the monitor never receives an unrelated inherited fd.
_preempt_notify_fd=''
if [ "$_preemptible" = 1 ]; then
  if exec {_preempt_notify_fd}>&2; then
    _preempt_notify_target="$(readlink "/proc/self/fd/$_preempt_notify_fd" 2>/dev/null || true)"
    # `readlink /proc/self/fd/2 2>/dev/null` would inspect the readlink
    # process's fd 2 — which is necessarily /dev/null because of that very
    # suppression redirection — rather than this wrapper's original stderr.
    # Resolve the outer shell's descriptor by PID so the probe can stay quiet
    # without changing the descriptor it is validating.
    _preempt_stderr_target="$(readlink "/proc/$$/fd/2" 2>/dev/null || true)"
    case "$_preempt_notify_fd" in
      ''|0|1|2|*[!0-9]*) _preempt_notify_fd='' ;;
      *)
        if [ -z "$_preempt_notify_target" ] || [ "$_preempt_notify_target" != "$_preempt_stderr_target" ] || ! { : >&"$_preempt_notify_fd"; } 2>/dev/null; then
          eval "exec ${_preempt_notify_fd}>&-" 2>/dev/null || true
          _preempt_notify_fd=''
        else
          export PC_HEAVY_PREEMPT_NOTIFY_FD="$_preempt_notify_fd"
        fi
        ;;
    esac
  fi
fi

# Run holding the slot; the flock releases when this shell exits (normal, error,
# or signal). We intentionally do NOT `exec` so the fd/lock stays with us.
if [ "$_do_cache_write" = 1 ]; then
  # Leader path: tee combined streams to the coalescing cache while keeping
  # stdout/stderr genuinely separate for OUR OWN caller. The capture readers
  # use explicit FIFOs and PIDs instead of process substitution: a command may
  # spawn a daemon that inherits the capture descriptors after the command PID
  # exits, and Bash's implicit process-substitution wait would then hang forever
  # waiting for EOF that belongs to the daemon's descriptor table (EI-21261757807519288).
  # Stamped HERE, not when the lock was won: winning the lock can precede the
  # actual start by however long the slot sweep below had to wait, and the
  # barrier's guarantee is about when the command began READING the tree.
  # (Stamping the earlier instant would still be sound — it only ever makes the
  # stamp smaller, i.e. the check stricter — but it needlessly rejects replays.)
  _started_at=$(date +%s)
  # Tee to PER-PROCESS TEMP files, never straight to the live $_c_out/$_c_err
  # (EI-19368312145172418). `tee FILE` TRUNCATES at open — i.e. the instant this
  # leader starts, before it has a single byte to write — while freshness is
  # gated on a DIFFERENT file, $_c_exit, which still holds the PREVIOUS run's rc
  # and mtime. Writing the live files directly therefore opens a window, lasting
  # this entire run (~174s for a typecheck), in which a follower is told "fresh,
  # rc=0" and then replays a file that was just emptied. Measured: a follower
  # returned exit 0 with NO output, and `lint:tsc`'s own "no output means the
  # toolchain broke" check turned that into a hard red pointing at the caller's
  # toolchain rather than at this cache.
  #
  # Reaching it only needs two callers to disagree about freshness — routine,
  # since PC_HEAVY_COALESCE_SEC is per-caller (default 90, this repo's own suite
  # passes 30) — so the second caller runs as a new leader and truncates an entry
  # the first still considers replayable.
  #
  # This is the same "one write, one atomic fact" rule already argued for the
  # start-stamp above; it was applied to $_c_exit but not to the output files.
  # Rename is atomic within a directory, so a follower sees either the complete
  # OLD pair or the complete NEW one, never a half-written file. Publish the
  # outputs BEFORE $_c_exit, because $_c_exit is the gate: anything that passes
  # it must already have its output in place.
  _c_out_tmp="$_c_out.$$.part"
  _c_err_tmp="$_c_err.$$.part"
  # WI-40946 / EI-21261757807519288 — capture helpers must not inherit the
  # wrapper's slot or each other's FIFO descriptors. The real command tree MUST
  # inherit `_fd` (the slot covers all of its work), but the two passive capture
  # helpers must not. Closing every non-stdio descriptor in the helper also
  # prevents the stderr tee from retaining the stdout tee's input pipe.
  _pc_heavy_capture_without_slot_fd() {
    _capture_fd_path=""
    _capture_fd_num=""
    for _capture_fd_path in /proc/self/fd/*; do
      _capture_fd_num="${_capture_fd_path##*/}"
      case "$_capture_fd_num" in
        0|1|2) ;;
        *) eval "exec ${_capture_fd_num}>&-" 2>/dev/null || true ;;
      esac
    done
    exec tee "$1"
  }

  _c_out_fifo="$_c_out.$$.out.pipe"
  _c_err_fifo="$_c_err.$$.err.pipe"
  _c_out_tee_pid=""
  _c_err_tee_pid=""
  if mkfifo "$_c_out_fifo" "$_c_err_fifo" 2>/dev/null; then
    # Start readers before opening the command's FIFO writers. Each helper is
    # explicitly tracked so it can be terminated as soon as the command PID
    # exits, even when a daemon still holds a writer open.
    _pc_heavy_capture_without_slot_fd "$_c_out_tmp" <"$_c_out_fifo" &
    _c_out_tee_pid=$!
    _pc_heavy_capture_without_slot_fd "$_c_err_tmp" <"$_c_err_fifo" >&2 &
    _c_err_tee_pid=$!
    "${_runner[@]}" "$@" >"$_c_out_fifo" 2>"$_c_err_fifo"
    _rc=$?
    # The command has returned; any remaining FIFO writers belong to
    # descendants. They must not decide when this wrapper or its caller sees
    # completion. GNU tee writes each read promptly, so killing the readers
    # here preserves the command's completed output while releasing the pipe.
    kill "$_c_out_tee_pid" "$_c_err_tee_pid" 2>/dev/null || true
    wait "$_c_out_tee_pid" "$_c_err_tee_pid" 2>/dev/null || true
    rm -f "$_c_out_fifo" "$_c_err_fifo" 2>/dev/null || true
  else
    # Coalescing is best-effort. If this cache directory cannot host FIFOs,
    # run the command normally rather than risking a blocked writer or a
    # cache entry with no complete output pair.
    _do_cache_write=0
    "${_runner[@]}" "$@"
    exit $?
  fi
  mv -f "$_c_out_tmp" "$_c_out" 2>/dev/null
  mv -f "$_c_err_tmp" "$_c_err" 2>/dev/null
  printf '%s %s\n' "$_rc" "$_started_at" > "$_c_exit" 2>/dev/null
  rm -f "$_c_out_tmp" "$_c_err_tmp" 2>/dev/null   # no-op after a successful mv
  rm -rf "$_c_lockdir" 2>/dev/null
  trap - EXIT
  exit "$_rc"
fi

"${_runner[@]}" "$@"
exit $?
}

_pc_heavy_retry_result_file=''

# Run the requested command through a bounded outer retry policy. This wrapper
# deliberately lives OUTSIDE `main`: the normal pc-heavy invocation has many
# terminal `exit` paths (including coalescing replay), so a same-shell retry
# would either be unreachable or accidentally retry a result that never ran.
# Each attempt is a fresh child invocation and publishes its private terminal
# preemption marker through PC_HEAVY_PREEMPT_RESULT_FILE.
_pc_heavy_run_with_retries() {
  if [ "${PC_HEAVY_RETRY_ACTIVE:-0}" = 1 ]; then
    main "$@"
    return $?
  fi

  local _retry_raw="${PC_HEAVY_RETRY_PREEMPTIONS:-0}"
  case "$_retry_raw" in
    ''|0)
      main "$@"
      return $?
      ;;
    *[!0-9]*)
      echo "[pc-heavy] invalid PC_HEAVY_RETRY_PREEMPTIONS=$_retry_raw; expected a non-negative integer" >&2
      return 75
      ;;
  esac

  local _retry_limit="$_retry_raw"
  if [ "$_retry_limit" -gt 10 ]; then
    echo "[pc-heavy] PC_HEAVY_RETRY_PREEMPTIONS=$_retry_limit exceeds the bounded maximum; clamping to 10" >&2
    _retry_limit=10
  fi

  _pc_heavy_retry_result_file="$(mktemp "${TMPDIR:-/tmp}/pc-heavy-preempt-result.XXXXXX" 2>/dev/null || true)"
  if [ -z "$_pc_heavy_retry_result_file" ]; then
    echo "[pc-heavy] retry marker unavailable; running without preemption retries" >&2
    main "$@"
    return $?
  fi
  trap 'rm -f "${_pc_heavy_retry_result_file:-}" 2>/dev/null || true' EXIT

  local _retry_attempt=0 _retry_rc=0 _retry_marker=''
  while [ "$_retry_attempt" -le "$_retry_limit" ]; do
    rm -f "$_pc_heavy_retry_result_file" 2>/dev/null || true

    # Retry-enabled callers must not replay a cached exit 75. Disable
    # coalescing on the first attempt as well as subsequent attempts: an older
    # preemption may already be cached before this policy is introduced, and
    # that cache contains no private marker for this outer loop to inspect.
    PC_HEAVY_RETRY_ACTIVE=1 \
      PC_HEAVY_PREEMPT_RESULT_FILE="$_pc_heavy_retry_result_file" \
      PC_HEAVY_COALESCE=0 \
      bash "$0" "$@"
    _retry_rc=$?

    _retry_marker=''
    if [ -f "$_pc_heavy_retry_result_file" ]; then
      IFS= read -r _retry_marker < "$_pc_heavy_retry_result_file" 2>/dev/null || true
    fi

    if [ "$_retry_rc" -eq 75 ] && [ "$_retry_marker" = "PC_HEAVY_RESULT status=preempted reason=exclusive-materializer" ]; then
      if [ "$_retry_attempt" -lt "$_retry_limit" ]; then
        _retry_attempt=$(( _retry_attempt + 1 ))
        echo "[pc-heavy] retrying after exclusive-materializer preemption (retry $_retry_attempt/$_retry_limit)" >&2
        continue
      fi
      echo "[pc-heavy] exhausted $_retry_limit preemption retry(s); returning the exact exclusive-materializer failure" >&2
    fi

    trap - EXIT
    rm -f "$_pc_heavy_retry_result_file" 2>/dev/null || true
    return "$_retry_rc"
  done
}

_pc_heavy_run_with_retries "$@"
exit $?
