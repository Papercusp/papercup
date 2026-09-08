#!/usr/bin/env bash
# papercusp-script-snapshot.sh — run a shell script from an immutable
# per-invocation snapshot.
#
# systemd units in this repository execute scripts from the shared staging tree.
# Bash reads those scripts lazily, so an edit that lands while a long-running
# invocation is in progress can move the next byte offset and turn a valid
# program into a different program.  This launcher snapshots the entry script
# and every nested *.sh argument before starting work.
#
# The launcher snapshots itself first.  That keeps the short-lived dispatcher
# stable too, and makes this helper safe to edit while a service is starting.
set -uo pipefail

hash_file() {
  local path="${1:-}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$path" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$path" | awk '{print $1}'
    return
  fi
  return 69
}

snapshot_file() {
  local source="${1:-}" destination="${2:-}" label="${3:-script}"
  local before after copied attempt

  for attempt in 1 2 3 4 5; do
    before="$(hash_file "$source")" || {
      echo "[script-snapshot] cannot hash $label before copy: $source" >&2
      return 69
    }
    rm -f -- "$destination" 2>/dev/null || true
    cp -p -- "$source" "$destination" || {
      echo "[script-snapshot] cannot copy $label: $source" >&2
      return 73
    }
    after="$(hash_file "$source")" || {
      echo "[script-snapshot] cannot hash $label after copy: $source" >&2
      return 69
    }
    copied="$(hash_file "$destination")" || {
      echo "[script-snapshot] cannot hash copied $label: $destination" >&2
      return 69
    }
    if [[ "$before" == "$after" && "$before" == "$copied" ]]; then
      return 0
    fi
  done

  echo "[script-snapshot] source changed while copying $label: $source" >&2
  return 75
}

new_temp_dir() {
  mktemp -d "${TMPDIR:-/tmp}/papercusp-script-snapshot.XXXXXX" 2>/dev/null
}

# Freeze this launcher before it starts looking at the target.  The child keeps
# SELF_DIR in its environment so its EXIT trap can reclaim this directory after
# the target exits.
if [[ -z "${PAPERCUSP_SCRIPT_SNAPSHOT_SELF_COPIED:-}" ]]; then
  self_dir="$(new_temp_dir)" || {
    echo "[script-snapshot] unable to create self-snapshot directory" >&2
    exit 73
  }
  self_copy="$self_dir/papercusp-script-snapshot.sh"
  if snapshot_file "$0" "$self_copy" "launcher"; then
    export PAPERCUSP_SCRIPT_SNAPSHOT_SELF_COPIED=1
    export PAPERCUSP_SCRIPT_SNAPSHOT_SELF_DIR="$self_dir"
    exec bash "$self_copy" "$@"
  fi
  rm -rf -- "$self_dir" 2>/dev/null || true
  exit 75
fi

usage() {
  echo "usage: $0 SCRIPT.sh [ARG ...]" >&2
  exit 64
}

[[ "$#" -ge 1 ]] || usage

snapshot_root="$(new_temp_dir)" || {
  echo "[script-snapshot] unable to create invocation snapshot directory" >&2
  exit 73
}
self_dir="${PAPERCUSP_SCRIPT_SNAPSHOT_SELF_DIR:-}"

cleanup() {
  local status=$?
  trap - EXIT
  rm -rf -- "$snapshot_root" 2>/dev/null || true
  if [[ -n "$self_dir" && "$self_dir" != "$snapshot_root" ]]; then
    rm -rf -- "$self_dir" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

resolve_path() {
  local path="${1:-}" dir base
  dir="$(dirname -- "$path")"
  base="$(basename -- "$path")"
  (
    cd -- "$dir" 2>/dev/null || exit 1
    printf '%s/%s\n' "$PWD" "$base"
  )
}

declare -A snapshots=()
snapshot_index=0

snapshot_script() {
  local source_token="${1:-}" source source_dir base destination_dir destination sidecar
  source="$(resolve_path "$source_token")" || {
    echo "[script-snapshot] cannot resolve script path: $source_token" >&2
    return 64
  }
  [[ -f "$source" ]] || {
    echo "[script-snapshot] script does not exist: $source_token" >&2
    return 64
  }

  if [[ -n "${snapshots["$source"]+present}" ]]; then
    printf '%s\n' "${snapshots["$source"]}"
    return 0
  fi

  source_dir="$(dirname -- "$source")"
  base="$(basename -- "$source")"
  snapshot_index=$((snapshot_index + 1))
  destination_dir="$snapshot_root/script-$snapshot_index"
  mkdir -p -- "$destination_dir" || return 73
  destination="$destination_dir/$base"

  snapshot_file "$source" "$destination" "target $base" || return $?

  # Health checks source lib/red-marker.sh through BASH_SOURCE.  Preserve
  # adjacent shell sidecars under the same relative lib/ path in the snapshot.
  if [[ -d "$source_dir/lib" ]]; then
    mkdir -p -- "$destination_dir/lib" || return 73
    while IFS= read -r -d '' sidecar; do
      snapshot_file \
        "$sidecar" \
        "$destination_dir/lib/$(basename -- "$sidecar")" \
        "sidecar $(basename -- "$sidecar")" || return $?
    done < <(find "$source_dir/lib" -maxdepth 1 -type f -name '*.sh' -print0 2>/dev/null)
  fi

  snapshots["$source"]="$destination"
  printf '%s\n' "$destination"
}

argv=("$1" "${@:2}")
for index in "${!argv[@]}"; do
  case "${argv[$index]}" in
    *.sh)
      if [[ -f "${argv[$index]}" ]]; then
        argv[$index]="$(snapshot_script "${argv[$index]}")" || exit $?
      fi
      ;;
  esac
done

# Keep the wrapper process alive until the target exits so the EXIT trap can
# remove the private snapshot tree, while preserving the target's exit status.
set +e
bash "${argv[0]}" "${argv[@]:1}"
status=$?
exit "$status"
