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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGymSchema } from './schema';
// eslint-disable-next-line import/no-relative-packages -- the real boot-path migration runner
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The migration tree, relative to the repo root. */
const SQL_DIR_REL = join('libs', 'papercusp', 'libs', 'db', 'sql');

/**
 * Resolve the main-schema migration dir by walking UP from `startDir` to the
 * first ancestor that actually contains `libs/papercusp/libs/db/sql`.
 *
 * EI-8689: the old fixed `join(__dirname, '../../../../' + SQL_DIR_REL)` was
 * calibrated for the SOURCE layout (`packages/operator-core/lib/gym`, four
 * levels below the repo root). But operator-core is BUNDLED into
 * `apps/operator/dist-host/hono-host.mjs`, where `import.meta.url` — and thus
 * `__dirname` — sits at `apps/operator/dist-host`, only THREE levels below the
 * repo root. Up-four then overshot to `<workspace>/libs/papercusp/libs/db/sql`
 * (the workspace parent of the repo), which does not exist, so every gym-cycle
 * autoloop fire died with `ENOENT: scandir '.../libs/papercusp/libs/db/sql'`
 * (chronically red — 14 consecutive fires on gymloopharness). Walking up to the
 * real marker resolves correctly from BOTH the source and the bundled depth.
 */
export function resolveMainSqlDir(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 16; i += 1) {
    const candidate = join(dir, SQL_DIR_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the legacy source-relative path, so a genuinely-absent tree
  // still yields a deterministic path for the ENOENT message.
  return join(startDir, '..', '..', '..', '..', SQL_DIR_REL);
}

/** The main schema migration dir (000-baseline.sql + 107+). */
export const MAIN_SQL_DIR = resolveMainSqlDir(__dirname);

/**
 * The Postgres image the gym cycle provisions its dedicated ephemeral DB from.
 *
 * EI-8784: MUST track the shipped/embedded operator's PG major AND the shared
 * integration-test container (`@papercusp/test-config` pg-container.ts,
 * `TEST_PG_IMAGE`). WI-2942 (2026-07-05) bumped BOTH the test infra and the
 * embedded operator from PG16 → PG18 ("PG16 silently ALLOWED behavior PG18
 * REJECTS, and vice versa") but MISSED this gym provisioning line, which stayed
 * on `pgvector/pgvector:pg16`. The gym applies the SAME `000-baseline.sql` the
 * operator ships, so a version skew makes provisioning drift from what the
 * passing `gym-db-init.integration.test.ts` (which runs on pg18 via getTestPg)
 * actually validates — every live gym-cycle fire on gymloopharness then died at
 * `CREATE DATABASE cannot run inside a transaction block` (29 consecutive reds),
 * a failure the pg18 integration test never reproduced because it runs the
 * identical code against pg18. Pinning this to pg18 makes the live path
 * byte-identical to the green test; `gym-provision-image.test.ts` asserts it
 * can't drift from `TEST_PG_IMAGE` again.
 */
export const GYM_PROVISION_PG_IMAGE = 'pgvector/pgvector:pg18';

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
