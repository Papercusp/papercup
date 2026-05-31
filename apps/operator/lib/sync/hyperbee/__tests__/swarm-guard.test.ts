/**
 * swarm-guard.test.ts — hyperswarm-dos-hardening Phases 2-3 (P-003 firewall
 * ban-gate, P-004 ban-on-abuse, P-005 per-peer connection rate-limit).
 *
 * Covers: the in-memory BucketStore; ban-list TTL (injected clock); the
 * sync firewall predicate; recordConnection's allow/deny + over-limit → ban;
 * and the process-global singleton seam.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONN_RATE,
  createInMemoryBucketStore,
  createSwarmGuard,
  getSwarmGuard,
  _setSwarmGuardForTests,
} from '../swarm-guard';

const KEY = 'ab'.repeat(32); // 64-hex = a 32-byte Noise key
const IP = '203.0.113.7';

describe('createInMemoryBucketStore', () => {
  it('reads null for a missing key, round-trips a written payload', async () => {
    const s = createInMemoryBucketStore();
    expect(await s.read('nope')).toBeNull();
    await s.write('k', { recent: [1, 2, 3], lockedUntilMs: 0 });
    expect(await s.read('k')).toEqual({ recent: [1, 2, 3], lockedUntilMs: 0 });
  });

  it('delete removes a key', async () => {
    const s = createInMemoryBucketStore();
    await s.write('k', { recent: [1], lockedUntilMs: 0 });
    await s.delete('k');
    expect(await s.read('k')).toBeNull();
  });

  it('clearPrefix drops only matching keys', async () => {
    const s = createInMemoryBucketStore();
    await s.write('conn:a', { recent: [1], lockedUntilMs: 0 });
    await s.write('conn:b', { recent: [1], lockedUntilMs: 0 });
    await s.write('other:c', { recent: [1], lockedUntilMs: 0 });
    await s.clearPrefix('conn:');
    expect(await s.read('conn:a')).toBeNull();
    expect(await s.read('conn:b')).toBeNull();
    expect(await s.read('other:c')).not.toBeNull();
  });

  it('gcStale drops entries written before the threshold', async () => {
    // touched is wall-clock (Date.now); a threshold in the future drops everything,
    // a threshold of 0 keeps everything.
    const s = createInMemoryBucketStore();
    await s.write('k', { recent: [1], lockedUntilMs: 0 });
    await s.gcStale(0); // nothing older than epoch
    expect(await s.read('k')).not.toBeNull();
    await s.gcStale(Number.MAX_SAFE_INTEGER); // everything is "older than" +inf
    expect(await s.read('k')).toBeNull();
  });
});

describe('ban-list TTL (injected clock)', () => {
  it('banKey expires lazily after its TTL', () => {
    let t = 1_000;
    const g = createSwarmGuard({ now: () => t });
    g.banKey(KEY, 5_000);
    expect(g.isBannedKey(KEY)).toBe(true);
    t = 1_000 + 4_999;
    expect(g.isBannedKey(KEY)).toBe(true); // still inside the window
    t = 1_000 + 5_000;
    expect(g.isBannedKey(KEY)).toBe(false); // now >= expiry → unbanned
  });

  it('banIp expires lazily after its TTL', () => {
    let t = 0;
    const g = createSwarmGuard({ now: () => t });
    g.banIp(IP, 1_000);
    expect(g.isBannedIp(IP)).toBe(true);
    t = 1_000;
    expect(g.isBannedIp(IP)).toBe(false);
  });
});

describe('firewall (P-003 — sync key-gate, true = DENY)', () => {
  it('allows an unidentifiable remote (never break a legit peer)', () => {
    const g = createSwarmGuard();
    expect(g.firewall(null)).toBe(false);
    expect(g.firewall(undefined)).toBe(false);
  });

  it('allows an un-banned key and denies a banned one', () => {
    const g = createSwarmGuard();
    const buf = Buffer.from(KEY, 'hex');
    expect(g.firewall(buf)).toBe(false);
    g.banKey(KEY);
    expect(g.firewall(buf)).toBe(true);
  });

  it('handles a Uint8Array key (not just Buffer)', () => {
    const g = createSwarmGuard();
    const u8 = new Uint8Array(Buffer.from(KEY, 'hex'));
    g.banKey(KEY);
    expect(g.firewall(u8)).toBe(true);
  });
});

describe('recordConnection (P-004/P-005)', () => {
  it('allows a fresh peer under the rate ceiling', async () => {
    const g = createSwarmGuard();
    expect(await g.recordConnection(KEY, IP)).toEqual({ allow: true });
  });

  it('denies a peer whose key is already banned (no rate-limit round-trip)', async () => {
    const g = createSwarmGuard();
    g.banKey(KEY);
    expect(await g.recordConnection(KEY, IP)).toEqual({ allow: false, reason: 'banned' });
  });

  it('denies a peer whose IP is already banned', async () => {
    const g = createSwarmGuard();
    g.banIp(IP);
    expect(await g.recordConnection(KEY, IP)).toEqual({ allow: false, reason: 'banned' });
  });

  it('over the connection-rate ceiling → bans the key + IP and denies', async () => {
    const g = createSwarmGuard();
    for (let i = 0; i < CONN_RATE.capacity; i++) {
      expect((await g.recordConnection(KEY, IP)).allow).toBe(true);
    }
    // The (capacity+1)th connection trips the soft bucket.
    expect(await g.recordConnection(KEY, IP)).toEqual({ allow: false, reason: 'rate_limited' });
    expect(g.isBannedKey(KEY)).toBe(true);
    expect(g.isBannedIp(IP)).toBe(true);
    // …and the firewall now rejects that key pre-handshake.
    expect(g.firewall(Buffer.from(KEY, 'hex'))).toBe(true);
  });

  it('rate-limits a key-only peer (no IP) and bans the key on breach', async () => {
    const g = createSwarmGuard();
    for (let i = 0; i < CONN_RATE.capacity; i++) {
      expect((await g.recordConnection(KEY, undefined)).allow).toBe(true);
    }
    expect((await g.recordConnection(KEY, undefined)).allow).toBe(false);
    expect(g.isBannedKey(KEY)).toBe(true);
  });

  it('a wholly-unidentifiable peer is rate-limited but bans nothing', async () => {
    const g = createSwarmGuard();
    for (let i = 0; i < CONN_RATE.capacity; i++) {
      expect((await g.recordConnection(undefined, undefined)).allow).toBe(true);
    }
    expect((await g.recordConnection(undefined, undefined)).allow).toBe(false);
    // No key/IP to ban — the ceiling still throttled it, but nothing is banned.
    expect(g.isBannedKey(KEY)).toBe(false);
    expect(g.isBannedIp(IP)).toBe(false);
  });
});

describe('getSwarmGuard / _setSwarmGuardForTests', () => {
  afterEach(() => _setSwarmGuardForTests(null));

  it('returns a stable process-global singleton', () => {
    _setSwarmGuardForTests(null);
    const a = getSwarmGuard();
    const b = getSwarmGuard();
    expect(a).toBe(b);
  });

  it('the test seam swaps the singleton', () => {
    const injected = createSwarmGuard();
    _setSwarmGuardForTests(injected);
    expect(getSwarmGuard()).toBe(injected);
  });
});
