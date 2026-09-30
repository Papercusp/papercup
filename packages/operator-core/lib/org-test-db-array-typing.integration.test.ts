/**
 * WI-10004177: the org test fixture's clients must type `sql.array(...)` the way production does,
 * on the FIRST query of a cold pool.
 *
 * Production clients come from `buildClient()` in @papercusp/db-org, which seeds postgres-js's
 * array-type map (`seedBuiltinArrayTypes`, WI-41207) and types number arrays
 * (`installNumericArrayTyping`, EI-21301868186403490). The fixture's `applyRawSerializerFixes`
 * mirrored only the Date and jsonb fixes. So a test's first `sql.array(['a'])` query was declared
 * `text`, not `text[]`, and failed with "column … is of type text[] but expression is of type
 * text". Production never did that. A later query succeeded because by then the connection had
 * fetched the catalog's array types.
 *
 * Each client below is fresh from `createOrgTestDb()` and has run no query before the one that is
 * checked, so this is the cold-pool case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('org test fixture: sql.array typing on a cold pool (WI-10004177)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('declares a string array as text[] on the app client\'s first query', async () => {
    const rows = await db.appSql<{ t: string }[]>`SELECT pg_typeof(${db.appSql.array(['a', 'b'])})::text AS t`;
    expect(rows[0]?.t).toBe('text[]');
  });

  it('declares a number array as bigint[] on the admin client\'s first query', async () => {
    const rows = await db.adminSql<{ t: string }[]>`SELECT pg_typeof(${db.adminSql.array([1, 2])})::text AS t`;
    expect(rows[0]?.t).toBe('bigint[]');
  });
});
