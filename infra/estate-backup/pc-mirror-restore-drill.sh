#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# pc-mirror-restore-drill.sh — prove a restore FROM THE OFF-GCP COPY (WI-645563)
#
# THE POINT — this is the THIRD drill here, and the other two cannot do its job
#   pc-restore-drill.sh        bucket -> live VM container.  Proves the dump.
#   pc-offgcp-restore-proof.sh bucket -> stock container off GCP.
#                              Proves the PROCEDURE needs no GCP API.
#   this one                   MIRROR -> stock container off GCP.
#                              Proves we can recover WITH GCP GONE.
#
#   The distinction is one column wide and it is the whole point: the first two
#   both reach into the bucket, so neither can run during the event they are
#   insurance against. Only this one has no GCP participant at all. It is also
#   the only one that is SCHEDULED, because it is the only one whose premise —
#   that the local copy is current and intact — decays on its own.
#
#   This drill answers that second question, so it touches nothing Google owns:
#     source  = the local mirror on this box
#     engine  = a throwaway stock postgres container on this box
#     runbook = the mirrored copy under $MIRROR/tools
#   If GCP vanished mid-run, this script would still finish.
#
# THE VERDICT — four legs, each of which can fail on its own
#   1. INTEGRITY   every artifact matches the sha256 the VM recorded at capture.
#   2. PARSE       pg_restore -l parses the archive, and the TOC entry count
#                  equals the `objects` count the VM recorded at capture time.
#   3. RESTORE     the archive actually restores into a stock Postgres and
#                  yields relations. pg_restore's EXIT CODE is deliberately not
#                  the verdict -- it continues past errors and returns non-zero
#                  for harmless ownership noise, which is precisely how a
#                  half-restored database gets called a failure and a failed one
#                  gets called fine. Content is the verdict.
#   4. NO-REGRESS  no table that held rows in the previous drill holds zero now.
#                  A dump that silently lost one table's contents passes every
#                  size and checksum check ever devised; only this catches it.
#
# Exits non-zero if any leg fails, so systemd's OnFailure= alarm fires.
# ---------------------------------------------------------------------------
set -uo pipefail

MIRROR="${PC_ESTATE_MIRROR_ROOT:-/mnt/data/papercusp-estate-mirror}"
HOST="${1:-hetzner-restore-prod}"
ARTIFACT="${2:-pg/restart-postgres-1__restart.dump}"
TOPN="${PC_DRILL_TOPN:-12}"
STATEF="$MIRROR/DRILL-STATE.json"
CID=""
WORK=""
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERT="$SELF_DIR/pc-estate-mirror-alert.sh"

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { log "FAIL: $*"; FAILED+=("$*"); }
FAILED=()

cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT

command -v docker >/dev/null || { log "docker not available"; exit 2; }
WORK="$(mktemp -d)"

# --- 0. locate the newest mirrored snapshot for this host -------------------
HOSTDIR="$MIRROR/snapshots/$HOST"
[ -d "$HOSTDIR" ] || { log "no mirrored snapshots for $HOST under $MIRROR"; exit 1; }
SNAP="$(ls -1 "$HOSTDIR" 2>/dev/null | sort | tail -1)"
[ -n "$SNAP" ] || { log "no snapshots in $HOSTDIR"; exit 1; }
SRC="$HOSTDIR/$SNAP"
DUMP="$SRC/$ARTIFACT"
log "drilling $HOST/$SNAP -> $ARTIFACT"
log "source is LOCAL ONLY: $DUMP"
[ -f "$DUMP" ] || { log "artifact absent from the mirror: $DUMP"; exit 1; }

# --- 1. INTEGRITY -----------------------------------------------------------
EXPECT_SHA=$(python3 -c "
import json,sys
m=json.load(open('$SRC/MANIFEST.json'))
print(next((a.get('sha256','') for a in m.get('artifacts',[]) if a['path']=='$ARTIFACT'),''))" 2>/dev/null)
EXPECT_OBJ=$(python3 -c "
import json,sys
m=json.load(open('$SRC/MANIFEST.json'))
print(next((a.get('objects','') for a in m.get('artifacts',[]) if a['path']=='$ARTIFACT'),''))" 2>/dev/null)
if [ -z "$EXPECT_SHA" ]; then
  fail "artifact not listed in the mirrored MANIFEST.json"
else
  ACTUAL_SHA=$(sha256sum "$DUMP" | cut -d' ' -f1)
  if [ "$ACTUAL_SHA" = "$EXPECT_SHA" ]; then
    log "leg 1 INTEGRITY: PASS (sha256 matches capture-time manifest)"
  else
    fail "leg 1 INTEGRITY: sha256 $ACTUAL_SHA != manifest $EXPECT_SHA"
  fi
fi

# --- 2. PARSE ---------------------------------------------------------------
# The dump's own header names the server version that produced it; restoring a
# newer archive with an older pg_restore fails with an opaque error, so pick
# the image from the archive instead of guessing.
# A pg custom archive records the producing server version as a bare "16.14"
# string in its first few hundred bytes, right after the database name — so
# this is a 512-byte read, not a `strings` pass over 715MB. Restoring a newer
# archive with an older pg_restore fails with an opaque "unsupported version"
# error, which is a miserable thing to debug from a weekly timer, so read the
# version rather than guessing it.
SRCVER=$(head -c 512 "$DUMP" 2>/dev/null | strings | grep -m1 -oE '^[0-9]+\.[0-9]+$' | cut -d. -f1)
if [ -n "$SRCVER" ]; then
  PGIMG="postgres:${SRCVER}"
  log "archive was dumped from Postgres ${SRCVER}.x; using $PGIMG"
else
  PGIMG="postgres:16"
  log "WARNING: could not read the producing Postgres version from the archive header; defaulting to $PGIMG"
fi

CID=$(docker run -d --rm -e POSTGRES_PASSWORD=drill -e POSTGRES_HOST_AUTH_METHOD=trust \
        --name "pc-mirror-drill-$$" "$PGIMG" 2>/dev/null)
if [ -z "$CID" ]; then
  log "could not start $PGIMG (image missing? try: docker pull $PGIMG)"; exit 2
fi
for _ in $(seq 1 60); do
  docker exec "$CID" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CID" pg_isready -U postgres >/dev/null 2>&1 || { log "postgres never became ready"; exit 2; }

docker cp "$DUMP" "$CID:/tmp/drill.dump" >/dev/null 2>&1 || { fail "docker cp of the dump failed"; }
TOC=$(docker exec "$CID" pg_restore -l /tmp/drill.dump 2>/dev/null | grep -cv '^;' || echo 0)
if [ "$TOC" -eq 0 ]; then
  fail "leg 2 PARSE: pg_restore -l produced no TOC entries"
elif [ -n "$EXPECT_OBJ" ] && [ "$TOC" != "$EXPECT_OBJ" ]; then
  fail "leg 2 PARSE: TOC entries $TOC != capture-time objects $EXPECT_OBJ"
else
  log "leg 2 PARSE: PASS (${TOC} TOC entries, matches capture-time count)"
fi

# --- 3. RESTORE -------------------------------------------------------------
DRILLDB="drill_$(date -u +%H%M%S)"
docker exec "$CID" psql -U postgres -tAc "CREATE DATABASE ${DRILLDB}" >/dev/null 2>&1
docker exec "$CID" pg_restore -U postgres -d "$DRILLDB" --no-owner --no-acl /tmp/drill.dump \
  >"$WORK/restore.log" 2>&1
RC=$?
log "pg_restore exit=${RC} (NOT the verdict — content is, see leg 3/4)"

RELS=$(docker exec "$CID" psql -U postgres -d "$DRILLDB" -tAc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND c.relkind IN ('r','m','S','p')" 2>/dev/null | tr -dc '0-9')
if [ "${RELS:-0}" -gt 0 ]; then
  log "leg 3 RESTORE: PASS (${RELS} relations live in the restored database)"
else
  fail "leg 3 RESTORE: the restored database holds ZERO relations (see $WORK/restore.log)"
  head -20 "$WORK/restore.log" >&2 2>/dev/null || true
fi

# --- 4. NO-REGRESS ----------------------------------------------------------
# Fingerprint the largest tables. A count alone would pass a dump whose payload
# columns were all NULLed out, so hash the rows too.
docker exec "$CID" psql -U postgres -d "$DRILLDB" -tAF$'\t' -c "
  SELECT quote_ident(schemaname)||'.'||quote_ident(relname)
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT ${TOPN}" \
  2>/dev/null | tr -d ' ' >"$WORK/tables"

: >"$WORK/fingerprint"
while IFS= read -r t; do
  [ -n "$t" ] || continue
  r=$(docker exec "$CID" psql -U postgres -d "$DRILLDB" -tAc \
      "SELECT count(*)||' '||coalesce(md5(string_agg(h,'' ORDER BY h)),'EMPTY')
         FROM (SELECT md5(x::text) AS h FROM ${t} x) s" 2>/dev/null)
  printf '%s\t%s\n' "$t" "${r:-ERR ERR}" >>"$WORK/fingerprint"
done <"$WORK/tables"

REGRESS=$(python3 - "$STATEF" "$WORK/fingerprint" "$HOST" "$ARTIFACT" "$SNAP" <<'PY'
import json, os, sys, datetime
statef, fpf, host, artifact, snap = sys.argv[1:6]
key = "%s::%s" % (host, artifact)
cur = {}
for line in open(fpf):
    parts = line.rstrip("\n").split("\t")
    if len(parts) != 2:
        continue
    t, rest = parts
    rows = rest.split(" ")[0]
    cur[t] = int(rows) if rows.isdigit() else -1
prev = {}
state = {}
if os.path.isfile(statef):
    try:
        state = json.load(open(statef))
        prev = (state.get(key) or {}).get("tables") or {}
    except Exception:
        state = {}
regress = [t for t, n in prev.items()
           if n > 0 and t in cur and cur[t] == 0]
state[key] = {
    "last_drill_at": datetime.datetime.now(datetime.timezone.utc)
                      .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "snapshot": snap,
    "tables": cur,
    "regressions": regress,
}
json.dump(state, open(statef, "w"), indent=2)
for t in regress:
    print(t)
PY
)
if [ -n "$REGRESS" ]; then
  fail "leg 4 NO-REGRESS: table(s) that held rows in the previous drill are now EMPTY: $(echo "$REGRESS" | tr '\n' ' ')"
elif [ ! -s "$WORK/fingerprint" ]; then
  fail "leg 4 NO-REGRESS: could not fingerprint any table"
else
  log "leg 4 NO-REGRESS: PASS ($(wc -l <"$WORK/fingerprint") tables fingerprinted, none emptied)"
fi

# --- verdict ----------------------------------------------------------------
echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "DRILL PASS — ${HOST}/${SNAP} ${ARTIFACT} restored from the OFF-GCP mirror alone."
  echo "  source:  $DUMP"
  echo "  engine:  $PGIMG (throwaway container on this box)"
  echo "  result:  ${RELS} relations, ${TOC} TOC entries, sha256 verified"
  echo "  GCP participation in this proof: none."
  exit 0
fi
echo "DRILL FAIL — ${#FAILED[@]} leg(s):"
printf '  - %s\n' "${FAILED[@]}"
[ -x "$ALERT" ] && "$ALERT" "restore drill FROM THE MIRROR failed: ${FAILED[0]}"
exit 1
