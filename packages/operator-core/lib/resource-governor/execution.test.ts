import { describe, expect, it, vi } from 'vitest';
import { Governor } from './admission';
import { WorkItemAdmissionQueueDriver, type DurableAdmissionQueueStore } from './queue';
import {
  admissionContextFromEnvironment,
  beginGovernedExecution,
  withGovernedExecution,
} from './execution';

function deps() {
  let record: any = null;
  const store: DurableAdmissionQueueStore = {
    async enqueue(next) {
      record = next;
      return { receiptId: 'WI-R1', record, created: true };
    },
    async find() {
      return record ? { receiptId: 'WI-R1', record } : null;
    },
    async cancel(_namespace, _key, reason, nowMs) {
      record = { ...record, state: 'cancelled', cancellationReason: reason, updatedAtMs: nowMs, lease: undefined };
      return { receiptId: 'WI-R1', record, changed: true };
    },
    async leaseNext() {
      return null;
    },
    async leaseReceipt(_namespace, receiptId, owner, leaseId, ttlMs, nowMs) {
      record = { ...record, state: 'leased', lease: { owner, leaseId, generation: 1, expiresAtMs: nowMs + ttlMs } };
      return { receiptId, record, changed: true };
    },
    async markRunning(receiptId) {
      record = { ...record, state: 'running' };
      return { receiptId, record, changed: true };
    },
    async complete() {
      return null;
    },
    async releaseLease() {
      return null;
    },
    async releaseClaim(receiptId, _leaseId, actualDemand, nowMs) {
      record = { ...record, state: 'completed', actualDemand, releasedAtMs: nowMs, lease: undefined };
      return { receiptId, record, changed: true };
    },
    async supersede() {
      return null;
    },
  };
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: 'agent-process',
    now: () => 1_000,
    leaseIdFactory: () => 'lease-1',
  });
  return {
    store,
    driver,
    governor: new Governor(driver, { now: () => 1_000, idFactory: () => 'request-1' }),
    current: () => record,
  };
}

describe('governed execution lifecycle', () => {
  it('round-trips a propagated parent context and rejects malformed env input', async () => {
    const d = deps();
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'parent', admissionClass: 'agent' },
      { owner: 'agent-launcher' },
      d,
    );
    expect(admissionContextFromEnvironment(JSON.stringify(execution.context))).toEqual(execution.context);
    expect(admissionContextFromEnvironment('{bad json')).toBeUndefined();
    expect(admissionContextFromEnvironment(JSON.stringify({ requestId: 'partial' }))).toBeUndefined();
  });

  it('persists, targets its own receipt, marks running, and releases exact actual demand', async () => {
    const d = deps();
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'launch-1', admissionClass: 'agent', demand: { cpuWeight: 1, memoryBytes: 10 } },
      { owner: 'agent-launcher' },
      d,
    );
    expect(execution).toMatchObject({ receiptId: 'WI-R1', context: { receiptId: 'WI-R1', leaseId: 'lease-1' } });
    expect(d.current()).toMatchObject({ state: 'running', lease: { owner: 'agent-launcher' } });
    expect(await execution.finish({ cpuWeight: 2, memoryBytes: 12 })).toBe(true);
    expect(await execution.finish()).toBe(false);
    expect(d.current()).toMatchObject({ state: 'completed', actualDemand: { cpuWeight: 2, memoryBytes: 12 } });
  });

  it('cancels the visible durable receipt before process start failure returns', async () => {
    const d = deps();
    const execution = await beginGovernedExecution(
      { idempotencyKey: 'launch-2', admissionClass: 'agent' },
      { owner: 'agent-launcher' },
      d,
    );
    expect(await execution.cancel('spawn failed')).toBe(true);
    expect(d.current()).toMatchObject({ state: 'cancelled', cancellationReason: 'spawn failed' });
  });

  it('wraps a bounded subprocess lifecycle and releases it after the result', async () => {
    const d = deps();
    const result = await withGovernedExecution(
      { idempotencyKey: 'bounded-1', admissionClass: 'process', demand: { cpuWeight: 0.25 } },
      { owner: 'bounded-runner' },
      d,
      async (context) => ({ ok: true, parentRequestId: context.parentRequestId }),
    );
    expect(result).toEqual({ ok: true, parentRequestId: null });
    expect(d.current()).toMatchObject({ state: 'completed' });
  });

  it('cancels the durable receipt when a bounded subprocess throws', async () => {
    const d = deps();
    await expect(
      withGovernedExecution(
        { idempotencyKey: 'bounded-2', admissionClass: 'process' },
        { owner: 'bounded-runner' },
        d,
        async () => {
          throw new Error('spawn exploded');
        },
      ),
    ).rejects.toThrow('spawn exploded');
    expect(d.current()).toMatchObject({
      state: 'cancelled',
      cancellationReason: 'governed execution failed: spawn exploded',
    });
  });

  it('fails closed when a driver returns non-durable compatibility admission', async () => {
    const driver = { admit: vi.fn(async (_request: any, context: any) => ({ kind: 'admitted' as const, context })) };
    await expect(
      beginGovernedExecution(
        { idempotencyKey: 'launch-3', admissionClass: 'agent' },
        { owner: 'agent-launcher' },
        { governor: new Governor(driver), driver: {} as WorkItemAdmissionQueueDriver },
      ),
    ).rejects.toThrow(/requires a durable queued receipt/);
  });
});
