#!/usr/bin/env bash
# Immutable dependency generations for release/checkpoint setup (P-006 / WI-41117).
#
# `npm-install-safe.mjs` publishes a generation after a verified install, and
# `setup-release-checkout.sh` can also publish one on demand. A generation is a
# complete, versioned snapshot of every product-owned node_modules tree. It is
# built beside the final generation, checked against the live source before and
# after the copy, and made visible with one same-filesystem rename. Checkpoints
# then pin that identity instead of traversing a mutable live install.
#
# This file is both a sourceable library and a small standalone publisher:
#   dependency-generation.sh --integration <repo> [--generation-root <dir>]

dependency_generation_log() {
  printf '[dependency-generation] %s\n' "$*" >&2
}

dependency_generation_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{ print $1 }'
  else
    dependency_generation_log 'FATAL: neither sha256sum nor shasum is available'
    return 1
  fi
}

dependency_generation_host() {
  hostname 2>/dev/null || uname -n 2>/dev/null || printf 'unknown-host\n'
}

dependency_generation_device() {
  local path="$1" parent
  while [ ! -e "$path" ]; do
    parent="$(dirname "$path")"
    [ "$parent" = "$path" ] && break
    path="$parent"
  done
  stat -c '%d' "$path" 2>/dev/null || stat -f '%d' "$path"
}

# Product dependency trees only. Coordination worktrees and Git metadata are
# runtime infrastructure, never dependency-generation inputs.
dependency_generation_enumerate_node_modules() {
  local root="$1"
  find "$root" \
    \( -type d \( -name .papercusp -o -name .git \) -prune \) -o \
    \( -type d -name node_modules -prune -print \)
}

# Metadata identity deliberately avoids reading ~13 GiB of file contents. The
# aggregate is sampled before and after publication, so a concurrent install or
# test mutation cannot authorize a mixed generation.
dependency_generation_tree_fingerprint() {
  local root="$1" local_path stat_record link_target
  [ -d "$root" ] || return 1
  (
    cd "$root" || exit 1
    if [ "${DEPENDENCY_GENERATION_FORCE_PORTABLE_STAT:-0}" != '1' ] \
      && find . -xdev -mindepth 1 -maxdepth 1 -printf '' >/dev/null 2>&1; then
      LC_ALL=C find . -xdev -mindepth 1 \
        \( -type d \( -name .vite -o -name .vite-temp \) -prune \) -o \
        \( ! -path './.papercusp-isolated-snapshot' \
        ! -path './.papercusp-dependency-generation' \
        ! -path './.package-lock.json' \
        -printf '%P\0%y\0%m\0%u\0%g\0%s\0%T@\0%i\0%l\0' \) \
        | dependency_generation_sha256
    else
      # BSD/macOS find has no -printf. Keep the same identity classes with a
      # portable stat record per path. It is slower, but correctness-preserving.
      LC_ALL=C find . -xdev -mindepth 1 \
        \( -type d \( -name .vite -o -name .vite-temp \) -prune \) -o \
        \( ! -path './.papercusp-isolated-snapshot' \
        ! -path './.papercusp-dependency-generation' \
        ! -path './.package-lock.json' -print0 \) \
        | while IFS= read -r -d '' path; do
            local_path="${path#./}"
            if stat_record="$(stat -c '%F|%a|%U|%G|%s|%Y|%i' "$path" 2>/dev/null)"; then
              :
            else
              stat_record="$(stat -f '%HT|%Lp|%Su|%Sg|%z|%m|%i' "$path")" || exit 1
            fi
            link_target=''
            [ -L "$path" ] && link_target="$(readlink "$path")"
            printf '%s\0%s\0%s\0' "$local_path" "$stat_record" "$link_target"
          done \
        | dependency_generation_sha256
    fi
  )
}

dependency_generation_set_manifest() {
  local root="$1" nm rel fingerprint
  (
    while IFS= read -r nm; do
      rel="${nm#"$root"/}"
      fingerprint="$(dependency_generation_tree_fingerprint "$nm")" || exit 1
      printf '%s\t%s\n' "$rel" "$fingerprint"
    done < <(dependency_generation_enumerate_node_modules "$root")
  ) | LC_ALL=C sort
}

dependency_generation_manifest_fingerprint() {
  local manifest="$1"
  dependency_generation_sha256 < "$manifest"
}

dependency_generation_set_fingerprint() {
  local root="$1"
  dependency_generation_set_manifest "$root" | dependency_generation_sha256
}

dependency_generation_log_manifest_delta() {
  local before="$1" after="$2"
  awk -F '\t' '
    NR == FNR { old[$1] = $2; next }
    {
      seen[$1] = 1
      if (!($1 in old)) {
        if (shown++ < 20) print "[dependency-generation] changed input: " $1 " (added)" > "/dev/stderr"
      } else if (old[$1] != $2) {
        if (shown++ < 20) print "[dependency-generation] changed input: " $1 " (metadata fingerprint changed)" > "/dev/stderr"
      }
    }
    END {
      for (path in old) {
        if (!(path in seen) && shown++ < 20)
          print "[dependency-generation] changed input: " path " (removed)" > "/dev/stderr"
      }
    }
  ' "$before" "$after"
}

dependency_generation_read_field() {
  local file="$1" key="$2"
  sed -n "s/^${key}=//p" "$file" | head -1
}

dependency_generation_is_valid() {
  local generation="$1" expected_identity="${2:-}"
  local marker="$generation/.papercusp-dependency-generation"
  local identity expected_snapshot actual_snapshot
  [ -d "$generation/tree" ] && [ -f "$marker" ] || return 1
  identity="$(dependency_generation_read_field "$marker" identity)"
  [ -n "$identity" ] || return 1
  [ -z "$expected_identity" ] || [ "$identity" = "$expected_identity" ] || return 1
  expected_snapshot="$(dependency_generation_read_field "$marker" snapshot)"
  [ -n "$expected_snapshot" ] || return 1
  actual_snapshot="$(dependency_generation_set_fingerprint "$generation/tree" 2>/dev/null || true)"
  [ -n "$actual_snapshot" ] && [ "$actual_snapshot" = "$expected_snapshot" ]
}

dependency_generation_marker_matches() {
  local generation="$1" expected_identity="$2"
  local marker="$generation/.papercusp-dependency-generation"
  [ -d "$generation/tree" ] && [ -f "$marker" ] || return 1
  [ "$(dependency_generation_read_field "$marker" identity)" = "$expected_identity" ] \
    && [ -n "$(dependency_generation_read_field "$marker" snapshot)" ]
}

# Open one already-published immutable generation by its exact identity without
# consulting the mutable live node_modules tree. Checkpoint setup selects the
# identity before it waits for exclusive materialization capacity, then calls
# this helper after the wait; re-deriving an identity at that later point would
# silently move the input if an install landed in between (P-006 / WI-41199).
# Sets the same DEPENDENCY_GENERATION_* outputs as dependency_generation_ensure.
dependency_generation_select() {
  local generation_root="$1" identity="$2"
  local generation marker source
  if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
    dependency_generation_log "FATAL: invalid dependency-generation identity: $identity"
    return 2
  fi
  generation="$generation_root/$identity"
  if ! dependency_generation_is_valid "$generation" "$identity"; then
    dependency_generation_log "FATAL: dependency generation $identity is missing or invalid"
    return 74
  fi
  marker="$generation/.papercusp-dependency-generation"
  source="$(dependency_generation_read_field "$marker" source)"
  if [ -z "$source" ]; then
    dependency_generation_log "FATAL: dependency generation $identity has no source fingerprint"
    return 74
  fi
  DEPENDENCY_GENERATION_ID="$identity"
  DEPENDENCY_GENERATION_PATH="$generation"
  DEPENDENCY_GENERATION_TREE="$generation/tree"
  DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source"
  DEPENDENCY_GENERATION_REUSED='true'
}

dependency_generation_writer_is_live() {
  local marker="$1" expected_host="$2" owner_host owner_pid
  [ -f "$marker" ] || return 1
  owner_host="$(dependency_generation_read_field "$marker" host)"
  owner_pid="$(dependency_generation_read_field "$marker" pid)"
  [ "$owner_host" = "$expected_host" ] || return 0
  case "$owner_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$owner_pid" 2>/dev/null
}

dependency_generation_path_is_old() {
  local path="$1" min_age="${2:-300}" mtime now
  mtime="$(stat -c '%Y' "$path" 2>/dev/null || stat -f '%m' "$path" 2>/dev/null || true)"
  case "$mtime" in
    ''|*[!0-9]*) return 1 ;;
  esac
  now="$(date +%s)"
  [ $((now - mtime)) -ge "$min_age" ]
}

# A killed publisher may leave a large writable build tree or the tiny publish
# lock behind. Reclaim only same-host state whose recorded PID is no longer
# alive; foreign-host state remains fail-closed. Quarantine a stale lock so its
# ownership record survives inspection.
dependency_generation_cleanup_abandoned() {
  local generation_root="$1" host build marker lock quarantine
  host="$(dependency_generation_host)"
  for build in "$generation_root"/.build-*; do
    [ -d "$build" ] || continue
    marker="$build/.papercusp-generation-writer"
    if { [ -f "$marker" ] && ! dependency_generation_writer_is_live "$marker" "$host"; } \
      || { [ ! -f "$marker" ] && dependency_generation_path_is_old "$build"; }; then
      dependency_generation_log "removing abandoned build $(basename "$build")"
      chmod -R u+w "$build" 2>/dev/null || true
      rm -rf -- "$build"
    fi
  done

  lock="$generation_root/.publish-lock"
  if [ -d "$lock" ] \
    && { { [ -f "$lock/writer" ] && ! dependency_generation_writer_is_live "$lock/writer" "$host"; } \
      || { [ ! -f "$lock/writer" ] && dependency_generation_path_is_old "$lock"; }; }; then
    quarantine="$generation_root/.stale-publish-lock.$(date +%s).$$"
    if mv "$lock" "$quarantine" 2>/dev/null; then
      dependency_generation_log "quarantined abandoned publish lock as $(basename "$quarantine")"
    fi
  fi
}

dependency_generation_write_owner() {
  local marker="$1"
  printf 'host=%s\npid=%s\nstarted=%s\n' \
    "$(dependency_generation_host)" "$$" "$(date +%s)" > "$marker"
}

dependency_generation_acquire_publish_lock() {
  local generation_root="$1" lock attempts=0
  lock="$generation_root/.publish-lock"
  while ! mkdir "$lock" 2>/dev/null; do
    dependency_generation_cleanup_abandoned "$generation_root"
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 300 ]; then
      dependency_generation_log 'FATAL: timed out waiting for the short dependency-generation publish lock'
      return 73
    fi
    sleep 0.1
  done
  dependency_generation_write_owner "$lock/writer"
  DEPENDENCY_GENERATION_PUBLISH_LOCK="$lock"
}

dependency_generation_release_publish_lock() {
  local lock="${DEPENDENCY_GENERATION_PUBLISH_LOCK:-}"
  [ -n "$lock" ] || return 0
  rm -f -- "$lock/writer"
  rmdir "$lock" 2>/dev/null || true
  DEPENDENCY_GENERATION_PUBLISH_LOCK=''
}

dependency_generation_copy_independent() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  # GNU cp uses a CoW clone where available and a regular independent copy
  # otherwise. BSD/BusyBox cp reject --reflink; retry with portable `cp -a`.
  if cp -a --reflink=auto "$src" "$dest" 2>/dev/null; then
    return 0
  fi
  rm -rf -- "$dest"
  cp -a "$src" "$dest"
}

dependency_generation_prune_ephemeral() {
  local root="$1"
  [ -d "$root" ] || return 0
  # npm rewrites node_modules/.package-lock.json during install bookkeeping. It
  # is internal metadata, not a runtime dependency, and older hardlink-based
  # release trees can share its inode with the integration tree. Vitest likewise
  # mutates .vite/.vite-temp cache state. None belong in an immutable generation:
  # retaining or fingerprinting them can false-fail rc75 on unrelated churn.
  rm -f -- "$root/.package-lock.json"
  find "$root" -type d \( -name .vite -o -name .vite-temp \) -exec rm -rf -- {} +
}

# Materialize from an immutable generation. Same-filesystem hardlinks are safe
# because generation files have no write bits; directories are distinct, so a
# checkpoint may prune/add directory entries without changing the generation.
# Cross-filesystem and explicitly forced paths fall back to an independent copy.
dependency_generation_materialize_tree() {
  local src="$1" dest="$2" tmp old
  local source_device dest_device mode='copy'
  tmp="${dest}.generation-tmp.$$"
  old="${dest}.generation-old.$$"
  rm -rf -- "$tmp" "$old"
  mkdir -p "$(dirname "$dest")"
  source_device="$(dependency_generation_device "$src")" || return 1
  dest_device="$(dependency_generation_device "$(dirname "$dest")")" || return 1
  if [ "${DEPENDENCY_GENERATION_FORCE_COPY:-0}" != '1' ] && [ "$source_device" = "$dest_device" ]; then
    if cp -al "$src" "$tmp" 2>/dev/null; then
      mode='hardlink'
    else
      rm -rf -- "$tmp"
    fi
  fi
  if [ ! -d "$tmp" ]; then
    dependency_generation_copy_independent "$src" "$tmp"
  fi
  if [ -e "$dest" ]; then
    mv "$dest" "$old"
    mv "$tmp" "$dest"
    chmod -R u+w "$old" 2>/dev/null || true
    rm -rf -- "$old"
  else
    mv "$tmp" "$dest"
  fi
  DEPENDENCY_GENERATION_MATERIALIZE_MODE="$mode"
}

dependency_generation_remove_build() {
  local build="$1"
  [ -e "$build" ] || return 0
  chmod -R u+w "$build" 2>/dev/null || true
  rm -rf -- "$build"
}

# Sets DEPENDENCY_GENERATION_{ID,PATH,TREE,SOURCE_FINGERPRINT,REUSED}.
dependency_generation_ensure() {
  local integration_root="$1"
  local generation_root="${2:-$integration_root/.papercusp/dependency-generations}"
  local source_before source_after identity generation build tree nm rel snapshot marker
  local quarantine before_manifest after_manifest
  mkdir -p "$generation_root"
  dependency_generation_cleanup_abandoned "$generation_root"

  build="$generation_root/.build-pending-$(dependency_generation_host)-$$-$(date +%s)"
  tree="$build/tree"
  before_manifest="$build/.source-before"
  after_manifest="$build/.source-after"
  mkdir -p "$tree"
  dependency_generation_write_owner "$build/.papercusp-generation-writer"
  dependency_generation_set_manifest "$integration_root" > "$before_manifest" || {
    dependency_generation_remove_build "$build"
    return 1
  }
  source_before="$(dependency_generation_manifest_fingerprint "$before_manifest")" || {
    dependency_generation_remove_build "$build"
    return 1
  }
  identity="v1-$source_before"
  generation="$generation_root/$identity"
  if dependency_generation_is_valid "$generation" "$identity"; then
    dependency_generation_set_manifest "$integration_root" > "$after_manifest" || {
      dependency_generation_remove_build "$build"
      return 1
    }
    source_after="$(dependency_generation_manifest_fingerprint "$after_manifest")" || {
      dependency_generation_remove_build "$build"
      return 1
    }
    if [ "$source_after" != "$source_before" ]; then
      dependency_generation_log_manifest_delta "$before_manifest" "$after_manifest"
      dependency_generation_remove_build "$build"
      dependency_generation_log 'FATAL: live node_modules changed while pinning an existing generation'
      return 75
    fi
    dependency_generation_remove_build "$build"
    DEPENDENCY_GENERATION_ID="$identity"
    DEPENDENCY_GENERATION_PATH="$generation"
    DEPENDENCY_GENERATION_TREE="$generation/tree"
    DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source_before"
    DEPENDENCY_GENERATION_REUSED='true'
    return 0
  fi

  dependency_generation_log "building $identity from a stable live dependency snapshot"
  while IFS= read -r nm; do
    rel="${nm#"$integration_root"/}"
    if ! dependency_generation_copy_independent "$nm" "$tree/$rel"; then
      dependency_generation_remove_build "$build"
      return 1
    fi
    dependency_generation_prune_ephemeral "$tree/$rel"
  done < <(dependency_generation_enumerate_node_modules "$integration_root")

  if [ -n "${DEPENDENCY_GENERATION_AFTER_COPY_HOOK:-}" ]; then
    bash -c "$DEPENDENCY_GENERATION_AFTER_COPY_HOOK"
  fi
  dependency_generation_set_manifest "$integration_root" > "$after_manifest" 2>/dev/null || true
  source_after="$(dependency_generation_manifest_fingerprint "$after_manifest" 2>/dev/null || true)"
  if [ -z "$source_after" ] || [ "$source_after" != "$source_before" ]; then
    dependency_generation_log_manifest_delta "$before_manifest" "$after_manifest"
    dependency_generation_log 'FATAL: live node_modules changed during generation build; refusing a torn snapshot'
    dependency_generation_remove_build "$build"
    return 75
  fi
  # Freeze file contents before recording the snapshot identity because mode is
  # part of the metadata fingerprint. Recording first would make every freshly
  # published generation invalidate itself on its next read.
  find "$tree" -type f -exec chmod a-w {} +
  snapshot="$(dependency_generation_set_fingerprint "$tree")" || {
    dependency_generation_remove_build "$build"
    return 1
  }
  marker="$build/.papercusp-dependency-generation"
  printf 'schema=1\nidentity=%s\nsource=%s\nsnapshot=%s\ncreated=%s\n' \
    "$identity" "$source_after" "$snapshot" "$(date +%s)" > "$marker"

  dependency_generation_acquire_publish_lock "$generation_root" || {
    dependency_generation_remove_build "$build"
    return $?
  }
  # Keep the build-owner marker until the short publish lock is held; otherwise
  # a concurrent cleanup can mistake this complete-but-not-yet-published tree
  # for an abandoned build. A generation may have appeared since our initial
  # validation, but its marker alone is not proof that the published tree is
  # still valid. A stale/corrupt tree can retain the expected identity and
  # snapshot fields; accepting that marker would discard this fully-validated
  # replacement and leave exact-id consumers pinned to the corrupt tree.
  # Re-validate the competing generation under the publish lock so that the
  # decision and any quarantine/replacement remain one serialized operation.
  # The expensive branch is limited to a same-identity race or repair.
  rm -f -- "$build/.papercusp-generation-writer"
  if dependency_generation_is_valid "$generation" "$identity"; then
    dependency_generation_remove_build "$build"
    DEPENDENCY_GENERATION_REUSED='true'
  else
    if [ -e "$generation" ]; then
      quarantine="$generation_root/.invalid-$identity-$(date +%s).$$"
      mv "$generation" "$quarantine"
      dependency_generation_log "quarantined invalid generation as $(basename "$quarantine")"
    fi
    mv "$build" "$generation"
    DEPENDENCY_GENERATION_REUSED='false'
  fi
  dependency_generation_release_publish_lock

  DEPENDENCY_GENERATION_ID="$identity"
  DEPENDENCY_GENERATION_PATH="$generation"
  DEPENDENCY_GENERATION_TREE="$generation/tree"
  DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source_after"
}

dependency_generation_main() {
  local integration_root='' generation_root=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --integration) integration_root="$2"; shift 2 ;;
      --generation-root) generation_root="$2"; shift 2 ;;
      *) dependency_generation_log "unknown arg: $1"; return 2 ;;
    esac
  done
  [ -n "$integration_root" ] || {
    dependency_generation_log '--integration is required'
    return 2
  }
  integration_root="$(cd "$integration_root" && pwd -P)"
  generation_root="${generation_root:-$integration_root/.papercusp/dependency-generations}"
  dependency_generation_ensure "$integration_root" "$generation_root" || return $?
  printf 'DEPENDENCY_GENERATION_RESULT schema=1 identity=%s source=%s reused=%s path=%s\n' \
    "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
    "$DEPENDENCY_GENERATION_REUSED" "$DEPENDENCY_GENERATION_PATH"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  dependency_generation_main "$@"
fi
