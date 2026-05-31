import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  joinHarnessSwarm,
  swarmConstructorOpts,
  extractPublicKeyHex,
  extractRemoteIp,
  type HyperswarmLike,
  _setSharedSwarmForTests,
  _peekSharedSwarmForTests,
} from '../swarm';
import { createSwarmGuard, _setSwarmGuardForTests } from '../swarm-guard';
import type Corestore from 'corestore';

afterEach(() => {
  _setSharedSwarmForTests(null);
  // Reset the process-global guard so each test gets a fresh ban-list +
  // rate-limit buckets (the connection handler defaults to the global guard).
  _setSwarmGuardForTests(null);
});

interface FakeSwarmState {
  joins: Array<{ topic: Buffer; opts?: { server?: boolean; client?: boolean } }>;
  leaves: Buffer[];
  listeners: Map<string, Array<(socket: unknown, info?: unknown) => void>>;
}

function fakeSwarm(): { swarm: HyperswarmLike; state: FakeSwarmState; emit: (event: string, socket: unknown, info?: unknown) => void } {
  const state: FakeSwarmState = { joins: [], leaves: [], listeners: new Map() };
  const swarm: HyperswarmLike = {
    join(topic, opts) {
      state.joins.push({ topic, opts });
      return { flushed: () => Promise.resolve() };
    },
    leave(topic) {
      state.leaves.push(topic);
    },
    on(event, listener) {
      const arr = state.listeners.get(event) ?? [];
      arr.push(listener);
      state.listeners.set(event, arr);
      return swarm;
    },
    off(event, listener) {
      const arr = state.listeners.get(event) ?? [];
      state.listeners.set(
        event,
        arr.filter((l) => l !== listener),
      );
      return swarm;
    },
  };
  return {
    swarm,
    state,
    emit(event, socket, info?: unknown) {
      const arr = state.listeners.get(event) ?? [];
      for (const l of arr) l(socket, info);
    },
  };
}

function fakeStore(): { store: Corestore; replicateCalls: boolean[] } {
  const replicateCalls: boolean[] = [];
  const store = {
    replicate(initiator: boolean) {
      replicateCalls.push(initiator);
      return { pipe: vi.fn() };
    },
  } as unknown as Corestore;
  return { store, replicateCalls };
}

function topic32(): Buffer {
  return Buffer.from('a'.repeat(64), 'hex');
}

describe('joinHarnessSwarm — validation', () => {
  it('rejects missing store', async () => {
    const { swarm } = fakeSwarm();
    await expect(joinHarnessSwarm({ store: null as never, topic: topic32(), swarm })).rejects.toThrow(/store/);
  });

  it('rejects non-32-byte topic', async () => {
    const { swarm } = fakeSwarm();
    const { store } = fakeStore();
    await expect(joinHarnessSwarm({ store, topic: Buffer.alloc(16), swarm })).rejects.toThrow(/32-byte/);
    await expect(joinHarnessSwarm({ store, topic: null as never, swarm })).rejects.toThrow(/32-byte/);
  });

  it('rejects missing swarm', async () => {
    const { store } = fakeStore();
    await expect(joinHarnessSwarm({ store, topic: topic32(), swarm: null as never })).rejects.toThrow(/swarm/);
  });
});

describe('joinHarnessSwarm — happy path', () => {
  it('calls swarm.join with the topic + server:true + client:true', async () => {
    const { swarm, state } = fakeSwarm();
    const { store } = fakeStore();
    await joinHarnessSwarm({ store, topic: topic32(), swarm });
    expect(state.joins).toHaveLength(1);
    expect(state.joins[0].topic.equals(topic32())).toBe(true);
    expect(state.joins[0].opts).toEqual({ server: true, client: true });
  });

  it('returns a handle with topicHex + connectionCount=0', async () => {
    const { swarm } = fakeSwarm();
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    expect(h.topicHex).toBe('a'.repeat(64));
    expect(h.connectionCount).toBe(0);
  });

  it('on connection, calls store.replicate(true) + bidi-pipes', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateCalls } = fakeStore();
    await joinHarnessSwarm({ store, topic: topic32(), swarm });
    const peer = { pipe: vi.fn() };
    emit('connection', peer);
    expect(replicateCalls).toEqual([true]);
    expect(peer.pipe).toHaveBeenCalledTimes(1);
  });

  it('increments connectionCount on each peer', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    emit('connection', { pipe: vi.fn() });
    emit('connection', { pipe: vi.fn() });
    expect(h.connectionCount).toBe(2);
  });

  it('fires onPeerConnected for each connection', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const cb = vi.fn();
    await joinHarnessSwarm({ store, topic: topic32(), swarm, onPeerConnected: cb });
    emit('connection', { pipe: vi.fn() });
    emit('connection', { pipe: vi.fn() });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('passes the peer Noise key (hex) to onPeerConnected (P-002)', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const cb = vi.fn();
    await joinHarnessSwarm({ store, topic: topic32(), swarm, onPeerConnected: cb });
    emit('connection', { pipe: vi.fn() }, { publicKey: Buffer.from('abcd', 'hex') });
    expect(cb).toHaveBeenCalledWith('abcd');
  });

  it('swallows onPeerConnected throws (diagnostic callback)', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const cb = vi.fn(() => {
      throw new Error('boom');
    });
    await joinHarnessSwarm({ store, topic: topic32(), swarm, onPeerConnected: cb });
    expect(() => emit('connection', { pipe: vi.fn() })).not.toThrow();
  });

  it('swallows replication throws (peer-side stream weirdness)', async () => {
    const { swarm, emit } = fakeSwarm();
    const badStore = {
      replicate() {
        throw new Error('local replicate failed');
      },
    } as unknown as Corestore;
    await joinHarnessSwarm({ store: badStore, topic: topic32(), swarm });
    expect(() => emit('connection', { pipe: vi.fn() })).not.toThrow();
  });
});

describe('joinHarnessSwarm — DoS guard (P-003/P-004/P-005)', () => {
  const BANNED_KEY = '11'.repeat(32);
  const BANNED_IP = '198.51.100.9';

  it('drops a banned-key peer before replicating + destroys the socket', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateCalls } = fakeStore();
    const guard = createSwarmGuard();
    guard.banKey(BANNED_KEY);
    await joinHarnessSwarm({ store, topic: topic32(), swarm, guard });

    const socket = { pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from(BANNED_KEY, 'hex') });

    expect(replicateCalls).toEqual([]); // never replicated
    expect(socket.pipe).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('drops a banned-IP peer (the key-only firewall cannot see IPs)', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateCalls } = fakeStore();
    const guard = createSwarmGuard();
    guard.banIp(BANNED_IP);
    await joinHarnessSwarm({ store, topic: topic32(), swarm, guard });

    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: BANNED_IP } };
    emit('connection', socket); // no peerInfo → no key, only the IP

    expect(replicateCalls).toEqual([]);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('replicates a non-banned peer + does not destroy it', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateCalls } = fakeStore();
    const guard = createSwarmGuard();
    await joinHarnessSwarm({ store, topic: topic32(), swarm, guard });

    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: '203.0.113.4' } };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });
    // Let the fire-and-forget rate-limit settle (in-memory → a few microtasks).
    await new Promise((r) => setTimeout(r, 0));

    expect(replicateCalls).toEqual([true]);
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});

describe('extractRemoteIp (P-005)', () => {
  it('reads rawStream.remoteHost', () => {
    expect(extractRemoteIp({ rawStream: { remoteHost: '10.0.0.1' } })).toBe('10.0.0.1');
  });
  it('returns undefined for missing / non-string / empty hosts', () => {
    expect(extractRemoteIp(undefined)).toBeUndefined();
    expect(extractRemoteIp({})).toBeUndefined();
    expect(extractRemoteIp({ rawStream: {} })).toBeUndefined();
    expect(extractRemoteIp({ rawStream: { remoteHost: 123 } })).toBeUndefined();
    expect(extractRemoteIp({ rawStream: { remoteHost: '' } })).toBeUndefined();
  });
});

describe('joinHarnessSwarm — close', () => {
  it('close calls swarm.leave(topic) + detaches the listener', async () => {
    const { swarm, state } = fakeSwarm();
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    expect(state.listeners.get('connection')?.length).toBe(1);
    await h.close();
    expect(state.leaves).toHaveLength(1);
    expect(state.leaves[0].equals(topic32())).toBe(true);
    expect(state.listeners.get('connection')?.length).toBe(0);
  });

  it('close is robust to a swarm without `off` method', async () => {
    const { swarm, state } = fakeSwarm();
    delete (swarm as { off?: unknown }).off;
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    await h.close();
    expect(state.leaves).toHaveLength(1);
  });

  it('close swallows leave errors', async () => {
    const { store } = fakeStore();
    const swarm: HyperswarmLike = {
      join: () => ({ flushed: () => Promise.resolve() }),
      leave: () => {
        throw new Error('not joined');
      },
      on: () => undefined,
      off: () => undefined,
    };
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    await expect(h.close()).resolves.toBeUndefined();
  });
});

describe('_setSharedSwarmForTests / _peekSharedSwarmForTests', () => {
  it('round-trips', () => {
    expect(_peekSharedSwarmForTests()).toBeNull();
    const s = { join: () => ({}), leave: () => {}, on: () => undefined } as unknown as HyperswarmLike;
    _setSharedSwarmForTests(s);
    expect(_peekSharedSwarmForTests()).toBe(s);
    _setSharedSwarmForTests(null);
    expect(_peekSharedSwarmForTests()).toBeNull();
  });
});

describe('swarmConstructorOpts (P-001 — maxPeers cap)', () => {
  const KEY = 'PAPERCUSP_SWARM_MAX_PEERS';
  const orig = process.env[KEY];
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  it('defaults maxPeers to 256', () => {
    delete process.env[KEY];
    expect(swarmConstructorOpts()).toEqual({ maxPeers: 256 });
  });

  it('honors a positive PAPERCUSP_SWARM_MAX_PEERS override', () => {
    process.env[KEY] = '32';
    expect(swarmConstructorOpts()).toEqual({ maxPeers: 32 });
  });

  it('falls back to the default for non-numeric / non-positive values', () => {
    process.env[KEY] = 'nope';
    expect(swarmConstructorOpts().maxPeers).toBe(256);
    process.env[KEY] = '0';
    expect(swarmConstructorOpts().maxPeers).toBe(256);
  });
});

describe('extractPublicKeyHex (P-002)', () => {
  it('extracts the hex of a PeerInfo.publicKey buffer', () => {
    expect(extractPublicKeyHex({ publicKey: Buffer.from('deadbeef', 'hex') })).toBe('deadbeef');
  });
  it('returns undefined for missing / malformed peerInfo', () => {
    expect(extractPublicKeyHex(undefined)).toBeUndefined();
    expect(extractPublicKeyHex(null)).toBeUndefined();
    expect(extractPublicKeyHex({})).toBeUndefined();
    expect(extractPublicKeyHex({ publicKey: 123 })).toBeUndefined();
  });
});
