/**
 * WI-3232: the bundled (offline) EpochKeyProvider — resolves the hive epoch key from the
 * seed's epoch-keys.json so a fresh packaged install decrypts the seed with no admission.
 * Fail-closed on every miss (missing file / hive / epoch / bad key) so a caller degrades
 * to the member provider instead of crashing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBundledEpochKeyProvider } from './bundled-epoch-key-provider';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';

const KEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 3) % 256));
const B64 = Buffer.from(KEY).toString('base64');
const doc = JSON.stringify({ papercusp: { '0': B64, '2': B64 } });

describe('createBundledEpochKeyProvider', () => {
  it('resolves the 32-byte key for a known (hive, epoch)', async () => {
    const readFileImpl = vi.fn(async () => doc);
    const p = createBundledEpochKeyProvider('/seed', { readFileImpl });
    expect(Uint8Array.from(await p.keyForEpoch('papercusp', 0))).toEqual(KEY);
    expect(Uint8Array.from(await p.keyForEpoch('papercusp', 2))).toEqual(KEY);
  });

  it('reads + parses the doc only ONCE (cached across calls)', async () => {
    const readFileImpl = vi.fn(async () => doc);
    const p = createBundledEpochKeyProvider('/seed', { readFileImpl });
    await p.keyForEpoch('papercusp', 0);
    await p.keyForEpoch('papercusp', 2);
    expect(readFileImpl).toHaveBeenCalledTimes(1);
  });

  it('fail-closed (EpochKeyUnavailableError) for an unknown epoch', async () => {
    const p = createBundledEpochKeyProvider('/seed', { readFileImpl: async () => doc });
    await expect(p.keyForEpoch('papercusp', 5)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
  });

  it('fail-closed for an unknown hive', async () => {
    const p = createBundledEpochKeyProvider('/seed', { readFileImpl: async () => doc });
    await expect(p.keyForEpoch('other', 0)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
  });

  it('fail-closed when the seed has no epoch-keys.json (no bundled key ⇒ defer, not crash)', async () => {
    const readFileImpl = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const p = createBundledEpochKeyProvider('/seed', { readFileImpl });
    await expect(p.keyForEpoch('papercusp', 0)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
  });

  it('fail-closed on malformed JSON / bad base64 length (never a truncated key)', async () => {
    const bad = createBundledEpochKeyProvider('/seed', { readFileImpl: async () => 'not json' });
    await expect(bad.keyForEpoch('papercusp', 0)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
    const short = createBundledEpochKeyProvider('/seed', {
      readFileImpl: async () => JSON.stringify({ papercusp: { '0': Buffer.from([1, 2, 3]).toString('base64') } }),
    });
    await expect(short.keyForEpoch('papercusp', 0)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
  });
});
