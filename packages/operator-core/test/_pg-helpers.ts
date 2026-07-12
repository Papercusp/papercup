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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb } from '@papercusp/test-config';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');

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
 * Apply the migrations `claims.ts`'s `acquireClaimLocal` path needs against a
 * hand-provisioned test DB: 140 (plan-item assignments), 141 (leased claims),
 * 143 (agent_activity — the EI-8997 holder-activity grace join). Every
 * plan-items integration test that exercises claims.ts used to hand-copy this
 * list itself; when 143 was added as a dependency, at least four files missed
 * it independently and each generated its own watchdog red-test ticket
 * (EI-9508, EI-9509, EI-9513, EI-9515 — see EI-9613). Call this once in
 * `beforeAll` instead of listing the files by hand; a future migration
 * `claims.ts` starts depending on becomes a one-line addition here.
 *
 * GRANT-stripped (unlike `applyMigrationForTest`): 4 of the 5 call sites this
 * replaces (plan-item-claim-two-instance / plan-items / activity-claim-renewal
 * / claim-discipline .integration.test.ts) already hand-filtered GRANT lines
 * out of these exact 3 migrations rather than pre-creating the `harness_app`
 * / `harness_zero` roles the GRANTs target — a fresh testcontainer DB has
 * neither role until some file creates them, and role creation order across a
 * shared/reused container isn't guaranteed. The 5th site
 * (claims.integration.test.ts) instead pre-creates both roles via a DO block;
 * stripping GRANT here makes that block redundant but harmless, and keeps
 * this helper a true behavior-preserving drop-in for every call site (the
 * DDL itself is identical either way — GRANTs never affect table/column
 * shape, only a role's runtime privileges the test's own superuser/owner
 * connection doesn't need).
 */
export async function applyPlanItemClaimMigrations(sql: postgres.Sql): Promise<void> {
  for (const f of ['140-plan-item-assignments.sql', '141-plan-item-claims.sql', '143-agent-activity.sql']) {
    const sqlText = readFileSync(resolve(SQL_DIR, f), 'utf8')
      .split('\n')
      .filter(
        (l) => !l.trimStart().startsWith('\\') && !/\bGRANT\b/.test(l) && !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()),
      )
      .join('\n');
    await sql.unsafe(sqlText);
  }
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
  -- WI-2923 (mig 504): the apply-guard's tie-break at an equal order key —
  -- writer-pair when both known, else the symmetric content digest (local rows
  -- carry author_pubkey NULL, mig 214 stamps fed_ts only). Keep the body
  -- word-for-word in sync with
  -- libs/papercusp/libs/db/sql/504-fed-apply-writer-tiebreak.sql.
  CREATE OR REPLACE FUNCTION harness_shared.fed_apply_wins(
    excluded_hlc text, excluded_ts bigint, excluded_writer text, excluded_digest text,
    local_hlc    text, local_ts    bigint, local_writer    text, local_digest    text
  ) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fed_apply_wins$
    SELECT CASE
      WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
         > harness_shared.fed_order_key(local_hlc, local_ts) THEN true
      WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
         < harness_shared.fed_order_key(local_hlc, local_ts) THEN false
      WHEN excluded_writer IS NOT NULL AND local_writer IS NOT NULL
           AND excluded_writer <> local_writer THEN excluded_writer > local_writer
      ELSE COALESCE(excluded_digest, '') >= COALESCE(local_digest, '')
    END;
  $fed_apply_wins$;
`;

/**
 * ⚠ THIS DOES NOT RUN REAL MIGRATIONS. It provisions a genuinely EMPTY database
 * (`CREATE SCHEMA harness_shared` + the fed-order-key fns only) — every table your
 * test needs, YOU hand-roll as inline DDL in the calling `*.integration.test.ts`
 * file. There is no schema replay to fall back on.
 *
 * The footgun (EI-9387): when a table/column rename migration lands, a hand-rolled
 * DDL fixture using the OLD name still "successfully" creates a table — just the
 * wrong one — and the test then fails with `relation "harness_shared.<new_name>"
 * does not exist`, which reads EXACTLY like a genuine migration-replay bug. Two
 * agents burned a full session (P-009, 2026-07-09) chasing that theory against
 * migration 557 before finding the fixtures, not the migrations, were stale. If
 * you're hunting a "does not exist" failure from a test that uses this helper,
 * check the inline DDL in the test file FIRST — it is never auto-replayed from
 * `libs/papercusp/libs/db/sql/`.
 *
 * Need real migrations replayed instead? Use `createMigratedTestDb` /
 * `provisionRestartTestDb` (@papercusp/test-config) — those DO apply the actual
 * migration files.
 */
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
