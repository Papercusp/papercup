/**
 * substrate-wake-gossip.test.ts — the swarm-presence keepalive that lets a
 * harness stay JOINED to its hive topic with NO resident engine
 * (shared-hive-cross-machine-scale-10k-2026-06-29 P-012 slice B / WI-6071).
 *
 * The gossip CHASSIS (discovery refresh, lazy-accept pairing, one-muxer-per-
 * socket) is pinned by directory-swarm.test.ts; this pins what the wake layer
 * adds on top: the key↔topic fan-in/fan-out, the residency gate, the wake
 * cooldown that bounds unauthenticated boot amplification, and the fail-OPEN
 * direction on every ambiguity (a redundant boot is cheap; a missed one is the
 * EI-126 divergence class).
 *
 * Uses the same Protomux fake as directory-swarm.test.ts so pairing/frames are
 * exercised without a real swarm, socket or engine.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/hyperbee/substrate-wake-gossip.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Protomux fake (mirrors directory-swarm.test.ts) ─────────────────────────
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
  remoteOpens(id: Buffer): void;
}
const allChannels: FakeChannel[] = [];
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
        ch as unknown as {
          addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void };
        }
      ).addMessage = (m) => {
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
      return makeMux();
    },
  },
}));

const {
  createSubstrateWakeGossip,
  SUBSTRATE_WAKE_PROTOCOL,
  WAKE_FRAME_VERSION,
  DEFAULT_WAKE_COOLDOWN_MS,
} = await import('./substrate-wake-gossip');
import type { SubstrateWakeEvent, SubstrateWakeFrame } from './substrate-wake-gossip';

/** A fake HyperswarmLike capturing join/leave + the connection handler. */
function fakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  const joined: Buffer[] = [];
  const left: Buffer[] = [];
  const connections = new Set<unknown>();
  return {
    swarm: {
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
    },
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

const TOPIC_A = Buffer.alloc(32, 7);
const TOPIC_B = Buffer.alloc(32, 9);
const HEX_A = TOPIC_A.toString('hex');
const HEX_B = TOPIC_B.toString('hex');

const KEY1 = 'ws-1|harness-alpha';
const KEY2 = 'ws-1|harness-beta';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Build a well-formed inbound frame as a peer would send it. */
const peerFrame = (kind: 'hello' | 'activity' = 'activity', ts = 1): SubstrateWakeFrame => ({
  v: WAKE_FRAME_VERSION,
  kind,
  ts,
});

/** The channel this gossip opened for one topic on one socket. */
const channelFor = (topic: Buffer): FakeChannel => {
  const hex = topic.toString('hex');
  const ch = allChannels.find(
    (c) => c.protocol === SUBSTRATE_WAKE_PROTOCOL && c.id?.toString('hex') === hex && !c.closed,
  );
  if (!ch) throw new Error(`no open wake channel for topic ${hex}`);
  return ch;
};

beforeEach(() => {
  allChannels.length = 0;
});

describe('watch / unwatch topic bookkeeping', () => {
  it('watch joins the topic once and is idempotent per key', () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    expect(f.joined).toHaveLength(1);
    expect(f.joined[0].equals(TOPIC_A)).toBe(true);
    g.watch(KEY1, TOPIC_A); // idempotent
    expect(f.joined).toHaveLength(1);
    expect(g.watchedKeys).toEqual([KEY1]);
    expect(g.topicHexFor(KEY1)).toBe(HEX_A);
    expect(g.topicCount).toBe(1);
  });

  it('two harnesses sharing one hive topic join the DHT topic only ONCE', () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_A);
    expect(f.joined).toHaveLength(1);
    expect(g.topicCount).toBe(1);
    expect(g.watchedKeys.sort()).toEqual([KEY1, KEY2].sort());
  });

  it('unwatch keeps the topic joined while ANOTHER key still watches it', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_A);
    await g.unwatch(KEY1);
    expect(f.left).toHaveLength(0); // KEY2 still needs the topic
    expect(g.watchedKeys).toEqual([KEY2]);
    await g.unwatch(KEY2);
    expect(f.left).toHaveLength(1);
    expect(f.left[0].equals(TOPIC_A)).toBe(true);
    expect(g.topicCount).toBe(0);
  });

  it('unwatch of an unknown key is a no-op', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    await expect(g.unwatch('never-watched')).resolves.toBeUndefined();
    expect(f.left).toHaveLength(0);
  });

  it('re-watching a key under a NEW topic moves it and leaves the orphaned topic', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY1, TOPIC_B); // a re-key
    await tick();
    expect(g.topicHexFor(KEY1)).toBe(HEX_B);
    expect(g.topicCount).toBe(1);
    expect(f.joined).toHaveLength(2);
    expect(f.left.some((t) => t.equals(TOPIC_A))).toBe(true);
  });

  it('a re-key does NOT leave the old topic while another key still watches it', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_A);
    g.watch(KEY1, TOPIC_B);
    await tick();
    expect(f.left).toHaveLength(0);
    expect(g.topicHexFor(KEY2)).toBe(HEX_A);
  });

  it('rejects an empty topic and a blank key', () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    expect(() => g.watch(KEY1, Buffer.alloc(0))).toThrow(/topic required/);
    expect(() => g.watch('', TOPIC_A)).toThrow(/key required/);
  });

  it('requires a swarm and an onWake listener', () => {
    const f = fakeSwarm();
    expect(() =>
      createSubstrateWakeGossip({
        swarm: undefined as never,
        onWake: () => {},
      }),
    ).toThrow(/swarm required/);
    expect(() =>
      createSubstrateWakeGossip({ swarm: f.swarm, onWake: undefined as never }),
    ).toThrow(/onWake required/);
  });
});

describe('the wake signal', () => {
  it('a peer frame wakes the dark key watching that topic', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    ch.inbound?.(peerFrame('activity'));
    await tick();
    expect(woke).toHaveLength(1);
    expect(woke[0].key).toBe(KEY1);
    expect(woke[0].topicHex).toBe(HEX_A);
    expect(woke[0].frame.kind).toBe('activity');
  });

  it("a peer's HELLO is itself a wake — a member being online is the D-005 signal", async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    ch.inbound?.(peerFrame('hello'));
    await tick();
    expect(woke.map((w) => w.frame.kind)).toEqual(['hello']);
  });

  it('wakes EVERY dark key sharing the topic', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    ch.inbound?.(peerFrame());
    await tick();
    expect(woke.map((w) => w.key).sort()).toEqual([KEY1, KEY2].sort());
  });

  it('does NOT wake a key whose engine is already resident', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      isResident: (k) => k === KEY1,
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    ch.inbound?.(peerFrame());
    await tick();
    expect(woke.map((w) => w.key)).toEqual([KEY2]);
  });

  it('a THROWING residency probe fails OPEN — the key is treated as dark and woken', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      isResident: () => {
        throw new Error('handle map exploded');
      },
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    ch.inbound?.(peerFrame());
    await tick();
    expect(woke).toHaveLength(1);
  });

  it('a frame on a topic no key watches wakes nothing', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    await g.unwatch(KEY1);
    ch.inbound?.(peerFrame());
    await tick();
    expect(woke).toHaveLength(0);
  });

  it('drops malformed / unknown-kind frames without throwing or waking', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    for (const bad of [null, undefined, 42, 'nope', {}, { kind: 'from-the-future' }]) {
      expect(() => ch.inbound?.(bad)).not.toThrow();
    }
    await tick();
    expect(woke).toHaveLength(0);
  });

  it('a throwing onWake listener never breaks the wake of the other keys', async () => {
    const f = fakeSwarm();
    const woke: string[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => {
        if (e.key === KEY1) throw new Error('listener blew up');
        woke.push(e.key);
      },
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    expect(() => ch.inbound?.(peerFrame())).not.toThrow();
    await tick();
    expect(woke).toEqual([KEY2]);
  });
});

describe('the wake cooldown (boot-amplification bound)', () => {
  it('a second frame inside the cooldown does not re-wake; after it, it does', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    let clock = 1_000;
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      now: () => clock,
      wakeCooldownMs: 5_000,
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();

    ch.inbound?.(peerFrame());
    expect(woke).toHaveLength(1);

    clock += 4_999;
    ch.inbound?.(peerFrame());
    expect(woke).toHaveLength(1); // still cooling down

    clock += 2;
    ch.inbound?.(peerFrame());
    expect(woke).toHaveLength(2);
  });

  it('the cooldown is PER TOPIC — a wake on one hive never suppresses another', () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      now: () => 1_000,
      wakeCooldownMs: 60_000,
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_B);
    f.connect();
    channelFor(TOPIC_A).pairRemote();
    channelFor(TOPIC_B).pairRemote();
    channelFor(TOPIC_A).inbound?.(peerFrame());
    channelFor(TOPIC_B).inbound?.(peerFrame());
    expect(woke.map((w) => w.key).sort()).toEqual([KEY1, KEY2].sort());
  });

  it('frames arriving while every key is RESIDENT do not consume the cooldown budget', () => {
    // The ordering guard: residency is checked BEFORE the cooldown is stamped,
    // so a chatty live peer cannot starve a key that goes dark moments later.
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    let resident = true;
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      isResident: () => resident,
      now: () => 1_000,
      wakeCooldownMs: 60_000,
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    ch.inbound?.(peerFrame());
    ch.inbound?.(peerFrame());
    expect(woke).toHaveLength(0);

    resident = false; // the engine gets evicted; the very next frame must wake
    ch.inbound?.(peerFrame());
    expect(woke).toHaveLength(1);
  });

  it('wakeCooldownMs: 0 disables the cooldown entirely', () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      now: () => 1_000,
      wakeCooldownMs: 0,
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    ch.inbound?.(peerFrame());
    ch.inbound?.(peerFrame());
    expect(woke).toHaveLength(2);
  });

  it('the default cooldown is a sane non-zero bound', () => {
    expect(DEFAULT_WAKE_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

describe('the send side', () => {
  it('sends a hello frame to a freshly-paired peer', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    await tick();
    expect(ch.sent).toHaveLength(1);
    const sent = ch.sent[0] as SubstrateWakeFrame;
    expect(sent.kind).toBe('hello');
    expect(sent.v).toBe(WAKE_FRAME_VERSION);
  });

  it('announceActivity broadcasts on the key\'s topic only', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_B);
    f.connect();
    const chA = channelFor(TOPIC_A);
    const chB = channelFor(TOPIC_B);
    chA.pairRemote();
    chB.pairRemote();
    await tick();
    chA.sent.length = 0;
    chB.sent.length = 0;

    g.announceActivity(KEY1);
    expect(chA.sent).toHaveLength(1);
    expect((chA.sent[0] as SubstrateWakeFrame).kind).toBe('activity');
    expect(chB.sent).toHaveLength(0);
  });

  it('announceActivity for an unwatched key is a silent no-op', () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    expect(() => g.announceActivity('ws-1|not-watched')).not.toThrow();
  });

  it('stamps the injected clock on outbound frames', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: () => {},
      now: () => 4_242,
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    await tick();
    expect((ch.sent[0] as SubstrateWakeFrame).ts).toBe(4_242);
  });
});

describe('close', () => {
  it('clears the watched set and is idempotent', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    g.watch(KEY1, TOPIC_A);
    g.watch(KEY2, TOPIC_B);
    await g.close();
    expect(g.watchedKeys).toEqual([]);
    expect(g.topicCount).toBe(0);
    await expect(g.close()).resolves.toBeUndefined();
  });

  it('after close, watch and announceActivity are inert', async () => {
    const f = fakeSwarm();
    const g = createSubstrateWakeGossip({ swarm: f.swarm, onWake: () => {}, refreshMs: 0 });
    await g.close();
    const joinedBefore = f.joined.length;
    g.watch(KEY1, TOPIC_A);
    expect(f.joined).toHaveLength(joinedBefore);
    expect(g.watchedKeys).toEqual([]);
    expect(() => g.announceActivity(KEY1)).not.toThrow();
  });

  it('no wake fires after close', async () => {
    const f = fakeSwarm();
    const woke: SubstrateWakeEvent[] = [];
    const g = createSubstrateWakeGossip({
      swarm: f.swarm,
      onWake: (e) => woke.push(e),
      refreshMs: 0,
    });
    g.watch(KEY1, TOPIC_A);
    f.connect();
    const ch = channelFor(TOPIC_A);
    ch.pairRemote();
    await g.close();
    ch.inbound?.(peerFrame());
    await tick();
    expect(woke).toHaveLength(0);
  });
});
