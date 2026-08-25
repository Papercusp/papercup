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
  const dependencies: WorkspaceHostActionRouteDependencies = {
    activeWorkspaceId: () => 'workspace_1',
    provisioningAvailable: () => true,
    readTarget,
    readConnection,
    startDestroy,
  };
  return { dependencies, readTarget, readConnection, startDestroy };
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
