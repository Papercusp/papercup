#!/usr/bin/env bash
#
# papercusp-systemd-restore-recovery.sh — repair timer state after a restore.
#
# A /home or /etc restore can put a unit file back on disk without repairing
# the systemd manager's in-memory failure state. In that state an enabled
# timer can remain failed/inactive forever (systemd reports "Unit to trigger
# vanished" / Result=resources), so its next scheduled run never happens.
#
# This is deliberately a post-restore sweep, not a resident watchdog: the
# restore operator owns the one-time daemon-reload/reset and then starts only
# timers that are enabled but not active. Disabled timers and active timers
# are left alone. Run the user scope after restoring /home; add --scope
# system when /etc was restored, or --scope both after restoring both trees.
#
# Usage:
#   papercusp-systemd-restore-recovery.sh [--scope user|system|both]
#
# The script is Linux/systemd-only. It fails loudly when systemctl or a
# manager is unavailable so a restore cannot be reported complete while the
# recovery sweep was silently skipped.

set -uo pipefail

SCRIPT_NAME="${0##*/}"
SCOPE="user"

usage() {
  cat >&2 <<EOF
Usage: $SCRIPT_NAME [--scope user|system|both]

Repair systemd timer state after restoring unit files:
  1. daemon-reload
  2. reset-failed
  3. start every enabled (or enabled-runtime) inactive timer

The default scope is user. Use --scope system after restoring /etc, or
--scope both after restoring both /home and /etc.
EOF
}

while (($# > 0)); do
  case "$1" in
    --scope)
      if (($# < 2)); then
        echo "$SCRIPT_NAME: --scope requires user, system, or both" >&2
        usage
        exit 2
      fi
      SCOPE="$2"
      shift 2
      ;;
    --scope=*)
      SCOPE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "$SCRIPT_NAME: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$SCOPE" in
  user|system|both) ;;
  *)
    echo "$SCRIPT_NAME: invalid scope '$SCOPE' (expected user, system, or both)" >&2
    usage
    exit 2
    ;;
esac

if ! command -v systemctl >/dev/null 2>&1; then
  echo "$SCRIPT_NAME: systemctl is unavailable; post-restore recovery was not run" >&2
  exit 127
fi

recover_scope() {
  local scope="$1"
  local manager_label="system"
  local -a ctl=(systemctl)
  if [[ "$scope" == "user" ]]; then
    manager_label="systemd --user"
    ctl+=(--user)
  fi

  echo "[$SCRIPT_NAME] recovering $manager_label timer state"

  if ! "${ctl[@]}" daemon-reload; then
    echo "[$SCRIPT_NAME] ERROR: $manager_label daemon-reload failed" >&2
    return 1
  fi
  if ! "${ctl[@]}" reset-failed; then
    echo "[$SCRIPT_NAME] ERROR: $manager_label reset-failed failed" >&2
    return 1
  fi

  local unit_file_listing
  if ! unit_file_listing="$("${ctl[@]}" list-unit-files --type=timer --no-legend --no-pager)"; then
    echo "[$SCRIPT_NAME] ERROR: could not list $manager_label timer unit files" >&2
    return 1
  fi

  local line unit_file_state unit _rest
  local started=0 skipped=0 failures=0
  while IFS= read -r line; do
    # systemctl emits one unit per line: NAME STATE PRESET. Ignore blank or
    # malformed rows rather than turning unrelated output into a unit name.
    [[ -n "${line//[[:space:]]/}" ]] || continue
    unit_file_state=""
    unit=""
    _rest=""
    read -r unit unit_file_state _rest <<<"$line"
    [[ "$unit" == *.timer ]] || continue
    case "$unit_file_state" in
      enabled|enabled-runtime) ;;
      *) continue ;;
    esac

    if "${ctl[@]}" is-active --quiet "$unit"; then
      skipped=$((skipped + 1))
      continue
    fi

    echo "[$SCRIPT_NAME] starting enabled inactive timer: $unit"
    if "${ctl[@]}" start "$unit"; then
      started=$((started + 1))
    else
      echo "[$SCRIPT_NAME] ERROR: could not start $manager_label timer $unit" >&2
      failures=$((failures + 1))
    fi
  done <<<"$unit_file_listing"

  echo "[$SCRIPT_NAME] $manager_label: started=$started already-active=$skipped failures=$failures"
  (( failures == 0 ))
}

case "$SCOPE" in
  user)
    recover_scope user
    ;;
  system)
    recover_scope system
    ;;
  both)
    overall_status=0
    recover_scope user || overall_status=1
    recover_scope system || overall_status=1
    exit "$overall_status"
    ;;
esac
