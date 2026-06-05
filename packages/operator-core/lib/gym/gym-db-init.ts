/**
 * gym-PG-init (P-001 / D-018): provision the DEDICATED gym Postgres database.
 *
 * A gym instance runs the real pipeline, which writes to the full papercup schema
 * (harness_shared.*, dbos.*, per-harness views), so the gym DB needs the WHOLE main
 * schema PLUS the gym-owned schema. This creates the database, the framework roles,
 * the required extensions, applies the main migration baseline (000-baseline + 107+,
 * now self-contained — gated by fresh-migrate.integration.test.ts), then the gym
 * schema. Mirrors the test fixture _org-test-db.ts, hardened for real provisioning.
 *
 * Isolated from the live operator DB (D-018): a separate database the gym owns.
 */
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGymSchema } from './schema';
// eslint-disable-next-line import/no-relative-packages -- the real boot-path migration runner
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The main schema migration dir (000-baseline.sql + 107+). */
export const MAIN_SQL_DIR = join(__dirname, '../../../../libs/papercusp/libs/db/sql');

const FRAMEWORK_ROLES_DDL = `
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
`;

const EXTENSIONS_DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const SAFE_DB_NAME = /^[a-z_][a-z0-9_]*$/;

export interface ProvisionGymDbOpts {
  /** A maintenance DSN (connects to an existing db, e.g. `postgres`) able to CREATE DATABASE. */
  maintenanceUri: string;
  /** Name of the gym database to create. */
  dbName: string;
  /** Main schema migration dir; defaults to the repo's libs/papercusp/libs/db/sql. */
  mainSqlDir?: string;
}

/**
 * Create + fully provision the gym database. Returns its connection URI (admin role).
 * Idempotent on the schema (CREATE ... IF NOT EXISTS + the migration tracker); the
 * CREATE DATABASE tolerates an already-existing database.
 */
export async function provisionGymDatabase(opts: ProvisionGymDbOpts): Promise<{ databaseUri: string }> {
  if (!SAFE_DB_NAME.test(opts.dbName)) {
    throw new Error(`unsafe gym db name: ${JSON.stringify(opts.dbName)}`);
  }
  const maint = postgres(opts.maintenanceUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`CREATE DATABASE "${opts.dbName}"`);
  } catch (err) {
    // 42P04 = duplicate_database — fine (idempotent).
    if (!/already exists|duplicate_database|42P04/i.test(String(err))) throw err;
  } finally {
    await maint.end({ timeout: 5 });
  }

  const u = new URL(opts.maintenanceUri);
  u.pathname = `/${opts.dbName}`;
  const databaseUri = u.toString();

  const boot: Sql = postgres(databaseUri, { max: 1, onnotice: () => {}, prepare: false });
  try {
    await boot.unsafe(FRAMEWORK_ROLES_DDL);
    await boot.unsafe(EXTENSIONS_DDL);
    await applyPendingMigrations({ client: boot, sqlDir: opts.mainSqlDir ?? MAIN_SQL_DIR });
    await applyGymSchema(boot);
    await premintSpawnSigningKey(boot);
  } finally {
    await boot.end({ timeout: 5 });
  }

  return { databaseUri };
}

/**
 * Pre-mint the spawn-signing key so the orchestrator's `spawn-mcp` can SIGN the agent's
 * per-spawn `.mcp.json` on the very FIRST agent invoke.
 *
 * The live operator mints this key lazily, on its first signing/verify call
 * (`loadOrCreateKey` in apps/operator/lib/spawn-signing.ts). But a fresh gym DB never
 * receives such a call before the gym-operator spawns its first pipeline agent — so
 * `spawn-mcp.loadSigningKey()` reads `harness_shared.operator_secrets` for
 * `spawn-signing-key`, finds it missing, and (strict mode being the default) refuses to
 * emit an unsigned URL → the per-spawn `.mcp.json` is never written → `claude -p
 * --mcp-config <path> --strict-mcp-config` aborts with "MCP config file not found" and
 * EXIT 1, which the pipeline surfaces as "decide invoke failed (exit=1, empty=true)".
 *
 * Minting it here (idempotent) makes the first real agent run work. A 32-byte random key
 * matches what `loadOrCreateKey` would mint; both the orchestrator (signs) and the
 * gym-operator's MCP route (verifies) read this one row, so the HMAC is consistent.
 */
export async function premintSpawnSigningKey(sql: Sql): Promise<void> {
  const valueB64 = randomBytes(32).toString('base64');
  await sql`
    INSERT INTO harness_shared.operator_secrets (name, value_b64)
    VALUES ('spawn-signing-key', ${valueB64})
    ON CONFLICT (name) DO NOTHING`;
}
