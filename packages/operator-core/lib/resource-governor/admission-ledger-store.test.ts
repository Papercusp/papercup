import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  defaultSql: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: mocks.defaultSql }),
}));
vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: mocks.transaction }));

import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import { PgAdmissionCutoverQueueStore } from './admission-cutover-store';
import { PgWorkItemAdmissionQueueStore } from './queue';
import {
  resetGovernedExecutionRuntimesForTests,
  setGovernedProcessClientFactoryForTests,
  withGovernedProcessRuntime,
} from './execution';

describe('admission ledger acquisition attribution', () => {
  it.each([
    ['pg_advisory_xact_lock', 'lock'],
    ['INSERT INTO harness_shared.operator_settings', 'cutover-latch'],
    ['SELECT value', 'cutover-latch'],
    ['SELECT receipt_id, record', 'find-identity'],
    ['legacy-identity', 'find-legacy-identity'],
    ['INSERT INTO harness_shared.resource_governor_admissions', 'insert'],
  ])('attributes an enqueue failure at %s to its internal phase', async (statement, phase) => {
    const failure = new Error('controlled enqueue failure');
    const sql = vi.fn((strings: TemplateStringsArray) => {
      const query = strings.join(' ');
      if (query.includes(statement)) throw failure;
      if (query.includes('SELECT value')) return Promise.resolve([{ value: '1' }]);
      if (query.includes('FOR UPDATE') && !query.includes('SELECT')) return 'FOR UPDATE';
      return Promise.resolve([]);
    });
    let phaseAtFailure: string | undefined;
    mocks.transaction.mockReset().mockImplementation(async (fn, options) => {
      try {
        return await fn(sql as never);
      } catch (error) {
        phaseAtFailure = options?.phase?.();
        throw error;
      }
    });
    const store = new PgAdmissionLedgerQueueStore({
      workspaceId: 'phase-test', sql: sql as never,
      legacyAdapter: {
        async findIdentity() {
          if (statement === 'legacy-identity') throw failure;
          return null;
        },
        async supersedeActiveCoalesce() {},
      },
    });

    await expect(store.enqueue({ namespace: 'integration', idempotencyKey: 'phase-test' } as never))
      .rejects.toBe(failure);
    expect(phaseAtFailure).toBe(`resource-governor.admission-ledger.enqueue.${phase}`);
  });

  it('labels a commit failure after a successful legacy replay separately from its identity read', async () => {
    const failure = new Error('controlled commit failure');
    const sql = vi.fn((strings: TemplateStringsArray) => Promise.resolve(
      strings.join(' ').includes('SELECT value') ? [{ value: '1' }] : [],
    ));
    let phaseAtFailure: string | undefined;
    mocks.transaction.mockReset().mockImplementation(async (fn, options) => {
      await fn(sql as never);
      phaseAtFailure = options?.phase?.();
      throw failure;
    });
    const store = new PgAdmissionLedgerQueueStore({
      workspaceId: 'phase-test', sql: sql as never,
      legacyAdapter: {
        async findIdentity() { return { receiptId: 'WI-legacy', record: {} } as never; },
        async supersedeActiveCoalesce() {},
      },
    });

    await expect(store.enqueue({ namespace: 'integration', idempotencyKey: 'phase-test' } as never))
      .rejects.toBe(failure);
    expect(phaseAtFailure).toBe('resource-governor.admission-ledger.enqueue.commit');
  });

  it('labels mark-running timeout phases at the exact ledger statement', async () => {
    const sql = vi.fn((strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT receipt_id, record')) {
        return Promise.resolve([{
          receipt_id: 'RG-phase-test',
          record: {
            schemaVersion: 1,
            namespace: 'integration',
            idempotencyKey: 'phase-test',
            requestFingerprint: 'fingerprint',
            admissionClass: 'process',
            priority: 0,
            deadlineAtMs: null,
            demand: {},
            payloadRef: null,
            coalesceKey: null,
            metadata: {},
            context: {},
            state: 'leased',
            enqueuedAtMs: 1,
            updatedAtMs: 1,
            decision: { generation: 1, atMs: 1, reason: 'leased', evidence: {} },
            lease: { leaseId: 'lease-1', owner: 'worker', generation: 1, expiresAtMs: 1000 },
          },
        }]);
      }
      if (statement.includes('UPDATE harness_shared.resource_governor_admissions')) {
        return Promise.reject(new Error('simulated update timeout'));
      }
      return 'FOR UPDATE';
    });
    let phaseAtFailure: string | undefined;
    mocks.transaction.mockReset().mockImplementation(async (fn, options) => {
      try {
        return await fn(sql as never);
      } catch (error) {
        phaseAtFailure = options?.phase?.();
        throw error;
      }
    });
    const store = new PgAdmissionLedgerQueueStore({ workspaceId: 'phase-test', sql: sql as never });

    await expect(store.markRunning('RG-phase-test', 'lease-1', 2)).rejects.toThrow('simulated update timeout');
    expect(phaseAtFailure).toBe('resource-governor.admission-ledger.mark-running.update');
  });

  it.each([
    [PgAdmissionLedgerQueueStore, false],
    [PgAdmissionLedgerQueueStore, true],
    [PgAdmissionCutoverQueueStore, false],
    [PgAdmissionCutoverQueueStore, true],
    [PgWorkItemAdmissionQueueStore, false],
    [PgWorkItemAdmissionQueueStore, true],
  ] as const)('tracks the default pool for %s (injected=%s)', async (Store, injected) => {
    const sql = vi.fn();
    const failure = new Error('stop before transaction body');
    mocks.transaction.mockReset().mockRejectedValue(failure);
    const store = new Store({
      workspaceId: 'acquisition-test',
      ...(injected ? { sql: sql as never } : {}),
    });
    await expect(store.enqueue({} as never)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      client: injected ? sql : mocks.defaultSql,
      acquirePool: injected ? undefined : 'org-admin',
    }));
  });

  it.each([
    PgAdmissionLedgerQueueStore,
    PgAdmissionCutoverQueueStore,
    PgWorkItemAdmissionQueueStore,
  ])('preserves explicit acquisition attribution through %s', async (Store) => {
    const sql = vi.fn();
    const failure = new Error('stop before transaction body');
    mocks.transaction.mockReset().mockRejectedValue(failure);
    const store = new Store({
      workspaceId: 'acquisition-test',
      sql: sql as never,
      acquirePool: 'registered-test-pool',
    });
    await expect(store.enqueue({} as never)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      client: sql,
      acquirePool: 'registered-test-pool',
    }));
  });

  it('attributes process-runtime admission transactions to the registered dedicated pool', async () => {
    resetGovernedExecutionRuntimesForTests();
    const sql = vi.fn() as never;
    const failure = new Error('stop before transaction body');
    mocks.transaction.mockReset().mockRejectedValue(failure);
    setGovernedProcessClientFactoryForTests(() => ({ sql, async end() {} }));

    try {
      await expect(withGovernedProcessRuntime('acquisition-test', 'governed-process', async ({ driver }) => {
        const store = (driver as unknown as { store: PgAdmissionCutoverQueueStore }).store;
        await store.enqueue({} as never);
      })).rejects.toBe(failure);

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
        client: sql,
        acquirePool: 'org-admin-governed-process',
      }));
    } finally {
      resetGovernedExecutionRuntimesForTests();
      setGovernedProcessClientFactoryForTests(null);
    }
  });
});
