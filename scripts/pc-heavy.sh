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
#   PC_HEAVY_SLOTS        concurrent heavy runs allowed. Default max(2, cores/32)
#                         — 32 mirrors affected-tests.mjs's per-suite worker cap,
#                         so full occupancy is ~cores workers, i.e. ~1x the box.
#   PC_HEAVY_TIMEOUT_SEC  max seconds to WAIT for a slot before running anyway
#                         (default 900). Running-anyway (never blocking forever)
#                         keeps a wedged holder from deadlocking the fleet; the
#                         kernel also frees a slot the instant its holder dies.
#   PC_HEAVY_DIR          slot-file dir (default ${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots)
#   PC_HEAVY_NICE         nice increment (default 10)
#   PC_HEAVY_IONICE       ionice spec: "best-effort N" | "idle" | "" to skip
#                         (default "best-effort 7"; UNSET uses the default,
#                         set-but-EMPTY skips ionice)
#
# Crash-safe: the slot is an flock held on an open fd for the child's whole
# lifetime; the kernel releases it when this process exits for ANY reason
# (including SIGKILL), so a crashed run never leaks a slot. No daemon, no DB.
#
# Fail-open: if the slot dir can't be made or no slot machinery is available,
# the command still runs (unthrottled) — admission control must never be the
# reason a legitimate build can't start.

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

_cores="$(nproc 2>/dev/null || echo 8)"
_slots="${PC_HEAVY_SLOTS:-}"
if [ -z "$_slots" ]; then
  _slots=$(( _cores / 32 ))
  [ "$_slots" -lt 2 ] && _slots=2
fi
_dir="${PC_HEAVY_DIR:-${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots}"
_timeout="${PC_HEAVY_TIMEOUT_SEC:-900}"

# Can't create the slot dir or flock is missing → fail-open (run unthrottled).
if ! mkdir -p "$_dir" 2>/dev/null || ! command -v flock >/dev/null 2>&1; then
  export PC_HEAVY_BYPASS=1
  exec "$@"
fi

# Try each slot non-blocking; hold the first free one open on its own fd.
_held=""
for _i in $(seq 0 $(( _slots - 1 ))); do
  if exec {_fd}>"$_dir/slot.$_i" 2>/dev/null; then
    if flock -n "$_fd"; then _held=1; break; fi
    eval "exec ${_fd}>&-" 2>/dev/null || true   # not ours — close it
  fi
done

# All slots busy → block on slot 0 with a timeout; run anyway if it elapses so a
# stuck holder can't wedge the fleet (its slot frees on death regardless).
if [ -z "$_held" ]; then
  if exec {_fd}>"$_dir/slot.0" 2>/dev/null && flock -w "$_timeout" "$_fd"; then
    _held=1
  fi
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
"${_runner[@]}" "$@"
exit $?
