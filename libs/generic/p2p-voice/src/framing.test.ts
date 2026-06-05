import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  FRAME_AUDIO,
  FRAME_CTRL,
  decodeAudio,
  decodeCtrl,
  encodeAudio,
  encodeCtrl,
  encodeFrame,
} from './framing';
import { energy, mixInt16 } from './mixer';

describe('framing', () => {
  it('round-trips ctrl JSON', () => {
    const wire = encodeCtrl({ kind: 'hello', id: 'a', channel: 'x'.repeat(64) });
    const dec = new FrameDecoder();
    const frames = dec.push(wire);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FRAME_CTRL);
    expect(decodeCtrl(frames[0].payload)).toEqual({ kind: 'hello', id: 'a', channel: 'x'.repeat(64) });
  });

  it('round-trips audio with seq, across split chunk boundaries', () => {
    const data = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const wire = encodeAudio(0xdeadbeef, data);
    const dec = new FrameDecoder();
    // feed one byte at a time — worst-case fragmentation
    const frames = [];
    for (const b of wire) frames.push(...dec.push(new Uint8Array([b])));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FRAME_AUDIO);
    const { seq, data: out } = decodeAudio(frames[0].payload);
    expect(seq).toBe(0xdeadbeef);
    expect([...out]).toEqual([...data]);
  });

  it('decodes multiple coalesced frames from one chunk', () => {
    const a = encodeFrame(FRAME_CTRL, new Uint8Array([1]));
    const b = encodeAudio(7, new Uint8Array([9, 9]));
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    const frames = new FrameDecoder().push(joined);
    expect(frames.map((f) => f.type)).toEqual([FRAME_CTRL, FRAME_AUDIO]);
  });

  it('rejects oversized frames', () => {
    const dec = new FrameDecoder();
    const evil = new Uint8Array(5);
    new DataView(evil.buffer).setUint32(0, 0x7fffffff, false);
    expect(() => dec.push(evil)).toThrow(/too large/);
  });
});

describe('mixer', () => {
  it('sums with saturation', () => {
    const a = new Int16Array([30000, -30000, 100]);
    const b = new Int16Array([30000, -30000, 23]);
    const m = mixInt16([a, b], 3);
    expect([...m]).toEqual([32767, -32768, 123]);
  });

  it('empty input mixes to silence at frame length', () => {
    const m = mixInt16([], 4);
    expect([...m]).toEqual([0, 0, 0, 0]);
  });

  it('energy: silence is 0, full-scale is ~1', () => {
    expect(energy(new Int16Array(10))).toBe(0);
    const loud = new Int16Array(10).fill(32767);
    expect(energy(loud)).toBeGreaterThan(0.99);
  });
});
