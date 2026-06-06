/**
 * Two-node loopback over a mock swarm — the P-006 core acceptance shape:
 * join → hello handshake → mic frames flow → peer tap + mix → mute → leave.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createVoiceNode, type DuplexLike, type SwarmLike, type VoiceCodec } from './voice-node';

const TOPIC = 'ab'.repeat(32);

/** Identity codec: PCM16 bytes pass through unchanged. 4-sample frames keep tests tiny. */
const testCodec: VoiceCodec = {
  frameSamples: 4,
  encode: (pcm) => new Uint8Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)),
  decode: (data) => new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
};

/** In-memory duplex pair — synchronous cross-wired writes. */
function duplexPair(): [DuplexLike, DuplexLike] {
  const make = () => Object.assign(new EventEmitter(), { peer: null as EventEmitter | null });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  const wrap = (self: EventEmitter & { peer: EventEmitter | null }): DuplexLike => ({
    write: (data: Uint8Array) => {
      // copy → emit on the other end next microtask (avoids reentrancy surprises)
      const copy = new Uint8Array(data);
      queueMicrotask(() => self.peer?.emit('data', copy));
      return true;
    },
    on: (ev: string, cb: (...args: never[]) => void) => self.on(ev, cb as never),
    destroy: () => {
      queueMicrotask(() => {
        self.emit('close');
        self.peer?.emit('close');
      });
    },
  });
  return [wrap(a), wrap(b)];
}

/** Mock swarm: join is recorded; test wires connections manually. */
function mockSwarm(): SwarmLike & { emitConnection(conn: DuplexLike): void; joined: string[]; left: string[] } {
  const ee = new EventEmitter();
  const joined: string[] = [];
  const left: string[] = [];
  return {
    joined,
    left,
    join: (topic: Uint8Array) => {
      joined.push(Buffer.from(topic).toString('hex'));
      return { flushed: async () => {} };
    },
    leave: async (topic: Uint8Array) => {
      left.push(Buffer.from(topic).toString('hex'));
    },
    on: (ev, cb) => ee.on(ev, cb as never),
    off: (ev, cb) => ee.off(ev, cb as never),
    emitConnection: (conn: DuplexLike) => ee.emit('connection', conn),
  };
}

const tickle = () => new Promise((r) => setTimeout(r, 60)); // a few 20ms ticks

function connectedPair() {
  const swarmA = mockSwarm();
  const swarmB = mockSwarm();
  const nodeA = createVoiceNode({ swarm: swarmA, codec: testCodec, identity: { id: 'A', label: 'Alice' } });
  const nodeB = createVoiceNode({ swarm: swarmB, codec: testCodec, identity: { id: 'B', label: 'Bob' } });
  const chanA = nodeA.joinChannel(TOPIC);
  const chanB = nodeB.joinChannel(TOPIC);
  const [endA, endB] = duplexPair();
  swarmA.emitConnection(endA);
  swarmB.emitConnection(endB);
  return { swarmA, swarmB, nodeA, nodeB, chanA, chanB };
}

describe('voice-node two-party loopback', () => {
  it('handshakes, exchanges audio, taps peers, and mixes', async () => {
    const { chanA, chanB, nodeA, nodeB } = connectedPair();
    await tickle();

    // hello handshake registered both directions
    expect(chanA.peers()).toEqual([{ id: 'B', label: 'Bob', muted: false, speaking: false, cameraOn: false }]);
    expect(chanB.peers()).toEqual([{ id: 'A', label: 'Alice', muted: false, speaking: false, cameraOn: false }]);

    const tapB = vi.fn();
    chanB.onPeerFrame(tapB);
    const mixesB: Int16Array[] = [];
    chanB.onMixedFrame((f) => {
      if (f.some((v) => v !== 0)) mixesB.push(f);
    });

    const loud = new Int16Array([20000, -20000, 20000, -20000]);
    chanA.pushMic(loud);
    chanA.pushMic(loud);
    await tickle();

    expect(tapB).toHaveBeenCalled();
    expect(tapB.mock.calls[0][0]).toBe('A');
    expect([...(tapB.mock.calls[0][1] as Int16Array)]).toEqual([...loud]);
    expect(mixesB.length).toBeGreaterThan(0);
    expect([...mixesB[0]]).toEqual([...loud]);

    // speaking flag rose on B's view of A
    expect(chanB.peers()[0].speaking).toBe(true);

    await chanA.leave();
    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('propagates mute state and suppresses mic while muted', async () => {
    const { chanA, chanB, nodeA, nodeB } = connectedPair();
    await tickle();

    const tapB = vi.fn();
    chanB.onPeerFrame(tapB);

    chanA.setMuted(true);
    await tickle();
    expect(chanB.peers()[0].muted).toBe(true);

    chanA.pushMic(new Int16Array([100, 100, 100, 100]));
    await tickle();
    expect(tapB).not.toHaveBeenCalled();

    chanA.setMuted(false);
    await tickle();
    expect(chanB.peers()[0].muted).toBe(false);

    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('rejects peers from a different channel', async () => {
    const swarmA = mockSwarm();
    const swarmC = mockSwarm();
    const nodeA = createVoiceNode({ swarm: swarmA, codec: testCodec, identity: { id: 'A', label: 'Alice' } });
    const nodeC = createVoiceNode({ swarm: swarmC, codec: testCodec, identity: { id: 'C', label: 'Carol' } });
    const chanA = nodeA.joinChannel(TOPIC);
    const chanC = nodeC.joinChannel('cd'.repeat(32)); // different channel
    const [endA, endC] = duplexPair();
    swarmA.emitConnection(endA);
    swarmC.emitConnection(endC);
    await tickle();

    expect(chanA.peers()).toEqual([]);
    expect(chanC.peers()).toEqual([]);

    await nodeA.destroy();
    await nodeC.destroy();
  });

  it('single-channel invariant + leave releases the topic', async () => {
    const swarm = mockSwarm();
    const node = createVoiceNode({ swarm, codec: testCodec, identity: { id: 'A', label: 'A' } });
    const chan = node.joinChannel(TOPIC);
    expect(() => node.joinChannel('cd'.repeat(32))).toThrow(/already in channel/);
    expect(node.activeChannel()).toBe(TOPIC);
    await chan.leave();
    expect(node.activeChannel()).toBeNull();
    expect(swarm.left).toEqual([TOPIC]);
    // rejoin works after leave
    node.joinChannel('cd'.repeat(32));
    await node.destroy();
  });

  it('fans video per-peer (opaque, no mix) and taps inbound video with sender id', async () => {
    const { chanA, chanB, nodeA, nodeB } = connectedPair();
    await tickle();

    const videoB = vi.fn();
    chanB.onPeerVideoFrame(videoB);
    // A pushes two opaque video payloads (encodeVideo format isn't required —
    // the core treats them as bytes; here just distinct buffers).
    const k = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0xaa, 0xbb]); // pretend keyframe
    const d = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0xcc]); // pretend delta
    chanA.pushVideo(k);
    chanA.pushVideo(d);
    await tickle();

    expect(videoB).toHaveBeenCalledTimes(2);
    expect(videoB.mock.calls[0][0]).toBe('A');
    expect([...(videoB.mock.calls[0][1] as Uint8Array)]).toEqual([...k]);
    expect([...(videoB.mock.calls[1][1] as Uint8Array)]).toEqual([...d]);
    // delivered payload is a copy — retaining it is safe
    expect(videoB.mock.calls[0][1]).not.toBe(k);

    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('propagates cameraOn via the in-band state frame', async () => {
    const { chanA, chanB, nodeA, nodeB } = connectedPair();
    await tickle();
    expect(chanB.peers()[0].cameraOn).toBe(false);

    chanA.setCameraOn(true);
    await tickle();
    expect(chanB.peers()[0].cameraOn).toBe(true);
    // mute is independent and preserved across a camera toggle
    expect(chanB.peers()[0].muted).toBe(false);

    chanA.setCameraOn(false);
    await tickle();
    expect(chanB.peers()[0].cameraOn).toBe(false);

    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('a peer joining with camera already on advertises cameraOn in its hello', async () => {
    const swarmA = mockSwarm();
    const swarmB = mockSwarm();
    const nodeA = createVoiceNode({ swarm: swarmA, codec: testCodec, identity: { id: 'A', label: 'Alice' } });
    const nodeB = createVoiceNode({ swarm: swarmB, codec: testCodec, identity: { id: 'B', label: 'Bob' } });
    const chanA = nodeA.joinChannel(TOPIC);
    const chanB = nodeB.joinChannel(TOPIC);
    chanA.setCameraOn(true); // camera on BEFORE the connection is established
    const [endA, endB] = duplexPair();
    swarmA.emitConnection(endA);
    swarmB.emitConnection(endB);
    await tickle();

    expect(chanB.peers()[0]).toMatchObject({ id: 'A', cameraOn: true });

    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('three-party mix sums two speakers at the listener', async () => {
    // listener L connected to speakers S1 and S2 via two separate conns
    const swarmL = mockSwarm();
    const swarmS1 = mockSwarm();
    const swarmS2 = mockSwarm();
    const L = createVoiceNode({ swarm: swarmL, codec: testCodec, identity: { id: 'L', label: 'L' } });
    const S1 = createVoiceNode({ swarm: swarmS1, codec: testCodec, identity: { id: 'S1', label: 'S1' } });
    const S2 = createVoiceNode({ swarm: swarmS2, codec: testCodec, identity: { id: 'S2', label: 'S2' } });
    const chanL = L.joinChannel(TOPIC);
    const chanS1 = S1.joinChannel(TOPIC);
    const chanS2 = S2.joinChannel(TOPIC);
    const [l1, s1] = duplexPair();
    const [l2, s2] = duplexPair();
    swarmL.emitConnection(l1);
    swarmS1.emitConnection(s1);
    swarmL.emitConnection(l2);
    swarmS2.emitConnection(s2);
    await tickle();
    expect(chanL.peers().map((p) => p.id)).toEqual(['S1', 'S2']);

    const mixes: Int16Array[] = [];
    chanL.onMixedFrame((f) => {
      if (f.some((v) => v !== 0)) mixes.push(f);
    });
    chanS1.pushMic(new Int16Array([1000, 1000, 1000, 1000]));
    chanS2.pushMic(new Int16Array([234, 234, 234, 234]));
    await tickle();

    expect(mixes.length).toBeGreaterThan(0);
    expect([...mixes[0]]).toEqual([1234, 1234, 1234, 1234]);

    await L.destroy();
    await S1.destroy();
    await S2.destroy();
  });
});
