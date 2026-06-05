/**
 * Operator voice-node tests (holepunch-voice-channels P-006):
 *  - real opusscript codec round-trip through the codec seam
 *  - two p2p-voice nodes exchanging REAL Opus over an in-memory duplex
 */
import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { createVoiceNode, energy, type DuplexLike, type SwarmLike } from '@papercusp/p2p-voice';
import { getOpusCodec, VOICE_FRAME_SAMPLES } from './codec';

function sineFrame(freq = 440, amp = 0.6): Int16Array {
  const out = new Int16Array(VOICE_FRAME_SAMPLES);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / 48_000) * amp * 32767);
  }
  return out;
}

function duplexPair(): [DuplexLike, DuplexLike] {
  const a = new EventEmitter();
  const b = new EventEmitter();
  const wrap = (self: EventEmitter, peer: EventEmitter): DuplexLike => ({
    write: (data: Uint8Array) => {
      const copy = new Uint8Array(data);
      queueMicrotask(() => peer.emit('data', copy));
      return true;
    },
    on: (ev: string, cb: (...args: never[]) => void) => self.on(ev, cb as never),
    destroy: () =>
      queueMicrotask(() => {
        self.emit('close');
        peer.emit('close');
      }),
  });
  return [wrap(a, b), wrap(b, a)];
}

function mockSwarm(): SwarmLike & { emitConnection(conn: DuplexLike): void } {
  const ee = new EventEmitter();
  return {
    join: () => ({ flushed: async () => {} }),
    leave: async () => {},
    on: (ev, cb) => ee.on(ev, cb as never),
    off: (ev, cb) => ee.off(ev, cb as never),
    emitConnection: (conn: DuplexLike) => ee.emit('connection', conn),
  };
}

describe('opus codec seam', () => {
  it('encodes 20ms PCM16 to a compact frame and decodes back to 960 samples', async () => {
    const codec = await getOpusCodec();
    const pcm = sineFrame();
    const enc = codec.encode(pcm);
    expect(enc.length).toBeGreaterThan(10);
    expect(enc.length).toBeLessThan(400); // voice-bitrate Opus, not raw PCM (1920B)
    const dec = codec.decode(enc);
    expect(dec.length).toBe(VOICE_FRAME_SAMPLES);
    // lossy codec: energy survives within a sane band
    const ratio = energy(dec) / energy(pcm);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(1.5);
  });
});

describe('two nodes over real Opus', () => {
  it('delivers intelligible (energy-preserving) audio peer to peer', async () => {
    const codec = await getOpusCodec();
    const swarmA = mockSwarm();
    const swarmB = mockSwarm();
    const A = createVoiceNode({ swarm: swarmA, codec, identity: { id: 'A', label: 'A' } });
    const B = createVoiceNode({ swarm: swarmB, codec, identity: { id: 'B', label: 'B' } });
    const chanA = A.joinChannel('ee'.repeat(32));
    const chanB = B.joinChannel('ee'.repeat(32));
    const [ea, eb] = duplexPair();
    swarmA.emitConnection(ea);
    swarmB.emitConnection(eb);
    await new Promise((r) => setTimeout(r, 50));
    expect(chanB.peers().map((p) => p.id)).toEqual(['A']);

    const got: Int16Array[] = [];
    chanB.onPeerFrame((_id, f) => got.push(f));
    const pcm = sineFrame();
    for (let i = 0; i < 5; i++) chanA.pushMic(pcm);
    await new Promise((r) => setTimeout(r, 80));

    expect(got.length).toBeGreaterThanOrEqual(4);
    expect(got[got.length - 1].length).toBe(VOICE_FRAME_SAMPLES);
    // Opus warms up across the first frames; judge the steady-state tail.
    const tail = got[got.length - 1];
    expect(energy(tail)).toBeGreaterThan(energy(pcm) * 0.4);

    await A.destroy();
    await B.destroy();
  });
});

afterAll(async () => {
  (await getOpusCodec()).dispose();
});
