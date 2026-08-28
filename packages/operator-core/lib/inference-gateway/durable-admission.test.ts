import { describe, expect, it } from 'vitest';
import {
  AdmissionPersistenceError,
  Governor,
  type AdmissionContext,
} from '../resource-governor/admission';
import {
  DurableGatewayAdmissionDriver,
  createDurableGatewayAdmissionGovernor,
} from './durable-admission';
import type {
  DurableAdmissionQueueStore,
  DurableAdmissionRecord,
  QueueLeaseSelection,
  QueueMutationResult,
  StoredAdmissionRecord,
} from '../resource-governor/queue';

class MemoryStore implements DurableAdmissionQueueStore {
  private nextId = 0;
  private readonly rows = new Map<string, StoredAdmissionRecord>();
  fail = false;

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
    if (this.fail) throw new Error('persistence unavailable');
    const key = this.key(record.namespace, record.idempotencyKey);
    const existing = this.rows.get(key);
    if (existing) return { ...existing, created: false };
    const stored = { receiptId: `WI-${++this.nextId}`, record };
    this.rows.set(key, stored);
    return { ...stored, created: true };
  }

  async find(namespace: string, idempotencyKey: string) {
    return this.rows.get(this.key(namespace, idempotencyKey)) ?? null;
  }

  async cancel(namespace: string, idempotencyKey: string, reason: string | undefined, nowMs: number) {
    const stored = await this.find(namespace, idempotencyKey);
    if (!stored) return null;
    const next = this.replace(stored, {
      ...stored.record,
      state: 'cancelled',
      updatedAtMs: nowMs,
      decision: { generation: stored.record.decision.generation + 1, atMs: nowMs, reason: 'cancelled', evidence: reason ? { reason } : {} },
      lease: undefined,
    });
    return { ...next, changed: true };
  }

  async leaseNext(_namespace: string, _owner: string, _leaseId: string, _ttlMs: number, _nowMs: number, _selection?: QueueLeaseSelection) {
    return null;
  }

  async leaseReceipt(namespace: string, receiptId: string, owner: string, leaseId: string, ttlMs: number, nowMs: number) {
    const stored = this.byReceipt(receiptId);
    if (!stored || stored.record.namespace !== namespace || !['queued', 'eligible'].includes(stored.record.state)) {
      return stored ? { ...stored, changed: false } : null;
    }
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

  private mutate(receiptId: string, leaseId: string, fn: (record: DurableAdmissionRecord) => DurableAdmissionRecord, nowMs: number): QueueMutationResult | null {
    const stored = this.byReceipt(receiptId);
    if (!stored || stored.record.lease?.leaseId !== leaseId) return stored ? { ...stored, changed: false } : null;
    return { ...this.replace(stored, fn(stored.record)), changed: true };
  }

  async markRunning(receiptId: string, leaseId: string, nowMs: number) {
    return this.mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'running',
      updatedAtMs: nowMs,
      decision: { generation: record.decision.generation + 1, atMs: nowMs, reason: 'execution-started', evidence: {} },
    }), nowMs);
  }

  async complete(receiptId: string, leaseId: string, resultRef: string | undefined, nowMs: number) {
    // `evidence` is Readonly<Record<string, DecisionValue>> and DecisionValue is
    // string|number|boolean|null. Written inline, the ternary widens to
    // `{ resultRef: string } | { resultRef?: undefined }`, and that optional
    // `undefined` member is what the record type rejects. Naming the value with
    // its own annotation keeps the empty branch a plain record instead.
    const evidence: Record<string, string> = resultRef ? { resultRef } : {};
    return this.mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: { generation: record.decision.generation + 1, atMs: nowMs, reason: 'execution-completed', evidence },
      lease: undefined,
      ...(resultRef ? { resultRef } : {}),
    }), nowMs);
  }

  async releaseLease(receiptId: string, leaseId: string, nowMs: number) {
    return this.mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'queued',
      updatedAtMs: nowMs,
      decision: { generation: record.decision.generation + 1, atMs: nowMs, reason: 'lease-released', evidence: {} },
      lease: undefined,
    }), nowMs);
  }

  async releaseClaim(receiptId: string, leaseId: string, actualDemand: DurableAdmissionRecord['demand'] | undefined, nowMs: number) {
    return this.mutate(receiptId, leaseId, (record) => ({
      ...record,
      state: 'completed',
      updatedAtMs: nowMs,
      decision: { generation: record.decision.generation + 1, atMs: nowMs, reason: 'resources-released', evidence: {} },
      lease: undefined,
      ...(actualDemand ? { actualDemand } : {}),
      releasedAtMs: nowMs,
    }), nowMs);
  }

  async supersede(_receiptId: string, _replacementReceiptId: string, _nowMs: number) {
    return null;
  }

  state(namespace: string, idempotencyKey: string): string | undefined {
    return this.rows.get(this.key(namespace, idempotencyKey))?.record.state;
  }
}

function request() {
  return {
    idempotencyKey: 'gateway:test:1',
    admissionClass: 'inference',
    demand: { providerRequests: 1 },
    metadata: { 'gateway.ownerId': 'owner-test' },
  } as const;
}

describe('DurableGatewayAdmissionDriver', () => {
  it('persists, leases, marks running, and releases one synchronous request', async () => {
    const store = new MemoryStore();
    const driver = new DurableGatewayAdmissionDriver({
      store,
      namespace: 'gateway-test',
      now: () => 1_000,
      leaseIdFactory: () => 'lease-test',
    });
    const governor = new Governor(driver, { now: () => 1_000, idFactory: () => 'request-test' });
    const outcome = await governor.admit(request());
    expect(outcome).toMatchObject({ kind: 'admitted', context: { receiptId: 'WI-1', leaseId: 'lease-test' } });
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('running');
    const released = await governor.release(outcome.context, { providerRequests: 1 });
    expect(released.released).toBe(true);
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('completed');
  });

  it('does not return a false receipt when persistence fails', async () => {
    const store = new MemoryStore();
    store.fail = true;
    const governor = createDurableGatewayAdmissionGovernor({ store, namespace: 'gateway-test' });
    await expect(governor.admit(request())).rejects.toBeInstanceOf(AdmissionPersistenceError);
  });

  it('rejects a replay after the first lease is running instead of starting a second upstream call', async () => {
    const store = new MemoryStore();
    const first = createDurableGatewayAdmissionGovernor({
      store,
      namespace: 'gateway-test',
      now: () => 1_000,
      leaseIdFactory: () => 'lease-first',
    });
    const outcome = await first.admit(request());
    expect(outcome.kind).toBe('admitted');
    await expect(
      createDurableGatewayAdmissionGovernor({
        store,
        namespace: 'gateway-test',
        now: () => 1_000,
        leaseIdFactory: () => 'lease-replay',
      }).admit(request()),
    ).rejects.toBeInstanceOf(AdmissionPersistenceError);
    await first.release(outcome.context);
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('completed');
  });
});
