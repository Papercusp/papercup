import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
} from '../../identity/ed25519';
import {
  createPhysicalDrillHostReceipt,
  physicalDrillSigningBytes,
  resolvePhysicalDrillHostIdentity,
  validatePhysicalDrillHostReceipt,
  type PhysicalDrillHostIdentity,
} from './physical-drill-host-receipt';
import {
  finalizePhysicalDrillArtifacts,
  preflightPhysicalDrillHosts,
  samePhysicalDrillPath,
} from './physical-drill-producer';

function evidence(deviceKey: string): Record<string, unknown> {
  return {
    schemaVersion: 'hive-git-physical-evidence/v2',
    plan: 'p2p-git-live-activation-2026-07-09',
    runId: 'physical-run-receipt-test',
    window: {
      startedAt: '2026-08-13T12:00:00.000Z',
      finishedAt: '2026-08-13T12:30:00.000Z',
    },
    topology: {
      kind: 'two-physical-machines',
      hosts: [
        { id: 'tower', deviceKey },
        { id: 'vm', deviceKey: Buffer.alloc(32, 9).toString('base64') },
      ],
    },
  };
}

describe('physical drill keychain-bound host receipt', () => {
  it('recognizes the macOS /tmp alias as the same direct CLI module path', () => {
    const macRealpath = (path: string): string => path.replace(/^\/tmp\//, '/private/tmp/');
    expect(samePhysicalDrillPath(
      '/tmp/hive-git-physical-source.123/packages/operator-core/lib/sync/pot-git/physical-drill-producer.ts',
      '/private/tmp/hive-git-physical-source.123/packages/operator-core/lib/sync/pot-git/physical-drill-producer.ts',
      macRealpath,
    )).toBe(true);
    expect(samePhysicalDrillPath('/tmp/producer.ts', '/private/tmp/other.ts', macRealpath)).toBe(false);
  });

  it('resolves only an existing cached announce identity and stable machine fingerprint', async () => {
    const device = generateEd25519KeypairDer();
    const loadIdentity = vi.fn(async () => ({
      keychainId: '4242:tower-machine',
      devicePubkeyBase64: device.pubkeyBase64,
      githubUserId: 4242,
      githubLogin: 'tower-owner',
      attestationGistId: 'gist-1',
    }));
    const resolveMachineFingerprint = vi.fn(async () => 'a'.repeat(64));

    await expect(resolvePhysicalDrillHostIdentity({
      hostId: 'tower',
      cachePath: '/real/shared/local-announce-identity.json',
      loadIdentity,
      resolveMachineFingerprint,
    })).resolves.toEqual({
      schemaVersion: 'hive-git-physical-host-identity/v1',
      hostId: 'tower',
      deviceKey: device.pubkeyBase64,
      keychainId: '4242:tower-machine',
      githubUserId: 4242,
      githubLogin: 'tower-owner',
      machineFingerprint: 'a'.repeat(64),
    });
    expect(loadIdentity).toHaveBeenCalledOnce();
    expect(resolveMachineFingerprint).toHaveBeenCalledOnce();
  });

  it('fails closed when the cache cannot be re-verified against an existing keychain key', async () => {
    const resolveMachineFingerprint = vi.fn(async () => 'a'.repeat(64));
    await expect(resolvePhysicalDrillHostIdentity({
      hostId: 'tower',
      cachePath: '/synthetic/local-announce-identity.json',
      loadIdentity: async () => null,
      resolveMachineFingerprint,
    })).rejects.toThrow('cached announce identity/keychain mismatch');
    expect(resolveMachineFingerprint).not.toHaveBeenCalled();
  });

  it('rejects a local-only pair that reuses one physical machine fingerprint', () => {
    const tower = generateEd25519KeypairDer();
    const vm = generateEd25519KeypairDer();
    expect(() => preflightPhysicalDrillHosts([
      {
        schemaVersion: 'hive-git-physical-host-identity/v1',
        hostId: 'tower',
        deviceKey: tower.pubkeyBase64,
        keychainId: '4242:tower',
        githubUserId: 4242,
        githubLogin: 'tower-owner',
        machineFingerprint: 'a'.repeat(64),
      },
      {
        schemaVersion: 'hive-git-physical-host-identity/v1',
        hostId: 'vm',
        deviceKey: vm.pubkeyBase64,
        keychainId: '4243:vm',
        githubUserId: 4243,
        githubLogin: 'vm-owner',
        machineFingerprint: 'a'.repeat(64),
      },
    ])).toThrow('two physical hosts must have distinct machineFingerprint values');
  });

  it('refuses a scenario manifest that tries to supply pre-banked attestations', () => {
    const device = generateEd25519KeypairDer();
    const rawEvidence = {
      ...evidence(device.pubkeyBase64),
      attestations: [{
        deviceKey: device.pubkeyBase64,
        signature: Buffer.alloc(64).toString('base64'),
      }],
    };
    expect(() => finalizePhysicalDrillArtifacts({
      evidence: rawEvidence,
      receipts: [],
    })).toThrow('scenario output must not contain pre-banked attestations');
  });

  it('signs the exact evidence bytes and a host/device/machine binding with the same device key', async () => {
    const device = generateEd25519KeypairDer();
    const identity: PhysicalDrillHostIdentity = {
      schemaVersion: 'hive-git-physical-host-identity/v1',
      hostId: 'tower',
      deviceKey: device.pubkeyBase64,
      keychainId: '4242:tower-machine',
      githubUserId: 4242,
      githubLogin: 'tower-owner',
      machineFingerprint: 'a'.repeat(64),
    };
    const rawEvidence = evidence(device.pubkeyBase64);
    const receipt = await createPhysicalDrillHostReceipt({
      evidence: rawEvidence,
      identity,
      signedAt: new Date('2026-08-13T12:30:30.000Z'),
      sign: async (_keychainId, bytes) => signWithPrivateKeyDer(device.privateKeyDer, bytes),
    });

    expect(receipt.evidenceSigningSha256).toBe(
      createHash('sha256').update(physicalDrillSigningBytes(rawEvidence)).digest('hex'),
    );
    expect(validatePhysicalDrillHostReceipt(receipt, rawEvidence)).toMatchObject({
      ok: true,
      errors: [],
    });
  });

  it('rejects evidence changed after the physical host signed it', async () => {
    const device = generateEd25519KeypairDer();
    const rawEvidence = evidence(device.pubkeyBase64);
    const receipt = await createPhysicalDrillHostReceipt({
      evidence: rawEvidence,
      identity: {
        schemaVersion: 'hive-git-physical-host-identity/v1',
        hostId: 'tower',
        deviceKey: device.pubkeyBase64,
        keychainId: '4242:tower-machine',
        githubUserId: 4242,
        githubLogin: 'tower-owner',
        machineFingerprint: 'a'.repeat(64),
      },
      signedAt: new Date('2026-08-13T12:30:30.000Z'),
      sign: async (_keychainId, bytes) => signWithPrivateKeyDer(device.privateKeyDer, bytes),
    });
    (rawEvidence.window as Record<string, unknown>).finishedAt = '2026-08-13T12:31:00.000Z';

    const verdict = validatePhysicalDrillHostReceipt(receipt, rawEvidence);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'host receipt evidenceSigningSha256 must match the canonical evidence bytes',
    );
  });

  it('refuses a banked run whose signing happens outside the ten-minute completion grace', async () => {
    const device = generateEd25519KeypairDer();
    await expect(createPhysicalDrillHostReceipt({
      evidence: evidence(device.pubkeyBase64),
      identity: {
        schemaVersion: 'hive-git-physical-host-identity/v1',
        hostId: 'tower',
        deviceKey: device.pubkeyBase64,
        keychainId: '4242:tower-machine',
        githubUserId: 4242,
        githubLogin: 'tower-owner',
        machineFingerprint: 'a'.repeat(64),
      },
      signedAt: new Date('2026-08-13T12:40:00.001Z'),
      sign: async (_keychainId, bytes) => signWithPrivateKeyDer(device.privateKeyDer, bytes),
    })).rejects.toThrow('within 10 minutes of its finish');
  });
});
