/**
 * signWithDeviceKey — Ed25519 signing through the keychain-held private key.
 *
 * The keychain itself is covered by keychain.test.ts; here we mock it to a
 * known PKCS8 key and assert the crypto contract: a real, 64-byte Ed25519
 * signature that verifies under the matching public key, fails under any
 * other key or tampered bytes, and that a missing key throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, verify as nodeVerify, type KeyObject } from 'node:crypto';

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('./keychain'));

function makeKeypair(): { pkcs8Der: Buffer; publicKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pkcs8Der: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer, publicKey };
}

async function loadSigner(keychainLoad: ReturnType<typeof vi.fn>) {
  vi.doMock('./keychain', () => ({ keychainLoad }));
  const { signWithDeviceKey } = await import('./sign-with-device-key');
  return signWithDeviceKey;
}

const ok = (pkcs8Der: Buffer) => vi.fn(async () => ({ kind: 'ok', value: pkcs8Der }));

describe('signWithDeviceKey', () => {
  it('produces a 64-byte Ed25519 signature that verifies under the matching public key', async () => {
    const { pkcs8Der, publicKey } = makeKeypair();
    const sign = await loadSigner(ok(pkcs8Der));
    const bytes = Buffer.from('announce-payload');
    const sig = await sign('kc-id', bytes);
    expect(Buffer.isBuffer(sig)).toBe(true);
    expect(sig.length).toBe(64);
    expect(nodeVerify(null, bytes, publicKey, sig)).toBe(true);
  });

  it('signature does NOT verify under a different key (no cross-key acceptance)', async () => {
    const a = makeKeypair();
    const b = makeKeypair();
    const sign = await loadSigner(ok(a.pkcs8Der));
    const bytes = Buffer.from('x');
    const sig = await sign('id', bytes);
    expect(nodeVerify(null, bytes, b.publicKey, sig)).toBe(false);
  });

  it('verification fails when the signed bytes are tampered', async () => {
    const { pkcs8Der, publicKey } = makeKeypair();
    const sign = await loadSigner(ok(pkcs8Der));
    const sig = await sign('id', Buffer.from('original-bytes'));
    expect(nodeVerify(null, Buffer.from('tampered-bytes'), publicKey, sig)).toBe(false);
  });

  it('throws when the keychain has no key for the id (not_found)', async () => {
    const sign = await loadSigner(vi.fn(async () => ({ kind: 'error', error: { kind: 'not_found' } })));
    await expect(sign('missing-id', Buffer.from('x'))).rejects.toThrow(/not found in keychain/);
  });

  it('passes the keychainId through to keychainLoad verbatim', async () => {
    const { pkcs8Der } = makeKeypair();
    const keychainLoad = ok(pkcs8Der);
    const sign = await loadSigner(keychainLoad);
    await sign('gh-12345:fingerprint', Buffer.from('x'));
    expect(keychainLoad).toHaveBeenCalledWith('gh-12345:fingerprint');
  });
});
