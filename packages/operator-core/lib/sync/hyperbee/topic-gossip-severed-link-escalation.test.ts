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
      };
      (
        ch as unknown as { addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void } }
      ).addMessage = (m) => {
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
    connect(): { userData?: FakeMux; destroy: (err?: Error) => void; destroyed: boolean } {
      const socket = {
        userData: undefined as FakeMux | undefined,
        destroyed: false,
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
    // EI-13317/WI-5481: evicted unconditionally even though TOPIC2 still
    // claimed it — a real destroy() would cascade-close every muxed channel
    // (incl. TOPIC2's), but this fake doesn't model that cascade, so we only
    // assert the eviction decision itself here.
    expect(socket.destroyed).toBe(true);
    await g.close();
  });

  it('WI-5355 iteration 3: re-attempts CHANNEL-level pairing on a surviving socket after the forced leave+rejoin (not just the DHT-level rejoin)', async () => {
    // Root cause: a topic that severs on a socket which is NOT evicted (still
    // serving some OTHER topic — the common real-world case, e.g. the shared
    // substrate/corestore connection also carries a directory-gossip topic)
    // never gets its Protomux CHANNEL recreated by the escalation — only the
    // DHT-level swarm.leave()/join() ran. Since Hyperswarm dedupes connections
    // per peer, the SAME socket persists, so unless the code re-invokes
    // openTopicChannel (mux.createChannel + .open()) on that surviving socket,
    // the channel-level handshake is NEVER retried and the topic can never
    // re-pair — reproducing "forceRejoin fires but never actually re-pairs".
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
    ch1.fireClose(); // TOPIC severs; TOPIC2 (same socket) stays live so the socket is never evicted

    await vi.advanceTimersByTimeAsync(1100);
    expect(f.left).toHaveLength(1); // DHT-level escalation fired
    expect(socket.destroyed).toBe(false); // survives — still serving TOPIC2

    // The fix under test: a FRESH channel for TOPIC must have been created on
    // the surviving socket (the closed ch1 plus a brand-new one), and it must
    // have been opened (an "open" frame sent) — otherwise the remote peer
    // (which, per the bug, already rejected/closed the old one) has nothing
    // to pair against and the topic is wedged forever.
    const topicChannelsOnSocket = mux.channels.filter((c) => c.id && c.id.equals(TOPIC));
    expect(topicChannelsOnSocket.length).toBeGreaterThanOrEqual(2);
    const freshChannel = topicChannelsOnSocket[topicChannelsOnSocket.length - 1]!;
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
