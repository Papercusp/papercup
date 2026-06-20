-- ============================================================================
-- DRAFT — papercup → papercusp full data rename.
-- NOT in libs/papercusp/libs/db/sql/ ⇒ does NOT auto-apply on boot.
-- Apply ONLY in the coordinated cutover (see plan papercup-to-papercusp-migration-2026-06-20):
--   1. land the CODE cutover too (register-papercup→register-papercusp,
--      LEGACY_DEFAULT_HOME_HARNESS='papercusp', PAPERCUP_HARNESS_SLUG→PAPERCUSP_HARNESS_SLUG)
--      — else the next boot's registerPapercupHarness() re-creates 'papercup' (split-brain);
--   2. drain / quiesce the routine engine first (git-sync + green-checkpoint are live
--      install_slug='papercup' routines — don't rename them mid-fire);
--   3. restart the operator so routines re-register + fire under 'papercusp';
--   4. resolve the (now) papercusp-hive cursed placements terminal + scope the cursed
--      anti-join by install_slug so a retired install never poisons the active frontier.
--
-- Mapping = uniform prefix substitution (idempotent; re-runnable):
--   papercup → papercusp · papercup-hive → papercusp-hive · papercup-org → papercusp-org
--   ('papercusp-workspace' has NO 'papercup' substring — cuSp ≠ cuP — so it is never touched.)
-- ============================================================================

DO $$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  -- 1. Every slug column in harness_shared (install_slug / harness_slug / hive_slug /
  --    home_slug / hive_home_slug). Prefix-replace preserves sub-harness slugs
  --    ('papercup/libs/sync' → 'papercusp/libs/sync').
  FOR r IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND column_name ~ '(install|harness|hive|home)_slug'
     ORDER BY table_name, column_name
  LOOP
    EXECUTE format(
      'UPDATE harness_shared.%I SET %I = ''papercusp'' || substring(%I from 9) '
      || 'WHERE %I LIKE ''papercup%%''',
      r.table_name, r.column_name, r.column_name, r.column_name);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE NOTICE '  %.% : % rows', r.table_name, r.column_name, n;
      total := total + n;
    END IF;
  END LOOP;

  -- 2. operator_settings KEYS: hive_started:* / overwatch_*:* / overwatch_cadence_sec:* : papercup*.
  --    'papercup' as a substring only appears in the install component (workspace = papercusp-*).
  UPDATE harness_shared.operator_settings
     SET key = replace(key, 'papercup', 'papercusp')
   WHERE key LIKE '%papercup%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE '  operator_settings.key : % rows', n; total := total + n; END IF;

  RAISE NOTICE 'papercup→papercusp: % rows renamed across slug columns + settings keys', total;
END $$;

-- 3. harness_registry JSONB (the projects[] array — slug + hive_slug). Precise substitution on
--    the JSON text: only quoted "papercup" / "papercup-..." literals; "papercusp"/"papercusp-..."
--    are left intact because they do not contain the 'papercup' substring.
UPDATE harness_shared.harness_registry
   SET payload = replace(replace(payload::text, '"papercup"', '"papercusp"'),
                         '"papercup-', '"papercusp-')::jsonb
 WHERE payload::text LIKE '%papercup%';

-- POST-CHECK (run after): expect ZERO rows.
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema='harness_shared' AND column_name ~ '(install|harness|hive|home)_slug';
--   ...then verify none still hold 'papercup%' (the surface sweep from the plan).
