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
import type { GcpWorkspaceHostInventorySnapshot } from './gcp-provider';
import {
  GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS,
  type GcpManagedWorkspaceHostResourceObservation,
} from './gcp-safety';
import {
  runWorkspaceHostDestroy,
  type RunWorkspaceHostDestroyInput,
  type WorkspaceHostDestroyCanaryEvidence,
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
  const inventoryManagedResources = vi.fn<() => Promise<GcpWorkspaceHostInventorySnapshot>>(async () => {
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

function storeHarness(targetDesired: WorkspaceHostDesiredSpec = desired) {
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
      desired: targetDesired,
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

function legacyInventorySnapshot(
  observed: readonly GcpManagedWorkspaceHostResourceObservation[] = resources.map(
    (resource): GcpManagedWorkspaceHostResourceObservation => ({
      resource,
      labels: ['vm', 'disk'].includes(resource.kind)
        ? {
            [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
            [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: 'host-1',
            [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: WORKSPACE_ID,
            purpose: 'legacy-canary',
          }
        : {},
      observedAt: NOW,
    }),
  ),
): GcpWorkspaceHostInventorySnapshot {
  const names = (kind: string) =>
    resources.filter((resource) => resource.kind === kind).map((resource) => resource.providerId);
  return {
    complete: true,
    observed,
    inventoryEvidence: [
      { kind: 'vm', strategy: 'managed-labels', providerEvidenceRef: 'gcp://inventory/vm' },
      { kind: 'disk', strategy: 'managed-labels', providerEvidenceRef: 'gcp://inventory/disk' },
      {
        kind: 'firewall',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/firewall',
        deterministicNames: names('firewall'),
      },
      {
        kind: 'subnetwork',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/subnetwork',
        deterministicNames: names('subnetwork'),
      },
      {
        kind: 'network',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/network',
        deterministicNames: names('network'),
      },
      { kind: 'snapshot', strategy: 'managed-labels', providerEvidenceRef: 'gcp://inventory/snapshot' },
      {
        kind: 'router',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/router',
        deterministicNames: names('router'),
      },
      {
        kind: 'nat',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/nat',
        deterministicNames: names('nat'),
      },
    ],
  };
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
    const { store, checkpoints, updateHostState, updateOperation } = storeHarness();

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
    const successUpdate = updateOperation.mock.calls.findIndex(([entry]) => entry.status === 'succeeded');
    const evidenceEvent = vi
      .mocked(store.appendEvent)
      .mock.calls.findIndex(([entry]) => entry.phase === 'destroy-evidence');
    expect(updateHostState.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      updateOperation.mock.invocationCallOrder[successUpdate] ?? 0,
    );
    expect(updateHostState.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      vi.mocked(store.appendEvent).mock.invocationCallOrder[evidenceEvent] ?? 0,
    );
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

  it('permits explicitly audited cleanup of a pre-tagging canary only after an exact pre-delete census', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    let inventoryCalls = 0;
    inventoryManagedResources.mockImplementation(async () => {
      inventoryCalls += 1;
      return inventoryCalls === 1 ? legacyInventorySnapshot() : legacyInventorySnapshot([]);
    });
    const legacyDesired: WorkspaceHostDesiredSpec = {
      ...desired,
      labels: { purpose: 'legacy-canary' },
    };
    const { store } = storeHarness(legacyDesired);

    const result = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(result.status).toBe('succeeded');
    expect(inventoryManagedResources).toHaveBeenCalledTimes(2);
    expect(store.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          labelAdmission: {
            mode: 'legacy-manual-purpose',
            purpose: 'legacy-canary',
            preDeleteCensus: 'controller-independent-exact-population',
          },
        }),
      }),
    );
    expect(apply).toHaveBeenCalledTimes(resources.length);
  });

  it('fails closed before planning when a legacy canary census finds an extra managed resource', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const extra = {
      resource: { ...resources[0]!, providerId: 'foreign-vm' },
      labels: {
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: 'host-1',
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: WORKSPACE_ID,
        purpose: 'legacy-canary',
      },
      observedAt: NOW,
    } satisfies GcpWorkspaceHostInventorySnapshot['observed'][number];
    inventoryManagedResources.mockResolvedValue(
      legacyInventorySnapshot([...legacyInventorySnapshot().observed, extra]),
    );
    const { store } = storeHarness({ ...desired, labels: { purpose: 'legacy-canary' } });

    await expect(runWorkspaceHostDestroy(runInput(provider, store))).rejects.toMatchObject({
      problems: [expect.stringContaining('clean pre-delete provider identity census')],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  // WI-1762411: a destroy that deleted everything reported `failed` at percent=99 because the
  // terminal census was single-shot. Provider list reads are eventually consistent and the network
  // is deleted LAST, so the census could still see a resource whose delete had been confirmed.
  it('re-reads a terminal census that still shows a resource mid-deletion instead of failing a completed teardown', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation, updateHostState } = storeHarness();
    // First terminal read still sees the resources; the second is the harness default — clean.
    inventoryManagedResources.mockImplementationOnce(async () => legacyInventorySnapshot());

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), censusSettleMs: 400 });

    expect(result.status).toBe('succeeded');
    expect(inventoryManagedResources).toHaveBeenCalledTimes(2);
    expect(updateOperation.mock.calls.some(([entry]) => entry.status === 'failed')).toBe(false);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
  });

  it('still fails a terminal census that is unclean at the settle deadline, naming the census and the resource', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation } = storeHarness();
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot());

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    expect(inventoryManagedResources).toHaveBeenCalledOnce();
    const failure = updateOperation.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.status === 'failed');
    const failureError = failure?.error as { reason?: unknown } | undefined;
    const reason = String(failureError?.reason ?? '');
    // The old message named neither which census failed nor what it saw.
    expect(reason).toMatch(/census is not clean after 1 read\(s\)/);
    expect(reason).toMatch(/(provider|orphan)\.\w+=\[/);
    expect(reason).toContain('pc-host-');
  });
});

// WI-2143805: a host whose canary run FAILED could not be destroyed through the product route at
// all. Destroy admission demanded an approved contract report, settled cumulative cost, and a
// provider-delayed observed-spend entry — evidence only a run that COMPLETED can produce — so the
// hosts most in need of teardown were exactly the ones the product refused to tear down, leaving
// the operator to reach around it with a script. `failedRunTeardown` relaxes that economic family
// and nothing else: identity still has to hold, which is what these four cases pin, in both
// directions. A test that only proves the new path works would equally pass if the requirement had
// simply been deleted.
describe('runWorkspaceHostDestroy failed-run teardown', () => {
  const failedRunCanary = (): WorkspaceHostDestroyCanaryEvidence => ({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    maxSpendCents: 2_500,
    teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
    budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
    preRunZeroBaseline: { cents: 0, observedAt: NOW, providerEvidenceRef: 'gcp://billing/baseline-zero' },
    // Exactly what a failed run has: the baseline read before it mutated anything, and nothing else.
    costEvidence: [],
    failedRunTeardown: {
      actorId: 'operator:test',
      reason: 'canary run failed during bootstrap; the host must still be torn down',
      procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
      failedOperationIds: ['op-run-1'],
    },
  });

  it('destroys a failed-canary host on evidence a failed run can actually produce', async () => {
    const { provider, apply } = providerHarness();
    const { store, updateHostState } = storeHarness();

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), canary: failedRunCanary() });

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(resources.length);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
    // The receipt cites the audited procedure, and carries NO contract report ref — a reader of the
    // persisted signal can tell a failed-run teardown from a completed canary without guessing.
    expect(result.evidence?.completionReceipt).toMatchObject({
      spentCents: 0,
      resourceCount: resources.length,
      failedRunTeardown: { procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1' },
    });
    expect(result.evidence?.completionReceipt.contractReportRef).toBeUndefined();
    expect(store.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          evidenceAdmission: {
            mode: 'failed-run-teardown',
            waives: 'economic-evidence-only',
            actorId: 'operator:test',
            procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
            failedOperationIds: ['op-run-1'],
          },
        }),
      }),
    );
  });

  // The calibration case. Without it the test above would pass just as well against a build that
  // dropped the economic requirement outright, which is the failure this whole item is about.
  it('still refuses the identical evidence when failedRunTeardown is absent', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const { failedRunTeardown: _waiver, ...withoutWaiver } = failedRunCanary();
    const canary = {
      ...withoutWaiver,
      contractApproval: {
        status: 'approved' as const,
        suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
        reportRef: 'report://gcp/fake-contract',
        approvedBy: 'operator:test',
        approvedAt: NOW,
      },
    } satisfies WorkspaceHostDestroyCanaryEvidence;

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.stringContaining('at least one named cumulative cost entry'),
        expect.stringContaining('provider-delayed observed spend entry'),
      ]),
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not waive identity: a canary label that disagrees with the run still refuses', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness({ ...desired, labels: { ...labels, papercusp_run_id: 'canary_someone_else' } });

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary: failedRunCanary() }),
    ).rejects.toMatchObject({
      problems: [expect.stringContaining(`papercusp_run_id=${RUN_ID}`)],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  // The two waivers stay disjoint. emergencyManualDestroy is the LABEL waiver for a host
  // provisioned before the canary tag contract existed; failedRunTeardown waives economics only.
  // Neither may stand in for the other, or one request could drop both proofs at once.
  it('does not waive the canary labels a pre-tagging host is missing — that is still the manual path', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness({ ...desired, labels: { purpose: 'legacy-canary' } });

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary: failedRunCanary() }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.stringContaining('papercusp_canary=true')]),
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
