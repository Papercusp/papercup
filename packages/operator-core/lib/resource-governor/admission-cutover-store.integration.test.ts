/** Real-PostgreSQL coverage for the bounded ledger/work-item rolling cutover. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { Governor } from './admission';
import { PgAdmissionCutoverQueueStore } from './admission-cutover-store';
import { PgWorkItemAdmissionQueueStore, WorkItemAdmissionQueueDriver } from './queue';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql'),
  'utf8',
);

const WORKSPACE = 'ws-cutover';
const NAMESPACE = 'cutover-integration';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('resource-governor-admission-cutover');
  await db.sql
    .unsafe(
      `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE SEQUENCE harness_shared.work_item_seq;
    CREATE OR REPLACE FUNCTION harness_shared.next_work_item_id()
    RETURNS text
    LANGUAGE sql
    AS $function$
      SELECT 'WI-' || nextval('harness_shared.work_item_seq')::text
    $function$;
    CREATE TABLE harness_shared.operator_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      description text,
      updated_at bigint NOT NULL DEFAULT 0,
      workspace_id text
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL DEFAULT '',
      feature_id text NOT NULL,
      title text,
      summary text,
      status text,
      attempts integer NOT NULL DEFAULT 0,
      item_kind text,
      payload jsonb,
      taken_by text,
      taken_at timestamptz,
      origin text,
      ts bigint,
      created_ts bigint NOT NULL,
      updated_ts bigint NOT NULL,
      needs_design boolean NOT NULL DEFAULT false,
      needs_human_review boolean NOT NULL DEFAULT false,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
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
  await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
});

const resolveLive = (async (subjects: readonly { ownerId: string }[]) =>
  new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'live' as const }]))) as never;

function runtime(
  kind: 'legacy' | 'cutover',
  label: string,
  options: {
    now?: () => number;
    resolveSessionStatesFn?: unknown;
  } = {},
) {
  let requestNo = 0;
  let leaseNo = 0;
  const now = options.now ?? (() => 10_000);
  const shared = {
    sql: db.sql,
    workspaceId: WORKSPACE,
    resolveSessionStatesFn: (options.resolveSessionStatesFn ?? resolveLive) as never,
  };
  const store =
    kind === 'legacy' ? new PgWorkItemAdmissionQueueStore(shared) : new PgAdmissionCutoverQueueStore(shared);
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: NAMESPACE,
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

describe('PgAdmissionCutoverQueueStore', () => {
  it('resumes and exactly settles a pre-cutover WI receipt, then writes only RG receipts', async () => {
    const legacy = runtime('legacy', 'old');
    const prior = await legacy.governor.admit({
      idempotencyKey: 'already-live',
      admissionClass: 'process',
    });
    if (prior.kind !== 'queued') throw new Error('expected a queued legacy receipt');
    expect(prior.receipt.receiptId).toMatch(/^WI-/);

    const modern = runtime('cutover', 'modern');
    const resumed = await modern.governor.admit({
      idempotencyKey: 'already-live',
      admissionClass: 'process',
    });
    if (resumed.kind !== 'queued') throw new Error('expected the pre-cutover receipt');
    expect(resumed.receipt.receiptId).toBe(prior.receipt.receiptId);

    const claim = await modern.driver.leaseReceipt({
      receiptId: resumed.receipt.receiptId,
      owner: 'owner-a',
      ttlMs: 5_000,
    });
    if (!claim) throw new Error('expected the legacy receipt to remain leaseable');
    expect((await modern.driver.markRunning(claim.receiptId, claim.lease.leaseId))?.changed).toBe(true);
    expect((await modern.driver.complete(claim.receiptId, claim.lease.leaseId, 'result:legacy'))?.changed).toBe(true);

    await expect(
      runtime('legacy', 'stale-binary').governor.admit({
        idempotencyKey: 'post-latch-old-writer',
        admissionClass: 'process',
      }),
    ).rejects.toThrow(/legacy work_items receipt insertion is disabled|post.cutover.guard/i);

    const fresh = await modern.governor.admit({
      idempotencyKey: 'ledger-only',
      admissionClass: 'agent',
    });
    if (fresh.kind !== 'queued') throw new Error('expected a new ledger receipt');
    expect(fresh.receipt.receiptId).toMatch(/^RG-/);

    const rows = await db.sql<Array<{ feature_id: string; state: string }>>`
      SELECT feature_id, payload->'resource_governor'->>'state' AS state
        FROM harness_shared.work_items
       WHERE workspace_id = ${WORKSPACE}`;
    expect(rows).toEqual([{ feature_id: prior.receipt.receiptId, state: 'completed' }]);
    await expect((modern.store as PgAdmissionCutoverQueueStore).readCutoverCensus()).resolves.toMatchObject({
      cutoverLatched: true,
      ledgerTotal: 1,
      ledgerActive: 1,
      legacyTotal: 1,
      legacyActive: 0,
      legacyTerminal: 1,
      legacyCreatedAfterCutover: 0,
      terminalLegacyDeletionReady: true,
    });
  });

  it('serializes an old/new identity race to exactly one durable receipt', async () => {
    const input = {
      idempotencyKey: 'cross-version-race',
      admissionClass: 'embedding',
    } as const;
    const [oldResult, modernResult] = await Promise.allSettled([
      runtime('legacy', 'old-racer').governor.admit(input),
      runtime('cutover', 'modern-racer').governor.admit(input),
    ]);
    expect(modernResult.status).toBe('fulfilled');

    const counts = await db.sql<Array<{ ledger: number; legacy: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.resource_governor_admissions) AS ledger,
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE payload ? 'resource_governor') AS legacy`;
    expect((counts[0]?.ledger ?? 0) + (counts[0]?.legacy ?? 0)).toBe(1);

    if (oldResult.status === 'fulfilled' && modernResult.status === 'fulfilled') {
      if (oldResult.value.kind !== 'queued' || modernResult.value.kind !== 'queued') {
        throw new Error('expected queued race outcomes');
      }
      expect(modernResult.value.receipt.receiptId).toBe(oldResult.value.receipt.receiptId);
      expect(modernResult.value.receipt.receiptId).toMatch(/^WI-/);
    } else if (oldResult.status === 'rejected') {
      expect(String(oldResult.reason)).toMatch(/cutover|legacy work_items receipt insertion is disabled/i);
      expect(counts[0]).toEqual({ ledger: 1, legacy: 0 });
    } else {
      throw new Error('the modern cutover writer must always converge or create the receipt');
    }
  });

  it('supersedes an active legacy coalesce peer in the same ledger enqueue transaction', async () => {
    const legacy = runtime('legacy', 'old-coalesce');
    const old = await legacy.governor.admit({
      idempotencyKey: 'old-index',
      admissionClass: 'embedding',
      coalesceKey: 'index:main',
    });
    if (old.kind !== 'queued') throw new Error('expected queued legacy receipt');

    const modern = runtime('cutover', 'new-coalesce');
    const replacement = await modern.governor.admit({
      idempotencyKey: 'new-index',
      admissionClass: 'embedding',
      coalesceKey: 'index:main',
    });
    if (replacement.kind !== 'queued') throw new Error('expected queued ledger receipt');
    expect(replacement.receipt.receiptId).toMatch(/^RG-/);

    await expect(modern.governor.status('old-index')).resolves.toMatchObject({ state: 'superseded' });
    await expect(modern.governor.status('new-index')).resolves.toMatchObject({
      state: 'queued',
      receipt: { receiptId: replacement.receipt.receiptId },
    });
  });

  it('fails closed when one identity exists in both persistence stores', async () => {
    const legacy = runtime('legacy', 'duplicate-source');
    await legacy.governor.admit({
      idempotencyKey: 'contradictory',
      admissionClass: 'process',
    });
    const records = await db.sql<Array<{ record: unknown }>>`
      SELECT payload->'resource_governor' AS record
        FROM harness_shared.work_items
       WHERE workspace_id = ${WORKSPACE}`;
    await db.sql`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
      VALUES (${WORKSPACE}, ${JSON.stringify(records[0]?.record)}::text::jsonb)`;

    const modern = runtime('cutover', 'duplicate-reader');
    await expect(modern.governor.status('contradictory')).rejects.toThrow(/exists in both/i);
    await expect(
      modern.governor.admit({
        idempotencyKey: 'contradictory',
        admissionClass: 'process',
      }),
    ).rejects.toThrow(/exists in both/i);
  });

  it('reclaims an explicitly ended ledger owner but preserves a lease renewed after the liveness read', async () => {
    const clock = { now: 50_000 };
    const resolveEnded = (async (subjects: readonly { ownerId: string }[]) =>
      new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'ended' as const }]))) as never;
    const ended = runtime('cutover', 'ended-owner', {
      now: () => clock.now,
      resolveSessionStatesFn: resolveEnded,
    });
    const admitted = await ended.governor.admit({
      idempotencyKey: 'ended-owner',
      admissionClass: 'agent',
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued ledger receipt');
    const claim = await ended.driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'owner-ended',
      ttlMs: 10_000,
    });
    if (!claim) throw new Error('expected ledger lease');
    await ended.driver.markRunning(claim.receiptId, claim.lease.leaseId);
    await expect(ended.store.reconcileExpired?.(NAMESPACE, clock.now)).resolves.toMatchObject({
      requeued: 1,
      total: 1,
    });
    await expect(ended.governor.status('ended-owner')).resolves.toMatchObject({
      state: 'queued',
      receipt: { receiptId: admitted.receipt.receiptId },
    });

    let staleReceiptId = '';
    const resolveAfterRenewal = (async (subjects: readonly { ownerId: string }[]) => {
      const rows = await db.sql<Array<{ record: Record<string, unknown> }>>`
        SELECT record
          FROM harness_shared.resource_governor_admissions
         WHERE workspace_id = ${WORKSPACE}
           AND receipt_id = ${staleReceiptId}`;
      const record = rows[0]?.record;
      if (!record) throw new Error('expected the stale-verdict control receipt');
      const renewed = {
        ...record,
        updatedAtMs: clock.now + 1,
        lease: {
          leaseId: 'renewed-lease',
          owner: 'owner-renewed',
          generation: 99,
          expiresAtMs: clock.now + 20_000,
        },
      };
      await db.sql`
        UPDATE harness_shared.resource_governor_admissions
           SET record = ${JSON.stringify(renewed)}::text::jsonb
         WHERE workspace_id = ${WORKSPACE}
           AND receipt_id = ${staleReceiptId}`;
      return new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'ended' as const }]));
    }) as never;
    const stale = runtime('cutover', 'stale-verdict', {
      now: () => clock.now,
      resolveSessionStatesFn: resolveAfterRenewal,
    });
    const staleAdmitted = await stale.governor.admit({
      idempotencyKey: 'stale-verdict',
      admissionClass: 'process',
    });
    if (staleAdmitted.kind !== 'queued') throw new Error('expected queued stale-verdict receipt');
    staleReceiptId = staleAdmitted.receipt.receiptId;
    const staleClaim = await stale.driver.leaseReceipt({
      receiptId: staleReceiptId,
      owner: 'owner-original',
      ttlMs: 10_000,
    });
    if (!staleClaim) throw new Error('expected stale-verdict ledger lease');
    await stale.driver.markRunning(staleClaim.receiptId, staleClaim.lease.leaseId);

    await expect(stale.store.reconcileExpired?.(NAMESPACE, clock.now)).resolves.toMatchObject({
      requeued: 0,
      total: 0,
    });
    const rows = await db.sql<Array<{ state: string; lease_id: string; owner: string }>>`
      SELECT state,
             record->'lease'->>'leaseId' AS lease_id,
             lease_owner AS owner
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${WORKSPACE}
         AND receipt_id = ${staleReceiptId}`;
    expect(rows[0]).toEqual({ state: 'running', lease_id: 'renewed-lease', owner: 'owner-renewed' });
  });
});
