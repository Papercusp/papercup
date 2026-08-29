import { describe, expect, it } from 'vitest';
import { AdmissionPersistenceError, Governor } from '../resource-governor/admission';
// The in-memory store used to be a ~130-line copy inline here, and near-identical
// copies still live in resource-governor/{queue,execution}.test.ts. P-014 needed a
// store that survives driver reconstruction, so the copy was promoted to a shared
// seam rather than duplicated a fourth time.
import { MemoryAdmissionQueueStore } from '../resource-governor/memory-admission-queue-store';
import {
  DurableGatewayAdmissionDriver,
  createDurableGatewayAdmissionGovernor,
} from './durable-admission';

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
    const store = new MemoryAdmissionQueueStore();
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
    const store = new MemoryAdmissionQueueStore();
    store.fail = true;
    const governor = createDurableGatewayAdmissionGovernor({ store, namespace: 'gateway-test' });
    await expect(governor.admit(request())).rejects.toBeInstanceOf(AdmissionPersistenceError);
  });

  it('rejects a replay after the first lease is running instead of starting a second upstream call', async () => {
    const store = new MemoryAdmissionQueueStore();
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
