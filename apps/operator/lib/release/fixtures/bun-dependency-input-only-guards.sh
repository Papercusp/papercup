# Exact portable guard block for the P-006 input-only proposal. The caller sources
# the pinned maintained helper first and owns the disposable error-file directory.
# No generation API is called. Keep machine paths and execution admission outside
# this fixture; its bytes are embedded in the canonical review packet.
dependency_generation_input_only() (
  set -euo pipefail
  root="$1" ref="$2" errors="$3"
  DEPENDENCY_GENERATION_INFLIGHT_PROGRESS=''
  export GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1

  git() {
    local rc=0 listing='' listing_rc=0
    if [ "$#" -lt 3 ] || [ "$1" != '-C' ]; then
      printf 'unsupported git invocation\n' >> "$errors"
      return 74
    fi
    case "$3" in
      rev-parse|ls-tree) ;;
      cat-file)
        case "${4:-}" in blob|-e) ;; *) printf 'unsupported cat-file\n' >> "$errors"; return 74 ;; esac ;;
      config)
        if [ "$#" -ne 7 ] || [ "$4" != '--blob' ] || [ "$6" != '--get-regexp' ] || [ "$7" != '\.path$' ]; then
          printf 'unsupported config read\n' >> "$errors"
          return 74
        fi ;;
      *) printf 'forbidden git command: %s\n' "$3" >> "$errors"; return 74 ;;
    esac
    command git "$@" || rc=$?
    [ "$rc" -ne 0 ] || return 0
    # The maintained walker asks every leaf repo for .gitmodules. Missing files
    # (128) and valid files without path entries (1) are normal, not read failures.
    if [ "$3" = config ] && { [ "$rc" -eq 1 ] || [ "$rc" -eq 128 ]; }; then
      listing="$(command git -C "$2" ls-tree "${5%:.gitmodules}" -- .gitmodules)" || listing_rc=$?
      if [ "$listing_rc" -eq 0 ] && { [ -z "$listing" ] || [ "$rc" -eq 1 ]; }; then
        return "$rc"
      fi
    fi
    # Process substitutions can hide failures from the caller's exit status.
    # Their descendants share this one caller-owned error channel, checked below.
    printf 'git read failed: %s exit=%s\n' "$3" "$rc" >> "$errors"
    return "$rc"
  }

  dependency_generation_hydrate_submodule() {
    printf 'missing committed submodule; hydration forbidden\n' >> "$errors"
    return 74
  }

  resolved="$(git -C "$root" rev-parse --verify "$ref^{commit}")" || exit $?
  [ "$resolved" = "$ref" ] || exit 74
  manifest="$(dependency_generation_input_manifest_ref "$root" "$ref" | LC_ALL=C sort)" || exit $?
  [ ! -s "$errors" ] || { cat "$errors" >&2; exit 74; }
  [ -n "$manifest" ] || exit 74
  printf '%s\n' "$manifest" | awk -F '\t' '
    NF != 2 || length($2) != 64 || $2 !~ /^[0-9a-f]+$/ ||
      $1 ~ /^\// || $1 ~ /(^|\/)\.\.?($|\/)/ || $1 ~ /\\/ { exit 74 }
    seen[$1]++ { exit 74 }
  ' || exit $?
  fingerprint="$( { printf 'schema\t1\n'; printf '%s\n' "$manifest"; } | dependency_generation_sha256)" || exit $?
  [[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || exit 74
  printf 'DEPENDENCY_INPUT_MANIFEST_BEGIN\n%s\nDEPENDENCY_INPUT_MANIFEST_END\n' "$manifest"
  printf 'DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=%s input=%s\n' "$ref" "$fingerprint"
)
