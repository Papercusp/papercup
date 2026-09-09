/**
 * Live-PG test for gym-PG-init (P-001/D-018): provisionGymDatabase creates a fresh
 * database, applies the full main schema baseline + the gym schema, and the result is
 * a working operator DB (harness_shared.*) WITH the gym tables (harness_gym.*).
 * Slow (applies the whole baseline) — the real prerequisite for any gym run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import {
  GYM_TEMPLATE_READY_MARK,
  gymTemplateKey,
  provisionGymDatabase,
} from '../gym-db-init';

let containerUri: string;
let databaseUri: string;
let sql: postgres.Sql;
const dbName = `gymprov_${randomBytes(5).toString('hex')}`;

beforeAll(async () => {
  containerUri = await getTestPg();
  ({ databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName }));
  sql = postgres(databaseUri, { max: 1, onnotice: () => {}, prepare: false });
}, 420_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('provisionGymDatabase', () => {
  it('produces a working operator DB with the main schema (harness_features_consolidated)', async () => {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('harness_shared.harness_features_consolidated') IS NOT NULL AS exists`;
    expect(rows[0].exists).toBe(true);
  });

  it('also has the gym schema (harness_gym.gym_runs)', async () => {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('harness_gym.gym_runs') IS NOT NULL AS exists`;
    expect(rows[0].exists).toBe(true);
  });

  it('reuses a ready migration template for a second database and mints a target key', async () => {
    const cloneName = `gymclone_${randomBytes(5).toString('hex')}`;
    const { databaseUri: cloneUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName: cloneName });
    const clone = postgres(cloneUri, { max: 1, onnotice: () => {}, prepare: false });
    const admin = postgres(containerUri, { max: 1, onnotice: () => {} });
    try {
      const schemaRows = await clone<{ exists: boolean }[]>`
        SELECT to_regclass('harness_shared.harness_features_consolidated') IS NOT NULL AS exists`;
      expect(schemaRows[0].exists).toBe(true);
      const keyRows = await clone<{ value_b64: string }[]>`
        SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key'`;
      expect(keyRows).toHaveLength(1);
      expect(Buffer.from(keyRows[0].value_b64, 'base64')).toHaveLength(32);

      const templateRows = await admin<{ description: string }[]>`
        SELECT c.description
          FROM pg_database d
          JOIN pg_shdescription c ON c.objoid = d.oid
         WHERE d.datname = ${`tmpl_gym_${gymTemplateKey()}`}
           AND c.description = ${GYM_TEMPLATE_READY_MARK}`;
      expect(templateRows).toHaveLength(1);
    } finally {
      await clone.end({ timeout: 5 });
      try { await admin.unsafe(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
    }
  });

  it('pre-mints the spawn-signing key so the first real agent spawn can sign its .mcp.json', async () => {
    // Without this row, spawn-mcp throws "spawn-signing-key row missing" and the first
    // director invoke fails (claude -p --strict-mcp-config aborts on a missing .mcp.json).
    const rows = await sql<{ value_b64: string }[]>`
      SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key' LIMIT 1`;
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].value_b64, 'base64')).toHaveLength(32);
  });

  it('is idempotent — re-provisioning the same db does not throw', async () => {
    await expect(provisionGymDatabase({ maintenanceUri: containerUri, dbName })).resolves.toBeTruthy();
  }, 120_000);
});
