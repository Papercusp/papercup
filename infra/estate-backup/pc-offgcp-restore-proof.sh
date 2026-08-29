#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# P-024 — OFF-GCP restore proof.
#
# The drill on the VM proves the artifact restores. It does NOT prove
# provider-neutrality, because it runs inside the same provider that holds the
# systems -- which is the exact concentration P-024 exists to break.
#
# This script restores a bucket artifact on a machine OUTSIDE GCP, into a
# stock upstream postgres image, using only open-source tools, and then
# compares content against the live database. That is the only evidence that
# actually speaks to the item's rationale.
# ---------------------------------------------------------------------------
set -euo pipefail

BUCKET="gs://papercusp-estate-backups-active-alcove-504205-q3"
HOSTVM="hetzner-restore-mesh"
CONTAINER="defguard-postgres-1"
DB="defguard"
WORK="/tmp/pc-offgcp-proof"
CNAME="pc_offgcp_restore"

cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
rm -rf "$WORK"; mkdir -p "$WORK"

echo "== 1. locate + pull the artifact out of GCS =="
REMOTE=$(gcloud storage ls "${BUCKET}/daily/**/${HOSTVM}/**/pg/${CONTAINER}__${DB}.dump" 2>/dev/null | sort | tail -1)
[ -n "$REMOTE" ] || { echo "FAIL: artifact not in bucket"; exit 1; }
RUNDIR="${REMOTE%/pg/*}"
gcloud storage cp "$REMOTE" "$WORK/dump" --quiet 2>/dev/null
gcloud storage cp "${RUNDIR}/MANIFEST.json" "$WORK/MANIFEST.json" --quiet 2>/dev/null
echo "   $REMOTE"

echo "== 2. verify sha256 against the manifest =="
EXPECT=$(python3 -c "
import json
m=json.load(open('$WORK/MANIFEST.json'))
print(next((a['sha256'] for a in m['artifacts'] if a['path']=='pg/${CONTAINER}__${DB}.dump'),''))")
ACTUAL=$(sha256sum "$WORK/dump" | cut -d' ' -f1)
[ -n "$EXPECT" ] || { echo "FAIL: not listed in manifest"; exit 1; }
[ "$EXPECT" = "$ACTUAL" ] || { echo "FAIL: sha256 mismatch"; exit 1; }
echo "   sha256 OK: $ACTUAL"
[ "$(head -c5 "$WORK/dump")" = "PGDMP" ] || { echo "FAIL: not a PGDMP archive"; exit 1; }

echo "== 3. restore into a STOCK upstream postgres, off GCP, no GCP APIs =="
docker run -d --name "$CNAME" -e POSTGRES_PASSWORD=proof -v "$WORK:/b:ro" postgres:16-alpine >/dev/null
for i in $(seq 1 40); do
  docker exec "$CNAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1
done
docker exec "$CNAME" psql -U postgres -tAc "CREATE DATABASE ${DB}" >/dev/null
set +e
docker exec "$CNAME" pg_restore -U postgres -d "$DB" --no-owner --no-acl /b/dump >"$WORK/restore.log" 2>&1
echo "   pg_restore exit=$? (ignored as a verdict -- pg_restore continues past errors)"
set -e

echo "== 4. VERDICT: content identity vs the LIVE database on ${HOSTVM} =="
Q="SELECT quote_ident(schemaname)||'.'||quote_ident(relname) FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10"
mapfile -t TABLES < <(gcloud compute ssh "$HOSTVM" --zone us-central1-a --tunnel-through-iap \
  --command "sudo docker exec $CONTAINER psql -U postgres -d $DB -tAc \"$Q\"" 2>/dev/null | tr -d '\r' | grep -v '^$')

PASS=0; FAILN=0
printf '\n%-34s %10s %10s  %s\n' TABLE LIVE RESTORED VERDICT
for t in "${TABLES[@]}"; do
  # bound both sides to the backup's window via a monotonic integer PK, so a
  # live append-only table does not read as corruption (see the drill script)
  pk=$(docker exec "$CNAME" psql -U postgres -d "$DB" -tAc "
    SELECT a.attname FROM pg_index i
      JOIN pg_class c ON c.oid=i.indrelid
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum = ANY(i.indkey)
      JOIN pg_type ty ON ty.oid=a.atttypid
     WHERE i.indisprimary AND c.oid='${t}'::regclass
       AND array_length(i.indkey,1)=1 AND ty.typname IN ('int2','int4','int8')" 2>/dev/null | tr -d ' ')
  WHERE=""
  if [ -n "$pk" ]; then
    B=$(docker exec "$CNAME" psql -U postgres -d "$DB" -tAc "SELECT coalesce(max(${pk})::text,'NULL') FROM ${t}" 2>/dev/null | tr -d ' ')
    [ "$B" != "NULL" ] && WHERE="WHERE ${pk} <= ${B}"
  fi
  hq="SELECT count(*)||' '||coalesce(md5(string_agg(h,'' ORDER BY h)),'EMPTY') FROM (SELECT md5(x::text) AS h FROM ${t} x ${WHERE}) s"
  L=$(gcloud compute ssh "$HOSTVM" --zone us-central1-a --tunnel-through-iap \
        --command "sudo docker exec $CONTAINER psql -U postgres -d $DB -tAc \"$hq\"" 2>/dev/null | tr -d '\r' | grep -v '^$' | tail -1)
  R=$(docker exec "$CNAME" psql -U postgres -d "$DB" -tAc "$hq" 2>/dev/null)
  lr=${L%% *}; lh=${L##* }; rr=${R%% *}; rh=${R##* }
  if [ -n "$lh" ] && [ "$lh" = "$rh" ]; then v=PASS; PASS=$((PASS+1)); else v="FAIL(live=${lh:0:10} restored=${rh:0:10})"; FAILN=$((FAILN+1)); fi
  printf '%-34s %10s %10s  %s\n' "$t" "$lr" "$rr" "$v"
done

echo
if [ "$FAILN" -gt 0 ]; then echo "OFF-GCP PROOF FAILED: $FAILN mismatch(es)"; exit 1; fi
echo "OFF-GCP PROOF PASSED: ${PASS}/${#TABLES[@]} tables byte-identical, restored outside GCP into stock postgres:16-alpine"
