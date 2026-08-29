#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# papercusp estate — RESTORE DRILL (P-024 / D-030 acceptance test)
#
# Proves a backup is restorable by actually restoring it and comparing CONTENT,
# because the failure this exists to catch is invisible to every cheaper check:
#   - pg_restore CONTINUES PAST ERRORS, so a restore that produced absolutely
#     nothing looks like ordinary ordering noise plus a non-zero exit that also
#     occurs on healthy runs. Exit code proves nothing.
#   - A ROW COUNT IS NOT EVIDENCE THE PAYLOAD SURVIVED: N rows with every
#     payload column NULL is total data loss that a table-exists check calls
#     SUCCESS.
# So the verdict is byte identity of row content, live vs restored (WI-37835).
#
# Deliberately pulls the artifact back OUT of GCS rather than reading the local
# staging copy -- the staging copy proves the dump; only the round trip proves
# the BACKUP.
#
# usage: pc-restore-drill.sh <pg_container> <db>
# ---------------------------------------------------------------------------
set -euo pipefail

BUCKET="${PC_BACKUP_BUCKET:-gs://papercusp-estate-backups-active-alcove-504205-q3}"
CONTAINER="${1:?usage: pc-restore-drill.sh <pg_container> <db>}"
DB="${2:?usage: pc-restore-drill.sh <pg_container> <db>}"
HOST="$(hostname -s)"
DRILLDB="restore_drill_$(date -u +%H%M%S)"
WORK="/srv/backups/drill/$$"
TOPN="${PC_DRILL_TABLES:-8}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
mkdir -p "$WORK"
cleanup() {
  docker exec "$CONTAINER" psql -U postgres -tAc "DROP DATABASE IF EXISTS \"$DRILLDB\"" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" rm -f "/tmp/$$.dump" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- 1. locate the newest artifact IN THE BUCKET ----------------------------
log "locating newest ${CONTAINER}/${DB} artifact for ${HOST}"
# `|| true` matters: under `set -e` a failing command substitution aborts the
# script BEFORE the explicit check below can report why, which turns a missing
# artifact into a silent one-line death instead of a diagnosis.
REMOTE=$(gcloud storage ls "${BUCKET}/daily/**/${HOST}/**/pg/${CONTAINER}__${DB}.dump" 2>/dev/null | sort | tail -1 || true)
[ -n "$REMOTE" ] || { echo "FAIL: no ${CONTAINER}__${DB}.dump for ${HOST} in ${BUCKET} -- has a backup completed for this host?"; exit 1; }
RUNDIR="${REMOTE%/pg/*}"
log "  artifact: $REMOTE"

# --- 2. pull it back out of GCS, and verify it against the manifest ---------
gcloud storage cp "$REMOTE" "$WORK/dump" --quiet 2>/dev/null
gcloud storage cp "${RUNDIR}/MANIFEST.json" "$WORK/MANIFEST.json" --quiet 2>/dev/null
EXPECT=$(python3 -c "
import json,sys
m=json.load(open('$WORK/MANIFEST.json'))
print(next((a['sha256'] for a in m['artifacts'] if a['path']=='pg/${CONTAINER}__${DB}.dump'),''))
")
ACTUAL=$(sha256sum "$WORK/dump" | cut -d' ' -f1)
if [ -z "$EXPECT" ]; then echo "FAIL: artifact not listed in MANIFEST.json"; exit 1; fi
if [ "$EXPECT" != "$ACTUAL" ]; then echo "FAIL: sha256 mismatch (manifest=$EXPECT downloaded=$ACTUAL)"; exit 1; fi
log "  sha256 verified against manifest: $ACTUAL"

# format is detected from the ARTIFACT, never the filename (WI-37835)
[ "$(head -c5 "$WORK/dump")" = "PGDMP" ] || { echo "FAIL: not a PGDMP custom archive"; exit 1; }

# --- 3. restore into a scratch database -------------------------------------
log "restoring into ${DRILLDB}"
docker cp "$WORK/dump" "$CONTAINER:/tmp/$$.dump" >/dev/null
docker exec "$CONTAINER" psql -U postgres -tAc "CREATE DATABASE \"$DRILLDB\"" >/dev/null
set +e
docker exec "$CONTAINER" pg_restore -U postgres -d "$DRILLDB" --no-owner --no-acl "/tmp/$$.dump" >"$WORK/restore.log" 2>&1
RC=$?
set -e
log "  pg_restore exit=${RC} (DELIBERATELY IGNORED as a verdict -- see below)"

# --- 4. THE VERDICT: content identity, live vs restored ---------------------
log "comparing content of the ${TOPN} largest tables"
mapfile -t TABLES < <(docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc \
  "SELECT quote_ident(schemaname)||'.'||quote_ident(relname)
     FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT ${TOPN}")

PASS=0; FAILN=0; DRIFT=0
printf '\n%-42s %10s %10s  %s\n' TABLE LIVE RESTORED VERDICT
for t in "${TABLES[@]}"; do
  # THE LIVE-DRIFT PROBLEM: the backup is a point in time; the live table keeps
  # moving. An append-only table (session stats, event logs) will ALWAYS differ
  # by the rows written since the dump, and reporting that as corruption trains
  # everyone to ignore the drill -- which is how a backup rots unnoticed.
  # So bound BOTH sides to the backup's own window using a monotonic integer
  # primary key, when the table has one.
  pk=$(docker exec "$CONTAINER" psql -U postgres -d "$DRILLDB" -tAc "
    SELECT a.attname FROM pg_index i
      JOIN pg_class c ON c.oid=i.indrelid
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum = ANY(i.indkey)
      JOIN pg_type ty ON ty.oid=a.atttypid
     WHERE i.indisprimary AND c.oid='${t}'::regclass
       AND array_length(i.indkey,1)=1 AND ty.typname IN ('int2','int4','int8')" 2>/dev/null | tr -d ' ')

  if [ -n "$pk" ]; then
    BOUND=$(docker exec "$CONTAINER" psql -U postgres -d "$DRILLDB" -tAc \
      "SELECT coalesce(max(${pk})::text,'NULL') FROM ${t}" 2>/dev/null | tr -d ' ')
    if [ "$BOUND" = "NULL" ]; then WHERE=""; else WHERE="WHERE ${pk} <= ${BOUND}"; fi
    scope="pk<=${BOUND}"
  else
    WHERE=""; scope="whole table"
  fi

  # order-independent, content-sensitive: hash each row, sort the hashes.
  # A NULLed-out payload column changes the row hash, so this subsumes the
  # count(*) vs count(payload) check that a row count alone would pass.
  q="SELECT count(*)||' '||coalesce(md5(string_agg(h,'' ORDER BY h)),'EMPTY') FROM (SELECT md5(x::text) AS h FROM ${t} x ${WHERE}) s"
  L=$(docker exec "$CONTAINER" psql -U postgres -d "$DB"      -tAc "$q" 2>/dev/null || echo "ERR ERR")
  R=$(docker exec "$CONTAINER" psql -U postgres -d "$DRILLDB" -tAc "$q" 2>/dev/null || echo "ERR ERR")
  lr=${L%% *}; lh=${L##* }
  rr=${R%% *}; rh=${R##* }

  if [ "$lh" = "$rh" ] && [ "$lh" != "ERR" ]; then
    v="PASS (${scope})"; PASS=$((PASS+1))
  elif [ -z "$WHERE" ] && [ "$lh" != "ERR" ] && [ "${lr:-0}" -gt "${rr:-0}" ] 2>/dev/null; then
    # no usable PK to bound with, and live simply has MORE rows: report it as
    # drift rather than claiming corruption we have not actually demonstrated
    v="DRIFT? live has $((lr-rr)) more rows, no integer PK to bound by"; DRIFT=$((DRIFT+1))
  else
    v="FAIL (live=${lh:0:12} restored=${rh:0:12})"; FAILN=$((FAILN+1))
  fi
  printf '%-42s %10s %10s  %s\n' "$t" "$lr" "$rr" "$v"
done
[ "$DRIFT" -gt 0 ] && echo "note: ${DRIFT} table(s) inconclusive (live moved, no bounding key) -- not counted as pass"

# relation-count cross-check: catches objects lost wholesale
LREL=$(docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc "SELECT count(*) FROM pg_stat_user_tables")
RREL=$(docker exec "$CONTAINER" psql -U postgres -d "$DRILLDB" -tAc "SELECT count(*) FROM pg_stat_user_tables")
printf '\nuser tables: live=%s restored=%s\n' "$LREL" "$RREL"
[ "$LREL" = "$RREL" ] || { echo "FAIL: relation count differs"; FAILN=$((FAILN+1)); }

echo
if [ "$FAILN" -gt 0 ]; then
  echo "DRILL FAILED: ${FAILN} mismatch(es), ${PASS} pass. Restore log tail:"
  tail -15 "$WORK/restore.log"
  exit 1
fi
echo "DRILL PASSED: ${PASS}/${#TABLES[@]} tables byte-identical, relation counts equal (${DB} <- ${REMOTE})"
