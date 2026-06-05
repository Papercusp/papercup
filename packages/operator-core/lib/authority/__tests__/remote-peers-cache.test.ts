/**
 * Unit tests for the remote-peers cache (Phase 2 hot-path guard,
 * distributed-coordination-shared-harness-2026-06-04). Pure — presence + clock
 * injected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasRemotePeers,
  invalidateRemotePeers,
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
