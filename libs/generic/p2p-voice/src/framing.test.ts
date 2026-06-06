import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  FRAME_AUDIO,
  FRAME_CTRL,
  FRAME_VIDEO,
  decodeAudio,
  decodeCtrl,
  decodeVideo,
  encodeAudio,
  encodeCtrl,
  encodeFrame,
  encodeVideo,
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

  it('round-trips a video keyframe with timestamp', () => {
    const data = new Uint8Array([0, 255, 13, 200, 7]);
    const wire = encodeVideo({ key: true, timestamp: 123456789 }, data);
    const frames = new FrameDecoder().push(wire);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FRAME_VIDEO);
    const dec = decodeVideo(frames[0].payload);
    expect(dec.key).toBe(true);
    expect(dec.timestamp).toBe(123456789);
    expect([...dec.data]).toEqual([...data]);
  });

  it('round-trips a delta frame (key=false) across split chunk boundaries', () => {
    const data = new Uint8Array([42, 42, 42, 42]);
    const wire = encodeVideo({ key: false, timestamp: 2 ** 40 + 7 }, data);
    const d = new FrameDecoder();
    const frames = [];
    for (const b of wire) frames.push(...d.push(new Uint8Array([b])));
    expect(frames).toHaveLength(1);
    const dec = decodeVideo(frames[0].payload);
    expect(dec.key).toBe(false);
    // 2^40 is exactly representable as f64 — microsecond timestamps stay exact.
    expect(dec.timestamp).toBe(2 ** 40 + 7);
    expect([...dec.data]).toEqual([...data]);
  });

  it('interleaves CTRL + AUDIO + VIDEO on one decoder (one shared peer connection)', () => {
    const ctrl = encodeCtrl({ kind: 'state', muted: false });
    const audio = encodeAudio(1, new Uint8Array([1, 2]));
    const video = encodeVideo({ key: true, timestamp: 0 }, new Uint8Array([9, 9, 9]));
    const joined = new Uint8Array(ctrl.length + audio.length + video.length);
    joined.set(ctrl, 0);
    joined.set(audio, ctrl.length);
    joined.set(video, ctrl.length + audio.length);
    const frames = new FrameDecoder().push(joined);
    expect(frames.map((f) => f.type)).toEqual([FRAME_CTRL, FRAME_AUDIO, FRAME_VIDEO]);
  });

  it('decodeVideo tolerates a truncated header', () => {
    const dec = decodeVideo(new Uint8Array([1, 2, 3]));
    expect(dec.key).toBe(false);
    expect(dec.timestamp).toBe(0);
    expect(dec.data).toHaveLength(0);
  });

  it('handles an empty-payload (camera-off heartbeat) video frame', () => {
    const wire = encodeVideo({ key: false, timestamp: 5 }, new Uint8Array(0));
    const frames = new FrameDecoder().push(wire);
    const dec = decodeVideo(frames[0].payload);
    expect(dec.timestamp).toBe(5);
    expect(dec.data).toHaveLength(0);
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
