import { describe, expect, it } from 'vitest';
import { NlmsAec } from './nlms-aec';
import { applyGainPcm16 } from './gain';

const FRAME = 960;

/** Deterministic white-ish noise (LCG) in int16 scale. */
function makeNoiseSource(seed = 12345, amp = 8000) {
  let s = seed >>> 0;
  return (n: number): Int16Array => {
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      out[i] = (((s >>> 9) / (1 << 23)) * 2 - 1) * amp;
    }
    return out;
  };
}

function rms(a: Int16Array | Float32Array): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += a[i] * a[i];
  return Math.sqrt(acc / a.length);
}

/**
 * A simulated room: echo(t) = g0·far(t-d0) + g1·far(t-d1). Keeps its own
 * far-end history so the test is independent of the AEC's internals.
 */
class EchoPath {
  private hist: number[] = [];
  constructor(private readonly taps: Array<{ delay: number; gain: number }>) {}
  push(far: Int16Array): void {
    for (let i = 0; i < far.length; i++) this.hist.push(far[i]);
  }
  echoFrame(n: number): Float32Array {
    const out = new Float32Array(n);
    const end = this.hist.length;
    for (let i = 0; i < n; i++) {
      const t = end - n + i;
      for (const { delay, gain } of this.taps) {
        const idx = t - delay;
        if (idx >= 0) out[i] += gain * this.hist[idx];
      }
    }
    return out;
  }
}

function toI16(f: Float32Array, extra?: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = f[i] + (extra ? extra[i] : 0);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
  }
  return out;
}

/** Drive `frames` frames of far-end noise through the path + canceller. */
function converge(aec: NlmsAec, path: EchoPath, noise: (n: number) => Int16Array, frames: number) {
  let lastIn = 0;
  let lastOut = 0;
  for (let f = 0; f < frames; f++) {
    const far = noise(FRAME);
    aec.pushFarEnd(far);
    path.push(far);
    const mic = toI16(path.echoFrame(FRAME));
    const out = aec.process(mic);
    lastIn = rms(mic);
    lastOut = rms(out);
  }
  return { lastIn, lastOut };
}

describe('NlmsAec', () => {
  // ~100 ms bulk delay + a short tail — inside the default search window.
  // Gains model a typical ~6 dB echo-return loss (below the Geigel ratio, so
  // pure echo is never misread as double-talk).
  const ECHO_TAPS = [
    { delay: 4800, gain: 0.5 },
    { delay: 4900, gain: 0.2 },
  ];

  it('converges on a synthetic echo path (≥12 dB suppression of pure echo)', () => {
    const aec = new NlmsAec({ taps: 512, marginSamples: 240 });
    const path = new EchoPath(ECHO_TAPS);
    const { lastIn, lastOut } = converge(aec, path, makeNoiseSource(), 200); // 4 s
    const suppressionDb = 20 * Math.log10(lastIn / Math.max(1e-3, lastOut));
    expect(suppressionDb).toBeGreaterThan(12);
    expect(aec.erleDb()).toBeGreaterThan(6); // running average incl. pre-convergence
  });

  it('locks the bulk delay near the true value', () => {
    const aec = new NlmsAec({ taps: 512, marginSamples: 240 });
    const path = new EchoPath(ECHO_TAPS);
    converge(aec, path, makeNoiseSource(), 60);
    const d = aec.estimatedDelaySamples();
    expect(d).not.toBeNull();
    // Decimated xcorr resolution is 16 samples; allow a generous window.
    expect(Math.abs((d as number) - 4800)).toBeLessThan(480);
  });

  it('preserves near-end speech during double-talk', () => {
    const aec = new NlmsAec({ taps: 512, marginSamples: 240 });
    const path = new EchoPath(ECHO_TAPS);
    const noise = makeNoiseSource();
    converge(aec, path, noise, 150); // converge first

    // Now the near talker speaks: a 1 kHz tone on top of the echo.
    const toneAmp = 6000;
    let phase = 0;
    let toneE = 0;
    let outDotTone = 0;
    let outE = 0;
    for (let f = 0; f < 25; f++) {
      const far = noise(FRAME);
      aec.pushFarEnd(far);
      path.push(far);
      const tone = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) {
        tone[i] = toneAmp * Math.sin((2 * Math.PI * 1000 * (phase + i)) / 48000);
      }
      phase += FRAME;
      const mic = toI16(path.echoFrame(FRAME), tone);
      const out = aec.process(mic);
      for (let i = 0; i < FRAME; i++) {
        toneE += tone[i] * tone[i];
        outDotTone += out[i] * tone[i];
        outE += out[i] * out[i];
      }
    }
    // The tone survives: high correlation with the near-end signal and energy
    // in the same ballpark (the echo is removed, the talker is not).
    const corr = outDotTone / Math.sqrt(toneE * outE);
    expect(corr).toBeGreaterThan(0.85);
    const outDb = 10 * Math.log10(outE / toneE);
    expect(Math.abs(outDb)).toBeLessThan(3);
  });

  it('passes mic through before any far-end correlation exists', () => {
    const aec = new NlmsAec();
    const mic = makeNoiseSource(7)(FRAME);
    const out = aec.process(mic);
    expect([...out]).toEqual([...mic]);
  });

  it('is silent-safe: silence in, silence out, no NaNs', () => {
    const aec = new NlmsAec({ taps: 256 });
    aec.pushFarEnd(new Int16Array(FRAME));
    const out = aec.process(new Int16Array(FRAME));
    expect(rms(out)).toBe(0);
  });
});

describe('applyGainPcm16', () => {
  it('is identity at unity', () => {
    const f = new Int16Array([1, -2, 30000]);
    expect(applyGainPcm16(f, 1)).toBe(f);
  });
  it('scales and clamps', () => {
    const out = applyGainPcm16(new Int16Array([1000, -1000, 30000, -30000]), 2);
    expect([...out]).toEqual([2000, -2000, 32767, -32768]);
  });
});
