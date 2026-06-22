/**
 * _work-items-schema.ts — the ONE canonical `harness_features_consolidated` DDL
 * for integration-test fixtures. NOT a test file (no `.integration.test.ts`
 * suffix), so the glob never collects it — it is imported by the engine's
 * real-Postgres integration tests.
 *
 * WHY THIS EXISTS (fixture-completeness debt, D-014 @ autoloop-pot-operator-rebuild):
 * ~36 integration tests used to hand-roll their own `CREATE TABLE
 * harness_features_consolidated (...)` DDL, each including only the column SUBSET
 * it happened to touch. The real prod table (000-baseline + incrementals) has the
 * full set. So any time the engine's shared `FEATURE_COLS` select/returning list in
 * work-items.ts widened by one column (e.g. surfacing `feature_order` as the
 * WorkItem `priority`), every test whose hand-rolled DDL omitted that column broke
 * with `column "X" does not exist` — turning a one-line engine change into a
 * 25-file fixture chase (memory: feature-cols-widen-breaks-fixtures).
 *
 * THE FIX: one complete, prod-faithful column superset, imported everywhere. It is
 * the full current `harness_features_consolidated` column set (live :5432 columns +
 * `swarm_affinity` from migration 191, which the dev box's native PG hadn't applied
 * yet) with test-friendly DEFAULTs that let the engine's column-omitting INSERTs
 * succeed without the prod BEFORE-INSERT fill triggers (which the bare test schema
 * lacks). Adding a column to `FEATURE_COLS` from now on means adding it HERE, once.
 *
 * Keep it a SUPERSET of prod: a test can never reference a column it doesn't have.
 * Check constraints are intentionally omitted — this fixes column completeness, not
 * constraint enforcement, and the prod triggers/constraints aren't what the engine
 * reads exercise. If you genuinely need a constraint or trigger, add it in the
 * specific test, not here.
 */

/**
 * Complete `harness_features_consolidated` DDL — apply with `sql.unsafe(...)` (it is
 * `CREATE TABLE IF NOT EXISTS`, so it composes into a multi-table bootstrap block).
 *
 * Test-friendly DEFAULTs that differ from prod and why:
 *   • workspace_id DEFAULT 'default' — prod fills it via the BEFORE-INSERT
 *     `fill_ws_features` trigger (absent in the bare test schema); the engine's
 *     createWorkItem INSERT omits the column on purpose.
 *   • status DEFAULT 'todo', attempts DEFAULT 0, item_kind DEFAULT 'feature' —
 *     convenience for hand-written test inserts that omit them.
 */
export const HARNESS_FEATURES_CONSOLIDATED_DDL = `
  CREATE SEQUENCE IF NOT EXISTS harness_shared.work_item_seq;
  CREATE OR REPLACE FUNCTION harness_shared.next_work_item_id() RETURNS text LANGUAGE sql VOLATILE AS $wiid$ SELECT 'WI-' || nextval('harness_shared.work_item_seq')::text $wiid$;
  CREATE TABLE IF NOT EXISTS harness_shared.work_items (
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    summary text,
    status text DEFAULT 'todo',
    attempts bigint DEFAULT 0,
    claims text,
    notes text,
    metadata jsonb,
    kind text,
    project_id text,
    expected_cost_cents bigint,
    tags jsonb,
    needs_human_review boolean NOT NULL DEFAULT false,
    ts bigint,
    created_ts bigint,
    updated_ts bigint,
    parent_id text,
    goal_id text,
    taken_by text,
    taken_at timestamptz,
    last_progress_at timestamptz,
    expires_at timestamptz,
    workspace_id text NOT NULL DEFAULT 'default',
    deprecation_reason text,
    see_also text[] NOT NULL DEFAULT '{}'::text[],
    needs_design boolean NOT NULL DEFAULT false,
    design_status text,
    design_spec_id text,
    discarded_design_work boolean NOT NULL DEFAULT false,
    completion_ref jsonb,
    created_by_github_user_id bigint,
    working_users bigint[] NOT NULL DEFAULT '{}'::bigint[],
    worked_by_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    wave text,
    verified_done_at_remote_ts timestamptz,
    verifier_last_error text,
    verifier_last_checked_at timestamptz,
    source_plan_slug text,
    source_plan_item_ids text[],
    feature_order integer,
    author_pubkey text,
    origin text NOT NULL DEFAULT 'local',
    audit_verdict text,
    audit_reasons text,
    audited_at timestamptz,
    verified_author_github_user_id bigint,
    item_kind text NOT NULL DEFAULT 'feature',
    payload jsonb,
    assignee_rank integer,
    rank_writer text,
    rank_updated_at timestamptz,
    swarm_affinity text,
    fed_ts bigint,
    fed_hlc text,
    redundancy integer,
    requeue_count integer NOT NULL DEFAULT 0,
    _search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(notes, '')), 'C')
    ) STORED,
    PRIMARY KEY (harness_slug, feature_id)
  );
  DROP VIEW IF EXISTS harness_shared.harness_features_consolidated;
  CREATE VIEW harness_shared.harness_features_consolidated AS
    SELECT * FROM harness_shared.work_items WHERE item_kind NOT IN ('bug', 'change', 'task');
  DROP TABLE IF EXISTS harness_shared.engineer_issues CASCADE;
  DROP VIEW IF EXISTS harness_shared.engineer_issues;
  CREATE VIEW harness_shared.engineer_issues AS
    SELECT
      workspace_id,
      feature_id AS issue_id,
      COALESCE(payload->'_ei'->>'scope', CASE WHEN harness_slug = '' THEN 'operator' ELSE 'harness:' || harness_slug END) AS scope,
      title,
      COALESCE(summary, '') AS body,
      COALESCE(payload->'_ei'->>'severity', 'minor') AS severity,
      COALESCE(payload->'_ei'->>'source', 'engineer') AS source,
      status AS state,
      taken_by AS assignee,
      payload->'_ei'->>'found_during' AS found_during,
      payload->'_ei'->>'linked_feature_id' AS linked_feature_id,
      payload->'_ei'->>'created_by' AS created_by,
      to_timestamp(created_ts / 1000.0) AS created_at,
      to_timestamp(updated_ts / 1000.0) AS updated_at,
      author_pubkey, origin, _search,
      item_kind AS kind,
      (payload - '_ei') AS payload,
      payload->'_ei'->>'assigned_by' AS assigned_by,
      taken_at AS assigned_at,
      assignee_rank, rank_writer, rank_updated_at, fed_ts,
      COALESCE(payload->'_ei'->>'signal_origin', 'local') AS signal_origin,
      fed_hlc
    FROM harness_shared.work_items WHERE item_kind IN ('bug', 'change', 'task');
  CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml() RETURNS trigger LANGUAGE plpgsql AS $ei_dml$
  DECLARE v_slug text; v_ei jsonb;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM harness_shared.work_items WHERE workspace_id = OLD.workspace_id AND feature_id = OLD.issue_id AND item_kind IN ('bug','change','task');
      RETURN OLD;
    END IF;
    v_slug := CASE WHEN COALESCE(NEW.scope,'operator') LIKE 'harness:%' THEN substr(NEW.scope,9) ELSE '' END;
    v_ei := jsonb_strip_nulls(jsonb_build_object('scope',NEW.scope,'severity',NEW.severity,'source',NEW.source,'found_during',NEW.found_during,'linked_feature_id',NEW.linked_feature_id,'created_by',NEW.created_by,'assigned_by',NEW.assigned_by,'signal_origin',NEW.signal_origin));
    IF TG_OP = 'INSERT' THEN
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, title, summary, status, taken_by, taken_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer, rank_updated_at, fed_ts, fed_hlc, ts, created_ts, updated_ts, payload)
      VALUES (COALESCE(NEW.workspace_id,'default'), v_slug, NEW.issue_id, NEW.title, COALESCE(NEW.body,''), COALESCE(NEW.state,'open'), NEW.assignee, NEW.assigned_at, COALESCE(NEW.kind,'bug'), COALESCE(NEW.origin,'local'), NEW.author_pubkey, NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at, NEW.fed_ts, NEW.fed_hlc, (extract(epoch FROM COALESCE(NEW.updated_at,now()))*1000)::bigint, (extract(epoch FROM COALESCE(NEW.created_at,now()))*1000)::bigint, (extract(epoch FROM COALESCE(NEW.updated_at,now()))*1000)::bigint, COALESCE(NEW.payload,'{}'::jsonb) || jsonb_build_object('_ei', v_ei));
      RETURN NEW;
    ELSE
      UPDATE harness_shared.work_items SET harness_slug=v_slug, title=NEW.title, summary=COALESCE(NEW.body,''), status=NEW.state, taken_by=NEW.assignee, taken_at=NEW.assigned_at, item_kind=COALESCE(NEW.kind,'bug'), origin=COALESCE(NEW.origin,'local'), author_pubkey=NEW.author_pubkey, assignee_rank=NEW.assignee_rank, rank_writer=NEW.rank_writer, rank_updated_at=NEW.rank_updated_at, fed_ts=NEW.fed_ts, fed_hlc=NEW.fed_hlc, updated_ts=(extract(epoch FROM COALESCE(NEW.updated_at,now()))*1000)::bigint, payload=(COALESCE(NEW.payload,'{}'::jsonb) - '_ei') || jsonb_build_object('_ei', v_ei) WHERE workspace_id=OLD.workspace_id AND feature_id=OLD.issue_id AND item_kind IN ('bug','change','task');
      RETURN NEW;
    END IF;
  END;
  $ei_dml$;
  DROP TRIGGER IF EXISTS engineer_issues_view_dml_trg ON harness_shared.engineer_issues;
  CREATE TRIGGER engineer_issues_view_dml_trg INSTEAD OF INSERT OR UPDATE OR DELETE ON harness_shared.engineer_issues FOR EACH ROW EXECUTE FUNCTION harness_shared.engineer_issues_view_dml();`;

/**
 * `user_trust_list` DDL — the owner's trusted github user ids (migration 276,
 * shared-hive-trust-admission). The work-items claim path's `autoPickableWhereSql`
 * (work-items-admission.ts, P-010) LEFT-JOINs this table to let un-screened remote
 * work whose VERIFIED author is trusted pass the admission gate. The engine reads it
 * on EVERY claim / claim_next / observe, so any claim-path integration test needs it
 * present — same D-014 read-path-completeness rationale as the consolidated table
 * above: add the engine's read dependencies HERE once, apply in the bootstrap block.
 *
 * Test-friendly DEFAULT on created_ts (prod requires it explicitly); RLS + GRANTs
 * from the migration are intentionally omitted — the test connects as the DB owner
 * (RLS bypassed) and provisions no app roles, matching this fixture's superset-only,
 * no-enforcement stance. Empty by default → the trust leg matches nothing, so the
 * gate behaves exactly as it does for an owner with no trusted authors.
 */
export const USER_TRUST_LIST_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.user_trust_list (
    workspace_id            text NOT NULL,
    trusted_github_user_id  bigint NOT NULL,
    note                    text,
    created_ts              bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, trusted_github_user_id)
  )`;

/**
 * Minimal `work_item_deps` table (migration 367) for the claim path. claimNextWorkItem's
 * readiness AND-clause (work-item-deps-and-readiness-2026-06-22 P-005, the F1 fix)
 * UNCONDITIONALLY references harness_shared.work_item_deps, so EVERY integration test that
 * exercises the claim path must have this table — apply it in the test bootstrap alongside
 * HARNESS_FEATURES_CONSOLIDATED_DDL. Just the columns + the edge-uniqueness the inserts use;
 * the change-notify trigger/extra indexes (migration 367) are not what the readiness read needs.
 */
export const WORK_ITEM_DEPS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_deps (
    id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    workspace_id  text        NOT NULL DEFAULT 'default',
    blocked_kind  text        NOT NULL,
    blocked_ref   text        NOT NULL,
    blocker_kind  text        NOT NULL,
    blocker_ref   text        NOT NULL,
    dep_type      text        NOT NULL DEFAULT 'blocks',
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT work_item_deps_no_self
      CHECK (NOT (blocked_kind = blocker_kind AND blocked_ref = blocker_ref))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS work_item_deps_edge_uniq
    ON harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type);`;

/**
 * Minimal `engineer_issues` table for the claim path's readiness clause (P-005): its
 * issue-blocker EXISTS subquery reads harness_shared.engineer_issues(workspace_id, issue_id,
 * state). `CREATE TABLE IF NOT EXISTS`, so it composes harmlessly into a test that ALSO applies
 * the full migration 131 (the migration wins; this is a no-op there). Apply it only in claim-path
 * tests that DON'T already create engineer_issues, so the issue-blocker subquery has a table to read.
 */
export const ENGINEER_ISSUES_MIN_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id     text NOT NULL,
    title        text NOT NULL DEFAULT '',
    state        text NOT NULL DEFAULT 'open',
    PRIMARY KEY (workspace_id, issue_id)
  )`;
