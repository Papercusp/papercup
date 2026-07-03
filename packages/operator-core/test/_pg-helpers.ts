/**
 * _pg-helpers.ts — shared fixture for the engine *-pg real-Postgres integration
 * tests (P-008). NOT a test file (no `.integration.test.ts` suffix, so the glob
 * never collects it) — it is imported by them.
 *
 * Isolation (a throwaway database on the shared, reused testcontainer + a `drop`
 * that terminates backends first) is now the SHARED primitive `createFreshTestDb`
 * in @papercusp/test-config — the same engine Restart's provisionRestartTestDb /
 * createMigratedTestDb use. This helper only adds the two Papercusp-specific bits:
 *   1. a PRODUCTION-FAITHFUL client — `prepare:false` + BIGINT→number, matching
 *      libs/papercusp/libs/db/src/connection.ts. Using the same client config is
 *      load-bearing: it's what makes a real bug (e.g. the lanes jsonb double-encode)
 *      reproduce here exactly as in production, not a test-only client artifact.
 *   2. the `harness_shared` schema.
 *
 * cleanup() closes the client and drops the throwaway DB but leaves the container
 * up for reuse by the next test file (testcontainers `.withReuse()`), so a serial
 * integration run doesn't pay the ~2s boot per file.
 */
import postgres from 'postgres';
import { createFreshTestDb } from '@papercusp/test-config';

export interface FreshPgDb {
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}

/**
 * Federation ordering key (mig-458 / EI-1698). Every hyperbee projection's
 * PG-level LWW guard (ON CONFLICT … WHERE / DELETE WHERE) compares in one order
 * space via harness_shared.fed_order_key(hlc, ts) — the SAME derivation as the
 * in-process lwwPick. Hand-provisioned projection integration tests build only a
 * subset of the schema and never run mig-458, so without seeding this every
 * projection write/delete throws "function fed_order_key(text, bigint) does not
 * exist". It's a pure, table-free, IMMUTABLE fn — safe + idempotent to seed in
 * any fresh test DB after `CREATE SCHEMA harness_shared`. Keep the body
 * word-for-word in sync with
 * libs/papercusp/libs/db/sql/458-fed-order-key-transitivity-fix.sql.
 */
export const FED_ORDER_KEY_DDL = `
  CREATE OR REPLACE FUNCTION harness_shared.fed_order_key(hlc text, ts bigint)
  RETURNS text LANGUAGE sql IMMUTABLE AS $fed_order_key$
    SELECT COALESCE(hlc, lpad(COALESCE(ts, 0)::text, 15, '0') || ':00000');
  $fed_order_key$;
`;

export async function createFreshPgDb(prefix = 'eng'): Promise<FreshPgDb> {
  const db = await createFreshTestDb({ prefix });

  const sql = postgres(db.url, {
    max: 4,
    onnotice: () => {},
    prepare: false,
    types: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bigint: { to: 20, from: [20], serialize: (x: any) => String(x), parse: (x: string) => Number(x) } as any,
    },
  });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(FED_ORDER_KEY_DDL);

  const cleanup = async () => {
    await sql.end({ timeout: 5 });
    await db.drop();
  };

  return { sql, cleanup };
}
