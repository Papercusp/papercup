/**
 * Un-hardcode contract test (Phase 4).
 *
 * The architectural promise: a new harness installed via template needs
 * zero code changes. The slug becomes a row value, every Zero query +
 * dashboard panel picks it up via *Consolidated.bySlug, the per-harness
 * schema is auto-provisioned with views over the consolidated tables.
 *
 * This test enforces that promise. If a future change re-introduces a
 * compile-time slug list anywhere on the install path, it fails.
 *
 * Skipped when no PG is reachable (CI without a running database).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { scaffoldHarnessSchema } from './scaffold-harness-schema';

const TEST_SLUG = `contract-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_SCHEMA = `harness_${TEST_SLUG.replace(/-/g, '_')}`;

async function getSql() {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql;
}

async function pgReachable(): Promise<boolean> {
  try {
    const sql = await getSql();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('un-hardcode contract', () => {
  let skip = false;

  beforeAll(async () => {
    skip = !(await pgReachable());
  });

  afterAll(async () => {
    if (skip) return;
    const sql = await getSql();
    // Clean up: drop the schema and any consolidated rows for the test slug.
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } catch { /* best-effort */ }
    try {
      await sql`DELETE FROM harness_shared.harness_features_consolidated  WHERE harness_slug = ${TEST_SLUG}`;
      await sql`DELETE FROM harness_shared.harness_issues_consolidated    WHERE harness_slug = ${TEST_SLUG}`;
      await sql`DELETE FROM harness_shared.agent_runs_consolidated        WHERE harness_slug = ${TEST_SLUG}`;
      await sql`DELETE FROM harness_shared.harness_snapshots_consolidated WHERE harness_slug = ${TEST_SLUG}`;
      await sql`DELETE FROM harness_shared.harness_text_artifacts         WHERE harness_slug = ${TEST_SLUG}`;
      await sql`DELETE FROM harness_shared.harness_brainstorm             WHERE harness_slug = ${TEST_SLUG}`;
      await sql`DELETE FROM harness_shared.harness_project_files          WHERE harness_slug = ${TEST_SLUG}`;
    } catch { /* best-effort */ }
  });

  it('scaffolds a new harness schema with views over consolidated tables', async (ctx) => {
    // Properly skip (not console.warn — the global fail-on-console setup treats
    // a warn as a failure) when no test PG is reachable.
    if (skip) { ctx.skip(); return; }

    await scaffoldHarnessSchema(TEST_SLUG);

    const sql = await getSql();
    // All 8 physical tables + 4 views must exist in the new schema.
    const rows = await sql<{ table_name: string; table_type: string }[]>`
      SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = ${TEST_SCHEMA}
       ORDER BY table_name
    `;
    const names = rows.map((r) => r.table_name);
    const views = rows.filter((r) => r.table_type === 'VIEW').map((r) => r.table_name);

    // feature_audit dropped from per-schema templates per un-hardcode plan
    // item #6 (writes go directly to harness_shared.feature_audit_consolidated).
    // config_token + harness_proposals were retired from per-schema scaffolding
    // (migration 121 retire-per-harness-config-token-and-proposals), so they are
    // no longer among the scaffolded names.
    expect(names).toEqual(expect.arrayContaining([
      'agent_chats', 'directive_summaries', 'executed_actions',
      'messages', 'supervisor_notes',
    ]));
    expect(names).not.toContain('feature_audit');
    expect(views).toEqual(expect.arrayContaining([
      'agent_runs', 'harness_features', 'harness_issues', 'harness_snapshots',
    ]));
  });

  it('inserts via per-harness view → readable via consolidated table', async () => {
    if (skip) return;

    const sql = await getSql();
    const ts = Date.now();
    await sql.unsafe(`
      INSERT INTO ${TEST_SCHEMA}.harness_features
        (harness_slug, feature_id, title, status, ts, created_ts, updated_ts)
      VALUES ($1, 'F-CONTRACT-001', 'contract test feature', 'open', $2, $2, $2)
    `, [TEST_SLUG, ts]);

    const rows = await sql<{ feature_id: string; title: string; workspace_id: string }[]>`
      SELECT feature_id, title, workspace_id FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${TEST_SLUG}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].feature_id).toBe('F-CONTRACT-001');
    expect(rows[0].title).toBe('contract test feature');
    // workspace_id auto-fill trigger should set 'default' when no project row exists.
    expect(rows[0].workspace_id).toBeTruthy();
  });

  it('view filter rejects writes with mismatched harness_slug', async () => {
    if (skip) return;

    const sql = await getSql();
    // WITH CHECK OPTION on the view should reject this — the view's
    // WHERE clause filters to TEST_SLUG only.
    await expect(sql.unsafe(`
      INSERT INTO ${TEST_SCHEMA}.harness_features
        (harness_slug, feature_id, title, status, ts, created_ts, updated_ts)
      VALUES ('some-other-slug', 'F-WRONG', 't', 'open', 0, 0, 0)
    `)).rejects.toThrow();
  });

  it('text artifacts are slug-keyed and isolated', async () => {
    if (skip) return;

    const { saveTextArtifact, loadTextArtifact } = await import('./text-artifacts');
    await saveTextArtifact(TEST_SLUG, 'memory/MEMORY.md', '# contract-test memory');
    const back = await loadTextArtifact(TEST_SLUG, 'memory/MEMORY.md');
    expect(back).toBe('# contract-test memory');

    // Different slug should not see this row.
    const other = await loadTextArtifact('a-different-slug', 'memory/MEMORY.md');
    expect(other).not.toBe('# contract-test memory');
  });

  it('there is no compile-time slug list anywhere in lib/zero-harness', async () => {
    // Filesystem assertion (avoids importing across the workspace, which
    // hits unrelated vitest/tsconfig path issues). The deleted symbols
    // listed below were the central hardcoding root pre-Phase-1.5.
    //
    // Skip when running from a `.next/standalone/` build copy — Next's
    // standalone bundler clones .test.ts files into the standalone dir
    // and the relative path can't reach back to the workspace's
    // libs/zero-harness/. The "real" test under apps/operator/lib/
    // covers this case correctly.
    if (__dirname.includes('.next/standalone')) {
      console.warn('skipping in .next/standalone copy');
      return;
    }
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const schemaPath = path.join(__dirname, '../../../libs/zero-harness/src/schema.ts');
    const queriesPath = path.join(__dirname, '../../../libs/zero-harness/src/queries.ts');
    const schemaSrc = await fs.readFile(schemaPath, 'utf8');
    const queriesSrc = await fs.readFile(queriesPath, 'utf8');

    // No HARNESS_SLUGS const, no exported slugTo*Key helpers.
    expect(schemaSrc).not.toMatch(/^const HARNESS_SLUGS/m);
    expect(queriesSrc).not.toMatch(/^export function slugTo[A-Z][A-Za-z]*Key/m);

    // No per-slug exports like `featuresSheets` / `issuesOrg`.
    expect(schemaSrc).not.toMatch(/^export const features(Sheets|Org|Restart)/m);
    expect(schemaSrc).not.toMatch(/^export const issues(Sheets|Org|Restart)/m);
    expect(schemaSrc).not.toMatch(/^export const agentRuns(Sheets|Org|Restart)/m);
    expect(schemaSrc).not.toMatch(/^export const snapshots(Sheets|Org|Restart)/m);
  });
});
