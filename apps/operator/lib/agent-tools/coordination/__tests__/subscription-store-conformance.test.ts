/**
 * P-050 dual-impl proof for SubscriptionStore: run the SHARED conformance
 * suite (the one InMemorySubscriptionStore passes in
 * packages/coordination/src/subscription-store/subscription-store.test.ts)
 * against the production `PgSubscriptionStore` over a real Postgres handle.
 * Mirrors event-log-conformance.test.ts. coord-channels-pg-port P-012.
 */
import { afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { PgSubscriptionStore, ensureCoordSubscriptionsTable } from '@papercusp/coordination/subscription-store';
import { describeSubscriptionStoreConformance } from '@papercusp/coordination/subscription-store/conformance';
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
  await ensureCoordSubscriptionsTable(sql);
  pgOk = true;
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[subscription-store-conformance] PG not reachable, skipping:', (e as Error)?.message);
}

afterAll(async () => {
  if (!sql) return;
  // The conformance suite mints owners under a `subconf-` prefix; clean ours
  // off the shared live table after the run.
  try {
    await sql`DELETE FROM harness_shared.coord_subscriptions WHERE owner_id LIKE 'subconf-%'`;
  } catch {
    /* best-effort */
  }
  await sql.end({ timeout: 5 });
});

describeSubscriptionStoreConformance(
  'PgSubscriptionStore (live PG)',
  () => new PgSubscriptionStore({ getSql: () => sql!, ensureSchema: async () => {} }),
  { ready: async () => pgOk },
);
