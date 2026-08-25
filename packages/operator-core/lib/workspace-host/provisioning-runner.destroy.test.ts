import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostPlanStep,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  runWorkspaceHostDestroy,
  type RunWorkspaceHostDestroyInput,
  type WorkspaceHostDestroyStore,
  WorkspaceHostProvisioningRequestError,
} from './provisioning-runner';

const NOW = '2026-08-25T00:00:00.000Z';
const LATER = '2026-08-25T00:10:00.000Z';
const RUN_ID = 'canary_1';
const WORKSPACE_ID = 'workspace_1';

const labels = {
  papercusp_canary: 'true',
  papercusp_run_id: RUN_ID,
  papercusp_workspace_id: WORKSPACE_ID,
};

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
  labels,
};

const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};

const resources: readonly WorkspaceHostResourceRef[] = [
  { target: 'gcp', kind: 'vm', providerId: 'pc-host-vm', parentProviderId: 'project-1', zone: desired.zone },
  { target: 'gcp', kind: 'disk', providerId: 'pc-host-data', parentProviderId: 'project-1', zone: desired.zone },
  { target: 'gcp', kind: 'firewall', providerId: 'pc-host-iap', parentProviderId: 'project-1' },
  { target: 'gcp', kind: 'nat', providerId: 'pc-host-nat', parentProviderId: 'project-1', region: desired.region },
  {
    target: 'gcp',
    kind: 'router',
    providerId: 'pc-host-router',
    parentProviderId: 'project-1',
    region: desired.region,
  },
  {
    target: 'gcp',
    kind: 'subnetwork',
    providerId: 'pc-host-subnet',
    parentProviderId: 'project-1',
    region: desired.region,
  },
  { target: 'gcp', kind: 'network', providerId: 'pc-host-net', parentProviderId: 'project-1' },
];

function steps(): WorkspaceHostPlanStep[] {
  const ordered = ['vm', 'disk', 'firewall', 'nat', 'router', 'subnetwork', 'network'];
  return ordered.map((kind, index) => {
    const resource = resources.find((entry) => entry.kind === kind)!;
    return {
      id: `delete-${kind}-${resource.providerId}`,
      action: 'destroy',
      resourceKind: resource.kind,
      dependsOn:
        index === 0
          ? []
          : [
              `delete-${ordered[index - 1]}-${resources.find((entry) => entry.kind === ordered[index - 1])!.providerId}`,
            ],
      idempotencyKey: `destroy:${kind}`,
      destructive: true,
      input: { op: `delete-${kind}`, resourceName: resource.providerId },
    };
  });
}

function providerHarness(options: { inventoryError?: Error } = {}) {
  const apply = vi.fn<WorkspaceHostProvider['apply']>(async (request): Promise<WorkspaceHostApplyResult> => {
    const providerResourceId = String(request.step.input.resourceName);
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'destroyed',
      observedAt: LATER,
      confirmation: {
        hostId: 'host-1',
        providerResourceId,
        confirmedAbsentAt: LATER,
        source: 'provider-read',
        providerRequestId: `operation:${providerResourceId}`,
      },
    };
  });
  const inventoryManagedResources = vi.fn(async () => {
    if (options.inventoryError) throw options.inventoryError;
    return {
      complete: true as const,
      observed: [],
      inventoryEvidence: [
        { kind: 'vm' as const, strategy: 'managed-labels' as const, providerEvidenceRef: 'gcp://inventory/vm' },
        { kind: 'disk' as const, strategy: 'managed-labels' as const, providerEvidenceRef: 'gcp://inventory/disk' },
        {
          kind: 'firewall' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/firewall',
          deterministicNames: ['pc-host-iap'],
        },
        {
          kind: 'subnetwork' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/subnetwork',
          deterministicNames: ['pc-host-subnet'],
        },
        {
          kind: 'network' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/network',
          deterministicNames: ['pc-host-net'],
        },
        {
          kind: 'snapshot' as const,
          strategy: 'managed-labels' as const,
          providerEvidenceRef: 'gcp://inventory/snapshot',
        },
        {
          kind: 'router' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/router',
          deterministicNames: ['pc-host-router'],
        },
        {
          kind: 'nat' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/nat',
          deterministicNames: ['pc-host-nat'],
        },
      ],
    };
  });
  const provider = {
    target: 'gcp',
    capabilities: {},
    validateConnection: vi.fn(async () => ({ ok: true, checkedAt: NOW, warnings: [], errors: [] })),
    plan: vi.fn(async (request) => ({
      planId: 'plan-destroy-1',
      operationId: request.operationId,
      target: 'gcp' as const,
      hostId: 'host-1',
      generatedAt: NOW,
      steps: steps(),
      warnings: [],
    })),
    apply,
    reconcile: vi.fn<WorkspaceHostProvider['reconcile']>(),
    observe: vi.fn<WorkspaceHostProvider['observe']>(),
    inventoryManagedResources,
  } as unknown as WorkspaceHostProvider & {
    inventoryManagedResources: typeof inventoryManagedResources;
  };
  return { provider, apply, inventoryManagedResources };
}

function storeHarness() {
  let checkpoints: WorkspaceHostResourceCheckpoint[] = [];
  const updateHostState = vi.fn<WorkspaceHostDestroyStore['updateHostState']>();
  const updateOperation = vi.fn<WorkspaceHostDestroyStore['updateOperation']>();
  const store: WorkspaceHostDestroyStore = {
    readTarget: vi.fn(async () => ({
      id: 'host-1',
      name: 'Canary host',
      connectionId: 'connection-1',
      target: 'gcp',
      observedState: 'running',
      desired,
      resources: resources.map((resource) => ({ resource, registeredAt: NOW })),
    })),
    beginOperation: vi.fn(async () => {}),
    updateOperation,
    readCheckpoints: vi.fn(async () => checkpoints.map((entry) => ({ ...entry }))),
    upsertCheckpoint: vi.fn(async ({ checkpoint }) => {
      checkpoints = [...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey), { ...checkpoint }];
    }),
    appendEvent: vi.fn(async () => 'event-1'),
    recordSignals: vi.fn(async () => {}),
    updateHostState,
  };
  return { store, checkpoints: () => checkpoints, updateHostState, updateOperation };
}

function runInput(provider: WorkspaceHostProvider, store: WorkspaceHostDestroyStore): RunWorkspaceHostDestroyInput {
  return {
    workspaceId: WORKSPACE_ID,
    hostId: 'host-1',
    connection,
    provider,
    disposition: 'discard',
    confirmation: { expectedHostId: 'host-1', confirmedBy: 'operator:test', confirmedAt: NOW },
    canary: {
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      contractApproval: {
        status: 'approved',
        suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
        reportRef: 'report://gcp/fake-contract',
        approvedBy: 'operator:test',
        approvedAt: NOW,
      },
      maxSpendCents: 2_500,
      teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
      budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
      preRunZeroBaseline: { cents: 0, observedAt: NOW, providerEvidenceRef: 'gcp://billing/baseline-zero' },
      costEvidence: [{ cents: 71, observedAt: LATER, providerEvidenceRef: 'gcp://billing/settled' }],
      lateObservedSpend: [{ cents: 4, observedAt: LATER, providerEvidenceRef: 'gcp://billing/late' }],
      emergencyManualDestroy: {
        actorId: 'operator:test',
        reason: 'manual cleanup recovered by durable destroy',
        procedureRef: 'runbook://workspace-host/gcp/ambiguous-operation-recovery-v1',
      },
    },
    operationId: 'op-destroy-1',
    store,
  };
}

describe('runWorkspaceHostDestroy', () => {
  it('persists matching provider-read receipts and completes only after non-vacuous clean census + cost proof', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const { store, checkpoints, updateHostState } = storeHarness();

    const result = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(result).toMatchObject({
      status: 'succeeded',
      evidence: {
        completionReceipt: { resourceCount: 7, spentCents: 75 },
        providerCensus: { controllerIndependent: true, inventoryComplete: true, clean: true },
        orphanCensus: { clean: true },
        manualDestroyReceipts: Array(7).fill(
          expect.objectContaining({ kind: 'workspace-host-emergency-manual-destroy' }),
        ),
      },
    });
    expect(apply).toHaveBeenCalledTimes(7);
    expect(inventoryManagedResources).toHaveBeenCalledOnce();
    expect(checkpoints()).toHaveLength(7);
    for (const checkpoint of checkpoints()) {
      expect(checkpoint).toMatchObject({
        state: 'absent',
        providerResource: { providerId: checkpoint.deletionConfirmation?.providerResourceId },
        deletionConfirmation: { source: 'provider-read' },
      });
    }
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
  });

  it('fails closed when the all-kind provider inventory cannot be read', async () => {
    const { provider } = providerHarness({ inventoryError: new Error('403 compute.disks.list denied') });
    const { store, updateHostState, updateOperation } = storeHarness();

    const result = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(result.status).toBe('failed');
    expect(updateHostState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'absent' }));
    expect(updateOperation).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', percent: 99 }));
  });

  it('rejects invalid cumulative evidence before planning or deleting any provider resource', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const input = runInput(provider, store);
    input.canary = {
      ...input.canary,
      costEvidence: [{ cents: 2_501, observedAt: LATER, providerEvidenceRef: 'gcp://billing/over-ceiling' }],
      lateObservedSpend: [],
    };

    await expect(runWorkspaceHostDestroy(input)).rejects.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
