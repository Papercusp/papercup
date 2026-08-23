import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  joinHarnessSwarm,
  swarmConstructorOpts,
  extractPublicKeyHex,
  extractRemoteIp,
  resolveDhtUniverseState,
  assertDhtUniverse,
  readExpectedDhtBootstrap,
  readEffectiveDhtBootstrapRaw,
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
    // EI-18682571591024156: the callback now also receives a PeerSignallingInfo
    // stating what the fire actually proves — SIGNALLING success, never a
    // demonstrated data path (see swarm-data-path-honesty.test.ts).
    expect(cb).toHaveBeenCalledWith(
      'abcd',
      expect.objectContaining({ signallingOnly: true, dataPathProven: null }),
    );
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

  it('WI-5895: never crashes the handler on a replication throw, but no longer swallows it silently — logs loudly + tears the socket down', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const badStore = {
      replicate() {
        throw new Error('local replicate failed');
      },
    } as unknown as Corestore;
    const cb = vi.fn(); // onPeerConnected must NOT fire for a wiring failure
    await joinHarnessSwarm({ store: badStore, topic: topic32(), swarm, onPeerConnected: cb });
    const peer = { pipe: vi.fn(), destroy: vi.fn() };
    expect(() => emit('connection', peer)).not.toThrow();

    // 1. Logged loudly (never silently swallowed) with enough context to diagnose.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('replication wiring failed'),
      expect.objectContaining({ error: expect.stringContaining('local replicate failed') }),
    );
    // 2. The half-wired connection is torn down immediately, not left looking alive.
    expect(peer.destroy).toHaveBeenCalledTimes(1);
    // A connection whose wiring threw never actually replicated — don't report it as connected.
    expect(cb).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('WI-5895: a wiring-throw teardown never crashes even when the socket has no destroy() (best-effort)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const badStore = {
      replicate() {
        throw new Error('local replicate failed');
      },
    } as unknown as Corestore;
    await joinHarnessSwarm({ store: badStore, topic: topic32(), swarm });
    // No `destroy` method on this fake — destroySocket's optional-chaining must not throw.
    expect(() => emit('connection', { pipe: vi.fn() })).not.toThrow();
    errorSpy.mockRestore();
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

  // WI-1840/WI-183 (rig run m1783120511): liveConnectionCount must read the
  // shared swarm's OWN live socket set, not a per-join counter. A per-join
  // counter misses any socket whose 'connection' event pre-dated this join's
  // registration (shared-swarm dedup across topics; rekey() replaces the
  // handle with a zero counter) — which read swarmConnections=0 on live rigs
  // and silently disarmed the connected_never_replicated axis in exactly the
  // zombie-connection scenario it exists to catch.
  it('liveConnectionCount reads the shared swarm live socket set (Set fast path)', async () => {
    const { swarm } = fakeSwarm();
    const { store } = fakeStore();
    const live = new Set<unknown>([{ pipe: vi.fn() }, { pipe: vi.fn() }]);
    (swarm as { connections?: Iterable<unknown> }).connections = live;
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    expect(h.liveConnectionCount).toBe(2); // pre-existing sockets, no events fired
    live.add({ pipe: vi.fn() });
    expect(h.liveConnectionCount).toBe(3); // tracks the LIVE set, not join-time
  });

  it('liveConnectionCount counts a non-Set iterable connections surface', async () => {
    const { swarm } = fakeSwarm();
    const { store } = fakeStore();
    (swarm as { connections?: Iterable<unknown> }).connections = [
      { pipe: vi.fn() },
      { pipe: vi.fn() },
    ];
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    expect(h.liveConnectionCount).toBe(2);
  });

  it('liveConnectionCount falls back to the per-join counter without connections', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    expect(h.liveConnectionCount).toBe(0);
    emit('connection', { pipe: vi.fn() });
    emit('connection', { pipe: vi.fn() });
    expect(h.liveConnectionCount).toBe(2);
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

  it('forceRejoin destroys a peer socket even when another topic still shares it (EI-13317/WI-5481 deadlock break)', async () => {
    const { swarm, state, emit } = fakeSwarm();
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
    // Two harness topics on ONE shared swarm — the live-fed rig muxes several
    // harnesses (hello-world-pot + hello-world + papercusp) over a single peer
    // connection this way.
    const h1 = await joinHarnessSwarm({ store: first.store, topic: topic32(), swarm, guard });
    await joinHarnessSwarm({ store: second.store, topic: Buffer.alloc(32, 2), swarm, guard });

    // One physical socket connects — BOTH topics' handlers claim it, so it is
    // shared (isSocketIdleAcrossAllTopics === false for either topic).
    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: '203.0.113.55' } };
    emit('connection', socket, { publicKey: Buffer.from('55'.repeat(32), 'hex') });
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.destroy).not.toHaveBeenCalled(); // a healthy shared connection is left alone

    // Topic 1 forces a rejoin (its link is proven dead past the repair ladder).
    // Even though topic 2 still claims the SAME socket, it MUST be evicted:
    // a dead handshake is dead for every muxed topic, and the old
    // idle-across-all-topics guard deadlocked here (each topic waited for the
    // others to evict; nobody did), leaving the link connected-but-dead until
    // the OS TCP timeout ~6 min later (past the 90s replication_soak SLA).
    await h1.forceRejoin();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    // and it did fire the actual leave()+join() rejoin
    expect(state.leaves.length).toBe(1);
  });
});

describe('joinHarnessSwarm — forceRejoin topic-scoped coordination (WI-5923)', () => {
  const guard = () => ({
    firewall: () => false,
    isBannedKey: () => false,
    isBannedIp: () => false,
    banKey: () => {},
    banIp: () => {},
    recordConnection: vi.fn(async () => ({ allow: true })),
  });

  it('one sibling forcing a rejoin performs exactly ONE topic-wide swarm.leave() and rejoins EVERY sibling on the same topic, not just itself', async () => {
    const { swarm, state } = fakeSwarm();
    const first = fakeStore();
    const second = fakeStore();
    // Two harnesses sharing ONE topic on ONE process swarm — the exact
    // Shared-Hive shape (boot.ts joins once per member harness on a per-Hive
    // topic) that made the OLD process-wide `swarm.leave()` self-cancelling:
    // harness A's forced rejoin used to destroy harness B's live session with
    // no callback, and vice versa, in a ping-pong bounded only by
    // MAX_UNPAIRED_ESCALATIONS.
    const h1 = await joinHarnessSwarm({ store: first.store, topic: topic32(), swarm, guard: guard() });
    const h2 = await joinHarnessSwarm({ store: second.store, topic: topic32(), swarm, guard: guard() });
    expect(state.joins.length).toBe(2);
    expect(state.leaves.length).toBe(0);

    // Only h1's escalation ladder fires — h2 never asked for a rejoin.
    await h1.forceRejoin();

    // Exactly ONE real topic-wide leave (not one per sibling — that's the
    // OLD self-cancelling behavior) …
    expect(state.leaves.length).toBe(1);
    // … but EVERY sibling on the topic rejoined onto the fresh discovery, not
    // just the caller: 2 initial joins + 2 rejoins (h1's own + h2's, driven by
    // the coordinator on h2's behalf even though h2 never called forceRejoin
    // itself).
    expect(state.joins.length).toBe(4);

    // Neither sibling is left "orphaned" (holding a stale session with no
    // sign anything happened) — both still observe live connection events
    // normally after the coordinated rejoin.
    const socket = { pipe: vi.fn(), destroy: vi.fn(), rawStream: { remoteHost: '203.0.113.9' } };
    // Re-emit via the swarm's own listener registry (both instances are
    // still attached — the coordinator never touches `on`/`off`).
    for (const l of state.listeners.get('connection') ?? []) {
      l(socket, { publicKey: Buffer.from('99'.repeat(32), 'hex') });
    }
    expect(h1.liveConnectionCount).toBe(1);
    expect(h2.liveConnectionCount).toBe(1);
  });

  it('two siblings forcing a rejoin ~concurrently collapse onto ONE shared rejoin (fixes the WI-5923 self-cancelling ping-pong)', async () => {
    const { swarm, state } = fakeSwarm();
    const first = fakeStore();
    const second = fakeStore();
    const h1 = await joinHarnessSwarm({ store: first.store, topic: topic32(), swarm, guard: guard() });
    const h2 = await joinHarnessSwarm({ store: second.store, topic: topic32(), swarm, guard: guard() });
    expect(state.joins.length).toBe(2);

    // Both siblings' escalation ladders fire ~simultaneously (the measured
    // WI-5923 signature: detectors ~2.5s out of phase, each escalating on its
    // own topic-wide leave+rejoin). Pre-fix this was TWO independent
    // leave()+join() sequences, each undoing the other's repair. Post-fix the
    // second call folds into the first's in-flight operation.
    await Promise.all([h1.forceRejoin(), h2.forceRejoin()]);

    expect(state.leaves.length).toBe(1);
    expect(state.joins.length).toBe(4); // 2 initial + ONE coordinated round (2 rejoins), not 2 rounds
  });

  it('closing one sibling does not disrupt (or re-leave) the topic for a sibling that stays joined', async () => {
    const { swarm, state } = fakeSwarm();
    const first = fakeStore();
    const second = fakeStore();
    const h1 = await joinHarnessSwarm({ store: first.store, topic: topic32(), swarm, guard: guard() });
    const h2 = await joinHarnessSwarm({ store: second.store, topic: topic32(), swarm, guard: guard() });

    await h1.close();
    // close() prefers the refcounted discovery.destroy() (fakeSwarm's join()
    // doesn't return one, so this falls back to swarm.leave() — unrelated to
    // the topic-rejoin coordinator, which h1.close() also unregisters from
    // without triggering a coordinated rejoin of its own).
    expect(state.leaves.length).toBe(1);

    // h2 is still live and can still force its OWN rejoin — now the SOLE
    // remaining participant, so it's back to the single-instance behavior.
    await h2.forceRejoin();
    expect(state.leaves.length).toBe(2);
    expect(state.joins.length).toBe(3); // 2 initial + h2's own rejoin (h1 already closed, never re-joined)
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

  it('pushes a fresh signed writer high-water on refreshAnnounce instead of waiting for the periodic sweep', async () => {
    const { swarm, emit } = fakeSwarm();
    const { store } = fakeStore();
    const logKey = 'ac'.repeat(32);
    let logLength = 26;
    const buildOurAnnounce = vi.fn(async () =>
      announceFixture({ log_core_key: logKey, log_length: logLength }),
    );
    const h = await joinHarnessSwarm({
      store,
      topic: topic32(),
      swarm,
      ourAnnounce: announceFixture({ log_core_key: logKey, log_length: logLength }),
      buildOurAnnounce,
      onAnnounce: vi.fn(),
    });

    const socket = { __muxId: 'writer-progress', pipe: vi.fn(), destroy: vi.fn() };
    emit('connection', socket, { publicKey: Buffer.from('22'.repeat(32), 'hex') });
    const ch = fakeChannels.get(socket)!;
    await vi.waitFor(() => expect(ch.sent.at(-1)?.log_length).toBe(26));

    // The WI-40905 edge: the receiver cursor is at 26, then the writer appends
    // post-revoke content. The pushed frame must make length 27 visible now;
    // otherwise the frozen detector reads caught-up until the five-minute sweep.
    logLength = 27;
    h.refreshAnnounce?.();
    await vi.waitFor(() => expect(ch.sent.at(-1)?.log_length).toBe(27));
    expect(buildOurAnnounce).toHaveBeenCalledTimes(2);

    await h.close();
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

    // P-006 §5.2/§5.3: onAnnounce receives the per-connection ctx as a 2nd arg
    // ({ send, muxer }) so the admission layer can serve/disclose on THIS peer.
    expect(onAnnounce).toHaveBeenCalledWith(
      incoming,
      expect.objectContaining({ send: expect.any(Function), muxer: expect.anything() }),
    );
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

    // Still called with the §5.2 per-connection ctx even on the reject path.
    expect(onAnnounce).toHaveBeenCalledWith(
      forged,
      expect.objectContaining({ send: expect.any(Function), muxer: expect.anything() }),
    );
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

  it('WI-5923: close() prefers the session-level destroy() over the process-wide swarm.leave() — never destroys a SIBLING harness/topic session sharing the same swarm', async () => {
    // A real Hyperswarm session (what join() genuinely returns) exposes its own
    // destroy() — this fake models that, PLUS leave(), to prove close() picks
    // the refcounted one instead of the process-wide teardown. If close() ever
    // regressed to calling swarm.leave(topic) again, this test fails on the
    // `leaves` assertion below (leave() would be called once instead of never).
    const state = { leaves: [] as Buffer[], destroyed: 0, listeners: new Map<string, Array<(...a: unknown[]) => void>>() };
    const swarm: HyperswarmLike = {
      join: () => ({
        flushed: () => Promise.resolve(),
        destroy: () => {
          state.destroyed++;
        },
      }),
      leave: (topic) => {
        state.leaves.push(topic);
      },
      on: (event, listener) => {
        const arr = state.listeners.get(event) ?? [];
        arr.push(listener as (...a: unknown[]) => void);
        state.listeners.set(event, arr);
        return swarm;
      },
      off: () => undefined,
    };
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    await h.close();
    expect(state.destroyed).toBe(1);
    // The whole point of WI-5923: a sibling harness's session on the SAME
    // swarm+topic must survive this close() — proven here by NEVER reaching
    // for the process-wide leave() a real Hyperswarm would tear every session
    // down with.
    expect(state.leaves).toHaveLength(0);
  });

  it('WI-5923: close() falls back to swarm.leave() when join() returns no destroy() (a minimal test fake, unchanged behavior)', async () => {
    const { swarm, state } = fakeSwarm();
    const { store } = fakeStore();
    const h = await joinHarnessSwarm({ store, topic: topic32(), swarm });
    await h.close();
    expect(state.leaves).toHaveLength(1);
    expect(state.leaves[0].equals(topic32())).toBe(true);
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
  // Hermetic against ALL env folded into the opts: a box with a live isolated-DHT
  // rig legitimately exports PAPERCUSP_DHT_BOOTSTRAP / PAPERCUSP_DHT_HOST (e.g. the
  // 172.31.44.x tower↔VM drills), which swarmConstructorOpts folds in as
  // `bootstrap`/`dhtHost` — without clearing them these exact-shape assertions fail
  // on that box only (hit live 2026-07-03). Save/clear each, restore after.
  // WI-6063: PAPERCUSP_SWARM_INBOUND_RESERVE joins the list for the same reason —
  // it feeds `maxClientConnections` into these exact-shape assertions, so a box
  // that exports it would fail them. Cleared here (and RESTORED in afterEach)
  // rather than deleted inline in each test, which would not restore it.
  const ENV_KEYS = [
    KEY,
    'PAPERCUSP_DHT_BOOTSTRAP',
    'PAPERCUSP_DHT_HOST',
    'PAPERCUSP_SWARM_INBOUND_RESERVE',
  ] as const;
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      orig[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  it('uses the provided default for maxPeers when there is no env override', () => {
    // Hermetic (P-004): the no-arg default now DERIVES from the host resource
    // profile (resolveDefaultMaxPeers — cores/RAM), which is host/ordering-
    // dependent, so inject a known default to keep this env-parsing test stable.
    delete process.env[KEY];
    // WI-6063 added `maxClientConnections` (maxPeers minus the inbound reserve —
    // clamp(floor(256/8), 8, 64) = 32 → 224). Asserted as part of the exact shape
    // rather than loosened to `.maxPeers`, so the reserve stays pinned here too.
    expect(swarmConstructorOpts({ defaultMaxPeers: 256 })).toEqual({
      maxPeers: 256,
      maxClientConnections: 224,
    });
  });

  it('honors a positive PAPERCUSP_SWARM_MAX_PEERS override', () => {
    process.env[KEY] = '32';
    // Reserve floors at 8 for a small budget: 32 - max(8, floor(32/8)) = 24.
    expect(swarmConstructorOpts()).toEqual({ maxPeers: 32, maxClientConnections: 24 });
  });

  it('falls back to the provided default for non-numeric / non-positive values', () => {
    process.env[KEY] = 'nope';
    expect(swarmConstructorOpts({ defaultMaxPeers: 256 }).maxPeers).toBe(256);
    process.env[KEY] = '0';
    expect(swarmConstructorOpts({ defaultMaxPeers: 256 }).maxPeers).toBe(256);
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

describe('WI-3604: resolveDhtUniverseState (split-DHT-universe recurrence guard)', () => {
  it('unset/empty env → public', () => {
    expect(resolveDhtUniverseState(undefined)).toEqual({ mode: 'public' });
    expect(resolveDhtUniverseState('')).toEqual({ mode: 'public' });
    expect(resolveDhtUniverseState('   ')).toEqual({ mode: 'public' });
  });

  it('a valid host:port list → isolated', () => {
    expect(resolveDhtUniverseState('172.31.44.1:49838')).toEqual({
      mode: 'isolated',
      bootstrap: [{ host: '172.31.44.1', port: 49838 }],
    });
  });

  it('set but all-malformed → misconfigured (the silent-fallback-to-public defect)', () => {
    expect(resolveDhtUniverseState('not-a-valid-entry')).toEqual({
      mode: 'misconfigured',
      envValue: 'not-a-valid-entry',
    });
  });
});

describe('WI-3604: assertDhtUniverse', () => {
  it('no expectation configured → ok regardless of actual', () => {
    expect(assertDhtUniverse({ mode: 'public' }, undefined).ok).toBe(true);
    expect(assertDhtUniverse({ mode: 'public' }, '').ok).toBe(true);
  });

  it('unparsable expectation → ok (never false-positives on a bad config)', () => {
    expect(assertDhtUniverse({ mode: 'public' }, 'garbage').ok).toBe(true);
  });

  it('matching isolated bootstrap → ok', () => {
    const state = resolveDhtUniverseState('172.31.44.1:49838');
    expect(assertDhtUniverse(state, '172.31.44.1:49838').ok).toBe(true);
  });

  it('the 2026-07-09 incident shape: resolved public when isolated expected → mismatch', () => {
    const result = assertDhtUniverse({ mode: 'public' }, '172.31.44.1:49838');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/PUBLIC DHT/);
  });

  it('resolved misconfigured (env set, unparsable) when isolated expected → mismatch', () => {
    const state = resolveDhtUniverseState('garbage-value');
    const result = assertDhtUniverse(state, '172.31.44.1:49838');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no usable nodes/);
  });

  it('resolved a DIFFERENT isolated address than expected → mismatch', () => {
    const state = resolveDhtUniverseState('10.0.0.1:9999');
    const result = assertDhtUniverse(state, '172.31.44.1:49838');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/but this process resolved to/);
  });
});

describe('WI-3604: readExpectedDhtBootstrap', () => {
  const KEY = 'PAPERCUSP_EXPECTED_DHT_BOOTSTRAP';
  const FILE_KEY = 'PAPERCUSP_EXPECTED_DHT_BOOTSTRAP_FILE';
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [KEY, FILE_KEY]) {
      orig[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of [KEY, FILE_KEY]) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  it('prefers the env var when set', () => {
    process.env[KEY] = '172.31.44.1:49838';
    expect(readExpectedDhtBootstrap()).toBe('172.31.44.1:49838');
  });

  it('falls back to a missing file → undefined (best-effort, never throws)', () => {
    process.env[FILE_KEY] = '/nonexistent/path/that/does/not/exist-wi3604';
    expect(readExpectedDhtBootstrap()).toBeUndefined();
  });
});

// ─── EI-8893: readEffectiveDhtBootstrapRaw + file-fallback in swarmConstructorOpts ─
//
// Root cause: on macOS a Server.app that self-relaunches via LaunchServices does
// NOT inherit its LaunchAgent's EnvironmentVariables, so PAPERCUSP_DHT_BOOTSTRAP
// goes missing and the process silently joins the PUBLIC DHT instead of the
// isolated testnet. The durable fix reads the bootstrap from a marker FILE
// (~/.papercusp/dht-bootstrap, or PAPERCUSP_DHT_BOOTSTRAP_FILE) when the env is
// absent — immune to the relaunch env-stripping path entirely.
describe('EI-8893: readEffectiveDhtBootstrapRaw (env→file bootstrap fallback)', () => {
  const ENV_KEY = 'PAPERCUSP_DHT_BOOTSTRAP';
  const FILE_KEY = 'PAPERCUSP_DHT_BOOTSTRAP_FILE';
  const MAXPEERS_KEY = 'PAPERCUSP_SWARM_MAX_PEERS';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path');
  const orig: Record<string, string | undefined> = {};
  let tmpDir: string;
  beforeEach(() => {
    for (const k of [ENV_KEY, FILE_KEY, MAXPEERS_KEY]) {
      orig[k] = process.env[k];
      delete process.env[k];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ei8893-'));
  });
  afterEach(() => {
    for (const k of [ENV_KEY, FILE_KEY, MAXPEERS_KEY]) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prefers the env var when set (unchanged behavior for env-configured hosts)', () => {
    process.env[ENV_KEY] = '172.31.44.1:49838';
    // A file exists too, but the env WINS.
    const file = path.join(tmpDir, 'dht-bootstrap');
    fs.writeFileSync(file, '10.0.0.9:1234', 'utf8');
    process.env[FILE_KEY] = file;
    expect(readEffectiveDhtBootstrapRaw()).toBe('172.31.44.1:49838');
  });

  it('falls back to the marker FILE when the env var is unset (the relaunch fix)', () => {
    const file = path.join(tmpDir, 'dht-bootstrap');
    fs.writeFileSync(file, '172.31.44.1:49838\n', 'utf8');
    process.env[FILE_KEY] = file;
    expect(readEffectiveDhtBootstrapRaw()).toBe('172.31.44.1:49838');
  });

  it('returns undefined when neither env nor file is present (best-effort, never throws)', () => {
    process.env[FILE_KEY] = path.join(tmpDir, 'does-not-exist');
    expect(readEffectiveDhtBootstrapRaw()).toBeUndefined();
  });

  it('REGRESSION: swarmConstructorOpts resolves bootstrap from the file when env is stripped', () => {
    // Simulate the macOS self-relaunch: PAPERCUSP_DHT_BOOTSTRAP is NOT in the
    // environment, but the provisioning file is present. Before the fix,
    // swarmConstructorOpts read env only → bootstrap undefined → PUBLIC DHT.
    const file = path.join(tmpDir, 'dht-bootstrap');
    fs.writeFileSync(file, '172.31.44.1:49838,172.31.44.1:49839', 'utf8');
    process.env[FILE_KEY] = file;
    expect(process.env[ENV_KEY]).toBeUndefined();
    expect(swarmConstructorOpts().bootstrap).toEqual([
      { host: '172.31.44.1', port: 49838 },
      { host: '172.31.44.1', port: 49839 },
    ]);
    // And the boot-banner / recurrence-guard classifier agrees it is ISOLATED,
    // not a false PUBLIC — it consumes the same effective value.
    expect(resolveDhtUniverseState(readEffectiveDhtBootstrapRaw())).toEqual({
      mode: 'isolated',
      bootstrap: [
        { host: '172.31.44.1', port: 49838 },
        { host: '172.31.44.1', port: 49839 },
      ],
    });
  });

  it('a malformed file value falls through to the misconfigured (loud) universe, never a silent public join', () => {
    const file = path.join(tmpDir, 'dht-bootstrap');
    fs.writeFileSync(file, 'garbage-no-port', 'utf8');
    process.env[FILE_KEY] = file;
    expect(swarmConstructorOpts().bootstrap).toBeUndefined();
    expect(resolveDhtUniverseState(readEffectiveDhtBootstrapRaw())).toEqual({
      mode: 'misconfigured',
      envValue: 'garbage-no-port',
    });
  });
});
