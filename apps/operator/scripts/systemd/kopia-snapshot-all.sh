#!/usr/bin/env bash
# Run pre-snapshot DB hook ONCE per cycle, then snapshot every registered source.
set -uo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=kopia-cache-bootstrap.sh
source "$script_dir/kopia-cache-bootstrap.sh"
LOG_DIR="${KOPIA_SNAPSHOT_LOG_DIR:-$HOME/.cache/kopia}"
PID_FILE="$LOG_DIR/snapshot-all.kopia.pid"
PROC_ROOT="${KOPIA_SNAPSHOT_PROC_ROOT:-/proc}"
SUDO_BIN="${KOPIA_SNAPSHOT_SUDO:-/usr/bin/sudo}"
KILL_BIN="${KOPIA_SNAPSHOT_KILL:-/usr/bin/kill}"
KOPIA_BIN="${KOPIA_SNAPSHOT_BIN:-/usr/bin/kopia}"
if ! ensure_kopia_cache_dir "$LOG_DIR"; then
  echo "FATAL: unable to bootstrap Kopia snapshot log directory: $LOG_DIR" >&2
  exit 1
fi

# A user manager cannot reliably kill a root-owned sudo child after oomd tears
# down the user unit. Validate the exact PID and command before cleanup; never
# scan for or kill unrelated Kopia processes.
kopia_pid_matches() {
  local pid="$1" exe="" cmdline=""
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" -gt 1 ] 2>/dev/null || return 1
  exe="$(readlink -f "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
  # The Kopia child runs as ROOT (sudo), and /proc/<pid>/exe of a root process is
  # unreadable to this user unit, so the plain readlink above returns nothing for the
  # exact process this cleanup exists to kill (WI-10002636: two orphaned snapshot
  # creates ran 3.5h while every cleanup logged "refusing to kill"). Resolve the link
  # with the same sudo the kill below already uses; cmdline stays world-readable.
  if [ "$exe" != "$KOPIA_BIN" ]; then
    exe="$("$SUDO_BIN" -n -- readlink -f -- "$PROC_ROOT/$pid/exe" 2>/dev/null || true)"
  fi
  [ "$exe" = "$KOPIA_BIN" ] || return 1
  cmdline="$(tr '\0' ' ' <"$PROC_ROOT/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == "$KOPIA_BIN snapshot create "* ]]
}

cleanup_kopia_pid() {
  local pid=""
  [ -s "$PID_FILE" ] || return 0
  pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"

  if kopia_pid_matches "$pid"; then
    if "$SUDO_BIN" -n -- "$KILL_BIN" -KILL "$pid" >>"$LOG_DIR/snapshot-all.log" 2>&1; then
      echo "CLEANUP: killed exact Kopia PID $pid" >>"$LOG_DIR/snapshot-all.log"
    else
      echo "WARN: failed to kill exact Kopia PID $pid" >>"$LOG_DIR/snapshot-all.log"
    fi
  else
    echo "INFO: stale/non-Kopia PID file $PID_FILE; refusing to kill PID ${pid:-<empty>}" >>"$LOG_DIR/snapshot-all.log"
  fi
  rm -f -- "$PID_FILE"
}

# ExecStopPost calls this after a kill. Keep it above the guard self-wrap so
# cleanup cannot wait on a backup lock whose owner is being torn down.
if [ "${1:-}" = "--cleanup" ]; then
  cleanup_kopia_pid
  exit 0
fi

# D-001: this script is safe both from systemd and when invoked directly. The
# outer service already enters the same guard; KOPIA_BACKUP_GUARD_ACTIVE avoids
# recursively reacquiring it. Scheduled mode skips on overlap or unsafe PSI.
if [ "${KOPIA_BACKUP_GUARD_ACTIVE:-0}" != 1 ]; then
  guard="${KOPIA_BACKUP_GUARD_BIN:-$script_dir/kopia-backup-guard.sh}"
  exec "$guard" --mode scheduled --label hot -- "$0" "$@"
fi

# Background priority. Children inherit both.
renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true

run_kopia_snapshot() {
  local output_file="$LOG_DIR/snapshot-all-output.$$" sudo_pid="" rc=0
  rm -f -- "$PID_FILE" "$output_file"

  "$SUDO_BIN" -n /usr/bin/bash -c '
    pid_file="$1"
    shift
    printf "%s\n" "$$" >"$pid_file"
    exec "$@"
  ' bash "$PID_FILE" "$KOPIA_BIN" snapshot create "--parallel=1" "$@" >"$output_file" 2>&1 &
  sudo_pid=$!
  wait "$sudo_pid"
  rc=$?
  record_sweep_progress "$output_file"
  cat "$output_file"
  rm -f -- "$output_file" "$PID_FILE"
  return "$rc"
}

# ── SWEEP ROTATION: resume a stopped sweep instead of restarting it ──────────
# The DB-dump waiters (papercusp-db-backup, workspace dumps) may stop this sweep
# mid-run by design (the guard's priority-waiter handoff). Kopia keeps every
# source it FINISHED, but discovery order was fixed, so the next sweep re-walked
# the same leading sources and the ones after the slowest never got a turn.
# Measured 2026-10-06 (EI-25211496463956189): the sweep stopped at 16:52 EDT had
# landed only /mnt/backup/db-dumps, and Restart, storewolf-*, .papercusp-workspaces
# and .papercusp were 19-20h stale. The last snapshot TIME cannot rank staleness
# here: the global policy sets "ignore identical snapshots", so an unchanged source
# keeps an old timestamp. So record, per source, when a sweep last reached it, from
# Kopia's own per-source output: "Snapshotting <user@host:/path> ..." starts a
# source; "Created snapshot ..." or "Not saving snapshot because no files have been
# changed ..." finishes it. A source that started but did not finish is stamped one
# second before the finished ones, so it runs ahead of them but after the sources
# the stopped sweep never reached.
SWEEP_STATE="${KOPIA_SNAPSHOT_SWEEP_STATE:-$LOG_DIR/snapshot-all.sweep-state}"

# Merge the per-source progress in Kopia output file $1 into $SWEEP_STATE, stamped
# with the file's mtime (when Kopia last wrote to it). Keeps the newest stamp.
record_sweep_progress() {
  local output_file="$1" stamp tmp
  [ -s "$output_file" ] || return 0
  stamp=$(stat -c %Y -- "$output_file" 2>/dev/null) || return 0
  tmp="$SWEEP_STATE.tmp.$$"
  {
    if [ -r "$SWEEP_STATE" ]; then cat -- "$SWEEP_STATE"; fi
    tr '\r' '\n' <"$output_file" | awk -v done_at="$stamp" '
      function flush(at) { if (cur != "") printf "%d\t%s\n", at, cur; cur = "" }
      /^Snapshotting [^ ]*@[^ ]*:\// {
        flush(done_at - 1)
        cur = $0
        sub(/^Snapshotting [^@]*@[^:]*:/, "", cur)
        sub(/ \.\.\.$/, "", cur)
        next
      }
      /^Created snapshot with root / || /Not saving snapshot because no files have been changed/ { flush(done_at) }
      END { flush(done_at - 1) }
    '
  } | awk -F'\t' '
    NF >= 2 && $1 ~ /^[0-9]+$/ {
      src = substr($0, index($0, "\t") + 1)
      if (!(src in at) || $1 + 0 > at[src] + 0) at[src] = $1
    }
    END { for (s in at) printf "%s\t%s\n", at[s], s }
  ' >"$tmp" 2>/dev/null && mv -f -- "$tmp" "$SWEEP_STATE" || rm -f -- "$tmp"
}

# A stopped sweep is killed before run_kopia_snapshot can record its output, which
# is why ~/.cache/kopia held 105 leftover output files on 2026-10-06. Fold in every
# leftover from a process that is gone, oldest first, then delete it.
ingest_stopped_sweep_outputs() {
  local f pid
  while IFS= read -r f; do
    pid=${f##*.}
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [ "$pid" != "$$" ] || continue
    [ ! -d "$PROC_ROOT/$pid" ] || continue
    record_sweep_progress "$f"
    rm -f -- "$f"
  done < <(ls -1tr -- "$LOG_DIR"/snapshot-all-output.* 2>/dev/null)
}

trap cleanup_kopia_pid EXIT

{
  echo "=== $(date -Iseconds) run start ==="
  "$HOME/.config/kopia/hooks/pre-snapshot.sh"
  # ── BATCHED INVOCATION (2026-08-07, fan/thermal investigation) ──────────────
  # Was: one `kopia snapshot create` per source inside a while-read loop — 13
  # separate kopia processes every cycle. Measured on this host, a kopia
  # invocation costs ~4.2 CPU-SECONDS before it looks at any data: snapshotting a
  # 40 KB directory with ZERO changed files took real 3.8s / user 2.8s / sys 1.8s,
  # and a bare `snapshot list -n 1` cost 3.4 CPU-s. That is fixed index-load
  # overhead from the repo's ~5,300 index blobs, paid once PER PROCESS — and each
  # invocation also fires its own opportunistic "Running quick maintenance..." pass.
  #
  # `kopia snapshot create` accepts multiple sources (usage: [<source>...]), so one
  # invocation loads the index once instead of 13 times: ~50 CPU-s of the measured
  # 572 CPU-s/cycle. Deliberately noting what this does NOT fix: 82% of the cost
  # (469 CPU-s) is walking .papercusp-workspaces / papercupai-workspace / .papercusp.
  # ── COLD SOURCES: discovered, but NOT snapshotted on this 30-minute timer ────
  # Source discovery below is DYNAMIC (`kopia snapshot list --all`), so any source
  # that has ever been snapshotted gets swept every 30 minutes. $HOME
  # is a deliberately DAILY source (plan kopia-curated-home-coverage-2026-08-16):
  # it walks the whole home tree, and doing that every 30 min would undo the
  # 2026-08-07 thermal fix that first cut this timer from 5 min to 15. It has its own
  # unit — kopia-home-snapshot.timer — and must be filtered out HERE, or it would
  # silently rejoin the hot sweep the moment its first snapshot exists.
  #
  # Exact-match (`grep -vxF`) on purpose: this must remove $HOME
  # itself WITHOUT removing its children ($HOME/.papercusp etc.),
  # which ARE hot sources and must keep their 30-minute cadence. The two
  # owner-protected VM sources are also daily: their images are hundreds of GB,
  # so registering them must never make the 30-minute sweep walk them.
  # windows-vm is a symlink today; keep both spellings cold so a source created
  # from its resolved target cannot accidentally re-enter the hot sweep.
  COLD_SOURCES=(
    "$HOME"
    "$HOME/windows-vm"
    "$HOME/macos-vm"
    /mnt/data/offload/windows-vm
  )
  # ── REQUIRED SOURCES: the fix for a blind spot in the discovery above ───────
  # Discovery is self-referential: it enumerates sources that ALREADY HAVE a
  # snapshot, so a directory that has never been snapshotted CANNOT ENTER IT, by
  # construction. There is no registration path. That is not a corner case — it
  # is what happened on 2026-09-05 (WI-2146225): WI-2145150 relocated the
  # Postgres dumps from /mnt/data/Backup/db-dumps to /mnt/backup/db-dumps
  # because /mnt/data hit 97%, the new directory had no snapshot, so discovery
  # never returned it, so it never got one. The dumps kept being produced
  # perfectly and stopped leaving the box entirely, and every existing check
  # stayed green: the freshness checks read LOCAL files, and check 2 takes the
  # newest snapshot across ALL sources, so 16 healthy sources kept it green.
  #
  # Silent, self-perpetuating, and unbounded in time — the exact shape of
  # EI-10733. So the paths that MUST be covered are named here and unioned in
  # unconditionally: relocating a backup directory now costs one sweep of
  # latency instead of forever. Only paths that exist on disk are added, so a
  # box that does not have one is not spammed with errors for it.
  REQUIRED_SOURCES=(
    "${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/backup/db-dumps}"
  )
  COLD_FILTER="$(printf '%s\n' "${COLD_SOURCES[@]}")"
  mapfile -t DISCOVERED < <("$SUDO_BIN" -n "$KOPIA_BIN" snapshot list --all 2>/dev/null \
      | awk -F'@' '/^[a-zA-Z]/' \
      | grep -oE ':/[^ ]+' \
      | sed 's/^://' \
      | sort -u \
      | grep -vxF "$COLD_FILTER")
  # ── ORDER: a source that has NEVER been snapshotted goes FIRST ──────────────
  # Membership alone is not coverage. This sweep runs one `kopia snapshot
  # create` at --parallel=1, so sources are visited IN ORDER, and the backup
  # guard aborts the run mid-flight under memory/io pressure (48h of label=hot
  # on 2026-09-05: 51 started, 46 killed mid-run, 6 finished). A killed cycle
  # therefore yields a PREFIX of this list, not a random sample.
  #
  # Union-then-`sort -u` put /mnt/backup/db-dumps in the /mnt/* tail, behind
  # every /home/* source — so on 2026-09-05 the REQUIRED_SOURCES fix above
  # correctly placed the zero-coverage directory into the sweep and it STILL
  # got no snapshot: the 13:00:04 cycle was killed at 96s, thousands of files
  # short of ever reaching it. The blind spot simply moved from "cannot enter
  # the list" to "is always last in a list that rarely finishes".
  #
  # So sort by RISK, not by name: a source with no snapshot at all has
  # unbounded exposure (nothing to restore from, at any age), while an
  # already-covered source that is skipped this cycle merely gets 30 minutes
  # staler. First snapshot first, every time.
  # 2026-09-05 (WI-2146225): hoist EVERY required source, not only the
  # never-snapshotted ones. The previous test skipped any source already in
  # DISCOVERED, which made this hoist ONE-SHOT AND SELF-DISABLING: DISCOVERED is
  # `kopia snapshot list --all`, so the instant a required path got its FIRST
  # snapshot it re-entered DISCOVERED, `sort -u` dropped it into the /mnt/* tail,
  # and it was never prioritised again.
  #
  # Measured, not theorised: two ad-hoc snapshots taken at 13:17 and 14:12 EDT to
  # establish tier-1 coverage put /mnt/backup/db-dumps at position 13 of 15 —
  # behind the three /home trees that are 82% of cycle cost (469 of 572 CPU-s).
  # At --parallel=1 with the guard killing runs mid-flight (16 of ~35 fires that
  # day), no cycle ever reached position 13: zero scheduled captures in the ~8
  # fires after 14:12. Establishing coverage is what disabled the prioritisation
  # that earns coverage.
  #
  # The old rationale — an already-covered source "merely gets 30 minutes
  # staler" — holds only if sweeps FINISH. Here they almost never do, so a
  # deprioritised source is unbounded-stale, which is the same exposure the hoist
  # exists to prevent; the binary never-snapshotted? is a decaying proxy for risk
  # that evaporates exactly when coverage turns fragile rather than absent.
  # A path in REQUIRED_SOURCES MUST be covered: keep it first, every cycle.
  PRIORITY=()
  for r in ${REQUIRED_SOURCES[@]+"${REQUIRED_SOURCES[@]}"}; do
    [ -d "$r" ] || continue
    printf '%s\n' ${PRIORITY[@]+"${PRIORITY[@]}"} | grep -qxF "$r" && continue
    printf '%s\n' "$COLD_FILTER" | grep -qxF "$r" && continue
    PRIORITY+=("$r")
  done
  # Strip hoisted paths out of the tail so one cycle cannot snapshot them twice.
  TAIL=()
  for d in ${DISCOVERED[@]+"${DISCOVERED[@]}"}; do
    printf '%s\n' ${PRIORITY[@]+"${PRIORITY[@]}"} | grep -qxF "$d" && continue
    TAIL+=("$d")
  done
  # Least-recently-swept first (SWEEP ROTATION above); ties keep discovery order.
  ingest_stopped_sweep_outputs
  if [ "${#TAIL[@]}" -gt 1 ] && [ -s "$SWEEP_STATE" ]; then
    mapfile -t TAIL < <(
      printf '%s\n' "${TAIL[@]}" | awk -v state="$SWEEP_STATE" '
        BEGIN {
          while ((getline line < state) > 0) {
            tab = index(line, "\t")
            if (tab > 1) at[substr(line, tab + 1)] = substr(line, 1, tab - 1) + 0
          }
        }
        { printf "%d\t%d\t%s\n", ($0 in at ? at[$0] : 0), NR, $0 }
      ' | LC_ALL=C sort -t "$(printf '\t')" -k1,1n -k2,2n | cut -f3-)
    echo "ROTATION: least-recently-swept first: ${TAIL[*]}"
  fi
  if [ "${#PRIORITY[@]}" -gt 0 ]; then
    echo "PRIORITY: ${#PRIORITY[@]} required source(s) ordered first: ${PRIORITY[*]}"
  fi
  SRCS=( ${PRIORITY[@]+"${PRIORITY[@]}"} ${TAIL[@]+"${TAIL[@]}"} )
  # Guard: the old loop snapshotted NOTHING, silently, if discovery came back empty
  # — the same shape as the `--max-results-per-source` flag breakage that made
  # healthcheck.sh exit 1 on every run for weeks before anyone noticed. Silent
  # success-looking failure is this system's recurring bug; log it loudly instead.
  if [ "${#SRCS[@]}" -eq 0 ]; then
    echo "WARNING: source discovery returned NOTHING — no sources snapshotted this cycle"
  else
    echo "snapshotting ${#SRCS[@]} sources in ONE kopia invocation"
    run_kopia_snapshot "${SRCS[@]}" 2>&1 | tail -5
  fi
  echo "=== $(date -Iseconds) run end ==="
} >> "$LOG_DIR/snapshot-all.log" 2>&1
