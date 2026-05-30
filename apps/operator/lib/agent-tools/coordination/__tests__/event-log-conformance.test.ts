/**
 * P-050 dual-impl proof for CoordEventLog: run the SHARED conformance suite
 * (the one InMemoryCoordLog + FsCoordLog pass in
 * packages/coordination/src/event-log/event-log.test.ts) against the
 * PRODUCTION-grade `PgCoordLog` over a real Postgres handle. Three backends
 * passing the SAME assertions is what makes the "optional PG log" swappable
 * (P-011) and the dual-impl claim real (P-050) — the event-log analogue of
 * the peer's presence-conformance.test.ts.
 *
 * Connects via `connectionString()` (env→discovery→fallback, the resolver
 * `pgClientFields` uses — `getOrgPg()` needs an operator bootstrap a
 * standalone vitest run lacks) and mirrors getOrgPg()'s postgres-js options
 * (esp. `prepare: false`, which governs jsonb round-tripping). The
 * `coord_event_log` table is created idempotently via the package's own
 * `ensureCoordEventLogTable`, so the proof RUNS wherever PG is reachable —
 * live operator or CI testcontainer — and soft-skips only when no PG exists.
 */
import { afterAll, describe } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { PgCoordLog, ensureCoordEventLogTable } from '@papercusp/coordination/event-log';
import { describeCoordEventLogConformance } from '@papercusp/coordination/event-log/conformance';
import { connectionString } from '@/lib/memory/mem0-connection';

let sql: Sql | null = null;
let pgOk = false;

try {
  const url = await connectionString();
  sql = postgres(url, {
    onnotice: () => {},
    connection: { search_path: 'harness_shared, public' },
    prepare: false,
    max: 4,
  });
  await sql`SELECT 1`;
  await ensureCoordEventLogTable(sql);
  pgOk = true;
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[event-log-conformance] PG not reachable, skipping:', (e as Error)?.message);
}

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describeCoordEventLogConformance(
  'PgCoordLog (live PG)',
  async () => {
    // coord_event_log is a test-only table (the operator runs FsCoordLog), so
    // a full clear per case gives every test an empty surface to start from —
    // matching the in-mem/fs factories that hand back a fresh store.
    await sql!`DELETE FROM harness_shared.coord_event_log`;
    return {
      log: new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {} }),
      cleanup: async () => {
        await sql!`DELETE FROM harness_shared.coord_event_log`;
      },
    };
  },
  pgOk ? describe : describe.skip,
);
