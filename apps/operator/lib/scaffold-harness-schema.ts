/**
 * Inline TypeScript replacement for bin/scaffold-harness-schema.sh.
 *
 * Creates the per-harness `harness_<slug>` schema with the 8 remaining
 * physical tables (config_token, agent_chats, harness_proposals, messages,
 * supervisor_notes, directive_summaries, executed_actions, feature_audit)
 * plus the 4 auto-updatable views over the consolidated tables (Migration
 * 032: harness_features, harness_issues, agent_runs, harness_snapshots).
 *
 * Idempotent. Called from add-project flow and onboard-action flow so a
 * new harness install needs no out-of-process bash.
 */
import { getOrgPg } from '@papercusp/db-org';

function slugToSchema(slug: string): string {
  // Lowercase + hyphens to underscores. Matches harnessSchemaName in
  // libs/papercusp/libs/db/src/shared-schema.ts.
  return 'harness_' + slug.toLowerCase().replace(/-/g, '_');
}

export async function scaffoldHarnessSchema(slug: string): Promise<void> {
  const schema = slugToSchema(slug);
  const { sql } = getOrgPg();

  // Schema + per-harness physical tables (config_token, plus 7 others).
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS ${schema};

    CREATE TABLE IF NOT EXISTS ${schema}.config_token (
      token TEXT PRIMARY KEY
    );

    -- feature_audit dropped from per-schema templates as of un-hardcode
    -- plan item #6: writes go directly to harness_shared.feature_audit_consolidated.
    -- Existing per-harness feature_audit tables are kept untouched as
    -- a best-effort mirror during transition; the cleanup migration
    -- that drops them lands separately.

    CREATE TABLE IF NOT EXISTS ${schema}.agent_chats (
      id BIGSERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      feature_id TEXT,
      harness_slug TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      archived_at BIGINT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS ${schema}.harness_proposals (
      proposal_id TEXT PRIMARY KEY,
      harness_slug TEXT NOT NULL,
      ts BIGINT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      mtime_ms BIGINT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ${schema}.messages (
      message_id TEXT PRIMARY KEY,
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      to_role TEXT,
      kind TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      ref_id TEXT,
      created_at BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS ${schema}.supervisor_notes (
      id BIGSERIAL PRIMARY KEY,
      harness_slug TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ${schema}.directive_summaries (
      id BIGSERIAL PRIMARY KEY,
      directive_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ${schema}.executed_actions (
      id BIGSERIAL PRIMARY KEY,
      caller_slug TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      op TEXT NOT NULL,
      executed_at BIGINT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    GRANT USAGE ON SCHEMA ${schema} TO harness_app, harness_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO harness_app, harness_admin;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO harness_app, harness_admin;
  `);
  // harness_zero powers Zero WS for the web deploy path. Keep grants.
  // Wrapped in try/catch so harness scaffolding still works in environments
  // where Zero is intentionally absent (e.g. test rigs).
  try {
    await sql.unsafe(`
      GRANT USAGE ON SCHEMA ${schema} TO harness_zero;
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO harness_zero;
    `);
  } catch { /* harness_zero absent — skip grants */ }

  // Auto-updatable views (Migration 032 pattern). Filtered on harness_slug
  // WITH CHECK OPTION so writers that include harness_slug pass through
  // and ones that don't are caught at INSERT time.
  await sql.unsafe(`
    CREATE OR REPLACE VIEW ${schema}.harness_features AS
      SELECT * FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    CREATE OR REPLACE VIEW ${schema}.harness_issues AS
      SELECT * FROM harness_shared.harness_issues_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    CREATE OR REPLACE VIEW ${schema}.agent_runs AS
      SELECT * FROM harness_shared.agent_runs_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    CREATE OR REPLACE VIEW ${schema}.harness_snapshots AS
      SELECT * FROM harness_shared.harness_snapshots_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ${schema}.harness_features,
      ${schema}.harness_issues,
      ${schema}.agent_runs,
      ${schema}.harness_snapshots
      TO harness_app, harness_admin;
  `);
  try {
    await sql.unsafe(`
      GRANT SELECT ON
        ${schema}.harness_features,
        ${schema}.harness_issues,
        ${schema}.agent_runs,
        ${schema}.harness_snapshots
        TO harness_zero;
    `);
  } catch { /* harness_zero absent — skip grants */ }
}
