import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';
import {
  createWorkspaceHostConnectionRoute,
  workspaceHostConnectionId,
  type WorkspaceHostConnectionRouteDependencies,
} from './connection';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

function successfulInspection() {
  return {
    validation: {
      ok: true,
      checkedAt: '2026-08-28T00:00:00.000Z',
      identity: 'owner@example.test',
      warnings: [] as string[],
      errors: [] as string[],
    },
    scopes: [{ kind: 'project', id: 'paper-prod', label: 'paper-prod' }],
    regions: [
      { id: 'us-central1', label: 'Iowa', available: true, zones: ['us-central1-a'] },
      { id: 'offline', label: 'Offline', available: false },
    ],
    sizes: [
      { id: 'e2-small', label: 'e2-small', cpuCount: 2, memoryMiB: 4096, available: true },
      { id: 'old', label: 'old', cpuCount: 1, memoryMiB: 1024, available: false },
    ],
    images: [
      { id: 'projects/images/global/images/papercusp-v1', label: 'Papercusp v1', signed: true },
      { id: 'old-image', label: 'Old', signed: true, deprecated: true },
    ],
  };
}

function harness() {
  const upsertConnection = vi.fn<WorkspaceHostConnectionRouteDependencies['upsertConnection']>(async () => {});
  const inspectConnection = vi.fn<WorkspaceHostConnectionRouteDependencies['inspectConnection']>(async () =>
    successfulInspection(),
  );
  const readConnection = vi.fn<WorkspaceHostConnectionRouteDependencies['readConnection']>(async () => null);
  const dependencies: WorkspaceHostConnectionRouteDependencies = {
    activeWorkspaceId: () => 'ws-1',
    readConnection,
    upsertConnection,
    inspectConnection,
  };
  return { dependencies, inspectConnection, readConnection, upsertConnection };
}

async function post(dependencies: WorkspaceHostConnectionRouteDependencies, body: unknown): Promise<Response> {
  return createWorkspaceHostConnectionRoute(dependencies).handler(
    new Request('http://operator.test/api/workspace-hosts/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('POST /workspace-hosts/connection', () => {
  it('validates and persists the supported GCP connection with normalized catalog rows', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'Production GCP',
      credentialRef: 'adc://default',
      projectId: 'paper-prod',
      serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      connectionId: 'gcp:production-gcp',
      status: 'connected',
    });
    expect(inspectConnection).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      connectionId: 'gcp:production-gcp',
      connection: {
        target: 'gcp',
        cloudCredentialRef: { kind: 'cloud', ref: 'adc://default' },
        scope: { kind: 'project', id: 'paper-prod' },
        provider: {
          projectId: 'paper-prod',
          serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
        },
      },
    });
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        id: 'gcp:production-gcp',
        credentialRef: 'adc://default',
        status: 'connected',
        authenticatedIdentity: 'owner@example.test',
        scopes: [{ id: 'paper-prod', label: 'paper-prod' }],
        regions: [{ id: 'us-central1', label: 'Iowa', zones: ['us-central1-a'] }],
        sizes: [{ id: 'e2-small', label: 'e2-small', vcpu: 2, memoryGiB: 4 }],
        images: [{ id: 'projects/images/global/images/papercusp-v1', label: 'Papercusp v1' }],
        networks: [{ id: 'managed', label: 'Papercusp-managed private network' }],
      }),
    );
  });

  it('fails closed when a nominally successful validation proves no authenticated principal', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    inspectConnection.mockResolvedValueOnce({
      ...successfulInspection(),
      validation: {
        ok: true,
        checkedAt: '2026-08-28T00:00:00.000Z',
        warnings: [],
        errors: [],
      },
    });

    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'Production GCP',
      credentialRef: 'adc://default',
      projectId: 'paper-prod',
      serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
    });

    expect(response.status).toBe(422);
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'invalid',
        statusDetail: 'Provider validation did not return an authenticated identity.',
      }),
    );
  });

  it('admits the default Compute service-account identity used by GCP projects', async () => {
    const { dependencies, inspectConnection } = harness();
    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'BYOC Canary GCP',
      credentialRef: 'gcloud://active-user',
      projectId: 'active-alcove-504205-q3',
      serviceAccountEmail: '243118361453-compute@developer.gserviceaccount.com',
    });

    expect(response.status).toBe(200);
    expect(inspectConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          provider: expect.objectContaining({
            serviceAccountEmail: '243118361453-compute@developer.gserviceaccount.com',
          }),
        }),
      }),
    );
  });

  it('refreshes an existing connection from its stored raw reference instead of the masked UI row', async () => {
    const { dependencies, readConnection, inspectConnection, upsertConnection } = harness();
    readConnection.mockResolvedValueOnce({
      id: 'gcp:production-gcp',
      label: 'Production GCP',
      target: 'gcp',
      status: 'connected',
      connection: {
        target: 'gcp',
        cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
        provider: {
          projectId: 'paper-prod',
          serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
        },
      },
    });

    expect(
      await post(dependencies, {
        action: 'validate-connection',
        connectionId: 'gcp:production-gcp',
      }),
    ).toMatchObject({ status: 200 });
    expect(inspectConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
        }),
      }),
    );
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Production GCP', credentialRef: 'gcloud://active-user' }),
    );
  });

  it('persists an invalid status and returns typed recovery when validation fails', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    inspectConnection.mockResolvedValueOnce({
      validation: {
        ok: false,
        checkedAt: '2026-08-28T00:00:00.000Z',
        warnings: [],
        errors: ['Project permission is missing.'],
      },
      scopes: [],
      regions: [],
      sizes: [],
      images: [],
    });

    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'Production GCP',
      credentialRef: 'adc://default',
      projectId: 'paper-prod',
      serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'Project permission is missing.',
      problems: ['Project permission is missing.'],
    });
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'invalid', statusDetail: 'Project permission is missing.' }),
    );
  });

  it('rejects unsupported targets and malformed GCP identity before provider calls', async () => {
    const first = harness();
    expect(
      await post(first.dependencies, {
        action: 'connect',
        target: 'aws',
        label: 'AWS',
        credentialRef: 'resolver://aws',
      }),
    ).toMatchObject({ status: 501 });
    expect(first.inspectConnection).not.toHaveBeenCalled();

    const second = harness();
    expect(
      await post(second.dependencies, {
        action: 'connect',
        target: 'gcp',
        label: 'GCP',
        credentialRef: 'adc://default',
        projectId: '../bad',
        serviceAccountEmail: 'not-an-email',
      }),
    ).toMatchObject({ status: 400 });
    expect(second.inspectConnection).not.toHaveBeenCalled();
  });

  it('derives a stable retry-safe connection id from the target and label', () => {
    expect(workspaceHostConnectionId('gcp', '  Production / GCP  ')).toBe('gcp:production-gcp');
  });
});
