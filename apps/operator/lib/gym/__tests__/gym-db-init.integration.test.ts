/**
 * Live-PG test for gym-PG-init (P-001/D-018): provisionGymDatabase creates a fresh
 * database, applies the full main schema baseline + the gym schema, and the result is
 * a working operator DB (harness_shared.*) WITH the gym tables (harness_gym.*).
 * Slow (applies the whole baseline) — the real prerequisite for any gym run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config';
import { provisionGymDatabase } from '../gym-db-init';

let containerUri: string;
let databaseUri: string;
let sql: postgres.Sql;
const dbName = `gymprov_${randomBytes(5).toString('hex')}`;

beforeAll(async () => {
  containerUri = await getTestPg();
  ({ databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName }));
  sql = postgres(databaseUri, { max: 1, onnotice: () => {}, prepare: false });
}, 120_000);

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

  it('is idempotent — re-provisioning the same db does not throw', async () => {
    await expect(provisionGymDatabase({ maintenanceUri: containerUri, dbName })).resolves.toBeTruthy();
  }, 120_000);
});
