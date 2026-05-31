#!/usr/bin/env bash
# Idempotently provisions a per-harness schema in papercusp.
# Usage:
#   bin/scaffold-harness-schema.sh <harness-slug>      # one harness
#   bin/scaffold-harness-schema.sh --all               # everything in ~/.restart-harness-projects.json
#
# Slug → schema name: lowercase, dashes → underscores, prefixed with "harness_".

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TEMPLATE="$ROOT/libs/papercusp/libs/db/sql/002-per-harness-template.sql"
REGISTRY="$HOME/.restart-harness-projects.json"

# Two modes (matching bin/papercusp-init-db.sh):
# - real Postgres (default)
# - pglite (PAPERCUSP_USE_PGLITE=1) — connects to @papercusp/pglite-server
#   over a unix domain socket; pglite has a single 'postgres' database.
if [[ "${PAPERCUSP_USE_PGLITE:-}" = "1" ]]; then
  : "${PGLITE_SOCKET_DIR:=$HOME/.papercusp/pglite-socket}"
  : "${PGUSER:=postgres}"
  : "${PGHOST:=$PGLITE_SOCKET_DIR}"
  : "${PGDATABASE:=postgres}"
  unset PGPASSWORD || true
  export PGUSER PGHOST PGDATABASE
else
  : "${PGUSER:=postgres_app}"
  : "${PGPASSWORD:=postgres}"
  : "${PGHOST:=localhost}"
  : "${PGDATABASE:=papercusp}"
  export PGUSER PGPASSWORD PGHOST PGDATABASE
fi

slug_to_schema() {
  local s="${1//-/_}"
  echo "harness_${s,,}"
}

scaffold_one() {
  local slug="$1"
  local schema; schema="$(slug_to_schema "$slug")"
  echo "→ Scaffold $slug → $schema"
  local rendered; rendered="$(mktemp)"
  sed "s/{{SCHEMA}}/$schema/g" "$TEMPLATE" > "$rendered"
  psql -v ON_ERROR_STOP=1 -q -f "$rendered"
  rm -f "$rendered"
  refresh_views
  add_to_zero_publication "$schema"
}

# Add the per-harness schema's tables to the zero_harness publication so
# their changes flow through Postgres logical replication into Zero. No-op
# if the publication doesn't exist yet (zero sync optional). Idempotent —
# safe to call multiple times.
add_to_zero_publication() {
  local schema="$1"
  psql -v ON_ERROR_STOP=1 -q <<SQL >/dev/null 2>&1
DO \$\$
DECLARE
  tbl TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'zero_harness') THEN
    -- Tables published per harness. Keep this list aligned with the
    -- per-harness template and libs/zero-harness schema.
    FOR tbl IN SELECT unnest(ARRAY[
      'harness_features',
      'feature_audit',
      'harness_issues',
      'harness_proposals',
      'agent_runs',
      'harness_snapshots',
      'messages',
      'supervisor_notes'
    ])
    LOOP
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = '${schema}' AND table_name = tbl) THEN
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname='zero_harness' AND schemaname='${schema}' AND tablename=tbl) THEN
          EXECUTE format('ALTER PUBLICATION zero_harness ADD TABLE %I.%I', '${schema}', tbl);
        END IF;
      END IF;
    END LOOP;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO harness_zero', '${schema}');
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO harness_zero', '${schema}');
  END IF;
END \$\$;
SQL
}

# Re-generate the cross-harness UNION views in harness_shared.
# Reads schemas from pg_namespace WHERE name LIKE 'harness_%' AND name != 'harness_shared'
refresh_views() {
  local sql; sql="$(mktemp)"
  cat > "$sql" <<'OUTER'
DO $$
DECLARE
  branches_features TEXT := '';
  branches_audit    TEXT := '';
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'harness\_%' ESCAPE '\'
      AND nspname <> 'harness_shared'
    ORDER BY nspname
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = rec.nspname AND table_name = 'harness_features') THEN
      IF branches_features <> '' THEN branches_features := branches_features || ' UNION ALL '; END IF;
      branches_features := branches_features || format('SELECT * FROM %I.harness_features', rec.nspname);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = rec.nspname AND table_name = 'feature_audit') THEN
      IF branches_audit <> '' THEN branches_audit := branches_audit || ' UNION ALL '; END IF;
      branches_audit := branches_audit || format('SELECT * FROM %I.feature_audit', rec.nspname);
    END IF;
  END LOOP;

  IF branches_features = '' THEN branches_features := 'SELECT NULL::text AS harness_slug, NULL::text AS feature_id, NULL::text AS title, NULL::text AS summary, NULL::text AS status, NULL::bigint AS attempts, NULL::text AS claims, NULL::text AS notes, NULL::jsonb AS metadata, NULL::text AS kind, NULL::text AS project_id, NULL::bigint AS expected_cost_cents, NULL::jsonb AS tags, NULL::boolean AS needs_human_review, NULL::bigint AS ts, NULL::bigint AS created_ts, NULL::bigint AS updated_ts WHERE FALSE'; END IF;
  IF branches_audit    = '' THEN branches_audit    := 'SELECT NULL::bigint AS id, NULL::bigint AS ts, NULL::text AS harness_slug, NULL::text AS feature_id, NULL::text AS field, NULL::text AS old_value, NULL::text AS new_value, NULL::text AS actor WHERE FALSE'; END IF;

  EXECUTE 'CREATE OR REPLACE VIEW harness_shared.all_features AS ' || branches_features;
  EXECUTE 'CREATE OR REPLACE VIEW harness_shared.all_feature_audit AS ' || branches_audit;
  EXECUTE 'GRANT SELECT ON harness_shared.all_features TO harness_app, harness_admin';
  EXECUTE 'GRANT SELECT ON harness_shared.all_feature_audit TO harness_app, harness_admin';
END $$;
OUTER
  psql -v ON_ERROR_STOP=1 -q -f "$sql"
  rm -f "$sql"
}

if [[ "${1:-}" == "--all" ]]; then
  if [[ ! -f "$REGISTRY" ]]; then
    echo "Registry not found: $REGISTRY" >&2; exit 1
  fi
  mapfile -t SLUGS < <(jq -r '.projects[].slug' "$REGISTRY")
  for s in "${SLUGS[@]}"; do scaffold_one "$s"; done
elif [[ "${1:-}" == "--refresh-views" ]]; then
  refresh_views
elif [[ -n "${1:-}" ]]; then
  scaffold_one "$1"
else
  echo "Usage: $0 <slug> | --all | --refresh-views" >&2; exit 1
fi

echo "✓ scaffolding complete"
