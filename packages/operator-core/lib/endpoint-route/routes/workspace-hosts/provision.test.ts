import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostDesiredSpec, WorkspaceHostProvider } from '@papercusp/deployment-driver';
import type { RouteContext } from '../../define-route';
import { createWorkspaceHostProvisionRoute, type WorkspaceHostProvisionRouteDependencies } from './provision';
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
} from '../../../workspace-host/provisioning-runner';

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
};

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const provider = { target: 'gcp' } as unknown as WorkspaceHostProvider;

function harness() {
  const runProvisioning = vi.fn<WorkspaceHostProvisionRouteDependencies['runProvisioning']>(async () => ({
    status: 'succeeded' as const,
    operationId: 'op-1',
    hostId: 'host-1',
    plan: {
      planId: 'plan-1',
      operationId: 'op-1',
      target: 'gcp',
      hostId: 'host-1',
      generatedAt: '2026-08-25T00:00:00Z',
      steps: [],
      warnings: [],
    },
    checkpoints: [],
  }));
  const readConnection = vi.fn<WorkspaceHostProvisionRouteDependencies['readConnection']>(async () => ({
    id: 'connection-1',
    target: 'gcp',
    status: 'connected' as const,
    connection: {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' },
    },
  }));
  const dependencies: WorkspaceHostProvisionRouteDependencies = {
    activeWorkspaceId: () => 'ws-1',
    readConnection,
    createGcpProvider: () => provider,
    runProvisioning,
  };
  return { dependencies, readConnection, runProvisioning };
}

async function post(dependencies: WorkspaceHostProvisionRouteDependencies, body: unknown): Promise<Response> {
  const route = createWorkspaceHostProvisionRoute(dependencies);
  return route.handler(
    new Request('http://operator.test/api/workspace-hosts/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /workspace-hosts/provision', () => {
  it('rejects malformed request identity before reading durable state', async () => {
    const { dependencies, readConnection } = harness();
    const response = await post(dependencies, { connectionId: '../bad', name: '', desired: {} });
    expect(response.status).toBe(400);
    expect(readConnection).not.toHaveBeenCalled();
  });

  it('distinguishes a missing connection from one that is not ready', async () => {
    const missing = harness();
    missing.readConnection.mockResolvedValueOnce(null);
    expect(await post(missing.dependencies, { connectionId: 'connection-1', name: 'Host', desired })).toMatchObject({
      status: 404,
    });

    const degraded = harness();
    degraded.readConnection.mockResolvedValueOnce({
      id: 'connection-1',
      target: 'gcp',
      status: 'degraded',
      statusDetail: 'ADC refresh required',
      connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
    });
    const response = await post(degraded.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('composes the selected connection with desired scope and returns 201 on completion', async () => {
    const { dependencies, runProvisioning } = harness();
    const response = await post(dependencies, {
      connectionId: 'connection-1',
      name: 'Research host',
      desired,
      operationId: 'op-1',
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
    });
    expect(runProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        connectionId: 'connection-1',
        operationId: 'op-1',
        desired,
        provider,
        connection: {
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
          scope: { kind: 'project', id: 'project-1' },
        },
      }),
    );
  });

  it('returns a resumable 202 receipt without hiding retry timing', async () => {
    const { dependencies, runProvisioning } = harness();
    runProvisioning.mockResolvedValueOnce({
      status: 'in-progress',
      operationId: 'op-1',
      hostId: 'host-1',
      plan: {
        planId: 'plan-1',
        operationId: 'op-1',
        target: 'gcp',
        hostId: 'host-1',
        generatedAt: '2026-08-25T00:00:00Z',
        steps: [],
        warnings: [],
      },
      checkpoints: [{ logicalKey: 'create-instance', state: 'retry-wait', attempts: 1 }],
      retryAfterMs: 7_500,
    });

    const response = await post(dependencies, { connectionId: 'connection-1', name: 'Host', desired });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'in-progress',
      retryAfterMs: 7_500,
      resources: [{ logicalKey: 'create-instance', state: 'retry-wait', attempts: 1 }],
    });
  });

  it('maps unsupported targets and typed runner refusals without echoing internal failures', async () => {
    const unsupported = harness();
    unsupported.readConnection.mockResolvedValueOnce({
      id: 'connection-1',
      target: 'aws',
      status: 'connected',
      connection: { target: 'aws', cloudCredentialRef: { kind: 'cloud', ref: 'resolver://aws' } },
    });
    const awsDesired = { ...desired, target: 'aws' };
    expect(
      await post(unsupported.dependencies, {
        connectionId: 'connection-1',
        name: 'Host',
        desired: awsDesired,
      }),
    ).toMatchObject({ status: 501 });

    const rejected = harness();
    rejected.runProvisioning.mockRejectedValueOnce(
      new WorkspaceHostProvisioningRequestError(['desired.zone must belong to desired.region']),
    );
    const rejectedResponse = await post(rejected.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(rejectedResponse.status).toBe(422);

    const unavailable = harness();
    unavailable.runProvisioning.mockRejectedValueOnce(
      new WorkspaceHostProvisioningConnectionError(['provider connection is not usable']),
    );
    expect(await post(unavailable.dependencies, { connectionId: 'connection-1', name: 'Host', desired })).toMatchObject(
      { status: 409 },
    );

    const internal = harness();
    internal.runProvisioning.mockRejectedValueOnce(new Error('secret-bearing internal detail'));
    const internalResponse = await post(internal.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(internalResponse.status).toBe(500);
    await expect(internalResponse.text()).resolves.not.toContain('secret-bearing internal detail');
  });
});
