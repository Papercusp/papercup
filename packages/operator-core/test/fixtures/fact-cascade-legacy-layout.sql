-- Recreate the old catalog in the calling integration test's rollback-only
-- transaction. The original 62990b15 draft had both tables but neither bound.
-- The 8e649660 draft had both bounds and no database lineage writers.
DO $fixture$
DECLARE
  layout text := current_setting('fixture.fact_cascade_layout');
BEGIN
  IF current_database() IS DISTINCT FROM current_setting('fixture.database_name') THEN
    RAISE EXCEPTION 'expected the private fact-cascade fixture database';
  END IF;
  CASE layout
    WHEN 'no queue' THEN
      DROP TABLE harness_shared.fact_change_cascade_deliveries, harness_shared.fact_change_cascades;
      ALTER TABLE harness_shared.agent_facts DROP COLUMN citation_after_version CASCADE;
    WHEN 'no deliveries' THEN
      DROP TABLE harness_shared.fact_change_cascade_deliveries;
    WHEN 'no fact boundary' THEN
      ALTER TABLE harness_shared.agent_facts DROP COLUMN citation_after_version CASCADE;
    WHEN 'no generation boundary' THEN
      ALTER TABLE harness_shared.fact_change_cascades DROP COLUMN citation_after_version CASCADE;
    WHEN 'neither boundary' THEN
      ALTER TABLE harness_shared.agent_facts DROP COLUMN citation_after_version CASCADE;
      ALTER TABLE harness_shared.fact_change_cascades DROP COLUMN citation_after_version CASCADE;
    WHEN 'no lineage writers' THEN
      DROP TRIGGER stamp_fact_citation_floor ON harness_shared.agent_facts;
      DROP TRIGGER stamp_cascade_citation_floor ON harness_shared.fact_change_cascades;
    ELSE
      RAISE EXCEPTION 'unknown fact-cascade fixture layout %', layout;
  END CASE;
END
$fixture$;
