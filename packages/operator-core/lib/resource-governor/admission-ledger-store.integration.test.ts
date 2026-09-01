/** Real-PostgreSQL behavior coverage for the ledger-only admission store. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { Governor } from './admission';
import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import { WorkItemAdmissionQueueDriver } from './queue';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql'),
  'utf8',
);

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('resource-governor-ledger-store');
  await db.sql
    .unsafe(
      `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.operator_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      description text,
      updated_at bigint NOT NULL DEFAULT 0,
      workspace_id text
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      feature_id text NOT NULL,
      payload jsonb,
      PRIMARY KEY (workspace_id, feature_id)
    );
  `,
    )
    .simple();
  await db.sql.unsafe(MIGRATION).simple();
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`
    TRUNCATE harness_shared.resource_governor_admissions,
             harness_shared.operator_settings,
             harness_shared.work_items`;
});

function instance(
  label: string,
  options: {
    now?: () => number;
    workspaceId?: string;
    abandonAfterMs?: number;
  } = {},
) {
  let requestNo = 0;
  let leaseNo = 0;
  const now = options.now ?? (() => 10_000);
  const store = new PgAdmissionLedgerQueueStore({
    sql: db.sql,
    workspaceId: options.workspaceId ?? 'ws-ledger',
    ...(options.abandonAfterMs ? { abandonAfterMs: options.abandonAfterMs } : {}),
    resolveSessionStatesFn: (async (subjects: readonly { ownerId: string }[]) =>
      new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'live' as const }]))) as never,
  });
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'integration',
    now,
    leaseIdFactory: () => `${label}-lease-${++leaseNo}`,
  });
  return {
    store,
    driver,
    governor: new Governor(driver, {
      now,
      idFactory: () => `${label}-request-${++requestNo}`,
    }),
  };
}

describe('PgAdmissionLedgerQueueStore', () => {
  it('converges concurrent writers on one RG receipt and never creates a work item', async () => {
    const input = {
      idempotencyKey: 'restart-safe',
      admissionClass: 'build',
      priority: 4,
      demand: { cpuWeight: 20, memoryBytes: 8_192 },
    } as const;
    const [left, right] = await Promise.all([instance('a').governor.admit(input), instance('b').governor.admit(input)]);
    if (left.kind !== 'queued' || right.kind !== 'queued') throw new Error('expected queued receipts');

    expect(left.receipt.receiptId).toMatch(/^RG-/);
    expect(right.receipt.receiptId).toBe(left.receipt.receiptId);
    const [ledger, workItems, latch] = await Promise.all([
      db.sql<Array<{ receipt_id: string; state: string }>>`
        SELECT receipt_id, state
          FROM harness_shared.resource_governor_admissions
         WHERE workspace_id = 'ws-ledger'`,
      db.sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM harness_shared.work_items
         WHERE workspace_id = 'ws-ledger'`,
      db.sql<Array<{ value: string }>>`
        SELECT value
          FROM harness_shared.operator_settings
         WHERE key = 'resource_governor_admission_ledger_cutover:ws-ledger'`,
    ]);
    expect(ledger).toEqual([{ receipt_id: left.receipt.receiptId, state: 'queued' }]);
    expect(workItems[0]).toEqual({ count: 0 });
    expect(latch[0]).toEqual({ value: '1' });
  });

  it('preserves targeted lease CAS, running, completion, and restart status', async () => {
    const producer = instance('producer');
    const admitted = await producer.governor.admit({
      idempotencyKey: 'exactly-once',
      admissionClass: 'process',
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued receipt');

    const claim = await producer.driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'worker-a',
      ttlMs: 5_000,
    });
    if (!claim) throw new Error('expected targeted lease');

    expect((await producer.driver.markRunning(claim.receiptId, 'stale-token'))?.changed).toBe(false);
    expect((await producer.driver.markRunning(claim.receiptId, claim.lease.leaseId))?.record.state).toBe('running');
    const completed = await producer.driver.complete(claim.receiptId, claim.lease.leaseId, 'result:ledger');
    expect(completed?.record).toMatchObject({ state: 'completed', resultRef: 'result:ledger' });
    expect(completed?.record).not.toHaveProperty('lease');
    await expect(instance('restart').governor.status('exactly-once')).resolves.toMatchObject({
      state: 'completed',
      receipt: { receiptId: admitted.receipt.receiptId },
      resultRef: 'result:ledger',
    });
  });

  it('persists latest-wins coalescing and cancellation without work-item projections', async () => {
    await instance('old').governor.admit({
      idempotencyKey: 'old',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });
    await instance('new').governor.admit({
      idempotencyKey: 'new',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });

    const reader = instance('reader');
    await expect(reader.governor.status('old')).resolves.toMatchObject({ state: 'superseded' });
    await expect(reader.governor.cancel('new', 'no longer needed')).resolves.toMatchObject({
      cancelled: true,
      state: 'cancelled',
    });
    const rows = await db.sql<Array<{ idempotency_key: string; state: string }>>`
      SELECT idempotency_key, state
        FROM harness_shared.resource_governor_admissions
       ORDER BY idempotency_key`;
    expect(rows).toEqual([
      { idempotency_key: 'new', state: 'cancelled' },
      { idempotency_key: 'old', state: 'superseded' },
    ]);
  });

  it('reads one complete queue census from the ledger plus bounded legacy overlap', async () => {
    const clock = { now: 100_000 };
    const legacyRecord = {
      schemaVersion: 1,
      namespace: 'integration',
      idempotencyKey: 'legacy-active',
      requestFingerprint: 'legacy-fingerprint',
      admissionClass: 'process',
      state: 'queued',
      priority: 1,
      enqueuedAtMs: clock.now - 1_000,
      updatedAtMs: clock.now - 1_000,
      deadlineAtMs: null,
      decision: { generation: 0, atMs: clock.now - 1_000, reason: 'legacy-fixture' },
    };
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, payload)
      VALUES (
        'ws-ledger',
        'WI-legacy-active',
        ${JSON.stringify({ resource_governor: legacyRecord })}::text::jsonb
      )`;

    const current = instance('census', { now: () => clock.now });
    const active = await current.governor.admit({ idempotencyKey: 'ledger-active', admissionClass: 'agent' });
    const terminal = await current.governor.admit({ idempotencyKey: 'ledger-terminal', admissionClass: 'agent' });
    if (active.kind !== 'queued' || terminal.kind !== 'queued') throw new Error('expected ledger receipts');
    const claim = await current.driver.leaseReceipt({
      receiptId: terminal.receipt.receiptId,
      owner: 'census-worker',
      ttlMs: 1_000,
    });
    if (!claim) throw new Error('expected terminal fixture lease');
    await current.driver.complete(claim.receiptId, claim.lease.leaseId, 'result:census');

    await expect(current.store.readQueuePopulation(clock.now, 60_000)).resolves.toEqual([
      {
        admissionClass: 'agent',
        depth: 1,
        oldestAgeMs: 0,
        arrivals: 2,
        drained: 1,
        observedWindowMs: 60_000,
      },
      {
        admissionClass: 'process',
        depth: 1,
        oldestAgeMs: 1_000,
        arrivals: 1,
        drained: 0,
        observedWindowMs: 60_000,
      },
    ]);
  });

  it('reconciles lease expiry, deadlines, and deadline-less abandonment in bounded passes', async () => {
    const clock = { now: 20_000 };
    const primary = instance('primary', { now: () => clock.now });
    await primary.governor.admit({ idempotencyKey: 'lease', admissionClass: 'process' });
    const lease = await primary.driver.leaseNext({ owner: 'old-owner', ttlMs: 100 });
    if (!lease) throw new Error('expected lease');
    clock.now += 101;
    await expect(primary.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 1,
      expired: 0,
      abandoned: 0,
      total: 1,
    });
    expect((await primary.store.find('integration', 'lease'))?.record).toMatchObject({
      state: 'queued',
      decision: { reason: 'lease-expired' },
    });

    await primary.governor.admit({
      idempotencyKey: 'deadline',
      admissionClass: 'inference',
      deadlineAtMs: clock.now + 10,
    });
    clock.now += 11;
    await expect(primary.store.reconcileExpiredAll(clock.now)).resolves.toMatchObject({ expired: 1 });
    expect((await primary.store.find('integration', 'deadline'))?.record.state).toBe('expired');

    const abandoned = instance('abandoned', {
      now: () => clock.now,
      workspaceId: 'ws-abandon',
      abandonAfterMs: 100,
    });
    await abandoned.governor.admit({
      idempotencyKey: 'no-deadline',
      admissionClass: 'agent',
    });
    clock.now += 101;
    await expect(abandoned.store.reconcileExpiredAll(clock.now)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      abandoned: 1,
      total: 1,
    });
    expect((await abandoned.store.find('integration', 'no-deadline'))?.record).toMatchObject({
      state: 'expired',
      decision: { reason: 'abandoned-without-deadline' },
    });
  });
});
