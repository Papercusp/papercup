import { describe, expect, it } from 'vitest';
import {
  AdmissionIdempotencyConflictError,
  AdmissionPersistenceError,
  Governor,
  type AdmissionContext,
} from './admission';
import {
  PgWorkItemAdmissionQueueStore,
  WorkItemAdmissionQueueDriver,
  type DurableAdmissionQueueStore,
  type DurableAdmissionRecord,
  type QueueMutationResult,
  type QueueReconciliationResult,
  type StoredAdmissionRecord,
} from './queue';

class MemoryQueueStore implements DurableAdmissionQueueStore {
  private seq = 0;
  private readonly rows = new Map<string, StoredAdmissionRecord>();
  failEnqueue = false;
  /** Optional concrete fault to throw instead of the generic one, so tests can inject a pg-shaped error. */
  enqueueError: unknown;
  /** EI-21863356544930781: fail the next N enqueues, then succeed — a TRANSIENT fault, so a test
   *  can tell "rode out the dip and persisted" apart from "never failed in the first place". */
  failEnqueueTimes = 0;
  /** Every enqueue attempt, so a test can assert a non-retryable fault was tried exactly ONCE. */
  enqueueAttempts = 0;

  get size(): number {
    return this.rows.size;
  }

  private key(namespace: string, idempotencyKey: string): string {
    return `${namespace}\u0000${idempotencyKey}`;
  }

  private byReceipt(receiptId: string): StoredAdmissionRecord | null {
    return [...this.rows.values()].find((row) => row.receiptId === receiptId) ?? null;
  }

  private replace(stored: StoredAdmissionRecord, record: DurableAdmissionRecord): StoredAdmissionRecord {
    const next = { receiptId: stored.receiptId, record };
    this.rows.set(this.key(record.namespace, record.idempotencyKey), next);
    return next;
  }

  async enqueue(record: DurableAdmissionRecord) {
    this.enqueueAttempts += 1;
    if (this.failEnqueueTimes > 0) {
      this.failEnqueueTimes -= 1;
      throw this.enqueueError ?? new Error('database unavailable');
    }
    if (this.failEnqueue) throw this.enqueueError ?? new Error('database unavailable');
    const key = this.key(record.namespace, record.idempotencyKey);
    const existing = this.rows.get(key);
    if (existing) return { ...existing, created: false };
    if (record.coalesceKey) {
      for (const row of this.rows.values()) {
        if (
          row.record.namespace === record.namespace &&
          row.record.coalesceKey === record.coalesceKey &&
          ['queued', 'eligible', 'leased', 'running'].includes(row.record.state)
        ) {
          this.replace(row, {
            ...row.record,
            state: 'superseded',
            updatedAtMs: record.enqueuedAtMs,
            decision: {
              generation: row.record.decision.generation + 1,
              atMs: record.enqueuedAtMs,
              reason: 'coalesced-by-newer-request',
              evidence: { idempotencyKey: record.idempotencyKey },
            },
            lease: undefined,
          });
        }
      }
    }
    const stored = { receiptId: `WI-${++this.seq}`, record };
    this.rows.set(key, stored);
    return { ...stored, created: true };
  }

  async find(namespace: string, idempotencyKey: string) {
    return this.rows.get(this.key(namespace, idempotencyKey)) ?? null;
  }

  async cancel(namespace: string, idempotencyKey: string, reason: string | undefined, nowMs: number) {
    const stored = await this.find(namespace, idempotencyKey);
    if (!stored) return null;
    if (!['queued', 'eligible', 'leased', 'running'].includes(stored.record.state)) {
      return { ...stored, changed: false };
    }
    const next = this.replace(stored, {
      ...stored.record,
      state: 'cancelled',
      updatedAtMs: nowMs,
      decision: {
        generation: stored.record.decision.generation + 1,
        atMs: nowMs,
        reason: 'cancelled',
        evidence: reason ? { reason } : {},
      },
      lease: undefined,
      ...(reason ? { cancellationReason: reason } : {}),
    });
    return { ...next, changed: true };
  }

  async leaseNext(namespace: string, owner: string, leaseId: string, ttlMs: number, nowMs: number) {
    const stored = [...this.rows.values()]
      .filter((row) => row.record.namespace === namespace && ['queued', 'eligible'].includes(row.record.state))
      .sort((a, b) => b.record.priority - a.record.priority || a.record.enqueuedAtMs - b.record.enqueuedAtMs)[0];
    if (!stored) return null;
    const generation = stored.record.decision.generation + 1;
    const next = this.replace(stored, {
      ...stored.record,
      state: 'leased',
      updatedAtMs: nowMs,
      decision: { generation, atMs: nowMs, reason: 'leased', evidence: { owner } },
      lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
    });
    return { ...next, changed: true };
  }

  /** Target one already-persisted receipt during observe-only migration.
   *  Mirrors leaseNext, but selects by receiptId instead of queue order. */
  async leaseReceipt(
    namespace: string,
    receiptId: string,
    owner: string,
    leaseId: string,
    ttlMs: number,
    nowMs: number,
  ) {
    const stored = this.byReceipt(receiptId);
    if (!stored || stored.record.namespace !== namespace) return null;
    if (!['queued', 'eligible'].includes(stored.record.state)) return { ...stored, changed: false };
    const generation = stored.record.decision.generation + 1;
    const next = this.replace(stored, {
      ...stored.record,
      state: 'leased',
      updatedAtMs: nowMs,
      decision: { generation, atMs: nowMs, reason: 'leased', evidence: { owner } },
      lease: { leaseId, owner, generation, expiresAtMs: nowMs + ttlMs },
    });
    return { ...next, changed: true };
  }

  private leaseMutation(
    receiptId: string,
    leaseId: string,
    mutate: (record: DurableAdmissionRecord) => DurableAdmissionRecord,
  ): QueueMutationResult | null {
    const stored = this.byReceipt(receiptId);
    if (!stored) return null;
    if (stored.record.lease?.leaseId !== leaseId) return { ...stored, changed: false };
    return { ...this.replace(stored, mutate(stored.record)), changed: true };
  }

  async markRunning(receiptId: string, leaseId: string, nowMs: number) {
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'running',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'execution-started',
        evidence: {},
      },
    }));
  }

  async complete(receiptId: string, leaseId: string, resultRef: string | undefined, nowMs: number) {
    const evidence: Readonly<Record<string, string>> = resultRef ? { resultRef } : {};
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'execution-completed',
        evidence,
      },
      lease: undefined,
      ...(resultRef ? { resultRef } : {}),
    }));
  }

  async releaseLease(receiptId: string, leaseId: string, nowMs: number) {
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'queued',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'lease-released',
        evidence: {},
      },
      lease: undefined,
    }));
  }

  async releaseClaim(
    receiptId: string,
    leaseId: string,
    actualDemand: DurableAdmissionRecord['demand'] | undefined,
    nowMs: number,
  ) {
    return this.leaseMutation(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: {
        generation: record.decision.generation + 1,
        atMs: nowMs,
        reason: 'resources-released',
        evidence: { actualDemandReported: actualDemand !== undefined },
      },
      lease: undefined,
      ...(actualDemand ? { actualDemand } : {}),
      releasedAtMs: nowMs,
    }));
  }

  async supersede(receiptId: string, replacementReceiptId: string, nowMs: number) {
    const stored = this.byReceipt(receiptId);
    if (!stored) return null;
    if (!['queued', 'eligible', 'leased', 'running'].includes(stored.record.state)) {
      return { ...stored, changed: false };
    }
    const next = this.replace(stored, {
      ...stored.record,
      state: 'superseded',
      updatedAtMs: nowMs,
      decision: {
        generation: stored.record.decision.generation + 1,
        atMs: nowMs,
        reason: 'superseded',
        evidence: { replacementReceiptId },
      },
      lease: undefined,
      supersededByReceiptId: replacementReceiptId,
    });
    return { ...next, changed: true };
  }
}

function governor(
  store: DurableAdmissionQueueStore,
  now = () => 1_000,
  // EI-21863356544930781: lets a retry test collapse the real ~6s of backoff to nothing.
  driverOptions: { admissionRetryBackoffsMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
) {
  let request = 0;
  let lease = 0;
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'test',
    now,
    leaseIdFactory: () => `lease-${++lease}`,
    ...driverOptions,
  });
  return {
    driver,
    governor: new Governor(driver, { now, idFactory: () => `request-${++request}` }),
  };
}

function recordingSqlClient() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values });
    return Promise.resolve([] as unknown[]);
  };
  const client = {
    begin: async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx),
  } as never;
  return { client, queries };
}

describe('WorkItemAdmissionQueueDriver', () => {
  it('bounds PostgreSQL queue mutations with database-side lock and statement timeouts', async () => {
    const { client, queries } = recordingSqlClient();
    const store = new PgWorkItemAdmissionQueueStore({
      sql: client,
      workspaceId: 'workspace-test',
    });

    await expect(store.reconcileExpired('test', 1_000)).resolves.toEqual({
      requeued: 0,
      expired: 0,
      total: 0,
    });

    const timeoutQueries = queries.filter((query) => query.text.includes('SELECT set_config'));
    expect(timeoutQueries).toHaveLength(2);
    expect(timeoutQueries[0]).toMatchObject({
      text: "SELECT set_config('lock_timeout', ?, true)",
      values: ['8000ms'],
    });
    expect(timeoutQueries[1]).toMatchObject({
      text: "SELECT set_config('statement_timeout', ?, true)",
      values: ['15000ms'],
    });
  });

  it('returns one stable durable receipt across process restart and rejects conflicting replay', async () => {
    const store = new MemoryQueueStore();
    const first = governor(store).governor;
    const restarted = governor(store).governor;
    const request = {
      idempotencyKey: 'same',
      admissionClass: 'build',
      demand: { memoryBytes: 4_096 },
      payloadRef: 'work-item:WI-source',
    } as const;

    const a = await first.admit(request);
    const b = await restarted.admit(request);
    expect(a).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1', state: 'queued' } });
    expect(b).toMatchObject({ kind: 'queued', receipt: { receiptId: 'WI-1', state: 'queued' } });
    expect(store.size).toBe(1);

    await expect(restarted.admit({ ...request, priority: 9 })).rejects.toBeInstanceOf(
      AdmissionIdempotencyConflictError,
    );
  });

  it('never returns a receipt when durable persistence fails', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    await expect(
      governor(store).governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' }),
    ).rejects.toBeInstanceOf(AdmissionPersistenceError);
    expect(store.size).toBe(0);
  });

  // Regression: the wrapper used to carry a CONSTANT message and keep the real fault only on
  // `.cause`, which is not serialised to MCP callers. Every distinct DB fault therefore reached an
  // agent as the same undiagnosable sentence. Observed 2026-08-27: capability:launch-agent failed
  // 4/4 with only "durable admission record could not be persisted", costing hours of blind
  // hypothesis-elimination because the actual SQLSTATE was never visible.
  it('surfaces the underlying fault in the thrown message, not just on .cause', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = new Error('relation "harness_shared.work_items" does not exist');

    const error = await governor(store)
      .governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' })
      .then(
        () => null,
        (thrown: unknown) => thrown as AdmissionPersistenceError,
      );

    expect(error).toBeInstanceOf(AdmissionPersistenceError);
    expect(error?.message).toContain('relation "harness_shared.work_items" does not exist');
    // The constant prefix alone must never be the whole message again.
    expect(error?.message).not.toBe('durable admission record could not be persisted');
    expect((error?.cause as Error | undefined)?.message).toBe(
      'relation "harness_shared.work_items" does not exist',
    );
  });

  // EI-21863356544930781: a transient pg contention timeout (55P03) on the admission write used to
  // cost the caller the whole run. Reproduced as two consecutive testing:run calls failing with
  // "durable admission record could not be persisted ... sqlstate=55P03" while the SAME tests ran
  // fine via npm immediately after — the tests were runnable throughout; only the bookkeeping
  // write lost its lock race. Admission is PRE-execution, so the fix is a bounded retry, not
  // best-effort recording.
  const contentionError = () =>
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

  const noSleep = { admissionRetryBackoffsMs: [1, 1, 1] as const, sleep: async () => {} };

  it('rides out a transient pg contention timeout on the admission write and still persists', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueueTimes = 2; // fails twice, then succeeds — the contention dip clears
    store.enqueueError = contentionError();

    const outcome = await governor(store, () => 1_000, noSleep).governor.admit({
      idempotencyKey: 'rides-out',
      admissionClass: 'mcp',
    });

    expect(outcome.kind).toBe('queued');
    expect(store.size).toBe(1);
    expect(store.enqueueAttempts).toBe(3); // two failures + the successful write
  });

  /**
   * NEGATIVE CONTROL. Without this, the test above would still pass if the retry were
   * unconditional — which would be a real defect: a genuine fault (missing relation, DB down,
   * a bug) must surface on the FIRST attempt, not after burning the backoff budget. Asserting
   * the attempt COUNT is the part that discriminates; asserting only that it threw would not.
   */
  it('does NOT retry a non-contention fault — it surfaces on the first attempt', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = Object.assign(
      new Error('relation "harness_shared.work_items" does not exist'),
      { code: '42P01' },
    );

    await expect(
      governor(store, () => 1_000, noSleep).governor.admit({
        idempotencyKey: 'real-fault',
        admissionClass: 'mcp',
      }),
    ).rejects.toBeInstanceOf(AdmissionPersistenceError);

    expect(store.enqueueAttempts).toBe(1);
  });

  it('says the retries are spent when contention never clears, so a caller does not just retry again', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true; // contention that never clears
    store.enqueueError = contentionError();

    const error = await governor(store, () => 1_000, noSleep)
      .governor.admit({ idempotencyKey: 'never-clears', admissionClass: 'mcp' })
      .then(
        () => null,
        (thrown: unknown) => thrown as AdmissionPersistenceError,
      );

    expect(error).toBeInstanceOf(AdmissionPersistenceError);
    expect(error?.message).toContain('after 4 attempts');
    expect(error?.message).toContain('sqlstate=55P03');
    expect(store.enqueueAttempts).toBe(4); // initial + 3 backoffs
  });

  it('includes postgres diagnostic fields when the fault is a pg error', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = Object.assign(new Error('new row violates check constraint'), {
      code: '23514',
      constraint: 'work_items_status_check',
      schema: 'harness_shared',
      table: 'work_items',
    });

    const error = await governor(store)
      .governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' })
      .then(
        () => null,
        (thrown: unknown) => thrown as AdmissionPersistenceError,
      );

    expect(error?.message).toContain('sqlstate=23514');
    expect(error?.message).toContain('constraint=work_items_status_check');
    expect(error?.message).toContain('relation=harness_shared.work_items');
  });

  it('does not throw while describing a non-Error rejection', async () => {
    const store = new MemoryQueueStore();
    store.failEnqueue = true;
    store.enqueueError = 'connection terminated unexpectedly';

    await expect(
      governor(store).governor.admit({ idempotencyKey: 'lost', admissionClass: 'mcp' }),
    ).rejects.toThrow(/connection terminated unexpectedly/);
  });

  it('leases once, rejects a stale lease, and exposes the durable result', async () => {
    const clock = { now: 10_000 };
    const store = new MemoryQueueStore();
    const { governor: api, driver } = governor(store, () => clock.now);
    await api.admit({ idempotencyKey: 'run', admissionClass: 'process', priority: 2 });

    const [won, lost] = await Promise.all([
      driver.leaseNext({ owner: 'worker-a', ttlMs: 1_000 }),
      driver.leaseNext({ owner: 'worker-b', ttlMs: 1_000 }),
    ]);
    expect([won, lost].filter(Boolean)).toHaveLength(1);
    const claim = won ?? lost;
    if (!claim) throw new Error('expected a lease');
    expect(claim.lease.owner).toMatch(/^worker-/);

    expect((await driver.markRunning(claim.receiptId, 'stale'))?.changed).toBe(false);
    expect((await driver.markRunning(claim.receiptId, claim.lease.leaseId))?.record.state).toBe('running');
    expect((await driver.complete(claim.receiptId, claim.lease.leaseId, 'result:42'))?.record.state).toBe('completed');
    await expect(api.status('run')).resolves.toMatchObject({ state: 'completed', resultRef: 'result:42' });
  });

  it('cancels idempotently and coalesces an older active receipt', async () => {
    const store = new MemoryQueueStore();
    const { governor: api } = governor(store);
    const old = await api.admit({ idempotencyKey: 'old', admissionClass: 'indexing', coalesceKey: 'index:main' });
    await api.admit({ idempotencyKey: 'new', admissionClass: 'indexing', coalesceKey: 'index:main' });
    expect(await api.status('old')).toMatchObject({ state: 'superseded' });
    expect(await api.cancel('new', 'operator stopped it')).toMatchObject({ cancelled: true, state: 'cancelled' });
    expect(await api.cancel('new')).toMatchObject({ cancelled: false, state: 'cancelled' });
    expect((old as { context: AdmissionContext }).context.rootRequestId).toBeTruthy();
  });

  it('propagates receipt lineage and records exact actual-cost release once', async () => {
    const clock = { now: 1_000 };
    const store = new MemoryQueueStore();
    const feedback: unknown[] = [];
    let request = 0;
    let lease = 0;
    const driver = new WorkItemAdmissionQueueDriver(store, {
      namespace: 'test',
      now: () => clock.now,
      leaseIdFactory: () => `lease-${++lease}`,
      onActualDemand: (input) => void feedback.push(input),
    });
    const api = new Governor(driver, { now: () => clock.now, idFactory: () => `request-${++request}` });

    const parent = await api.admit({ idempotencyKey: 'parent', admissionClass: 'agent', demand: { cpuWeight: 2 } });
    const child = await api.admit({
      idempotencyKey: 'child',
      admissionClass: 'database',
      demand: { databaseConnections: 1 },
      parent: parent.context,
    });
    expect(parent.context).toMatchObject({ receiptId: 'WI-1', rootRequestId: 'request-1' });
    expect(child.context).toMatchObject({
      receiptId: 'WI-2',
      parentReceiptId: 'WI-1',
      parentRequestId: 'request-1',
      rootRequestId: 'request-1',
      demand: { databaseConnections: 1 },
    });

    const parentClaim = await driver.leaseNext({ owner: 'worker', ttlMs: 1_000 });
    const childClaim = await driver.leaseNext({ owner: 'worker', ttlMs: 1_000 });
    const claim = [parentClaim, childClaim].find((item) => item?.record.idempotencyKey === 'child');
    if (!claim) throw new Error('expected child lease');
    clock.now = 1_100;
    await expect(api.release(claim.context, { databaseConnections: 2 })).resolves.toEqual({
      requestId: 'request-2',
      released: true,
    });
    await expect(api.release(claim.context, { databaseConnections: 3 })).resolves.toEqual({
      requestId: 'request-2',
      released: false,
    });
    await expect(api.status('child')).resolves.toMatchObject({
      state: 'completed',
      context: { receiptId: 'WI-2', parentReceiptId: 'WI-1', rootRequestId: 'request-1' },
    });
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      receiptId: 'WI-2',
      plannedDemand: { databaseConnections: 1 },
      actualDemand: { databaseConnections: 2 },
      releasedAtMs: 1_100,
    });
  });

  describe('reconcileExpired() coalescing (EI-1211660)', () => {
    /** A store whose reconcileExpired() never resolves on its own — settleNext() drives it,
     *  so a test can observe how many concurrent driver.reconcileExpired() calls are still
     *  in flight before any of them settle. */
    class DeferredReconcileStore extends MemoryQueueStore {
      calls = 0;
      private pendingResolvers: Array<(value: QueueReconciliationResult) => void> = [];

      async reconcileExpired(_namespace: string, _nowMs: number): Promise<QueueReconciliationResult> {
        this.calls += 1;
        return new Promise((resolve) => {
          this.pendingResolvers.push(resolve);
        });
      }

      settleNext(result: QueueReconciliationResult): void {
        const resolve = this.pendingResolvers.shift();
        if (!resolve) throw new Error('settleNext() called with no reconcileExpired() call pending');
        resolve(result);
      }
    }

    it('shares one store round-trip across concurrent calls, then across settled calls within the window', async () => {
      const clock = { now: 1_000 };
      const store = new DeferredReconcileStore();
      const driver = new WorkItemAdmissionQueueDriver(store, {
        namespace: 'test',
        now: () => clock.now,
      });

      // Two callers racing concurrently (the fleet-wide-admission shape this exists to fix)
      // must observe exactly ONE store call between them, not two.
      const first = driver.reconcileExpired();
      const second = driver.reconcileExpired();
      expect(store.calls).toBe(1);

      store.settleNext({ requeued: 1, expired: 2, total: 3 });
      await expect(first).resolves.toEqual({ requeued: 1, expired: 2, total: 3 });
      await expect(second).resolves.toEqual({ requeued: 1, expired: 2, total: 3 });

      // Still inside the coalesce window after settlement: a later caller reuses the same
      // settled result rather than issuing a fresh round-trip.
      clock.now += 500;
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 1, expired: 2, total: 3 });
      expect(store.calls).toBe(1);

      // Outside the window: the next call issues a genuinely fresh store round-trip.
      clock.now += 10_000;
      const fresh = driver.reconcileExpired();
      expect(store.calls).toBe(2);
      store.settleNext({ requeued: 0, expired: 0, total: 0 });
      await expect(fresh).resolves.toEqual({ requeued: 0, expired: 0, total: 0 });
    });

    it('never caches a rejection — the very next call retries against the store fresh', async () => {
      const clock = { now: 1_000 };
      let calls = 0;
      class FailOnceStore extends MemoryQueueStore {
        async reconcileExpired(): Promise<QueueReconciliationResult> {
          calls += 1;
          if (calls === 1) throw new Error('transient contention');
          return { requeued: 0, expired: 0, total: 0 };
        }
      }
      const driver = new WorkItemAdmissionQueueDriver(new FailOnceStore(), {
        namespace: 'test',
        now: () => clock.now,
      });

      await expect(driver.reconcileExpired()).rejects.toThrow('transient contention');
      // Immediately after, still well inside what would be the coalesce window — the failed
      // attempt must not be cached against later callers.
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 0, expired: 0, total: 0 });
      expect(calls).toBe(2);
    });

    it('a store with no reconcileExpired() keeps returning the zero result with no coalescing state', async () => {
      const store = new MemoryQueueStore();
      const driver = new WorkItemAdmissionQueueDriver(store, { namespace: 'test', now: () => 1_000 });
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 0, expired: 0, total: 0 });
      await expect(driver.reconcileExpired()).resolves.toEqual({ requeued: 0, expired: 0, total: 0 });
    });
  });
});
