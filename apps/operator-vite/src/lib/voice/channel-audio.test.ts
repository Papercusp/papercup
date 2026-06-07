import { describe, expect, it } from 'vitest';
import {
  CHANNEL_SAMPLE_RATE,
  captureChunkToChannelBytes,
  pcm16leToFloat32,
  rmsLevel,
} from './channel-audio';

describe('captureChunkToChannelBytes', () => {
  it('passes 48 kHz mono through sample-for-sample', () => {
    const mono = new Float32Array([0, 0.5, -0.5, 1]);
    const bytes = captureChunkToChannelBytes(mono, 1, CHANNEL_SAMPLE_RATE);
    expect(bytes.length).toBe(8); // 4 samples × 2 bytes
    const back = pcm16leToFloat32(bytes);
    expect(back[0]).toBeCloseTo(0, 3);
    expect(back[1]).toBeCloseTo(0.5, 2);
    expect(back[2]).toBeCloseTo(-0.5, 2);
    expect(back[3]).toBeCloseTo(1, 3);
  });

  it('downmixes stereo to mono (channel average)', () => {
    // interleaved L/R: (1, 0) → 0.5
    const stereo = new Float32Array([1, 0, 1, 0]);
    const bytes = captureChunkToChannelBytes(stereo, 2, CHANNEL_SAMPLE_RATE);
    const back = pcm16leToFloat32(bytes);
    expect(back.length).toBe(2);
    expect(back[0]).toBeCloseTo(0.5, 2);
    expect(back[1]).toBeCloseTo(0.5, 2);
  });

  it('resamples a 96 kHz chunk down to 48 kHz (half the samples)', () => {
    const src = new Float32Array(960); // 10 ms @ 96 kHz
    src.fill(0.25);
    const bytes = captureChunkToChannelBytes(src, 1, 96_000);
    expect(bytes.length / 2).toBe(480); // 10 ms @ 48 kHz
    const back = pcm16leToFloat32(bytes);
    expect(back[100]).toBeCloseTo(0.25, 2);
  });

  it('resamples a 44.1 kHz chunk up to 48 kHz', () => {
    const src = new Float32Array(441); // 10 ms @ 44.1 kHz
    src.fill(-0.1);
    const bytes = captureChunkToChannelBytes(src, 1, 44_100);
    expect(bytes.length / 2).toBe(480); // 10 ms @ 48 kHz
    const back = pcm16leToFloat32(bytes);
    expect(back[200]).toBeCloseTo(-0.1, 2);
  });

  it('clamps out-of-range floats', () => {
    const mono = new Float32Array([2, -2]);
    const back = pcm16leToFloat32(captureChunkToChannelBytes(mono, 1, CHANNEL_SAMPLE_RATE));
    expect(back[0]).toBeCloseTo(1, 3);
    expect(back[1]).toBeCloseTo(-1, 3);
  });
});

describe('rmsLevel', () => {
  it('is 0 for silence and an empty chunk', () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0);
    expect(rmsLevel(new Float32Array(100))).toBe(0);
  });

  it('reports the RMS of a constant signal', () => {
    const s = new Float32Array(100);
    s.fill(0.5);
    expect(rmsLevel(s)).toBeCloseTo(0.5, 5);
  });

  it('caps at 1 for clipping signals', () => {
    const s = new Float32Array(10);
    s.fill(4);
    expect(rmsLevel(s)).toBe(1);
  });
});
