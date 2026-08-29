# Papercusp estate — restore runbook

Plan `hetzner-to-gcp-restore-2026-08-28`, item **P-024**. Design + rationale: decision **D-030**.

This document and the backup script live **inside the backup bucket**
(`tools/`), so the recovery path depends on no VM, no git repo, and no
running service.

---

## 0. The one rule

**Never judge a restore by its exit code or its log shape.**

`pg_restore` continues past errors, so a restore that produced *absolutely
nothing* surfaces as one error line amid ordinary ordering noise plus a
non-zero exit that also occurs on perfectly healthy runs (WI-37835).

And **a row count is not evidence the payload survived**: 983 rows with every
`content` column NULL is total data loss that a table-exists check reports as
SUCCESS. Judge a restore by **content identity** — see §4.

---

## 1. What exists, and which artifact to reach for

Two independent families that fail differently. Use both.

| | Disk snapshots | Logical dumps (this runbook) |
|---|---|---|
| What | Whole-disk, `hetzner-restore-daily-snapshots` | Engine-produced per-database artifacts |
| Cadence / retention | Daily 03:00 UTC, 14 days | Daily 03:30 UTC, 45 days (NEARLINE at 14) |
| Restores | The entire VM, fast | One database, selectively, onto *any* host |
| Blind spot | **Faithfully preserves a broken file** (D-015: a 0-byte `dump.rdb` snapshotted perfectly, every day) | Application-level only; no OS/config |

Rule of thumb: **whole box lost → snapshot. Data wrong, corrupt, or
mis-migrated → logical dump.** A corrupt store is exactly the case the
snapshot cannot help with.

## 2. Layout

```
gs://papercusp-estate-backups-active-alcove-504205-q3/
  tools/pc-estate-backup.sh        <- the producer (canonical copy)
  tools/RESTORE-RUNBOOK.md         <- this file
  daily/<YYYY-MM-DD>/<host>/<UTC timestamp>/
      MANIFEST.json                <- START HERE: sha256 + bytes + object count per artifact
      pg/<container>__<db>.dump    <- pg_dump custom format (-Fc)
      redis/<container>.rdb        <- fresh server-side SAVE, not a file copy
      ch/<db>/schema.sql           <- ClickHouse DDL
      ch/<db>/data/<table>.native.gz
      vol/<volume>.tar.gz          <- Typesense / MinIO / SeaweedFS
```

`MANIFEST.json` also records **`excluded`** — every stateful container we
deliberately do *not* back up, with the reason. Read it before concluding
something is missing.

## 3. Restore procedures

Always verify the artifact against the manifest first:

```bash
sha256sum -c <<<"$(jq -r '.artifacts[]|"\(.sha256)  \(.path)"' MANIFEST.json)"
```

### 3a. Postgres

The archive is **custom format, a single file** (`-Fc`), chosen deliberately:
a `-Fd` *directory* archive was unrestorable in WI-37835 because the restore
tool handled only single files. Detect format from the **artifact**, never the
filename — first five bytes are `PGDMP`.

```bash
# into a scratch database, never over a live one on the first pass
createdb -U postgres restore_check
pg_restore -U postgres -d restore_check --no-owner --no-acl restart-postgres-1__restart.dump
# expect noise on stderr; IGNORE the exit code, go straight to §4
```

### 3b. Redis

```bash
docker run --rm -d --name redis_restore -v "$PWD:/seed:ro" redis:7-alpine \
  sh -c 'cp /seed/posthog-redis7-1.rdb /data/dump.rdb && redis-server --dbfilename dump.rdb --dir /data'
docker exec redis_restore redis-cli DBSIZE     # compare to manifest
```

⚠ **A 0-byte RDB is unrecoverable and boots nothing** (D-015). The backup
script refuses to produce one, so if you are holding a 0-byte RDB it did not
come from this pipeline.

### 3c. ClickHouse

Restores onto a **fresh** node — deliberately, because captured
replica/ZooKeeper metadata is a liability, not truth (D-011).

```bash
clickhouse-client -q "CREATE DATABASE posthog"
clickhouse-client -n < ch/posthog/schema.sql
for f in ch/posthog/data/*.native.gz; do
  t=$(basename "$f" .native.gz)
  gzip -dc "$f" | clickhouse-client -q "INSERT INTO posthog.\`$t\` FORMAT Native"
done
```

If the DDL names `Replicated*` engines and you are restoring to a single node
with no ZooKeeper, rewrite those engines to their non-replicated equivalents
before running the schema.

### 3d. Volumes (Typesense / MinIO / SeaweedFS)

```bash
docker run --rm -v <volume>:/v -v "$PWD:/b:ro" alpine \
  sh -c 'rm -rf /v/* && tar xzf /b/<volume>.tar.gz -C /v'
```

Typesense indexes are re-derivable from Postgres; if a tar is damaged,
reindexing is a valid recovery path.

## 4. Proving the restore actually worked — the acceptance test

Row counts do not prove the payload survived. Compare **content hashes**
between live and restored, over a stable ordering:

```sql
SELECT md5(string_agg(id::text || coalesce(<payload_col>,''), '' ORDER BY id))
  FROM <table>;
```

Run identically against live and restored. **Byte identity, not row presence.**

⚠ **Bound the comparison window, or a healthy backup reads as corrupt.** The
backup is a point in time; the live table keeps moving. An append-only table
will *always* differ by the rows written since the dump. Measured here:
`defguard.vpn_session_stats` reported FAIL purely because it gained 18 rows in
the 9 minutes between dump and drill. Bound **both** sides by a monotonic
integer primary key:

```sql
... FROM <table> x WHERE <pk> <= (SELECT max(<pk>) FROM <restored copy>)
```

Where no such key exists, report the difference as *drift* — not as
corruption you have not demonstrated. A drill that cries wolf gets ignored,
and that is how a backup rots unnoticed. `pc-restore-drill.sh` does this
automatically and prints the scope it used (`PASS (pk<=99902)`).

Two further traps:
- Check `count(*)` **vs** `count(<payload_col>)`. Equal row counts with NULL
  payloads is total loss reporting as success.
- Measure free space with `df -h -x tmpfs -x devtmpfs -x squashfs`, never
  `df -h /`. A box with a second volume will otherwise manufacture a false
  "no space" blocker.

### The drill is one command

```bash
/usr/local/bin/pc-restore-drill.sh <pg_container> <db>     # on either VM
```

It pulls the artifact back **out of the bucket** (not the local staging copy —
staging proves the dump, only the round trip proves the *backup*), verifies
sha256 against `MANIFEST.json`, restores into a throwaway database, compares
the 8 largest tables by content hash with the window bounded as above, checks
relation counts, and drops the scratch database on exit.

Verified 2026-08-29: `defguard` 8/8 tables byte-identical; `restart`
1,099,840-row `product_catalog` byte-identical.

## 5. Drill cadence

Re-run §3a + §4 against the newest artifact **quarterly**, and after any
Postgres major-version change. A backup is only known-good as of its last
restore drill — the WI-37835 artifact was fresh, complete, self-validating,
and unrestorable two independent ways for weeks.

## 6. Known limit — provider concentration

The bucket lives in the **same GCP project** as the VMs. P-024 exists because
one provider held both the systems and the recovery path, and a same-project
bucket reproduces that under project suspension.

What *is* achieved: every artifact restores with stock open-source tools
(`pg_restore`, `redis-server`, `clickhouse-client`, `tar`) and needs no GCP
API. To close the rest, copy a periodic artifact out of GCP entirely:

```bash
gcloud storage cp -r gs://papercusp-estate-backups-active-alcove-504205-q3/daily/<date> <off-provider destination>
```
