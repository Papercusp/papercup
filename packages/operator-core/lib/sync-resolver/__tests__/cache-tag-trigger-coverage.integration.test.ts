/**
 * cache-tag-trigger-coverage.integration.test.ts — the CACHE-TAG-BACKING coverage guard.
 *
 * THE GAP THIS CLOSES (caching-layer-tag-eca-2026-06-22 P-005)
 * -----------------------------------------------------------
 * `TABLE_TO_QUERY_NAMES` (sync-resolver/table-to-query-names.ts) is the authoritative
 * map a `harness_shared.<table>.changed` trigger event uses to invalidate the right
 * sync query names AND bump the right cache tags (P-006 / D-018). For that bridge to
 * FIRE on a write, the backing table MUST carry the generic
 * `harness_shared.emit_change_notify()` trigger — the producer of the
 * `sync_invalidate` LISTEN/NOTIFY stream (000-baseline.sql; payload + row-PK fix
 * mig-368).
 *
 * The producers are attached imperatively, scattered across migrations
 * (107/124/213/215/222/227/275/368/373). Nothing tied "is this table MAPPED in
 * TABLE_TO_QUERY_NAMES?" to "does it actually carry the trigger?" — so a table could
 * be added to the map (a new sync query reads it) with the trigger forgotten, and
 * every app-code `notifySyncInvalidate` would still appear to work while RAW-SQL and
 * FEDERATED writes (which depend on the local trigger — D-005) silently left the
 * cache stale on every node. An audit on 2026-06-22 found 34 of 48 mapped tables in
 * exactly that state; mig-373 closed them, and this guard keeps the door shut.
 *
 * WHY AN INTEGRATION TEST (not a grep of the DDL)
 * ----------------------------------------------
 * The triggers are attached by `CREATE [OR REPLACE] TRIGGER`, `DO $$ FOREACH`
 * loops, and dynamic `EXECUTE format(...)` across many files — grepping the SQL is
 * brittle. Mirroring the sibling stamp-coverage guard, this migrates an empty DB
 * 000-baseline → head through the REAL boot-path runner and introspects
 * `pg_trigger` joined on `proname='emit_change_notify'`, so a new mapped table that
 * forgets the trigger trips it automatically — no test edit needed.
 *
 * WHAT IT ASSERTS
 * ---------------
 * The required set is DERIVED from `TABLE_TO_QUERY_NAMES` itself (the keys), so it
 * can't drift from the source of truth:
 *
 *   Every `harness_shared.<table>` key in TABLE_TO_QUERY_NAMES MUST have the
 *   emit_change_notify trigger — UNLESS the table is in `COVERAGE_EXEMPT` with a
 *   documented reason.
 *
 * The core check is an EXACT set-equality (not a subset), which has teeth in three
 * directions: a newly-mapped table with no trigger → RED; a removed trigger → RED;
 * a STALE exemption (the table since gained the trigger) → RED, forcing the dead
 * allow-list entry out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { TABLE_TO_QUERY_NAMES } from '../table-to-query-names';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot.
// Roles are cluster-global on the reused testcontainer, hence IF NOT EXISTS.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const NOTIFY_FUNCTION = 'emit_change_notify';

/**
 * Cache-tag-backing tables that are MAPPED in TABLE_TO_QUERY_NAMES but
 * INTENTIONALLY do not carry the emit_change_notify trigger, EACH with the reason
 * + the condition to re-arm. Empty today — every mapped table is covered after
 * mig-373. A mapped table NOT here that lacks the trigger is the bug this guard
 * exists to catch.
 */
const COVERAGE_EXEMPT: Record<string, string> = {};

/** The required tables = the keys of TABLE_TO_QUERY_NAMES, which are
 *  `harness_shared.<table>` strings. Parse them once; assert the schema is the
 *  one this guard introspects so a future cross-schema mapping fails loudly here
 *  instead of being silently un-checked. */
const requiredTables: string[] = (() => {
  const tables: string[] = [];
  for (const key of Object.keys(TABLE_TO_QUERY_NAMES)) {
    const dot = key.indexOf('.');
    const schema = dot >= 0 ? key.slice(0, dot) : '';
    const table = dot >= 0 ? key.slice(dot + 1) : key;
    if (schema !== 'harness_shared') {
      throw new Error(
        `TABLE_TO_QUERY_NAMES key '${key}' is not in the harness_shared schema; this ` +
          `coverage guard only introspects harness_shared. Extend the guard to cover ` +
          `schema '${schema}' before mapping a table there.`,
      );
    }
    tables.push(table);
  }
  return tables.sort();
})();

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'cachetrg',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('cache-tag-backing tables — every TABLE_TO_QUERY_NAMES table has the change-notify trigger', () => {
  /** harness_shared tables with an emit_change_notify trigger attached (match on
   *  FUNCTION, not trigger NAME — robust to per-table trigger names). */
  async function notifyTriggerTables(): Promise<Set<string>> {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT DISTINCT c.relname AS table_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = 'harness_shared'
         AND p.proname = ${NOTIFY_FUNCTION}
         AND NOT t.tgisinternal
    `;
    return new Set(rows.map((r) => r.table_name));
  }

  it('sanity: the change-notify trigger introspects (a representative mapped table is present)', async () => {
    const withTrigger = await notifyTriggerTables();
    // harness_plans got its trigger in mig-124 — if THIS is absent the introspection
    // query or the migration apply is broken, not the invariant. Guards against a
    // silently-empty set making the core check vacuous.
    expect(
      withTrigger.has('harness_plans'),
      'change-notify trigger introspection returned nothing — query/migration broken',
    ).toBe(true);
  });

  it('every TABLE_TO_QUERY_NAMES table has emit_change_notify, except the documented COVERAGE_EXEMPT set', async () => {
    const withTrigger = await notifyTriggerTables();

    const missing = requiredTables.filter((t) => !withTrigger.has(t)).sort();
    const exempt = Object.keys(COVERAGE_EXEMPT).sort();

    expect(
      missing,
      `Cache-tag-backing table(s) are MAPPED in TABLE_TO_QUERY_NAMES but MISSING the ` +
        `'${NOTIFY_FUNCTION}' trigger. The sync-sse bridge can't invalidate their query ` +
        `names / cache tags on a raw-SQL or FEDERATED write, so caches go silently stale ` +
        `on every node (D-005). For each: attach the generic trigger in a migration ` +
        `(mirror mig-222 / mig-373), OR — if the table intentionally has no change-notify ` +
        `producer — add it to COVERAGE_EXEMPT in this test with the reason + the ` +
        `re-arm condition. Undocumented vs documented-exempt diff is the failure.\n` +
        `  mapped-but-no-trigger: [${missing.join(', ')}]\n` +
        `  documented COVERAGE_EXEMPT: [${exempt.join(', ')}]`,
    ).toEqual(exempt);
  });

  it('no COVERAGE_EXEMPT entry is stale (each is a real mapped table that still lacks the trigger)', async () => {
    const withTrigger = await notifyTriggerTables();
    const required = new Set(requiredTables);

    const stale: string[] = [];
    for (const t of Object.keys(COVERAGE_EXEMPT)) {
      // An exemption is stale if the table is no longer mapped, or has SINCE gained
      // the trigger (the coverage cutover landed).
      if (!required.has(t) || withTrigger.has(t)) stale.push(t);
    }
    expect(
      stale,
      `COVERAGE_EXEMPT has stale entr(ies) — the table now has the trigger (or is no ` +
        `longer mapped in TABLE_TO_QUERY_NAMES). Remove the dead exemption: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
