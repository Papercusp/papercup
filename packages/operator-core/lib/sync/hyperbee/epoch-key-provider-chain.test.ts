/**
 * WI-3232: the epoch-key provider chain — member (federated, PG-wrapped) provider FIRST,
 * bundled (offline seed) provider as fallback. Verifies the ordering + fail-closed contract
 * the offline pot relies on: first-success wins, a single provider is transparent (so online
 * behavior is byte-for-byte unchanged), and an all-miss propagates the last provider's error.
 */
import { describe, it, expect, vi } from 'vitest';
import { chainEpochKeyProviders } from './epoch-key-provider-chain';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';
import type { EpochKey } from './hive-epoch-crypto';
import type { EpochKeyProvider } from './hive-epoch-serving';

const key = (fill: number): EpochKey =>
  Uint8Array.from(Array.from({ length: 32 }, () => fill)) as EpochKey;

/** A provider that resolves a fixed key. */
const ok = (fill: number): EpochKeyProvider => ({ keyForEpoch: vi.fn(async () => key(fill)) });
/** A provider that always misses with EpochKeyUnavailableError. */
const miss = (): EpochKeyProvider => ({
  keyForEpoch: vi.fn(async (h: string, e: number) => {
    throw new EpochKeyUnavailableError(h, e);
  }),
});

describe('chainEpochKeyProviders', () => {
  it('a single provider is returned AS-IS (transparent — online behavior unchanged)', async () => {
    const only = ok(1);
    const chain = chainEpochKeyProviders([only]);
    expect(chain).toBe(only); // same object ⇒ identical error/success propagation
  });

  it('drops null/undefined entries before chaining (caller passes an optional member inline)', async () => {
    const bundled = ok(2);
    const chain = chainEpochKeyProviders([null, undefined, bundled]);
    expect(chain).toBe(bundled);
    expect(Uint8Array.from(await chain.keyForEpoch('papercusp', 0))).toEqual(key(2));
  });

  it('returns the FIRST provider that resolves; never consults later ones', async () => {
    const first = ok(1);
    const second = ok(2);
    const chain = chainEpochKeyProviders([first, second]);
    expect(Uint8Array.from(await chain.keyForEpoch('papercusp', 0))).toEqual(key(1));
    expect(second.keyForEpoch).not.toHaveBeenCalled(); // short-circuits on first success
  });

  it('falls through a missing member provider to the bundled fallback', async () => {
    const member = miss();
    const bundled = ok(9);
    const chain = chainEpochKeyProviders([member, bundled]);
    expect(Uint8Array.from(await chain.keyForEpoch('papercusp', 1))).toEqual(key(9));
    expect(member.keyForEpoch).toHaveBeenCalledOnce();
    expect(bundled.keyForEpoch).toHaveBeenCalledOnce();
  });

  it('all providers miss ⇒ propagates the LAST error (EpochKeyUnavailableError ⇒ caller defers)', async () => {
    const chain = chainEpochKeyProviders([miss(), miss()]);
    await expect(chain.keyForEpoch('papercusp', 2)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
  });

  it('a non-availability error from an earlier provider does not stop the fallback', async () => {
    const boom: EpochKeyProvider = {
      keyForEpoch: vi.fn(async () => {
        throw new Error('member crypto blew up');
      }),
    };
    const bundled = ok(7);
    const chain = chainEpochKeyProviders([boom, bundled]);
    expect(Uint8Array.from(await chain.keyForEpoch('papercusp', 0))).toEqual(key(7));
  });

  it('an empty chain is fail-closed: every lookup throws EpochKeyUnavailableError', async () => {
    const chain = chainEpochKeyProviders([null, undefined]);
    await expect(chain.keyForEpoch('papercusp', 0)).rejects.toBeInstanceOf(EpochKeyUnavailableError);
  });
});
