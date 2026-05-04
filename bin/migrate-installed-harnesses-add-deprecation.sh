#!/usr/bin/env bash
# Idempotently adds the per-harness columns introduced this session:
#   - harness_<slug>.harness_features.deprecation_reason   (TEXT)
#   - harness_<slug>.harness_proposals.applied_at          (BIGINT)
#   - harness_<slug>.harness_proposals.rejected_at         (BIGINT)
#
# These were added to libs/papercusp/libs/db/sql/002-per-harness-template.sql
# so new harnesses get them automatically. This script back-fills existing
# harnesses (one-time migration; safe to re-run).
#
# Usage:
#   bin/migrate-installed-harnesses-add-deprecation.sh        # all
#   bin/migrate-installed-harnesses-add-deprecation.sh <slug> # one harness

set -euo pipefail

if [[ "${PAPERCUSP_USE_PGLITE:-}" = "1" ]]; then
  : "${PGLITE_SOCKET_DIR:=$HOME/.papercusp/pglite-socket}"
  : "${PGUSER:=postgres}"
  : "${PGHOST:=$PGLITE_SOCKET_DIR}"
  : "${PGDATABASE:=postgres}"
  unset PGPASSWORD || true
else
  : "${PGUSER:=postgres_app}"
  : "${PGPASSWORD:=postgres}"
  : "${PGHOST:=localhost}"
  : "${PGDATABASE:=papercusp}"
  export PGPASSWORD
fi
export PGUSER PGHOST PGDATABASE

if [ "${1:-}" != "" ]; then
  SCHEMAS=$(echo "$1" | sed 's/-/_/g; s/^/harness_/')
else
  SCHEMAS=$(psql -tAc "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared' ORDER BY schema_name")
fi

count=0
for schema in $SCHEMAS; do
  psql -v ON_ERROR_STOP=1 -tAc "
    ALTER TABLE $schema.harness_features  ADD COLUMN IF NOT EXISTS deprecation_reason TEXT;
    ALTER TABLE $schema.harness_proposals ADD COLUMN IF NOT EXISTS applied_at BIGINT;
    ALTER TABLE $schema.harness_proposals ADD COLUMN IF NOT EXISTS rejected_at BIGINT;
  " >/dev/null
  count=$((count + 1))
done

echo "  migrated: $count harness schema(s)"
