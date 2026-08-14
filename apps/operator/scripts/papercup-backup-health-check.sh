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
# THREE independent signals, any can fire:
#   (a) FRESHNESS — the newest dump artifact is older than BACKUP_MAX_AGE_H. This is
#       the signal that would have caught the 30-day death on day one. It holds even if
#       the run log has been rotated away, because it judges the ARTIFACT, not the log.
#   (b) CONSECUTIVE FAILURES — db-backup.log's tail shows >= BACKUP_MAX_FAILS "backup
#       FAILED" runs with no intervening "backup OK". This fires EARLY (within an hour or
#       two of the breakage) rather than waiting for the artifact to age past the freshness
#       bar, and it catches the case where an artifact is fresh but a LATER dump began failing.
#   (c) STRANDED TMP — a "*.tmp" pg_dump staging directory under BACKUP_DUMP_DIR/pg/ older
#       than BACKUP_STALE_TMP_MAX_H. This is the recurrence guard for EI-18678678853631218
#       (2026-07-26): a failed pg_dump -Fd leaves a 0700 postgres-owned "$db.tmp" that a
#       service-user `rm -rf` cannot remove on the failure path. Because pg_dump -Fd refuses
#       a non-empty target, ONE stranded .tmp silently fails every subsequent hourly run for
#       that database forever — (a) and (b) both eventually catch that (the artifact goes
#       stale / the log fills with FAILs), but this signal names the ACTUAL mechanism
#       directly instead of making the on-call rediscover it from a generic staleness alarm.
#       db-backup.sh's own rm_tmp() now falls back to `sudo -n rm -rf` and should prevent
#       this from ever recurring — this check is the independent verifier that it did.
#   (d) POSTGRES DATA-VOLUME HEADROOM — the filesystem containing BACKUP_DB_DATA_DIR is
#       at/above BACKUP_DISK_WARN_PCT. This catches a shared root volume approaching ENOSPC
#       before PostgreSQL loses the ability to write WAL, locks, or its own data directory.
#
# CONVERGED 2026-07-12 (EI-10733): the backup path is now db-backup.sh (pg_dump -Fd -j,
# per-DB, TOC-validated) — NOT the old pre-snapshot.sh `timeout 60 pg_dumpall | gzip`
# that produced pg-5432.sql.gz. This probe was repointed at db-backup.sh's artifacts +
# run log accordingly; the signal design is unchanged, only what it judges.
#
# DETECTION + ESCALATION ONLY — this script never re-runs a dump, kills a process, or
# touches the backup config. Recovery is a human/agent call made off the filed EI. Same
# posture as papercup-dht-liveness-check.sh (EI-8892) and papercup-fedplane-disk-health-check.sh
# (EI-8982): a health check must not also hold mutate authority over what it judges
# (EI-8901's lesson — a threshold bug then becomes a self-inflicted incident).
#
# Usage: papercup-backup-health-check.sh
# Env:
#   BACKUP_DUMP_DIR      (default /mnt/data/Backup/db-dumps) — where the dumps land
#   BACKUP_ARTIFACTS     (default "pg/papercusp pg/restart") — space-separated dump artifacts
#                                                              (relative to BACKUP_DUMP_DIR) that
#                                                              MUST stay fresh. These are the
#                                                              per-DB pg_dump -Fd directories
#                                                              db-backup.sh renames into place
#                                                              ONLY after a chown + pg_restore -l
#                                                              validation, so a fresh dir mtime
#                                                              means a *verified* dump — the
#                                                              faithful successor to the old
#                                                              single pg-5432.sql.gz. papercusp
#                                                              (23GB) + restart (4.6GB) are the
#                                                              real-state DBs; papercusp_su /
#                                                              postgres are tiny/derived and
#                                                              deliberately not gated.
#   BACKUP_OPTIONAL_ARTIFACTS (default "$HOME/.papercusp-workspaces/*/db-dumps/pg-embedded.sql.gz")
#                                     — artifacts gated on FRESHNESS but not on EXISTENCE, and
#                                       allowed to be ABSOLUTE paths (these live beside each
#                                       workspace, not under BACKUP_DUMP_DIR). Absent ⇒ silent
#                                       (a box with no workspace backups is not broken);
#                                       present but stale ⇒ same alarm as any other artifact.
#                                       EI-20109034777197353 recurrence guard: the workspace
#                                       pre-snapshot pg_dump died and went unnoticed for 26h
#                                       precisely because NO probe watched its artifact — the
#                                       snapshot ledger said status='ok' the whole time.
#   BACKUP_MAX_AGE_H     (default 6)   — artifact older than this ⇒ alarm (dumps run ~hourly)
#   BACKUP_MAX_FAILS     (default 3)   — this many trailing FAILED runs with no "OK" ⇒ alarm
#   BACKUP_STALE_TMP_MAX_H (default 2) — a "*.tmp" pg_dump staging dir under
#                                        BACKUP_DUMP_DIR/pg/ older than this ⇒ alarm
#                                        (EI-18678678853631218 recurrence guard — see above)
#   BACKUP_DB_DATA_DIR     (default /var/lib/postgresql/18/main) — a path on the PostgreSQL
#                                        data filesystem whose usage should be monitored
#   BACKUP_DISK_WARN_PCT   (default 90)  — usage percentage at/above which the PostgreSQL
#                                        data-volume headroom alarm fires
#   BACKUP_HOOK_LOG      (default $BACKUP_DUMP_DIR/db-backup.log) — db-backup.sh's run log
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
   && { [ -n "${BACKUP_MAX_AGE_H+x}" ] || [ -n "${BACKUP_MAX_FAILS+x}" ] || [ -n "${BACKUP_STALE_TMP_MAX_H+x}" ] || [ -n "${BACKUP_DISK_WARN_PCT+x}" ]; } \
   && [ "${BACKUP_NO_FILE:-0}" != 1 ]; then
  echo "[backup-health] ALARM SUPPRESSED: a threshold was overridden (BACKUP_MAX_AGE_H/BACKUP_MAX_FAILS/BACKUP_STALE_TMP_MAX_H/BACKUP_DISK_WARN_PCT) — that is a TEST run, not production. Forcing BACKUP_NO_FILE=1 (no EI will be filed). Set BACKUP_ALERT_FORCE=1 to file anyway." >&2
  BACKUP_NO_FILE=1
fi

BACKUP_DUMP_DIR="${BACKUP_DUMP_DIR:-/mnt/data/Backup/db-dumps}"
BACKUP_ARTIFACTS="${BACKUP_ARTIFACTS:-pg/papercusp pg/restart}"
# Unquoted on purpose at the loop below so the glob expands per workspace; an
# unmatched glob stays literal, which then reads as "absent" and is silent.
#
# `-` not `:-` deliberately: an explicitly EMPTY value must mean "gate nothing",
# not "use the default". With `:-` the two are indistinguishable, so a caller
# that opts out (the self-test does exactly this) silently gets the default set
# back — and here that default points at a REAL artifact on the host, which made
# an isolated test case judge live state. Caught by self-test case 4.
BACKUP_OPTIONAL_ARTIFACTS="${BACKUP_OPTIONAL_ARTIFACTS-$HOME/.papercusp-workspaces/*/db-dumps/pg-embedded.sql.gz}"
BACKUP_MAX_AGE_H="${BACKUP_MAX_AGE_H:-6}"
BACKUP_MAX_FAILS="${BACKUP_MAX_FAILS:-3}"
BACKUP_STALE_TMP_MAX_H="${BACKUP_STALE_TMP_MAX_H:-2}"
BACKUP_DB_DATA_DIR="${BACKUP_DB_DATA_DIR:-/var/lib/postgresql/18/main}"
BACKUP_DISK_WARN_PCT="${BACKUP_DISK_WARN_PCT:-90}"
BACKUP_HOOK_LOG="${BACKUP_HOOK_LOG:-$BACKUP_DUMP_DIR/db-backup.log}"
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

# ── (d) POSTGRES DATA-VOLUME HEADROOM ─────────────────────────────────────
# `df -Pk TARGET` is portable across GNU/Linux and macOS. Parse the explicit
# NN% field instead of assuming a fixed column: a mount path containing spaces
# can shift the final field, while the percentage token remains unambiguous.
#
# ── WHY A TREND (WI-38595, 2026-08-14) ───────────────────────────────────
# A LEVEL alone is not actionable, and this alarm proved it: WI-38595 was filed
# at 90%, sat unclaimed 19.4h, and was found at 95% — ~104 GiB gone in the gap.
# Nothing on the item said the volume was STILL FALLING, so a genuine "~17h to
# ENOSPC, fleet-wide Postgres outage" read like a chronic "disk is fullish"
# warning. The DERIVATIVE is what turns this alarm into a deadline.
#
# It is also the only thing we can afford. A `du` of a multi-TiB shared root
# volume is ~7 MINUTES of heavy IO (measured on this box), so a probe that runs
# hourly must not scan for consumers — but remembering each df reading is O(1).
# Hence: report the rate we get for free, and hand over the scan RECIPE for the
# receiving agent to run ONCE, instead of scanning on every tick.
#
# The trend deliberately does NOT go in the title. work_items:create dedupes on
# admissionIdentity(title).titleKey (_create-core.ts), so a title carrying a
# changing "~17h to full" would mint a BRAND NEW item on every refile instead of
# deduping onto the open one. Keep the title stable; put the varying part here.
disk_trend_line() { # <avail_kb> — echoes ONE human line. Never fails, never blocks the alarm.
  local avail_kb="${1:-}" hist="$STATE_DIR/db-disk-history" now="" line_count=0
  now="$(now_s)"
  [[ "$avail_kb" =~ ^[0-9]+$ ]] || { echo "trend: unavailable (available-space field unparseable)"; return 0; }
  # Append BEFORE reading, so even a first-ever run leaves a baseline for the next.
  printf '%s %s\n' "$now" "$avail_kb" >>"$hist" 2>/dev/null || true
  line_count="$(wc -l <"$hist" 2>/dev/null || echo 0)"
  if [ "${line_count:-0}" -gt 240 ] 2>/dev/null; then
    { tail -n 240 "$hist" >"$hist.tmp" 2>/dev/null && mv "$hist.tmp" "$hist" 2>/dev/null; } || true
  fi
  # A malformed/garbage history must degrade to "no baseline", never to a wrong number.
  awk -v now="$now" -v cur="$avail_kb" '
    /^[0-9]+ [0-9]+$/ && $1 < now { if (oldest == 0 || $1 < oldest) { oldest = $1; oldest_avail = $2 } }
    END {
      if (oldest == 0) { print "trend: no prior sample yet (this run seeds the baseline)"; exit }
      span_h = (now - oldest) / 3600.0
      if (span_h < 0.5) { printf "trend: baseline too recent (%dm) to extrapolate\n", int(span_h * 60); exit }
      lost_kb = oldest_avail - cur
      rate = lost_kb / 1048576.0 / span_h
      if (rate <= 0.01) {
        printf "trend: NOT shrinking over the last %.1fh (free space changed %+.1f GiB)\n", span_h, -lost_kb / 1048576.0
        exit
      }
      printf "trend: losing %.2f GiB/h over the last %.1fh — ETA TO FULL ~%.0fh at this rate\n", rate, span_h, (cur / 1048576.0) / rate
    }
  ' "$hist" 2>/dev/null || echo "trend: unavailable"
}

check_db_disk_headroom() {
  local df_line="" disk_pct="" red_marker="" avail_kb="" trend=""
  if [ -e "$BACKUP_DB_DATA_DIR" ]; then
    df_line="$(df -Pk "$BACKUP_DB_DATA_DIR" 2>/dev/null | tail -n1)"
    disk_pct="$(printf '%s' "$df_line" | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) print $i}' | tr -d '%' | tail -n1)"
    # Available is the field immediately BEFORE the capacity token — located the
    # same way as disk_pct above, so a mount path containing spaces cannot shift it.
    avail_kb="$(printf '%s' "$df_line" | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { print $(i - 1); exit }}')"
  fi

  if [ -z "$disk_pct" ]; then
    log "SKIP disk-headroom probe: could not resolve usage% for '$BACKUP_DB_DATA_DIR' (path missing or df output unparseable)."
    return 0
  fi
  if ! [[ "$disk_pct" =~ ^[0-9]+$ ]] || ! [[ "$BACKUP_DISK_WARN_PCT" =~ ^[0-9]+$ ]] || [ "$BACKUP_DISK_WARN_PCT" -gt 100 ] 2>/dev/null; then
    log "SKIP disk-headroom probe: invalid usage/threshold (usage='$disk_pct', threshold='$BACKUP_DISK_WARN_PCT')."
    return 0
  fi

  # Sample on EVERY run, green included — a baseline that only starts accumulating
  # once the volume is already red can never produce a rate when one is needed.
  trend="$(disk_trend_line "$avail_kb")"
  log "Postgres data-volume usage at $BACKUP_DB_DATA_DIR: ${disk_pct}% (warn threshold ${BACKUP_DISK_WARN_PCT}%) | ${trend}"
  red_marker="$STATE_DIR/db-disk-red-ei-filed"
  if [ "$disk_pct" -ge "$BACKUP_DISK_WARN_PCT" ]; then
    local host
    host="$(hostname 2>/dev/null || echo unknown-host)"
    local title="Postgres data-volume disk usage ${disk_pct}% (>= ${BACKUP_DISK_WARN_PCT}% threshold) on ${host}"
    # Real newlines, not literal "\n": the body is JSON-encoded by jstr(), so a
    # backslash-n survived into the stored summary and rendered as the two
    # characters \n to every agent that read it.
    local body="EI-20115751074601731 durable disk-headroom probe: the filesystem containing PostgreSQL data path '$BACKUP_DB_DATA_DIR' is ${disk_pct}% used (warn threshold ${BACKUP_DISK_WARN_PCT}%). A full shared root volume takes PostgreSQL down fleet-wide by preventing WAL, lock, and data-directory writes.

${trend}

ACTION: inspect current filesystem consumers and free space before starting disk-heavy work. This probe is detection-only; it never deletes files or restarts PostgreSQL.

df output:
${df_line}

INVESTIGATION RECIPE (verified while working WI-38595, 2026-08-14 — each of these four traps cost real time):
1. PostgreSQL is usually NOT the consumer, despite this alarm's title. The probe watches the VOLUME holding PGDATA, and that volume is shared with \$HOME. Measured on this box: PGDATA was 34 GiB of a 1.9 TiB volume (1.8%), while VM disk images were 566 GiB (37%). Size PGDATA with 'sudo -n du -xsh $BACKUP_DB_DATA_DIR' — an unprivileged du prints a SILENT '4.0K' (permission denied) rather than an error, which reads as 'Postgres is tiny' for the wrong reason.
2. CONFIRM WHICH VOLUME a directory is on before reclaiming anything: 'findmnt -T <path>' or 'stat -c %d <path>'. On this box /tmp is a BIND MOUNT from a second physical disk, so deleting 136 GiB of stale /tmp scratch frees exactly nothing on the volume this alarm is about.
3. Enumerate consumers in ONE bounded backgrounded pass: 'nice -n 19 ionice -c3 du -x -d3 / | sort -hr > /tmp/scan-1.txt' (~7 min here). Re-run it later into scan-2.txt and DIFF the two — a diff of two snapshots is the only reliable attribution of NET growth per directory.
4. Do NOT attribute growth by mtime ('find -newermt'). It counts a file's WHOLE size when the file is merely touched, so a single live VM image reads as hundreds of GiB 'written' in 26h. Note also that qcow2 images grow monotonically and never return space the guest frees — and the .img suffix lies, so check the magic ('QFI\\373' = qcow2)."
    if [ "$(age_h "$red_marker")" -lt "$BACKUP_RED_REFILE_H" ]; then
      log "RED already tracked (Postgres data volume, filed $(age_h "$red_marker")h ago < ${BACKUP_RED_REFILE_H}h) — skipping duplicate filing."
    else
      file_ei "$title" "$body"
      mark_red "$red_marker"
    fi
  else
    rm -f "$red_marker"
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
    rm -rf "${t:?}/state" "$t/dump/pg"; mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart"
    # A directory artifact, matching db-backup.sh's pg_dump -Fd output shape.
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    if [ "$stale" = yes ]; then touch -d '10 hours ago' "$t/dump/pg/papercusp" "$t/dump/pg/restart"; fi
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        "$@" bash "$self" >/dev/null 2>&1
    # BACKUP_ARTIFACTS can name several dumps, so a red writes one stale-* marker PER
    # artifact — glob-match ANY of them (a bare `[ -f state/stale-* ]` errors with
    # "binary operator expected" the moment the glob expands to >1 file).
    local got_marker=no
    compgen -G "$t/state/stale-*" >/dev/null 2>&1 && got_marker=yes
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

  # ── EI-18678678853631218 recurrence guard: signal (c), stranded .tmp ──────
  # A separate helper (not `check`, which fixes the pg/<db> shape) so a stranded .tmp is
  # exercised independently of the freshness artifacts above.
  check_tmp() {
    local name="$1" stale="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg"; mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/dump/pg/papercusp.tmp"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    if [ "$stale" = yes ]; then touch -d '3 hours ago' "$t/dump/pg/papercusp.tmp"; fi
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        "$@" bash "$self" >/dev/null 2>&1
    local got_marker=no
    [ -f "$t/state/stale-tmp" ] && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  # 5. A .tmp older than the threshold fires (dry-run: marker still withheld, per bug #1's rule).
  check_tmp "stranded .tmp older than threshold on a REAL run: marker set" \
        yes yes BACKUP_ALERT_FORCE=1
  check_tmp "stranded .tmp older than threshold, dry-run: NO marker" \
        yes no  BACKUP_NO_FILE=1
  # 6. A fresh .tmp (still within one cycle — a dump legitimately in progress) is silent.
  check_tmp "fresh .tmp (in-progress dump), production defaults: green, no marker" \
        no  no
  printf '  ---- %d passed, %d failed (post stranded-tmp block)\n' "$p" "$f"

  # ── EI-20109034777197353 recurrence guard: the WORKSPACE dump artifact ────
  # The workspace pre-snapshot pg_dump died and nobody noticed for 26 HOURS,
  # because no probe watched its artifact — it lives outside BACKUP_DUMP_DIR,
  # and the only surface that mentioned it (backup_snapshots.status) said 'ok'
  # the entire time. It is gated on FRESHNESS but not EXISTENCE: a box with no
  # workspace backup is not broken, but one whose dump stopped advancing is.
  check_optional() {
    local name="$1" mode="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/ws"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/ws"
    # Required artifacts stay FRESH so any marker can only come from the optional one.
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    local opt="$t/ws/pg-embedded.sql.gz"
    case "$mode" in
      absent) rm -f "$opt" ;;
      fresh)  : > "$opt" ;;
      stale)  : > "$opt"; touch -d '26 hours ago' "$opt" ;;
    esac
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/no-db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="$opt" \
        "$@" bash "$self" >/dev/null 2>&1
    local got_marker=no
    compgen -G "$t/state/stale-*" >/dev/null 2>&1 && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  # 7. THE INCIDENT ITSELF: a workspace dump 26h stale must alarm.
  check_optional "optional artifact 26h STALE (the EI-20109034777197353 incident): marker set" \
        stale  yes
  # 8. NOT gated on existence — a box that never ran a workspace backup is silent.
  check_optional "optional artifact ABSENT: silent (never-backed-up workspace is not a fault)" \
        absent no
  # 9. NOT a hair-trigger: a current workspace dump is green.
  check_optional "optional artifact FRESH: green, no marker" \
        fresh  no
  printf '  ---- %d passed, %d failed (post optional-artifact block)\n' "$p" "$f"

  # ── EI-20115751074601731 recurrence guard: PostgreSQL data-volume headroom ──
  # Use a real temporary directory so the test exercises the portable `df -Pk`
  # parser without depending on the host's current root-volume usage. Threshold
  # overrides are explicitly forced for the RED leg; the alarm-safety guard above
  # must still suppress a dry-run and leave no dedupe marker behind.
  check_disk() {
    local name="$1" path_mode="$2" want_marker="$3"; shift 3
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/db-data"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart"
    [ "$path_mode" = present ] && mkdir -p "$t/db-data"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" \
        "$@" bash "$self" >/dev/null 2>&1
    local got_marker=no
    [ -f "$t/state/db-disk-red-ei-filed" ] && got_marker=yes
    if [ "$got_marker" = "$want_marker" ]; then
      printf '  ok    %s (marker=%s)\n' "$name" "$got_marker"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted marker=%s, got marker=%s\n' "$name" "$want_marker" "$got_marker"; f=$((f+1))
    fi
  }
  # 10. A threshold-forced red takes the filing path and writes its dedupe marker.
  check_disk "Postgres data volume over threshold: marker set" \
        present yes BACKUP_DISK_WARN_PCT=0 BACKUP_ALERT_FORCE=1
  # 11. A dry-run red must not disarm the next real alarm.
  check_disk "Postgres data volume red in dry-run: no marker" \
        present no BACKUP_DISK_WARN_PCT=0 BACKUP_NO_FILE=1
  # 12. A host without the native PostgreSQL path is skipped, not a false alarm.
  check_disk "Postgres data path absent: probe skipped" \
        missing no

  # ── WI-38595 recurrence guard: the disk TREND ────────────────────────────
  # The bug this alarm actually had was not a crash — it was reporting a LEVEL
  # with no derivative, so a volume falling ~5 GiB/h read the same as a stable
  # one and sat 19.4h. The trend fixes that, which means the trend itself now
  # gets read as a deadline. So the thing to guard is not "does it print" but
  # "can it print a number it has not earned": one sample, a too-recent
  # baseline, or a corrupt history must all degrade to an explicit no-baseline
  # message, NEVER to a fabricated rate or ETA.
  check_trend() {
    local name="$1" seed="$2" want_re="$3" out=""
    rm -rf "${t:?}/state" "$t/dump/pg" "$t/db-data"
    mkdir -p "$t/state" "$t/dump/pg/papercusp" "$t/dump/pg/restart" "$t/db-data"
    : > "$t/dump/pg/papercusp/toc.dat"; : > "$t/dump/pg/restart/toc.dat"
    [ -n "$seed" ] && printf '%s\n' "$seed" > "$t/state/db-disk-history"
    out="$(env BACKUP_DUMP_DIR="$t/dump" BACKUP_STATE_DIR="$t/state" \
        BACKUP_DB_DATA_DIR="$t/db-data" \
        BACKUP_HOOK_LOG="$t/no-such-log.log" \
        OPERATOR_MCP_URL="http://127.0.0.1:9/dead" \
        BACKUP_OPTIONAL_ARTIFACTS="" BACKUP_NO_FILE=1 \
        bash "$self" 2>&1 >/dev/null)"
    if printf '%s' "$out" | grep -qE "$want_re"; then
      printf '  ok    %s\n' "$name"; p=$((p+1))
    else
      printf '  FAIL  %s — wanted /%s/ in probe output, got: %s\n' \
        "$name" "$want_re" "$(printf '%s' "$out" | grep -i 'data-volume usage' | head -1)"; f=$((f+1))
    fi
  }
  # Anchor the synthetic history to the REAL current free space, so the expected
  # rate is exact rather than dependent on whatever this host happens to have.
  trend_now_s="$(date +%s)"
  trend_avail_kb="$(df -Pk "$t" 2>/dev/null | tail -n1 | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { print $(i - 1); exit }}')"
  # 13. No history at all: seeds a baseline and says so — no rate from one sample.
  check_trend "trend with no prior sample: seeds baseline, invents no rate" \
        "" "no prior sample yet"
  # 14. A 2h-old baseline with 10 GiB more free space = losing exactly 5 GiB/h.
  check_trend "trend over a 2h baseline: reports the rate AND an ETA" \
        "$((trend_now_s - 7200)) $((trend_avail_kb + 10485760))" \
        "losing 5\.0[0-9] GiB/h .* ETA TO FULL ~[0-9]+h"
  # 15. Space FREED must never render as a countdown to full.
  check_trend "trend when the volume is recovering: NOT shrinking, no ETA" \
        "$((trend_now_s - 7200)) $((trend_avail_kb - 10485760))" \
        "NOT shrinking"
  # 16. A corrupt history degrades to no-baseline, not to a garbage rate.
  check_trend "trend with a corrupt history: degrades to no-baseline" \
        "not-a-timestamp garbage" "no prior sample yet"
  # 17. A baseline minutes old cannot support an hourly extrapolation.
  check_trend "trend with a 6-minute baseline: refuses to extrapolate" \
        "$((trend_now_s - 360)) $((trend_avail_kb + 10485760))" \
        "baseline too recent"
  printf '  ---- %d passed, %d failed (post disk-headroom block)\n' "$p" "$f"
  [ "$f" -eq 0 ] || exit 1
  exit 0
fi

# Check the PostgreSQL data filesystem before the artifact probes. A shared root
# volume can take PostgreSQL down even while every backup artifact is still fresh.
check_db_disk_headroom

# ── (a) FRESHNESS — judge the ARTIFACT, not the log ────────────────────────
# Deliberately artifact-based: a rotated/truncated hook.log must never make a dead
# backup look healthy. An artifact that stopped advancing IS the failure, whatever
# the log says.
# Required artifacts first, then the optional ones. The sentinel flips the mode
# mid-loop: membership testing cannot be used here because the optional list is
# a GLOB that expands during this very word-split, so an expanded path would no
# longer match the pattern it came from.
ART_OPTIONAL=0
for art in $BACKUP_ARTIFACTS __OPTIONAL_ARTIFACTS_FOLLOW__ $BACKUP_OPTIONAL_ARTIFACTS; do
  if [ "$art" = __OPTIONAL_ARTIFACTS_FOLLOW__ ]; then ART_OPTIONAL=1; continue; fi
  # Absolute entries are used as-is (workspace dumps live outside BACKUP_DUMP_DIR);
  # relative ones hang off it, as they always have.
  case "$art" in /*) f="$art" ;; *) f="$BACKUP_DUMP_DIR/$art" ;; esac
  # -e not -f: db-backup.sh's artifacts are pg_dump -Fd DIRECTORIES, not single files.
  if [ ! -e "$f" ]; then
    # An optional artifact that does not exist is not a fault: the workspace may
    # simply never have been backed up. Only its going STALE is a signal.
    if [ "$ART_OPTIONAL" = 1 ]; then
      log "artifact $art: absent (optional — not gated on existence)"
      continue
    fi
    TITLE="DB backup artifact MISSING: $art (no dump has ever succeeded at $BACKUP_DUMP_DIR)"
    BODY="EI-10733 durable backup-health probe: expected dump artifact '$f' does not exist at all. There is NO recoverable database dump. Check ~/.config/kopia/db-backup.sh, its timer (systemctl --user status papercusp-db-backup.timer), and $BACKUP_HOOK_LOG."
    RED_MARKER="$STATE_DIR/missing-${art//\//-}"   # art may contain '/' (pg/papercusp) — flatten for the filename
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
  RED_MARKER="$STATE_DIR/stale-${art//\//-}"   # flatten '/' in the artifact path for the marker filename
  if [ "$age_hours" -ge "$BACKUP_MAX_AGE_H" ] 2>/dev/null; then
    TITLE="DB backup is STALE: $art is ${age_hours}h old (>= ${BACKUP_MAX_AGE_H}h threshold) — we may have no recoverable database"
    BODY="EI-10733 durable backup-health probe: '$f' has not advanced in ${age_hours} hours (size ${size}B). The DB dump is supposed to run ~hourly.

THIS IS THE SIGNAL THAT WAS MISSING. On 2026-07-12 the backup had been failing 100% for ~30 DAYS (newest good dump 2026-06-12) and nothing detected it, because a plausible-looking 1.4GB .gz sat on disk the whole time. 'The backup file exists' is not 'the backup works' — only its FRESHNESS discriminates.

LIKELY CAUSES (check in this order):
 1. db-backup.sh's timer stopped firing: systemctl --user status papercusp-db-backup.timer papercusp-db-backup.service ; journalctl --user -u papercusp-db-backup.service -n 50. Read $BACKUP_DUMP_DIR/STATUS.json (ok / failed[] / lastSuccessEpoch) and $BACKUP_HOOK_LOG.
 2. A specific DB's dump is failing validation: db-backup.sh only renames a dump into place after pg_restore -l passes, so a per-DB 'FAIL' in db-backup.log means the archive was unreadable or the dump errored — read the actual pg_dump error there. DO NOT blindly raise PC_BACKUP_TIMEOUT_SEC without reading it.
 3. An orphaned pg_dump is holding locks (the EI-10730 knock-on): check for a pg_dump backend older than its timeout (SELECT pid, application_name, backend_start FROM pg_stat_activity WHERE application_name LIKE 'pg_dump%'). db-backup.sh tags its own dumps PGAPPNAME=pcbackup and reaps foreign ones; a lingering 'pg_dump%' backend is a legacy/manual dump.
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
  # Walk the tail newest→oldest; count FAILED runs until the first OK. db-backup.sh writes
  # exactly one per-run summary line — "backup OK in Ns: ..." or "backup FAILED in Ns: ..." —
  # so this counts RUNS, not per-DB legs. Matching is anchored to that summary token so a
  # per-DB "papercusp FAIL" line inside a run never double-counts.
  TRAILING_FAILS="$(tac "$BACKUP_HOOK_LOG" 2>/dev/null | grep -aE 'backup (OK|FAILED)' | awk '
    /backup FAILED/ { n++; next }
    /backup OK/     { exit }
    { next }
    END { print n+0 }')"
  TRAILING_FAILS="${TRAILING_FAILS:-0}"
  log "hook log: $TRAILING_FAILS trailing FAIL(s) with no intervening ok (threshold $BACKUP_MAX_FAILS)"
  RED_MARKER="$STATE_DIR/consecutive-fails"
  if [ "$TRAILING_FAILS" -ge "$BACKUP_MAX_FAILS" ] 2>/dev/null; then
    TITLE="DB backup has FAILED $TRAILING_FAILS runs consecutively with no success — backups are broken"
    BODY="EI-10733 durable backup-health probe: $BACKUP_HOOK_LOG shows $TRAILING_FAILS consecutive 'backup FAILED' runs with no intervening 'backup OK' (threshold $BACKUP_MAX_FAILS).

This fires EARLY, before the artifact ages past the freshness bar — precisely so a broken backup is caught in hours, not the 30 DAYS it went unnoticed on 2026-07-12 (EI-10733).

Read the per-DB error in $BACKUP_HOOK_LOG (db-backup.sh logs 'db FAIL (...)' per database) and $BACKUP_DUMP_DIR/STATUS.json (failed[]). db-backup.sh only accepts a dump that passes pg_restore -l, so a FAILED run means the dump errored or produced an unreadable archive — read the actual pg_dump error, do NOT blindly raise PC_BACKUP_TIMEOUT_SEC. Also check for an orphaned pg_dump backend holding AccessShareLock on ~593 tables, which can wedge the release pipeline for hours (EI-10730): SELECT pid, application_name, backend_start FROM pg_stat_activity WHERE application_name LIKE 'pg_dump%'."
    if [ "$(age_h "$RED_MARKER")" -lt "$BACKUP_RED_REFILE_H" ]; then
      log "RED already tracked (consecutive fails) — skipping duplicate filing."
    else
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
  else
    rm -f "$RED_MARKER"
  fi
fi

# ── (c) STRANDED TMP — the EI-18678678853631218 recurrence guard ───────────
# A "*.tmp" pg_dump -Fd staging directory under $BACKUP_DUMP_DIR/pg/ that survives past
# one dump cycle means the failure-path cleanup could not remove it (0700 postgres-owned,
# `rm -rf` as the service user denied) — and because pg_dump -Fd refuses a non-empty target,
# that ONE stranded .tmp silently fails every later run of that database. db-backup.sh's
# rm_tmp() now falls back to `sudo -n rm -rf`, so this should never fire; if it does, the
# fallback itself is failing (e.g. a sudoers change) and needs a human, not just a retry.
PG_DIR="$BACKUP_DUMP_DIR/pg"
if [ -d "$PG_DIR" ]; then
  STALE_TMPS="$(find "$PG_DIR" -mindepth 1 -maxdepth 1 -name '*.tmp' -mmin "+$(( BACKUP_STALE_TMP_MAX_H * 60 ))" 2>/dev/null || true)"
  RED_MARKER="$STATE_DIR/stale-tmp"
  if [ -n "$STALE_TMPS" ]; then
    log "stranded tmp(s) found (older than ${BACKUP_STALE_TMP_MAX_H}h): $STALE_TMPS"
    TITLE="DB backup has a STRANDED .tmp staging dir — a database is silently failing every run"
    BODY="EI-18678678853631218 recurrence-guard probe: the following pg_dump -Fd staging director$([ "$(printf '%s\n' "$STALE_TMPS" | grep -c .)" = 1 ] && echo y || echo ies) under '$PG_DIR' predate the current run by more than ${BACKUP_STALE_TMP_MAX_H}h:

$STALE_TMPS

pg_dump -Fd refuses to write into a non-empty target, so as long as a stale '.tmp' sits here the database it belongs to fails EVERY hourly run — silently, unless (a)/(b) above happen to also fire. This is the EI-18678678853631218 failure shape: a failed dump's 0700 postgres-owned '.tmp' cannot be removed by a plain \`rm -rf\` running as the service user on the failure path.

CHECK FIRST: db-backup.sh's rm_tmp() (added 2026-07-26) should already fall back to \`sudo -n rm -rf\` for exactly this case — if a .tmp is still stranded, that fallback itself is failing (e.g. a sudoers/NOPASSWD change, disk-full on the delete). Read \$BACKUP_DUMP_DIR/db-backup.log for 'WARN could not remove stale tmp' to confirm, then fix the sudoers/perms gap. Manual recovery: \`sudo rm -rf <path>\` once, to let the next hourly run proceed."
    if [ "$(age_h "$RED_MARKER")" -lt "$BACKUP_RED_REFILE_H" ]; then
      log "RED already tracked (stranded tmp) — skipping duplicate filing."
    else
      file_ei "$TITLE" "$BODY"; mark_red "$RED_MARKER"
    fi
  else
    rm -f "$RED_MARKER"
  fi
fi

exit 0
