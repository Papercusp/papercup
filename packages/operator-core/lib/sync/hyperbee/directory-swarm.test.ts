/**
 * directory-swarm.test.ts — the hive-directory gossip transport (P-003 boot-join).
 *
 * Mocks Protomux to a controllable fake muxer so the join → pair → send-ours →
 * receive → broadcast → close lifecycle unit-tests without a real swarm/socket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Protomux fake: createChannel captures onopen/onclose; addMessage captures
//    onmessage + exposes a send spy; channel.open() fires onopen (simulates pairing).
interface FakeChannel {
  protocol: string;
  onopen?: () => void;
  onclose?: () => void;
  sent: unknown[];
  inbound?: (frame: unknown) => void;
  opened: boolean;
  /** OUR side opens (the source calls this). Does NOT fire onopen. */
  open(): void;
  /** The REMOTE peer pairs → Protomux fires onopen. */
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
        opened: false,
        open() {
          this.opened = true;
        },
        pair() {
          this.onopen?.();
        },
        fireClose() {
          this.onclose?.();
        },
      };
      // addMessage attaches the inbound handler + a send spy bound to THIS channel.
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
vi.mock('protomux', () => ({ default: { from: () => makeMux() } }));

const { joinDirectorySwarm, HIVE_DIRECTORY_PROTOCOL } = await import('./directory-swarm');
import type { SignedHiveAnnounce } from './hive-announce';

const TOPIC = Buffer.alloc(32, 7);
const frame = (id: string): SignedHiveAnnounce =>
  ({ hive_id: id, title: id, description: '', owner_github_login: 'a', owner_github_user_id: 1, owner_device_pubkey: 'pk', attestation_gist_id: 'g', member_topics: [], visibility: 'public', created_at: 0, ts: 0, sig: 's' }) as SignedHiveAnnounce;

/** A fake HyperswarmLike capturing join/leave + the connection handler. */
function fakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  const joined: Buffer[] = [];
  const left: Buffer[] = [];
  return {
    swarm: {
      join(t: Buffer) {
        joined.push(t);
        return {};
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

describe('joinDirectorySwarm', () => {
  it('joins the topic (server+client) and registers a connection handler', async () => {
    const f = fakeSwarm();
    const h = await joinDirectorySwarm({ swarm: f.swarm, topic: TOPIC, onAnnounce: () => {}, getOwnAnnounces: () => [] });
    expect(f.joined).toHaveLength(1);
    expect(f.joined[0].equals(TOPIC)).toBe(true);
    expect(f.handler).toBeTypeOf('function');
    expect(h.topicHex).toBe(TOPIC.toString('hex'));
  });

  it('rejects a non-32-byte topic', async () => {
    const f = fakeSwarm();
    await expect(joinDirectorySwarm({ swarm: f.swarm, topic: Buffer.alloc(10), onAnnounce: () => {}, getOwnAnnounces: () => [] })).rejects.toThrow(/32-byte/);
  });

  it('opens a directory-protocol channel per connection and sends our announces on pair', async () => {
    const f = fakeSwarm();
    await joinDirectorySwarm({
      swarm: f.swarm,
      topic: TOPIC,
      onAnnounce: () => {},
      getOwnAnnounces: () => [frame('mine-1'), frame('mine-2')],
    });
    f.connect();
    expect(muxers).toHaveLength(1);
    expect(muxers[0].protocol).toBe(HIVE_DIRECTORY_PROTOCOL);
    muxers[0].pair(); // simulate the peer pairing → onopen
    await new Promise((r) => setTimeout(r, 0)); // getOwnAnnounces is async
    expect(muxers[0].sent.map((s) => (s as SignedHiveAnnounce).hive_id)).toEqual(['mine-1', 'mine-2']);
  });

  it('pipes inbound frames to onAnnounce', async () => {
    const f = fakeSwarm();
    const seen: string[] = [];
    await joinDirectorySwarm({ swarm: f.swarm, topic: TOPIC, onAnnounce: (fr) => { seen.push(fr.hive_id); }, getOwnAnnounces: () => [] });
    f.connect();
    muxers[0].inbound?.(frame('remote-1'));
    expect(seen).toEqual(['remote-1']);
  });

  it('broadcast sends to every OPEN channel, not unpaired ones', async () => {
    const f = fakeSwarm();
    const h = await joinDirectorySwarm({ swarm: f.swarm, topic: TOPIC, onAnnounce: () => {}, getOwnAnnounces: () => [] });
    f.connect();
    f.connect();
    muxers[0].pair(); // only the first pairs
    await new Promise((r) => setTimeout(r, 0));
    expect(h.openChannelCount).toBe(1);
    h.broadcast(frame('bcast'));
    expect(muxers[0].sent.some((s) => (s as SignedHiveAnnounce).hive_id === 'bcast')).toBe(true);
    expect(muxers[1].sent).toHaveLength(0); // unpaired → no send
  });

  it('a closed channel drops out of the broadcast set', async () => {
    const f = fakeSwarm();
    const h = await joinDirectorySwarm({ swarm: f.swarm, topic: TOPIC, onAnnounce: () => {}, getOwnAnnounces: () => [] });
    f.connect();
    muxers[0].pair();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.openChannelCount).toBe(1);
    muxers[0].fireClose();
    expect(h.openChannelCount).toBe(0);
  });

  it('close leaves the topic and detaches the handler', async () => {
    const f = fakeSwarm();
    const h = await joinDirectorySwarm({ swarm: f.swarm, topic: TOPIC, onAnnounce: () => {}, getOwnAnnounces: () => [] });
    await h.close();
    expect(f.left[0].equals(TOPIC)).toBe(true);
    expect(f.handler).toBeNull();
  });
});
