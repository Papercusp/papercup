/**
 * _pg-helpers.ts — shared fixture for the engine *-pg real-Postgres integration
 * tests (P-008). NOT a test file (no `.integration.test.ts` suffix, so the glob
 * never collects it) — it is imported by them.
 *
 * Creates a throwaway database on the shared (reused) testcontainer, connected
 * with a PRODUCTION-FAITHFUL client — `prepare:false` + BIGINT→number, matching
 * libs/papercusp/libs/db/src/connection.ts. Using the same client config is
 * load-bearing: it is what makes a real bug (e.g. the lanes jsonb double-encode)
 * reproduce here exactly as it would in production, and what stops a test-only
 * client artifact from masquerading as a bug.
 *
 * cleanup() drops the throwaway DB but leaves the container up for reuse by the
 * next test file (testcontainers `.withReuse()`), so a serial integration run
 * doesn't pay the ~2s boot per file.
 */
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

export interface FreshPgDb {
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}

export async function createFreshPgDb(prefix = 'eng'): Promise<FreshPgDb> {
  const adminUri = await getTestPg();
  const dbName = `${prefix}_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  const sql = postgres(u.toString(), {
    max: 4,
    onnotice: () => {},
    prepare: false,
    types: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bigint: { to: 20, from: [20], serialize: (x: any) => String(x), parse: (x: string) => Number(x) } as any,
    },
  });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');

  const cleanup = async () => {
    await sql.end({ timeout: 5 });
    const a = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } catch {
      /* best-effort */
    } finally {
      await a.end({ timeout: 5 });
    }
  };

  return { sql, cleanup };
}
