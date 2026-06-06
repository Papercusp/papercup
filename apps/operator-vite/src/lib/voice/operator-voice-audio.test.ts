/**
 * Browser audio DSP for the desktop operator-voice client (P-008). Pure math —
 * the error-prone part of capture→EL and EL→playback — verified without a live
 * AudioContext. The getUserMedia/Web-Audio glue around it is the P-011 pass.
 */
import { describe, expect, it } from 'vitest';
import {
  toMono,
  resampleLinear,
  float32ToPcm16le,
  captureChunkToMicBytes,
  pcm16leToFloat32,
  MIC_TARGET_RATE,
} from './operator-voice-audio';

describe('toMono', () => {
  it('passes mono through unchanged', () => {
    const m = new Float32Array([0.1, 0.2, 0.3]);
    expect(toMono(m, 1)).toBe(m); // no copy/realloc for the common mono case
  });
  it('averages interleaved stereo to mono', () => {
    const stereo = new Float32Array([0, 1, 0.5, -0.5]); // [L0,R0,L1,R1]
    const mono = toMono(stereo, 2);
    expect(mono.length).toBe(2);
    expect(mono[0]).toBeCloseTo(0.5);
    expect(mono[1]).toBeCloseTo(0.0);
  });
});

describe('resampleLinear', () => {
  it('is identity when rates match', () => {
    const m = new Float32Array([0, 0.5, 1]);
    expect(resampleLinear(m, 16000, 16000)).toBe(m);
  });
  it('downsamples 48k→16k to ~a third the length', () => {
    const m = new Float32Array(480).map((_, i) => i / 480);
    const out = resampleLinear(m, 48000, 16000);
    expect(Math.abs(out.length - 160)).toBeLessThanOrEqual(1);
    // a monotone ramp stays monotone under linear interpolation
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] - 1e-6);
  });
  it('upsamples 8k→16k to ~double', () => {
    const m = new Float32Array(80).map((_, i) => i / 80);
    expect(Math.abs(resampleLinear(m, 8000, 16000).length - 160)).toBeLessThanOrEqual(1);
  });
});

describe('float32 ↔ pcm16le round trip', () => {
  it('encodes + decodes within quantization error', () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const bytes = float32ToPcm16le(src);
    expect(bytes.length).toBe(src.length * 2);
    const back = pcm16leToFloat32(bytes);
    for (let i = 0; i < src.length; i++) expect(back[i]).toBeCloseTo(src[i], 3);
  });
  it('clamps out-of-range samples', () => {
    const bytes = float32ToPcm16le(new Float32Array([2, -2]));
    const back = pcm16leToFloat32(bytes);
    expect(back[0]).toBeCloseTo(1, 3);
    expect(back[1]).toBeCloseTo(-1, 3);
  });
  it('pcm16leToFloat32 ignores a trailing odd byte', () => {
    expect(pcm16leToFloat32(new Uint8Array([0, 0, 1])).length).toBe(1);
  });
});

describe('captureChunkToMicBytes', () => {
  it('produces 16 kHz mono PCM16 bytes from 48k stereo', () => {
    // 480 stereo frames (960 interleaved) @48k → ~160 mono samples @16k → ~320 bytes
    const stereo = new Float32Array(960).map((_, i) => Math.sin(i / 20) * 0.3);
    const bytes = captureChunkToMicBytes(stereo, 2, 48000);
    expect(bytes.length % 2).toBe(0);
    expect(Math.abs(bytes.length / 2 - 160)).toBeLessThanOrEqual(2);
  });
  it('targets 16 kHz', () => {
    expect(MIC_TARGET_RATE).toBe(16000);
  });
});
