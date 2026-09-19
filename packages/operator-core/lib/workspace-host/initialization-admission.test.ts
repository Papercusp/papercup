import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION, type WorkspaceHostInitializationRequest } from '@papercusp/deployment-driver';

const h = vi.hoisted(() => ({
  read: vi.fn(), profile: vi.fn(() => ({})), resolve: vi.fn(), begin: vi.fn(), run: vi.fn(),
}));
vi.mock('./observability-store', () => ({ readWorkspaceHostDesiredSpec: h.read, beginWorkspaceHostOperation: h.begin }));
vi.mock('./initialization-runner', () => ({ runWorkspaceHostInitialization: h.run }));
vi.mock('./credential-material-source', () => ({ createOperatorWorkspaceHostCredentialMaterialSource: () => ({}) }));
vi.mock('./initialization-operations-resolver', async (original) => ({
  ...await original<object>(),
  resolveWorkspaceHostInitializationControllerProfile: h.profile,
  resolveWorkspaceHostInitializationOperationsForHost: h.resolve,
}));

import { prepareWorkspaceHostInitialization, executeAdmittedWorkspaceHostInitialization } from './initialization-admission';

const input: Omit<WorkspaceHostInitializationRequest, 'deliveryCapabilities'> = {
  contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  workspaceId: 'ws-1', hostId: 'host-1', operationId: 'init-1', requestedAt: '2026-09-19T00:00:00Z',
  source: { kind: 'empty' as const },
  credentialRefs: { cloudCredentialRef: { kind: 'cloud' as const, ref: 'cloud-resolver:v1' } },
  credentialDelivery: { cloud: { kind: 'provider-identity' as const, generation: 1, audience: 'host-1', revocationRef: 'revoke-1' } },
};

describe('durable initialization admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.read.mockResolvedValue({ desired: { target: 'gcp' } });
    h.resolve.mockResolvedValue({ operations: {}, deliveryCapabilities: { fileTransfer: true } });
    h.run.mockResolvedValue({ operationId: input.operationId });
  });

  it('validates the public request without waiting for cloud host keys or probing credentials', async () => {
    expect(await prepareWorkspaceHostInitialization(input)).toMatchObject({ operationId: 'init-1', deliveryCapabilities: { fileTransfer: true } });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('rejects invalid contracts and secret-bearing input before durable enqueue', async () => {
    await expect(prepareWorkspaceHostInitialization({ ...input, source: { kind: 'invalid' } as never })).rejects.toThrow('request rejected');
    await expect(prepareWorkspaceHostInitialization({ ...input, publicMetadata: { password: 'never-persist' } })).rejects.toThrow('request rejected');
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('records transport discovery before remote I/O so an early failure has a durable operation', async () => {
    h.resolve.mockImplementationOnce(async () => {
      expect(h.begin).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'init-1', status: 'running', action: 'initialize' }));
      throw new Error('host keys unavailable');
    });
    const request = await prepareWorkspaceHostInitialization(input);
    await expect(executeAdmittedWorkspaceHostInitialization(request)).rejects.toThrow('host keys unavailable');
    expect(h.run).not.toHaveBeenCalled();
  });

  it('resolves material and transport inside execution and preserves the admitted identity', async () => {
    const request = await prepareWorkspaceHostInitialization(input);
    await expect(executeAdmittedWorkspaceHostInitialization(request)).resolves.toEqual({ status: 'succeeded', operationId: 'init-1', hostId: 'host-1' });
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ ...input, operations: {}, credentialMaterialSource: {} }));
  });
});
