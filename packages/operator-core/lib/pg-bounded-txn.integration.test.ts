/**
 * Real postgres.js cancellation coverage for boundedOrgTxn. A mocked cancel()
 * promise cannot reveal rejections from the driver's in-flight query object.
 *
 * Run: npx vitest run --config vitest.integration.config.ts lib/pg-bounded-txn.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { boundedOrgTxn, type BoundedOrgTxnOptions } from './pg-bounded-txn';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('boundedOrgTxn (real PostgreSQL cancellation)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('observes the canceled in-flight query and keeps the pool usable', async () => {
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });

    try {
      const transaction = boundedOrgTxn(async (tx) => {
        const query = tx.unsafe('SELECT pg_sleep(2)');
        queryStarted();
        await query;
      }, {
        client: db.adminSql as BoundedOrgTxnOptions['client'],
        signal: controller.signal,
        statementTimeoutMs: 10_000,
      });

      await started;
      // postgres.js queries are lazy; this allows the await above to submit it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error('test abort'));
      await expect(transaction).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(await db.adminSql`SELECT 1 AS n`).toEqual([{ n: 1 }]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 20_000);

  it('does not turn a composed SQL fragment into an unobserved query on abort', async () => {
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });

    try {
      const transaction = boundedOrgTxn(async (tx) => {
        const where = tx`WHERE true`;
        const query = tx`SELECT pg_sleep(2) ${where}`;
        queryStarted();
        await query;
      }, {
        client: db.adminSql as BoundedOrgTxnOptions['client'],
        signal: controller.signal,
        statementTimeoutMs: 10_000,
      });

      await started;
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error('test abort'));
      await expect(transaction).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(await db.adminSql`SELECT 1 AS n`).toEqual([{ n: 1 }]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 20_000);
});
