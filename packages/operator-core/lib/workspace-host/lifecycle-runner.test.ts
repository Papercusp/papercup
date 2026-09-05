import { describe, expect, it, vi } from 'vitest';
import {
  fakeWorkspaceHostCapabilities,
  makeFakeWorkspaceHostProvider,
  type WorkspaceHostApplyResult,
  type WorkspaceHostPlan,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
} from '@papercusp/deployment-driver';
import { runWorkspaceHostLifecycle, type WorkspaceHostLifecycleStore } from './lifecycle-runner';
import { WorkspaceHostProvisioningRequestError } from './provisioning-runner';

const vm = {
  target: 'gcp' as const,
  kind: 'vm',
  providerId: 'pc-host-vm',
  parentProviderId: 'project-1',
  zone: 'us-central1-a',
};
const desired = {
  hostId: 'host-1',
  target: 'gcp' as const,
  scope: { kind: 'project' as const, id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' } },
};
const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};

function providerHarness(hostBootstrap = false) {
  const plan: WorkspaceHostPlan = {
    planId: 'plan-start-1',
    operationId: 'op-1',
    target: 'gcp',
    hostId: 'host-1',
    generatedAt: '2026-08-27T00:00:00Z',
    steps: [
      {
        id: 'start-instance',
        action: 'start',
        resourceKind: 'vm',
        dependsOn: [],
        idempotencyKey: 'start-key',
        destructive: false,
        input: { op: 'start-instance', instanceName: vm.providerId },
      },
    ],
    warnings: [],
  };
  const apply = vi.fn<WorkspaceHostProvider['apply']>();
  const reconcile = vi.fn<WorkspaceHostProvider['reconcile']>();
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
    capabilities: fakeWorkspaceHostCapabilities({ lifecycle: { hostBootstrap } }),
    validateConnection: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-08-27T00:00:00Z',
      warnings: [],
      errors: [],
    })),
    plan: vi.fn(async () => plan),
    apply,
    reconcile,
    observe: vi.fn<WorkspaceHostProvider['observe']>(async (host) => ({
      host,
      state: 'running' as const,
      resources: host.resources,
      observedAt: '2026-08-27T00:00:10Z',
      drift: [],
    })),
  });
  return { provider, apply, reconcile };
}

function storeHarness() {
  let checkpoints: WorkspaceHostResourceCheckpoint[] = [];
  const store: WorkspaceHostLifecycleStore = {
    readTarget: vi.fn(async () => ({
      id: 'host-1',
      name: 'Host one',
      connectionId: 'connection-1',
      target: 'gcp',
      observedState: 'stopped',
      desired,
      resources: [{ resource: vm, registeredAt: '2026-08-26T00:00:00Z' }],
    })),
    beginOperation: vi.fn(async () => {}),
    updateOperation: vi.fn(async () => {}),
    readCheckpoints: vi.fn(async () => checkpoints.map((entry) => ({ ...entry }))),
    upsertCheckpoint: vi.fn(async ({ checkpoint }) => {
      checkpoints = [...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey), { ...checkpoint }];
    }),
    appendEvent: vi.fn(async () => 'event-1'),
    recordObservation: vi.fn(async () => {}),
  };
  return { store, checkpoints: () => checkpoints };
}

function input(provider: WorkspaceHostProvider, store: WorkspaceHostLifecycleStore) {
  return {
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    connection,
    provider,
    action: 'start' as const,
    operationId: 'op-1',
    store,
  };
}

describe('runWorkspaceHostLifecycle', () => {
  it('persists the plan before mutation and passes the complete stored resource graph', async () => {
    const { store, checkpoints } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockImplementation(async (request): Promise<WorkspaceHostApplyResult> => {
      expect(checkpoints()[0]).toMatchObject({ logicalKey: 'start-instance', state: 'applying', providerResource: vm });
      expect(request.knownResources).toContainEqual(vm);
      return {
        operationId: 'op-1',
        stepId: 'start-instance',
        state: 'unchanged',
        observedAt: '2026-08-27T00:00:05Z',
        resource: vm,
      };
    });

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
      hostId: 'host-1',
    });
    expect(store.recordObservation).toHaveBeenCalledOnce();
  });

  it('renders the current controller bootstrap before a repair plan and passes it only through provider context', async () => {
    const { store } = storeHarness();
    const { provider, apply } = providerHarness(true);
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });
    const renderHostBootstrap = vi.fn(async () => '#!/usr/bin/env bash\necho repaired');

    await runWorkspaceHostLifecycle({
      ...input(provider, store),
      action: 'repair',
      renderHostBootstrap,
    });

    expect(renderHostBootstrap).toHaveBeenCalledWith('host-1');
    expect(provider.plan).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'repair' }),
      expect.objectContaining({ hostBootstrapScript: '#!/usr/bin/env bash\necho repaired' }),
    );
  });

  it('reconciles an ambiguous provider result on replay instead of applying twice', async () => {
    const { store } = storeHarness();
    const { provider, apply, reconcile } = providerHarness();
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'in-progress',
      observedAt: '2026-08-27T00:00:01Z',
      providerRequestId: 'provider-op-1',
      retryAfterMs: 5_000,
    });
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'unchanged',
      observedAt: '2026-08-27T00:00:06Z',
      resource: vm,
    });

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'in-progress',
      retryAfterMs: 5_000,
    });
    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({ status: 'succeeded' });
    expect(apply).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'resume', previousProviderRequestId: 'provider-op-1' }),
      expect.anything(),
    );
  });

  it('reports upgrade as succeeded-but-not-yet-servable, in the result AND the ledger', async () => {
    // WI-2143797: upgrade recreates the instance from the new image, so everything the
    // initialization leg installed is gone. The provider steps genuinely succeeded; the HOST
    // cannot serve. Both facts have to survive, which is why this is a flag beside
    // status:'succeeded' rather than a different status.
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });

    await expect(
      runWorkspaceHostLifecycle({
        ...input(provider, store),
        action: 'upgrade',
        image: { id: 'projects/images/global/images/papercusp-v2' },
      }),
    ).resolves.toMatchObject({ status: 'succeeded', requiresInitialization: true });

    // The ledger row is what an operator actually reads; a flag only the caller sees would
    // leave `succeeded | 100 | "completed"` sitting in the timeline saying the opposite.
    expect(store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        percent: 100,
        message: expect.stringContaining('CANNOT SERVE'),
      }),
    );
    expect(store.appendEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'complete', message: expect.stringContaining('CANNOT SERVE') }),
    );
  });

  it('leaves a non-boot-disk action reporting a plain completion', async () => {
    // The calibration case. Without it, a predicate stuck at `true` would pass the test above
    // while declaring every stop and restart unusable.
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
      requiresInitialization: false,
    });
    expect(store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Workspace-host start completed' }),
    );
  });

  it('fails closed when restore does not name a distinct desired host', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness();
    await expect(
      runWorkspaceHostLifecycle({
        ...input(provider, store),
        action: 'restore',
        snapshot: { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' },
        desired,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect(provider.plan).not.toHaveBeenCalled();
  });
});
