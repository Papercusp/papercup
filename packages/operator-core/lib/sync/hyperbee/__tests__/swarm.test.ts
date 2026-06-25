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
import type { SignedAnnounce } from '../announce';

// ── protomux fake (Model B Stage 4b announce channel) ──
// The announce channel rides Protomux.from(socket). The real muxer needs a live
// secret-stream; here a controllable fake captures the onmessage handler + sends
// so tests can drive an inbound announce + assert our announce was sent. Keyed by
// `socket.__muxId` so each connection gets its own channel state.
interface FakeChannelState {
  onmessage: ((frame: SignedAnnounce) => void) | null;
  onopen: (() => void) | null;
  opened: boolean;
  sent: SignedAnnounce[];
}
const fakeChannels = new Map<unknown, FakeChannelState>();

vi.mock('protomux', () => {
  return {
    default: class FakeProtomux {
      socket: unknown;
      constructor(socket: unknown) {
        this.socket = socket;
      }
      static from(socket: unknown): FakeProtomux {
        return new FakeProtomux(socket);
      }
      createChannel(opts: { protocol: string; onopen?: () => void }) {
        const socket = this.socket;
        let state = fakeChannels.get(socket);
        if (!state) {
          state = { onmessage: null, onopen: null, opened: false, sent: [] };
          fakeChannels.set(socket, state);
        }
        const st = state;
        st.onopen = opts.onopen ?? null;
        return {
          addMessage(msgOpts: { encoding: unknown; onmessage: (f: SignedAnnounce) => void }) {
            st.onmessage = msgOpts.onmessage;
            return {
              send(value: SignedAnnounce) {
                st.sent.push(value);
              },
            };
          },
          open() {
            st.opened = true;
            // Real Protomux fires onopen only once the channel is fully paired
            // (the remote opened the matching protocol). Default: model an
            // immediately-paired peer (fire onopen synchronously on open()) so
            // the onopen-gated announce send is exercised. A socket flagged
            // `__deferOpen` does NOT auto-fire — the test fires st.onopen() by
            // hand to model a peer that pairs later (Fix 5).
            if (!(socket as { __deferOpen?: boolean })?.__deferOpen) {
              st.onopen?.();
            }
          },
          close() {},
        };
      }
    },
  };
});

// compact-encoding is only used as an opaque encoding token; a trivial stub.
vi.mock('compact-encoding', () => ({ default: { json: {} } }));

afterEach(() => {
  _setSharedSwarmForTests(null);
  // Reset the process-global guard so each test gets a fresh ban-list +
  // rate-limit buckets (the connection handler defaults to the global guard).
  _setSwarmGuardForTests(null);
  fakeChannels.clear();
});

/** A signed-announce fixture (shape only — verifyAnnounce is independent). */
function announceFixture(over: Partial<SignedAnnounce> = {}): SignedAnnounce {
  return {
    device_pubkey: 'ZGV2cHVia2V5', // base64 placeholder
    github_user_id: 42,
    github_login: 'alice',
    attestation_gist_id: 'gist-test',
    log_core_key: 'bb'.repeat(32),
    ts: Date.now(),
    sig: 'c2ln',
    ...over,
  };
}

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

// Model B Stage 4b: store.replicate is now called with the connection socket
// (an external stream), NOT a boolean initiator. Capture whatever it's passed.
function fakeStore(): { store: Corestore; replicateArgs: unknown[] } {
  const replicateArgs: unknown[] = [];
  const store = {
    replicate(arg: unknown) {
      replicateArgs.push(arg);
      return { pipe: vi.fn() };
    },
  } as unknown as Corestore;
  return { store, replicateArgs };
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

  it('on connection, calls store.replicate(socket) (external stream)', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateArgs } = fakeStore();
    await joinHarnessSwarm({ store, topic: topic32(), swarm });
    const peer = { __muxId: 'p1', pipe: vi.fn() };
    emit('connection', peer);
    // The connection socket is passed straight to replicate (not a boolean).
    expect(replicateArgs).toEqual([peer]);
    // No manual pipe under the external-stream path — corestore handles it.
    expect(peer.pipe).not.toHaveBeenCalled();
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

describe('joinHarnessSwarm — shared-swarm late join (existing sockets)', () => {
  it('attaches replication + announce to sockets that existed BEFORE the join', async () => {
    const { swarm } = fakeSwarm();
    const { store, replicateArgs } = fakeStore();
    // A socket opened earlier by ANOTHER topic's join (e.g. the hive-directory
    // gossip) — present in swarm.connections, but 'connection' never re-fires.
    const existing = {
      __muxId: 'pre-existing',
      pipe: vi.fn(),
      remotePublicKey: Buffer.from('cd'.repeat(32), 'hex'),
    };
    (swarm as { connections?: Iterable<unknown> }).connections = [existing];
    const connectedKeys: Array<string | undefined> = [];
    const ours = announceFixture();
    const h = await joinHarnessSwarm({
      store,
      topic: topic32(),
      swarm,
      ourAnnounce: ours,
      onPeerConnected: (k) => connectedKeys.push(k),
    });
    expect(replicateArgs).toEqual([existing]);
    expect(h.connectionCount).toBe(1);
    expect(connectedKeys).toEqual(['cd'.repeat(32)]);
    const st = fakeChannels.get(existing);
    expect(st?.opened).toBe(true);
    expect(st?.sent).toEqual([ours]);
  });

  it('tolerates a swarm without connections (minimal fakes)', async () => {
    const { swarm } = fakeSwarm();
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    expect(h.connectionCount).toBe(0);
  });
});

describe('joinHarnessSwarm — DoS guard (P-003/P-004/P-005)', () => {
  const BANNED_KEY = '11'.repeat(32);
  const BANNED_IP = '198.51.100.9';

  it('drops a banned-key peer before replicating + destroys + fires onPeerRejected', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateArgs } = fakeStore();
    const guard = createSwarmGuard();
    guard.banKey(BANNED_KEY);
    const onPeerRejected = vi.fn();
    await joinHarnessSwarm({ store, topic: topic32(), swarm, guard, onPeerRejected });

    const socket = { pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from(BANNED_KEY, 'hex') });

    expect(replicateArgs).toEqual([]); // never replicated
    expect(socket.pipe).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(onPeerRejected).toHaveBeenCalledWith(BANNED_KEY, undefined);
  });

  it('drops a banned-IP peer (the key-only firewall cannot see IPs)', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateArgs } = fakeStore();
    const guard = createSwarmGuard();
    guard.banIp(BANNED_IP);
    const onPeerRejected = vi.fn();
    await joinHarnessSwarm({ store, topic: topic32(), swarm, guard, onPeerRejected });

    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: BANNED_IP } };
    emit('connection', socket); // no peerInfo → no key, only the IP

    expect(replicateArgs).toEqual([]);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(onPeerRejected).toHaveBeenCalledWith(undefined, BANNED_IP);
  });

  it('fires onPeerRateLimited + destroys when a connection trips the rate limit', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    // Stub guard: not banned (pre-check passes → replicate), but recordConnection
    // reports the connection tripped the rate limit.
    const guard = {
      firewall: () => false,
      isBannedKey: () => false,
      isBannedIp: () => false,
      banKey: () => {},
      banIp: () => {},
      recordConnection: async () => ({ allow: false, reason: 'rate_limited' as const }),
    };
    const onPeerRateLimited = vi.fn();
    const onPeerRejected = vi.fn();
    await joinHarnessSwarm({
      store,
      topic: topic32(),
      swarm,
      guard,
      onPeerRateLimited,
      onPeerRejected,
    });

    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: '203.0.113.8' } };
    emit('connection', socket, { publicKey: Buffer.from('33'.repeat(32), 'hex') });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget settle

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(onPeerRateLimited).toHaveBeenCalledTimes(1);
    expect(onPeerRejected).not.toHaveBeenCalled();
  });

  it('replicates a non-banned peer + does not destroy it', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateArgs } = fakeStore();
    const guard = createSwarmGuard();
    await joinHarnessSwarm({ store, topic: topic32(), swarm, guard });

    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: '203.0.113.4' } };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });
    // Let the fire-and-forget rate-limit settle (in-memory → a few microtasks).
    await new Promise((r) => setTimeout(r, 0));

    expect(replicateArgs).toEqual([socket]);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('counts a shared-swarm physical socket once even when multiple harness handlers attach', async () => {
    const { swarm, emit } = fakeSwarm();
    const first = fakeStore();
    const second = fakeStore();
    const guard = {
      firewall: () => false,
      isBannedKey: () => false,
      isBannedIp: () => false,
      banKey: () => {},
      banIp: () => {},
      recordConnection: vi.fn(async () => ({ allow: true })),
    };
    await joinHarnessSwarm({ store: first.store, topic: topic32(), swarm, guard });
    await joinHarnessSwarm({ store: second.store, topic: Buffer.alloc(32, 2), swarm, guard });

    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: '203.0.113.44' } };
    emit('connection', socket, { publicKey: Buffer.from('44'.repeat(32), 'hex') });
    await new Promise((r) => setTimeout(r, 0));

    expect(first.replicateArgs).toEqual([socket]);
    expect(second.replicateArgs).toEqual([socket]);
    expect(guard.recordConnection).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});

describe('joinHarnessSwarm — announce channel (Stage 4b)', () => {
  it('sends ourAnnounce + opens the channel on a non-banned connection', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const ourAnnounce = announceFixture({ log_core_key: 'aa'.repeat(32) });
    await joinHarnessSwarm({ store, topic: topic32(), swarm, ourAnnounce, onAnnounce: vi.fn() });

    const socket = { __muxId: 's1', pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });

    const ch = fakeChannels.get(socket)!;
    expect(ch.opened).toBe(true);
    expect(ch.sent).toEqual([ourAnnounce]);
  });

  it('uses the Hypercore noiseStream muxer when a Hyperswarm socket wraps one', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store, replicateArgs } = fakeStore();
    const ourAnnounce = announceFixture({ log_core_key: 'ab'.repeat(32) });
    await joinHarnessSwarm({ store, topic: topic32(), swarm, ourAnnounce, onAnnounce: vi.fn() });

    const noiseStream = { __muxId: 'inner-noise', pipe: vi.fn(), destroy: vi.fn() };
    const socket = { __muxId: 'outer-socket', noiseStream, pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });

    expect(replicateArgs).toEqual([socket]);
    expect(fakeChannels.get(socket)).toBeUndefined();
    const ch = fakeChannels.get(noiseStream)!;
    expect(ch.opened).toBe(true);
    expect(ch.sent).toEqual([ourAnnounce]);
  });

  it('sends ourAnnounce from the channel onopen — NOT before the channel pairs (Fix 5)', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const ourAnnounce = announceFixture({ log_core_key: 'ee'.repeat(32) });
    await joinHarnessSwarm({ store, topic: topic32(), swarm, ourAnnounce, onAnnounce: vi.fn() });

    // `__deferOpen` makes the fake protomux NOT auto-fire onopen on open(),
    // modeling Protomux only invoking onopen once the REMOTE peer opens the
    // matching protocol.
    const socket = { __muxId: 'deferred', __deferOpen: true, pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });

    const ch = fakeChannels.get(socket)!;
    // open() ran but the peer hasn't paired → nothing sent yet (the bug Fix 5
    // guards against: a synchronous post-open() send would be dropped here).
    expect(ch.opened).toBe(true);
    expect(ch.sent).toEqual([]);

    // Peer pairs → Protomux fires onopen → the announce is sent exactly once.
    ch.onopen!();
    expect(ch.sent).toEqual([ourAnnounce]);
    // A duplicate onopen must not double-send.
    ch.onopen!();
    expect(ch.sent).toEqual([ourAnnounce]);
  });

  it('a VALID inbound announce → onAnnounce admits, adds a remote log + merges', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    // Stand-in for boot.ts's onAnnounce: admit on a valid sig, track admitted.
    const admitted = new Set<string>();
    const mergeNow = vi.fn(async () => 1);
    const onAnnounce = vi.fn(async (frame: SignedAnnounce) => {
      // (verifyAnnounce + the real decider live in boot.ts; here we model the
      // admit path: a valid frame is admitted, its log is added, a merge runs.)
      admitted.add(frame.log_core_key);
      await mergeNow();
      return { admit: true as const };
    });
    await joinHarnessSwarm({ store, topic: topic32(), swarm, ourAnnounce: announceFixture(), onAnnounce });

    const socket = { __muxId: 's2', pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });

    // Drive an inbound announce through the channel's onmessage.
    const incoming = announceFixture({ log_core_key: 'cc'.repeat(32) });
    fakeChannels.get(socket)!.onmessage!(incoming);
    await new Promise((r) => setTimeout(r, 0)); // let the async onAnnounce settle

    expect(onAnnounce).toHaveBeenCalledWith(incoming);
    expect(admitted.has('cc'.repeat(32))).toBe(true);
    expect(mergeNow).toHaveBeenCalledTimes(1);
  });

  it('a FORGED announce (onAnnounce rejects) → not admitted, no merge', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const admitted = new Set<string>();
    const mergeNow = vi.fn(async () => 0);
    // Model the boot decider's reject path: verifyAnnounce false → not admitted.
    const onAnnounce = vi.fn(async (_frame: SignedAnnounce) => {
      return { admit: false as const, reason: 'bad_sig' as const };
    });
    await joinHarnessSwarm({ store, topic: topic32(), swarm, ourAnnounce: announceFixture(), onAnnounce });

    const socket = { __muxId: 's3', pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });

    const forged = announceFixture({ sig: 'dGFtcGVyZWQ', log_core_key: 'dd'.repeat(32) });
    fakeChannels.get(socket)!.onmessage!(forged);
    await new Promise((r) => setTimeout(r, 0));

    expect(onAnnounce).toHaveBeenCalledWith(forged);
    expect(admitted.size).toBe(0);
    expect(mergeNow).not.toHaveBeenCalled();
  });

  it('a banned peer is dropped BEFORE the announce channel opens', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const guard = createSwarmGuard();
    const BANNED = '11'.repeat(32);
    guard.banKey(BANNED);
    const onAnnounce = vi.fn();
    await joinHarnessSwarm({ store, topic: topic32(), swarm, guard, ourAnnounce: announceFixture(), onAnnounce });

    const socket = { __muxId: 's4', pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from(BANNED, 'hex') });

    // No channel opened for a dropped peer → nothing sent, onAnnounce unused.
    expect(fakeChannels.get(socket)).toBeUndefined();
    expect(onAnnounce).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
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
