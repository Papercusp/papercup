/**
 * topic-gossip-severed-link-escalation.test.ts — EI-13317, the gossip-chassis
 * mirror of swarm-severed-link-escalation.test.ts. Presence/directory gossip
 * rides `createTopicGossip` (topic-gossip.ts's module header: "presence-
 * gossip is the second instantiation"), and the same forensics apply: once a
 * topic that HAD a paired channel sits at zero paired channels for
 * `severedEscalationMs` despite refresh() ticking, it must
 *   1. fire a loud, rate-limited health signal (`onSeveredLink`), and
 *   2. force a topic-level leave()+rejoin() (a fresh discovery session)
 *      instead of trusting the same possibly-stale discovery handle forever.
 *
 * A topic that has never paired (no peer joined yet — the benign case) must
 * NOT escalate.
 *
 * Same Protomux-fake-mock convention as directory-swarm.test.ts (real pairing
 * lifecycle — pairRemote()/fireClose() — without a real socket/DHT), combined
 * with vi fake timers to drive the refresh-loop escalation ladder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeChannel {
  protocol: string;
  id: Buffer | null;
  onopen?: () => void;
  onclose?: () => void;
  sent: unknown[];
  opened: boolean;
  closed: boolean;
  open(): void;
  pairRemote(): void;
  fireClose(): void;
  /** P-203: the `onmessage` handler the module registered via addMessage(). */
  onmessage?: (frame: unknown) => void;
  /** P-203: deliver an inbound frame on this channel (as the remote would). */
  deliver(frame: unknown): void;
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
}
function makeMux(): FakeMux {
  const mux: FakeMux = {
    channels: [],
    notify: null,
    createChannel(spec) {
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
        deliver(frame: unknown) {
          this.onmessage?.(frame);
        },
      };
      (
        ch as unknown as { addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void } }
      ).addMessage = (m) => {
        ch.onmessage = m.onmessage;
        return { send: (v: unknown) => ch.sent.push(v) };
      };
      mux.channels.push(ch);
      return ch;
    },
    pair(_opts, notify) {
      mux.notify = notify;
    },
  };
  return mux;
}
vi.mock('protomux', () => ({
  default: {
    from: (socket: { userData?: unknown }) => {
      if (socket.userData) return socket.userData;
      return makeMux();
    },
  },
}));

const { createTopicGossip, DEFAULT_SEVERED_ESCALATION_MS } = await import('./topic-gossip');
// WI-5217: was a hand-duplicated local `{ topicHex, severedMs }` type that drifted from
// the real GossipSeveredLinkInfo (which gained `neverPaired?: boolean`) — import the real
// type instead so it can never drift again.
import type { GossipSeveredLinkInfo } from './topic-gossip';
import type { HyperswarmLike } from './swarm';

const TOPIC = Buffer.alloc(32, 11);
const HEX = TOPIC.toString('hex');

/** A fake HyperswarmLike capturing join/leave + the connection handler
 *  (mirrors directory-swarm.test.ts's fakeSwarm()). */
function fakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  const joined: Buffer[] = [];
  const left: Buffer[] = [];
  const connections = new Set<unknown>();
  const swarm: HyperswarmLike = {
    join(t: Buffer) {
      joined.push(t);
      return { refresh: () => {} };
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
    connections,
  };
  return {
    swarm,
    /** `rawStream` (P-203): optionally expose UDX-shaped wire counters, the way a
     *  real NoiseSecretStream does via `socket.rawStream.bytesReceived`. */
    connect(rawStream?: { bytesReceived: number }): {
      userData?: FakeMux;
      destroy: (err?: Error) => void;
      destroyed: boolean;
      rawStream?: { bytesReceived: number };
    } {
      const socket = {
        userData: undefined as FakeMux | undefined,
        destroyed: false,
        rawStream,
        destroy(_err?: Error) {
          socket.destroyed = true;
          connections.delete(socket);
        },
      };
      connections.add(socket);
      handler?.(socket);
      return socket;
    },
    joined,
    left,
    connections,
  };
}

type Frame = { kind: string };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createTopicGossip severed-link escalation ladder (EI-13317)', () => {
  it('escalates a topic that has NEVER paired at 2× the threshold (fresh-join stale-DHT limbo, WI-5211)', async () => {
    const f = fakeSwarm();
    const onSeveredLink = vi.fn();
    const g = createTopicGossip<Frame>({
      swarm: f.swarm,
      protocol: 'papercusp/test-gossip',
      onFrame: () => {},
      getHelloFrames: () => [],
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 1000,
      onSeveredLink,
    });
    g.joinTopic(TOPIC);
    expect(f.joined).toHaveLength(1);

    // Under 2× the severed threshold — the initial join keeps its honest chance.
    await vi.advanceTimersByTimeAsync(1900);
    expect(onSeveredLink).not.toHaveBeenCalled();
    expect(f.left).toHaveLength(0);

    // Past 2× — the never-paired escalation kicks a fresh leave+rejoin (the
    // win-rig hive-presence limbo: joined while the only counterpart was
    // unwired, then sat at zero channels forever with no kick).
    await vi.advanceTimersByTimeAsync(300);
    expect(onSeveredLink).toHaveBeenCalledTimes(1);
    const info = onSeveredLink.mock.calls[0]![0] as GossipSeveredLinkInfo;
    expect(info.topicHex).toBe(HEX);
    expect(info.neverPaired).toBe(true);
    expect(f.left).toHaveLength(1);
    expect(f.joined).toHaveLength(2);

    // Rate-limited at the same 2× window — no immediate re-fire.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSeveredLink).toHaveBeenCalledTimes(1);
    await g.close();
  });

  it('escalates (leave+rejoin + loud signal) once a topic that HAD a peer sits severed past the threshold', async () => {
    const f = fakeSwarm();
    const onSeveredLink = vi.fn();
    const g = createTopicGossip<Frame>({
      swarm: f.swarm,
      protocol: 'papercusp/test-gossip',
      onFrame: () => {},
      getHelloFrames: () => [],
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 1000,
      onSeveredLink,
    });
    g.joinTopic(TOPIC);
    expect(f.joined).toHaveLength(1); // the initial join

    // Pair, then the remote side drops — genuinely severed (had a peer, now none).
    const socket = f.connect();
    const ch = socket.userData!.channels[0];
    expect(ch.id?.toString('hex')).toBe(HEX);
    ch.pairRemote();
    expect(g.openChannelCount(HEX)).toBe(1);
    ch.fireClose();
    expect(g.openChannelCount(HEX)).toBe(0);

    // Under the threshold — no escalation yet.
    await vi.advanceTimersByTimeAsync(700);
    expect(onSeveredLink).not.toHaveBeenCalled();
    expect(f.left).toHaveLength(0);

    // Cross the threshold (fastWindowStartMs re-armed at fireClose()).
    await vi.advanceTimersByTimeAsync(400);
    expect(onSeveredLink).toHaveBeenCalledTimes(1);
    const info = onSeveredLink.mock.calls[0]![0] as GossipSeveredLinkInfo;
    expect(info.topicHex).toBe(HEX);
    expect(info.severedMs).toBeGreaterThanOrEqual(1000);
    expect(f.left).toHaveLength(1);
    expect(f.left[0]).toBe(TOPIC);
    // The rejoin fires a fresh join call.
    expect(f.joined).toHaveLength(2);
    await g.close();
  });

  it('WI-5355: evicts a zombie socket (idle across all topics) before rejoining on escalation', async () => {
    // Traced root cause: node_modules/hyperswarm's client-side rediscovery
    // (`_handlePeer`) no-ops whenever `_allConnections.has(peer.publicKey)`
    // is already true — a plain leave()+join() alone never gets Hyperswarm to
    // even ATTEMPT a fresh connection to a peer it still thinks is live. The
    // escalation must evict the dead socket so the next rejoin can actually
    // result in a new connection attempt.
    const f = fakeSwarm();
    const g = createTopicGossip<Frame>({
      swarm: f.swarm,
      protocol: 'papercusp/test-gossip',
      onFrame: () => {},
      getHelloFrames: () => [],
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 1000,
    });
    g.joinTopic(TOPIC);
    const socket = f.connect();
    const ch = socket.userData!.channels[0];
    ch.pairRemote();
    ch.fireClose(); // genuinely severed — this socket now carries zero live channels anywhere
    expect(socket.destroyed).toBe(false);
    expect(f.connections.has(socket)).toBe(true);

    await vi.advanceTimersByTimeAsync(1100); // cross severedEscalationMs
    expect(f.left).toHaveLength(1); // escalation fired (leave+rejoin)
    expect(socket.destroyed).toBe(true); // WI-5355: the idle zombie socket was evicted
    expect(f.connections.has(socket)).toBe(false);
    await g.close();
  });

  it('EI-13317/WI-5481: evicts a socket even when still paired on a DIFFERENT topic (shared-socket eviction deadlock)', async () => {
    // Sockets are shared A↔B connections across every topic this gossip
    // instance manages (module header). This test used to assert the
    // OPPOSITE (never evict a socket another topic still claims) — that is
    // precisely the shared-socket eviction DEADLOCK EI-13317/WI-5481 fixed:
    // one physical peer socket can half-open (live at the transport layer,
    // dead for gossip) and sever EVERY topic riding it at once, and each
    // topic's escalation refusing to evict because some OTHER topic still
    // claims the same dead socket means NOBODY ever evicts it. Reaching this
    // escalation means TOPIC's link is already proven dead past the repair
    // ladder, and a dead handshake is dead for every topic muxed over the
    // same socket — so eviction must be unconditional. (Silently reverting
    // this call site back to the guarded form on 2026-07-20 reintroduced the
    // exact deadlock and broke live cross-machine content federation for
    // hours — see the call site's EI-13317/WI-5481 writeup.)
    const TOPIC2 = Buffer.alloc(32, 22);
    const f = fakeSwarm();
    const g = createTopicGossip<Frame>({
      swarm: f.swarm,
      protocol: 'papercusp/test-gossip',
      onFrame: () => {},
      getHelloFrames: () => [],
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 1000,
    });
    g.joinTopic(TOPIC);
    g.joinTopic(TOPIC2);
    const socket = f.connect();
    const chs = socket.userData!.channels;
    const ch1 = chs.find((c) => c.id && c.id.equals(TOPIC))!;
    const ch2 = chs.find((c) => c.id && c.id.equals(TOPIC2))!;
    ch1.pairRemote();
    ch2.pairRemote();
    ch1.fireClose(); // only TOPIC severs; TOPIC2's channel on the SAME socket stays live

    await vi.advanceTimersByTimeAsync(1100);
    expect(f.left).toHaveLength(1); // TOPIC's escalation fired
    // EI-13317/WI-5481: evicted even though TOPIC2 still claimed it — a real
    // destroy() would cascade-close every muxed channel (incl. TOPIC2's), but
    // this fake doesn't model that cascade, so we only assert the eviction
    // decision itself here. P-203 keeps this verdict: the socket showed NO
    // inbound activity (no wire counters, no frames) for the whole liveness
    // window, which is exactly the dead half-open shape WI-5481 fixed — the
    // predicate never consults other topics' claims, so it cannot deadlock.
    expect(socket.destroyed).toBe(true);
    await g.close();
  });

  describe('P-203 / EI-22137294505377834: socket liveness predicate — a severed TOPIC is not a dead SOCKET', () => {
    // Forensics (rig VM Lm1ABoMR, 2026-09-02 06:35–08:15Z): the VM's two
    // hive-directory topics stayed permanently severed (the tower no longer
    // gossips them), so every 300s the unconditional eviction destroyed the
    // VM's ONLY tower socket — which was replicating hello-world-3-pot and
    // serving pot-git the whole time — on an exact 5-minute cadence. Inbound
    // activity separates "peer stopped serving this topic" (spare) from "socket
    // is dead" (evict), and a dead socket cannot fake it.
    const TOPIC2 = Buffer.alloc(32, 22);
    const mk = (f: ReturnType<typeof fakeSwarm>, extra: { socketLivenessWindowMs?: number } = {}) =>
      createTopicGossip<Frame>({
        swarm: f.swarm,
        protocol: 'papercusp/test-gossip',
        onFrame: () => {},
        getHelloFrames: () => [],
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 500,
        severedEscalationMs: 1000,
        ...extra,
      });

    it('SPARES a socket whose UDX bytesReceived keeps advancing (live for other traffic) — the escalation still leaves+rejoins the topic', async () => {
      const f = fakeSwarm();
      const onSeveredLink = vi.fn();
      const g = createTopicGossip<Frame>({
        swarm: f.swarm,
        protocol: 'papercusp/test-gossip',
        onFrame: () => {},
        getHelloFrames: () => [],
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 500,
        severedEscalationMs: 1000,
        onSeveredLink,
      });
      g.joinTopic(TOPIC);
      const raw = { bytesReceived: 4096 };
      const socket = f.connect(raw);
      const ch = socket.userData!.channels[0];
      ch.pairRemote();
      ch.fireClose(); // the peer stopped serving TOPIC…
      // …but the SAME socket keeps receiving bytes (replication / pot-git /
      // another gossip family — invisible to this instance, visible on the wire).
      const pump = setInterval(() => {
        raw.bytesReceived += 100;
      }, 100);

      await vi.advanceTimersByTimeAsync(1100); // cross severedEscalationMs
      clearInterval(pump);
      expect(f.left).toHaveLength(1); // the topic-level leave+rejoin still runs
      expect(f.joined).toHaveLength(2);
      expect(onSeveredLink).toHaveBeenCalledTimes(1);
      const info = onSeveredLink.mock.calls[0]![0] as GossipSeveredLinkInfo;
      expect(info.socketsSpared).toBe(1);
      expect(info.socketsEvicted).toBe(0);
      expect(socket.destroyed).toBe(false); // P-203: the live socket survives
      expect(f.connections.has(socket)).toBe(true);
      await g.close();
    });

    it('EVICTS a socket whose bytesReceived stopped advancing for the whole window, even while another topic still claims it (WI-5481 dead half-open shape)', async () => {
      const f = fakeSwarm();
      const onSeveredLink = vi.fn();
      const g = createTopicGossip<Frame>({
        swarm: f.swarm,
        protocol: 'papercusp/test-gossip',
        onFrame: () => {},
        getHelloFrames: () => [],
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 500,
        severedEscalationMs: 1000,
        onSeveredLink,
      });
      g.joinTopic(TOPIC);
      g.joinTopic(TOPIC2);
      const raw = { bytesReceived: 4096 }; // counters PRESENT, then frozen
      const socket = f.connect(raw);
      const chs = socket.userData!.channels;
      chs.find((c) => c.id && c.id.equals(TOPIC))!.pairRemote();
      chs.find((c) => c.id && c.id.equals(TOPIC2))!.pairRemote();
      chs.find((c) => c.id && c.id.equals(TOPIC))!.fireClose();

      await vi.advanceTimersByTimeAsync(1100);
      expect(f.left).toHaveLength(1);
      const info = onSeveredLink.mock.calls[0]![0] as GossipSeveredLinkInfo;
      expect(info.socketsEvicted).toBe(1);
      expect(info.socketsSpared).toBe(0);
      expect(socket.destroyed).toBe(true);
      await g.close();
    });

    it('counts a gossip frame on ANY channel of the socket as inbound activity (no wire counters exposed)', async () => {
      const f = fakeSwarm();
      const g = mk(f);
      g.joinTopic(TOPIC);
      g.joinTopic(TOPIC2);
      const socket = f.connect(); // no rawStream at all — frame-level fallback
      const chs = socket.userData!.channels;
      const ch1 = chs.find((c) => c.id && c.id.equals(TOPIC))!;
      const ch2 = chs.find((c) => c.id && c.id.equals(TOPIC2))!;
      ch1.pairRemote();
      ch2.pairRemote();
      ch1.fireClose();
      const pump = setInterval(() => ch2.deliver({ kind: 'hello' }), 100);

      await vi.advanceTimersByTimeAsync(1100);
      clearInterval(pump);
      expect(f.left).toHaveLength(1);
      expect(socket.destroyed).toBe(false);
      await g.close();
    });

    it('a socket that connected within the window is never destroyed by another topic\'s escalation (it may be the reconnect itself)', async () => {
      const f = fakeSwarm();
      const g = mk(f);
      g.joinTopic(TOPIC);
      const old = f.connect();
      old.userData!.channels[0].pairRemote();
      old.userData!.channels[0].fireClose();
      await vi.advanceTimersByTimeAsync(700);
      const fresh = f.connect(); // arrives 300ms before the escalation, never pairs
      await vi.advanceTimersByTimeAsync(400);
      expect(f.left).toHaveLength(1);
      expect(old.destroyed).toBe(true); // silent for the whole window → zombie
      expect(fresh.destroyed).toBe(false); // younger than the window → spared
      await g.close();
    });

    it('socketLivenessWindowMs: 0 restores unconditional eviction (EI-13317/WI-5481 behavior)', async () => {
      const f = fakeSwarm();
      const g = mk(f, { socketLivenessWindowMs: 0 });
      g.joinTopic(TOPIC);
      const raw = { bytesReceived: 4096 };
      const socket = f.connect(raw);
      const ch = socket.userData!.channels[0];
      ch.pairRemote();
      ch.fireClose();
      const pump = setInterval(() => {
        raw.bytesReceived += 100;
      }, 100);
      await vi.advanceTimersByTimeAsync(1100);
      clearInterval(pump);
      expect(f.left).toHaveLength(1);
      expect(socket.destroyed).toBe(true);
      await g.close();
    });
  });

  it('WI-5355 iteration 3 (EI-13317/WI-5481 unconditional-eviction era): re-opens a CHANNEL for the topic on the next fresh connection after the forced leave+rejoin', async () => {
    // Historical note: this test originally covered a topic severing on a
    // socket that SURVIVED the escalation (still serving some OTHER topic —
    // eviction used to be guarded). Under EI-13317/WI-5481's unconditional
    // eviction (restored 2026-07-20 — see the "shared-socket eviction
    // deadlock" test above), NO socket survives an escalation: every tracked
    // socket is evicted, so a "re-open the channel on the surviving socket"
    // loop is now a guaranteed no-op. Channel-level re-pairing instead
    // happens the ordinary way: the DHT leave()+join() below makes
    // Hyperswarm fire a fresh 'connection' event once the peer reconnects,
    // and the connection handler opens a channel for every joined topic on
    // that fresh socket (openTopicChannel) — still exercising the same
    // underlying concern this test guards: a rejected/closed Protomux
    // channel must be given a genuinely NEW local channel + a freshly-sent
    // "open" frame, not just a DHT-level rejoin, or the remote has nothing to
    // pair against and the topic is wedged forever.
    const TOPIC2 = Buffer.alloc(32, 33);
    const f = fakeSwarm();
    const g = createTopicGossip<Frame>({
      swarm: f.swarm,
      protocol: 'papercusp/test-gossip',
      onFrame: () => {},
      getHelloFrames: () => [],
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 1000,
    });
    g.joinTopic(TOPIC);
    g.joinTopic(TOPIC2);
    const socket = f.connect();
    const mux = socket.userData!;
    const ch1 = mux.channels.find((c) => c.id && c.id.equals(TOPIC))!;
    const ch2 = mux.channels.find((c) => c.id && c.id.equals(TOPIC2))!;
    ch1.pairRemote();
    ch2.pairRemote();
    ch1.fireClose(); // TOPIC severs; TOPIC2's channel (same socket) stays live

    await vi.advanceTimersByTimeAsync(1100);
    expect(f.left).toHaveLength(1); // DHT-level escalation fired
    expect(socket.destroyed).toBe(true); // EI-13317/WI-5481: evicted unconditionally

    // The peer reconnects after the DHT rejoin (a fresh swarm 'connection'
    // event) — the connection handler must open a fresh, LOCAL channel for
    // TOPIC on it (and send an "open" frame) so the remote has something new
    // to pair against.
    const socket2 = f.connect();
    const freshChannel = socket2.userData!.channels.find((c) => c.id && c.id.equals(TOPIC))!;
    expect(freshChannel.closed).toBe(false);
    expect(freshChannel.opened).toBe(true);

    // And it actually re-pairs once the remote (finally) acks it.
    freshChannel.pairRemote();
    expect(g.openChannelCount(HEX)).toBe(1);
    await g.close();
  });

  it('severedEscalationMs: 0 disables the escalation entirely', async () => {
    const f = fakeSwarm();
    const onSeveredLink = vi.fn();
    const g = createTopicGossip<Frame>({
      swarm: f.swarm,
      protocol: 'papercusp/test-gossip',
      onFrame: () => {},
      getHelloFrames: () => [],
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      onSeveredLink,
    });
    g.joinTopic(TOPIC);
    const socket = f.connect();
    const ch = socket.userData!.channels[0];
    ch.pairRemote();
    ch.fireClose();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSeveredLink).not.toHaveBeenCalled();
    expect(f.left).toHaveLength(0);
    await g.close();
  });

  it('exports a sane default escalation threshold matching swarm.ts', () => {
    expect(DEFAULT_SEVERED_ESCALATION_MS).toBe(5 * 60_000);
  });
});
