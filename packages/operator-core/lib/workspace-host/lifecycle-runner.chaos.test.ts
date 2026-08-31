import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_HOST_CHAOS_CLASSES,
  type WorkspaceHostApplyResult,
  type WorkspaceHostPlan,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
} from '@papercusp/deployment-driver';
import { runWorkspaceHostLifecycle, type WorkspaceHostLifecycleStore } from './lifecycle-runner';

/**
 * P-024 chaos drills against the REAL lifecycle controller (stop/start/restart/repair/
 * snapshot/restore). The registry suite in deployment-driver pins what each class must resolve to;
 * this file proves the shipped runner actually gets there, which is the half a pure-registry test
 * cannot claim.
 */

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

function providerHarness() {
  const plan: WorkspaceHostPlan = {
    planId: 'plan-start-1',
    operationId: 'op-1',
    target: 'gcp',
    hostId: 'host-1',
    generatedAt: '2026-08-27T00:00:00Z',
    steps: [{
      id: 'start-instance',
      action: 'start',
      resourceKind: 'vm',
      dependsOn: [],
      idempotencyKey: 'start-key',
      destructive: false,
      input: { op: 'start-instance', instanceName: vm.providerId },
    }],
    warnings: [],
  };
  const apply = vi.fn<WorkspaceHostProvider['apply']>();
  const reconcile = vi.fn<WorkspaceHostProvider['reconcile']>();
  const provider = {
    target: 'gcp',
    capabilities: {},
    validateConnection: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-08-27T00:00:00Z',
      warnings: [],
      errors: [],
    })),
    plan: vi.fn(async () => plan),
    apply,
    reconcile,
    observe: vi.fn(async (host) => ({
      host,
      state: 'running' as const,
      resources: host.resources,
      observedAt: '2026-08-27T00:00:10Z',
      drift: [],
    })),
  } as unknown as WorkspaceHostProvider;
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

/** Build the provider error a chaos class injects, preserving its `status` shape. */
function chaosError(spec: { status?: number; code?: string; message: string }): Error {
  return Object.assign(new Error(spec.message), {
    ...(spec.status === undefined ? {} : { status: spec.status }),
    ...(spec.code === undefined ? {} : { code: spec.code }),
  });
}

const thrownErrorClasses = WORKSPACE_HOST_CHAOS_CLASSES.filter(
  (entry) => entry.probe.kind === 'thrown-error',
);
const haltingClasses = thrownErrorClasses.filter((entry) => entry.expectedRecovery === 'halt');
const reconcilingClasses = thrownErrorClasses.filter((entry) => entry.expectedRecovery === 'reconcile');

describe('lifecycle controller — deterministic refusals fail closed', () => {
  it.each(haltingClasses.map((entry) => [entry.label, entry] as const))(
    'fails the operation on %s instead of reconciling forever',
    async (_label, chaosClass) => {
      const { store } = storeHarness();
      const { provider, apply, reconcile } = providerHarness();
      if (chaosClass.probe.kind !== 'thrown-error') throw new Error('expected a thrown-error probe');
      apply.mockRejectedValue(chaosError(chaosClass.probe.error));

      const first = await runWorkspaceHostLifecycle(input(provider, store));

      // A refusal the provider will repeat identically forever must surface as a failure. Reported
      // as in-progress it becomes a permanent hang: `ambiguous` is exempt from the attempt ceiling,
      // so the controller reconciles on every resume and never reaches a terminal verdict.
      expect(first.status).toBe('failed');
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it('records the refusal as terminal, not ambiguous, in the durable checkpoint', async () => {
    const { store, checkpoints } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockRejectedValue(chaosError({ status: 401, code: 'UNAUTHENTICATED', message: 'Credential has expired' }));

    await runWorkspaceHostLifecycle(input(provider, store));

    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'terminal' });
  });
});

describe('lifecycle controller — uncertain outcomes reconcile', () => {
  it.each(reconcilingClasses.map((entry) => [entry.label, entry] as const))(
    'reconciles rather than re-applying after %s',
    async (_label, chaosClass) => {
      const { store, checkpoints } = storeHarness();
      const { provider, apply, reconcile } = providerHarness();
      if (chaosClass.probe.kind !== 'thrown-error') throw new Error('expected a thrown-error probe');
      apply.mockRejectedValueOnce(chaosError(chaosClass.probe.error));
      reconcile.mockResolvedValue({
        operationId: 'op-1',
        stepId: 'start-instance',
        state: 'unchanged',
        observedAt: '2026-08-27T00:00:06Z',
        resource: vm,
      } satisfies WorkspaceHostApplyResult);

      const first = await runWorkspaceHostLifecycle(input(provider, store));
      expect(first.status).toBe('in-progress');
      expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'ambiguous' });

      // The resume must READ provider truth, never issue a second create: the mutation may already
      // have landed and a fresh apply would duplicate a live billed resource.
      const second = await runWorkspaceHostLifecycle(input(provider, store));
      expect(second.status).toBe('succeeded');
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'resume' }),
        expect.anything(),
      );
      expect(apply).toHaveBeenCalledOnce();
    },
  );
});
