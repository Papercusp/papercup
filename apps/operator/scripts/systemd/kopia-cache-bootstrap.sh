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
