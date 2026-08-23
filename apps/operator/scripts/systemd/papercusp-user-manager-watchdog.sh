#!/usr/bin/env bash
#
# Root-side recovery for the Papercusp service plane. This script is launched
# by the SYSTEM manager, so it survives the user manager it supervises.

set -uo pipefail

SCRIPT_NAME="${0##*/}"
TARGET_UID="${PAPERCUSP_USER_MANAGER_WATCHDOG_UID:-1000}"
GRACE_SEC="${PAPERCUSP_USER_MANAGER_WATCHDOG_GRACE_SEC:-60}"
STATE_DIR="${PAPERCUSP_USER_MANAGER_WATCHDOG_STATE_DIR:-/run/papercusp-user-manager-watchdog}"
NOW_SEC="${PAPERCUSP_USER_MANAGER_WATCHDOG_NOW_SEC:-}"

fail() {
  echo "[$SCRIPT_NAME] ERROR: $*" >&2
  exit 1
}

case "$TARGET_UID" in
  ''|*[!0-9]*) fail "target uid must be a positive integer (got '$TARGET_UID')" ;;
esac
(( TARGET_UID > 0 )) || fail "target uid must be greater than zero"

case "$GRACE_SEC" in
  ''|*[!0-9]*) fail "grace seconds must be a positive integer (got '$GRACE_SEC')" ;;
esac
(( GRACE_SEC > 0 )) || fail "grace seconds must be greater than zero"

if [[ -z "$NOW_SEC" ]]; then
  NOW_SEC="$(date +%s)" || fail "could not read the current time"
fi
case "$NOW_SEC" in
  ''|*[!0-9]*) fail "current time must be a non-negative integer (got '$NOW_SEC')" ;;
esac

command -v loginctl >/dev/null 2>&1 || fail "loginctl is unavailable"
command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable"
mkdir -p -- "$STATE_DIR" || fail "could not create state directory $STATE_DIR"
chmod 0755 "$STATE_DIR" || fail "could not secure state directory $STATE_DIR"

UNIT="user@$TARGET_UID.service"
MARKER="$STATE_DIR/user-$TARGET_UID.down-since"

clear_marker() {
  rm -f -- "$MARKER" || fail "could not clear $MARKER"
}

record_down_since() {
  local observed_at="$1"
  local tmp="$MARKER.$$"
  printf '%s\n' "$observed_at" >"$tmp" || fail "could not write $tmp"
  chmod 0644 "$tmp" || fail "could not secure $tmp"
  mv -f -- "$tmp" "$MARKER" || fail "could not publish $MARKER"
}

if ! linger="$(loginctl show-user "$TARGET_UID" --property=Linger --value 2>/dev/null)"; then
  fail "could not read linger state for uid $TARGET_UID"
fi
if [[ "$linger" != "yes" ]]; then
  clear_marker
  echo "[$SCRIPT_NAME] skip: uid $TARGET_UID does not have linger enabled"
  exit 0
fi

if ! active_state="$(systemctl show "$UNIT" --property=ActiveState --value 2>/dev/null)"; then
  fail "could not read ActiveState for $UNIT"
fi
case "$active_state" in
  active)
    clear_marker
    echo "[$SCRIPT_NAME] healthy: $UNIT is active"
    exit 0
    ;;
  activating|deactivating|reloading)
    # A deliberate restart is already moving. Reset the observation window so
    # the watchdog cannot race that transition.
    clear_marker
    echo "[$SCRIPT_NAME] suppress: $UNIT is $active_state"
    exit 0
    ;;
  inactive|failed) ;;
  *) fail "refusing to act on unexpected ActiveState '$active_state' for $UNIT" ;;
esac

if [[ ! -r "$MARKER" ]]; then
  record_down_since "$NOW_SEC"
  echo "[$SCRIPT_NAME] observed $UNIT $active_state; grace window starts now"
  exit 0
fi

down_since=""
IFS= read -r down_since <"$MARKER" || true
case "$down_since" in
  ''|*[!0-9]*)
    record_down_since "$NOW_SEC"
    echo "[$SCRIPT_NAME] reset invalid down-since marker; grace window restarts"
    exit 0
    ;;
esac

if (( NOW_SEC < down_since )); then
  record_down_since "$NOW_SEC"
  echo "[$SCRIPT_NAME] clock moved backwards; grace window restarts"
  exit 0
fi

elapsed=$((NOW_SEC - down_since))
if (( elapsed < GRACE_SEC )); then
  echo "[$SCRIPT_NAME] suppress: $UNIT has been $active_state for ${elapsed}s (< ${GRACE_SEC}s)"
  exit 0
fi

echo "[$SCRIPT_NAME] restoring $UNIT after ${elapsed}s down with linger=yes"
if ! systemctl start "$UNIT"; then
  fail "systemctl start $UNIT failed"
fi
if ! systemctl is-active --quiet "$UNIT"; then
  fail "$UNIT did not become active after a successful start job"
fi

clear_marker
echo "[$SCRIPT_NAME] restored: $UNIT is active"
