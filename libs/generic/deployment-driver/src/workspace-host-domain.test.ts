import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceHostReplacement,
  projectWorkspaceHostVendorControlMetadata,
  workspaceHostRuntimeRelease,
  type WorkspaceHostDomainState,
} from './workspace-host-domain';

const digest = 'a'.repeat(64);
const prior = (): WorkspaceHostDomainState => ({
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  hostGeneration: 1,
  connectionId: 'connection-1',
  desiredRevision: 7,
  observedRevision: 7,
  controllerAuthority: { controllerId: 'controller-a', fence: 3 },
});

describe('workspace-host D-295 domain boundary', () => {
  it('keeps Workspace/data identity stable while a replacement receives a new Host identity', () => {
    expect(() =>
      assertWorkspaceHostReplacement(prior(), {
        ...prior(),
        hostId: 'host-2',
        hostGeneration: 2,
        controllerAuthority: { controllerId: 'controller-b', fence: 4 },
      }),
    ).not.toThrow();

    expect(() =>
      assertWorkspaceHostReplacement(prior(), {
        ...prior(),
        workspaceId: 'workspace-other',
        hostId: 'host-2',
        hostGeneration: 2,
      }),
    ).toThrow(/preserve Workspace\/data identity/);
  });

  it('persists only the signed release identity and compatibility, never URLs or key material', () => {
    const persisted = workspaceHostRuntimeRelease(
      {
        version: '0.0.18-r21',
        bundleUrl: 'https://downloads.example.test/runtime.tar.zst',
        bundleSha256: digest,
        signatureUrl: 'https://downloads.example.test/runtime.tar.zst.minisig',
        signingPublicKey: 'RWQ public key material',
        signingKeySha256: digest,
      },
      'papercusp-workspace-host-bootstrap-v2',
      '1127',
    );

    expect(persisted).toEqual({
      version: '0.0.18-r21',
      bundleSha256: digest,
      signingKeySha256: digest,
      protocolVersion: 'papercusp-workspace-host-bootstrap-v2',
      schemaVersion: '1127',
    });
    expect(persisted).not.toHaveProperty('bundleUrl');
    expect(persisted).not.toHaveProperty('signatureUrl');
    expect(persisted).not.toHaveProperty('signingPublicKey');
  });

  it.each(['plan', 'workItem', 'prompt', 'transcript', 'source', 'modelInput', 'modelOutput', 'diagnostic']) (
    'fails closed when customer content field %s reaches the vendor metadata boundary',
    (field) => {
      expect(() => projectWorkspaceHostVendorControlMetadata({ workspaceId: 'workspace-1', [field]: 'customer data' }))
        .toThrow(/not allowlisted/);
    },
  );

  it('accepts only scalar fields from the explicit vendor control allowlist', () => {
    expect(
      projectWorkspaceHostVendorControlMetadata({
        workspaceId: 'workspace-1',
        hostId: 'host-2',
        desiredRevision: 8,
        controllerFence: 4,
        lifecycleState: 'running',
      }),
    ).toEqual({
      workspaceId: 'workspace-1',
      hostId: 'host-2',
      desiredRevision: 8,
      controllerFence: 4,
      lifecycleState: 'running',
    });
    expect(() => projectWorkspaceHostVendorControlMetadata({ workspaceId: { nested: true } })).toThrow(/must be scalar/);
  });
});
