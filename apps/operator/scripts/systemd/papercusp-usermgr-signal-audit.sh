#!/usr/bin/env bash
#
# Root-side FORENSICS for the systemd user manager: arm an audit rule that
# records every kill()/tgkill() aimed at the CURRENT main process of
# user@<uid>.service, so a signal that tears the manager down names its sender.
#
# WI-1430770. On 2026-08-30 21:32:45 the user manager received a SIGTERM,
# activated exit.target, and took the desktop session and the entire agent fleet
# with it. The sender could not be identified, because this host's audit rules
# capture only:
#   * signal 9  (`-S kill -F a1=0x9 -k sigkill`), and
#   * execve of the session binaries (systemctl/loginctl/pkill/killall/kill/
#     gnome-session-quit/systemd-run, `-k session_ctl`).
# A direct in-process kill(pid, SIGTERM) matches neither, so it left no trace at
# all. This closes that gap for the one pid whose death costs the whole box,
# while auditing nothing else — the rule is pinned to a single pid, so it adds
# no measurable volume.
#
# Because it is pid-pinned it must be RE-ARMED whenever the manager restarts.
# The timer re-checks every minute and re-arms when the pid changes or when the
# rule has gone missing (an auditd restart flushes the ruleset).
#
# Deliberately NOT folded into papercusp-user-manager-watchdog.sh: that unit
# runs with RestrictAddressFamilies=AF_UNIX, and auditctl needs AF_NETLINK.
# Loosening the recovery actor's sandbox to carry a forensic nicety would be a
# bad trade — the watchdog's job is to come back up, and nothing should widen
# its failure surface.

set -uo pipefail

SCRIPT_NAME="${0##*/}"
TARGET_UID="${PAPERCUSP_USERMGR_SIGNAL_AUDIT_UID:-1000}"
STATE_DIR="${PAPERCUSP_USERMGR_SIGNAL_AUDIT_STATE_DIR:-/run/papercusp-usermgr-signal-audit}"
AUDIT_KEY="${PAPERCUSP_USERMGR_SIGNAL_AUDIT_KEY:-usermgr_signal}"

fail() {
  echo "[$SCRIPT_NAME] ERROR: $*" >&2
  exit 1
}

case "$TARGET_UID" in
  '' | *[!0-9]*) fail "target uid must be a positive integer (got '$TARGET_UID')" ;;
esac
((TARGET_UID > 0)) || fail "target uid must be greater than zero"

command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable"
command -v auditctl >/dev/null 2>&1 || fail "auditctl is unavailable"
mkdir -p -- "$STATE_DIR" || fail "could not create state directory $STATE_DIR"
chmod 0755 "$STATE_DIR" || fail "could not secure state directory $STATE_DIR"

UNIT="user@$TARGET_UID.service"
ARMED_FILE="$STATE_DIR/armed-pid"

# kill(pid, sig) and tgkill(tgid, tid, sig) both carry the target in a0, so one
# rule covers both. pidfd_send_signal is deliberately absent: its a0 is a pidfd,
# not a pid, so it cannot be filtered this way — a sender using it stays
# invisible, and that limit is stated here rather than silently assumed away.
rule_spec() {
  printf '%s\n' always,exit -F arch=b64 -S kill -S tgkill -F "a0=$1" -k "$AUDIT_KEY"
}

rule_present() {
  local hex
  hex="$(printf '%X' "$1")" || return 1
  # auditctl -l renders the arg in hex, e.g.
  #   -a always,exit -F arch=b64 -S kill,tgkill -F a0=0x3323A -F key=usermgr_signal
  auditctl -l 2>/dev/null | grep -qF -- "a0=0x${hex} -F key=${AUDIT_KEY}"
}

main_pid="$(systemctl show "$UNIT" --property=MainPID --value 2>/dev/null)" ||
  fail "could not read MainPID for $UNIT"
case "$main_pid" in
  '' | *[!0-9]*) main_pid=0 ;;
esac

if ((main_pid <= 0)); then
  # The manager is down. Recovery is the watchdog's job, not ours; there is no
  # live pid to pin a rule to, so record nothing and let the next tick arm it.
  echo "[$SCRIPT_NAME] skip: $UNIT has no main process to audit"
  exit 0
fi

armed=""
if [[ -r "$ARMED_FILE" ]]; then
  IFS= read -r armed <"$ARMED_FILE" || armed=""
fi
case "$armed" in
  '' | *[!0-9]*) armed="" ;;
esac

if [[ "$armed" == "$main_pid" ]] && rule_present "$main_pid"; then
  echo "[$SCRIPT_NAME] already armed: signals to $UNIT pid $main_pid audited under '$AUDIT_KEY'"
  exit 0
fi

# A pid we previously pinned is now stale. Drop it so the ruleset cannot grow
# one dead entry per manager restart. Best-effort: the rule may already be gone
# (auditd restart), and that is not a failure.
if [[ -n "$armed" && "$armed" != "$main_pid" ]]; then
  mapfile -t old_spec < <(rule_spec "$armed")
  auditctl -d "${old_spec[@]}" >/dev/null 2>&1 || true
fi

mapfile -t new_spec < <(rule_spec "$main_pid")
auditctl -a "${new_spec[@]}" >/dev/null ||
  fail "could not arm the audit rule for $UNIT pid $main_pid"

tmp="$ARMED_FILE.$$"
printf '%s\n' "$main_pid" >"$tmp" || fail "could not write $tmp"
chmod 0644 "$tmp" || fail "could not secure $tmp"
mv -f -- "$tmp" "$ARMED_FILE" || fail "could not publish $ARMED_FILE"

echo "[$SCRIPT_NAME] armed: signals to $UNIT pid $main_pid audited under '$AUDIT_KEY' (read with: ausearch -k $AUDIT_KEY)"
