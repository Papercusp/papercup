#!/usr/bin/env bash
# papercup-backup-health-check.sh — periodic DB-backup freshness + failure probe (EI-10733).
#
# WHY: the Postgres backup failed 100% for ~30 DAYS and nothing noticed.
# 2026-07-12 (EI-10733): ~/.config/kopia/hooks/pre-snapshot.sh dumped the DB with
# `timeout 60`, but the DB had grown to 1.4GB gzipped — a dump that size cannot finish
# in 60s, so pg_dumpall was SIGTERMed mid-stream on EVERY cycle, the .tmp was deleted,
# and "pg-5432 FAIL" was appended to a logfile nobody reads. Meanwhile the last
# SUCCESSFUL dump (2026-06-12) still sat on disk looking exactly like a healthy backup.
# We had no recoverable database for a month and the only evidence was a stale mtime.
#
# It also had a second-order victim: when `timeout` killed pg_dumpall, its per-database
# `pg_dump` GRANDCHILD survived (reparented to systemd, no timeout of its own) holding
# AccessShareLock on ~593 tables. That orphan blocked every migration's ACCESS EXCLUSIVE,
# so the deploy's migrate step died on lock_timeout and the release pipeline wedged for
# 9h (EI-10730). One dead backup silently took the release pipeline with it.
#
# THE DETECTOR GAP THIS CLOSES: "the backup file exists" is NOT "the backup works".
# Nothing checked FRESHNESS or SUCCESS — the same cannot-discriminate class as a gate
# whose pass-branch fires on exactly the condition it exists to catch.
#
# TWO independent signals, either can fire:
#   (a) FRESHNESS — the newest dump artifact is older than BACKUP_MAX_AGE_H. This is
#       the signal that would have caught the 30-day death on day one. It holds even if
#       the hook log has been rotated away, because it judges the ARTIFACT, not the log.
#   (b) CONSECUTIVE FAILURES — the hook log's tail shows >= BACKUP_MAX_FAILS "FAIL"
#       lines with no intervening "ok". This fires EARLY (within an hour or two of the
#       breakage) rather than waiting for the artifact to age past the freshness bar,
#       and it catches the case where an artifact is fresh but a LATER dump began failing.
#
# DETECTION + ESCALATION ONLY — this script never re-runs a dump, kills a process, or
# touches the backup config. Recovery is a human/agent call made off the filed EI. Same
# posture as papercup-dht-liveness-check.sh (EI-8892) and papercup-fedplane-disk-health-check.sh
# (EI-8982): a health check must not also hold mutate authority over what it judges
# (EI-8901's lesson — a threshold bug then becomes a self-inflicted incident).
#
# Usage: papercup-backup-health-check.sh
# Env:
#   BACKUP_DUMP_DIR      (default /mnt/data/Backup/db-dumps) — where the .sql.gz dumps land
#   BACKUP_ARTIFACTS     (default "pg-5432.sql.gz")          — space-separated artifacts that
#                                                              MUST stay fresh. pg-16534 is
#                                                              deliberately NOT here: the
#                                                              embedded PG isn't running on the
#                                                              dev box, so it is skipped, not failed.
#   BACKUP_MAX_AGE_H     (default 6)   — artifact older than this ⇒ alarm (dumps run ~hourly)
#   BACKUP_MAX_FAILS     (default 3)   — this many trailing FAILs with no "ok" ⇒ alarm
#   BACKUP_HOOK_LOG      (default $BACKUP_DUMP_DIR/hook.log)
#   OPERATOR_MCP_URL     (default http://127.0.0.1:3070/api/mcp?superuser=1)
#   BACKUP_NO_FILE       (default 0)   — set 1 to skip EI filing (log-only / dry-run)
#   BACKUP_RED_REFILE_H  (default 12)  — RED-EI dedup window (mirrors DHT_RED_REFILE_H /
#                                        DISK_RED_REFILE_H — file once per window per still-bad
#                                        condition, not a fresh EI every tick)
set -uo pipefail

# ── ALARM SAFETY: a TEST must not be able to fire the real alarm (EI-10746) ──
# Its sibling ~/.config/kopia/healthcheck.sh had the identical hole and it BIT: on
# 2026-07-12 22:25, three failure-path test runs against a 4-minute-old healthy dump each
# rang the real alarm and paged the whole fleet. Both scripts offered an opt-out
# (BACKUP_ALERT_CMD there, BACKUP_NO_FILE here) and neither ENFORCED it — so the default
# way to test the alarm was to fire it. A guard you must REMEMBER is not a guard.
#
# Structural rule: OVERRIDING A THRESHOLD IS THE DEFINITION OF A NON-PRODUCTION RUN.
# Detected HERE, before the `${VAR:-default}` assignments below erase the difference
# between "unset" and "set to the default value" (${VAR+x} can still see it). The verdict
# and exit path are untouched — only the FILING is withheld, so a test still gets the truth.
# BACKUP_ALERT_FORCE=1 files anyway, for the rare case a non-default threshold should.
if [ -z "${BACKUP_ALERT_FORCE:-}" ] \
   && { [ -n "${BACKUP_MAX_AGE_H+x}" ] || [ -n "${BACKUP_MAX_FAILS+x}" ]; } \
   && [ "${BACKUP_NO_FILE:-0}" != 1 ]; then
  echo "[backup-health] ALARM SUPPRESSED: a threshold was overridden (BACKUP_MAX_AGE_H/BACKUP_MAX_FAILS) — that is a TEST run, not production. Forcing BACKUP_NO_FILE=1 (no EI will be filed). Set BACKUP_ALERT_FORCE=1 to file anyway." >&2
  BACKUP_NO_FILE=1
fi

BACKUP_DUMP_DIR="${BACKUP_DUMP_DIR:-/mnt/data/Backup/db-dumps}"
BACKUP_ARTIFACTS="${BACKUP_ARTIFACTS:-pg-5432.sql.gz}"
BACKUP_MAX_AGE_H="${BACKUP_MAX_AGE_H:-6}"
BACKUP_MAX_FAILS="${BACKUP_MAX_FAILS:-3}"
BACKUP_HOOK_LOG="${BACKUP_HOOK_LOG:-$BACKUP_DUMP_DIR/hook.log}"
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}"
BACKUP_NO_FILE="${BACKUP_NO_FILE:-0}"
BACKUP_RED_REFILE_H="${BACKUP_RED_REFILE_H:-12}"
GATE_SUPERUSER_TOKEN_PATH="${GATE_SUPERUSER_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
GATE_SUPERUSER_BEARER="$(cat "$GATE_SUPERUSER_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
STATE_DIR="${BACKUP_STATE_DIR:-$HOME/.papercusp/backup-health}"; mkdir -p "$STATE_DIR" 2>/dev/null || true

log() { echo "[backup-health $(date +%H:%M:%S 2>/dev/null || true)] $*" >&2; }
now_s() { date +%s 2>/dev/null || echo 0; }
age_h() { local f="$1"; [ -f "$f" ] || { echo 999999; return; }; echo $(( ( $(now_s) - $(cat "$f" 2>/dev/null || echo 0) ) / 3600 )); }
jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

# Mark a RED as filed, so we file once per BACKUP_RED_REFILE_H window instead of every tick.
# NEVER writes the marker on a dry-run: file_ei() no-ops under BACKUP_NO_FILE=1, so writing
# the marker anyway would let a harmless dry-run SUPPRESS the next REAL filing for 12h — a
# dry-run that disarms the alarm it is testing.
#
# ⚠ THAT IS EXACTLY WHAT WAS HAPPENING (EI-10746, fixed 2026-07-12). This function was
# defined, its rationale was written out in full above — and then NEVER CALLED. All three
# call sites inlined `echo "$(now_s)" >"$RED_MARKER"`, bypassing the guard completely. So a
# BACKUP_NO_FILE=1 dry-run skipped the EI (correct) but STILL wrote the marker (wrong), and
# the next REAL red was silently suppressed for 12 hours. Testing the alarm turned the alarm
# off — the precise failure this comment claims to prevent. The "discrimination test below"
# the comment used to cite did not exist either; it does now (--self-test), and it fails if
# any call site ever bypasses mark_red again.
mark_red() { [ "$BACKUP_NO_FILE" = 1 ] && return 0; echo "$(now_s)" >"$1"; }

file_ei() { # <title> <body> — best-effort curl-MCP; loud echo + journald are the fallback
  [ "$BACKUP_NO_FILE" = 1 ] && { log "BACKUP_NO_FILE=1 — would have filed: $1"; return 0; }
  local resp
  local -a auth_hdr=()
  if [ -n "$GATE_SUPERUSER_BEARER" ]; then
    auth_hdr=(-H "authorization: Bearer $GATE_SUPERUSER_BEARER")
  else
    log "WARN: no superuser bearer at $GATE_SUPERUSER_TOKEN_PATH — EI filing will 403; falling back to log-only."
  fi
  resp="$(curl -s -m 30 -X POST "$OPERATOR_MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${auth_hdr[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:create\",\"arguments\":{\"kind\":\"bug\",\"title\":$(jstr "$1"),\"summary\":$(jstr "$2"),\"harness\":\"papercusp\",\"severity\":\"critical\",\"topics\":[\"backup\",\"data-safety\",\"host-health\"]}}}" 2>/dev/null || true)"
  local id_match
  id_match="$(printf '%s' "$resp" | grep -oaE '\\?"id\\?":\\?"WI-[0-9]+' | head -1)"
  if [ -n "$id_match" ]; then
    log "EI filed OK → $(printf '%s' "$id_match" | grep -oaE 'WI-[0-9]+')"
  else
    log "EI filing DID NOT CONFIRM (no WI id in response) — resp head: ${resp:0:200}"
  fi
}

# ── SELF-TEST: prove the alarm DISCRIMINATES (EI-10746) ────────────────────
# The comment on mark_red() used to cite "the discrimination test below". There was no
# test. Both bugs it would have caught were live. So: this is that test, and it asserts
# the two independent failure modes plus the two ways the fix could over-correct.
#
# The observable is the RED MARKER, because the marker IS the alarm's memory: writing it
# on a run that filed nothing is what silently disarms the next real red for 12h.
# No real EI is ever filed here — the force case points OPERATOR_MCP_URL at a dead port,
# so the filing PATH runs (and marks) while the filing itself harmlessly fails.
#
# Run:  apps/operator/scripts/papercup-backup-health-check.sh --self-test
if [ "${1:-}" = "--self-test" ]; then
  t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
  mkdir -p "$t/dump" "$t/state"
  self="${BASH_SOURCE[0]}"
  p=0; f=0
  # <name> <stale:yes|no> <want-marker:yes|no> [ENV=VAL ...]
  check() {
    local name="$1" stale="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state"; mkdir -p "$t/state"
    : > "$t/dump/pg-5432.sql.gz"
    if [ "$stale" = yes ]; then touch -d '10 hours ago' "$t/dump/pg-5432.sql.gz"; fi
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_HOOK_LOG="$t/no-such-hook.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        "$@" bash "$self" >/dev/null 2>&1
    local got_marker=no
    # shellcheck disable=SC2144
    [ -f "$t"/state/stale-* ] && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  echo "papercup-backup-health-check.sh --self-test — EI-10746 alarm discrimination"
  # 1. THE DEAD-GUARD BUG: a dry-run files no EI, so it must not write the marker either.
  #    Before the fix it DID — silently disarming the next real red for BACKUP_RED_REFILE_H.
  check "dry-run on a RED does NOT write the marker (cannot disarm the real alarm)" \
        yes no  BACKUP_NO_FILE=1
  # 2. THE FALSE-ALARM BUG: overriding a threshold is a TEST — it must not file or mark.
  check "threshold override on a RED auto-suppresses (no file, no marker)" \
        yes no  BACKUP_MAX_AGE_H=1
  # 3. NOT A MUTE BUTTON: the alarm must still be able to fire when forced.
  check "threshold override + BACKUP_ALERT_FORCE=1 DOES take the filing path" \
        yes yes BACKUP_MAX_AGE_H=1 BACKUP_ALERT_FORCE=1
  # 4. NOT A HAIR-TRIGGER: a fresh artifact on production defaults is green and silent.
  check "fresh artifact, production defaults: green, no marker" \
        no  no
  printf '  ---- %d passed, %d failed\n' "$p" "$f"
  [ "$f" -eq 0 ] || exit 1
  exit 0
fi

# ── (a) FRESHNESS — judge the ARTIFACT, not the log ────────────────────────
# Deliberately artifact-based: a rotated/truncated hook.log must never make a dead
# backup look healthy. An artifact that stopped advancing IS the failure, whatever
# the log says.
for art in $BACKUP_ARTIFACTS; do
  f="$BACKUP_DUMP_DIR/$art"
  if [ ! -f "$f" ]; then
    TITLE="DB backup artifact MISSING: $art (no dump has ever succeeded at $BACKUP_DUMP_DIR)"
    BODY="EI-10733 durable backup-health probe: expected dump artifact '$f' does not exist at all. There is NO recoverable database dump. Check ~/.config/kopia/hooks/pre-snapshot.sh and $BACKUP_HOOK_LOG."
    RED_MARKER="$STATE_DIR/missing-$art"
    if [ "$(age_h "$RED_MARKER")" -lt "$BACKUP_RED_REFILE_H" ]; then
      log "RED already tracked (missing $art) — skipping duplicate filing."
    else
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
    continue
  fi
  mtime="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)"
  age_hours=$(( ( $(now_s) - mtime ) / 3600 ))
  size="$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)"
  log "artifact $art: age ${age_hours}h, size ${size}B (max age ${BACKUP_MAX_AGE_H}h)"
  RED_MARKER="$STATE_DIR/stale-$art"
  if [ "$age_hours" -ge "$BACKUP_MAX_AGE_H" ] 2>/dev/null; then
    TITLE="DB backup is STALE: $art is ${age_hours}h old (>= ${BACKUP_MAX_AGE_H}h threshold) — we may have no recoverable database"
    BODY="EI-10733 durable backup-health probe: '$f' has not advanced in ${age_hours} hours (size ${size}B). The DB dump is supposed to run ~hourly.

THIS IS THE SIGNAL THAT WAS MISSING. On 2026-07-12 the backup had been failing 100% for ~30 DAYS (newest good dump 2026-06-12) and nothing detected it, because a plausible-looking 1.4GB .gz sat on disk the whole time. 'The backup file exists' is not 'the backup works' — only its FRESHNESS discriminates.

LIKELY CAUSES (check in this order):
 1. The dump is exceeding its timeout. If the DB has grown, DB_DUMP_TIMEOUT in ~/.config/kopia/hooks/pre-snapshot.sh may again be too small — the ORIGINAL bug was 'timeout 60' against a 1.4GB dump. Look for 'pg-5432 FAIL' in $BACKUP_HOOK_LOG and any pg_dumpall error appended there. DO NOT blindly raise the timeout without reading the actual error.
 2. An orphaned pg_dump is holding locks (the EI-10730 knock-on): check for a pg_dump whose parent is dead (PPID 1/systemd). pre-snapshot.sh's reap_orphan_dumps() should terminate these — verify it is still present and running.
 3. The kopia-snapshots timer/service is not firing at all: systemctl --user list-timers kopia-snapshots.timer
 4. Disk full on the backup volume: df -h $BACKUP_DUMP_DIR

An orphaned/stuck dump is not just a dead backup — it holds AccessShareLock on ~593 tables, which starves every migration's ACCESS EXCLUSIVE and can wedge the whole release pipeline (EI-10730)."
    if [ "$(age_h "$RED_MARKER")" -lt "$BACKUP_RED_REFILE_H" ]; then
      log "RED already tracked (stale $art, filed $(age_h "$RED_MARKER")h ago < ${BACKUP_RED_REFILE_H}h) — skipping duplicate filing."
    else
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
  else
    rm -f "$RED_MARKER"
  fi
done

# ── (b) CONSECUTIVE FAILURES in the hook log ───────────────────────────────
# Fires EARLY — within an hour or two of breakage — instead of waiting for the artifact
# to age past the freshness bar. Counts the TRAILING run of FAILs: any "ok" resets it, so
# a single transient failure never alarms, but a persistently broken dump does.
if [ ! -f "$BACKUP_HOOK_LOG" ]; then
  log "SKIP consecutive-fail probe: no hook log at $BACKUP_HOOK_LOG"
else
  # Walk the tail newest→oldest; count FAILs until the first ok. "skip" lines are neutral
  # (the cadence guard legitimately skips when a dump is still fresh) and must not reset
  # the streak NOR count as failures.
  TRAILING_FAILS="$(tac "$BACKUP_HOOK_LOG" 2>/dev/null | grep -aE 'pg-[0-9]+ (ok|FAIL)' | awk '
    /FAIL/ { n++; next }
    /ok/   { exit }
    { next }
    END { print n+0 }')"
  TRAILING_FAILS="${TRAILING_FAILS:-0}"
  log "hook log: $TRAILING_FAILS trailing FAIL(s) with no intervening ok (threshold $BACKUP_MAX_FAILS)"
  RED_MARKER="$STATE_DIR/consecutive-fails"
  if [ "$TRAILING_FAILS" -ge "$BACKUP_MAX_FAILS" ] 2>/dev/null; then
    TITLE="DB backup has FAILED $TRAILING_FAILS times consecutively with no success — backups are broken"
    BODY="EI-10733 durable backup-health probe: $BACKUP_HOOK_LOG shows $TRAILING_FAILS consecutive 'FAIL' entries with no intervening 'ok' (threshold $BACKUP_MAX_FAILS).

This fires EARLY, before the artifact ages past the freshness bar — precisely so a broken backup is caught in hours, not the 30 DAYS it went unnoticed on 2026-07-12 (EI-10733).

Read the pg_dumpall error appended to $BACKUP_HOOK_LOG. The original root cause was 'timeout 60' against a 1.4GB dump: the dump was SIGTERMed mid-stream every cycle and its orphaned pg_dump child was left holding AccessShareLock on ~593 tables, which then wedged the release pipeline for 9h (EI-10730). DO NOT simply raise the timeout without reading the actual error — and check for orphaned pg_dump backends (pre-snapshot.sh's reap_orphan_dumps)."
    if [ "$(age_h "$RED_MARKER")" -lt "$BACKUP_RED_REFILE_H" ]; then
      log "RED already tracked (consecutive fails) — skipping duplicate filing."
    else
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
  else
    rm -f "$RED_MARKER"
  fi
fi

exit 0
