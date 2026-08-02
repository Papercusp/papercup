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
#   PC_HEAVY_GATE_RESERVE "1"(default)/"0" — while a green-checkpoint run is in
#                         flight, clamp the effective slot count to a quarter of
#                         the steady-state target (min 1) so the gate's isolation
#                         re-run keeps host headroom (EI-19315056231449472; see
#                         the block by _gate_reserve_active). off/false/no also
#                         disable. Applies to a FIXED PC_HEAVY_SLOTS too.
#   PAPERCUSP_CHECKPOINT_LOG_DIR  where green-checkpoint publishes its run lock
#                         (default ~/.papercusp/checkpoint-logs) — the SAME var
#                         release-config.ts resolves it from, so an alternate
#                         lineage or a test lines up without a second knob.
#   PC_HEAVY_DEBUG        "1" → print the computed slot count + inputs to stderr.
#   PC_HEAVY_TIMEOUT_SEC  max seconds to WAIT for a slot before running anyway
#                         (default 900). Running-anyway (never blocking forever)
#                         keeps a wedged holder from deadlocking the fleet; the
#                         kernel also frees a slot the instant its holder dies.
#   PC_HEAVY_DIR          slot-file dir (default ${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots)
#   PC_HEAVY_NICE         nice increment (default 10)
#   PC_HEAVY_IONICE       ionice spec: "best-effort N" | "idle" | "" to skip
#                         (default "best-effort 7"; UNSET uses the default,
#                         set-but-EMPTY skips ionice)
#   PC_HEAVY_COALESCE     "1"(default)/"0" — coalesce genuinely-CONCURRENT
#                         identical invocations (see below). off/false/no also
#                         disable.
#   PC_HEAVY_COALESCE_SEC coalescing window in seconds (default 90).
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
# `--incremental` staleness bug EI-487 already burned this team on. A slow
# leader is never blocked on by a follower forever: after the coalescing
# window elapses with no fresh result, a follower gives up waiting and just
# runs the command itself (uncached), so a wedged/crashed leader can never
# starve the fleet. Kill-switch: PC_HEAVY_COALESCE=0.

# NOTE: deliberately no `set -e` — a non-blocking flock miss returns non-zero by
# design and must not abort the script.
set -uo pipefail

# Strip an optional leading `--` separating flags from the command.
if [ "${1:-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then
  echo "pc-heavy: no command given" >&2
  echo "usage: pc-heavy.sh [--] <command> [args...]" >&2
  exit 2
fi

# Already inside a slot (nested pc-heavy, or the caller pre-bypassed): just run.
if [ "${PC_HEAVY_BYPASS:-}" = "1" ]; then
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
if [ "${PC_HEAVY_RELEASE_GATE:-}" = "1" ]; then
  export PC_HEAVY_BYPASS=1
  exec "$@"
fi

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
# run's pid, so liveness is a plain `kill -0`. That is what makes the clamp
# safe: a crashed gate run's leftover lock is self-evidently dead and IGNORED,
# so it can never wedge the fleet into permanent 1-slot mode. Same env var the
# TypeScript side resolves the dir from (release-config.ts), so a test/alternate
# lineage lines up automatically.
#
# Fail-open on EVERY unexpected input: no dir, no lock, unparseable json,
# non-numeric pid, dead pid, no `kill` → behave exactly as if no gate were
# running. Worst case degrades to today's behavior.
# Escape hatch: PC_HEAVY_GATE_RESERVE=0.
_gate_reserve_active() {
  case "${PC_HEAVY_GATE_RESERVE:-1}" in
    0|off|OFF|false|FALSE|no|NO) return 1 ;;
  esac
  local _logdir="${PAPERCUSP_CHECKPOINT_LOG_DIR:-${HOME:-}/.papercusp/checkpoint-logs}"
  [ -d "$_logdir" ] || return 1
  local _owner _pid
  # No nullglob: a non-matching glob yields the literal pattern, which the
  # -f test below rejects — that IS the no-gate-running path.
  for _owner in "$_logdir"/.green-checkpoint-run-*.lock/owner.json; do
    [ -f "$_owner" ] || continue
    _pid=$(head -c 4096 "$_owner" 2>/dev/null | tr -d ' \n' \
            | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' | head -1)
    case "$_pid" in ''|*[!0-9]*) continue ;; esac
    # A dead pid means the run crashed and left its lock behind — ignore it.
    kill -0 "$_pid" 2>/dev/null && return 0
  done
  return 1
}

# Effective slot count: the steady-state target (fixed or load-adaptive), then
# the gate clamp. The clamp applies to an explicit PC_HEAVY_SLOTS too — it is a
# safety reserve, not load adaptation, and it has its own dedicated override.
_effective_slots() {
  local _n
  if [ "$_slots_fixed" = 1 ]; then _n="$_slots_base"; else _n="$(_calc_slots)"; fi
  case "$_n" in ''|*[!0-9]*) _n="$_floor" ;; esac
  if _gate_reserve_active; then
    local _clamped=$(( _n / 4 ))
    [ "$_clamped" -lt 1 ] && _clamped=1
    [ "$_clamped" -lt "$_n" ] && _n="$_clamped"
  fi
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
if [ "$_gate_active" = 1 ]; then
  echo "[pc-heavy] release gate is JUDGING — heavy slots clamped to $_slots to keep" \
       "headroom for its isolation re-run (EI-19315056231449472)." \
       "Override with PC_HEAVY_GATE_RESERVE=0." >&2
fi
if [ "${PC_HEAVY_DEBUG:-}" = "1" ]; then
  echo "[pc-heavy] slots=$_slots fixed=$_slots_fixed cores=$_cores floor=$_floor ceil=$_ceil gate=$_gate_active" >&2
fi
_dir="${PC_HEAVY_DIR:-${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots}"
_timeout="${PC_HEAVY_TIMEOUT_SEC:-900}"

# Can't create the slot dir or flock is missing → fail-open (run unthrottled).
if ! mkdir -p "$_dir" 2>/dev/null || ! command -v flock >/dev/null 2>&1; then
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
  #   (b) if cwd is inside a git worktree, one `git status --porcelain=v2
  #       --branch` call (HEAD + tracked-file changes in one invocation) —
  #       covers "I edited a repo-tracked file the command exercises".
  # Fail-open: git/stat unavailable just yields an empty token, degrading to
  # the previous cwd+argv-only behavior rather than erroring — coalescing
  # was already best-effort, this doesn't change that contract.
  _tree_token=""
  for _a in "$@"; do
    if [ -f "$_a" ]; then
      _tree_token="$_tree_token|$(stat -c '%Y:%s' "$_a" 2>/dev/null)"
    fi
  done
  if command -v git >/dev/null 2>&1; then
    _git_state=$(git status --porcelain=v2 --branch --untracked-files=no 2>/dev/null)
    [ -n "$_git_state" ] && _tree_token="$_tree_token|$(printf '%s' "$_git_state" | sha1sum | cut -d' ' -f1)"
  fi

  # Key on cwd + full argv + tree-state token, NUL-separated so args
  # containing spaces can't collide two different commands into the same key.
  _key=$({ printf '%s\0' "$PWD"; printf '%s\0' "$@"; printf '%s\0' "$_tree_token"; } | sha1sum | cut -d' ' -f1)
  _c_out="$_coalesce_dir/$_key.out"
  _c_err="$_coalesce_dir/$_key.err"
  _c_exit="$_coalesce_dir/$_key.exit"
  _c_lockdir="$_coalesce_dir/$_key.lock"

  # True when $_c_exit exists and is fresh enough to reuse.
  _coalesce_fresh() {
    [ -f "$_c_exit" ] || return 1
    _mt=$(stat -c %Y "$_c_exit" 2>/dev/null) || return 1
    _now=$(date +%s)
    _age=$(( _now - _mt ))
    [ "$_age" -ge 0 ] && [ "$_age" -le "$_coalesce_ttl" ]
  }

  # Replays the cached run's stdout/stderr/exit-code and NEVER RETURNS.
  _coalesce_replay() {
    echo "[pc-heavy] coalesced: reusing a ${_age}s-old identical run (same cwd+argv)" \
         "instead of spawning another — see EI-18685262961418231." \
         "Disable via PC_HEAVY_COALESCE=0." >&2
    cat "$_c_out" 2>/dev/null
    cat "$_c_err" >&2 2>/dev/null
    exit "$(cat "$_c_exit" 2>/dev/null || echo 1)"
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
  _c_deadline=$(( $(date +%s) + _coalesce_ttl ))
  while :; do
    if _coalesce_fresh; then _coalesce_replay; fi
    if mkdir "$_c_lockdir" 2>/dev/null; then
      # Re-check: a fresh result may have appeared between the freshness
      # check just above and winning the lock (e.g. the prior leader finished
      # and removed its lock in that exact gap). Defer to it instead of
      # redundantly re-running.
      if _coalesce_fresh; then
        rmdir "$_c_lockdir" 2>/dev/null || true
        _coalesce_replay
      fi
      _do_cache_write=1
      trap 'rm -rf "$_c_lockdir" 2>/dev/null' EXIT
      break
    fi
    # Reclaim an ABANDONED lock. Unlike the flock slots above, a plain mkdir
    # lock has no kernel-level auto-release — a leader that's SIGKILL'd (never
    # trappable) leaves it stuck forever otherwise, taxing every future
    # identical call with a full wait before it gives up. A lock older than
    # the coalescing window is presumed dead; reclaim and retry immediately.
    if [ -d "$_c_lockdir" ]; then
      _lock_mt=$(stat -c %Y "$_c_lockdir" 2>/dev/null || echo 0)
      if [ $(( $(date +%s) - _lock_mt )) -gt "$_coalesce_ttl" ]; then
        rmdir "$_c_lockdir" 2>/dev/null || true
        continue
      fi
    fi
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
  if { exec {_fd}>"$_dir/slot.$_i"; } 2>/dev/null; then
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
  _fallback_deadline=$(( $(date +%s) + _timeout ))
  while :; do
    # Re-resolve each sweep so a waiter's admitted count tracks the box: load
    # dropping widens the probe set mid-wait, rising load narrows it back
    # toward the floor (held slots are never revoked). This also re-checks the
    # release-gate clamp, so a gate run STARTING mid-wait narrows the set and
    # one FINISHING re-widens it — a waiter that queued before the gate began
    # must not walk into the run it is about to starve. Unlike load adaptation
    # this applies to a FIXED PC_HEAVY_SLOTS too (see _effective_slots).
    _slots="$(_effective_slots)"
    for _i in $(seq 0 $(( _slots - 1 ))); do
      if { exec {_fd}>"$_dir/slot.$_i"; } 2>/dev/null; then
        if flock -n "$_fd"; then _held=1; break 2; fi
        eval "exec ${_fd}>&-" 2>/dev/null || true   # not ours — close it
      fi
    done
    [ "$(date +%s)" -ge "$_fallback_deadline" ] && break
    sleep 0.5
  done
fi

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

# Run holding the slot; the flock releases when this shell exits (normal, error,
# or signal). We intentionally do NOT `exec` so the fd/lock stays with us.
if [ "$_do_cache_write" = 1 ]; then
  # Leader path: tee combined streams to the coalescing cache while keeping
  # stdout/stderr genuinely separate for OUR OWN caller (process substitution
  # runs the command in the foreground — $? below is the real command's exit
  # status, not tee's).
  "${_runner[@]}" "$@" > >(tee "$_c_out") 2> >(tee "$_c_err" >&2)
  _rc=$?
  wait 2>/dev/null || true   # let both tee subshells flush before we publish the result
  echo "$_rc" > "$_c_exit" 2>/dev/null
  rm -rf "$_c_lockdir" 2>/dev/null
  trap - EXIT
  exit "$_rc"
fi

"${_runner[@]}" "$@"
exit $?
