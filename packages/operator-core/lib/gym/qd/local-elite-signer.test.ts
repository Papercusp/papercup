import { describe, it, expect } from 'vitest';
import { resolveLocalEliteOutcomeSigner } from './local-elite-signer';
import type { LocalAnnounceIdentity } from '../../sync/hyperbee/local-announce-identity';

const fakeIdentity = (over: Partial<LocalAnnounceIdentity> = {}): LocalAnnounceIdentity => ({
  keychainId: '4242:test-machine',
  devicePubkeyBase64: 'PUBKEY==',
  githubUserId: 4242,
  githubLogin: 'alice',
  attestationGistId: 'gist',
  ...over,
});

describe('resolveLocalEliteOutcomeSigner', () => {
  it('binds the signer pubkey to the resolved announce device (anti-lift parity)', async () => {
    const signer = await resolveLocalEliteOutcomeSigner(async () => fakeIdentity());
    expect(signer).toBeDefined();
    // The stamped pubkey MUST equal the announce device pubkey, so the receiver's
    // resolveAuthorDevice(ourLog) → this same key verifies the record.
    expect(signer!.devicePubkeyBase64).toBe('PUBKEY==');
  });

  it('sign() delegates to signWithDeviceKey under the resolved keychainId', async () => {
    const signer = await resolveLocalEliteOutcomeSigner(async () =>
      fakeIdentity({ keychainId: 'kc-absent-9f3c' }),
    );
    // No such key in the keychain → signWithDeviceKey throws naming the keychainId,
    // proving the closure delegated to it with the resolved id (not a fixed/wrong id).
    await expect(signer!.sign(Buffer.from('outcome-bytes'))).rejects.toThrow(/kc-absent-9f3c/);
  });

  it('returns undefined when no local identity is available → federate tier-1 (unsigned)', async () => {
    expect(await resolveLocalEliteOutcomeSigner(async () => null)).toBeUndefined();
  });

  it('returns undefined (never throws) when the identity loader itself fails', async () => {
    expect(
      await resolveLocalEliteOutcomeSigner(async () => {
        throw new Error('keychain blip');
      }),
    ).toBeUndefined();
  });
});
