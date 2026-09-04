import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION } from '@papercusp/deployment-driver';
import type { RouteContext } from '../../define-route';
import { createWorkspaceHostActionRoute, type WorkspaceHostActionRouteDependencies } from './action';
import { WorkspaceHostProvisioningConflictError } from '../../../dbos/workspace-host-provision-workflow';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const desired = {
  hostId: 'host-1',
  target: 'gcp' as const,
  scope: { kind: 'project', id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' } },
  labels: {
    papercusp_canary: 'true',
    papercusp_run_id: 'canary_1',
    papercusp_workspace_id: 'workspace_1',
  },
};

const canary = {
  runId: 'canary_1',
  workspaceId: 'workspace_1',
  contractApproval: {
    status: 'approved' as const,
    suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
    reportRef: 'report://gcp/fake-contract',
    approvedBy: 'operator:test',
    approvedAt: '2026-08-25T00:00:00.000Z',
  },
  teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
  budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
  preRunZeroBaseline: {
    cents: 0,
    observedAt: '2026-08-25T00:00:00.000Z',
    providerEvidenceRef: 'gcp://billing/baseline-zero',
  },
  costEvidence: [{ cents: 75, observedAt: '2026-08-25T00:10:00.000Z', providerEvidenceRef: 'gcp://billing/settled' }],
  lateObservedSpend: [{ cents: 1, observedAt: '2026-08-25T01:10:00.000Z', providerEvidenceRef: 'gcp://billing/late' }],
};

function harness() {
  const readTarget = vi.fn<WorkspaceHostActionRouteDependencies['readTarget']>(async () => ({
    id: 'host-1',
    name: 'Canary host',
    connectionId: 'connection-1',
    target: 'gcp',
    observedState: 'running',
    desired,
    resources: [],
  }));
  const readConnection = vi.fn<WorkspaceHostActionRouteDependencies['readConnection']>(async () => ({
    id: 'connection-1',
    target: 'gcp',
    status: 'connected',
    connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
  }));
  const startDestroy = vi.fn<WorkspaceHostActionRouteDependencies['startDestroy']>(async () => ({
    status: 'succeeded',
    operationId: 'op-destroy-1',
    hostId: 'host-1',
    plan: {
      planId: 'plan-destroy-1',
      operationId: 'op-destroy-1',
      target: 'gcp',
      hostId: 'host-1',
      generatedAt: '2026-08-25T00:00:00.000Z',
      steps: [],
      warnings: [],
    },
    checkpoints: [
      {
        logicalKey: 'delete-vm',
        state: 'absent',
        attempts: 1,
        deletionConfirmation: {
          hostId: 'host-1',
          providerResourceId: 'pc-host-vm',
          confirmedAbsentAt: '2026-08-25T00:10:00.000Z',
          source: 'provider-read',
        },
      },
    ],
  }));
  const startLifecycle = vi.fn<WorkspaceHostActionRouteDependencies['startLifecycle']>(async (input) => ({
    status: 'succeeded',
    operationId: input.operationId ?? 'op-lifecycle-1',
    hostId: input.action === 'restore' ? input.desired!.hostId : input.hostId,
    plan: {
      planId: `plan-${input.action}-1`,
      operationId: input.operationId ?? 'op-lifecycle-1',
      target: 'gcp',
      hostId: input.action === 'restore' ? input.desired!.hostId : input.hostId,
      generatedAt: '2026-08-25T00:00:00.000Z',
      steps: [],
      warnings: [],
    },
    checkpoints: [],
  }));
  const dependencies: WorkspaceHostActionRouteDependencies = {
    activeWorkspaceId: () => 'workspace_1',
    provisioningAvailable: () => true,
    readTarget,
    readConnection,
    startDestroy,
    startLifecycle,
  };
  return { dependencies, readTarget, readConnection, startDestroy, startLifecycle };
}

async function post(dependencies: WorkspaceHostActionRouteDependencies, body: unknown): Promise<Response> {
  const route = createWorkspaceHostActionRoute(dependencies);
  return route.handler(
    new Request('http://operator.test/api/workspace-hosts/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

const destroyBody = {
  action: 'destroy',
  workspaceId: 'host-1',
  disposition: 'discard',
  operationId: 'op-destroy-1',
  confirmation: {
    expectedHostId: 'host-1',
    confirmedBy: 'operator:test',
    confirmedAt: '2026-08-25T00:00:00.000Z',
  },
  canary,
};

beforeEach(() => vi.clearAllMocks());

describe('POST /workspace-hosts/action destroy', () => {
  it('admits discard through the stored connection and returns provider-read receipts', async () => {
    const { dependencies, startDestroy } = harness();
    const response = await post(dependencies, destroyBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-destroy-1',
      resources: [{ state: 'absent', deletionConfirmation: { source: 'provider-read' } }],
    });
    expect(startDestroy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace_1',
        hostId: 'host-1',
        connectionId: 'connection-1',
        disposition: 'discard',
        canary,
      }),
    );
  });

  it('rejects non-discard and missing canary evidence before durable reads', async () => {
    const { dependencies, readTarget } = harness();
    const snapshot = await post(dependencies, { ...destroyBody, disposition: 'snapshot' });
    expect(snapshot.status).toBe(422);
    const missing = await post(dependencies, { ...destroyBody, canary: undefined });
    expect(missing.status).toBe(400);
    expect(readTarget).not.toHaveBeenCalled();
  });

  // WI-2143805: a run that FAILED cannot produce an approved contract report, settled cumulative
  // cost, or a provider-delayed spend entry, so requiring them refused teardown for exactly the
  // hosts that most needed it. The route admits an audited failedRunTeardown in their place — and
  // only in their place.
  it('admits a failed-run teardown that carries no economic evidence, and refuses one carrying both authorizations', async () => {
    const { dependencies, startDestroy } = harness();
    const failedRunTeardown = {
      actorId: 'operator:test',
      reason: 'canary run failed during bootstrap; the host must still be torn down',
      procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
      failedOperationIds: ['op-run-1'],
    };
    const { contractApproval: _approval, lateObservedSpend: _late, ...base } = canary;
    const failedRunCanary = { ...base, costEvidence: [], failedRunTeardown };

    const admitted = await post(dependencies, { ...destroyBody, canary: failedRunCanary });
    expect(admitted.status).toBe(200);
    expect(startDestroy).toHaveBeenCalledWith(expect.objectContaining({ canary: failedRunCanary }));

    // Presenting an approved report AND claiming the run failed would leave the audit record unable
    // to say which evidence the destroy was admitted on.
    const both = await post(dependencies, {
      ...destroyBody,
      canary: { ...canary, failedRunTeardown },
    });
    expect(both.status).toBe(400);

    // Still not a blanket waiver: the audit context itself has to be complete.
    const unnamed = await post(dependencies, {
      ...destroyBody,
      canary: { ...failedRunCanary, failedRunTeardown: { ...failedRunTeardown, failedOperationIds: [] } },
    });
    expect(unnamed.status).toBe(400);
  });

  it('maps the host-scoped DBOS dedup conflict to 409 without leaking internals', async () => {
    const { dependencies, startDestroy } = harness();
    startDestroy.mockRejectedValueOnce(new WorkspaceHostProvisioningConflictError('host-1'));

    const response = await post(dependencies, destroyBody);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workspace host already has an operation in progress',
    });
  });
});

describe('POST /workspace-hosts/action existing-host lifecycle', () => {
  it.each(['start', 'stop', 'restart', 'repair', 'snapshot'] as const)(
    'admits %s through the stored connection and durable lifecycle workflow',
    async (action) => {
      const { dependencies, startLifecycle } = harness();
      const response = await post(dependencies, { action, workspaceId: 'host-1', operationId: `op-${action}-1` });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: 'succeeded',
        operationId: `op-${action}-1`,
        hostId: 'host-1',
      });
      expect(startLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          workspaceId: 'workspace_1',
          hostId: 'host-1',
          operationId: `op-${action}-1`,
          connection: expect.objectContaining({ target: 'gcp', scope: desired.scope }),
        }),
      );
    },
  );

  it('threads explicit upgrade and restore inputs without inventing provider defaults', async () => {
    const { dependencies, startLifecycle } = harness();
    const image = { id: 'projects/images/global/images/papercusp-v2', version: '2' };
    const upgrade = await post(dependencies, {
      action: 'upgrade',
      workspaceId: 'host-1',
      image,
      rollbackImage: desired.image,
    });
    expect(upgrade.status).toBe(200);
    expect(startLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'upgrade', image, rollbackImage: desired.image }),
    );

    const restored = { ...desired, hostId: 'host-restored-1' };
    const snapshot = { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' };
    const restore = await post(dependencies, {
      action: 'restore',
      workspaceId: 'host-1',
      snapshot,
      desired: restored,
    });
    expect(restore.status).toBe(200);
    await expect(restore.json()).resolves.toMatchObject({ hostId: 'host-restored-1' });
    expect(startLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'restore', snapshot, desired: restored }),
    );
  });
});
