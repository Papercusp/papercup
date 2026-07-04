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
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createFreshTestDb } from '@papercusp/test-config';

export interface FreshPgDb {
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}

/**
 * EI-6887 — apply ONE real migration SQL file to a hand-provisioned test DB
 * (e.g. `createFreshPgDb` above) via `sql.unsafe`, which speaks SQL, not psql.
 * Newer migrations (461/462/464/465+) carry `\set ON_ERROR_STOP on` psql
 * meta-commands + a top-level BEGIN;/COMMIT; wrapper per the runner convention
 * — raw `sql.unsafe(readFileSync(file))` on one of these fails TWICE in
 * sequence: first on the `\`-line ("syntax error at or near \"\\\""), then
 * (once that's stripped) on postgres-js's UNSAFE_TRANSACTION guard (raw txn
 * control isn't allowed on a pooled/non-`sql.begin` client). Older migrations
 * (184/185/189) carry neither, so a test written against them silently
 * doesn't transfer to a newer one. This strips both (the wrapper is a
 * production-apply nicety, not a correctness requirement for a hand-applied
 * single-file DDL run — the file's own DDL is idempotent) so any migration,
 * old or new, applies the same way. Lifted from the inline version in
 * `lib/agent-facts/store.integration.test.ts` (the first two call sites —
 * that file and composition-rig.ts — both hand-rolled equivalent filters).
 */
export async function applyMigrationForTest(sql: postgres.Sql, filePath: string): Promise<void> {
  const sqlText = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()))
    .join('\n');
  await sql.unsafe(sqlText);
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
