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
| `pc-estate-mirror.sh` | **the off-GCP copy** (WI-645563) — `mirror` \| `verify` \| `health` |
| `pc-mirror-restore-drill.sh` | the weekly proof that the off-GCP copy actually restores |
| `pc-estate-mirror-alert.sh` | the alarm the three mirror units share |
| `pc-estate-mirror{,-health}.{service,timer}`, `pc-mirror-restore-drill.{service,timer}`, `pc-estate-mirror-alert.service` | user units on the owner's box, symlinked to this directory |
| `RESTORE-RUNBOOK.md` | how to actually restore, per engine |

### Three drills, and why none of them replaces another

They look similar and they answer genuinely different questions. Read the
column that changes:

| drill | artifact comes from | restored on | what it proves |
|---|---|---|---|
| `pc-restore-drill.sh` | the bucket | the live VM container | the dump is good |
| `pc-offgcp-restore-proof.sh` | the bucket | a stock container off GCP | the *procedure* needs no GCP API |
| `pc-mirror-restore-drill.sh` | the **local mirror** | a stock container off GCP | we can recover **with GCP gone** |

The first two both reach into the bucket, so neither can run during the event
they are insurance against. Only the third has no GCP participant at all — and
it is the only one that is scheduled, because it is the only one whose premise
(the mirror is current and intact) decays on its own.

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

## Provider concentration — closed, and what is left

The bucket is in the **same GCP project** as the VMs it protects, which
reproduces the concentration P-024 exists to break. Format neutrality was
already achieved and proven. **WI-645563** closed the other half: the artifacts
themselves now live off GCP as well.

`pc-estate-mirror.sh` keeps a verified, immutable copy on the owner's own
hardware at `/mnt/data/papercusp-estate-mirror`, daily. Every artifact is
checked against its own `MANIFEST.json` sha256 **before** publication — a bad
copy is quarantined rather than stored — and published snapshots are sealed
`chattr +i`, so neither a stray `rm -rf` nor an agent holding `sudo` deletes one
by accident. `RESTORE-RUNBOOK.md` §6 has the layout, the recovery path, and the
unseal command.

Three units, three failure modes, one alarm:

```bash
pc-estate-mirror.timer         # daily 05:15Z — copy, verify, seal, prune to 14/host
pc-estate-mirror-health.timer  # 6-hourly    — assert FRESHNESS (a stopped timer looks healthy)
pc-mirror-restore-drill.timer  # weekly      — re-verify every byte, then actually restore one
```

All three carry `OnFailure=pc-estate-mirror-alert.service`, which writes a
marker file, journals, `notify-send`s, and broadcasts over `coord:send`. That is
four channels because each can be down alone, and because EI-10733 is what a
silently-rotting backup costs here: 30 days.

**What is still open, stated plainly:**

- **Not geographically offsite.** Fire or theft at the office destroys the
  mirror. GCP still holds a copy, so no *single* event destroys both — two
  failure domains, not three. The strictly stronger answer is S3 Object Lock in
  the existing `papercusp-byoc` AWS account, which needs an owner decision: its
  SSO token expired 2026-08-23, and an unattended daily job cannot use SSO at
  all, so it needs a long-lived IAM key deliberately created for it.
- **Not encrypted at rest.** Every agent here already holds `sudo -n` and read
  access to the source bucket, so a key kept on this same box would add a way to
  *lose* the backup without adding a boundary that matters. A key held elsewhere
  is the real fix, and it belongs with the offsite work above.
- **Both filesystems on this box run ~92% full.** The mirror refuses below a
  40GB floor and alarms rather than skipping quietly, but headroom is the thing
  most likely to break it first.
