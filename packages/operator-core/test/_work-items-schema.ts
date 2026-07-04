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
    terminal_owner text,
    terminal_completion_ref text,
    last_released_by text,
    last_released_at timestamptz,
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
  DO $eidrop$ BEGIN
    -- Drop engineer_issues whether it is a leftover TABLE (mig 131) or a prior VIEW
    -- (idempotent re-application): DROP TABLE IF EXISTS errors on a view and vice-versa,
    -- so branch on relkind.
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'harness_shared' AND c.relname = 'engineer_issues') THEN
      EXECUTE (SELECT CASE WHEN c.relkind = 'v' THEN 'DROP VIEW' ELSE 'DROP TABLE' END
               || ' harness_shared.engineer_issues CASCADE'
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'harness_shared' AND c.relname = 'engineer_issues');
    END IF;
  END $eidrop$;
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
      fed_hlc,
      terminal_owner,
      terminal_completion_ref
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
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, title, summary, status, taken_by, taken_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer, rank_updated_at, fed_ts, fed_hlc, ts, created_ts, updated_ts, payload, terminal_owner, terminal_completion_ref)
      VALUES (COALESCE(NEW.workspace_id,'default'), v_slug, NEW.issue_id, NEW.title, COALESCE(NEW.body,''), COALESCE(NEW.state,'open'), NEW.assignee, NEW.assigned_at, COALESCE(NEW.kind,'bug'), COALESCE(NEW.origin,'local'), NEW.author_pubkey, NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at, NEW.fed_ts, NEW.fed_hlc, (extract(epoch FROM COALESCE(NEW.updated_at,now()))*1000)::bigint, (extract(epoch FROM COALESCE(NEW.created_at,now()))*1000)::bigint, (extract(epoch FROM COALESCE(NEW.updated_at,now()))*1000)::bigint, COALESCE(NEW.payload,'{}'::jsonb) || jsonb_build_object('_ei', v_ei), NEW.terminal_owner, NEW.terminal_completion_ref);
      RETURN NEW;
    ELSE
      UPDATE harness_shared.work_items SET harness_slug=v_slug, title=NEW.title, summary=COALESCE(NEW.body,''), status=NEW.state, taken_by=NEW.assignee, taken_at=NEW.assigned_at, item_kind=COALESCE(NEW.kind,'bug'), origin=COALESCE(NEW.origin,'local'), author_pubkey=NEW.author_pubkey, assignee_rank=NEW.assignee_rank, rank_writer=NEW.rank_writer, rank_updated_at=NEW.rank_updated_at, fed_ts=NEW.fed_ts, fed_hlc=NEW.fed_hlc, updated_ts=(extract(epoch FROM COALESCE(NEW.updated_at,now()))*1000)::bigint, payload=(COALESCE(NEW.payload,'{}'::jsonb) - '_ei') || jsonb_build_object('_ei', v_ei), terminal_owner=NEW.terminal_owner, terminal_completion_ref=NEW.terminal_completion_ref WHERE workspace_id=OLD.workspace_id AND feature_id=OLD.issue_id AND item_kind IN ('bug','change','task');
      RETURN NEW;
    END IF;
  END;
  $ei_dml$;
  DROP TRIGGER IF EXISTS engineer_issues_view_dml_trg ON harness_shared.engineer_issues;
  CREATE TRIGGER engineer_issues_view_dml_trg INSTEAD OF INSERT OR UPDATE OR DELETE ON harness_shared.engineer_issues FOR EACH ROW EXECUTE FUNCTION harness_shared.engineer_issues_view_dml();

  -- Minimal datatype_registry (migration 421). The work-item VISIBILITY clause
  -- (featureFamilyKindClause: listWorkItems/count/search) AND the PLACEMENT clause
  -- (frontierPlacementKindClause: claim floors / survey / wake-frontier) reference this table
  -- via a subquery, so EVERY work-items integration test must have it present — same D-014
  -- read-path-completeness rationale as work_item_deps / user_trust_list above. Just the 5
  -- columns those subqueries read; the full 421 (VECTOR(384) embedding + generated title_tsv)
  -- is not needed and would require the pgvector extension. Empty by default ⇒ the subquery
  -- matches nothing, so the clauses behave exactly as the built-in-kinds-only form did before.
  CREATE TABLE IF NOT EXISTS harness_shared.datatype_registry (
    id              text NOT NULL,
    workspace_id    text NOT NULL,
    work_item_kind  text,
    tier            text NOT NULL DEFAULT 'generic-kind',
    status          text NOT NULL DEFAULT 'active',
    review_status   text NOT NULL DEFAULT 'none',
    tags            text[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (workspace_id, id)
  );
  -- WI-2118 reserved-plan-lane floor (reservedPlanLaneExclusionSql): the issue-claim path AND
  -- diagnoseClaimNextMiss reference these two tables to exclude items reserved by another active
  -- plan lane. Minimal columns the floor reads; empty by default ⇒ the EXISTS subqueries match
  -- nothing, so a test that seeds neither is byte-identical to the pre-floor behavior (mirrors the
  -- datatype_registry precedent above). A test that DOES apply the full migration 122/141 tables
  -- keeps them (CREATE TABLE IF NOT EXISTS is a no-op when the richer table already exists).
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    plan_slug text PRIMARY KEY,
    status text
  );
  CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
    plan_slug text NOT NULL,
    item_id text NOT NULL,
    owner text NOT NULL,
    expires_ts timestamptz NOT NULL,
    PRIMARY KEY (plan_slug, item_id)
  );`;

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
    ON harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type);

  -- work-item-deps-and-readiness P-005 (migration 379): the maintained-readiness blocked-set sidecar
  -- + oracle fn + one-hop triggers. Folded in HERE (not per-test) so that with SCHEDULER_MAINTAINED_READY
  -- ON the claim's indexed anti-join (NOT EXISTS work_item_blocked) finds a MAINTAINED table in EVERY
  -- claim integration test (applied alongside + AFTER HARNESS_FEATURES_CONSOLIDATED_DDL, which creates
  -- work_items). Mirrors the frozen migration 379 — keep in sync if 379 ever changes.
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_blocked (
      workspace_id text        NOT NULL DEFAULT 'default',
      harness_slug text        NOT NULL,
      feature_id   text        NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
  );
  CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(p_harness text, p_feature text)
      RETURNS boolean LANGUAGE sql STABLE AS $WIB$
      SELECT EXISTS (
          SELECT 1 FROM harness_shared.work_item_deps d
           WHERE d.workspace_id = 'default' AND d.dep_type = 'blocks'
             AND d.blocked_ref = p_harness || '#' || p_feature
             AND ( EXISTS (SELECT 1 FROM harness_shared.work_items bf
                            WHERE bf.item_kind <> ALL (ARRAY['bug','change','task'])
                              AND (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                              AND bf.status NOT IN ('passed','deprecated'))
                   OR EXISTS (SELECT 1 FROM harness_shared.work_items bi
                            WHERE bi.item_kind = ANY (ARRAY['bug','change','task'])
                              AND bi.workspace_id = 'default' AND bi.feature_id = d.blocker_ref
                              AND bi.status NOT IN ('resolved','closed')) )
      );
  $WIB$;
  CREATE OR REPLACE FUNCTION harness_shared.sync_work_item_blocked(p_ws text, p_harness text, p_feature text)
      RETURNS void LANGUAGE plpgsql AS $SWB$
  BEGIN
      IF harness_shared.work_item_is_blocked(p_harness, p_feature) THEN
          INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id, updated_at)
          VALUES (p_ws, p_harness, p_feature, now())
          ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE SET updated_at = now();
      ELSE
          DELETE FROM harness_shared.work_item_blocked
           WHERE workspace_id = p_ws AND harness_slug = p_harness AND feature_id = p_feature;
      END IF;
  END;
  $SWB$;
  CREATE OR REPLACE FUNCTION harness_shared.wir_deps_sync() RETURNS trigger LANGUAGE plpgsql AS $WDS$
  DECLARE v_ref text := COALESCE(NEW.blocked_ref, OLD.blocked_ref); r record;
  BEGIN
      IF COALESCE(NEW.dep_type, OLD.dep_type) <> 'blocks' THEN RETURN COALESCE(NEW, OLD); END IF;
      FOR r IN SELECT f.workspace_id, f.harness_slug, f.feature_id FROM harness_shared.work_items f
                WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
                  AND (f.harness_slug || '#' || f.feature_id) = v_ref
      LOOP PERFORM harness_shared.sync_work_item_blocked(r.workspace_id, r.harness_slug, r.feature_id); END LOOP;
      RETURN COALESCE(NEW, OLD);
  EXCEPTION WHEN OTHERS THEN RETURN COALESCE(NEW, OLD); END;
  $WDS$;
  DROP TRIGGER IF EXISTS wir_deps_sync_trg ON harness_shared.work_item_deps;
  CREATE TRIGGER wir_deps_sync_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.work_item_deps
      FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_deps_sync();
  CREATE OR REPLACE FUNCTION harness_shared.wir_status_sync_dependents() RETURNS trigger LANGUAGE plpgsql AS $WSS$
  DECLARE r record;
  BEGIN
      FOR r IN SELECT f.workspace_id, f.harness_slug, f.feature_id
                 FROM harness_shared.work_item_deps d
                 JOIN harness_shared.work_items f
                   ON f.item_kind <> ALL (ARRAY['bug','change','task'])
                  AND (f.harness_slug || '#' || f.feature_id) = d.blocked_ref
                WHERE d.workspace_id = 'default' AND d.dep_type = 'blocks'
                  AND ( d.blocker_ref = NEW.harness_slug || '#' || NEW.feature_id
                        OR (NEW.item_kind = ANY (ARRAY['bug','change','task']) AND d.blocker_ref = NEW.feature_id) )
      LOOP PERFORM harness_shared.sync_work_item_blocked(r.workspace_id, r.harness_slug, r.feature_id); END LOOP;
      RETURN NEW;
  EXCEPTION WHEN OTHERS THEN RETURN NEW; END;
  $WSS$;
  DROP TRIGGER IF EXISTS wir_status_sync_dependents_trg ON harness_shared.work_items;
  CREATE TRIGGER wir_status_sync_dependents_trg AFTER UPDATE OF status ON harness_shared.work_items
      FOR EACH ROW WHEN ((OLD.status IN ('passed','deprecated','resolved','closed'))
        IS DISTINCT FROM (NEW.status IN ('passed','deprecated','resolved','closed')))
      EXECUTE FUNCTION harness_shared.wir_status_sync_dependents();
  CREATE OR REPLACE FUNCTION harness_shared.wir_insert_sync_own() RETURNS trigger LANGUAGE plpgsql AS $WIS$
  BEGIN
      IF NEW.item_kind <> ALL (ARRAY['bug','change','task']) THEN
          PERFORM harness_shared.sync_work_item_blocked(NEW.workspace_id, NEW.harness_slug, NEW.feature_id);
      END IF;
      RETURN NEW;
  EXCEPTION WHEN OTHERS THEN RETURN NEW; END;
  $WIS$;
  DROP TRIGGER IF EXISTS wir_insert_sync_own_trg ON harness_shared.work_items;
  CREATE TRIGGER wir_insert_sync_own_trg AFTER INSERT ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_insert_sync_own();
  CREATE OR REPLACE FUNCTION harness_shared.wir_delete_cleanup() RETURNS trigger LANGUAGE plpgsql AS $WDC$
  BEGIN
      DELETE FROM harness_shared.work_item_blocked
       WHERE workspace_id = OLD.workspace_id AND harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
      RETURN OLD;
  EXCEPTION WHEN OTHERS THEN RETURN OLD; END;
  $WDC$;
  DROP TRIGGER IF EXISTS wir_delete_cleanup_trg ON harness_shared.work_items;
  CREATE TRIGGER wir_delete_cleanup_trg AFTER DELETE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_delete_cleanup();`;

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

/**
 * `substrate_outbox` federation CDC outbox (archive/102) — the bare table + drain index,
 * WITHOUT archive/102's per-table capture trigger attachments. Those attach to
 * harness_features_consolidated / harness_issues_consolidated, which are now compat VIEWS
 * after the P-010 unification, so 102's `CREATE TRIGGER ... ON <view>` would fail. Federation
 * tests apply THIS for the outbox surface, then the real work_items capture via
 * readMigration('375-work-items-cdc-capture.sql'); the projection-apply tests (echo-guarded,
 * remote-origin writes) need only this empty table for their beforeEach reset.
 */
export const SUBSTRATE_OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.substrate_outbox (
    id           BIGSERIAL PRIMARY KEY,
    workspace_id TEXT   NOT NULL,
    harness_slug TEXT   NOT NULL,
    table_name   TEXT   NOT NULL,
    op           TEXT   NOT NULL CHECK (op IN ('put', 'del')),
    key          TEXT   NOT NULL,
    row          JSONB,
    ts           BIGINT NOT NULL,
    drained_at   BIGINT,
    drained_log_key TEXT
  );
  CREATE INDEX IF NOT EXISTS substrate_outbox_drain_idx
    ON harness_shared.substrate_outbox (workspace_id, harness_slug, drained_at, id);`;

/**
 * The migration-103 workspace_id fill (fill_workspace_id_from_projects) + a BEFORE INSERT
 * trigger on work_items. Pre-unification this trigger lived on harness_features_consolidated
 * (fill_ws_features_trg); that table is now a compat VIEW, so the fill must run on the
 * work_items BASE — an INSERT through the auto-updatable hfc view fires the base's triggers.
 * Federation send-side tests apply this so a feature written WITHOUT workspace_id gets it
 * stamped from harness_shared.projects (by slug), matching the drain's workspace_id filter.
 * REQUIRES harness_shared.projects to exist (the function reads it at trigger time).
 */
export const FILL_WORKSPACE_ID_DDL = `
  -- The fill trigger only stamps when workspace_id is '' / NULL. The helper's work_items
  -- uses DEFAULT 'default' (so engine tests that OMIT the column get a value without this
  -- trigger); but the prod fill path keys off the '' default, so reset it here — otherwise
  -- an omitting INSERT gets 'default' and the fill (→ workspace from projects) never runs,
  -- leaving the outbox row keyed on 'default' and the drain's workspace filter missing it.
  ALTER TABLE harness_shared.work_items ALTER COLUMN workspace_id SET DEFAULT '';
  CREATE OR REPLACE FUNCTION harness_shared.fill_workspace_id_from_projects()
  RETURNS TRIGGER AS $fwip$
  BEGIN
    IF NEW.workspace_id IS NULL OR NEW.workspace_id = '' THEN
      SELECT workspace_id INTO NEW.workspace_id
        FROM harness_shared.projects WHERE slug = NEW.harness_slug LIMIT 1;
      IF NEW.workspace_id IS NULL OR NEW.workspace_id = '' THEN
        NEW.workspace_id := 'default';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $fwip$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS fill_ws_work_items_trg ON harness_shared.work_items;
  CREATE TRIGGER fill_ws_work_items_trg
    BEFORE INSERT ON harness_shared.work_items
    FOR EACH ROW EXECUTE FUNCTION harness_shared.fill_workspace_id_from_projects();`;

/**
 * harness_issues_consolidated — the SEPARATE legacy issues-consolidated federated table
 * (distinct from engineer_issues; NOT part of the P-010 work_items unification). Some
 * federation round-trip tests federate it alongside features, so they need the table + the
 * generic substrate_outbox capture (archive/102) + the workspace_id fill on it. Apply AFTER
 * SUBSTRATE_OUTBOX_DDL + FILL_WORKSPACE_ID_DDL (which defines fill_workspace_id_from_projects)
 * + a harness_shared.projects row. The generic capture fn mirrors archive/102 verbatim.
 */
export const HARNESS_ISSUES_CONSOLIDATED_FED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (
    harness_slug      TEXT NOT NULL,
    issue_id          TEXT NOT NULL,
    workspace_id      TEXT NOT NULL DEFAULT '',
    title             TEXT NOT NULL,
    severity          TEXT NOT NULL,
    source            TEXT NOT NULL,
    status            TEXT NOT NULL,
    found_at          TIMESTAMPTZ NOT NULL,
    found_during      TEXT,
    repro             TEXT,
    evidence          TEXT,
    suggested_fix     TEXT,
    code_pointer      TEXT,
    linked_feature_id TEXT,
    attempts          INT NOT NULL DEFAULT 0,
    notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_ts        BIGINT NOT NULL,
    updated_ts        BIGINT NOT NULL,
    author_pubkey     TEXT,
    origin            TEXT NOT NULL DEFAULT 'local',
    fed_ts            BIGINT,
    fed_hlc           TEXT,
    PRIMARY KEY (harness_slug, issue_id)
  );
  CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $cso$
    DECLARE v_op TEXT; v_rec RECORD; v_origin TEXT; v_key TEXT; v_row JSONB; v_ws TEXT; v_slug TEXT; v_keycol TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD; ELSE v_op := 'put'; v_rec := NEW; END IF;
      v_row := to_jsonb(v_rec); v_origin := v_row ->> 'origin';
      IF COALESCE(v_origin, 'local') <> 'local' THEN RETURN v_rec; END IF;
      v_key := v_row ->> v_keycol; v_ws := COALESCE(v_row ->> 'workspace_id', ''); v_slug := v_row ->> 'harness_slug';
      INSERT INTO harness_shared.substrate_outbox (workspace_id, harness_slug, table_name, op, key, row, ts)
        VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row, (extract(epoch from now()) * 1000)::bigint);
      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);
      RETURN v_rec;
    END; $cso$;
  DROP TRIGGER IF EXISTS fill_ws_hic_trg ON harness_shared.harness_issues_consolidated;
  CREATE TRIGGER fill_ws_hic_trg BEFORE INSERT ON harness_shared.harness_issues_consolidated
    FOR EACH ROW EXECUTE FUNCTION harness_shared.fill_workspace_id_from_projects();
  DROP TRIGGER IF EXISTS capture_hic_insdel_trg ON harness_shared.harness_issues_consolidated;
  CREATE TRIGGER capture_hic_insdel_trg AFTER INSERT OR DELETE ON harness_shared.harness_issues_consolidated
    FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
  DROP TRIGGER IF EXISTS capture_hic_upd_trg ON harness_shared.harness_issues_consolidated;
  CREATE TRIGGER capture_hic_upd_trg AFTER UPDATE ON harness_shared.harness_issues_consolidated
    FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
    EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');`;
