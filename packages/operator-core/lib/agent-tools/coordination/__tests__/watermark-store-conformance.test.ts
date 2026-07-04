/**
 * P-050 dual-impl proof for WatermarkStore: run the SHARED conformance suite
 * (the one InMemoryWatermarkStore passes in
 * packages/coordination/src/watermark-store/watermark-store.test.ts) against
 * the production `PgWatermarkStore` over a real Postgres handle. Mirrors
 * event-log-conformance.test.ts: connects via `connectionString()`
 * (env→discovery→fallback), creates the table idempotently via the package's
 * own `ensureCoordWatermarksTable`, and soft-skips when no PG is reachable.
 * coord-channels-pg-port P-012.
 */
import { afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { PgWatermarkStore, ensureCoordWatermarksTable } from '@papercusp/coordination/watermark-store';
import { describeWatermarkStoreConformance } from '@papercusp/coordination/watermark-store/conformance';
import { connectionString } from '../../../memory/mem0-connection';

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
  await ensureCoordWatermarksTable(sql);
  pgOk = true;
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[watermark-store-conformance] PG not reachable, skipping:', (e as Error)?.message);
}

afterAll(async () => {
  if (!sql) return;
  // The conformance suite mints owners under a `wmconf-` prefix; clean ours
  // off the shared live table after the run.
  try {
    await sql`DELETE FROM harness_shared.coord_watermarks WHERE owner_id LIKE 'wmconf-%'`;
  } catch {
    /* best-effort */
  }
  await sql.end({ timeout: 5 });
});

describeWatermarkStoreConformance(
  'PgWatermarkStore (live PG)',
  () => new PgWatermarkStore({ getSql: () => sql!, ensureSchema: async () => {} }),
  { ready: async () => pgOk },
);
