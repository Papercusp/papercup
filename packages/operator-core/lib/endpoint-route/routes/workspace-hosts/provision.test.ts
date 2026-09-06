import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { RouteContext } from '../../define-route';
import { createWorkspaceHostProvisionRoute, type WorkspaceHostProvisionRouteDependencies } from './provision';
import { WorkspaceHostProvisioningConflictError } from '../../../dbos/workspace-host-provision-workflow';
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
} from '../../../workspace-host/provisioning-runner';
import type { WorkspaceHostRequestForwarder } from '../../../workspace-host/controller-forwarding';

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

function harness() {
  const startProvisioning = vi.fn<WorkspaceHostProvisionRouteDependencies['startProvisioning']>(async () => ({
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
      provider: {
        projectId: 'project-1',
        serviceAccountEmail: 'papercusp-host@project-1.iam.gserviceaccount.com',
      },
    },
  }));
  const dependencies: WorkspaceHostProvisionRouteDependencies = {
    activeWorkspaceId: () => 'ws-1',
    provisioningAvailable: () => true,
    readConnection,
    startProvisioning,
  };
  return { dependencies, readConnection, startProvisioning };
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

  it('fails with a typed 503 before durable reads when the DBOS executor is unavailable', async () => {
    const { dependencies, readConnection, startProvisioning } = harness();
    dependencies.provisioningAvailable = () => false;
    const forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async () => null);
    dependencies.forwardRequest = forwardRequest;

    const response = await post(dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workspace-host provisioning workflow is unavailable on this operator',
    });
    expect(forwardRequest).toHaveBeenCalledWith('/api/workspace-hosts/provision', {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(readConnection).not.toHaveBeenCalled();
    expect(startProvisioning).not.toHaveBeenCalled();
  });

  it('forwards a valid request to the DBOS controller and returns its response when local DBOS is unavailable', async () => {
    const { dependencies, readConnection, startProvisioning } = harness();
    dependencies.provisioningAvailable = () => false;
    const forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async (path, body) => {
      expect(path).toBe('/api/workspace-hosts/provision');
      expect(body).toEqual({ connectionId: 'connection-1', name: 'Host', desired, operationId: 'op-forward-1' });
      return Response.json(
        { ok: true, status: 'succeeded', operationId: 'op-forward-1', hostId: 'host-1' },
        { status: 201 },
      );
    });
    dependencies.forwardRequest = forwardRequest;

    const requestBody = {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
      operationId: 'op-forward-1',
    };
    const response = await post(dependencies, requestBody);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-forward-1',
      hostId: 'host-1',
    });
    expect(forwardRequest).toHaveBeenCalledOnce();
    expect(readConnection).not.toHaveBeenCalled();
    expect(startProvisioning).not.toHaveBeenCalled();
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
    const { dependencies, startProvisioning } = harness();
    const response = await post(dependencies, {
      connectionId: 'connection-1',
      name: 'Research host',
      desired: {
        ...desired,
        credentials: {
          cloudCredentialRef: { kind: 'cloud', ref: 'masked://configured' },
        },
        provider: { network: { mode: 'managed' }, zone: 'client-value-must-not-replace-provider-config' },
      },
      operationId: 'op-1',
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
    });
    expect(startProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        connectionId: 'connection-1',
        operationId: 'op-1',
        desired: {
          ...desired,
          credentials: {
            cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
          },
          provider: {
            network: { mode: 'managed' },
            zone: 'client-value-must-not-replace-provider-config',
            projectId: 'project-1',
            serviceAccountEmail: 'papercusp-host@project-1.iam.gserviceaccount.com',
          },
        },
        connection: expect.objectContaining({
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
          scope: { kind: 'project', id: 'project-1' },
          provider: {
            projectId: 'project-1',
            serviceAccountEmail: 'papercusp-host@project-1.iam.gserviceaccount.com',
          },
        }),
      }),
    );
  });

  it('returns a resumable 202 receipt without hiding retry timing', async () => {
    const { dependencies, startProvisioning } = harness();
    startProvisioning.mockResolvedValueOnce({
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
    rejected.startProvisioning.mockRejectedValueOnce(
      new WorkspaceHostProvisioningRequestError(['desired.zone must belong to desired.region']),
    );
    const rejectedResponse = await post(rejected.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(rejectedResponse.status).toBe(422);

    const unavailable = harness();
    unavailable.startProvisioning.mockRejectedValueOnce(
      new WorkspaceHostProvisioningConnectionError(['provider connection is not usable']),
    );
    expect(await post(unavailable.dependencies, { connectionId: 'connection-1', name: 'Host', desired })).toMatchObject(
      { status: 409 },
    );

    const internal = harness();
    internal.startProvisioning.mockRejectedValueOnce(new Error('secret-bearing internal detail'));
    const internalResponse = await post(internal.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(internalResponse.status).toBe(500);
    await expect(internalResponse.text()).resolves.not.toContain('secret-bearing internal detail');
  });

  it('maps a concurrent host-scoped DBOS admission refusal to 409', async () => {
    const conflict = harness();
    conflict.startProvisioning.mockRejectedValueOnce(new WorkspaceHostProvisioningConflictError('host-1'));

    const response = await post(conflict.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workspace host already has a provisioning operation in progress',
    });
  });
});
