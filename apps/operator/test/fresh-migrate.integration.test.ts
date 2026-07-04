/**
 * fresh-migrate.integration.test.ts — the STRICT SUCCESS GATE: empty Postgres → head.
 *
 * Plan: self-contained-migration-baseline-2026-06-02, Phase 3 (P-011). Supersedes the
 * old "tripwire" (which asserted empty→head FAILED, because the schema used to be split
 * between hand-written migrations and runtime ensure-schema DDL).
 *
 * The schema is now a single self-contained `000-baseline.sql` (the squash + the
 * 117 archived incrementals). So empty→head MUST now succeed, completely and
 * idempotently, with ZERO skips. This gate asserts exactly that, exercising the REAL
 * production migration runner from a genuinely empty database.
 *
 * Boot pre-steps the production embedded-pg performs before migrations (and that this
 * gate replicates): framework roles + the 3 extensions the baseline references
 * (pgcrypto/pg_trgm/vector). See embedded-postgres-server/src/index.js.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// Boot pre-migration step (roles + extensions), mirrored from embedded-postgres-server/src/index.js.
// A future refactor should extract a shared ensureFrameworkPrereqs() both call.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const MIN_HARNESS_SHARED_TABLES = 180; // complete baseline (see verify-baseline.ts); -3 after dropping the 3 harness_expert* tables (migration 117); -1 harness_health (migration 171)

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;
let firstRun: { appliedCount: number; totalKnown: number };

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `fm_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  // max:1 — the runner applies each migration in an explicit BEGIN/COMMIT block.
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(BOOT_PREREQS_DDL);

  // The one real apply, shared across the assertions below.
  firstRun = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
}, 120_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('fresh migrate — empty Postgres → head (STRICT SUCCESS GATE)', () => {
  it('applies every tracked migration from empty, with zero skips', () => {
    expect(firstRun.totalKnown).toBeGreaterThanOrEqual(1); // 000-baseline.sql (template is name-skipped)
    expect(firstRun.appliedCount).toBe(firstRun.totalKnown); // ZERO skips
  });

  it('builds the complete schema (all harness_shared tables present)', async () => {
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'harness_shared' AND table_type = 'BASE TABLE'`,
    );
    expect(n).toBeGreaterThanOrEqual(MIN_HARNESS_SHARED_TABLES);
  });

  it('records exactly one tracker row per applied migration', async () => {
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.schema_migrations`,
    );
    expect(n).toBe(firstRun.totalKnown);
  });

  it('wires the reactivity triggers (emit_change_notify_trg) from migrations, not runtime DDL', async () => {
    // Migration 107 moved these out of the old runtime wireDogfoodTriggers() helper.
    // A table/column/index/policy diff can't see triggers, so assert them explicitly.
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = 'emit_change_notify_trg'`,
    );
    expect(n).toBeGreaterThanOrEqual(18);
  });

  it('builds the core global schemas (papercusp_auth + audit, migration 109)', async () => {
    // The reference dump was scoped to harness_shared + papercusp_shared, so these were a
    // baseline blind spot until 109 restored them.
    const rows = await sql.unsafe(
      `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)`,
      [['harness_shared', 'papercusp_shared', 'papercusp_auth', 'audit']],
    );
    expect(rows.length).toBe(4);
  });

  it('grants the runtime app role access (harness_app can read its tables — migration 109)', async () => {
    // --no-privileges stripped every grant from the baseline; 109 restores them. Connect AS
    // harness_app (not the migration superuser) to prove a fresh boot doesn't lock the app out.
    const u = new URL(adminUri);
    const appUri = `postgresql://harness_app:harness_app_pwd@${u.hostname}:${u.port}/${dbName}`;
    const app = postgres(appUri, { max: 1, onnotice: () => {} });
    try {
      await expect(app.unsafe(`SELECT count(*) FROM harness_shared.harness_features_consolidated`)).resolves.toBeDefined();
      await expect(app.unsafe(`SELECT count(*) FROM papercusp_auth.users`)).resolves.toBeDefined();
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it('is idempotent — a second run applies nothing', async () => {
    const second = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
    expect(second.appliedCount).toBe(0);
  });

  it('re-applying 000-baseline.sql RAW is a clean no-op (statement-level idempotency)', async () => {
    // Asserted on a baseline-ONLY database, not the head DB: migration 374 turned
    // work_items/harness_features_consolidated/engineer_issues into views at head,
    // so table-DDL statements in the baseline (ALTER TABLE, triggers, RLS) now fail
    // there on relation-type mismatch no matter how well guarded. The contract this
    // gate protects — every baseline statement is guarded (IF NOT EXISTS /
    // OR REPLACE / DO-block) — is a property of the baseline itself.
    const { readFileSync } = await import('node:fs');
    const baseline = readFileSync(resolve(SQL_DIR, '000-baseline.sql'), 'utf8');
    const bName = `fmb_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${bName}"`);
      const u = new URL(adminUri);
      u.pathname = `/${bName}`;
      const bSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
      try {
        await bSql.unsafe(BOOT_PREREQS_DDL);
        await bSql.unsafe(baseline);
        // Throws if any statement isn't guarded.
        await expect(bSql.unsafe(baseline)).resolves.toBeDefined();
      } finally {
        await bSql.end({ timeout: 5 });
      }
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${bName}" WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 5 });
    }
  }, 120_000);
});

describe('migration runner — filename-keyed tracker safety', () => {
  it('records each migration filename at most once (filename is the PK)', async () => {
    const dupes = await sql.unsafe(
      `SELECT filename FROM harness_shared.schema_migrations
        GROUP BY filename HAVING count(*) > 1`,
    );
    expect(dupes).toHaveLength(0);
  });
});
