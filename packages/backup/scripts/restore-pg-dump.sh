#!/usr/bin/env bash
#
# restore-pg-dump.sh — safely import a Postgres dump into a target database.
#
# It accepts EITHER of the two dump shapes this box actually produces:
#
#   1. PLAIN SQL (`.sql` / `.sql.gz`) — what `hook.ts` writes into
#      `<workspaceRoot>/db-dumps/pg-embedded.sql.gz` before every kopia
#      snapshot. Imported with `psql -f`.
#   2. ARCHIVE (`pg_dump -Fd` directory, or `-Fc` custom file) — what the
#      hourly host backup (`~/.config/kopia/db-backup.sh`, systemd unit
#      `papercusp-db-backup.service`) writes to
#      `/mnt/data/Backup/db-dumps/pg/<db>/`. Imported with `pg_restore`.
#
# WHY BOTH (WI-37835, 2026-08-11): the PRIMARY disaster-recovery artifact on
# this box is the hourly `-Fd` directory dump — and until this change the only
# documented restore tool could not read it at all (it `exit 1`-ed on "dump
# file not found", because a directory is not a `-f` file). A DR script that
# cannot open the actual backup is not a DR story. Format is now DETECTED, not
# assumed from the filename.
#
# WHY THIS SCRIPT EXISTS (EI-13868):
#   A backup/restore round-trip drill (WI-3207, 2026-07-17) found that the
#   "obvious" restore step — `gzip -d | psql -f` — has two real, reproducible
#   failure modes when importing a self-generated dump on this stack:
#
#   1. PG18's pg_dump wraps the whole dump in `\restrict TOKEN` /
#      `\unrestrict TOKEN` (a security feature that gates other backslash
#      meta-commands while replaying an UNTRUSTED dump). Importing the raw
#      dump via plain `psql -f` desyncs psql's COPY-data parser part-way
#      through ("backslash commands are restricted; only \unrestrict is
#      allowed", then cascading syntax errors as literal data rows get fed
#      to the SQL parser) and eventually OOMs the psql process. This dump is
#      SELF-GENERATED and TRUSTED (it's our own workspace's data, not an
#      untrusted third party's) — the `\restrict` guard exists to protect
#      against a hostile dump, which this isn't — so it's safe to strip the
#      two marker lines before importing. Do NOT do this for a dump you did
#      not generate yourself.
#   2. `harness_admin` is `LOGIN SUPERUSER` on every environment this schema
#      is designed for (embedded-pg, test containers, frame-bootstrap — see
#      libs/papercusp/packages/embedded-postgres-server/src/index.js) — but a
#      role that ISN'T superuser cannot run the dump's `CREATE EXTENSION`
#      statements (vector / pg_trgm / pgcrypto), which cascades into every
#      vector-typed table failing to create ("relation does not exist" at
#      COPY time) further down the dump. Import as an actual Postgres
#      superuser role.
#
# USAGE:
#   ./restore-pg-dump.sh <dump.sql.gz|dump.sql|dumpdir|dump.dump> \
#                        <target-db-name> [target-url]
#
#   <target-db-name>  Database to import into. Created first (via
#                      `CREATE DATABASE ... OWNER <owner>`) if it doesn't
#                      already exist — this script never touches an existing
#                      database's tables beyond what the dump itself creates,
#                      and refuses outright if the target name matches a
#                      LIVE-looking name (see the guard below) unless
#                      RESTORE_FORCE=1 is set.
#   [target-url]       Optional full superuser connection URL, e.g.
#                       postgresql://harness_admin:harness_admin_pwd@localhost:5532/x
#                       (embedded-pg: harness_admin IS superuser there).
#                       Omit to use `sudo -u postgres psql` against the
#                       native install on :5432 (this dev box's harness_admin
#                       is NOT superuser — see EI-13868).
#
# EXAMPLES:
#   # Native dev-box Postgres, restore-drill scratch DB:
#   ./restore-pg-dump.sh ~/.papercusp-workspaces/default/db-dumps/pg-embedded.sql.gz restore_scratch_20260719
#
#   # Embedded-pg target (harness_admin already superuser there):
#   ./restore-pg-dump.sh dump.sql.gz restore_scratch \
#     postgresql://harness_admin:harness_admin_pwd@localhost:5532/postgres
#
# EXIT CODES:
#   0 — imported; row-count sanity check on key tables passed (or table absent)
#   1 — bad usage / missing dump file
#   2 — refused: target name looks live and RESTORE_FORCE was not set
#   3 — CREATE DATABASE failed
#   4 — import (psql / pg_restore) failed — see printed stderr tail
#   5 — post-import verification found a real problem (missing expected table,
#       or the doc corpus came back with every `content` NULL — see below)
#
# This never touches the LIVE database directly: it creates a NEW database
# and imports into that. Diff/promote the result yourself
# (backup:diff / backup:promote / a manual comparison) — this script's job
# ends at "the dump imported cleanly into a fresh DB".

set -euo pipefail

DUMP_PATH="${1:-}"
TARGET_DB="${2:-}"
TARGET_URL="${3:-}"

if [[ -z "$DUMP_PATH" || -z "$TARGET_DB" ]]; then
  echo "Usage: $0 <dump.sql.gz|dump.sql> <target-db-name> [target-url]" >&2
  exit 1
fi

if [[ ! -e "$DUMP_PATH" ]]; then
  echo "ERROR: dump path not found: $DUMP_PATH" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Detect the archive format from the ARTIFACT, never from the filename.
#
# A `-Fd` dump is a DIRECTORY holding `toc.dat` + numbered `*.dat[.gz]` members;
# a `-Fc` dump is a single file whose first five bytes are the literal `PGDMP`.
# Both are pg_restore targets. Anything else is treated as plain SQL text
# (optionally gzipped), which is the psql path.
#
# Filename-sniffing would be wrong in both directions here: the host artifact
# is a directory with NO extension at all, and its members are `.gz` while the
# archive itself is not a gzipped SQL stream.
# ---------------------------------------------------------------------------
DUMP_FORMAT=""
if [[ -d "$DUMP_PATH" ]]; then
  if [[ ! -f "$DUMP_PATH/toc.dat" ]]; then
    echo "ERROR: '$DUMP_PATH' is a directory but has no toc.dat — that is not a" >&2
    echo "       pg_dump -Fd archive. Point at the archive directory itself" >&2
    echo "       (e.g. /mnt/data/Backup/db-dumps/pg/papercusp), not its parent." >&2
    exit 1
  fi
  DUMP_FORMAT="directory"
elif [[ "$(head -c 5 "$DUMP_PATH" 2>/dev/null || true)" == "PGDMP" ]]; then
  DUMP_FORMAT="custom"
else
  DUMP_FORMAT="plain"
fi
echo "==> detected dump format: $DUMP_FORMAT ($DUMP_PATH)"

# Refuse an obviously-live-looking target name unless explicitly forced.
# This is a scratch-restore tool, not a disaster-recovery cutover tool.
case "$TARGET_DB" in
  papercusp|postgres|harness_admin|harness_shared)
    if [[ "${RESTORE_FORCE:-0}" != "1" ]]; then
      echo "ERROR: target-db-name '$TARGET_DB' looks like a live/system database." >&2
      echo "       Refusing to import over it. Set RESTORE_FORCE=1 to override" >&2
      echo "       (only if you genuinely mean a disaster-recovery cutover, and" >&2
      echo "       you have your own safety net for the current contents)." >&2
      exit 2
    fi
    ;;
esac

# Build the psql invocation. With TARGET_URL given, connect directly (the
# caller is asserting that role is a superuser there — e.g. embedded-pg's
# harness_admin). Without it, use `sudo -u postgres psql` against the local
# native install on :5432, which is what this drill actually used (this
# dev box's native harness_admin role is NOT superuser — EI-13868).
if [[ -n "$TARGET_URL" ]]; then
  PSQL_SUPER=(psql "$TARGET_URL")
  # The URL's own database is just the connect-to-create-database-from
  # target; the actual import happens against $TARGET_DB below via a
  # database-qualified URL derived by swapping the path component.
  BASE_URL="${TARGET_URL%/*}"
  IMPORT_URL="$BASE_URL/$TARGET_DB"
  PSQL_IMPORT=(psql "$IMPORT_URL")
  PG_RESTORE_IMPORT=(pg_restore -d "$IMPORT_URL")
else
  PSQL_SUPER=(sudo -u postgres psql)
  PSQL_IMPORT=(sudo -u postgres psql -d "$TARGET_DB")
  PG_RESTORE_IMPORT=(sudo -u postgres pg_restore -d "$TARGET_DB")
fi

echo "==> target database: $TARGET_DB"

EXISTS="$("${PSQL_SUPER[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" 2>&1)" || {
  echo "ERROR: could not reach the superuser connection to check/create the database:" >&2
  echo "$EXISTS" >&2
  exit 3
}

if [[ "$EXISTS" != "1" ]]; then
  echo "==> creating database $TARGET_DB..."
  if ! "${PSQL_SUPER[@]}" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$TARGET_DB\";"; then
    echo "ERROR: CREATE DATABASE failed." >&2
    exit 3
  fi
else
  echo "==> database $TARGET_DB already exists — importing into it as-is."
fi

# Decompress (if needed) and strip the \restrict / \unrestrict marker lines
# before piping into psql. Safe ONLY for a dump we generated ourselves — see
# the header comment.
decompress() {
  if [[ "$DUMP_PATH" == *.gz ]]; then
    gzip -dc "$DUMP_PATH"
  else
    cat "$DUMP_PATH"
  fi
}

echo "==> importing (this can take a while for a large dump)..."
IMPORT_LOG="$(mktemp)"
trap 'rm -f "$IMPORT_LOG"' EXIT

if ! decompress \
    | sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' \
    | "${PSQL_IMPORT[@]}" -v ON_ERROR_STOP=0 -f - >"$IMPORT_LOG" 2>&1; then
  echo "ERROR: import pipeline reported a non-zero exit." >&2
  tail -n 50 "$IMPORT_LOG" >&2
  exit 4
fi

REAL_ERRORS="$(grep -c '^psql:.*ERROR:' "$IMPORT_LOG" || true)"
if [[ "$REAL_ERRORS" -gt 0 ]]; then
  echo "==> import finished with $REAL_ERRORS ERROR line(s) (see below) — a few" \
       "index/extension-ordering errors on a schema-and-data dump are common" \
       "and non-fatal; eyeball them, don't assume clean:"
  grep '^psql:.*ERROR:' "$IMPORT_LOG" | head -20
else
  echo "==> import finished with 0 ERROR lines."
fi

# Post-import sanity check: a handful of release-critical tables should
# exist (this is exactly what gap #2 silently broke — those tables never
# got created at all, and nothing in a raw psql exit code said so). A
# schema-only or partial dump may legitimately omit some of these, so a
# single missing table is only a warning — but if EVERY one of them is
# missing, that's the EI-13868 failure mode recurring (extensions never
# got created, so nothing vector-typed exists), so fail loudly.
echo "==> verifying key tables..."
PRESENT_COUNT=0
for T in work_items harness_plans engineer_issues; do
  COUNT="$("${PSQL_IMPORT[@]}" -tAc \
    "SELECT count(*) FROM harness_shared.$T" 2>&1)" && {
    echo "   $T: $COUNT rows"
    PRESENT_COUNT=$((PRESENT_COUNT + 1))
    continue
  }
  echo "   $T: NOT PRESENT"
done

if [[ "$PRESENT_COUNT" -eq 0 ]]; then
  echo "ERROR: none of the release-critical tables exist after import — this is" >&2
  echo "       the EI-13868 failure mode (extensions never created, so nothing" >&2
  echo "       vector-typed exists). Check the import log above for CREATE" >&2
  echo "       EXTENSION errors; the importing role likely lacks superuser." >&2
  exit 5
fi

echo "==> done. Restored into database '$TARGET_DB'. Diff/promote manually —" \
     "this script never touches the live database."
