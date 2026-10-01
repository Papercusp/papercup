/**
 * The standalone blind-relay core (plan public-blind-relay-2026-10-01, R-1):
 * a relay started from a seed announces the seed-derived key, and that key is
 * findable on the DHT — the same liveness probe the boot check runs
 * (sync-relay.ts probeRelayKey). Real hyperdht testnet, offline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import { probeRelayKey, type RelayLookupDht } from '../sync/hyperbee/sync-relay';
import {
  createBlindRelayServer,
  parseRelaySeedHex,
  relayPublicKeyForSeed,
  type BlindRelayServer,
} from './blind-relay-core';

type Testnet = { bootstrap: Array<{ host: string; port: number }>; destroy(): Promise<void> };
type ProberDht = RelayLookupDht & { destroy(): Promise<void> };
const DhtCtor = DHT as unknown as {
  new (opts: { bootstrap: unknown }): ProberDht;
  keyPair(seed?: Buffer): { publicKey: Buffer };
};

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
});

describe('parseRelaySeedHex', () => {
  it('accepts 64 hex chars with surrounding whitespace, any case', () => {
    const seed = randomBytes(32);
    expect(parseRelaySeedHex(`  ${seed.toString('hex').toUpperCase()}\n`).equals(seed)).toBe(true);
  });
  it('refuses a short, long or non-hex seed', () => {
    expect(() => parseRelaySeedHex('ab'.repeat(31))).toThrow(/64 hex/);
    expect(() => parseRelaySeedHex('ab'.repeat(33))).toThrow(/64 hex/);
    expect(() => parseRelaySeedHex('zz'.repeat(32))).toThrow(/64 hex/);
  });
});

describe('createBlindRelayServer (real hyperdht testnet)', () => {
  it('refuses a seed that is not 32 bytes before touching the network', async () => {
    await expect(createBlindRelayServer({ seed: Buffer.alloc(16) })).rejects.toThrow(/32 bytes/);
  });

  it('announces the seed-derived key, and that key is live on the DHT', async () => {
    const testnet = (await createTestnet(3)) as unknown as Testnet;
    cleanups.push(() => testnet.destroy());
    const seed = randomBytes(32);

    const relay: BlindRelayServer = await createBlindRelayServer({ seed, bootstrap: testnet.bootstrap });
    cleanups.push(() => relay.close());

    const expected = DhtCtor.keyPair(seed).publicKey.toString('hex');
    expect(relay.publicKey).toBe(expected);
    expect(await relayPublicKeyForSeed(seed)).toBe(expected);

    const prober = new DhtCtor({ bootstrap: testnet.bootstrap });
    cleanups.push(() => prober.destroy());
    expect(await probeRelayKey(prober, Buffer.from(relay.publicKey, 'hex'), 10_000)).toEqual({ status: 'live' });
  }, 30_000);

  it('the same seed gives the same key across restarts', async () => {
    const testnet = (await createTestnet(3)) as unknown as Testnet;
    cleanups.push(() => testnet.destroy());
    const seed = randomBytes(32);
    const first = await createBlindRelayServer({ seed, bootstrap: testnet.bootstrap });
    const firstKey = first.publicKey;
    await first.close();
    const second = await createBlindRelayServer({ seed, bootstrap: testnet.bootstrap });
    cleanups.push(() => second.close());
    expect(second.publicKey).toBe(firstKey);
  }, 30_000);
});

describe('relay core stays dependency-light', () => {
  it('imports nothing but hyperdht and blind-relay (the daemon bundle ships only those)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'blind-relay-core.ts'), 'utf8');
    const specifiers = [...src.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(['hyperdht', 'blind-relay']));
  });
});
