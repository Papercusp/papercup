/**
 * P-003 recurrence guard against real Postgres. Proves that canonical
 * work_items persistence, the partial unique identity index, and row locking
 * provide restart-safe receipts and exclusive execution leases.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { AdmissionIdempotencyConflictError, Governor } from './admission';
import { PgWorkItemAdmissionQueueStore, WorkItemAdmissionQueueDriver } from './queue';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(__dirname, '../../../../libs/papercusp/libs/db/sql/986-resource-governor-work-item-queue-identity.sql'),
  'utf8',
);

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('resource-governor-queue');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await db.sql.unsafe(migration).simple();
}, 60_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items`;
  await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
});

function instance(label: string, now = () => 10_000) {
  let requestNo = 0;
  let leaseNo = 0;
  const store = new PgWorkItemAdmissionQueueStore({ sql: db.sql, workspaceId: 'ws-governor' });
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'integration',
    now,
    leaseIdFactory: () => `${label}-lease-${++leaseNo}`,
  });
  return {
    store,
    driver,
    governor: new Governor(driver, { now, idFactory: () => `${label}-request-${++requestNo}` }),
  };
}

describe('PgWorkItemAdmissionQueueStore', () => {
  it('concurrent process instances converge on one durable receipt and reject conflicting replay', async () => {
    const a = instance('a');
    const b = instance('b');
    const input = {
      idempotencyKey: 'restart-safe',
      admissionClass: 'build',
      priority: 4,
      demand: { cpuWeight: 20, memoryBytes: 8_192 },
      payloadRef: 'work-item:WI-parent',
    } as const;

    const [left, right] = await Promise.all([a.governor.admit(input), b.governor.admit(input)]);
    expect(left).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1' } });
    expect(right).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1' } });

    const rows = await db.sql<
      Array<{ feature_id: string; status: string; taken_by: string | null; payload: Record<string, unknown> }>
    >`SELECT feature_id, status, taken_by, payload FROM harness_shared.work_items`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature_id: 'WI-1', status: 'open', taken_by: null });
    expect(rows[0].payload).toMatchObject({
      _claimHold: true,
      claim_hold_by: 'system:resource-governor',
      resource_governor: { idempotencyKey: 'restart-safe', state: 'queued' },
    });

    const restarted = instance('restart');
    await expect(restarted.governor.status('restart-safe')).resolves.toMatchObject({
      state: 'queued',
      receipt: { receiptId: 'WI-1' },
    });
    await expect(restarted.governor.admit({ ...input, priority: 5 })).rejects.toBeInstanceOf(
      AdmissionIdempotencyConflictError,
    );
  });

  it('uses canonical taken_by ownership so only one concurrent worker receives a lease', async () => {
    const producer = instance('producer');
    await producer.governor.admit({ idempotencyKey: 'once', admissionClass: 'process', priority: 2 });

    const a = instance('worker-a');
    const b = instance('worker-b');
    const claims = await Promise.all([
      a.driver.leaseNext({ owner: 'worker-a', ttlMs: 5_000 }),
      b.driver.leaseNext({ owner: 'worker-b', ttlMs: 5_000 }),
    ]);
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;

    const row = await db.sql<Array<{ taken_by: string | null; state: string }>>`
      SELECT taken_by, payload->'resource_governor'->>'state' AS state
        FROM harness_shared.work_items WHERE feature_id = ${winner.receiptId}`;
    expect(row[0]).toEqual({ taken_by: winner.lease.owner, state: 'leased' });

    expect((await a.driver.markRunning(winner.receiptId, 'stale-lease'))?.changed).toBe(false);
    const owner = winner.lease.owner === 'worker-a' ? a.driver : b.driver;
    expect((await owner.markRunning(winner.receiptId, winner.lease.leaseId))?.record.state).toBe('running');
    expect((await owner.complete(winner.receiptId, winner.lease.leaseId, 'result:durable'))?.record.state).toBe(
      'completed',
    );
    await expect(instance('reader').governor.status('once')).resolves.toMatchObject({
      state: 'completed',
      resultRef: 'result:durable',
    });
  });

  it('persists cancellation and latest-wins coalescing across driver restart', async () => {
    const first = instance('first');
    await first.governor.admit({
      idempotencyKey: 'old',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });
    await instance('second').governor.admit({
      idempotencyKey: 'new',
      admissionClass: 'indexing',
      coalesceKey: 'index:main',
    });

    const restarted = instance('restart');
    await expect(restarted.governor.status('old')).resolves.toMatchObject({ state: 'superseded' });
    await expect(restarted.governor.cancel('new', 'no longer needed')).resolves.toMatchObject({
      cancelled: true,
      state: 'cancelled',
    });
    await expect(instance('reader').governor.cancel('new')).resolves.toMatchObject({
      cancelled: false,
      state: 'cancelled',
    });
  });

  it('reclaims an expired lease, rejects its stale token, and expires overdue queued work', async () => {
    const clock = { now: 20_000 };
    const producer = instance('producer', () => clock.now);
    await producer.governor.admit({ idempotencyKey: 'lease-expiry', admissionClass: 'transfer' });

    const first = await producer.driver.leaseNext({ owner: 'worker-old', ttlMs: 100 });
    if (!first) throw new Error('expected first lease');
    clock.now += 101;

    const replacement = instance('replacement', () => clock.now);
    const second = await replacement.driver.leaseNext({ owner: 'worker-new', ttlMs: 100 });
    expect(second).toMatchObject({ receiptId: first.receiptId, lease: { owner: 'worker-new', generation: 3 } });
    expect((await producer.driver.markRunning(first.receiptId, first.lease.leaseId))?.changed).toBe(false);
    expect((await replacement.driver.markRunning(first.receiptId, second!.lease.leaseId))?.record.state).toBe(
      'running',
    );

    await producer.governor.admit({
      idempotencyKey: 'deadline',
      admissionClass: 'build',
      deadlineAtMs: clock.now + 10,
    });
    clock.now += 11;
    expect(await replacement.driver.leaseNext({ owner: 'worker-new', ttlMs: 100 })).toBeNull();
    await expect(instance('reader', () => clock.now).governor.status('deadline')).resolves.toMatchObject({
      state: 'expired',
    });
  });
});
