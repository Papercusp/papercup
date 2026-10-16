import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostHealthAttestation, WorkspaceHostProvider } from '@papercusp/deployment-driver';
import { refreshHostedPoolObservation } from './hosted-lifecycle-store';
import type { StoredWorkspaceHostConnection, StoredWorkspaceHostDestroyTarget } from './observability-store';

function fixture() {
  const target = {
    id: 'host-a', connectionId: 'connection-a', hostGeneration: 2, desiredRevision: 3, observedRevision: 3,
    controllerAuthority: { controllerId: 'controller-a', fence: 9 },
    runtimeRelease: { bundleSha256: 'a'.repeat(64) },
    desired: { scope: { kind: 'project', id: 'project-a' }, region: 'us-central1', zone: 'us-central1-a',
      size: 'size-a', image: { id: 'image-a' } },
  } as StoredWorkspaceHostDestroyTarget;
  const attestation = { hostId: 'host-a', status: 'healthy', observedAt: new Date().toISOString(), checks: [] } as WorkspaceHostHealthAttestation;
  const readTarget = vi.fn(async () => target);
  const readConnection = vi.fn(async () => ({ connection: { target: 'gcp' } }) as StoredWorkspaceHostConnection);
  const listSizes = vi.fn(async () => [{ id: 'size-a', available: true, cpuCount: 4, memoryMiB: 8192, architectures: ['x86_64'] }]);
  const listImages = vi.fn(async () => [{ id: 'image-a', architecture: 'x86_64' }]);
  const record = vi.fn(async () => {});
  const deps = { readTarget, readConnection, record,
    resolveProvider: () => ({ listSizes, listImages }) as unknown as WorkspaceHostProvider };
  return { target, attestation, readTarget, listSizes, listImages, record, deps,
    run: () => refreshHostedPoolObservation({ workspaceId: 'control-a', controllerId: 'controller-a', attestation }, deps) };
}

describe('standing controller pool observations', () => {
  it('records catalog capacity and the exact controller generation/revision/runtime without claiming clean tenancy', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ generation: 2, desiredRevision: 3, controllerFence: 9,
      architecture: 'x86_64', size: { cpuCount: 4, memoryMiB: 8192 }, cleanAttestationRef: null,
      runtimeBundleSha256: 'a'.repeat(64), observedAtMs: Date.parse(f.attestation.observedAt) });
    expect(f.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workspaceId: 'control-a', hostId: 'host-a', controllerId: 'controller-a' }));
  });

  it.each(['unhealthy', 'foreign-controller', 'unconverged', 'no-runtime', 'no-zone'])(
    'does not publish eligibility for %s state', async kind => {
      const f = fixture();
      if (kind === 'unhealthy') f.attestation.status = 'unreachable';
      if (kind === 'foreign-controller') f.target.controllerAuthority!.controllerId = 'other';
      if (kind === 'unconverged') f.target.observedRevision = 2;
      if (kind === 'no-runtime') delete f.target.runtimeRelease;
      if (kind === 'no-zone') delete f.target.desired.zone;
      expect(await f.run()).toBeNull();
      expect(f.listSizes).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
    });

  it('does not guess architecture when the image catalog did not measure it', async () => {
    const f = fixture();
    f.listImages.mockResolvedValue([{ id: 'image-a', architecture: '' }]);
    expect(await f.run()).toBeNull();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('surfaces a fencing refusal if controller authority changed while the catalog was read', async () => {
    const f = fixture();
    f.record.mockRejectedValue(new Error('hosted_pool_observation_fenced_or_stale'));
    await expect(f.run()).rejects.toThrow('fenced_or_stale');
  });
});
