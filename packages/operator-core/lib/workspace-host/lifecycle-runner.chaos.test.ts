import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_HOST_CHAOS_CLASSES,
  makeFakeWorkspaceHostProvider,
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
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
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

function storeHarness(seed: readonly WorkspaceHostResourceCheckpoint[] = []) {
  let checkpoints: WorkspaceHostResourceCheckpoint[] = seed.map((entry) => ({ ...entry }));
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

describe('lifecycle controller — survives termination mid-operation (P-018)', () => {
  it('resumes an `applying` row by reconciling, never by issuing a second create', async () => {
    // The crash window itself: the controller died AFTER the provider call went out and BEFORE the
    // result was recorded. The provider may be holding a resource this controller never wrote down,
    // so a fresh apply here would duplicate a live billed resource.
    const { store } = storeHarness([
      { logicalKey: 'start-instance', state: 'applying', attempts: 1, providerRequestId: 'provider-op-1' },
    ]);
    const { provider, apply, reconcile } = providerHarness();
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'unchanged',
      observedAt: '2026-08-27T00:00:06Z',
      resource: vm,
    } satisfies WorkspaceHostApplyResult);

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'resume', previousProviderRequestId: 'provider-op-1' }),
      expect.anything(),
    );
  });

  it('carries the lost provider request id into the resume so the reconcile can find the side effect', async () => {
    // Without previousProviderRequestId the provider cannot correlate the orphaned operation, and
    // an "I see nothing" answer would be indistinguishable from "it was never created".
    const { store } = storeHarness([
      { logicalKey: 'start-instance', state: 'applying', attempts: 2, providerRequestId: 'provider-op-lost' },
    ]);
    const { provider, reconcile } = providerHarness();
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:07Z',
      resource: vm,
    } satisfies WorkspaceHostApplyResult);

    await runWorkspaceHostLifecycle(input(provider, store));

    expect(reconcile.mock.calls[0]?.[0]).toMatchObject({
      reason: 'resume',
      previousProviderRequestId: 'provider-op-lost',
    });
  });

  it('still fails closed when the resumed reconcile hits a deterministic refusal', async () => {
    // Termination recovery must not become its own hang: a resumed reconcile that is REFUSED is
    // still terminal. This is the intersection of the two classes and the one a partial fix misses.
    const { store, checkpoints } = storeHarness([
      { logicalKey: 'start-instance', state: 'applying', attempts: 1, providerRequestId: 'provider-op-1' },
    ]);
    const { provider, reconcile } = providerHarness();
    reconcile.mockRejectedValue(
      chaosError({ status: 401, code: 'UNAUTHENTICATED', message: 'Credential has expired' }),
    );

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'failed',
    });
    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'terminal' });
  });
});

describe('snapshot restore (P-018)', () => {
  const snapshot = { target: 'gcp' as const, providerId: 'pc-snap-1', hostId: 'host-1' };
  const restoredDesired = { ...desired, hostId: 'host-restored' };

  function restoreHarness(extraSteps: readonly WorkspaceHostPlan['steps'][number][] = []) {
    const plan: WorkspaceHostPlan = {
      planId: 'plan-restore-1',
      operationId: 'op-restore-1',
      target: 'gcp',
      hostId: 'host-restored',
      generatedAt: '2026-08-27T00:00:00Z',
      steps: [
        {
          id: 'restore-instance',
          action: 'restore',
          resourceKind: 'vm',
          dependsOn: [],
          idempotencyKey: 'restore-key',
          destructive: false,
          input: { op: 'restore-instance', snapshotId: snapshot.providerId },
        },
        ...extraSteps,
      ],
      warnings: [],
    };
    const { provider, apply, reconcile } = providerHarness();
    (provider as { plan: unknown }).plan = vi.fn(async () => plan);
    return { provider, apply, reconcile };
  }

  function restoreInput(provider: WorkspaceHostProvider, store: WorkspaceHostLifecycleStore) {
    return {
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      connection,
      provider,
      action: 'restore' as const,
      operationId: 'op-restore-1',
      store,
      snapshot,
      desired: restoredDesired,
    };
  }

  it('restores onto the NEW host id, never over the source host', async () => {
    const { store } = storeHarness();
    const { provider, apply } = restoreHarness();
    apply.mockResolvedValue({
      operationId: 'op-restore-1',
      stepId: 'restore-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: { ...vm, providerId: 'pc-host-restored' },
    } satisfies WorkspaceHostApplyResult);

    await expect(runWorkspaceHostLifecycle(restoreInput(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
      hostId: 'host-restored',
    });
  });

  it('fails closed when the restore names no snapshot', async () => {
    const { store } = storeHarness();
    const { provider } = restoreHarness();
    // The detail is carried on `problems`, not the message — asserting on the message alone would
    // pass for ANY rejected request and tell you nothing about which validation fired.
    await expect(
      runWorkspaceHostLifecycle({
        ...restoreInput(provider, store),
        snapshot: undefined,
      } as unknown as ReturnType<typeof restoreInput>),
    ).rejects.toMatchObject({
      name: 'WorkspaceHostProvisioningRequestError',
      problems: ['restore snapshot is required'],
    });
  });

  it('a terminally-failed restore RETAINS its created resources as recorded rows, never silently succeeds', async () => {
    // lifecycle-runner marks every resource retainOnCancel:true and sets no compensation plan, so a
    // failed restore deliberately does NOT auto-delete what it made — you do not silently destroy a
    // user's restored data. That makes the zero-orphan guarantee depend on the resource staying
    // RECORDED, so teardown and the orphan reaper can still find it. Assert exactly that: a failed
    // verdict, plus a durable row naming the provider resource.
    const { store, checkpoints } = storeHarness();
    // Two steps: the VM lands, then the data disk is refused. A single-step plan cannot show this —
    // the operation would simply succeed and the assertion would pass for the wrong reason.
    const { provider, apply } = restoreHarness([{
      id: 'restore-disk',
      action: 'restore',
      resourceKind: 'disk',
      dependsOn: ['restore-instance'],
      idempotencyKey: 'restore-disk-key',
      destructive: false,
      input: { op: 'restore-disk', snapshotId: snapshot.providerId },
    }]);
    apply.mockImplementation(async (request) => {
      if (request.step.id === 'restore-instance') {
        return {
          operationId: 'op-restore-1',
          stepId: 'restore-instance',
          state: 'applied',
          observedAt: '2026-08-27T00:00:05Z',
          resource: { ...vm, providerId: 'pc-host-restored' },
        } satisfies WorkspaceHostApplyResult;
      }
      throw chaosError({ status: 403, code: 'QUOTA_EXCEEDED', message: "Quota 'DISKS' exceeded" });
    });

    const result = await runWorkspaceHostLifecycle(restoreInput(provider, store));

    expect(result.status).toBe('failed');
    const vmRow = checkpoints().find((entry) => entry.logicalKey === 'restore-instance');
    const diskRow = checkpoints().find((entry) => entry.logicalKey === 'restore-disk');
    // The VM the restore DID create stays recorded with its provider id, so teardown and the orphan
    // reaper can still find and bill-stop it. Retained is not the same as orphaned.
    expect(vmRow).toMatchObject({
      state: 'applied',
      providerResource: expect.objectContaining({ providerId: 'pc-host-restored' }),
    });
    expect(diskRow).toMatchObject({ state: 'failed', retryClass: 'terminal' });
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
