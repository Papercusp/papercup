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

## 6. Provider concentration — and the off-GCP mirror that closes it

The bucket lives in the **same GCP project** as the VMs. P-024 exists because
one provider held both the systems and the recovery path, and a same-project
bucket reproduces that under project suspension. A second bucket in another GCP
project does **not** fix it: account-level suspension is the modelled event, and
it takes every project on the billing account at once.

Two things now stand between us and that event.

**The procedure is provider-portable.** Every artifact restores with stock
open-source tools (`pg_restore`, `redis-server`, `clickhouse-client`, `tar`) and
needs no GCP API.

**The artifacts are no longer only on GCP.** `pc-estate-mirror.sh` (WI-645563)
keeps a verified, immutable copy on the owner's own hardware, on a daily timer:

| unit | cadence | what it does |
|---|---|---|
| `pc-estate-mirror.timer` | daily 05:15Z | pull every new snapshot, verify each artifact's sha256 against its own `MANIFEST.json`, seal it `chattr +i`, prune past 14 per host |
| `pc-estate-mirror-health.timer` | 6-hourly | assert the mirror is FRESH — a timer that quietly stops firing looks exactly like a healthy mirror from the inside |
| `pc-mirror-restore-drill.timer` | weekly | re-verify every stored byte, then actually restore one from the mirror alone |

All three carry `OnFailure=pc-estate-mirror-alert.service`, which writes a marker
file, journals, `notify-send`s, and broadcasts to the fleet over `coord:send`.
Silence is not evidence of health — EI-10733 is what a silently-rotting backup
costs (30 days).

```
/mnt/data/papercusp-estate-mirror/
  snapshots/<host>/<taken_at>/    MANIFEST.json + MIRROR-META.json + pg/ redis/ vol/
  tools/                          this runbook and the scripts, mirrored too
  MIRROR-STATE.json               last run, per-host counts, seal state, errors
  DRILL-STATE.json                per-table fingerprints from the last drill
  .quarantine/                    snapshots that FAILED verification — kept, not deleted
```

### Restoring when GCP is gone

Nothing in this path touches Google:

```bash
MIRROR=/mnt/data/papercusp-estate-mirror
ls $MIRROR/snapshots/hetzner-restore-prod/            # pick a snapshot
cat $MIRROR/snapshots/hetzner-restore-prod/<ts>/MANIFEST.json
# then follow §3 with that local directory as the artifact source.
$MIRROR/tools/RESTORE-RUNBOOK.md                      # this file, mirrored
```

The weekly drill proves that path rather than assuming it —
`pc-mirror-restore-drill.sh` restores a mirrored dump into a throwaway stock
Postgres container on the owner's box and grades four independent legs
(sha256 integrity, TOC parse against the capture-time object count, a real
restore producing relations, and no table that held rows last week holding zero
now). Its verdict ignores `pg_restore`'s exit code on purpose: pg_restore
continues past errors and returns non-zero for harmless ownership noise, so
content is the verdict, not status.

⚠ **Published snapshots are immutable.** Before any deliberate deletion:

```bash
sudo chattr -R -i /mnt/data/papercusp-estate-mirror/snapshots/<host>/<ts>
```

### What the mirror still does NOT give us

Stated plainly, because a backup you have overestimated is worse than one you
have measured:

- **It is not geographically offsite.** Fire or theft at the office destroys
  this copy. GCP still holds one, so no *single* event destroys both — that is
  two failure domains, not three.
- **It is not encrypted at rest.** It sits mode-0700 on the owner's hardware.
  Every agent here already holds `sudo -n` and read access to the source bucket,
  so a key stored on this same box would add a way to *lose* the backup without
  adding a boundary that matters. A key held elsewhere is the real fix, and
  belongs with the offsite work.
- **Both this box's filesystems run ~92% full.** The mirror refuses to run below
  a 40GB floor and alarms rather than silently skipping, but headroom is the
  thing most likely to break it first.
