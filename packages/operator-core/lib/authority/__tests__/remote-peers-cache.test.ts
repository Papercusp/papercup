/**
 * Unit tests for the remote-peers cache (Phase 2 hot-path guard,
 * distributed-coordination-shared-harness-2026-06-04). Pure — presence + clock
 * injected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasRemotePeers,
  hasRemoteHivePeers,
  invalidateRemotePeers,
  invalidateRemoteHivePeers,
  __resetRemotePeersCacheForTests,
} from '../remote-peers-cache';
import { routeFileLockOp } from '../file-lock-routing';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../peer-rpc-transport';

const NOW = 1_700_000_000_000;

function peerRow(pubkey: string, machine = 'm', secondsAgo = 1) {
  return { device_pubkey: pubkey, github_user_id: 1, machine_label: machine, last_seen_ms: NOW - secondsAgo * 1000 };
}

afterEach(() => {
  __resetRemotePeersCacheForTests();
  __resetPeerRpcTransportForTests();
});

describe('hasRemotePeers', () => {
  it('single box (no peers, no self) → false', async () => {
    expect(await hasRemotePeers('h', { now: () => NOW, fetchPresenceRows: async () => [], resolveSelf: async () => null })).toBe(false);
  });

  it('only self present → false', async () => {
    expect(
      await hasRemotePeers('h', {
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
        fetchPresenceRows: async () => [peerRow('aaa')],
      }),
    ).toBe(false);
  });

  it('self + a remote peer → true', async () => {
    expect(
      await hasRemotePeers('h', {
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
        fetchPresenceRows: async () => [peerRow('aaa'), peerRow('bbb', 'm2')],
      }),
    ).toBe(true);
  });

  it('a remote peer with no self identity → true', async () => {
    expect(
      await hasRemotePeers('h', { now: () => NOW, resolveSelf: async () => null, fetchPresenceRows: async () => [peerRow('bbb')] }),
    ).toBe(true);
  });

  it('caches within the TTL (a second call does NOT re-query)', async () => {
    const fetch = vi.fn(async () => [] as ReturnType<typeof peerRow>[]);
    const deps = { now: () => NOW, resolveSelf: async () => null, fetchPresenceRows: fetch, ttlMs: 5_000 };
    expect(await hasRemotePeers('h', deps)).toBe(false);
    expect(await hasRemotePeers('h', deps)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('re-queries after the TTL expires', async () => {
    const fetch = vi.fn(async () => [] as ReturnType<typeof peerRow>[]);
    let t = NOW;
    const deps = { now: () => t, resolveSelf: async () => null, fetchPresenceRows: fetch, ttlMs: 5_000 };
    await hasRemotePeers('h', deps);
    t = NOW + 6_000;
    await hasRemotePeers('h', deps);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces a re-query before the TTL', async () => {
    const fetch = vi.fn(async () => [] as ReturnType<typeof peerRow>[]);
    const deps = { now: () => NOW, resolveSelf: async () => null, fetchPresenceRows: fetch, ttlMs: 5_000 };
    await hasRemotePeers('h', deps);
    invalidateRemotePeers('h');
    await hasRemotePeers('h', deps);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('routeFileLockOp — remote-peers fast path', () => {
  it('no remote peers → runs local without consulting the transport', async () => {
    // A transport that would throw if ever called — proves the fast path skips it.
    setPeerRpcTransport({
      async rpc() {
        throw new Error('transport must not be consulted on the no-peers fast path');
      },
    });
    const res = await routeFileLockOp(
      '/repo/h',
      { local: async () => 'L' },
      {
        domainToHarnessSlug: () => 'h',
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
        fetchPresenceRows: async () => [peerRow('aaa')], // only self → no remote peers
      },
    );
    expect(res).toEqual({ value: 'L', via: 'local-authority' });
  });

  it('remote peers present → delegates to authority routing (fail-open without transport)', async () => {
    const res = await routeFileLockOp(
      '/repo/h',
      { local: async () => 'L' },
      {
        domainToHarnessSlug: () => 'h',
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 2, devicePubkey: 'mmm' }),
        fetchPresenceRows: async () => [peerRow('aaa', 'authority'), peerRow('mmm', 'self')],
      },
    );
    expect(res.via).toBe('fail-open');
    expect(res.value).toBe('L');
  });
});

// ── Hive path + namespacing + invalidation (depth pass, su-7f3e0376) ─────────
describe('hasRemoteHivePeers + cache namespacing (P-009)', () => {
  it('a Hive with only self → false; with a remote Swarm → true', async () => {
    expect(
      await hasRemoteHivePeers('my-hive', {
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
        fetchHivePresenceRows: async (h) => { expect(h).toBe('my-hive'); return [peerRow('aaa')]; },
      }),
    ).toBe(false);
    invalidateRemoteHivePeers('my-hive'); // clear the hive entry so the next call re-resolves
    expect(
      await hasRemoteHivePeers('my-hive', {
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
        fetchHivePresenceRows: async () => [peerRow('aaa'), peerRow('bbb', 'm2')],
      }),
    ).toBe(true);
  });

  it('hive: and harness keys NEVER collide — the same name yields independent entries', async () => {
    const self = { githubUserId: 1, devicePubkey: 'aaa' };
    // harness 'x' has a remote peer → true; hive 'x' is self-alone → false. Same name, opposite answers.
    const harnessVal = await hasRemotePeers('x', {
      now: () => NOW,
      resolveSelf: async () => self,
      fetchPresenceRows: async () => [peerRow('aaa'), peerRow('bbb', 'm2')],
    });
    const hiveVal = await hasRemoteHivePeers('x', {
      now: () => NOW,
      resolveSelf: async () => self,
      fetchHivePresenceRows: async () => [peerRow('aaa')],
    });
    expect(harnessVal).toBe(true);
    expect(hiveVal).toBe(false); // a collision would have served the cached harness `true`
  });

  it('invalidateRemotePeers() with no argument clears EVERY entry (harness + hive)', async () => {
    const harnessFetch = vi.fn(async () => [] as ReturnType<typeof peerRow>[]);
    const hiveFetch = vi.fn(async () => [] as ReturnType<typeof peerRow>[]);
    const base = { now: () => NOW, resolveSelf: async () => null, ttlMs: 60_000 };
    await hasRemotePeers('h1', { ...base, fetchPresenceRows: harnessFetch });
    await hasRemoteHivePeers('hv1', { ...base, fetchHivePresenceRows: hiveFetch });
    invalidateRemotePeers(); // no arg → clear ALL
    await hasRemotePeers('h1', { ...base, fetchPresenceRows: harnessFetch });
    await hasRemoteHivePeers('hv1', { ...base, fetchHivePresenceRows: hiveFetch });
    expect(harnessFetch).toHaveBeenCalledTimes(2); // re-queried after the clear-all
    expect(hiveFetch).toHaveBeenCalledTimes(2);
  });
});
