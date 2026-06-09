/**
 * cross-hive-swarm-transport.test.ts — the LIVE CrossHiveTransport adapter
 * (cross-hive-boundary-2026-06-08 P-006). Mocks Protomux to a controllable fake
 * muxer (mirroring directory-swarm.test.ts) so the join → pair → hello → send →
 * receive → close lifecycle unit-tests without a real swarm/socket.
 *
 * Pins: self-topic joined as SERVER; per-connection cross-hive channel + a HELLO
 * on pair; inbound env routes to the subscriber (buffered before subscribe);
 * send() routes ONLY to the channel whose remote pubkey matches (no broadcast
 * leak), joins the target topic as CLIENT, and throws when no channel appears.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Protomux fake (same shape as directory-swarm.test.ts) ──────────────────────
interface FakeChannel {
  protocol: string;
  onopen?: () => void;
  onclose?: () => void;
  sent: unknown[];
  inbound?: (frame: unknown) => void;
  open(): void;
  pair(): void;
  fireClose(): void;
}
const muxers: FakeChannel[] = [];
function makeMux() {
  return {
    createChannel(spec: { protocol: string; onopen?: () => void; onclose?: () => void }): FakeChannel {
      const ch: FakeChannel = {
        protocol: spec.protocol,
        onopen: spec.onopen,
        onclose: spec.onclose,
        sent: [],
        open() {},
        pair() {
          this.onopen?.();
        },
        fireClose() {
          this.onclose?.();
        },
      };
      (ch as unknown as { addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void } }).addMessage =
        (m) => {
          ch.inbound = m.onmessage;
          return { send: (v: unknown) => ch.sent.push(v) };
        };
      muxers.push(ch);
      return ch;
    },
  };
}
import { vi } from 'vitest';
vi.mock('protomux', () => ({ default: { from: () => makeMux() } }));

const { makeSwarmCrossHiveTransport, CROSS_HIVE_PROTOCOL } = await import('./cross-hive-swarm-transport');
import type { CrossHiveWireEnvelope } from './cross-hive-transport';

const SELF = 'self-hive-pubkey';
const PEER_B = 'peer-B-pubkey';
const PEER_C = 'peer-C-pubkey';

// Deterministic 32-byte topic per pubkey (the real deriveHiveFederationTopic is sha256).
const fakeTopic = (pk: string): Buffer => {
  const b = Buffer.alloc(32);
  Buffer.from(pk).copy(b);
  return b;
};

const wire = (id: string, over: Partial<CrossHiveWireEnvelope> = {}): CrossHiveWireEnvelope => ({
  id,
  fromHivePubkey: SELF,
  toHivePubkey: PEER_B,
  kind: 'ask',
  subject: `s-${id}`,
  body: `b-${id}`,
  sig: `sig-${id}`,
  ...over,
});

/** Fake HyperswarmLike capturing join (+ opts) / leave / the connection handler. */
function fakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  const joined: Array<{ topic: Buffer; opts?: { server?: boolean; client?: boolean } }> = [];
  const left: Buffer[] = [];
  return {
    swarm: {
      join(topic: Buffer, optsArg?: { server?: boolean; client?: boolean }) {
        joined.push({ topic, opts: optsArg });
        return {};
      },
      leave(topic: Buffer) {
        left.push(topic);
      },
      on(_e: 'connection', l: (s: unknown) => void) {
        handler = l;
      },
      off() {
        handler = null;
      },
    },
    connect() {
      handler?.({});
    },
    get handler() {
      return handler;
    },
    joined,
    left,
  };
}

beforeEach(() => {
  muxers.length = 0;
});

describe('makeSwarmCrossHiveTransport — construction', () => {
  it('joins our own Hive topic as SERVER and registers a connection handler', () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({ swarm: f.swarm, selfHivePubkey: SELF, deriveTopic: fakeTopic });
    expect(f.handler).toBeTypeOf('function');
    expect(f.joined).toHaveLength(1);
    expect(f.joined[0].topic.equals(fakeTopic(SELF))).toBe(true);
    expect(f.joined[0].opts).toMatchObject({ server: true, client: true });
    expect(t.selfTopicHex).toBe(fakeTopic(SELF).toString('hex'));
  });

  it('opens a cross-hive-protocol channel per connection and sends our HELLO on pair', () => {
    const f = fakeSwarm();
    makeSwarmCrossHiveTransport({ swarm: f.swarm, selfHivePubkey: SELF, deriveTopic: fakeTopic });
    f.connect();
    expect(muxers).toHaveLength(1);
    expect(muxers[0].protocol).toBe(CROSS_HIVE_PROTOCOL);
    muxers[0].pair(); // peer pairs → onopen → send our hello
    expect(muxers[0].sent).toEqual([{ t: 'hello', hivePubkey: SELF }]);
  });
});

describe('makeSwarmCrossHiveTransport — receive', () => {
  it('routes an inbound env frame to the subscribed handler', () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({ swarm: f.swarm, selfHivePubkey: SELF, deriveTopic: fakeTopic });
    const seen: string[] = [];
    t.subscribe(async (env) => { seen.push(env.id); });
    f.connect();
    muxers[0].pair();
    muxers[0].inbound?.({ t: 'env', env: wire('inbound-1') });
    expect(seen).toEqual(['inbound-1']);
  });

  it('buffers env frames received BEFORE subscribe, then flushes on subscribe', () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({ swarm: f.swarm, selfHivePubkey: SELF, deriveTopic: fakeTopic });
    f.connect();
    muxers[0].pair();
    muxers[0].inbound?.({ t: 'env', env: wire('early') }); // no subscriber yet → buffered
    const seen: string[] = [];
    t.subscribe(async (env) => { seen.push(env.id); });
    expect(seen).toEqual(['early']);
  });

  it('a HELLO frame sets the remote pubkey but is not delivered as an envelope', () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({ swarm: f.swarm, selfHivePubkey: SELF, deriveTopic: fakeTopic });
    const seen: string[] = [];
    t.subscribe(async (env) => { seen.push(env.id); });
    f.connect();
    muxers[0].pair();
    muxers[0].inbound?.({ t: 'hello', hivePubkey: PEER_B });
    expect(seen).toEqual([]); // hello is control, not an envelope
  });
});

describe('makeSwarmCrossHiveTransport — send (addressed routing, no broadcast leak)', () => {
  it('joins the target topic as CLIENT and sends the env to ONLY the matching channel', async () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({ swarm: f.swarm, selfHivePubkey: SELF, deriveTopic: fakeTopic });
    // Two connected peers: B and C.
    f.connect();
    f.connect();
    muxers[0].pair();
    muxers[1].pair();
    muxers[0].inbound?.({ t: 'hello', hivePubkey: PEER_B }); // channel 0 ↔ B
    muxers[1].inbound?.({ t: 'hello', hivePubkey: PEER_C }); // channel 1 ↔ C

    await t.send(PEER_B, wire('to-b'));

    // target topic joined as client-only (not server)
    const targetJoin = f.joined.find((j) => j.topic.equals(fakeTopic(PEER_B)));
    expect(targetJoin?.opts).toMatchObject({ server: false, client: true });
    // env delivered to B's channel only — C never sees the A→B envelope
    expect(muxers[0].sent).toContainEqual({ t: 'env', env: wire('to-b') });
    expect(muxers[1].sent.some((s) => (s as { t: string }).t === 'env')).toBe(false);
  });

  it('throws when no paired channel to the target appears within the wait window', async () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({
      swarm: f.swarm,
      selfHivePubkey: SELF,
      deriveTopic: fakeTopic,
      sendWaitMs: 40,
      pollMs: 10,
    });
    await expect(t.send(PEER_B, wire('undeliverable'))).rejects.toThrow(/no paired channel to Hive/);
  });
});

describe('makeSwarmCrossHiveTransport — lifecycle', () => {
  it('a closed channel drops out of the routable set', () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({ swarm: f.swarm, selfHivePubkey: SELF, deriveTopic: fakeTopic });
    f.connect();
    muxers[0].pair();
    expect(t.openChannelCount).toBe(1);
    muxers[0].fireClose();
    expect(t.openChannelCount).toBe(0);
  });

  it('close leaves every joined topic and detaches the handler', async () => {
    const f = fakeSwarm();
    const t = makeSwarmCrossHiveTransport({
      swarm: f.swarm,
      selfHivePubkey: SELF,
      deriveTopic: fakeTopic,
      sendWaitMs: 20,
      pollMs: 5,
    });
    await t.send(PEER_B, wire('x')).catch(() => {}); // joins B's topic (then throws fast — ignored)
    await t.close();
    expect(f.left.some((b) => b.equals(fakeTopic(SELF)))).toBe(true);
    expect(f.left.some((b) => b.equals(fakeTopic(PEER_B)))).toBe(true);
    expect(f.handler).toBeNull();
  });
});
