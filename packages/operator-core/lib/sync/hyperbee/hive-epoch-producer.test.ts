/**
 * Tests for the PRODUCER (write-side) of the re-key (Brief RE-KEY / Move 2, K's P4):
 * encryptForCurrentEpoch reads the hive's CURRENT epoch (P1) + mints the epoch key
 * (ed300) + encrypts under it (P4 serving). End-to-end against ed300's REAL crypto +
 * my serving consumer: encrypt under the current epoch → decrypt with that epoch's key
 * round-trips; the reported epoch matches the store; ciphertext ≠ plaintext.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settings } = vi.hoisted(() => ({ settings: new Map<string, unknown>() }));
const sk = (ws: string, slug: string, key: string) => `${ws}::${slug}::${key}`;
vi.mock('../../hive-settings-store', () => ({
  getHiveSetting: async (ws: string, slug: string, key: string) =>
    settings.has(sk(ws, slug, key))
      ? { workspaceId: ws, potHomeSlug: slug, settingKey: key, value: settings.get(sk(ws, slug, key)), createdAt: 0, updatedAt: 0 }
      : null,
  setHiveSetting: async () => ({}),
}));
// keychain is mocked in-memory so createHiveEpochCrypto's deriveEpochKey persists hermetically.
const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
vi.mock('../../identity/keychain', () => ({
  keychainStore: async (id: string, der: Buffer) => { mem.set(id, der); return { kind: 'ok', value: undefined }; },
  keychainLoad: async (id: string) =>
    mem.has(id) ? { kind: 'ok', value: mem.get(id)! } : { kind: 'error', error: { kind: 'not_found' } },
  keychainDelete: async (id: string) => { mem.delete(id); return { kind: 'ok', value: undefined }; },
}));

const { createHiveEpochCrypto } = await import('./hive-epoch-crypto-impl');
const { encryptForCurrentEpoch } = await import('./hive-epoch-producer');
const { decryptOpPayload } = await import('./hive-epoch-serving');

const CTX = { workspaceId: 'default', potHomeSlug: 'hello-world-hive', potId: 'hive-1' };
const ID = { tableTag: 'harness-features', rowKey: 'F-1', authorPubkey: 'owner' };
const enc = (s: string) => new TextEncoder().encode(s);
const setEpoch = (n: number) => settings.set(sk(CTX.workspaceId, CTX.potHomeSlug, 'epoch'), n);

beforeEach(() => { settings.clear(); mem.clear(); });

describe('encryptForCurrentEpoch — encrypt under the hive current epoch', () => {
  it('reports the current epoch + the ciphertext round-trips under that epoch key', async () => {
    const c = createHiveEpochCrypto();
    setEpoch(5);
    const { epoch, ciphertext } = await encryptForCurrentEpoch(c, CTX, enc('secret body'), ID);
    expect(epoch).toBe(5);
    expect(Buffer.from(ciphertext).equals(Buffer.from(enc('secret body')))).toBe(false); // actually encrypted

    // A reader holding epoch-5's key (via the same crypto) decrypts it through the serving consumer.
    const key5 = await c.deriveEpochKey(CTX.potId, 5);
    const pt = await decryptOpPayload(c, ciphertext, { potId: CTX.potId, epoch: 5, id: ID }, key5);
    expect(new TextDecoder().decode(pt)).toBe('secret body');
  });

  it('an unset hive encrypts under the baseline epoch 0', async () => {
    const c = createHiveEpochCrypto();
    const { epoch, ciphertext } = await encryptForCurrentEpoch(c, CTX, enc('e0'), ID);
    expect(epoch).toBe(0);
    const key0 = await c.deriveEpochKey(CTX.potId, 0);
    const pt = await decryptOpPayload(c, ciphertext, { potId: CTX.potId, epoch: 0, id: ID }, key0);
    expect(new TextDecoder().decode(pt)).toBe('e0');
  });

  it('content from epoch N cannot be read with epoch N-1 key (the boundary cut)', async () => {
    const c = createHiveEpochCrypto();
    setEpoch(2);
    const { ciphertext } = await encryptForCurrentEpoch(c, CTX, enc('post-boundary'), ID);
    const key1 = await c.deriveEpochKey(CTX.potId, 1); // an older-epoch holder's key
    await expect(
      decryptOpPayload(c, ciphertext, { potId: CTX.potId, epoch: 2, id: ID }, key1),
    ).rejects.toBeTruthy();
  });
});
