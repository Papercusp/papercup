import { afterEach, describe, expect, it, vi } from 'vitest';
import Hyperswarm from 'hyperswarm';
import { describeSyncRelayFallback, resolveSyncRelayKeys, syncRelayThroughOption } from './sync-relay';

const KEY_A = Buffer.alloc(32, 0xaa);
const KEY_B = Buffer.alloc(32, 0xbb);

describe('syncRelayThroughOption (WI-10004827)', () => {
  it('omits relayThrough entirely when no relay is configured', () => {
    // [] is truthy to hyperswarm: passing it would force "relay through nothing".
    expect(syncRelayThroughOption([])).toEqual({});
    expect('relayThrough' in syncRelayThroughOption([])).toBe(false);
  });

  it('passes every configured relay key through, as a copy', () => {
    const keys = [KEY_A, KEY_B];
    const opt = syncRelayThroughOption(keys);
    expect(opt.relayThrough).toEqual([KEY_A, KEY_B]);
    expect(opt.relayThrough).not.toBe(keys);
  });
});

describe('resolveSyncRelayKeys', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the relay set the reader provides', async () => {
    await expect(resolveSyncRelayKeys(async () => [KEY_A])).resolves.toEqual([KEY_A]);
  });

  it('never throws: a failed read degrades to no relay fallback with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      resolveSyncRelayKeys(async () => {
        throw new Error('pg down');
      }),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NO relay fallback'));
  });
});

describe('describeSyncRelayFallback', () => {
  it('names the unreachable-peer consequence when no relay exists', () => {
    expect(describeSyncRelayFallback([])).toContain('will never connect');
    expect(describeSyncRelayFallback([KEY_A])).toContain('1 blind-relay key(s)');
  });
});

describe('hyperswarm relay semantics the fallback depends on (real module)', () => {
  it('relays only on a forced retry after a failed direct connect, never on the first attempt', async () => {
    // Empty bootstrap: the DHT node binds locally and never reaches the network.
    const swarm = new Hyperswarm({ bootstrap: [], ...syncRelayThroughOption([KEY_A, KEY_B]) }) as unknown as {
      dht: { randomized?: boolean };
      _maybeRelayConnection(force: boolean): Buffer[] | null;
      destroy(): Promise<void>;
    };
    try {
      expect(swarm.dht.randomized).toBeFalsy();
      // First attempt: direct (peerInfo.forceRelaying is false).
      expect(swarm._maybeRelayConnection(false)).toBeNull();
      // After HOLEPUNCH_ABORTED / REMOTE_NOT_HOLEPUNCHABLE hyperswarm retries with force.
      expect(swarm._maybeRelayConnection(true)).toEqual([KEY_A, KEY_B]);
    } finally {
      await swarm.destroy();
    }
  });

  it('has no relay at all when the option is omitted', async () => {
    const swarm = new Hyperswarm({ bootstrap: [], ...syncRelayThroughOption([]) }) as unknown as {
      _maybeRelayConnection(force: boolean): Buffer[] | null;
      destroy(): Promise<void>;
    };
    try {
      expect(swarm._maybeRelayConnection(true)).toBeNull();
    } finally {
      await swarm.destroy();
    }
  });
});
