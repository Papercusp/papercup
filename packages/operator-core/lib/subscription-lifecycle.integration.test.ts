/**
 * subscription-lifecycle.integration.test.ts — shared-reference-system-2026-11-13
 * P-002 over a REAL Postgres (testcontainer):
 *
 *  - R-8: a contextual subscription ends on each of the four end events (clean
 *    session end, a session the liveness oracle reports ended, context
 *    replacement, explicit release), and a subscription cancelled between
 *    resolve and write is never delivered to (the race).
 *  - R-39: an explicit or held-item follow survives every context end and goes
 *    only through its own explicit release.
 *  - D-002: the legacy cleanup snapshots, then cancels, only dead legacy rows,
 *    and finishes across bounded batches without skipping a row.
 *
 * Run: npm run test:file -- packages/operator-core/lib/subscription-lifecycle.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyMigrationForTest } from '../test/_pg-helpers';
import {
  ensureCoordCapabilityTables,
  isResolvedSubscriberLive,
  PgEntitySubscriptionStore,
  PgTaggableStore,
  PgTopicStore,
  resolveObjectSubscribers,
  type ObjectRef,
} from '@papercusp/coordination/capabilities';
import { deliverInjectMany, type InjectEvent, type InjectSink } from './agent-tools/coordination/fanout-delivery';
import {
  cleanupLegacyDeadSubscriptions,
  endSubscriberContexts,
  LEGACY_CLEANUP_RUN,
  sweepEndedSubscriberContexts,
} from './subscription-lifecycle';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');

let sql: postgres.Sql;
let wsCounter = 0;
const freshWs = () => `p002_${++wsCounter}_${randomBytes(2).toString('hex')}`;
const storeFor = (workspaceId: string) =>
  new PgEntitySubscriptionStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId });
const nowIso = () => new Date().toISOString();
const su = (n: number) => `su-${String(n).padStart(8, '0')}-0000-4000-8000-${randomBytes(6).toString('hex')}`;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `p002life_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 8, onnotice: () => {} });
  await ensureCoordCapabilityTables(sql);
  await applyMigrationForTest(sql, resolve(SQL_DIR, '1638-subscription-reasons-lifecycle.sql'));
  // Minimal registries the legacy cleanup reads (only the columns it uses).
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions (
      id bigserial PRIMARY KEY, workspace_id text, coord_owner_id text, ended_at timestamptz);
    CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (workspace_id text, owner_id text);`);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function rowsOf(ws: string, subscriber: string) {
  return sql<{ target_ref: string; reasons: string[] | null; cancelled_at: Date | null; cancel_reason: string | null }[]>`
    SELECT target_ref, reasons, cancelled_at, cancel_reason
      FROM harness_shared.coord_entity_subscriptions
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriber}
     ORDER BY target_ref`;
}

async function contextFollow(store: PgEntitySubscriptionStore, subscriber: string, ref: string, epoch: number) {
  await store.subscribe({
    subscriber_id: subscriber, target_kind: 'object', target_ref: ref,
    created_ts: nowIso(), reason: 'context', context_epoch: epoch,
  });
}

describe('R-8: a contextual subscription ends on every end event', () => {
  test('clean session end, oracle-ended, context replacement and explicit release each cancel it', async () => {
    const ws = freshWs();
    const store = storeFor(ws);
    const [a, b, c, d] = [su(1), su(2), su(3), su(4)];
    for (const s of [a, b, c, d]) await contextFollow(store, s, 'issue:ISS-1', 1);
    // c re-reads ISS-2 in its NEW context (epoch 2): that follow must survive the replacement.
    await contextFollow(store, c, 'issue:ISS-2', 2);

    await endSubscriberContexts(a, 'session-end', { store });
    const sweep = await sweepEndedSubscriberContexts({ store, endedAmong: async (ids) => new Set(ids.filter((id) => id === b)) });
    await endSubscriberContexts(c, 'context-replaced', { store, beforeEpoch: 2 });
    await store.unsubscribe(d, 'object', 'issue:ISS-1', 'context');

    expect(sweep.ended).toBe(1);
    expect((await rowsOf(ws, a))[0]).toMatchObject({ cancel_reason: 'session-end' });
    expect((await rowsOf(ws, b))[0]).toMatchObject({ cancel_reason: 'session-ended-oracle' });
    const cRows = await rowsOf(ws, c);
    expect(cRows[0]).toMatchObject({ target_ref: 'issue:ISS-1', cancel_reason: 'context-replaced' });
    expect(cRows[1]).toMatchObject({ target_ref: 'issue:ISS-2', cancelled_at: null });
    expect((await rowsOf(ws, d))[0].cancelled_at).not.toBeNull();
    const live = await store.listTargetSubscribers('object', 'issue:ISS-1');
    expect(live).toEqual([]);
  });

  test('the oracle sweep pages every context subscriber to exhaustion (page boundary N-1, N, N+1)', async () => {
    for (const total of [2, 3, 4]) {
      const ws = freshWs();
      const store = storeFor(ws);
      const ids = Array.from({ length: total }, (_, i) => su(100 + i));
      for (const id of ids) await contextFollow(store, id, 'issue:ISS-9', 1);
      const sweep = await sweepEndedSubscriberContexts({ store, pageSize: 3, endedAmong: async (page) => new Set(page) });
      expect(sweep.scanned).toBe(total);
      expect(sweep.ended).toBe(total);
      expect(await store.listTargetSubscribers('object', 'issue:ISS-9')).toEqual([]);
    }
  });

  test('a subscription cancelled between resolve and write is not delivered to', async () => {
    const ws = freshWs();
    const subscriptions = storeFor(ws);
    const stores = {
      subscriptions,
      tags: new PgTaggableStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: ws }),
      topics: new PgTopicStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: ws }),
    };
    const object: ObjectRef = { kind: 'issue', ref: 'ISS-7' };
    const [kept, ended] = [su(7), su(8)];
    await contextFollow(subscriptions, kept, 'issue:ISS-7', 1);
    await contextFollow(subscriptions, ended, 'issue:ISS-7', 1);
    const resolved = await resolveObjectSubscribers(object, stores);
    expect(resolved.map((r) => r.subscriber_id).sort()).toEqual([kept, ended].sort());

    await endSubscriberContexts(ended, 'session-end', { store: subscriptions });

    const written: string[] = [];
    const sink: InjectSink = { appendLine: async (_s, writerKey) => { written.push(writerKey); } };
    const ev: InjectEvent = { from: 'su-actor', subject: 'issue:ISS-7', summary: 'changed' } as InjectEvent;
    const n = await deliverInjectMany(resolved, ev, sink, (sub) => isResolvedSubscriberLive(subscriptions, object, sub));
    expect(n).toBe(1);
    expect(written).toEqual([kept]);

    // Control: without the delivery-time check the stale resolve would have written both.
    const unguarded: string[] = [];
    await deliverInjectMany(resolved, ev, { appendLine: async (_s, k) => { unguarded.push(k); } });
    expect(unguarded.sort()).toEqual([kept, ended].sort());
  });
});

describe('R-39: explicit and held-item follows survive every context end', () => {
  test('only their own explicit release removes them', async () => {
    const ws = freshWs();
    const store = storeFor(ws);
    const e = su(39);
    await store.subscribe({ subscriber_id: e, target_kind: 'object', target_ref: 'issue:X', created_ts: nowIso(), reason: 'explicit' });
    await store.subscribe({ subscriber_id: e, target_kind: 'object', target_ref: 'issue:Y', created_ts: nowIso(), reason: 'held_item' });
    await contextFollow(store, e, 'issue:Z', 1);
    // One row holding BOTH explicit and context: the context end must leave it active.
    await store.subscribe({ subscriber_id: e, target_kind: 'object', target_ref: 'issue:W', created_ts: nowIso(), reason: 'explicit' });
    await contextFollow(store, e, 'issue:W', 1);

    await endSubscriberContexts(e, 'session-end', { store });
    await sweepEndedSubscriberContexts({ store, endedAmong: async (ids) => new Set(ids) });
    await endSubscriberContexts(e, 'context-replaced', { store, beforeEpoch: 5 });

    let rows = await rowsOf(ws, e);
    const byRef = Object.fromEntries(rows.map((r) => [r.target_ref, r]));
    expect(byRef['issue:X'].cancelled_at).toBeNull();
    expect(byRef['issue:Y'].cancelled_at).toBeNull();
    expect(byRef['issue:W']).toMatchObject({ cancelled_at: null, reasons: ['explicit'] });
    expect(byRef['issue:Z'].cancel_reason).toBe('session-end');

    await store.unsubscribe(e, 'object', 'issue:X', 'explicit');
    await store.unsubscribe(e, 'object', 'issue:Y', 'held_item');
    rows = await rowsOf(ws, e);
    expect(rows.find((r) => r.target_ref === 'issue:X')?.cancelled_at).not.toBeNull();
    expect(rows.find((r) => r.target_ref === 'issue:Y')?.cancelled_at).not.toBeNull();
  });
});

describe('D-002: legacy dead-subscription cleanup', () => {
  test('snapshots then cancels only dead legacy rows, across bounded batches', async () => {
    const ws = freshWs();
    const deadA = su(201);
    const deadB = su(202);
    const recent = su(203);
    const live = su(204);
    const principal = `system:operator/s-1780000000000-${randomBytes(4).toString('hex')}`;
    const routine = 'system-other-family';
    const legacy = async (subscriber: string, ref: string) => sql`
      INSERT INTO harness_shared.coord_entity_subscriptions
        (workspace_id, subscriber_id, target_kind, target_ref, delivery_mode, created_at, reasons)
      VALUES (${ws}, ${subscriber}, 'object', ${ref}, 'full', now(), NULL)`;
    for (const [s, r] of [[deadA, 'issue:A1'], [deadA, 'issue:A2'], [deadB, 'issue:B1'], [recent, 'issue:R1'],
      [live, 'issue:L1'], [principal, 'issue:P1'], [routine, 'issue:Q1']] as const) await legacy(s, r);
    await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, ended_at) VALUES
      (${ws}, ${deadA}, now() - interval '10 days'), (${ws}, ${recent}, now() - interval '1 day'), (${ws}, ${live}, NULL)`;
    await sql`INSERT INTO harness_shared.coord_presence (workspace_id, owner_id) VALUES (${ws}, ${live})`;

    const dry = await cleanupLegacyDeadSubscriptions({ sql, workspaceId: ws, dryRun: true });
    expect(dry.cancelled).toBe(4);

    // Batch size 1, two batches per call: the work spans calls and none is skipped.
    const totals: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await cleanupLegacyDeadSubscriptions({ sql, workspaceId: ws, batchSize: 1, maxBatches: 2 });
      totals.push(r.cancelled);
      if (!r.more) break;
    }
    expect(totals.reduce((x, y) => x + y, 0)).toBe(4);

    const cancelled = await sql<{ subscriber_id: string; cancel_reason: string }[]>`
      SELECT subscriber_id, cancel_reason FROM harness_shared.coord_entity_subscriptions
       WHERE workspace_id = ${ws} AND cancelled_at IS NOT NULL ORDER BY subscriber_id, target_ref`;
    expect(cancelled.map((r) => [r.subscriber_id, r.cancel_reason]).sort()).toEqual([
      [deadA, 'cleanup:session-ended'], [deadA, 'cleanup:session-ended'], [deadB, 'cleanup:session-ended'],
      [principal, 'cleanup:machine-identity'],
    ].sort());
    const snaps = await sql<{ subscriber_id: string; row_data: { target_ref: string; cancelled_at: unknown } }[]>`
      SELECT subscriber_id, row_data FROM harness_shared.coord_entity_subscription_cleanup_snapshots
       WHERE workspace_id = ${ws} AND cleanup_run = ${LEGACY_CLEANUP_RUN}`;
    expect(snaps).toHaveLength(4);
    for (const s of snaps) expect(s.row_data.cancelled_at).toBeNull();

    const again = await cleanupLegacyDeadSubscriptions({ sql, workspaceId: ws });
    expect(again).toMatchObject({ cancelled: 0, more: false });
  });
});
