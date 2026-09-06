import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  makeFakeWorkspaceHostProvider,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostPlanStep,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import type { RouteContext } from '../endpoint-route/define-route';
import {
  createWorkspaceHostProvisionRoute,
  type WorkspaceHostProvisionRouteDependencies,
} from '../endpoint-route/routes/workspace-hosts/provision';
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
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
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
  });
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
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 1,
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

  // WI-2143626: a FAILED destroy discarded the one artefact that says what is still RECLAIMABLE.
  // The destroy census runs with `expected: []`, so every managed resource still visible lands in
  // `reaperPlan` carrying a reclaim state (and, while quarantined, the instant it becomes eligible).
  // `reaperPlan` has no production consumer anywhere — only this message — so if it is not named
  // here it is not recoverable at all. That is why p046-canary-04..07 left networks, subnets, Cloud
  // NAT routers and 4x100GiB disks billing for days, found only by a by-hand six-kind census.
  it('names what is still RECLAIMABLE, not merely what is still live, when a destroy fails', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation } = storeHarness();
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot());

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    const failure = updateOperation.mock.calls.map(([entry]) => entry).find((entry) => entry.status === 'failed');
    const reason = String((failure?.error as { reason?: unknown } | undefined)?.reason ?? '');
    // The survivors were first observed at NOW, far outside the 60s orphan grace by the time the
    // census evaluates, so the plan's verdict is that they are reclaimable RIGHT NOW. Losing that
    // verdict — not losing the resource list — is what made the strandage undiscoverable.
    expect(reason).toContain('provider.reapEligible=[');
    expect(reason).toMatch(/provider\.reapEligible=\[[^\]]*pc-host-/);
    // CONTROL: the reclaim verdict must be ADDITIVE to the survivor list, never a relabelling of it.
    // Without both assertions a regression that merely renamed `provider.untracked` would pass.
    expect(reason).toContain('provider.untracked=[');
  });
});

// WI-2143805: a canary host could not be destroyed through the product route at all — destroy
// admission demanded an approved contract report, settled cumulative cost, and a provider-delayed
// observed-spend entry, so the hosts most in need of teardown were exactly the ones the product
// refused to tear down and the operator had to reach around it with a script.
//
// D-274 splits that into two ORTHOGONAL axes, and these cases pin both, in both directions:
//   AUTHORIZATION — contractApproval (run completed) XOR failedRunTeardown (run failed, so the
//     approved contract report cannot exist).
//   SETTLEMENT    — absent means provider billing has settled and both cost fields are required;
//     spendSettlement means it has not, which for a short-lived canary is the NORMAL case.
// Neither axis may be inferred from the other: a failed run still spends money, and that money
// settles on the provider's clock exactly like a successful run's.
//
// Identity (canary labels + pre-delete census) is waived by neither. A test that only proved the
// new paths work would pass equally against a build that simply deleted the requirements, so every
// admitting case below is paired with the refusal that calibrates it.
describe('runWorkspaceHostDestroy evidence axes (D-274)', () => {
  const deferredSettlement = {
    status: 'deferred' as const,
    actorId: 'operator:test',
    reason: 'provider billing has not settled; GCP lags hours behind teardown',
    procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
    reconcileAfter: '2026-08-26T00:00:00.000Z',
  };

  // A failed run: no approved contract report (never will be) AND no settled spend (not yet).
  const failedRunCanary = (): WorkspaceHostDestroyCanaryEvidence => ({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    maxSpendCents: 2_500,
    teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
    budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
    preRunZeroBaseline: { cents: 0, observedAt: NOW, providerEvidenceRef: 'gcp://billing/baseline-zero' },
    costEvidence: [],
    spendSettlement: deferredSettlement,
    failedRunTeardown: {
      actorId: 'operator:test',
      reason: 'canary run failed during bootstrap; the host must still be torn down',
      procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
      failedOperationIds: ['op-run-1'],
    },
  });

  // canary-15's case: the run SUCCEEDED — provisioned, upgraded, SSH serving — so it HAS an approved
  // contract report. It was undestroyable purely because the spend had not settled yet, and
  // `lateObservedSpend` is by definition learned only AFTER the settle. This is what part 2 fixes.
  const settledLaterCanary = (): WorkspaceHostDestroyCanaryEvidence => ({
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
    costEvidence: [],
    spendSettlement: deferredSettlement,
  });

  it('destroys a host whose run SUCCEEDED but whose spend has not settled (canary-15)', async () => {
    const { provider, apply } = providerHarness();
    const { store, updateHostState } = storeHarness();

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), canary: settledLaterCanary() });

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(resources.length);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
    // The receipt still cites the approved contract report — the run DID complete — and additionally
    // marks its spend provisional, so no reader reports spentCents:0 as this host's final cost.
    expect(result.evidence?.completionReceipt).toMatchObject({
      contractReportRef: 'report://gcp/fake-contract',
      spentCents: 0,
      spendSettlement: { status: 'deferred', reconcileAfter: '2026-08-26T00:00:00.000Z' },
    });
    // The obligation is hoisted onto the persisted signal so a sweep can FIND who owes one.
    expect(store.recordSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        costSignals: [expect.objectContaining({ spendSettlement: expect.objectContaining({ status: 'deferred' }) })],
      }),
    );
    expect(store.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          spendAdmission: {
            mode: 'deferred-settlement',
            waives: 'settled-cost-evidence-only',
            actorId: 'operator:test',
            procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
            reconcileAfter: '2026-08-26T00:00:00.000Z',
          },
        }),
      }),
    );
  });

  // Calibration for the case above: authorization alone does NOT waive the economics. Without the
  // settlement attestation the identical payload is still refused — so the axes really are separate,
  // and part 2 is not just "the cost requirement was deleted".
  it('still refuses a successful-run payload with empty economics and no settlement attestation', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const { spendSettlement: _deferred, ...withoutSettlement } = settledLaterCanary();

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary: withoutSettlement }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.stringContaining('at least one named cumulative cost entry'),
        expect.stringContaining('provider-delayed observed spend entry'),
      ]),
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  // The deferral is an obligation, not a hole: it must name who deferred it and when it comes due.
  it('refuses a settlement deferral that names no reconciliation date', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const canary = {
      ...settledLaterCanary(),
      spendSettlement: { ...deferredSettlement, reconcileAfter: 'whenever' },
    } satisfies WorkspaceHostDestroyCanaryEvidence;

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary }),
    ).rejects.toMatchObject({
      problems: [expect.stringContaining('canary.spendSettlement.reconcileAfter')],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('destroys a failed-canary host on evidence a failed run can actually produce', async () => {
    const { provider, apply } = providerHarness();
    const { store, updateHostState } = storeHarness();

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), canary: failedRunCanary() });

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(resources.length);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
    // The receipt cites the audited procedure and carries NO contract report ref — a reader of the
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
          // D-274: this authorization waives the approved contract report and NOTHING about spend —
          // the failed run's own spend is deferred by the separate settlement axis, recorded beside
          // it. Before D-274 this row claimed 'economic-evidence-only', conflating the two.
          evidenceAdmission: {
            mode: 'failed-run-teardown',
            waives: 'approved-contract-report-only',
            actorId: 'operator:test',
            procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
            failedOperationIds: ['op-run-1'],
          },
          spendAdmission: expect.objectContaining({ mode: 'deferred-settlement' }),
        }),
      }),
    );
  });

  // Calibration for the AUTHORIZATION axis, mirroring the settlement one above. A settled-spend
  // attestation does not stand in for the missing contract report: strip the authorization and the
  // ledger still refuses, so neither axis silently covers for the other.
  it('still refuses when the run produced no contract report and no failed-run authorization', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const { failedRunTeardown: _authorization, ...withoutAuthorization } = failedRunCanary();

    await expect(
      runWorkspaceHostDestroy({
        ...runInput(provider, store),
        // Cast: the union forbids this shape at compile time, which is the point — this asserts the
        // RUNTIME gate holds too, for a caller reaching the route with untyped JSON.
        canary: withoutAuthorization as unknown as WorkspaceHostDestroyCanaryEvidence,
      }),
    ).rejects.toMatchObject({
      problems: [expect.stringContaining('contract report is approved')],
    });
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

/**
 * WI-2144027 — the identity labels must come from the PRODUCTION provision path.
 *
 * Every other test in this file hands the destroy runner a `desired` whose canary labels the test
 * itself wrote (the `labels` fixture at the top). That is exactly how the defect shipped: the only
 * writer of these keys anywhere in the tree was the fake-provider harness, so the suite was green
 * because the harness satisfied the gate on the product's behalf, while every real GCP canary was
 * born with no labels at all and could not be destroyed through the product route.
 *
 * These tests never write a canary label. They drive the real `POST /workspace-hosts/provision`
 * handler, capture the spec IT persisted, and feed exactly that into the real destroy runner — so
 * if the provision route stops synthesizing the labels, the round trip fails here.
 */
describe('canary identity survives provision → destroy (WI-2144027)', () => {
  const PROVISION_CTX: RouteContext = {
    principal: null,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
  };

  /** The fixture spec with the canary labels REMOVED — a caller never supplies them. */
  function requestedDesired(): Record<string, unknown> {
    const request: Record<string, unknown> = { ...(desired as unknown as Record<string, unknown>) };
    delete request.labels;
    return request;
  }

  async function provision(body: Record<string, unknown>): Promise<{
    response: Response;
    persisted?: WorkspaceHostDesiredSpec;
  }> {
    let persisted: WorkspaceHostDesiredSpec | undefined;
    const dependencies: WorkspaceHostProvisionRouteDependencies = {
      activeWorkspaceId: () => WORKSPACE_ID,
      provisioningAvailable: () => true,
      readConnection: async () => ({
        id: 'connection-1',
        target: 'gcp',
        status: 'connected' as const,
        connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' } },
      }),
      startProvisioning: async (input) => {
        persisted = input.desired;
        return {
          status: 'succeeded' as const,
          operationId: 'op-provision-1',
          hostId: 'host-1',
          plan: {
            planId: 'plan-1',
            operationId: 'op-provision-1',
            target: 'gcp' as const,
            hostId: 'host-1',
            generatedAt: NOW,
            steps: [],
            warnings: [],
          },
          checkpoints: [],
        };
      },
    };
    const response = await createWorkspaceHostProvisionRoute(dependencies).handler(
      new Request('http://operator.test/api/workspace-hosts/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      PROVISION_CTX,
    );
    return { response, persisted };
  }

  it('destroys a host whose labels the provision route wrote — this test writes none', async () => {
    const { response, persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Canary host',
      desired: requestedDesired(),
      canary: { runId: RUN_ID },
    });
    expect(response.status).toBe(201);
    // Derived by the operator from the declared run and its own workspace. Nothing in this file
    // supplied them, which is what makes the round trip below evidence rather than assertion.
    expect(persisted?.labels).toEqual({
      papercusp_canary: 'true',
      papercusp_run_id: RUN_ID,
      papercusp_workspace_id: WORKSPACE_ID,
    });

    const { provider } = providerHarness();
    const { store } = storeHarness(persisted!);
    const result = await runWorkspaceHostDestroy(runInput(provider, store));
    expect(result.status).toBe('succeeded');
  });

  // The falsifier. This is the exact state canary-13/14/15/16 were provisioned in, and the refusal
  // the destroy runner produced on real hardware at 2026-09-04T08:11:49Z.
  it('refuses the destroy when the provision declared no canary run — labels are never invented', async () => {
    const { response, persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Ordinary host',
      desired: requestedDesired(),
    });
    expect(response.status).toBe(201);
    expect(persisted?.labels).toBeUndefined();

    const { provider, apply } = providerHarness();
    const { store } = storeHarness(persisted!);
    await expect(runWorkspaceHostDestroy(runInput(provider, store))).rejects.toMatchObject({
      problems: [
        `stored desired.labels must contain 'papercusp_canary=true'`,
        `stored desired.labels must contain 'papercusp_run_id=${RUN_ID}'`,
        `stored desired.labels must contain 'papercusp_workspace_id=${WORKSPACE_ID}'`,
      ],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses a caller that hand-writes an identity label instead of declaring the run', async () => {
    const { response, persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Forged canary',
      desired: { ...requestedDesired(), labels: { papercusp_run_id: RUN_ID } },
      canary: { runId: RUN_ID },
    });
    expect(response.status).toBe(422);
    expect(persisted).toBeUndefined();
    await expect(response.json()).resolves.toMatchObject({
      problems: [expect.stringContaining(`desired.labels must not set 'papercusp_run_id'`)],
    });
  });

  it('binds the labels to the declared run, so a destroy citing another run still refuses', async () => {
    const { persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Canary host',
      desired: requestedDesired(),
      canary: { runId: 'canary_2' },
    });
    expect(persisted?.labels?.papercusp_run_id).toBe('canary_2');

    const { provider, apply } = providerHarness();
    const { store } = storeHarness(persisted!);
    await expect(runWorkspaceHostDestroy(runInput(provider, store))).rejects.toMatchObject({
      problems: [`stored desired.labels must contain 'papercusp_run_id=${RUN_ID}'`],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
