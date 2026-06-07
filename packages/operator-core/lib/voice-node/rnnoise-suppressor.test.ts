/**
 * RNNoise WASM binding (P-010/D-013) — loads the real WASM under Node and
 * verifies it suppresses a stationary noise floor. Real-audio efficacy (does a
 * fan/keyboard audibly vanish for the far peer?) is the hardware-gated pass.
 */
import { describe, expect, it } from 'vitest';
import { createRnnoiseSuppressor, RNNOISE_FRAME_SAMPLES } from './rnnoise-suppressor';
import { VOICE_FRAME_SAMPLES } from './codec';

function noiseFrame(seed: number, amp: number, n = VOICE_FRAME_SAMPLES): Int16Array {
  let s = seed >>> 0;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (((s >>> 9) / (1 << 23)) * 2 - 1) * amp;
  }
  return out;
}

function rms(a: Int16Array): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += a[i] * a[i];
  return Math.sqrt(acc / a.length);
}

describe('createRnnoiseSuppressor', () => {
  it('channel frames are a whole number of RNNoise frames', () => {
    expect(VOICE_FRAME_SAMPLES % RNNOISE_FRAME_SAMPLES).toBe(0);
  });

  it('attenuates a stationary noise floor and reports a voice probability', async () => {
    const ns = await createRnnoiseSuppressor();
    try {
      let inE = 0;
      let outE = 0;
      // Let the noise estimator settle, then measure.
      for (let f = 0; f < 25; f++) {
        const frame = noiseFrame(1000 + f, 2500);
        const out = ns.process(frame);
        expect(out.length).toBe(frame.length);
        if (f >= 10) {
          inE += rms(frame);
          outE += rms(out);
        }
      }
      expect(outE).toBeLessThan(inE * 0.7); // ≥ ~3 dB on a pure noise floor
      const p = ns.lastVoiceProb();
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    } finally {
      ns.destroy?.();
    }
  });

  it('passes oddly-sized frames through untouched (defensive)', async () => {
    const ns = await createRnnoiseSuppressor();
    try {
      const odd = noiseFrame(7, 1000, 333);
      expect(ns.process(odd)).toBe(odd);
    } finally {
      ns.destroy?.();
    }
  });

  it('destroy is idempotent and process after destroy is a pass-through', async () => {
    const ns = await createRnnoiseSuppressor();
    ns.destroy?.();
    ns.destroy?.();
    const frame = noiseFrame(3, 1000);
    expect(ns.process(frame)).toBe(frame);
  });
});
