-- ============================================================================
-- DRAFT — papercup → papercusp DIVERGENT-COPY RECONCILIATION (Option B, owner-directed).
-- NOT in libs/papercusp/libs/db/sql/ ⇒ does NOT auto-apply. DRAFT for review + dry-run.
--
-- WHY a reconciliation, not a rename: 'papercusp' already holds a near-complete DIVERGENT
-- COPY of 'papercup' (the failed 2026-06-19 migration): features 106/104, plans 504/506,
-- plan_parts 23.3k/23.4k, work_items 259/119, + dark routine dups. A blind UPDATE would
-- violate ~88 unique constraints. This merges the two into ONE 'papercusp':
--   * per unique key, KEEP the winner (row_number rank 1) and DROP the losers;
--   * WINNER ORDER = newest recency first (updated_at/created_at/ts/last_fired_at/
--     routed_at/graded_at), then papercup*-preferred on a tie/when no recency col
--     (papercup is the LIVE authoritative spine), then ctid for stability;
--   * papercusp-UNIQUE rows (recent su-aede8 work) have no peer ⇒ survive untouched;
--   * then rename surviving papercup* → papercusp everywhere.
--
-- ⚠ EXECUTION PROTOCOL — DO NOT shortcut:
--   1. deploy GREEN (the cutover code lands with it; a half-state split-brains);
--   2. su-aede8 PAUSED (I ping ~5 min before) — this holds row locks on shared rows;
--   3. owner CONFIRMS the recency-wins reconciliation (data-loss on divergent-overlap rows);
--   4. DRY-RUN ON A SNAPSHOT, NOT THE LIVE DB — a live BEGIN…ROLLBACK still locks every
--      papercup*/papercusp row for the txn duration and blocks su-aede8. Restore a snapshot
--      (backup:snapshot_create / a scratch DB), run with _apply:=false there, eyeball the
--      NOTICE counts, THEN run with _apply:=true in the coordinated window;
--   5. BACKUP first; this DELETEs rows.
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  _apply boolean := false;  -- ← flip to true ONLY for the real apply (in the window, post dry-run)
  _recency text[] := ARRAY['updated_at','created_at','ts','last_fired_at','routed_at','graded_at'];
  r record; slug_col text; part_cols text; order_clause text; rec_col text;
  n bigint; del_total bigint := 0; ren_total bigint := 0;
BEGIN
  -- 1) Recency-dedup + rename across every slug-keyed UNIQUE/PK table.
  FOR r IN
    SELECT tc.table_name, array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'harness_shared' AND tc.constraint_type IN ('UNIQUE','PRIMARY KEY')
    GROUP BY tc.table_name, tc.constraint_name
    HAVING bool_or(kcu.column_name ~ '(install|harness|hive|home)_slug')
  LOOP
    SELECT c INTO slug_col FROM unnest(r.cols) c WHERE c ~ '(install|harness|hive|home)_slug' LIMIT 1;
    SELECT string_agg(quote_ident(c), ', ') INTO part_cols
      FROM unnest(r.cols) c WHERE c !~ '(install|harness|hive|home)_slug';
    IF part_cols IS NULL THEN part_cols := '1'; END IF;  -- slug-only key ⇒ one partition

    rec_col := (
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'harness_shared' AND table_name = r.table_name
        AND column_name = ANY(_recency)
      ORDER BY array_position(_recency, column_name) LIMIT 1
    );
    -- WINNER RULE (owner-confirmed 2026-06-20): papercup is the live-READ authoritative copy
    -- (operatorHomeHarnessSlug→papercup), so papercup* beats the papercusp 06-19 SHADOW on a
    -- collision — papercusp's newer updated_at is a copy-stamp, NOT real activity. papercusp-UNIQUE
    -- rows (no papercup* peer) are alone in their partition ⇒ rn=1 ⇒ SURVIVE (su-aede8's work).
    -- EXCEPTION: hive_placements — keep the most-RECENT placement per key, so su-aede8's recent
    -- papercusp re-placements beat the RETIRED papercup-hive ones.
    IF r.table_name = 'hive_placements' AND rec_col IS NOT NULL THEN
      order_clause := format('%I DESC NULLS LAST, ctid', rec_col);  -- recency: newest placement wins
    ELSE
      order_clause := format('array_position(ARRAY[%L,%L,%L,%L]::text[], %I::text), ctid',
                             'papercup', 'papercup-org', 'papercup-hive', 'papercusp', slug_col);
    END IF;

    EXECUTE format(
      'DELETE FROM harness_shared.%1$I WHERE ctid IN ('
      || 'SELECT ctid FROM (SELECT ctid, row_number() OVER (PARTITION BY %2$s ORDER BY %3$s) AS rn '
      || 'FROM harness_shared.%1$I WHERE %4$I IN (%5$L,%6$L,%7$L,%8$L)) z WHERE z.rn > 1)',
      r.table_name, part_cols, order_clause, slug_col,
      'papercup', 'papercup-hive', 'papercup-org', 'papercusp');
    GET DIAGNOSTICS n = ROW_COUNT; del_total := del_total + n;
    IF n > 0 THEN RAISE NOTICE 'dedup %  (slug=%, recency=%): dropped % loser(s)',
      r.table_name, slug_col, COALESCE(rec_col,'<none→papercup-wins>'), n; END IF;

    EXECUTE format('UPDATE harness_shared.%1$I SET %2$I = %3$L WHERE %2$I IN (%4$L,%5$L,%6$L)',
      r.table_name, slug_col, 'papercusp', 'papercup', 'papercup-hive', 'papercup-org');
    GET DIAGNOSTICS n = ROW_COUNT; ren_total := ren_total + n;
  END LOOP;

  -- 2) slug columns NOT in any unique constraint (append-only logs): plain rename, no dedup.
  FOR r IN
    SELECT c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'harness_shared' AND c.column_name ~ '(install|harness|hive|home)_slug'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage kcu
        JOIN information_schema.table_constraints tc
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'harness_shared' AND tc.constraint_type IN ('UNIQUE','PRIMARY KEY')
          AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name)
  LOOP
    EXECUTE format('UPDATE harness_shared.%1$I SET %2$I = %3$L WHERE %2$I IN (%4$L,%5$L,%6$L)',
      r.table_name, r.column_name, 'papercusp', 'papercup', 'papercup-hive', 'papercup-org');
    GET DIAGNOSTICS n = ROW_COUNT; ren_total := ren_total + n;
  END LOOP;

  -- 3) operator_settings KEYS (hive_started/overwatch :*:papercup*). 'papercusp-workspace'
  --    has no 'papercup' substring (cuSp ≠ cuP), so this is precise.
  DELETE FROM harness_shared.operator_settings a
   WHERE a.key LIKE '%papercup%'
     AND EXISTS (SELECT 1 FROM harness_shared.operator_settings b
                  WHERE b.key = replace(a.key, 'papercup', 'papercusp') AND b.key <> a.key);
  UPDATE harness_shared.operator_settings SET key = replace(key, 'papercup', 'papercusp')
   WHERE key LIKE '%papercup%';

  RAISE NOTICE 'RECONCILE TOTAL: dropped % losers, renamed % rows → papercusp', del_total, ren_total;

  IF NOT _apply THEN
    RAISE EXCEPTION 'DRY-RUN (set _apply:=true to apply) — rolling back';
  END IF;
END $$;

-- 4) harness_registry merge (run ONLY on _apply): point the papercusp hive at the repo path
--    and drop the legacy papercup entry. (Boot also converges via ensure-papercusp-hive
--    existingPath, but this fixes the EXISTING row in lock-step with the data.)
UPDATE harness_shared.harness_registry r
   SET payload = jsonb_set(
     r.payload,
     '{projects}',
     (SELECT jsonb_agg(
        CASE WHEN p->>'slug' = 'papercusp'
             THEN jsonb_set(p, '{path}', to_jsonb(COALESCE(
                    (SELECT p2->>'path' FROM jsonb_array_elements(r.payload->'projects') p2 WHERE p2->>'slug'='papercup'),
                    p->>'path')))
             ELSE p END)
      FROM jsonb_array_elements(r.payload->'projects') p
      WHERE p->>'slug' <> 'papercup'))
 WHERE r.workspace_id = 'papercusp-workspace'
   AND r.payload::text LIKE '%"papercup"%';

COMMIT;

-- 5) FOLLOW-UP (separate, post-merge): the folded papercusp-hive cursed placements now live
--    under 'papercusp'. Resolve them terminal so they stop poisoning the active frontier, and
--    scope the cursed anti-join (survey.ts) by install_slug so a retired install never poisons
--    the home hive again. (Handled in code + a targeted UPDATE, not here.)
