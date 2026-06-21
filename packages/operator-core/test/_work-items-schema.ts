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
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
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
    redundancy integer,
    requeue_count integer NOT NULL DEFAULT 0,
    _search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(notes, '')), 'C')
    ) STORED,
    PRIMARY KEY (harness_slug, feature_id)
  )`;

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
