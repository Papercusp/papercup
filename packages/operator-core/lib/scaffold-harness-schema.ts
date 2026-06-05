/**
 * Inline TypeScript replacement for bin/scaffold-harness-schema.sh.
 *
 * Creates the per-harness `harness_<slug>` schema containing ONLY auto-updatable
 * views over the slug-keyed harness_shared.*_consolidated tables — no physical
 * per-harness tables (harness-state-storage-unification-2026-06-01, D-007).
 * Views: harness_features, harness_issues, agent_runs, harness_snapshots
 * (migration 032), agent_chats (116), feature_audit (118), supervisor_notes +
 * directive_summaries (119), messages + executed_actions (120). Retired:
 * config_token (token_index is authoritative), harness_proposals
 * (harness_proposals_shared is authoritative).
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

  // Per-harness schema only — every per-harness relation is now an auto-updatable
  // VIEW over a slug-keyed harness_shared.*_consolidated table (created below);
  // there are NO physical per-harness tables. Retired: config_token (token_index
  // is the authoritative token store), harness_proposals (harness_proposals_shared
  // is authoritative, fs-watcher-fed), feature_audit (writes go to consolidated),
  // and agent_chats / messages / executed_actions / supervisor_notes /
  // directive_summaries (migrations 116/118/119/120).
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS ${schema};

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

    CREATE OR REPLACE VIEW ${schema}.agent_chats AS
      SELECT * FROM harness_shared.agent_chats_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    -- Column defaults so writers that omit these on INSERT pass through
    -- (matches migration 116). harness_slug satisfies WITH CHECK OPTION.
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN workspace_id SET DEFAULT 'default';
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN updated_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN transcript SET DEFAULT '[]'::jsonb;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN total_input_tokens SET DEFAULT 0;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN total_output_tokens SET DEFAULT 0;
    ALTER VIEW ${schema}.agent_chats ALTER COLUMN total_cost_usd_cents SET DEFAULT 0;

    CREATE OR REPLACE VIEW ${schema}.supervisor_notes AS
      SELECT * FROM harness_shared.supervisor_notes_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN workspace_id SET DEFAULT 'default';
    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';
    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;
    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN body SET DEFAULT '';
    ALTER VIEW ${schema}.supervisor_notes ALTER COLUMN source SET DEFAULT '';

    CREATE OR REPLACE VIEW ${schema}.directive_summaries AS
      SELECT * FROM harness_shared.directive_summaries_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN workspace_id SET DEFAULT 'default';
    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';
    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN source SET DEFAULT 'ceo';
    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN summary SET DEFAULT '';
    ALTER VIEW ${schema}.directive_summaries ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint;

    CREATE OR REPLACE VIEW ${schema}.messages AS
      SELECT * FROM harness_shared.messages_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    ALTER VIEW ${schema}.messages ALTER COLUMN workspace_id SET DEFAULT 'default';
    ALTER VIEW ${schema}.messages ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';

    CREATE OR REPLACE VIEW ${schema}.executed_actions AS
      SELECT * FROM harness_shared.executed_actions_consolidated
      WHERE harness_slug = '${slug.replace(/'/g, "''")}'
      WITH CHECK OPTION;

    ALTER VIEW ${schema}.executed_actions ALTER COLUMN workspace_id SET DEFAULT 'default';
    ALTER VIEW ${schema}.executed_actions ALTER COLUMN harness_slug SET DEFAULT '${slug.replace(/'/g, "''")}';

    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ${schema}.harness_features,
      ${schema}.harness_issues,
      ${schema}.agent_runs,
      ${schema}.harness_snapshots,
      ${schema}.agent_chats,
      ${schema}.supervisor_notes,
      ${schema}.directive_summaries,
      ${schema}.messages,
      ${schema}.executed_actions
      TO harness_app, harness_admin;
  `);
  try {
    await sql.unsafe(`
      GRANT SELECT ON
        ${schema}.harness_features,
        ${schema}.harness_issues,
        ${schema}.agent_runs,
        ${schema}.harness_snapshots,
        ${schema}.agent_chats,
        ${schema}.supervisor_notes,
        ${schema}.directive_summaries,
        ${schema}.messages,
        ${schema}.executed_actions
        TO harness_zero;
    `);
  } catch { /* harness_zero absent — skip grants */ }
}
