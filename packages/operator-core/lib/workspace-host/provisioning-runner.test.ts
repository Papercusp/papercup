import { describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceHostApplyResult,
  WorkspaceHostDesiredSpec,
  WorkspaceHostPlan,
  WorkspaceHostPlanStep,
  WorkspaceHostProvider,
  WorkspaceHostProviderConnection,
  WorkspaceHostResourceCheckpoint,
} from '@papercusp/deployment-driver';
import {
  runWorkspaceHostProvisioning,
  WorkspaceHostProvisioningRequestError,
  type WorkspaceHostProvisioningStore,
} from './provisioning-runner';

const desired: WorkspaceHostDesiredSpec = {
  hostId: 'host-1',
  target: 'gcp',
  scope: { kind: 'project', id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
  provider: { network: { mode: 'managed', networkName: 'host-1-net' } },
};

const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};

function planStep(id: string, dependsOn: readonly string[] = []): WorkspaceHostPlanStep {
  return {
    id,
    action: 'provision',
    resourceKind: id === 'create-instance' ? 'vm' : 'network',
    dependsOn,
    idempotencyKey: `key:${id}`,
    destructive: false,
    input: { op: id === 'create-instance' ? 'insert-instance' : 'insert-network' },
  };
}

function providerPlan(steps: readonly WorkspaceHostPlanStep[]): WorkspaceHostPlan {
  return {
    planId: 'plan-1',
    operationId: 'op-1',
    target: 'gcp',
    hostId: 'host-1',
    generatedAt: '2026-08-25T00:00:00Z',
    steps,
    warnings: [],
  };
}

function providerHarness(steps: readonly WorkspaceHostPlanStep[]) {
  const apply = vi.fn<WorkspaceHostProvider['apply']>();
  const reconcile = vi.fn<WorkspaceHostProvider['reconcile']>();
  const observe = vi.fn<WorkspaceHostProvider['observe']>(async (host) => ({
    host,
    state: 'running',
    resources: host.resources,
    observedAt: '2026-08-25T00:00:10Z',
    drift: [],
  }));
  const provider = {
    target: 'gcp',
    capabilities: {},
    validateConnection: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-08-25T00:00:00Z',
      warnings: [],
      errors: [],
    })),
    plan: vi.fn(async () => providerPlan(steps)),
    apply,
    reconcile,
    observe,
  } as unknown as WorkspaceHostProvider;
  return { provider, apply, reconcile, observe };
}

function storeHarness(initial: readonly WorkspaceHostResourceCheckpoint[] = []) {
  const calls: string[] = [];
  let checkpoints = initial.map((entry) => ({ ...entry }));
  const store: WorkspaceHostProvisioningStore = {
    upsertHost: vi.fn(async (input) => {
      calls.push('host');
      expect(input.desiredSpec).toEqual(desired);
    }),
    beginOperation: vi.fn(async () => {
      calls.push('operation');
    }),
    updateOperation: vi.fn(async (input) => {
      calls.push(`operation:${input.status}`);
    }),
    readCheckpoints: vi.fn(async () => checkpoints.map((entry) => ({ ...entry }))),
    upsertCheckpoint: vi.fn(async ({ checkpoint }) => {
      calls.push(`checkpoint:${checkpoint.logicalKey}:${checkpoint.state}`);
      checkpoints = [
        ...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey),
        { ...checkpoint },
      ];
    }),
    appendEvent: vi.fn(async (input) => {
      calls.push(`event:${input.phase}`);
      return `event-${calls.length}`;
    }),
    recordObservation: vi.fn(async () => {
      calls.push('observation');
    }),
  };
  return { store, calls, checkpoints: () => checkpoints.map((entry) => ({ ...entry })) };
}

function runInput(provider: WorkspaceHostProvider, store: WorkspaceHostProvisioningStore) {
  return {
    workspaceId: 'ws-1',
    connectionId: 'connection-1',
    name: 'Research host',
    desired,
    connection,
    provider,
    operationId: 'op-1',
    store,
  };
}

describe('runWorkspaceHostProvisioning', () => {
  it('persists intent and every resource plan before the first provider mutation', async () => {
    const steps = [planStep('create-network'), planStep('create-instance', ['create-network'])];
    const { store, calls, checkpoints } = storeHarness();
    const { provider, apply, observe } = providerHarness(steps);
    apply.mockImplementation(async (request): Promise<WorkspaceHostApplyResult> => {
      calls.push(`provider:${request.step.id}`);
      expect(calls.indexOf('host')).toBeLessThan(calls.indexOf(`provider:${request.step.id}`));
      expect(calls.indexOf('checkpoint:create-network:planned')).toBeLessThan(
        calls.indexOf(`provider:${request.step.id}`),
      );
      expect(calls.indexOf('checkpoint:create-instance:planned')).toBeLessThan(
        calls.indexOf(`provider:${request.step.id}`),
      );
      if (request.step.id === 'create-instance') {
        expect(request.knownResources).toEqual([
          { target: 'gcp', kind: 'network', providerId: 'provider-create-network' },
        ]);
      }
      return {
        operationId: 'op-1',
        stepId: request.step.id,
        state: 'applied',
        observedAt: '2026-08-25T00:00:05Z',
        resource: {
          target: 'gcp',
          kind: request.step.resourceKind,
          providerId: `provider-${request.step.id}`,
        },
      };
    });

    const result = await runWorkspaceHostProvisioning(runInput(provider, store));

    expect(result.status).toBe('succeeded');
    expect(checkpoints().map(({ logicalKey, state }) => ({ logicalKey, state }))).toEqual([
      { logicalKey: 'create-network', state: 'applied' },
      { logicalKey: 'create-instance', state: 'applied' },
    ]);
    expect(observe).toHaveBeenCalledOnce();
    expect(calls).toContain('observation');
    expect(calls.at(-2)).toBe('operation:succeeded');
  });

  it('returns an in-progress receipt and reconciles on replay instead of blindly applying again', async () => {
    const steps = [planStep('create-network')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply, reconcile } = providerHarness(steps);
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-network',
      state: 'in-progress',
      observedAt: '2026-08-25T00:00:01Z',
      providerRequestId: 'provider-operation-1',
      retryAfterMs: 7_500,
    });
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-network',
      state: 'unchanged',
      observedAt: '2026-08-25T00:00:08Z',
      resource: { target: 'gcp', kind: 'network', providerId: 'provider-network' },
    });

    const first = await runWorkspaceHostProvisioning(runInput(provider, store));
    expect(first).toMatchObject({ status: 'in-progress', retryAfterMs: 7_500 });
    expect(checkpoints()[0]).toMatchObject({
      state: 'retry-wait',
      retryClass: 'ambiguous',
      providerRequestId: 'provider-operation-1',
    });

    const replay = await runWorkspaceHostProvisioning(runInput(provider, store));
    expect(replay.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]?.[0]).toMatchObject({
      reason: 'resume',
      previousProviderRequestId: 'provider-operation-1',
    });
  });

  it('records a thrown provider outcome as ambiguous and reconciles it on the next request', async () => {
    const steps = [planStep('create-network')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply, reconcile } = providerHarness(steps);
    apply.mockRejectedValueOnce(new Error('connection closed after request write'));
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-network',
      state: 'applied',
      observedAt: '2026-08-25T00:00:08Z',
      resource: { target: 'gcp', kind: 'network', providerId: 'provider-network' },
    });

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'in-progress',
    });
    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'ambiguous' });
    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('persists nothing when the provider rejects the plan', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness([planStep('create-network')]);
    vi.mocked(provider.plan).mockRejectedValueOnce(new Error('desired.zone must belong to desired.region'));

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceHostProvisioningRequestError>>({
        name: 'WorkspaceHostProvisioningRequestError',
        problems: ['desired.zone must belong to desired.region'],
      }),
    );
    expect(store.upsertHost).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
    expect(store.upsertCheckpoint).not.toHaveBeenCalled();
  });
});
