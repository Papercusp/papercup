/**
 * git-export-slug-coverage.integration.test.ts — the ROUTABILITY guard for git docs.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `capture_git_export_outbox()` routes every export by `row->>'harness_slug'` into
 * `git_export_outbox.harness_slug`, which is NOT NULL. A table registered in
 * `GIT_DOCS` that has no `harness_slug` column therefore cannot be exported at all —
 * and, before EI-10521's seatbelt, the trigger's failing INSERT propagated out of the
 * AFTER trigger and ABORTED the caller's write. The table didn't just fail to export;
 * it became unwritable.
 *
 * This has now bitten the codebase TWICE:
 *   • llm_test_fixtures / llm_test_claims / llm_test_findings — "crashed every insert
 *     … a fresh llm-test run couldn't persist" (diagnosed in table-registry.ts, fixed
 *     by removing them from GIT_DOCS);
 *   • `goals` (INSTALL-scoped — its column is `install_slug`) and
 *     `project_spec_revisions` (PROJECT-scoped — no slug at all), which sat FIVE LINES
 *     BELOW that very comment with the identical defect. Both tables held ZERO rows,
 *     because every write to them had always thrown (EI-10521).
 *
 * Nothing mechanical caught either one: the registry is a hand-maintained list, and
 * whether an entry can actually be routed is a property of the SCHEMA, not the list.
 * That's what this checks.
 *
 * WHAT IT ASSERTS
 * ---------------
 * For every `GIT_TABLES` entry that exists in the migrated `harness_shared` schema,
 * the table MUST carry a NOT NULL `harness_slug` column — i.e. every registered git
 * doc is genuinely harness-scoped and every one of its rows is routable to exactly one
 * harness's `.papercusp/state/` dir.
 *
 * The teeth point in two directions: registering a non-harness-scoped table (the
 * EI-10521 bug) goes RED, and so does dropping/nulling the slug column out from under
 * a table that IS registered.
 *
 * WHY AN INTEGRATION TEST (not a unit test over the registry)
 * ----------------------------------------------------------
 * The invariant is a JOIN between a TypeScript list and the real PG schema. Only a
 * migrated database knows whether `goals` has a `harness_slug` column; the registry
 * happily claims it does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { GIT_TABLES } from '../table-registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot.
// Roles are cluster-global on the reused testcontainer, hence IF NOT EXISTS.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

/** A git doc's registry name, minus any `<schema>.` qualifier. */
const bare = (t: string): string => (t.includes('.') ? t.slice(t.indexOf('.') + 1) : t);

let db: MigratedTestDb;
let sql: postgres.Sql;

/** harness_shared tables → their harness_slug column's nullability (absent = no column). */
let slugCol: Map<string, { notNull: boolean }>;
/** harness_shared base tables present in the migrated schema. */
let present: Set<string>;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'gitslug',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });

  const tables = await sql<Array<{ table_name: string }>>`
    SELECT c.relname AS table_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared' AND c.relkind = 'r'`;
  present = new Set(tables.map((r) => r.table_name));

  const cols = await sql<Array<{ table_name: string; not_null: boolean }>>`
    SELECT c.relname AS table_name, a.attnotnull AS not_null
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared' AND c.relkind = 'r'
       AND a.attname = 'harness_slug' AND a.attnum > 0 AND NOT a.attisdropped`;
  slugCol = new Map(cols.map((r) => [r.table_name, { notNull: r.not_null }]));
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('git-export registry — every git doc is routable (harness_slug coverage guard)', () => {
  it('sanity: the registry is non-empty and introspection found a representative git doc', async () => {
    // If either of these is empty the core checks below would pass vacuously.
    expect(GIT_TABLES.length).toBeGreaterThan(0);
    expect(slugCol.has('harness_decisions'), 'harness_slug introspection returned nothing — query/migration broken').toBe(
      true,
    );
  });

  it('every registered git doc HAS a harness_slug column — an unroutable one aborts its own writes', () => {
    // Only tables this install actually has: attachAllGitCaptureTriggers skips absent
    // ones, so a registry entry for a table that doesn't exist here is not this bug.
    const registered = GIT_TABLES.map(bare).filter((t) => present.has(t));
    const unroutable = registered.filter((t) => !slugCol.has(t)).sort();

    expect(
      unroutable,
      `Table(s) are registered as GIT DOCS but have NO 'harness_slug' column. ` +
        `capture_git_export_outbox() routes on row->>'harness_slug' and inserts it into ` +
        `git_export_outbox.harness_slug (NOT NULL) — so these rows can never be exported, and ` +
        `before EI-10521's guard the failing insert propagated out of the AFTER trigger and ` +
        `ABORTED every INSERT/UPDATE/DELETE on the table (it became unwritable: that is how ` +
        `goals + project_spec_revisions ended up with zero rows, and how llm_test_* broke before ` +
        `them). A git doc must be HARNESS-scoped — it is exported into one harness's ` +
        `.papercusp/state/ dir. If the table is install-/project-/workspace-scoped, it is not a ` +
        `git doc: remove it from GIT_DOCS (table-registry.ts) and let it fall to sync:'none'. ` +
        `Unroutable: [${unroutable.join(', ')}]`,
    ).toEqual([]);
  });

  it("every registered git doc's harness_slug is NOT NULL — a nullable one exports silently-never", () => {
    // Weaker failure than the above but the same class: post-EI-10521 the trigger DROPS an
    // unroutable op instead of raising, so a nullable slug would turn a loud break into a
    // silent no-export. Every git doc today is NOT NULL; keep it that way.
    const registered = GIT_TABLES.map(bare).filter((t) => present.has(t) && slugCol.has(t));
    const nullable = registered.filter((t) => !slugCol.get(t)!.notNull).sort();

    expect(
      nullable,
      `Registered git doc(s) have a NULLABLE harness_slug. A row written with a NULL slug is ` +
        `dropped by the capture trigger's routability guard (EI-10521) — it will silently never ` +
        `reach git, with no error anywhere. Make the column NOT NULL, or remove the table from ` +
        `GIT_DOCS. Nullable: [${nullable.join(', ')}]`,
    ).toEqual([]);
  });

  it('goals + project_spec_revisions are NOT git docs (EI-10521 regression)', () => {
    // Named-and-shamed regression pin: these two are install-/project-scoped. Re-adding
    // either without giving it a harness scope re-breaks its write path outright.
    const registered = new Set(GIT_TABLES.map(bare));
    expect(registered.has('goals')).toBe(false);
    expect(registered.has('project_spec_revisions')).toBe(false);
  });
});
