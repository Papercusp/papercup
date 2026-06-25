/**
 * directory-swarm.test.ts — the hive-directory gossip transport (P-003 boot-join).
 *
 * Mocks Protomux to a controllable fake muxer so the join → pair → send-ours →
 * receive → broadcast → close lifecycle unit-tests without a real swarm/socket.
 * The REAL-transport semantics (DHT discovery via the refresh loop, protomux
 * channel pairing + lazy accept over an actual socket) are pinned by
 * __tests__/hive-directory-live-two-peer.test.ts on a live testnet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Protomux fake: one muxer per socket (userData convention). createChannel
//    captures (protocol, id, onopen/onclose) and models the `unique` null-return
//    for a duplicate (protocol, id); pair() registers the lazy-accept notifier.
interface FakeChannel {
  protocol: string;
  id: Buffer | null;
  onopen?: () => void;
  onclose?: () => void;
  sent: unknown[];
  inbound?: (frame: unknown) => void;
  opened: boolean;
  closed: boolean;
  open(): void;
  /** The REMOTE peer pairs → Protomux fires onopen. */
  pairRemote(): void;
  fireClose(): void;
}
interface FakeMux {
  channels: FakeChannel[];
  notify: ((id: Buffer | null) => void | Promise<void>) | null;
  createChannel(spec: {
    protocol: string;
    id?: Buffer | null;
    onopen?: () => void;
    onclose?: () => void;
  }): FakeChannel | null;
  pair(opts: { protocol: string }, notify: (id: Buffer | null) => void | Promise<void>): void;
  /** Simulate an inbound remote open for (protocol, id) — fires the notifier. */
  remoteOpens(id: Buffer): void;
}
const allChannels: FakeChannel[] = [];
function makeMux(): FakeMux {
  const mux: FakeMux = {
    channels: [],
    notify: null,
    createChannel(spec) {
      // protomux `unique`: a second live channel for the same (protocol, id) → null.
      const key = `${spec.protocol}::${spec.id ? spec.id.toString('hex') : ''}`;
      const dup = mux.channels.find(
        (ch) => !ch.closed && `${ch.protocol}::${ch.id ? ch.id.toString('hex') : ''}` === key,
      );
      if (dup) return null;
      const ch: FakeChannel = {
        protocol: spec.protocol,
        id: spec.id ?? null,
        onopen: spec.onopen,
        onclose: spec.onclose,
        sent: [],
        opened: false,
        closed: false,
        open() {
          this.opened = true;
        },
        pairRemote() {
          this.onopen?.();
        },
        fireClose() {
          this.closed = true;
          this.onclose?.();
        },
      };
      (ch as unknown as { addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void } }).addMessage =
        (m) => {
          ch.inbound = m.onmessage;
          return { send: (v: unknown) => ch.sent.push(v) };
        };
      mux.channels.push(ch);
      allChannels.push(ch);
      return ch;
    },
    pair(_opts, notify) {
      mux.notify = notify;
    },
    remoteOpens(id: Buffer) {
      mux.notify?.(id);
    },
  };
  return mux;
}
vi.mock('protomux', () => ({
  default: {
    from: (socket: { userData?: unknown }) => {
      if (socket.userData) return socket.userData;
      // Protomux.from does NOT set userData; the source does (the hypercore convention).
      return makeMux();
    },
  },
}));

const { createDirectoryGossip, HIVE_DIRECTORY_PROTOCOL } = await import('./directory-swarm');
import type { SignedHiveAnnounce } from './hive-announce';

const TOPIC = Buffer.alloc(32, 7);
const TOPIC2 = Buffer.alloc(32, 9);
const HEX = TOPIC.toString('hex');
const HEX2 = TOPIC2.toString('hex');
const frame = (id: string): SignedHiveAnnounce =>
  ({ hive_id: id, title: id, description: '', owner_github_login: 'a', owner_github_user_id: 1, owner_device_pubkey: 'pk', attestation_gist_id: 'g', member_topics: [], visibility: 'public', created_at: 0, ts: 0, sig: 's' }) as SignedHiveAnnounce;

/** A fake HyperswarmLike capturing join/leave + the connection handler. */
function fakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  const joined: Buffer[] = [];
  const left: Buffer[] = [];
  const refreshed: Buffer[] = [];
  const connections = new Set<unknown>();
  return {
    swarm: {
      join(t: Buffer) {
        joined.push(t);
        return {
          refresh: () => {
            refreshed.push(t);
          },
        };
      },
      leave(t: Buffer) {
        left.push(t);
      },
      on(_e: 'connection', l: (s: unknown) => void) {
        handler = l;
      },
      off() {
        handler = null;
      },
      // The live Set the real Hyperswarm exposes — gossip seeds from it at
      // creation so a socket opened BEFORE the gossip was wired still pairs.
      connections,
    },
    /** Simulate an inbound connection; returns its socket (muxer via userData). */
    connect(): { userData?: FakeMux } {
      const socket: { userData?: FakeMux } = {};
      connections.add(socket);
      handler?.(socket);
      return socket;
    },
    /** A socket the swarm ALREADY had before the gossip attached its handler
     *  (e.g. the substrate's A↔B socket): present in `connections`, but it never
     *  re-emits 'connection'. The WI-647 case. */
    preconnect(): { userData?: FakeMux } {
      const socket: { userData?: FakeMux } = {};
      connections.add(socket);
      return socket;
    },
    get handler() {
      return handler;
    },
    joined,
    left,
    refreshed,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  allChannels.length = 0;
});

describe('createDirectoryGossip', () => {
  it('joinTopic joins the swarm topic (server+client) and registers ONE connection handler', () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 0 });
    expect(f.handler).toBeTypeOf('function');
    g.joinTopic(TOPIC);
    expect(f.joined).toHaveLength(1);
    expect(f.joined[0].equals(TOPIC)).toBe(true);
    expect(g.topicsJoined).toEqual([HEX]);
    g.joinTopic(TOPIC); // idempotent
    expect(f.joined).toHaveLength(1);
  });

  it('rejects a non-32-byte topic', () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 0 });
    expect(() => g.joinTopic(Buffer.alloc(10))).toThrow(/32-byte/);
  });

  it('opens a channel per (connection, topic) keyed by the topic id, and sends topic-scoped announces on pair', async () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({
      swarm: f.swarm,
      onAnnounce: () => {},
      getOwnAnnounces: (hex) => (hex === HEX ? [frame('mine-1'), frame('mine-2')] : [frame('other')]),
      refreshMs: 0,
    });
    g.joinTopic(TOPIC);
    g.joinTopic(TOPIC2);
    const socket = f.connect();
    const mux = socket.userData!;
    // One channel per topic on the SAME muxer, each keyed by its topic id.
    expect(mux.channels).toHaveLength(2);
    expect(mux.channels[0].protocol).toBe(HIVE_DIRECTORY_PROTOCOL);
    expect(mux.channels.map((ch) => ch.id?.toString('hex'))).toEqual([HEX, HEX2]);
    // Pair only the first topic's channel → ONLY its scoped announces flow.
    mux.channels[0].pairRemote();
    await tick();
    expect(mux.channels[0].sent.map((s) => (s as SignedHiveAnnounce).hive_id)).toEqual(['mine-1', 'mine-2']);
    expect(mux.channels[1].sent).toHaveLength(0);
  });

  it('uses the Hypercore noiseStream muxer when a Hyperswarm socket wraps one', () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({
      swarm: f.swarm,
      onAnnounce: () => {},
      getOwnAnnounces: () => [],
      refreshMs: 0,
    });
    g.joinTopic(TOPIC);

    const noiseStream: { userData?: FakeMux } = {};
    const socket: { userData?: FakeMux; noiseStream: typeof noiseStream } = { noiseStream };
    f.handler?.(socket);

    expect(socket.userData).toBeUndefined();
    expect(noiseStream.userData).toBeTruthy();
    expect(noiseStream.userData!.channels).toHaveLength(1);
    expect(noiseStream.userData!.channels[0].id?.toString('hex')).toBe(HEX);
  });

  it('pipes inbound frames to onAnnounce', () => {
    const f = fakeSwarm();
    const seen: string[] = [];
    const g = createDirectoryGossip({
      swarm: f.swarm,
      onAnnounce: (fr) => {
        seen.push(fr.hive_id);
      },
      getOwnAnnounces: () => [],
      refreshMs: 0,
    });
    g.joinTopic(TOPIC);
    const socket = f.connect();
    socket.userData!.channels[0].inbound?.(frame('remote-1'));
    expect(seen).toEqual(['remote-1']);
  });

  it('broadcast is per-topic and only reaches PAIRED channels', async () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 0 });
    g.joinTopic(TOPIC);
    g.joinTopic(TOPIC2);
    const s1 = f.connect();
    const s2 = f.connect();
    s1.userData!.channels[0].pairRemote(); // socket 1, TOPIC paired
    s1.userData!.channels[1].pairRemote(); // socket 1, TOPIC2 paired
    s2.userData!.channels[0].pairRemote(); // socket 2, TOPIC paired (TOPIC2 unpaired)
    await tick();
    expect(g.openChannelCount(HEX)).toBe(2);
    expect(g.openChannelCount(HEX2)).toBe(1);
    g.broadcast(HEX, frame('bcast'));
    expect(s1.userData!.channels[0].sent.some((x) => (x as SignedHiveAnnounce).hive_id === 'bcast')).toBe(true);
    expect(s2.userData!.channels[0].sent.some((x) => (x as SignedHiveAnnounce).hive_id === 'bcast')).toBe(true);
    // TOPIC2 channels never see a TOPIC broadcast.
    expect(s1.userData!.channels[1].sent).toHaveLength(0);
    expect(g.openChannelCount()).toBe(3);
  });

  it('a topic joined AFTER a connection exists opens its channel on that connection (late join)', () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 0 });
    g.joinTopic(TOPIC);
    const socket = f.connect();
    expect(socket.userData!.channels).toHaveLength(1);
    g.joinTopic(TOPIC2); // late join — must reach the existing socket
    expect(socket.userData!.channels).toHaveLength(2);
    expect(socket.userData!.channels[1].id?.toString('hex')).toBe(HEX2);
  });

  it('seeds from EXISTING swarm connections at creation, so a lazily-wired gossip pairs over an already-open socket (WI-647)', async () => {
    const f = fakeSwarm();
    // The substrate already opened the shared A↔B socket BEFORE the directory
    // gossip is wired — it lives in swarm.connections but never re-emits
    // 'connection'.
    const preexisting = f.preconnect();
    const g = createDirectoryGossip({
      swarm: f.swarm,
      onAnnounce: () => {},
      getOwnAnnounces: (hex) => (hex === HEX ? [frame('mine')] : []),
      refreshMs: 0,
    });
    // Joining the global topic must open + pair its channel on the PRE-EXISTING
    // socket — not only on sockets seen via a future 'connection' event.
    g.joinTopic(TOPIC);
    expect(preexisting.userData!.channels).toHaveLength(1);
    expect(preexisting.userData!.channels[0].id?.toString('hex')).toBe(HEX);
    preexisting.userData!.channels[0].pairRemote();
    await tick();
    // The peer is reachable (was 0 before the fix) and gets our scoped announce.
    expect(g.openChannelCount(HEX)).toBe(1);
    expect(preexisting.userData!.channels[0].sent.map((s) => (s as SignedHiveAnnounce).hive_id)).toEqual(['mine']);
  });

  it('the pair-notifier lazily accepts a remote open ONLY for a joined topic', () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 0 });
    g.joinTopic(TOPIC);
    const socket = f.connect();
    const mux = socket.userData!;
    expect(mux.channels).toHaveLength(1);
    // Remote opens a channel for a topic we have NOT joined → rejected (no channel).
    mux.remoteOpens(TOPIC2);
    expect(mux.channels).toHaveLength(1);
    // We join it → remote re-pairing path: the notifier now accepts.
    g.joinTopic(TOPIC2);
    expect(mux.channels).toHaveLength(2);
    mux.remoteOpens(TOPIC2); // duplicate open while live → unique-null, no extra channel
    expect(mux.channels).toHaveLength(2);
  });

  it('a closed channel drops out of the broadcast set', async () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 0 });
    g.joinTopic(TOPIC);
    const socket = f.connect();
    socket.userData!.channels[0].pairRemote();
    await tick();
    expect(g.openChannelCount(HEX)).toBe(1);
    socket.userData!.channels[0].fireClose();
    expect(g.openChannelCount(HEX)).toBe(0);
  });

  it('the refresh loop drives every joined topic’s discovery.refresh()', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeSwarm();
      const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 50 });
      g.joinTopic(TOPIC);
      g.joinTopic(TOPIC2);
      expect(f.refreshed).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(120);
      // Two ticks × two topics.
      expect(f.refreshed.filter((t) => t.equals(TOPIC)).length).toBeGreaterThanOrEqual(2);
      expect(f.refreshed.filter((t) => t.equals(TOPIC2)).length).toBeGreaterThanOrEqual(2);
      await g.close();
      const n = f.refreshed.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(f.refreshed.length).toBe(n); // close stops the loop
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off to the slow keepalive after the fast window, and re-arms on last-peer loss', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeSwarm();
      const g = createDirectoryGossip({
        swarm: f.swarm,
        onAnnounce: () => {},
        getOwnAnnounces: () => [],
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 1000,
      });
      g.joinTopic(TOPIC);
      // Fast window: ticks at 50/100/150 are inside it (200 is not).
      await vi.advanceTimersByTimeAsync(200);
      const fastCount = f.refreshed.length;
      expect(fastCount).toBeGreaterThanOrEqual(3);
      // Past the window, before the slow keepalive is due → silent.
      await vi.advanceTimersByTimeAsync(800);
      expect(f.refreshed.length).toBe(fastCount);
      // Slow keepalive fires once due (lastRefresh + slowRefreshMs).
      await vi.advanceTimersByTimeAsync(200);
      expect(f.refreshed.length).toBe(fastCount + 1);
      // Losing the topic's LAST peer re-arms the fast window.
      const socket = f.connect();
      socket.userData!.channels[0].pairRemote();
      await vi.advanceTimersByTimeAsync(0);
      socket.userData!.channels[0].fireClose();
      const n = f.refreshed.length;
      await vi.advanceTimersByTimeAsync(150);
      expect(f.refreshed.length).toBeGreaterThanOrEqual(n + 2);
      await g.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close leaves every topic and detaches the handler', async () => {
    const f = fakeSwarm();
    const g = createDirectoryGossip({ swarm: f.swarm, onAnnounce: () => {}, getOwnAnnounces: () => [], refreshMs: 0 });
    g.joinTopic(TOPIC);
    g.joinTopic(TOPIC2);
    await g.close();
    expect(f.left.map((t) => t.toString('hex')).sort()).toEqual([HEX, HEX2].sort());
    expect(f.handler).toBeNull();
    expect(() => g.joinTopic(TOPIC)).toThrow(/closed/);
  });
});
