/**
 * Tests for the MEMBER-side EpochKeyProvider (Brief RE-KEY / Move 2, K's P-005 consumer
 * half). Real ed300 crypto + a mock WrappedKeyLoader + a real device: a member unwraps
 * its wrapped row → the SAME key the owner minted, caches it, and a removed member (no
 * row) fails closed with EpochKeyUnavailableError. Keychain mocked in-memory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { createEpochKeyProvider, EpochKeyUnavailableError, type WrappedKeyLoader } from './hive-epoch-key-provider';

const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
vi.mock('../../identity/keychain', () => ({
  keychainStore: async (id: string, der: Buffer) => { mem.set(id, der); return { kind: 'ok', value: undefined }; },
  keychainLoad: async (id: string) =>
    mem.has(id) ? { kind: 'ok', value: mem.get(id)! } : { kind: 'error', error: { kind: 'not_found' } },
  keychainDelete: async (id: string) => { mem.delete(id); return { kind: 'ok', value: undefined }; },
}));

const { createHiveEpochCrypto } = await import('./hive-epoch-crypto-impl');
const { keychainStore } = await import('../../identity/keychain');

async function makeDevice(keychainId: string): Promise<{ keychainId: string; pubkeyBase64: string }> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pubkeyBase64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
  await keychainStore(keychainId, der);
  return { keychainId, pubkeyBase64 };
}

const HIVE = 'hive-1';
beforeEach(() => mem.clear());

describe('createEpochKeyProvider — member re-unwrap + cache + fail-closed cut-off', () => {
  it('unwraps the device wrapped row to the SAME key the owner minted', async () => {
    const c = createHiveEpochCrypto();
    const dev = await makeDevice('dev-1');
    const ownerKey = await c.deriveEpochKey(HIVE, 1);
    const blob = await c.wrapKeyToMember(ownerKey, dev.pubkeyBase64);
    const loader: WrappedKeyLoader = { load: async () => blob };

    const provider = createEpochKeyProvider(c, loader, dev);
    const memberKey = await provider.keyForEpoch(HIVE, 1);
    expect(Buffer.from(memberKey).equals(Buffer.from(ownerKey))).toBe(true);
  });

  it('caches — a second keyForEpoch does not re-load', async () => {
    const c = createHiveEpochCrypto();
    const dev = await makeDevice('dev-2');
    const blob = await c.wrapKeyToMember(await c.deriveEpochKey(HIVE, 1), dev.pubkeyBase64);
    const load = vi.fn(async () => blob);
    const provider = createEpochKeyProvider(c, { load }, dev);
    await provider.keyForEpoch(HIVE, 1);
    await provider.keyForEpoch(HIVE, 1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fails closed (EpochKeyUnavailableError) when the device has no wrapped row — the C-001 cut-off / defer signal', async () => {
    const c = createHiveEpochCrypto();
    const dev = await makeDevice('dev-removed');
    const provider = createEpochKeyProvider(c, { load: async () => null }, dev);
    await expect(provider.keyForEpoch(HIVE, 2)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
  });

  it('per-(hive,epoch) cache isolation — different epochs load independently', async () => {
    const c = createHiveEpochCrypto();
    const dev = await makeDevice('dev-3');
    const k1 = await c.deriveEpochKey(HIVE, 1);
    const k2 = await c.deriveEpochKey(HIVE, 2);
    const loader: WrappedKeyLoader = {
      load: async (_h, epoch) => c.wrapKeyToMember(epoch === 1 ? k1 : k2, dev.pubkeyBase64),
    };
    const provider = createEpochKeyProvider(c, loader, dev);
    expect(Buffer.from(await provider.keyForEpoch(HIVE, 1)).equals(Buffer.from(k1))).toBe(true);
    expect(Buffer.from(await provider.keyForEpoch(HIVE, 2)).equals(Buffer.from(k2))).toBe(true);
  });
});
