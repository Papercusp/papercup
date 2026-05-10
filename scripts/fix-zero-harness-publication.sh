#!/usr/bin/env bash
# Add the Phase-2/3 harness_shared.* tables to the zero_harness PG
# publication and grant SELECT to the harness_zero role.
#
# Why this exists: when Phase 2 (chokidar mirror — summaries, reviews,
# proposals) and Phase 3 (orchestrator-writes-status — harness_status,
# harness_lanes) shipped, they added new tables under harness_shared.*
# but no migration extended the existing zero_harness publication. Result:
# zero-cache silently can't replicate those tables; every Zero subscription
# that targets them returns the error
#   "harness_shared.<table> does not exist or is not one of the
#    replicated tables"
# and the @restart/sync provider falls back to REST polling forever.
#
# This script is idempotent — `ADD TABLE` errors when a table is already
# in the publication, so we add them one at a time and ignore "already a
# member" errors. GRANT is naturally idempotent.
#
# After running, restart zero-cache-harness so it picks up the new tables.

set -u

PG_USER="${PG_USER:-postgres_app}"
PG_PASS="${PG_PASS:-postgres}"
PG_HOST="${PG_HOST:-localhost}"
PG_DB="${PG_DB:-papercusp}"
PUB="${PUB:-zero_harness}"
ZERO_ROLE="${ZERO_ROLE:-harness_zero}"

TABLES=(
  harness_summaries
  pending_reviews
  harness_proposals_shared
  harness_status
  harness_lanes
  user_actions
  harness_pending_issues
  harness_phases
  harness_tests
  harness_escalations
  org_charter
  org_departments
  org_projects
  org_inbox
  org_outbox
  org_notes
  org_decisions
  operator_scans
  delegates
  operator_budget
  operator_last_scan
  operator_standing_candidates
  operator_idle_snapshot
  operator_tts_spend
  operator_stt_spend
  operator_voice_prefs
  operator_agent_config
  operator_scanner_session
  operator_first_run
  operator_user_profile
  operator_prompt_user
  operator_preferences
  operator_dismissed_cards
  operator_oracle_prompt
  operator_oracle_memory
  autoloop_state
  el_conv_calls
  project_spec_revisions
  delegate_inbox
  toast_log
  harness_archives
  harness_plan_review
  harness_smoke_test
  harness_checkpoints
  harness_hook_logs
  harness_screenshots
  harness_decisions
  harness_git_log
  harness_health
  harness_branch_actions
)

export PGPASSWORD="$PG_PASS"

for t in "${TABLES[@]}"; do
  printf "  %-40s " "$t"
  out=$(psql -U "$PG_USER" -h "$PG_HOST" -d "$PG_DB" -tAc "ALTER PUBLICATION $PUB ADD TABLE harness_shared.$t;" 2>&1)
  if [ $? -eq 0 ]; then
    echo "added"
  elif echo "$out" | grep -q "is already member of publication"; then
    echo "already in publication"
  elif echo "$out" | grep -q "does not exist"; then
    echo "skipped (table missing)"
  else
    echo "ERROR: $out"
  fi
done

echo "Granting SELECT to $ZERO_ROLE..."
TABLES_LIST=$(printf "harness_shared.%s," "${TABLES[@]}" | sed 's/,$//')
psql -U "$PG_USER" -h "$PG_HOST" -d "$PG_DB" -c "GRANT SELECT ON $TABLES_LIST TO $ZERO_ROLE;" >/dev/null 2>&1 && echo "  OK" || echo "  FAILED"

echo
echo "Tables now in $PUB / harness_shared:"
psql -U "$PG_USER" -h "$PG_HOST" -d "$PG_DB" -tAc \
  "SELECT '  ' || tablename FROM pg_publication_tables WHERE pubname='$PUB' AND schemaname='harness_shared' ORDER BY tablename;"

echo
echo "Restart zero-cache to pick up changes:"
echo "  systemctl --user restart zero-cache-harness"
