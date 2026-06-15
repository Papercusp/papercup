/**
 * coord-capability-pg-stores.integration.test.ts — runs the capability
 * CONFORMANCE suites against the production `Pg*` capability stores over a REAL
 * Postgres (testcontainer). These are the exact same assertions the in-memory
 * doubles pass in `packages/coordination/src/capabilities/capabilities.test.ts`,
 * so this is the swappability proof for the PG side.
 *
 * This is the "operator's live-PG integration test" that
 * `packages/coordination/src/capabilities/pg-stores.ts` (header + each store's
 * doc) points to — documented as the intended home for these assertions but
 * previously ABSENT. Added in the app-wide-test-coverage breadth wave (EI-423):
 * the Pg* stores were only exercised indirectly (via the conversations/audience
 * tools) and never pinned directly against the contract suites.
 *
 * Isolation: every conformance `factory()` call mints a FRESH workspaceId, so a
 * store-set is partitioned (by `workspace_id`) from every other call — the same
 * freshness the in-memory factory gives by returning a brand-new empty store.
 * The five tables are created once via `ensureCoordCapabilityTables` (the
 * package's standalone schema rig, mirroring migration 123).
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *   packages/operator-core/lib/coord-capability-pg-stores.integration.test.ts
 */
import { afterAll, beforeAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import {
  describeLinkableStoreConformance,
  describeResolveObjectSubscribers,
  describeSubscribableStoreConformance,
  describeThreadableStoreConformance,
  describeTopicStoreConformance,
} from '@papercusp/coordination/capabilities/conformance';
import {
  ensureCoordCapabilityTables,
  PgEntitySubscriptionStore,
  PgLinkStore,
  PgTaggableStore,
  PgThreadStore,
  PgTopicStore,
} from '@papercusp/coordination/capabilities';

let sql: postgres.Sql;

let wsCounter = 0;
/** A fresh workspace_id per factory() call → each store-set is isolated. */
const freshWs = () => `conf_${++wsCounter}_${randomBytes(2).toString('hex')}`;
const opts = (workspaceId: string) => ({
  getSql: () => sql,
  // Tables are created once in beforeAll; the per-store ensure is a no-op here
  // (mirrors the operator, which passes a no-op ensureSchema — schema is
  // migrations-only per repo storage policy).
  ensureSchema: async () => {},
  workspaceId,
});

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `coordcap_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 8, onnotice: () => {} });
  await ensureCoordCapabilityTables(sql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

// The four single-store contracts — the SAME suites the in-memory doubles run.
describeTopicStoreConformance('PgTopicStore', () => new PgTopicStore(opts(freshWs())));
describeSubscribableStoreConformance(
  'PgEntitySubscriptionStore',
  () => new PgEntitySubscriptionStore(opts(freshWs())),
);
describeLinkableStoreConformance('PgLinkStore', () => new PgLinkStore(opts(freshWs())));
describeThreadableStoreConformance('PgThreadStore', () => new PgThreadStore(opts(freshWs())));

// The resolveObjectSubscribers fan-out core over the PG trio (subscriptions +
// link-backed tags + topics sharing one workspace_id).
describeResolveObjectSubscribers('Pg trio', () => {
  const ws = freshWs();
  return {
    subscriptions: new PgEntitySubscriptionStore(opts(ws)),
    tags: new PgTaggableStore(opts(ws)),
    topics: new PgTopicStore(opts(ws)),
  };
});
