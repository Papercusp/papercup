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
type GossipSeveredLinkInfo = { topicHex: string; severedMs: number };
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
    connect(): { userData?: FakeMux } {
      const socket: { userData?: FakeMux } = {};
      connections.add(socket);
      handler?.(socket);
      return socket;
    },
    joined,
    left,
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
  it('never escalates a topic that has NOT yet paired (no peer online yet)', async () => {
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

    await vi.advanceTimersByTimeAsync(5000);
    expect(onSeveredLink).not.toHaveBeenCalled();
    expect(f.left).toHaveLength(0);
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
