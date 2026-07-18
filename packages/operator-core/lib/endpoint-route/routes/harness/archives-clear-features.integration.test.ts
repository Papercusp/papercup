/**
 * clearHarnessFeaturesForReset — WI-5381 (WI-4995 part b) regression test.
 * Proves the harnessQuery migration resolves `harness_features` to the
 * CORRECT per-harness schema (not a sibling harness's table with the same
 * unqualified name) in BOTH connection modes, mirroring harness-schema.
 * integration.test.ts's method. Real Postgres (testcontainer; Docker
 * required). Run:
 *   npx vitest run --config vitest.integration.config.ts lib/endpoint-route/routes/harness/archives-clear-features.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { slugToSchemaName, _resetForTests } from '@papercusp/db-org';
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import { clearHarnessFeaturesForReset } from './archives';

const SLUG_A = 'archtest-a';
const SLUG_B = 'archtest-b';
const SCHEMA_A = slugToSchemaName(SLUG_A);
const SCHEMA_B = slugToSchemaName(SLUG_B);

let db: MigratedTestDb;
let obs: Sql;

const savedEnv = {
  url: process.env.HARNESS_DATABASE_URL,
  pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
};

async function seed() {
  await obs.unsafe(`TRUNCATE ${SCHEMA_A}.harness_features, ${SCHEMA_B}.harness_features`);
  await obs.unsafe(
    `INSERT INTO ${SCHEMA_A}.harness_features (id, harness_slug, title, status) VALUES
      ('a-1', '${SLUG_A}', 'a1', 'todo'), ('a-2', '${SLUG_A}', 'a2', 'todo')`,
  );
  await obs.unsafe(
    `INSERT INTO ${SCHEMA_B}.harness_features (id, harness_slug, title, status) VALUES
      ('b-1', '${SLUG_B}', 'b1', 'todo')`,
  );
}

async function counts() {
  const [a] = await obs.unsafe(`SELECT count(*)::int AS n FROM ${SCHEMA_A}.harness_features`) as unknown as { n: number }[];
  const [b] = await obs.unsafe(`SELECT count(*)::int AS n FROM ${SCHEMA_B}.harness_features`) as unknown as { n: number }[];
  return { a: a.n, b: b.n };
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'archclr' });
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  _resetUrlCacheForTests();
  await _resetForTests();

  obs = postgres(db.url, { max: 1, onnotice: () => {} });
  for (const [slug, schema] of [[SLUG_A, SCHEMA_A], [SLUG_B, SCHEMA_B]] as const) {
    await obs.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await obs.unsafe(
      `CREATE TABLE IF NOT EXISTS ${schema}.harness_features (
         id text PRIMARY KEY, harness_slug text NOT NULL, title text, status text)`,
    );
  }
}, 120_000);

afterAll(async () => {
  await _resetForTests().catch(() => {});
  await obs?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
  if (savedEnv.url === undefined) delete process.env.HARNESS_DATABASE_URL;
  else process.env.HARNESS_DATABASE_URL = savedEnv.url;
  if (savedEnv.pgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = savedEnv.pgbouncer;
  _resetUrlCacheForTests();
});

describe('clearHarnessFeaturesForReset', () => {
  it('DIRECT mode: deletes only the target harness schema’s rows, leaving a sibling harness untouched', async () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    await _resetForTests();
    await seed();
    await clearHarnessFeaturesForReset(SLUG_A);
    const c = await counts();
    expect(c.a).toBe(0);
    expect(c.b).toBe(1); // sibling harness's rows survive — proves schema scoping, not a cross-harness wipe
  });

  it('POOLED mode: same scoping guarantee via the per-tx search_path chokepoint', async () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    await _resetForTests();
    try {
      await seed();
      await clearHarnessFeaturesForReset(SLUG_B);
      const c = await counts();
      expect(c.b).toBe(0);
      expect(c.a).toBe(2); // sibling harness untouched
    } finally {
      process.env.PAPERCUSP_PGBOUNCER = '0';
      await _resetForTests();
    }
  });
});
