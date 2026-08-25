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

# Empty means the historical full-product generation. A selected generation is
# configured by repeated --workspace-dir arguments and always retains the root
# node_modules tree in addition to these package-local trees.
DEPENDENCY_GENERATION_WORKSPACE_DIRS=()
DEPENDENCY_GENERATION_SCOPE_MODE='full'
DEPENDENCY_GENERATION_SCOPE_RECORD=''
DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT=''

dependency_generation_configure_workspace_dirs() {
  local root="$1" raw resolved
  shift
  DEPENDENCY_GENERATION_WORKSPACE_DIRS=()
  if [ "$#" -eq 0 ]; then
    DEPENDENCY_GENERATION_SCOPE_MODE='full'
    DEPENDENCY_GENERATION_SCOPE_RECORD='scope=full'
  else
    DEPENDENCY_GENERATION_SCOPE_MODE='selected'
    DEPENDENCY_GENERATION_SCOPE_RECORD='scope=selected'
    while IFS= read -r raw; do
      case "$raw" in
        ''|.|/*|./*|../*|*/../*|*/..|*//*|*/|*\\*|*$'\n'*|*$'\r'*|*$'\t'*)
          dependency_generation_log "FATAL: invalid repo-relative --workspace-dir: $raw"
          return 2
          ;;
      esac
      resolved="$(cd "$root/$raw" 2>/dev/null && pwd -P)" || {
        dependency_generation_log "FATAL: --workspace-dir does not exist: $raw"
        return 2
      }
      case "$resolved" in
        "$root"/*) ;;
        *)
          dependency_generation_log "FATAL: --workspace-dir escapes the integration root: $raw"
          return 2
          ;;
      esac
      [ -f "$resolved/package.json" ] || {
        dependency_generation_log "FATAL: --workspace-dir has no package.json: $raw"
        return 2
      }
      DEPENDENCY_GENERATION_WORKSPACE_DIRS+=("$raw")
      DEPENDENCY_GENERATION_SCOPE_RECORD+=$'\n'"workspace_dir=$raw"
    done < <(printf '%s\n' "$@" | LC_ALL=C sort -u)
  fi
  DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT="$(
    printf '%s\n' "$DEPENDENCY_GENERATION_SCOPE_RECORD" | dependency_generation_sha256
  )" || return 1
}

# Product dependency trees only. Coordination worktrees and Git metadata are
# runtime infrastructure, never dependency-generation inputs.
dependency_generation_enumerate_node_modules() {
  local root="$1" dir
  if [ "${DEPENDENCY_GENERATION_SCOPE_MODE:-full}" = 'selected' ]; then
    [ -d "$root/node_modules" ] && printf '%s\n' "$root/node_modules"
    for dir in "${DEPENDENCY_GENERATION_WORKSPACE_DIRS[@]}"; do
      [ -d "$root/$dir/node_modules" ] && printf '%s\n' "$root/$dir/node_modules"
    done
    return 0
  fi
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

dependency_generation_emit_tree_record() {
  local root="$1" nm="$2" rel fingerprint
  rel="${nm#"$root"/}"
  fingerprint="$(dependency_generation_tree_fingerprint "$nm")" || return 1
  # One short record per tree. Kept to a single write so that parallel walkers
  # cannot interleave a partial line on the shared pipe (a record is far below
  # PIPE_BUF, for which POSIX guarantees an atomic write).
  printf '%s\t%s\n' "$rel" "$fingerprint"
}

# Degree of parallelism for the manifest walk. Override with
# DEPENDENCY_GENERATION_WALK_JOBS; 1 forces the serial walk.
dependency_generation_walk_jobs() {
  local jobs="${DEPENDENCY_GENERATION_WALK_JOBS:-}" cores
  if [ -z "$jobs" ]; then
    cores="$(nproc 2>/dev/null || printf '4')"
    case "$cores" in '' | *[!0-9]*) cores=4 ;; esac
    jobs="$cores"
    # The walk is dentry/metadata bound, not CPU bound, so more workers than
    # this buys nothing and only adds contention on a loaded box.
    [ "$jobs" -gt 16 ] && jobs=16
  fi
  case "$jobs" in '' | *[!0-9]*) jobs=1 ;; esac
  [ "$jobs" -lt 1 ] && jobs=1
  printf '%s\n' "$jobs"
}

# Fail open to the serial walk on any xargs that lacks -0/-P/-I (BSD/macOS).
dependency_generation_walk_supports_parallel() {
  printf '' | xargs -0 -r -P 2 -I '{}' true >/dev/null 2>&1
}

dependency_generation_set_manifest_serial() {
  local root="$1" nm
  (
    while IFS= read -r nm; do
      dependency_generation_emit_tree_record "$root" "$nm" || exit 1
    done < <(dependency_generation_enumerate_node_modules "$root")
  ) | LC_ALL=C sort
}

# Each tree's fingerprint is computed independently and the manifest is globally
# sorted below, so emission ORDER carries no meaning and this walk parallelises
# without changing a single output byte. Identity classes, prune rules and the
# metadata-only guarantee are untouched — only the scheduling changes.
#
# Why it matters: one serial walk over this repo's ~94 node_modules trees
# measured 287s under real fleet load, and dependency_generation_ensure performs
# three of them (~861s) against green-checkpoint's 900s materialisation budget,
# so the walk alone could consume the entire budget before a byte was copied
# (EI-21322804786723906).
dependency_generation_set_manifest() {
  local root="$1" jobs records status=0
  jobs="$(dependency_generation_walk_jobs)"
  if [ "$jobs" -le 1 ] || ! dependency_generation_walk_supports_parallel; then
    dependency_generation_set_manifest_serial "$root"
    return
  fi
  export -f dependency_generation_emit_tree_record \
    dependency_generation_tree_fingerprint \
    dependency_generation_sha256 \
    dependency_generation_log
  # Collected rather than streamed so that a failed walker fails the manifest
  # with the SAME status the serial walk uses (xargs reports 123), instead of
  # letting a truncated manifest reach the caller as a valid identity. The
  # manifest is one short line per node_modules tree, so this stays small.
  records="$(
    dependency_generation_enumerate_node_modules "$root" \
      | tr '\n' '\0' \
      | DEPENDENCY_GENERATION_WALK_ROOT="$root" xargs -0 -r -P "$jobs" -I '{}' \
        bash -c 'dependency_generation_emit_tree_record "$DEPENDENCY_GENERATION_WALK_ROOT" "$1"' _ '{}'
  )" || status=1
  [ "$status" -eq 0 ] || return 1
  [ -n "$records" ] || return 0
  printf '%s\n' "$records" | LC_ALL=C sort
}

dependency_generation_manifest_fingerprint() {
  local manifest="$1"
  dependency_generation_sha256 < "$manifest"
}

dependency_generation_source_fingerprint() {
  local manifest="$1"
  {
    printf 'closure\t%s\n' "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT"
    cat "$manifest"
  } | dependency_generation_sha256
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
  local generation="$1" expected_identity="${2:-}" expected_closure="${3:-}"
  local marker="$generation/.papercusp-dependency-generation"
  local identity source closure scope expected_snapshot actual_snapshot
  # Test-only tracing proves that the publish-lock fast path does not silently
  # reintroduce the full tree walk. It is deliberately fail-open and has no
  # effect unless a test supplies the opt-in path.
  if [ -n "${DEPENDENCY_GENERATION_VALIDATION_TRACE:-}" ]; then
    printf '%s\n' "$generation" >> "$DEPENDENCY_GENERATION_VALIDATION_TRACE" || true
  fi
  [ -d "$generation/tree" ] && [ -f "$marker" ] || return 1
  identity="$(dependency_generation_read_field "$marker" identity)"
  [ -n "$identity" ] || return 1
  [ -z "$expected_identity" ] || [ "$identity" = "$expected_identity" ] || return 1
  source="$(dependency_generation_read_field "$marker" source)"
  [ -n "$source" ] && [ "$identity" = "v1-$source" ] || return 1
  closure="$(dependency_generation_read_field "$marker" closure)"
  [ -n "$closure" ] || return 1
  [ -z "$expected_closure" ] || [ "$closure" = "$expected_closure" ] || return 1
  scope="$(dependency_generation_read_field "$marker" scope)"
  case "$scope" in full|selected) ;; *) return 1 ;; esac
  expected_snapshot="$(dependency_generation_read_field "$marker" snapshot)"
  [ -n "$expected_snapshot" ] || return 1
  actual_snapshot="$(dependency_generation_set_fingerprint "$generation/tree" 2>/dev/null || true)"
  [ -n "$actual_snapshot" ] && [ "$actual_snapshot" = "$expected_snapshot" ]
}

# Return a cheap identity for a published generation. The generation directory
# is swapped into place atomically and its files are immutable after publish,
# so the directory device/inode plus marker device/inode/mtime is enough to
# prove that the exact incumbent we already validated has not been replaced.
# This avoids a second full snapshot walk while the publish lock is held.
dependency_generation_stat_token() {
  local path="$1"
  if stat -c '%d:%i:%Y:%s' "$path" 2>/dev/null; then
    return 0
  fi
  stat -f '%d:%i:%m:%z' "$path"
}

dependency_generation_generation_token() {
  local generation="$1" marker generation_token marker_token
  [ -d "$generation" ] || return 1
  generation_token="$(dependency_generation_stat_token "$generation")" || return 1
  marker="$generation/.papercusp-dependency-generation"
  if [ -e "$marker" ]; then
    marker_token="$(dependency_generation_stat_token "$marker")" || return 1
  else
    marker_token='missing'
  fi
  printf '%s|%s\n' "$generation_token" "$marker_token"
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

# Exact-ID consumers need protection before the expensive validation walk and
# until their checkout marker has been published. A lease is deliberately
# process-owned: same-host dead readers are reclaimable; a foreign-host reader
# is preserved fail-closed because kill(2) cannot prove its liveness.
dependency_generation_acquire_selector_lease() {
  local generation_root="$1" identity="$2" lease
  if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
    dependency_generation_log "FATAL: invalid dependency-generation lease identity: $identity"
    return 2
  fi
  dependency_generation_acquire_publish_lock "$generation_root" || return $?
  if ! dependency_generation_marker_matches "$generation_root/$identity" "$identity"; then
    dependency_generation_release_publish_lock
    dependency_generation_log "FATAL: dependency generation $identity disappeared before it could be leased"
    return 74
  fi
  mkdir -p "$generation_root/.leases"
  lease="$generation_root/.leases/selector-$$-$(date +%s)-${RANDOM:-0}"
  dependency_generation_write_owner "$lease"
  printf 'identity=%s\n' "$identity" >> "$lease"
  DEPENDENCY_GENERATION_SELECTOR_LEASE="$lease"
  dependency_generation_release_publish_lock
}

dependency_generation_release_selector_lease() {
  local lease="${DEPENDENCY_GENERATION_SELECTOR_LEASE:-}"
  [ -n "$lease" ] || return 0
  rm -f -- "$lease"
  rmdir "$(dirname "$lease")" 2>/dev/null || true
  DEPENDENCY_GENERATION_SELECTOR_LEASE=''
}

dependency_generation_write_pin_locked() {
  local generation_root="$1" checkout="$2" identity="$3"
  local marker pin_key pin tmp
  if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
    return 2
  fi
  checkout="$(cd "$checkout" 2>/dev/null && pwd -P)" || return 1
  case "$checkout" in *$'\n'*) return 2 ;; esac
  marker="$checkout/node_modules/.papercusp-dependency-generation"
  [ -f "$marker" ] || return 1
  [ "$(dependency_generation_read_field "$marker" identity)" = "$identity" ] || return 1
  dependency_generation_marker_matches "$generation_root/$identity" "$identity" || return 1
  mkdir -p "$generation_root/.pins"
  pin_key="$(printf '%s' "$checkout" | dependency_generation_sha256)" || return 1
  pin="$generation_root/.pins/checkout-$pin_key"
  tmp="$pin.tmp.$$"
  printf 'schema=1\nhost=%s\nidentity=%s\ncheckout=%s\nupdated=%s\n' \
    "$(dependency_generation_host)" "$identity" "$checkout" "$(date +%s)" > "$tmp"
  mv "$tmp" "$pin"
}

dependency_generation_register_pin() {
  local generation_root="$1" checkout="$2" identity="$3" rc=0
  dependency_generation_acquire_publish_lock "$generation_root" || return $?
  dependency_generation_write_pin_locked "$generation_root" "$checkout" "$identity" || rc=$?
  dependency_generation_release_publish_lock
  if [ "$rc" -ne 0 ]; then
    dependency_generation_log "FATAL: could not register checkout pin for $identity at $checkout"
  fi
  return "$rc"
}

# Refresh same-host pin/lease truth and import direct sibling checkout markers.
# This runs only while .publish-lock is held, so pruning cannot race a pin that
# is being registered or a selector that is being leased.
dependency_generation_refresh_retention_state_locked() {
  local generation_root="$1" integration_root="$2"
  local host pin pin_host identity checkout marker lease lease_host lease_pid parent sibling
  host="$(dependency_generation_host)"
  mkdir -p "$generation_root/.pins" "$generation_root/.leases"

  for pin in "$generation_root"/.pins/*; do
    [ -f "$pin" ] || continue
    pin_host="$(dependency_generation_read_field "$pin" host)"
    identity="$(dependency_generation_read_field "$pin" identity)"
    checkout="$(dependency_generation_read_field "$pin" checkout)"
    # A foreign-host pin is intentionally retained: this host cannot prove the
    # other checkout disappeared. Same-host state must still match the checkout
    # marker and an extant published generation.
    if [ -n "$pin_host" ] && [ "$pin_host" != "$host" ]; then
      if [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] \
        && dependency_generation_marker_matches "$generation_root/$identity" "$identity"; then
        continue
      fi
      dependency_generation_log "removing malformed foreign checkout pin $(basename "$pin")"
      rm -f -- "$pin"
      continue
    fi
    marker="$checkout/node_modules/.papercusp-dependency-generation"
    if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]] \
      || [ ! -f "$marker" ] \
      || [ "$(dependency_generation_read_field "$marker" identity)" != "$identity" ] \
      || ! dependency_generation_marker_matches "$generation_root/$identity" "$identity"; then
      dependency_generation_log "removing stale checkout pin $(basename "$pin")"
      rm -f -- "$pin"
    fi
  done

  for lease in "$generation_root"/.leases/*; do
    [ -f "$lease" ] || continue
    lease_host="$(dependency_generation_read_field "$lease" host)"
    lease_pid="$(dependency_generation_read_field "$lease" pid)"
    identity="$(dependency_generation_read_field "$lease" identity)"
    if [ -n "$lease_host" ] && [ "$lease_host" != "$host" ] \
      && [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]]; then
      continue
    fi
    if [[ ! "$identity" =~ ^v1-[0-9a-f]{64}$ ]] \
      || [[ ! "$lease_pid" =~ ^[0-9]+$ ]] \
      || ! kill -0 "$lease_pid" 2>/dev/null; then
      dependency_generation_log "removing stale selector lease $(basename "$lease")"
      rm -f -- "$lease"
    fi
  done

  integration_root="$(cd "$integration_root" && pwd -P)" || return 1
  parent="$(dirname "$integration_root")"
  for sibling in "$parent"/*; do
    [ -d "$sibling" ] || continue
    sibling="$(cd "$sibling" 2>/dev/null && pwd -P)" || continue
    [ "$sibling" != "$integration_root" ] || continue
    marker="$sibling/node_modules/.papercusp-dependency-generation"
    [ -f "$marker" ] || continue
    identity="$(dependency_generation_read_field "$marker" identity)"
    [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] || continue
    dependency_generation_marker_matches "$generation_root/$identity" "$identity" || continue
    dependency_generation_write_pin_locked "$generation_root" "$sibling" "$identity" || true
  done
}

DEPENDENCY_GENERATION_PRUNE_QUARANTINES=()

dependency_generation_quarantine_unretained_locked() {
  local generation_root="$1" retain_count="${DEPENDENCY_GENERATION_RETAIN_COUNT:-2}"
  local protected=' ' generation identity created pin lease kept=0 quarantine
  local ranked=()
  if [[ ! "$retain_count" =~ ^[0-9]+$ ]] || [ "$retain_count" -lt 1 ]; then
    dependency_generation_log "FATAL: DEPENDENCY_GENERATION_RETAIN_COUNT must be an integer >= 1"
    return 2
  fi

  mapfile -t ranked < <(
    for generation in "$generation_root"/v1-*; do
      [ -d "$generation" ] || continue
      identity="$(basename "$generation")"
      [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] || continue
      created="$(dependency_generation_read_field "$generation/.papercusp-dependency-generation" created)"
      case "$created" in ''|*[!0-9]*) created=0 ;; esac
      printf '%020d %s\n' "$created" "$identity"
    done | sort -k1,1nr -k2,2r
  )
  for generation in "${ranked[@]}"; do
    identity="${generation#* }"
    if [ "$kept" -lt "$retain_count" ]; then
      protected="$protected$identity "
      kept=$((kept + 1))
    fi
  done
  for pin in "$generation_root"/.pins/*; do
    [ -f "$pin" ] || continue
    identity="$(dependency_generation_read_field "$pin" identity)"
    [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] && protected="$protected$identity "
  done
  for lease in "$generation_root"/.leases/*; do
    [ -f "$lease" ] || continue
    identity="$(dependency_generation_read_field "$lease" identity)"
    [[ "$identity" =~ ^v1-[0-9a-f]{64}$ ]] && protected="$protected$identity "
  done

  DEPENDENCY_GENERATION_PRUNE_QUARANTINES=()
  # A prior process can die after the atomic rename but before deletion. These
  # paths are already outside the exact-ID namespace, so finish that deferred
  # deletion after this lock is released instead of letting crash residue grow.
  for quarantine in "$generation_root"/.prune-*; do
    [ -d "$quarantine" ] || continue
    DEPENDENCY_GENERATION_PRUNE_QUARANTINES+=("$quarantine")
  done
  for generation in "$generation_root"/v1-*; do
    [ -d "$generation" ] || continue
    identity="$(basename "$generation")"
    case "$protected" in *" $identity "*) continue ;; esac
    quarantine="$generation_root/.prune-$identity-$(date +%s)-$$"
    if mv "$generation" "$quarantine"; then
      dependency_generation_log "quarantined unretained generation $identity"
      DEPENDENCY_GENERATION_PRUNE_QUARANTINES+=("$quarantine")
    fi
  done
}

dependency_generation_delete_prune_quarantines() {
  local quarantine
  for quarantine in "${DEPENDENCY_GENERATION_PRUNE_QUARANTINES[@]:-}"; do
    [ -d "$quarantine" ] || continue
    # Checkouts may hardlink generation FILES. Changing their modes here would
    # mutate the retained checkout inode too; directory write permission alone
    # is sufficient for unlinking.
    find "$quarantine" -type d -exec chmod u+rwx {} + 2>/dev/null || true
    rm -rf -- "$quarantine"
  done
  DEPENDENCY_GENERATION_PRUNE_QUARANTINES=()
}

dependency_generation_apply_retention() {
  local generation_root="$1" integration_root="$2" rc=0
  dependency_generation_acquire_publish_lock "$generation_root" || return $?
  dependency_generation_refresh_retention_state_locked "$generation_root" "$integration_root" || rc=$?
  if [ "$rc" -eq 0 ]; then
    dependency_generation_quarantine_unretained_locked "$generation_root" || rc=$?
  fi
  dependency_generation_release_publish_lock
  dependency_generation_delete_prune_quarantines
  return "$rc"
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
    # `cp -al` shares file inodes with the immutable generation, while
    # directories remain distinct. Make only retired directories writable so
    # rm -rf can remove their entries; recursively chmodding files would
    # mutate the published generation before deleting the retired checkout.
    find "$old" -type d -exec chmod u+rwx {} + 2>/dev/null || true
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
  local incumbent_token_before incumbent_token_after incumbent_token
  local current_incumbent_token publish_replacement
  if [ -z "${DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT:-}" ]; then
    dependency_generation_configure_workspace_dirs "$integration_root" || return $?
  fi
  mkdir -p "$generation_root"
  dependency_generation_cleanup_abandoned "$generation_root"

  build="$generation_root/.build-pending-$(dependency_generation_host)-$$-$(date +%s)"
  tree="$build/tree"
  before_manifest="$build/.source-before"
  after_manifest="$build/.source-after"
  mkdir -p "$tree"
  dependency_generation_write_owner "$build/.papercusp-generation-writer"
  dependency_generation_log 'capturing live dependency manifest (before copy)'
  dependency_generation_set_manifest "$integration_root" > "$before_manifest" || {
    dependency_generation_remove_build "$build"
    return 1
  }
  source_before="$(dependency_generation_source_fingerprint "$before_manifest")" || {
    dependency_generation_remove_build "$build"
    return 1
  }
  dependency_generation_log \
    "captured live dependency manifest (before copy): trees=$(wc -l < "$before_manifest") source=$source_before"
  identity="v1-$source_before"
  generation="$generation_root/$identity"
  incumbent_token_before="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
  dependency_generation_log "validating existing generation $identity"
  if dependency_generation_is_valid \
    "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT"; then
    dependency_generation_log "validated existing generation $identity; confirming live source stability"
    dependency_generation_log 'capturing live dependency manifest (after existing-generation validation)'
    dependency_generation_set_manifest "$integration_root" > "$after_manifest" || {
      dependency_generation_remove_build "$build"
      return 1
    }
    source_after="$(dependency_generation_source_fingerprint "$after_manifest")" || {
      dependency_generation_remove_build "$build"
      return 1
    }
    dependency_generation_log \
      "captured live dependency manifest (after existing-generation validation): trees=$(wc -l < "$after_manifest") source=$source_after"
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
  # Keep the token only when the same directory was the object that failed the
  # initial validation. If a concurrent publisher replaced it during that walk,
  # force the serialized path below to perform its full validation instead.
  incumbent_token_after="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
  if [ -n "$incumbent_token_before" ] \
    && [ "$incumbent_token_before" = "$incumbent_token_after" ]; then
    incumbent_token="$incumbent_token_after"
  else
    incumbent_token=''
  fi

  dependency_generation_log "building $identity from a stable live dependency snapshot"
  while IFS= read -r nm; do
    rel="${nm#"$integration_root"/}"
    dependency_generation_log "copying dependency tree: $rel"
    if ! dependency_generation_copy_independent "$nm" "$tree/$rel"; then
      dependency_generation_remove_build "$build"
      return 1
    fi
    dependency_generation_prune_ephemeral "$tree/$rel"
    dependency_generation_log "copied dependency tree: $rel"
  done < <(dependency_generation_enumerate_node_modules "$integration_root")

  if [ -n "${DEPENDENCY_GENERATION_AFTER_COPY_HOOK:-}" ]; then
    bash -c "$DEPENDENCY_GENERATION_AFTER_COPY_HOOK"
  fi
  dependency_generation_log 'capturing live dependency manifest (after copy)'
  dependency_generation_set_manifest "$integration_root" > "$after_manifest" 2>/dev/null || true
  source_after="$(dependency_generation_source_fingerprint "$after_manifest" 2>/dev/null || true)"
  dependency_generation_log \
    "captured live dependency manifest (after copy): trees=$(wc -l < "$after_manifest") source=${source_after:-unresolved}"
  if [ -z "$source_after" ] || [ "$source_after" != "$source_before" ]; then
    dependency_generation_log_manifest_delta "$before_manifest" "$after_manifest"
    dependency_generation_log 'FATAL: live node_modules changed during generation build; refusing a torn snapshot'
    dependency_generation_remove_build "$build"
    return 75
  fi
  # Freeze file contents before recording the snapshot identity because mode is
  # part of the metadata fingerprint. Recording first would make every freshly
  # published generation invalidate itself on its next read.
  dependency_generation_log 'freezing copied dependency file modes'
  find "$tree" -type f -exec chmod a-w {} +
  dependency_generation_log 'fingerprinting immutable copied dependency snapshot'
  snapshot="$(dependency_generation_set_fingerprint "$tree")" || {
    dependency_generation_remove_build "$build"
    return 1
  }
  dependency_generation_log "fingerprinted immutable copied dependency snapshot: snapshot=$snapshot"
  marker="$build/.papercusp-dependency-generation"
  printf 'schema=1\nidentity=%s\nsource=%s\nclosure=%s\nsnapshot=%s\ncreated=%s\n%s\n' \
    "$identity" "$source_after" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" \
    "$snapshot" "$(date +%s)" "$DEPENDENCY_GENERATION_SCOPE_RECORD" > "$marker"

  dependency_generation_acquire_publish_lock "$generation_root" || {
    dependency_generation_remove_build "$build"
    return $?
  }
  dependency_generation_log "acquired dependency-generation publish lock for $identity"
  # Keep the build-owner marker until the short publish lock is held; otherwise
  # a concurrent cleanup can mistake this complete-but-not-yet-published tree
  # for an abandoned build. A generation may have appeared since our initial
  # validation, but its marker alone is not proof that the published tree is
  # still valid. A stale/corrupt tree can retain the expected identity and
  # snapshot fields; accepting that marker would discard this fully-validated
  # replacement and leave exact-id consumers pinned to the corrupt tree.
  # Re-validate the competing generation under the publish lock so that the
  # decision and any quarantine/replacement remain one serialized operation.
  # An unchanged incumbent is already known-invalid from the pre-build check;
  # compare its O(1) token and quarantine it directly. The expensive branch is
  # retained for any replacement/removal race, where a valid concurrent winner
  # must be recognized before publishing this build.
  rm -f -- "$build/.papercusp-generation-writer"
  current_incumbent_token="$(dependency_generation_generation_token "$generation" 2>/dev/null || true)"
  publish_replacement='1'
  if [ -n "$incumbent_token" ] && [ "$incumbent_token" = "$current_incumbent_token" ]; then
    dependency_generation_log "unchanged invalid generation $identity; skipping repeat validation under publish lock"
  else
    dependency_generation_log "validating concurrent generation winner for $identity"
    if dependency_generation_is_valid \
      "$generation" "$identity" "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT"; then
      dependency_generation_log "reusing valid concurrent generation winner for $identity"
      dependency_generation_remove_build "$build"
      DEPENDENCY_GENERATION_REUSED='true'
      publish_replacement='0'
    else
      dependency_generation_log "no valid concurrent generation winner for $identity"
    fi
  fi
  if [ "$publish_replacement" = '1' ]; then
    if [ -e "$generation" ]; then
      quarantine="$generation_root/.invalid-$identity-$(date +%s).$$"
      mv "$generation" "$quarantine"
      dependency_generation_log "quarantined invalid generation as $(basename "$quarantine")"
    fi
    mv "$build" "$generation"
    DEPENDENCY_GENERATION_REUSED='false'
    dependency_generation_log "published immutable dependency generation $identity"
  fi
  dependency_generation_release_publish_lock

  DEPENDENCY_GENERATION_ID="$identity"
  DEPENDENCY_GENERATION_PATH="$generation"
  DEPENDENCY_GENERATION_TREE="$generation/tree"
  DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$source_after"
}

dependency_generation_main() {
  local integration_root='' generation_root='' retention_rc=0
  local workspace_dirs=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --integration) integration_root="$2"; shift 2 ;;
      --generation-root) generation_root="$2"; shift 2 ;;
      --workspace-dir) workspace_dirs+=("$2"); shift 2 ;;
      *) dependency_generation_log "unknown arg: $1"; return 2 ;;
    esac
  done
  [ -n "$integration_root" ] || {
    dependency_generation_log '--integration is required'
    return 2
  }
  integration_root="$(cd "$integration_root" && pwd -P)"
  generation_root="${generation_root:-$integration_root/.papercusp/dependency-generations}"
  dependency_generation_configure_workspace_dirs \
    "$integration_root" "${workspace_dirs[@]}" || return $?
  dependency_generation_ensure "$integration_root" "$generation_root" || return $?
  # Protect the just-published/reused identity even when several generations
  # share the same second-level `created` timestamp and retention ordering ties.
  dependency_generation_acquire_selector_lease "$generation_root" "$DEPENDENCY_GENERATION_ID" || return $?
  dependency_generation_apply_retention "$generation_root" "$integration_root" || {
    retention_rc=$?
    dependency_generation_release_selector_lease
    return "$retention_rc"
  }
  dependency_generation_release_selector_lease
  printf 'DEPENDENCY_GENERATION_RESULT schema=1 identity=%s source=%s closure=%s scope=%s reused=%s path=%s\n' \
    "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" \
    "$DEPENDENCY_GENERATION_CLOSURE_FINGERPRINT" "$DEPENDENCY_GENERATION_SCOPE_MODE" \
    "$DEPENDENCY_GENERATION_REUSED" "$DEPENDENCY_GENERATION_PATH"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  dependency_generation_main "$@"
fi
