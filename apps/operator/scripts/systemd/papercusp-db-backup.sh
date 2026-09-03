#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Papercusp Postgres backup — EI-10733 / EI-10730 / WI-39596
#
# This file is canonical in the Papercusp staging tree. The systemd unit points
# here directly; do not restore an untracked ~/.config/kopia/db-backup.sh copy.
#
# Replaces the pg_dumpall legs of ~/.config/kopia/hooks/pre-snapshot.sh, which
# had NOT produced a usable dump since 2026-06-12 (30 days) and whose failure
# mode simultaneously wedged the release pipeline for 9h.
#
# WHAT WENT WRONG (all one defect chain):
#   1. `timeout 60 sudo -u postgres pg_dumpall | gzip` — the cluster is 29 GB
#      (papercusp alone 23 GB). It outgrew 60s around 2026-06-12 and from then
#      on was SIGKILLed mid-stream on EVERY cycle. Backup silently dead.
#   2. `timeout` signals only its DIRECT child (sudo -> pg_dumpall). pg_dumpall
#      shells out to a per-database `pg_dump` GRANDCHILD (sh -c -- pg_dump ...)
#      which does NOT die with it. The orphan holds ACCESS SHARE on every table
#      for as long as it lives; a migration needs ACCESS EXCLUSIVE and the
#      deploy runs lock_timeout=15s, so ONE orphan blocks every migration and
#      auto-rollback wedges the release. That is how :3070 sat 9h behind main.
#   3. It ran on the 5-minute kopia snapshot cycle. Even a WORKING 29 GB dump
#      cannot fit in 5 minutes, so a naive timeout bump would just reinstate
#      near-continuous ACCESS SHARE pressure on the DB the whole fleet migrates
#      against. The cadence itself was the defect -> this runs on its own timer.
#
# HOW THIS CANNOT REGRESS THE SAME WAY:
#   * NO ORPHAN IS POSSIBLE. The grandchild does not exist by construction: we
#     never run a full pg_dumpall (only --globals-only, which spawns nothing),
#     and pg_dump's -j workers are direct children it reaps itself. And because
#     a table lock is held by the BACKEND rather than the client process,
#     terminating the backend — not the process — is what actually releases it:
#     reap_own_stragglers() does that at both ends of every run, so even a
#     SIGKILLed client cannot leave a migration-blocking lock behind.
#   * NOT REAPABLE BY MISTAKE. Every HOST connection is tagged with the exact
#     host identity `pcbackup`, while the per-workspace hook uses the distinct
#     `pcbackup-workspace` identity. Cleanup may therefore reap this producer's
#     abandoned backends without terminating a healthy workspace snapshot.
#     Neither identity matches an `application_name LIKE 'pg_dump%'` reaper.
#     An age-based reaper (EI-10730's) would otherwise terminate this dump the
#     moment it legitimately ran longer than 90s.
#   * FAILURE IS LOUD. Success/failure is recorded in STATUS.json and the
#     script exits non-zero. healthcheck.sh asserts DUMP CONTENT freshness from
#     that file — not kopia snapshot recency, which is what hid this for a
#     month (kopia dutifully re-snapshotted the same 30-day-old .sql.gz every
#     5 minutes, so the backup looked perfectly healthy at the snapshot layer
#     while the payload rotted).
#
# RESTORE:  psql -f /mnt/data/Backup/db-dumps/pg/globals.sql     (roles first)
#           pg_restore -d <db> -j4 /mnt/data/Backup/db-dumps/pg/<db>/
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# PAPERCUSP_HOST_PG_DUMP_DIR is shared with the per-workspace pre-snapshot hook
# (packages/backup/src/host-dump-coverage.ts), which reads STATUS.json from this
# same directory to decide whether its own dump would be redundant. The two
# defaults are pinned together by host-dump-coverage-defaults.test.ts — if they
# drift, the hook simply never finds a receipt and keeps dumping, so the failure
# is a silent return of the redundancy rather than a broken backup.
DUMP="${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/data/Backup/db-dumps}"
STATUS="$DUMP/STATUS.json"
LOG="$DUMP/db-backup.log"
BACKUP_USER="${USER:-$(id -un)}"
BACKUP_GROUP="$(id -gn)"
BACKUP_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
LOCK="${PC_BACKUP_LOCK:-$BACKUP_HOME/.cache/kopia/db-backup.lock}"
PSQL="sudo -n -u postgres psql -h /var/run/postgresql -d postgres -tAc"

# pg_dump runs as the `postgres` OS user (peer auth on the unix socket — there is
# no backup-service PG role, and TCP is scram-only), so IT opens the output files.
# The old hook dodged this by piping to a shell redirect, which the shell (as
# the backup service user) opened. -Fd cannot stream to stdout, and pg_dump chmods the
# directory it writes, so the target must be postgres-OWNED. This staging dir is
# owned by postgres and group-writable by the backup service user, so pg_dump can write and
# this script can still do the atomic swap. 0775 keeps it readable by kopia.
PGOUT="$DUMP/pg"
sudo -n install -d -o postgres -g "$BACKUP_GROUP" -m 0775 "$PGOUT" 2>/dev/null || true

# Our ownership tag. Keep distinct from packages/backup's
# WORKSPACE_BACKUP_APPLICATION_NAME: reap_own_stragglers() below is deliberately
# exact-owner cleanup, not a cluster-wide backup kill switch.
readonly HOST_BACKUP_APPLICATION_NAME=pcbackup
export PGAPPNAME="$HOST_BACKUP_APPLICATION_NAME"

# Generous but finite. A 29 GB parallel dump measures in minutes; this is the
# ceiling past which we declare the dump wedged rather than let it hold locks
# forever. Overridable for a one-off large restore-test.
TIMEOUT_SEC="${PC_BACKUP_TIMEOUT_SEC:-2700}"
JOBS="${PC_BACKUP_JOBS:-4}"

# ── DISK HEADROOM ───────────────────────────────────────────────────────────
# Until 2026-09-03 this script never looked at free space AT ALL, and the shape
# of a -Fd dump makes that specifically dangerous: "$out.tmp" is written
# ALONGSIDE the existing "$out" and only swapped at the very end (see the atomic
# swap below), so a run transiently needs ~2x one database's dump on disk — and
# it needs it on a volume this script shares with everything else.
#
# MEASURED FAILURE (2026-09-03, WI-2143109): /mnt/data was already 97% full when
# the hourly timer fired. papercusp.tmp reached 85 GB, free space fell 590 GB/h,
# and the volume was ~20 minutes from ZERO. Filling it does not merely fail the
# backup: /mnt/data carries the Windows VM image and Postgres' own backup tree,
# and the owner's two VMs were already stalling on 25 ms NVMe write latency with
# a 160-deep queue. The observable symptom reported by a human was "why is the
# VM so laggy", followed by a CLOCK_WATCHDOG_TIMEOUT BSOD in the guest — i.e.
# this script's missing precondition surfaced as someone else's crash.
#
# So: refuse to start without headroom, refuse a database whose own last dump
# would not fit, and abort mid-flight rather than consume the last of the disk.
# Loud failure is the point — a skipped backup is recoverable, a full volume is
# an outage. All three are overridable for a deliberate one-off restore test.
#
# ⚠ Do NOT "fix" a headroom refusal by lowering these. The refusal means the
# volume is too full for a backup to be safe; the repair is to reclaim space.
PC_BACKUP_MIN_FREE_GB="${PC_BACKUP_MIN_FREE_GB:-120}"   # hard floor: never go below this
PC_BACKUP_SPACE_SAFETY="${PC_BACKUP_SPACE_SAFETY:-140}" # % of last dump size to require free
PC_BACKUP_WATCH_SEC="${PC_BACKUP_WATCH_SEC:-15}"        # mid-flight free-space poll interval

# Free GiB on the volume that actually holds the dumps. Reads $PGOUT rather than
# a hardcoded path so an overridden PAPERCUSP_HOST_PG_DUMP_DIR is measured on
# ITS OWN filesystem — a guard that measures the wrong volume is worse than no
# guard, because it reports headroom that does not exist where we are writing.
fs_avail_gb() {
  local kb
  kb=$(df --output=avail -k "$PGOUT" 2>/dev/null | tail -1 | tr -d '[:space:]')
  [ -n "$kb" ] || { echo 0; return; }   # unreadable df ⇒ report 0 ⇒ fail closed
  echo $(( kb / 1048576 ))
}

# Databases that are NOT real state: per-test, scratch, repro, e2e, gym fixtures.
# Deny-list (not an allow-list) so a genuinely new production DB is picked up
# automatically instead of being silently skipped.
EXCLUDE_RE='(_test$|_e2e|^e2e|^repro_|scratch|restore_check|gym_smoke|^template)'

mkdir -p "$DUMP" "$(dirname "$LOCK")"
log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG" >&2; }

# Single instance. A backup still running when the next timer fires must not be
# joined by a second one (that is WI-3550's overlap failure, on a bigger job).
exec 9>"$LOCK"
if ! flock -n 9; then
  log "skipped: previous backup still running"
  exit 0
fi

renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true

# ── pre-flight headroom gate ────────────────────────────────────────────────
# Before anything is written. Deliberately exits NON-ZERO and does NOT touch
# STATUS.json: healthcheck.sh asserts dump-content freshness from that file, so
# leaving it stale is what makes a refused backup visible as an aging dump
# rather than a fresh-looking success. Writing a "skipped" receipt here would
# hide exactly the condition an operator needs to see.
PC_FREE_GB=$(fs_avail_gb)
if [ "$PC_FREE_GB" -lt "$PC_BACKUP_MIN_FREE_GB" ]; then
  log "REFUSED: only ${PC_FREE_GB} GiB free on $(df --output=target "$PGOUT" 2>/dev/null | tail -1) — below the ${PC_BACKUP_MIN_FREE_GB} GiB floor."
  log "REFUSED: not dumping. A -Fd dump writes a full second copy before its atomic swap, so starting here risks filling the volume."
  log "REFUSED: reclaim space (this volume also carries VM images and the offsite staging tree); do NOT just lower PC_BACKUP_MIN_FREE_GB."
  exit 1
fi
log "headroom ok: ${PC_FREE_GB} GiB free (floor ${PC_BACKUP_MIN_FREE_GB} GiB)"

# ── mid-flight headroom watchdog ────────────────────────────────────────────
# The pre-flight gate can pass and the dump can STILL eat the volume: the
# database may have grown since its last dump, and the estimate below is only an
# estimate. So poll while the dump runs and abort it if free space reaches the
# floor. Aborting costs one backup cycle; not aborting costs the whole box.
#
# Kills BOTH ways on purpose, matching this script's own doctrine above: the
# client process (so `timeout`'s child stops writing) AND the backend via
# reap_own_stragglers (because a table lock is held by the BACKEND — killing the
# client alone proves nothing). Never a name/pattern kill: we hold the real PID.
run_bounded_watched() {
  local secs="$1"; shift
  local rc=0 dump_pid watch_pid
  "$@" &
  dump_pid=$!
  (
    while kill -0 "$dump_pid" 2>/dev/null; do
      sleep "$PC_BACKUP_WATCH_SEC"
      now=$(fs_avail_gb)
      if [ "$now" -lt "$PC_BACKUP_MIN_FREE_GB" ]; then
        log "ABORTING DUMP: free space fell to ${now} GiB (floor ${PC_BACKUP_MIN_FREE_GB} GiB) while dumping — killing this dump to protect the volume"
        kill -TERM "$dump_pid" 2>/dev/null
        sleep 5
        kill -KILL "$dump_pid" 2>/dev/null
        reap_own_stragglers
        return 0
      fi
    done
  ) &
  watch_pid=$!
  wait "$dump_pid"; rc=$?
  kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
  return "$rc"
}

# ── orphan sweep ────────────────────────────────────────────────────────────
# Reap by PROVENANCE, not age. Anything named pg_dump* is BY DEFINITION not us
# (we use the exact host identity above), so it is a stray or an orphan from the old broken hook —
# never a healthy dump of ours. This is the predicate EI-10730's reaper should
# have used: its age-based rule ("older than 60s must be an orphan") is only
# true while the dump is broken, and would execute this script's own dump.
reap_foreign_dumps() {
  local pids
  pids=$($PSQL "SELECT string_agg(pid::text,' ') FROM pg_stat_activity
                 WHERE application_name LIKE 'pg_dump%'
                   AND backend_start < now() - interval '5 minutes';" 2>/dev/null | tr -d '[:space:]')
  [ -z "$pids" ] && return 0
  $PSQL "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name LIKE 'pg_dump%'
            AND backend_start < now() - interval '5 minutes';" >/dev/null 2>&1
  log "reaped foreign/orphaned pg_dump backend(s) holding table locks: $pids"
}

# Kill any backend WE left behind (e.g. if we were SIGKILLed and the process
# group kill below never ran). Locks are held by the BACKEND, not the client,
# so killing the process is not sufficient — terminate the backend.
reap_own_stragglers() {
  $PSQL "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name = '$HOST_BACKUP_APPLICATION_NAME' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
}

# Bounded run. NOTE the grandchild trap of EI-10730 does not exist here BY
# CONSTRUCTION: it is specific to a full `pg_dumpall`, which shells out to a
# per-database `pg_dump` (sh -c -- pg_dump ...) that does not die with it. We
# never do that — `pg_dump` is invoked directly (its -j workers are direct
# children it reaps itself), and `pg_dumpall --globals-only` spawns nothing.
#
# The real guarantee is PG-side regardless: a table lock is held by the BACKEND,
# not by the client process, so killing a client proves nothing and
# pg_terminate_backend is authoritative. That is what reap_own_stragglers is —
# and it is why this cannot leave a migration-blocking lock behind even if the
# client is SIGKILLed.
run_bounded() {
  local secs="$1"; shift
  timeout --kill-after=20s "$secs" "$@"
}

START=$(date +%s)
reap_own_stragglers
reap_foreign_dumps

FAILED=()
DUMPED=()

# ── globals (roles, tablespaces) — tiny, but a restore is useless without them
if run_bounded 120 sudo -n -u postgres env "PGAPPNAME=$HOST_BACKUP_APPLICATION_NAME" \
      pg_dumpall -h /var/run/postgresql --globals-only -f "$PGOUT/globals.sql.tmp"; then
  mv -f "$PGOUT/globals.sql.tmp" "$PGOUT/globals.sql"
  log "globals ok ($(stat -c%s "$PGOUT/globals.sql") bytes)"
else
  rm -f "$PGOUT/globals.sql.tmp"; FAILED+=("globals"); log "globals FAIL"
fi

# ── per-database, parallel directory format ─────────────────────────────────
# -Fd + -j is the only pg_dump format that parallelises; pg_dumpall is
# plain-text-only and single-threaded, which is a large part of why the old
# hook could not finish.
#
# Do NOT add pg_dump compression here. Kopia is the single compression layer
# (zstd) for this source. Compressing each full logical dump before Kopia sees
# it destroys content-defined chunk reuse across hourly rewrites: the measured
# -Z1 writer made the first post-dump snapshot upload 6.3 GB while an unchanged
# follow-up uploaded 0 B. Uncompressed directory members let Kopia deduplicate
# stable COPY data while preserving the hourly recovery-point objective.
DBS=$(sudo -n -u postgres psql -h /var/run/postgresql -d postgres -tAc \
       "SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn;" 2>/dev/null \
       | grep -vE "$EXCLUDE_RE")

# Remove a "$db.tmp" that pg_dump created as postgres.
#
# pg_dump -Fd writes its output dir 0700 postgres:postgres. On the SUCCESS path
# we chown it back (below), so a plain `rm -rf` works. On the FAILURE path the
# chown never runs — and THIS script runs as the backup service user, so `rm -rf` on that
# 0700 postgres-owned dir dies with "Permission denied". That turned a single
# bad dump into a PERMANENT one: the leftover .tmp survived, and because
# pg_dump -Fd refuses a non-empty target, every later run failed the same way.
# Found 2026-07-26: a 1.3G papercusp.tmp stranded from one 00:01 failure, with
# the real pg_dump error never recorded anywhere. Route EVERY tmp removal
# through sudo so a failed dump can always be cleaned up.
rm_tmp() {
  [ -e "$1" ] || return 0
  rm -rf "$1" 2>/dev/null || sudo -n rm -rf "$1" 2>/dev/null || {
    log "WARN could not remove stale tmp $1 — the next run of this db will fail until it is removed by hand"
    return 1
  }
}

for db in $DBS; do
  out="$PGOUT/$db"
  rm_tmp "$out.tmp"

  # Per-database precondition. The previous successful dump of THIS database is
  # the only honest size estimate available before dumping it, and it is a
  # LOWER bound (the db only grows between runs) — hence the safety multiplier.
  # Requiring need + floor, not just need, is the point: finishing a dump with
  # 2 GiB left is not a success, it is the same outage one cycle later.
  #
  # A database with no previous dump (first run, or last run failed) has no
  # estimate, so it is gated on the floor alone — the pre-flight check above.
  # That is deliberate: refusing a brand-new database forever because it has
  # never been dumped would be a guard that prevents its own precondition.
  prev_gb=0
  if [ -d "$out" ]; then
    prev_kb=$(du -sk "$out" 2>/dev/null | cut -f1)
    [ -n "$prev_kb" ] && prev_gb=$(( prev_kb / 1048576 ))
  fi
  need_gb=$(( prev_gb * PC_BACKUP_SPACE_SAFETY / 100 ))
  avail_gb=$(fs_avail_gb)
  if [ "$prev_gb" -gt 0 ] && [ "$avail_gb" -lt $(( need_gb + PC_BACKUP_MIN_FREE_GB )) ]; then
    FAILED+=("$db")
    log "$db SKIPPED — needs ~${need_gb} GiB (last dump ${prev_gb} GiB x ${PC_BACKUP_SPACE_SAFETY}%) plus the ${PC_BACKUP_MIN_FREE_GB} GiB floor, but only ${avail_gb} GiB free; previous dump left intact"
    continue
  fi

  dumperr=$(mktemp -t "pcbackup-$db-XXXXXX.err")
  if run_bounded_watched "$TIMEOUT_SEC" timeout --kill-after=20s "$TIMEOUT_SEC" \
        sudo -n -u postgres env "PGAPPNAME=$HOST_BACKUP_APPLICATION_NAME" \
        pg_dump -h /var/run/postgresql -Fd -j "$JOBS" --compress=none -f "$out.tmp" "$db" 2>"$dumperr"; then

    # pg_dump chmods its -Fd output to 0700 postgres:postgres. Left that way the
    # dump is UNREADABLE BY KOPIA (which runs as the backup service user), so it would never
    # leave this box — a silently-useless backup, i.e. the very failure this
    # script exists to end, wearing a different mask. Hand it back to us.
    #
    # But note there are TWO readers, not one, and they are different users:
    #   * backup archiver + this script -> service user (gets it off the box, swaps it)
    #   * pg_restore, at RESTORE   -> postgres       (peer auth on the socket is the
    #                                 only superuser path here: the service user has no
    #                                 PG role and TCP is scram-only)
    # Chowning to the service user at 0700 served the first and locked out
    # the second, so the artifact was readable by the process that ARCHIVES it and
    # unreadable by the process that RESTORES it — a backup you cannot restore is
    # the same class of silently-useless backup as one that never leaves the box.
    # Measured 2026-08-11 (WI-37835) by actually running the restore drill:
    # `pg_restore: error: could not open input file ".../toc.dat": Permission
    # denied`, and note the files were already 0664 — it was the DIRECTORY's
    # missing group-traverse bit that blocked it, which is why the failure reads
    # as a file error. Group=postgres + g=rX serves both readers and still
    # excludes everyone else (o= also tightens the previously world-readable
    # members). Modes are set explicitly rather than via +X so the result does not
    # depend on what pg_dump happened to write.
    sudo -n chown -R "${BACKUP_USER}:postgres" "$out.tmp"
    sudo -n chmod -R u=rwX,g=rX,o= "$out.tmp"

    # VALIDATE THE ARTIFACT, don't trust the exit code. The whole EI-10733 bug
    # family is "reported success while producing nothing usable", so a dump is
    # only 'ok' if pg_restore can actually read its table of contents.
    if ! pg_restore -l "$out.tmp" >/dev/null 2>&1; then
      rm_tmp "$out.tmp"; FAILED+=("$db")
      log "$db FAIL — dump completed but is NOT a valid archive (pg_restore -l could not read it); previous dump left intact"
      rm -f "$dumperr"
      continue
    fi

    # Atomic swap, NO local ".prev". A previous version of this kept "$out.prev"
    # as last-known-good, but (a) kopia already versions every snapshot
    # (latest/hourly/daily/weekly/monthly) — the offsite repo IS the
    # previous-version store, so a local copy is pure redundancy that doubles
    # the on-disk footprint; and (b) each .prev inherited the dump's original
    # 0700 postgres:postgres perms, leaving a directory KOPIA COULD NOT READ and
    # erroring its snapshot of db-dumps every cycle (found 2026-07-12: errors:4).
    # On FAILURE we still leave the existing "$out" untouched (see the branch
    # above), so last-known-good survives a bad run without any .prev.
    rm -rf "$out"
    mv -f "$out.tmp" "$out"
    sz=$(du -sb "$out" 2>/dev/null | cut -f1)
    DUMPED+=("$db")
    log "$db ok ($(numfmt --to=iec "${sz:-0}" 2>/dev/null || echo "${sz:-0}") , $(pg_restore -l "$out" 2>/dev/null | grep -c '^[0-9]') objects)"
  else
    rc=$?
    rm_tmp "$out.tmp"
    FAILED+=("$db")
    # Say WHY. The old line logged "timeout ${TIMEOUT_SEC}s or dump error" and
    # discarded pg_dump's stderr entirely, so a failure was undiagnosable after
    # the fact — the same detector gap that let EI-10733 rot silently for 30
    # days. An unresolved OR is not a diagnosis: record the exit code and the
    # actual error text.
    detail=$(tr '\n' ' ' <"$dumperr" 2>/dev/null | tail -c 400)
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      log "$db FAIL — TIMEOUT after ${TIMEOUT_SEC}s (exit $rc); previous dump left intact${detail:+ — stderr: $detail}"
    else
      log "$db FAIL — pg_dump exit $rc; previous dump left intact${detail:+ — stderr: $detail}"
    fi
  fi
  rm -f "$dumperr"
done

reap_own_stragglers   # nothing of ours may outlive this script holding locks

# ── oddsmith embedded Postgres (TCP 5544) — WI-39502 ────────────────────────
# The enumeration above CANNOT see this database, by construction: it asks the
# SYSTEM cluster over the unix socket, and oddsmith runs its own EMBEDDED
# postgres on TCP 5544 with a private data dir (ODDSMITH_PG_DATA_DIR =
# ~/.oddsmith/embedded-pg-data). Widening EXCLUDE_RE would not help — the DB is
# not in that cluster's pg_database at all. It therefore needs its own leg.
#
# WHY THIS EXISTS: on 2026-08-15 18:54 ~/.oddsmith was destroyed. papercusp was
# restored from kopia and came back fine; oddsmith could not be, because it was
# in NEITHER backup path — not dumped here (wrong cluster) and not a kopia
# source (~/.oddsmith is not in the policy). Two independent blind spots meeting
# on one database. Every row of simulation and evidence history was lost
# permanently. Dumping into $PGOUT puts it inside /mnt/data/Backup/db-dumps,
# which kopia ALREADY snapshots — so this needs no new kopia policy, and a live
# PG data dir never has to be snapshotted file-by-file (which is unsafe anyway).
#
# DELIBERATELY NOT FOLDED INTO OK/FAILED: the oddsmith sidecar is a restartable
# service that can legitimately be down, and letting a down sidecar redden the
# whole cluster's backup health would raise ALERT-BACKUP-FAILING on a perfectly
# good papercusp dump — the false-alarm trap this file already warns about
# twice. It gets its OWN status fields and its OWN staleness assertion in
# healthcheck.sh, so it is independently loud without being coupled.
#
# Runs as the backup service user over TCP (scram), NOT `sudo -u postgres`: peer auth is a
# SYSTEM-cluster concept and this server has its own roles. So the chown dance
# above is unnecessary here — this script already owns what it writes.
ODDSMITH_DISCOVERY="${ODDSMITH_DISCOVERY:-$BACKUP_HOME/.oddsmith/embedded-pg.json}"
ODDS_OK=false
ODDS_NOTE="not attempted"
odds_out="$PGOUT/oddsmith"

odds_url=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ODDSMITH_DISCOVERY" 2>/dev/null | head -1)
if [ -z "${odds_url:-}" ]; then
  # No discovery file = the sidecar has never booted on this box, or ~/.oddsmith
  # was wiped again. Either way there is nothing to dump and that is worth saying
  # out loud rather than silently recording a clean run.
  ODDS_NOTE="no discovery file at $ODDSMITH_DISCOVERY (sidecar never booted, or ~/.oddsmith was wiped)"
  log "oddsmith SKIP — $ODDS_NOTE"
else
  # Parse the URI into parts so the PASSWORD never reaches the process table (a
  # conninfo URI passed as an argv would show in `ps` for the whole dump).
  odds_rest=${odds_url#*://}
  odds_user=${odds_rest%%:*}
  odds_pass=${odds_rest#*:}; odds_pass=${odds_pass%%@*}
  odds_hostport=${odds_rest#*@}; odds_hostport=${odds_hostport%%/*}
  odds_host=${odds_hostport%%:*}
  odds_port=${odds_hostport##*:}
  odds_db=${odds_url##*/}

  # Tolerate a restart in flight rather than calling a 5-second blip a backup
  # failure: the sidecar has Restart=always and does bounce.
  odds_ready=false
  for _try in 1 2 3; do
    if pg_isready -h "$odds_host" -p "$odds_port" -U "$odds_user" -d "$odds_db" -t 5 >/dev/null 2>&1; then
      odds_ready=true; break
    fi
    [ "$_try" -lt 3 ] && sleep 5
  done

  if ! $odds_ready; then
    ODDS_NOTE="embedded PG unreachable at $odds_host:$odds_port after 3 probes (sidecar down?)"
    log "oddsmith SKIP — $ODDS_NOTE"
  else
    rm_tmp "$odds_out.tmp"
    odds_err=$(mktemp -t "pcbackup-oddsmith-XXXXXX.err")
    # PGPASSWORD is exported INSIDE a subshell so it is neither in argv nor in
    # this script's environment for anything else that runs after.
    (
      export PGPASSWORD="$odds_pass" PGAPPNAME="$HOST_BACKUP_APPLICATION_NAME"
      run_bounded "$TIMEOUT_SEC" pg_dump -h "$odds_host" -p "$odds_port" -U "$odds_user" \
        -Fd -j "$JOBS" --compress=none -f "$odds_out.tmp" "$odds_db"
    ) 2>"$odds_err"
    orc=$?
    if [ "$orc" -eq 0 ]; then
      # Same rule as the loop above: VALIDATE THE ARTIFACT, never the exit code.
      if pg_restore -l "$odds_out.tmp" >/dev/null 2>&1; then
        chmod -R u=rwX,g=rX,o= "$odds_out.tmp" 2>/dev/null || true
        rm -rf "$odds_out"
        mv -f "$odds_out.tmp" "$odds_out"
        osz=$(du -sb "$odds_out" 2>/dev/null | cut -f1)
        ODDS_OK=true
        ODDS_NOTE="ok"
        log "oddsmith ok ($(numfmt --to=iec "${osz:-0}" 2>/dev/null || echo "${osz:-0}"), $(pg_restore -l "$odds_out" 2>/dev/null | grep -c '^[0-9]') objects)"
      else
        rm_tmp "$odds_out.tmp"
        ODDS_NOTE="dump completed but is NOT a valid archive (pg_restore -l could not read it)"
        log "oddsmith FAIL — $ODDS_NOTE; previous dump left intact"
      fi
    else
      rm_tmp "$odds_out.tmp"
      # Say WHY, same as the system loop — and scrub anything password-shaped out
      # of the text before it reaches a log file or STATUS.json.
      odetail=$(tr '\n' ' ' <"$odds_err" 2>/dev/null | sed "s|${odds_pass}|***|g" | tail -c 300)
      if [ "$orc" -eq 124 ] || [ "$orc" -eq 137 ]; then
        ODDS_NOTE="TIMEOUT after ${TIMEOUT_SEC}s (exit $orc)${odetail:+ — $odetail}"
      else
        ODDS_NOTE="pg_dump exit $orc${odetail:+ — $odetail}"
      fi
      log "oddsmith FAIL — $ODDS_NOTE; previous dump left intact"
    fi
    rm -f "$odds_err"
    unset odds_pass
  fi
fi

ELAPSED=$(( $(date +%s) - START ))
OK=true; [ ${#FAILED[@]} -eq 0 ] || OK=false

# Carry the previous oddsmith success forward when this run did not produce one.
# Read it BEFORE the STATUS rewrite, and default explicitly: `$(sed ... || echo 0)`
# yields EMPTY when sed matches nothing (sed still exits 0), which would emit
# `"oddsmithLastSuccessEpoch": ,` — invalid JSON that a consumer reads as absence.
ODDS_PREV=$(sed -n 's/.*"oddsmithLastSuccessEpoch": *\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null | head -1)
[ -n "${ODDS_PREV:-}" ] || ODDS_PREV=0
$ODDS_OK && ODDS_LAST=$(date +%s) || ODDS_LAST="$ODDS_PREV"

# ── STATUS.json — the file healthcheck.sh actually asserts on ───────────────
# `printf '"%s",' "${ARR[@]}"` runs its format ONCE even with zero arguments, so
# an empty array serialised as [""] — a one-element array holding an empty
# string. Any consumer testing `.failed | length == 0` therefore read a clean
# run as a failure (observed 2026-07-26 on a fully green run). Emit nothing for
# an empty array instead.
json_arr() {
  [ "$#" -eq 0 ] && return 0
  printf '"%s",' "$@" | sed 's/,$//'
}

# Cluster identity of what we just dumped, so a consumer can prove a database it
# is looking at is THE SAME SERVER rather than a same-named database elsewhere.
# The per-workspace hook uses this to stand down (host-dump-coverage.ts); it
# connects over TCP while we use the unix socket, so host:port can never match
# textually and a name-only comparison would wrongly suppress a workspace's
# EMBEDDED Postgres dump. `tr -dc` guarantees the field is digits-or-empty, and
# empty reads as "no identity" ⇒ the hook keeps dumping.
SYSID=$($PSQL "SELECT system_identifier FROM pg_control_system()" 2>/dev/null | tr -dc '0-9' || true)
{
  printf '{\n'
  printf '  "ok": %s,\n' "$OK"
  printf '  "lastRunEpoch": %s,\n' "$(date +%s)"
  printf '  "lastRunIso": "%s",\n' "$(date -Iseconds)"
  $OK && printf '  "lastSuccessEpoch": %s,\n' "$(date +%s)" \
       || printf '  "lastSuccessEpoch": %s,\n' "$(sed -n 's/.*"lastSuccessEpoch": \([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null | head -1 || echo 0)"
  printf '  "elapsedSec": %s,\n' "$ELAPSED"
  printf '  "dumped": [%s],\n' "$(json_arr ${DUMPED[@]+"${DUMPED[@]}"})"
  printf '  "failed": [%s],\n' "$(json_arr ${FAILED[@]+"${FAILED[@]}"})"
  printf '  "systemIdentifier": "%s",\n' "$SYSID"
  # WI-39502: the oddsmith embedded PG (5544) reports SEPARATELY from the system
  # cluster above — see the leg's comment for why coupling them would be a bug.
  # healthcheck.sh asserts oddsmithLastSuccessEpoch on its own threshold.
  printf '  "oddsmithOk": %s,\n' "$ODDS_OK"
  printf '  "oddsmithLastSuccessEpoch": %s,\n' "$ODDS_LAST"
  printf '  "oddsmithNote": "%s"\n' "$(printf '%s' "$ODDS_NOTE" | tr -d '\n' | sed 's/[\\"]/ /g' | tail -c 300)"
  printf '}\n'
} > "$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS"

if $OK; then
  # Clear the failure marker on recovery. backup-alert.sh RAISES
  # "$DUMP/ALERT-BACKUP-FAILING" via OnFailure=, but nothing ever removed it
  # again — so one bad run left a permanent "BACKUP FAILING" file on disk
  # flatly contradicting a green STATUS.json (observed 2026-07-26: the marker
  # survived a clean 120s run in which all four databases dumped). A false
  # alarm is a bug in the alarm: a marker that never clears trains readers to
  # ignore the single signal meant to catch silent backup rot.
  rm -f "$DUMP/ALERT-BACKUP-FAILING"
  log "backup OK in ${ELAPSED}s: ${DUMPED[*]}"
  exit 0
fi
log "backup FAILED in ${ELAPSED}s: ${FAILED[*]}"
exit 1
