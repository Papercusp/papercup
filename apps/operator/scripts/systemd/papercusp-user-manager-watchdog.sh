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
# systemd's DURABLE record of linger: `loginctl enable-linger` creates
# $LINGER_DIR/<username>, `disable-linger` removes it. It is root-owned, exists
# on disk, and — unlike logind's live user object — survives the user manager
# dying, which is the only state this watchdog is ever asked to repair.
LINGER_DIR="${PAPERCUSP_USER_MANAGER_WATCHDOG_LINGER_DIR:-/var/lib/systemd/linger}"

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

# loginctl is deliberately NOT required: it can only answer while logind still
# holds a user object, so demanding it up front reintroduces the very coupling
# that made this watchdog inert during the 2026-08-30 outage (WI-1430770).
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

resolve_username() {
  local uid="$1" name=""
  if command -v getent >/dev/null 2>&1; then
    name="$(getent passwd "$uid" 2>/dev/null | cut -d: -f1)" || name=""
  fi
  if [[ -z "$name" ]] && command -v id >/dev/null 2>&1; then
    name="$(id -nu "$uid" 2>/dev/null)" || name=""
  fi
  printf '%s' "$name"
}

# Resolve linger from the DURABLE on-disk marker first, and fall back to logind
# only when that cannot answer.
#
# WI-1430770 — why the order matters. This script used to gate on
# `loginctl show-user`, which reads logind's LIVE user object. logind destroys
# that object once the user manager exits and the last session is removed, so
# the call returns "User ID N is not logged in or lingering" and exits 1
# EXACTLY when the manager is down. The old code treated that as fatal, so the
# watchdog aborted before reaching any recovery: its enabling check could only
# succeed while it had nothing to do. On 2026-08-30 that left user@1000 — and
# with it the desktop session and the entire agent fleet — down for 13m52s
# across 13 consecutive one-per-minute runs, each dying on that single line,
# until the owner logged back in by hand.
TARGET_USER="$(resolve_username "$TARGET_UID")"
LINGER_MARKER=""
linger="unknown"
linger_source=""

if [[ -n "$TARGET_USER" && -d "$LINGER_DIR" ]]; then
  LINGER_MARKER="$LINGER_DIR/$TARGET_USER"
  if [[ -e "$LINGER_MARKER" ]]; then
    linger="yes"
  else
    linger="no"
  fi
  linger_source="$LINGER_MARKER"
fi

# logind: corroboration when the durable marker already answered, fallback when
# it could not. A failure here is an ordinary observation of a down manager,
# never a reason to abort.
if command -v loginctl >/dev/null 2>&1 &&
  live_linger="$(loginctl show-user "$TARGET_UID" --property=Linger --value 2>/dev/null)"; then
  if [[ "$linger" == "unknown" ]]; then
    [[ "$live_linger" == "yes" ]] && linger="yes" || linger="no"
    linger_source="loginctl"
  elif [[ "$linger" == "no" && "$live_linger" == "yes" ]]; then
    # logind knows about a linger this host records somewhere else. Prefer the
    # answer that keeps the manager alive; a false "enabled" only restarts a
    # service, while a false "disabled" is the outage above.
    linger="yes"
    linger_source="loginctl (no durable marker at ${LINGER_MARKER:-$LINGER_DIR})"
  fi
fi

case "$linger" in
  yes) ;;
  no)
    clear_marker
    echo "[$SCRIPT_NAME] skip: uid $TARGET_UID does not have linger enabled (per $linger_source)"
    exit 0
    ;;
  *)
    fail "could not determine linger state for uid $TARGET_UID: could not resolve its username or read $LINGER_DIR, and logind could not answer either"
    ;;
esac

if ! active_state="$(systemctl show "$UNIT" --property=ActiveState --value 2>/dev/null)"; then
  fail "could not read ActiveState for $UNIT"
fi
case "$active_state" in
  active)
    clear_marker
    # Naming the linger source on the healthy path is what makes it verifiable
    # from the journal that the DURABLE marker — not logind's live user object —
    # is the authority. If this ever reads "loginctl" on a host where the marker
    # should exist, the watchdog is one manager-exit away from being inert again.
    echo "[$SCRIPT_NAME] healthy: $UNIT is active (linger source: $linger_source)"
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
