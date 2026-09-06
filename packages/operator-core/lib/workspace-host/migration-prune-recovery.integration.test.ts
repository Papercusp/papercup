import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createFreshTestDb } from '@papercusp/test-config';
import {
  applyPendingMigrations,
  defaultSkipFile,
} from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');

// R22 pruned these runtime files AFTER its fresh-schema seed check had passed.
// Keep the historical omissions explicit: this tests recovery of that shipped schema,
// while the bundle's exact filename-set guard prevents new omissions at build time.
const R22_OMITTED_MIGRATIONS = [
  '389-bee-claim-spec-id-only.sql',
  '413-harness-test-runs-scope-columns.sql',
  '492-test-runs-saturation-columns.sql',
  '642-unify-claim-spec-states-todo-to-open.sql',
  '701-test-runs-scratch-config-flag.sql',
  '709-test-runs-worktree-dirty.sql',
  '738-adv-sessions-launch-spec.sql',
  '810-claim-spec-revision-history.sql',
  '815-expose-claim-spec-fields-on-engineer-issues-view.sql',
  '850-test-runs-future-timestamp-clamp.sql',
  '851-first-class-plan-spec-clauses.sql',
  '852-plan-spec-clause-integrity.sql',
  '855-work-item-spec-evidence-bindings.sql',
  '922-datatype-display-spec.sql',
  '929-spec-clause-falsifier.sql',
  '930-spec-clause-falsifier-null-safe.sql',
  '956-workspace-host-desired-spec.sql',
] as const;

describe('workspace-host recovery from the R22 migration-prune defect', () => {
  it('restores every omitted migration on the advanced schema and converges without retrying a failure', async () => {
    const db = await createFreshTestDb({ prefix: 'workspace_host_prune_replay' });
    // The production runner owns its transactions and needs one dedicated connection.
    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    const omitted = new Set<string>(R22_OMITTED_MIGRATIONS);
    try {
      // Same framework prerequisites as embedded boot and the shared org-test fixture.
      await sql.unsafe(`
        DO $roles$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
            CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
            CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
            CREATE ROLE harness_zero LOGIN REPLICATION NOSUPERUSER BYPASSRLS PASSWORD 'harness_zero_pwd';
          END IF;
        END $roles$;
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS vector;
      `);

      // R22 reached this exact first missing prerequisite, leaving the preceding
      // non-omitted migrations committed, including the bee→cup table rename.
      await expect(
        applyPendingMigrations({
          client: sql,
          sqlDir: SQL_DIR,
          skipFile: (file) => defaultSkipFile(file) || omitted.has(file) || Number.parseInt(file, 10) > 1111,
        }),
      ).rejects.toThrow('1111-acceptance-bar-contract-seed.sql');
      const before = await sql<{ filename: string }[]>`SELECT filename FROM harness_shared.schema_migrations`;
      const beforeNames = before.map(({ filename }) => filename);
      expect(beforeNames).toContain('555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql');
      expect(beforeNames).not.toContain('1111-acceptance-bar-contract-seed.sql');
      expect(beforeNames.filter((file) => omitted.has(file))).toEqual([]);
      const viewBefore = await sql<{ name: string }[]>`
        SELECT attname AS name FROM pg_attribute
         WHERE attrelid = 'harness_shared.engineer_issues'::regclass
           AND attnum > 0 AND NOT attisdropped
         ORDER BY attnum`;
      // Later migrations already exposed these fields while 815 was absent.
      expect(viewBefore.map(({ name }) => name)).toEqual(expect.arrayContaining(['admission', 'state_changed_at']));

      // Reuse the fail-closed production path: a later-schema collision in ANY
      // restored file must fail this test, not get skipped or pass on a later boot.
      const recovery = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR, dataDirWasReused: true });
      expect(recovery.failed).toEqual([]);
      expect(recovery.appliedCount).toBeGreaterThanOrEqual(omitted.size + 1);
      const after = await sql<{ filename: string }[]>`SELECT filename FROM harness_shared.schema_migrations`;
      const afterNames = after.map(({ filename }) => filename).sort();
      const expected = readdirSync(SQL_DIR)
        .filter((file) => file.endsWith('.sql') && !defaultSkipFile(file))
        .sort();
      expect(afterNames).toEqual(expected);
      const viewAfter = await sql<{ name: string }[]>`
        SELECT attname AS name FROM pg_attribute
         WHERE attrelid = 'harness_shared.engineer_issues'::regclass
           AND attnum > 0 AND NOT attisdropped
         ORDER BY attnum`;
      expect(viewAfter.slice(0, viewBefore.length)).toEqual(viewBefore);
      expect(viewAfter.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'tags',
          'source_plan_slug',
          'source_plan_item_ids',
          'redundancy',
          'expected_cost_cents',
        ]),
      );

      // Verify the migration's own no-op branch, separately from the runner's ledger skip.
      const definitionBeforeReplay =
        await sql`SELECT pg_get_viewdef('harness_shared.engineer_issues'::regclass) AS definition`;
      await sql.unsafe(
        readFileSync(resolve(SQL_DIR, '815-expose-claim-spec-fields-on-engineer-issues-view.sql'), 'utf8'),
      );
      const definitionAfterReplay =
        await sql`SELECT pg_get_viewdef('harness_shared.engineer_issues'::regclass) AS definition`;
      expect(definitionAfterReplay).toEqual(definitionBeforeReplay);

      await expect(
        applyPendingMigrations({ client: sql, sqlDir: SQL_DIR, dataDirWasReused: true }),
      ).resolves.toMatchObject({ appliedCount: 0, totalKnown: expected.length, failed: [] });
    } finally {
      await sql.end({ timeout: 5 });
      await db.drop();
    }
  }, 180_000);
});
