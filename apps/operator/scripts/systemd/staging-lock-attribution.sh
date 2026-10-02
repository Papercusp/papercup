#!/usr/bin/env bash
# Best-effort, attempt-correlated diagnostics for the staging API and sync
# flock. Every record goes to stderr, which systemd captures in the unit
# journal. Collection failures must never alter lock or readiness behavior.

staging_lock_log() {
  printf '%s\n' "[staging-lock-attribution] $*" >&2
}

staging_lock_attempt_id() {
  if [[ -n "${INVOCATION_ID:-}" ]]; then
    printf '%s' "$INVOCATION_ID"
  else
    printf '%s' unavailable
  fi
}

staging_lock_now_ms() {
  local value
  value="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
    return 0
  fi
  printf '%s' unknown
}

staging_lock_elapsed_ms() {
  local start="${1:-}" finish="${2:-}"
  if [[ "$start" =~ ^[0-9]+$ && "$finish" =~ ^[0-9]+$ ]]; then
    printf '%s' "$((finish - start))"
  else
    printf '%s' unknown
  fi
}

# Return "pid|comm" only for a live FLOCK record matching this exact file's
# device and inode. An arrow-prefixed blocked waiter is never reported as the
# holder. The optional third argument is a focused parser-test seam; production
# uses the kernel's /proc/locks.
staging_lock_resolve_holder() {
  local lock_path="${1:-}" requested_mode="${2:-}" proc_locks="${3:-/proc/locks}"
  local identity dev inode major minor target locks line id token advisory mode pid row_target rest comm
  [[ -n "$lock_path" && -e "$lock_path" ]] || return 1
  identity="$(stat -Lc '%d:%i' -- "$lock_path" 2>/dev/null || true)"
  [[ "$identity" == *:* ]] || return 1
  dev="${identity%%:*}"
  inode="${identity#*:}"
  [[ "$dev" =~ ^[0-9]+$ && "$inode" =~ ^[0-9]+$ ]] || return 1

  # Match the Linux dev_t encoding used by /proc/locks (same decoding as
  # glibc's major()/minor()).
  major=$(( ((dev >> 8) & 0xfff) | ((dev >> 32) & ~0xfff) ))
  minor=$(( (dev & 0xff) | ((dev >> 12) & ~0xff) ))
  printf -v target '%02x:%02x:%s' "$major" "$minor" "$inode"
  { locks="$(<"$proc_locks")"; } 2>/dev/null || return 1
  [[ -n "$locks" ]] || return 1

  while IFS= read -r line; do
    read -r id token advisory mode pid row_target rest <<<"$line"
    [[ "$token" != '->' ]] || continue
    [[ "$token" == FLOCK && "$advisory" == ADVISORY ]] || continue
    [[ "${row_target,,}" == "${target,,}" ]] || continue
    case "$requested_mode:$mode" in
      shared:WRITE|exclusive:READ|exclusive:WRITE) ;;
      *) continue ;;
    esac
    [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/comm" ]] || return 1
    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
    [[ -n "$comm" ]] || return 1
    comm="${comm//[^[:alnum:]_.-]/_}"
    printf '%s|%s' "$pid" "$comm"
    return 0
  done <<<"$locks"
  return 1
}

staging_lock_holder_fields() {
  local lock_path="${1:-}" requested_mode="${2:-}" proc_locks="${3:-/proc/locks}"
  local holder pid comm
  holder="$(staging_lock_resolve_holder "$lock_path" "$requested_mode" "$proc_locks" 2>/dev/null || true)"
  if [[ "$holder" == *'|'* ]]; then
    pid="${holder%%|*}"
    comm="${holder#*|}"
  else
    pid=unknown
    comm=unknown
  fi
  printf 'holder_pid=%s holder_comm=%s' "$pid" "$comm"
}

staging_lock_unit_fields() {
  local unit="${1:-papercup-staging-api.service}" output key value
  local active=unknown sub=unknown main_pid=unknown type=unknown result=unknown readiness=unknown
  output="$(systemctl --user show "$unit" -p ActiveState -p SubState -p MainPID -p Type -p Result --no-pager 2>/dev/null || true)"
  if [[ -n "$output" ]]; then
    while IFS='=' read -r key value; do
      case "$key" in
        ActiveState) active="$value" ;;
        SubState) sub="$value" ;;
        MainPID) main_pid="$value" ;;
        Type) type="$value" ;;
        Result) result="$value" ;;
      esac
    done <<<"$output"
    if [[ "$type" == notify && "$active" == active && "$sub" == running && "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
      readiness=ready
    else
      readiness=not_ready_or_unknown
    fi
  fi
  printf 'api_active_state=%s api_sub_state=%s api_main_pid=%s api_type=%s api_result=%s api_readiness=%s' \
    "$active" "$sub" "$main_pid" "$type" "$result" "$readiness"
}

staging_lock_api_pre_held() {
  local attempt_id="$1" wait_start="$2" sampler_pid="$3" marker="$4" bundle="$5"
  shift 5
  if [[ -n "$marker" ]]; then
    printf '%s\n' acquired >"$marker" 2>/dev/null || true
  fi
  kill -USR1 "$sampler_pid" 2>/dev/null || true
  staging_lock_log "event=acquired surface=start-pre attempt_id=$attempt_id lock_path=$PAPERCUSP_STAGING_LOCK_PATH lock_mode=shared wait_start_ms=$wait_start wait_elapsed_ms=$(staging_lock_elapsed_ms "$wait_start" "$(staging_lock_now_ms)")"
  exec "$bundle" "$@"
}

staging_lock_api_pre() {
  local lock_path="$1" bundle="$2"
  shift 2
  local attempt_id wait_start sampler_pid marker rc acquired outcome end_ms unit_fields
  attempt_id="$(staging_lock_attempt_id)"
  wait_start="$(staging_lock_now_ms)"
  PAPERCUSP_STAGING_LOCK_PATH="$lock_path"
  export PAPERCUSP_STAGING_LOCK_PATH
  staging_lock_log "event=start surface=start-pre attempt_id=$attempt_id state=wait_start lock_path=$lock_path lock_mode=shared wait_start_ms=$wait_start readiness_policy=Type-notify"

  (
    local sample=0 stop=0 sample_ms elapsed holder
    trap 'stop=1' USR1
    trap 'exit 0' TERM INT
    while ((sample < 5)); do
      sleep 1 2>/dev/null || true
      ((stop == 1)) && exit 0
      ((sample += 1))
      sample_ms="$(staging_lock_now_ms)"
      elapsed="$(staging_lock_elapsed_ms "$wait_start" "$sample_ms")"
      holder="$(staging_lock_holder_fields "$lock_path" shared)"
      staging_lock_log "event=wait_sample surface=start-pre attempt_id=$attempt_id lock_path=$lock_path lock_mode=shared sample=$sample sample_at_ms=$sample_ms wait_elapsed_ms=$elapsed $holder"
    done
  ) &
  sampler_pid=$!
  marker="$(mktemp /tmp/papercusp-staging-lock.XXXXXX 2>/dev/null || true)"
  if [[ -n "$marker" ]]; then
    printf '%s\n' not_acquired >"$marker" 2>/dev/null || true
  fi

  /usr/bin/flock --shared --no-fork "$lock_path" /usr/bin/bash "$0" api-pre-held \
    "$attempt_id" "$wait_start" "$sampler_pid" "$marker" "$bundle" "$@"
  rc=$?
  kill -TERM "$sampler_pid" 2>/dev/null || true
  wait "$sampler_pid" 2>/dev/null || true
  acquired=not_acquired
  if [[ -n "$marker" ]]; then
    acquired="$(cat "$marker" 2>/dev/null || printf not_acquired)"
    rm -f -- "$marker" 2>/dev/null || true
  fi
  end_ms="$(staging_lock_now_ms)"
  unit_fields="$(staging_lock_unit_fields papercup-staging-api.service)"
  if [[ "$acquired" == acquired ]]; then
    if ((rc == 0)); then outcome=bundle_success; else outcome=bundle_failed; fi
    staging_lock_log "event=end surface=start-pre attempt_id=$attempt_id state=complete lock_path=$lock_path lock_mode=shared wait_start_ms=$wait_start wait_elapsed_ms=$(staging_lock_elapsed_ms "$wait_start" "$end_ms") acquisition_outcome=acquired bundle_outcome=$outcome bundle_exit_status=$rc readiness_phase=before-execstart $unit_fields"
  elif [[ -z "$marker" ]]; then
    staging_lock_log "event=end surface=start-pre attempt_id=$attempt_id state=complete lock_path=$lock_path lock_mode=shared wait_start_ms=$wait_start wait_elapsed_ms=$(staging_lock_elapsed_ms "$wait_start" "$end_ms") acquisition_outcome=unknown_marker_unavailable command_exit_status=$rc readiness_phase=before-execstart $unit_fields"
  else
    staging_lock_log "event=end surface=start-pre attempt_id=$attempt_id state=complete lock_path=$lock_path lock_mode=shared wait_start_ms=$wait_start wait_elapsed_ms=$(staging_lock_elapsed_ms "$wait_start" "$end_ms") acquisition_outcome=not_acquired command_exit_status=$rc readiness_phase=before-execstart $unit_fields"
  fi
  return "$rc"
}

staging_lock_api_post() {
  local unit="${1:-papercup-staging-api.service}" attempt_id fields
  attempt_id="$(staging_lock_attempt_id)"
  fields="$(staging_lock_unit_fields "$unit")"
  staging_lock_log "event=api_ready surface=exec-start-post attempt_id=$attempt_id state=ready unit=$unit lock_path=/tmp/papercup-staging-sync.lock lock_mode=shared readiness_phase=after-Type-notify $fields"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  operation="${1:-}"
  shift || true
  case "$operation" in
    api-pre) staging_lock_api_pre "$@" ;;
    api-pre-held) staging_lock_api_pre_held "$@" ;;
    api-post) staging_lock_api_post "$@" ;;
    *) staging_lock_log "event=error surface=unknown state=invalid-operation operation=${operation:-unavailable}"; exit 64 ;;
  esac
fi
