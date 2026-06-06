import { describe, it, expect } from 'vitest';
import type { DeploymentConfig, DeploymentContext, Frame } from '@papercusp/deployment-driver';
import {
  generateFrameDeviceIdentity,
  makeHeadlessJoinHook,
  revokeFrameOnTeardown,
  loggingHeadlessPeerAdmission,
  type HeadlessPeerAdmission,
} from './headless-peer';

const cfg: DeploymentConfig = { target: 'latitude' };
const ctx: DeploymentContext = { harnessSlug: 'papercup', workspaceId: 'ws' };

function recordingAdmission() {
  const admitted: Array<{ frameId: string; devicePubkeyBase64: string }> = [];
  const revoked: Array<{ frameId: string; devicePubkeyBase64?: string }> = [];
  const admission: HeadlessPeerAdmission = {
    async admit(i) {
      admitted.push({ frameId: i.frameId, devicePubkeyBase64: i.devicePubkeyBase64 });
    },
    async revoke(i) {
      revoked.push({ frameId: i.frameId, devicePubkeyBase64: i.devicePubkeyBase64 });
    },
  };
  return { admission, admitted, revoked };
}

describe('generateFrameDeviceIdentity', () => {
  it('mints a raw-32-byte base64 Ed25519 pubkey + a pkcs8 PEM private key', () => {
    const id = generateFrameDeviceIdentity();
    expect(Buffer.from(id.devicePubkeyBase64, 'base64')).toHaveLength(32);
    expect(id.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });
  it('is unique per call', () => {
    expect(generateFrameDeviceIdentity().devicePubkeyBase64).not.toBe(generateFrameDeviceIdentity().devicePubkeyBase64);
  });
});

describe('makeHeadlessJoinHook', () => {
  it('mints + records a device pubkey on the frame and admits it', async () => {
    const { admission, admitted } = recordingAdmission();
    const hook = makeHeadlessJoinHook(admission);
    const frame: Frame = { id: 'sv_1', target: 'latitude', placement: 'remote' };
    await hook(frame, cfg, ctx);
    expect(frame.meta?.devicePubkey).toBeTruthy();
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ frameId: 'sv_1', devicePubkeyBase64: frame.meta!.devicePubkey });
  });

  it('is idempotent — re-admits an existing pubkey, does not re-key', async () => {
    const { admission, admitted } = recordingAdmission();
    const hook = makeHeadlessJoinHook(admission);
    const frame: Frame = { id: 'sv_1', target: 'latitude', placement: 'remote', meta: { devicePubkey: 'PRESET' } };
    await hook(frame, cfg, ctx);
    expect(frame.meta?.devicePubkey).toBe('PRESET');
    expect(admitted[0].devicePubkeyBase64).toBe('PRESET');
  });
});

describe('revokeFrameOnTeardown', () => {
  it('revokes the frame device pubkey', async () => {
    const { admission, revoked } = recordingAdmission();
    await revokeFrameOnTeardown({ id: 'sv_9', target: 'latitude', placement: 'remote', meta: { devicePubkey: 'PK' } }, 'papercup', 'ws', admission);
    expect(revoked).toEqual([{ frameId: 'sv_9', devicePubkeyBase64: 'PK' }]);
  });
});

describe('loggingHeadlessPeerAdmission', () => {
  it('admit/revoke resolve without throwing', async () => {
    const a = loggingHeadlessPeerAdmission();
    await expect(a.admit({ frameId: 'x', devicePubkeyBase64: 'k', harnessSlug: 'h', workspaceId: 'w' })).resolves.toBeUndefined();
    await expect(a.revoke({ frameId: 'x', harnessSlug: 'h', workspaceId: 'w' })).resolves.toBeUndefined();
  });
});
