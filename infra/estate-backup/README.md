# Estate backup — provider-neutral logical backups for the GCP-restored estate

Covers `hetzner-restore-prod` and `hetzner-restore-mesh` (project
`active-alcove-504205-q3`, zone `us-central1-a`).

Built for plan `hetzner-to-gcp-restore-2026-08-28`, item **P-024**.
Design and the measured population: decision **D-030**.
Why the verifier is manifest-driven: decision **D-031**.

## Why this exists alongside disk snapshots

A disk snapshot faithfully preserves a **broken** file. D-015 measured exactly
that on this estate: PostHog's `dump.rdb` was 0 bytes at source, and every
snapshot of it was a perfect copy of an unusable file.

Engine-produced logical dumps fail at **backup** time instead of at **restore**
time. The two families are not redundant — they fail differently, and you want
both:

| | Disk snapshots | Logical dumps (this directory) |
|---|---|---|
| Cadence / retention | daily 03:00 UTC, 14 days | daily 03:30 UTC, 45 days (NEARLINE at 14) |
| Restores | the whole VM, fast | one database, selectively, onto *any* host |
| Blind spot | preserves corruption perfectly | application state only, no OS/config |

## Files

| file | what it is |
|---|---|
| `pc-estate-backup.sh` | the producer. Installed at `/usr/local/bin/` on both VMs |
| `pc-estate-backup.{service,timer}` | daily 03:30 UTC, `/etc/systemd/system/` |
| `pc-restore-drill.sh` | the acceptance test — restores from the bucket and compares content hashes |
| `pc-offgcp-restore-proof.sh` | restores an artifact **outside GCP** into stock `postgres:16-alpine` |
| `RESTORE-RUNBOOK.md` | how to actually restore, per engine |

These are **also** stored in the backup bucket under `tools/`, deliberately:
the recovery path must not depend on this repo, on a VM, or on any running
service. This directory is the version-controlled copy; the bucket copy is the
operational one. Keep them in sync — `md5sum` is the check.

## Three rules the code encodes, each earned from a measured failure

1. **`-Fc` single file, never `-Fd`.** WI-37835: a `-Fd` *directory* archive was
   unrestorable because the restore tool handled only single files — while
   passing its own health check the entire time.
2. **Redis via `redis-cli --rdb`**, which forces a fresh server-side SAVE, with
   a hard failure on a 0-byte or header-less result. Copying `dump.rdb` off
   disk is what hid D-015.
3. **Declared-then-reconciled inventory.** An undeclared stateful container
   aborts the run (exit 3). A newly added database therefore *breaks the
   backup loudly* instead of being silently skipped. This is the recurrence
   guard for the whole class, and it fired correctly on its first run.

## Verifying

```bash
/usr/local/bin/pc-restore-drill.sh <pg_container> <db>   # on either VM
./pc-offgcp-restore-proof.sh                             # from a non-GCP machine
```

The drill pulls the artifact back **out of the bucket** — the local staging
copy proves the dump, only the round trip proves the *backup* — verifies
sha256 against `MANIFEST.json`, restores into a throwaway database, and
compares content hashes against live with the comparison window bounded by a
monotonic primary key (an append-only table will otherwise always "fail" by
the rows written since the dump).

Verified 2026-08-29: `defguard` 8/8 tables byte-identical · `restart` 8/8
including four 1.1M-row tables, 64/64 relations · off-GCP Postgres 10/10 ·
off-GCP Redis 138 keys into stock `redis:7.2-alpine`.

**Never judge a restore by exit code or log shape** — `pg_restore` continues
past errors. And a row count is not evidence the payload survived. See
`RESTORE-RUNBOOK.md` §0.

## Known limit

The bucket is in the **same GCP project** as the VMs it protects, which
reproduces the concentration P-024 exists to break. Format neutrality *is*
achieved and proven (every artifact restores with stock open-source tools, no
GCP API). Closing the rest is tracked as **WI-645563**.
