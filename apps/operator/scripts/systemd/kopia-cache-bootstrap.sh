#!/usr/bin/env bash
# Shared cache/log-directory bootstrap for the Kopia systemd scripts.
#
# A managed host may relocate ~/.cache/kopia by symlink. `mkdir -p
# ~/.cache/kopia` returns "File exists" when that symlink is dangling, so the
# callers must create the target rather than trying to replace the link. This
# helper is deliberately source-only: callers decide how a bootstrap failure
# should affect their operation.

# Ensure a cache/log directory exists and is usable without replacing a
# pre-existing symlink. A dangling symlink is repaired by creating its target;
# a symlink to a file, an ordinary file, or an unwritable target is rejected.
ensure_kopia_cache_dir() {
  local cache_dir="${1:-}" target=""

  if [ -z "$cache_dir" ]; then
    echo "Kopia cache directory is empty" >&2
    return 1
  fi

  if [ -L "$cache_dir" ]; then
    target="$(readlink -- "$cache_dir" 2>/dev/null)" || {
      echo "Unable to read Kopia cache symlink: $cache_dir" >&2
      return 1
    }
    if [ -z "$target" ]; then
      echo "Kopia cache symlink has an empty target: $cache_dir" >&2
      return 1
    fi
    if [[ "$target" != /* ]]; then
      target="$(dirname -- "$cache_dir")/$target"
    fi
    if ! mkdir -p -- "$target"; then
      echo "Unable to create Kopia cache symlink target: $target" >&2
      return 1
    fi
  elif [ -e "$cache_dir" ]; then
    if [ ! -d "$cache_dir" ]; then
      echo "Kopia cache path is not a directory: $cache_dir" >&2
      return 1
    fi
  elif ! mkdir -p -- "$cache_dir"; then
    echo "Unable to create Kopia cache directory: $cache_dir" >&2
    return 1
  fi

  if [ ! -d "$cache_dir" ]; then
    echo "Kopia cache path is not a usable directory: $cache_dir" >&2
    return 1
  fi
  if [ ! -w "$cache_dir" ]; then
    echo "Kopia cache directory is not writable: $cache_dir" >&2
    return 1
  fi
}

# ── STOP KOPIA WITHOUT DISCARDING WHAT IT FINISHED (EI-25211496463956189) ─────
# This lives here because it is the one helper every Kopia entrypoint already
# sources and that is already linked into ~/.config/kopia; a new file would add
# an install step whose absence stops backups outright.
#
# Kopia commits a finished source's snapshot only when it FLUSHES: when the
# process exits, or at a 45-minute checkpoint. On SIGTERM it saves the source in
# progress as a partial snapshot, flushes everything, and exits 0. SIGKILL
# discards every snapshot since the last flush. Measured 2026-10-06 on a
# throwaway repo (two sources, signal sent 2s after the first finished): SIGTERM
# gave rc 0 after 5.7s with the first source committed; a second SIGTERM 0.3s
# later changed nothing; SIGKILL gave rc 137 after 27ms and `snapshot list` was
# EMPTY. The cleanups used to SIGKILL at once, so every stopped hot sweep threw
# away the sources it had finished: the 14:52 EDT sweep that day lost its
# /mnt/backup/db-dumps snapshot (Kopia had printed "Created snapshot" for it).
#
# kopia_stop_flushing PID GRACE_SEC — SIGTERM the exact Kopia PID, wait up to
# GRACE_SEC for it to exit, then SIGKILL. The caller must have validated PID with
# its kopia_pid_matches, and must define SUDO_BIN, KILL_BIN and PROC_ROOT.
# Returns 0 when Kopia exited after SIGTERM (its snapshots are flushed), 2 when
# it had to be SIGKILLed, and 1 when even SIGKILL failed. Prints nothing; the
# caller logs. GRACE_SEC must stay below the guard's KOPIA_BACKUP_STOP_GRACE_SEC
# (default 20), which SIGKILLs the calling script if its cleanup outlives that.
kopia_stop_flushing() {
  local pid="$1" grace="${2:-15}" ticks=0 max_ticks=0
  [[ "$grace" =~ ^[0-9]+$ ]] || grace=15
  "$SUDO_BIN" -n -- "$KILL_BIN" -TERM "$pid" >/dev/null 2>&1 || true
  max_ticks=$((grace * 5))
  while [ -d "$PROC_ROOT/$pid" ] && [ "$ticks" -lt "$max_ticks" ]; do
    sleep 0.2
    ticks=$((ticks + 1))
  done
  # A zombie keeps its /proc dir but no readable exe, so it fails the match: gone.
  kopia_pid_matches "$pid" || return 0
  "$SUDO_BIN" -n -- "$KILL_BIN" -KILL "$pid" >/dev/null 2>&1 || return 1
  return 2
}
