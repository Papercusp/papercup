import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION, type WorkspaceHostInitializationRequest } from '@papercusp/deployment-driver';

const h = vi.hoisted(() => ({
  read: vi.fn(), profile: vi.fn(() => ({})), resolve: vi.fn(), begin: vi.fn(), run: vi.fn(),
  append: vi.fn(), update: vi.fn(), execute: vi.fn(), ready: vi.fn(),
  replay: vi.fn(async (_identity: unknown, run: () => Promise<unknown>) => run()),
}));
vi.mock('./observability-store', () => ({ readWorkspaceHostDesiredSpec: h.read, beginWorkspaceHostOperation: h.begin, appendWorkspaceHostEvent: h.append, updateWorkspaceHostOperation: h.update }));
vi.mock('./initialization-replay-store', () => ({ createWorkspaceHostInitializationReplayStore: () => ({ runOnce: h.replay }) }));
vi.mock('./initialization-runner', () => ({ runWorkspaceHostInitialization: h.run }));
vi.mock('./credential-material-source', () => ({ createOperatorWorkspaceHostCredentialMaterialSource: () => ({}) }));
vi.mock('./initialization-operations-resolver', async (original) => ({
  ...await original<object>(),
  resolveWorkspaceHostInitializationControllerProfile: h.profile,
  resolveWorkspaceHostInitializationOperationsForHost: h.resolve,
}));

import { prepareWorkspaceHostInitialization, executeAdmittedWorkspaceHostInitialization, prepareWorkspaceHostDesktopPack, executeAdmittedWorkspaceHostDesktopPack } from './initialization-admission';

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

  it('executes only the fixed desktop step through the replay store and records installation evidence', async () => {
    const request = await prepareWorkspaceHostDesktopPack({
      workspaceId: 'ws-1', hostId: 'host-1', operationId: 'pack-1', requestedAt: input.requestedAt, action: 'install-desktop-pack',
    });
    h.resolve.mockResolvedValueOnce({ operations: { execute: h.execute, awaitBootstrapReady: h.ready } });
    h.execute.mockResolvedValueOnce({ observedAt: input.requestedAt, publicEvidence: { hostId: 'host-1', status: 'healthy' } });
    expect(await executeAdmittedWorkspaceHostDesktopPack(request)).toMatchObject({ status: 'succeeded', operationId: 'pack-1' });
    expect(h.execute).toHaveBeenCalledWith({ id: 'desktop-pack', kind: 'install-desktop-pack', dependsOn: [], idempotencyKey: 'pack-1:desktop-pack', input: { hostId: 'host-1' } });
    expect(h.replay).toHaveBeenCalledWith({ idempotencyKey: 'pack-1:desktop-pack', stepFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }, expect.any(Function));
    expect(h.append).toHaveBeenCalledWith(expect.objectContaining({ phase: 'desktop-pack:installed', details: { publicEvidence: { hostId: 'host-1', status: 'healthy' } } }));
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('desktop session acceptance is separate'), status: 'succeeded' }));
    expect(h.run).not.toHaveBeenCalled();
  });

  it('reuses a persisted pack receipt without running the installer again', async () => {
    h.resolve.mockResolvedValueOnce({ operations: { execute: h.execute } });
    h.replay.mockResolvedValueOnce({ stepId: 'desktop-pack', status: 'succeeded', observedAt: input.requestedAt });
    await executeAdmittedWorkspaceHostDesktopPack({ workspaceId: 'ws-1', hostId: 'host-1', operationId: 'pack-1', requestedAt: input.requestedAt, action: 'install-desktop-pack' });
    expect(h.execute).not.toHaveBeenCalled();
  });
});
