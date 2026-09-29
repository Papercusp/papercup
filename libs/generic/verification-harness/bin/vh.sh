# vh.sh — verification-harness helper for SHELL harnesses. Source it; do not execute it.
#
#   source libs/generic/verification-harness/bin/vh.sh
#   vh_phase setup "" 1              # id, comma-separated deps, reusable (1/0) — declaration order
#   vh_phase leg-a setup
#   vh_phase leg-b setup
#   vh_scope hive-git physical-drill # optional: guard-rail scope tags (see vh_preflight)
#   vh_init my-drill "$EVIDENCE_ROOT" "$@"   # consumes --only/--from/--reuse; VH_ARGS = the rest
#   vh_preflight check_rig           # optional: a failure blocks every phase; with scope tags it
#                                    # also runs the matching guard-rail probes (VH_GUARD_RAIL_SOURCE)
#   vh_run setup  phase_setup        # each phase is a function
#   vh_run leg-a  phase_leg_a
#   vh_run leg-b  phase_leg_b
#   vh_finish                        # prints HARNESS_RESULT, returns 0 on pass
#
# Inside a phase function: `vh_step <label>` marks progress; `vh_fail <reasonCode> [detail]`
# records the failure (then `return`). A non-zero return without vh_fail is recorded as
# reasonCode exit-<rc>. vh_run calls the function in an `||` list, so errexit is suspended
# inside it: check each command explicitly. A later phase still runs after a failure unless
# it depends on the failed phase (never-abort). Each phase gets "$VH_PHASE_DIR" for evidence.
# Selection rules and the result schema live in src/cli.ts (TS), shared with the TS runner.
# Needs bash >= 4.2 (associative arrays, declare -g): run it on the Linux side, never under
# the macOS stock /bin/bash 3.2.

VH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
declare -ga VH_PHASE_IDS=() VH_SCOPE_TAGS=()
declare -gA VH_DEPS=() VH_REUSABLE=() VH_ACTION=() VH_REUSE_FROM=() VH_STATUS=()
VH_PREFLIGHT_FAILED=0
VH_PREFLIGHT_DONE=0
VH_PREFLIGHT_FN=""

_vh_tsx() {
  if [ -n "${VH_TSX:-}" ]; then echo "$VH_TSX"; return; fi
  local d="$VH_LIB_DIR"
  while [ "$d" != "/" ]; do
    [ -x "$d/node_modules/.bin/tsx" ] && { echo "$d/node_modules/.bin/tsx"; return; }
    d="$(dirname "$d")"
  done
  echo tsx
}

_vh_json_str() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"; s="${s//$'\r'/ }"; s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}

_vh_now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
_vh_ms() { date -u +%s%3N; }

# _vh_record <phase> <status> <step> <reasonCode> <detail> <startedAt> <endedAt> <elapsedMs> [reusedFromRunId]
_vh_record() {
  local row="{\"phase\":$(_vh_json_str "$1"),\"status\":$(_vh_json_str "$2")"
  [ -n "$3" ] && row+=",\"step\":$(_vh_json_str "$3")"
  [ -n "$4" ] && row+=",\"reasonCode\":$(_vh_json_str "$4")"
  [ -n "$5" ] && row+=",\"detail\":$(_vh_json_str "$5")"
  [ -n "$6" ] && row+=",\"startedAt\":$(_vh_json_str "$6")"
  [ -n "$7" ] && row+=",\"endedAt\":$(_vh_json_str "$7")"
  row+=",\"elapsedMs\":${8:-0}"
  [ -n "${9:-}" ] && row+=",\"reusedFromRunId\":$(_vh_json_str "$9")"
  printf '%s}\n' "$row" >> "$VH_RUN_DIR/phases.jsonl"
  VH_STATUS[$1]="$2"
  echo "VH_PHASE phase=$1 status=$2${3:+ step=$3}${4:+ reason=$4}"
}

vh_phase() {
  VH_PHASE_IDS+=("$1")
  VH_DEPS[$1]="${2:-}"
  VH_REUSABLE[$1]="${3:-0}"
}

# Scope tags for guard-rail selection (before vh_init): the preflight runs every probe from
# VH_GUARD_RAIL_SOURCE that shares a tag.
vh_scope() { VH_SCOPE_TAGS+=("$@"); }

vh_init() {
  local name="$1" root="$2"; shift 2
  VH_NAME="$name"
  VH_EVIDENCE_ROOT="$root"
  VH_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  VH_RUN_DIR="$root/$VH_RUN_ID"
  mkdir -p "$VH_RUN_DIR/phases" || return 2
  local sel=() VH_ARGS_TMP=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --only|--only-phase|--from|--from-phase|--reuse) sel+=("$1" "${2:-}"); shift 2 ;;
      --only=*|--only-phase=*|--from=*|--from-phase=*|--reuse=*) sel+=("$1"); shift ;;
      *) VH_ARGS_TMP+=("$1"); shift ;;
    esac
  done
  VH_ARGS=("${VH_ARGS_TMP[@]}")
  # `--reuse latest` means the run <root>/latest points at.
  local i; for i in "${!sel[@]}"; do [ "${sel[$i]}" = "latest" ] && sel[$i]="$(readlink -f "$root/latest")"; done
  {
    printf '{"name":%s,"phases":[' "$(_vh_json_str "$name")"
    local first=1 id d deps
    for id in "${VH_PHASE_IDS[@]}"; do
      deps=""
      IFS=',' read -ra _d <<< "${VH_DEPS[$id]}"
      for d in "${_d[@]}"; do [ -n "$d" ] && deps+="${deps:+,}$(_vh_json_str "$d")"; done
      [ $first -eq 1 ] || printf ','
      first=0
      printf '{"id":%s,"dependsOn":[%s],"reusable":%s}' "$(_vh_json_str "$id")" "$deps" \
        "$([ "${VH_REUSABLE[$id]}" = 1 ] && echo true || echo false)"
    done
    local tags="" t
    for t in "${VH_SCOPE_TAGS[@]}"; do tags+="${tags:+,}$(_vh_json_str "$t")"; done
    printf '],"scopeTags":[%s]}\n' "$tags"
  } > "$VH_RUN_DIR/contract.json"
  local plan
  plan="$("$(_vh_tsx)" "$VH_LIB_DIR/src/cli.ts" plan --run-dir "$VH_RUN_DIR" "${sel[@]}")" || return 2
  local p a r
  while IFS=$'\t' read -r p a r; do
    [ -n "$p" ] || continue
    VH_ACTION[$p]="$a"
    VH_REUSE_FROM[$p]="$r"
  done <<< "$plan"
  echo "VH_RUN harness=$name run=$VH_RUN_ID evidence=$VH_RUN_DIR plan=$(echo "$plan" | awk -F'\t' '{printf "%s%s:%s", (NR>1 ? "," : ""), $1, $2}')"
}

vh_step() { VH_CUR_STEP="$1"; echo "VH_STEP phase=${VH_CUR_PHASE:-?} step=$1"; }

vh_fail() { VH_CUR_FAIL="$1"; VH_CUR_DETAIL="${2:-}"; }

_vh_exec() {
  local id="$1" fn="$2"
  VH_CUR_PHASE="$id"; VH_CUR_STEP=""; VH_CUR_FAIL=""; VH_CUR_DETAIL=""
  VH_PHASE_DIR="$VH_RUN_DIR/phases/$id"
  mkdir -p "$VH_PHASE_DIR"
  local t0 s0 rc=0
  t0="$(_vh_ms)"; s0="$(_vh_now)"
  "$fn" || rc=$?
  local status=passed reason=""
  if [ -n "$VH_CUR_FAIL" ]; then status=failed; reason="$VH_CUR_FAIL"
  elif [ "$rc" -ne 0 ]; then status=failed; reason="exit-$rc"; fi
  _vh_record "$id" "$status" "$VH_CUR_STEP" "$reason" "$VH_CUR_DETAIL" "$s0" "$(_vh_now)" "$(( $(_vh_ms) - t0 ))"
  VH_CUR_PHASE=""
  [ "$status" = passed ]
}

# The harness's own check (if any) and then the guard rails; both run, so one run reports
# every broken precondition, and the harness's own failure names the reason when both fail.
_vh_preflight_body() {
  local rc=0
  if [ -n "$VH_PREFLIGHT_FN" ]; then "$VH_PREFLIGHT_FN" || rc=$?; fi
  local own_fail="$VH_CUR_FAIL" own_detail="$VH_CUR_DETAIL" own_step="$VH_CUR_STEP"
  [ -z "$own_fail" ] && [ "$rc" -ne 0 ] && own_fail="exit-$rc"
  local out="" line grc=0 greason="" gdetail=""
  if [ "${#VH_SCOPE_TAGS[@]}" -gt 0 ]; then
    vh_step guard-rails
    out="$("$(_vh_tsx)" "$VH_LIB_DIR/src/cli.ts" guard-rails --run-dir "$VH_RUN_DIR")" || grc=$?
    while IFS= read -r line; do
      case "$line" in
        "VH_GUARD_RAILS_FAILED "*)
          greason="${line#*reason=}"; greason="${greason%% detail=*}"; gdetail="${line#* detail=}" ;;
        ?*) echo "$line" ;;
      esac
    done <<< "$out"
    [ "$grc" -ne 0 ] && [ -z "$greason" ] && greason="guard-rail-check-error:$grc"
  fi
  if [ -n "$own_fail" ]; then
    VH_CUR_STEP="$own_step"
    vh_fail "$own_fail" "$own_detail${gdetail:+; $gdetail}"
    return 1
  fi
  if [ -n "$greason" ]; then vh_fail "$greason" "$gdetail"; return 1; fi
  return 0
}

# vh_preflight [fn] — fn is the harness's own fast check. With scope tags declared, the
# first vh_run calls this itself if the harness did not, so the rails always run.
vh_preflight() {
  VH_PREFLIGHT_FN="${1:-}"
  VH_PREFLIGHT_DONE=1
  _vh_exec preflight _vh_preflight_body || VH_PREFLIGHT_FAILED=1
}

vh_run() {
  local id="$1" fn="$2" d
  if [ "$VH_PREFLIGHT_DONE" = 0 ] && [ "${#VH_SCOPE_TAGS[@]}" -gt 0 ]; then vh_preflight; fi
  case "${VH_ACTION[$id]:-}" in
    "") echo "vh_run: phase $id was not declared with vh_phase" >&2; return 2 ;;
    skip) _vh_record "$id" skipped "" not-selected "" "" "" 0; return 0 ;;
    reuse) _vh_record "$id" reused "" "" "" "" "" 0 "${VH_REUSE_FROM[$id]}"; return 0 ;;
  esac
  if [ "$VH_PREFLIGHT_FAILED" = 1 ]; then _vh_record "$id" blocked "" preflight-failed "" "" "" 0; return 0; fi
  IFS=',' read -ra _deps <<< "${VH_DEPS[$id]}"
  for d in "${_deps[@]}"; do
    [ -n "$d" ] || continue
    case "${VH_STATUS[$d]:-}" in
      passed|reused) ;;
      *) _vh_record "$id" blocked "" "dependency:$d:${VH_STATUS[$d]:-unknown}" "" "" "" 0; return 0 ;;
    esac
  done
  _vh_exec "$id" "$fn"
  return 0
}

vh_finish() {
  "$(_vh_tsx)" "$VH_LIB_DIR/src/cli.ts" finalize --run-dir "$VH_RUN_DIR" --evidence-root "$VH_EVIDENCE_ROOT"
}
