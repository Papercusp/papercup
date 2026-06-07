/**
 * Mic-DSP chain (P-010/D-013) — pref wiring + stage composition + far-end
 * routing, with injected stage stubs (the cores' behaviour is covered in
 * @papercusp/audio-dsp and rnnoise-suppressor tests).
 */
import { describe, expect, it, vi } from 'vitest';
import { NlmsAec, type NoiseSuppressor } from '@papercusp/audio-dsp';
import { createMicDsp, micDspConfigFromPrefs } from './mic-dsp';

function cfg(overrides: Partial<ReturnType<typeof micDspConfigFromPrefs>> = {}) {
  return { inputGain: 1, aec: false, noiseSuppression: false, nsEngine: 'browser' as const, ...overrides };
}

function stubNs(marker: number): NoiseSuppressor & { destroyed: boolean } {
  const s = {
    destroyed: false,
    process(frame: Int16Array) {
      const out = new Int16Array(frame.length);
      out.set(frame);
      out[0] = marker; // visible fingerprint
      return out;
    },
    destroy() {
      s.destroyed = true;
    },
  };
  return s;
}

describe('micDspConfigFromPrefs', () => {
  it('maps the four voice prefs onto the chain config', () => {
    expect(
      micDspConfigFromPrefs({
        voiceInputGain: 1.5,
        voiceAec: true,
        voiceNoiseSuppression: true,
        noiseSuppressionEngine: 'rnnoise',
      }),
    ).toEqual({ inputGain: 1.5, aec: true, noiseSuppression: true, nsEngine: 'rnnoise' });
  });
});

describe('createMicDsp', () => {
  it('is a pass-through by default (unity gain, no AEC, no NS)', async () => {
    const dsp = createMicDsp({ nsFactory: async () => stubNs(1) });
    await dsp.configure(cfg());
    const frame = new Int16Array([5, 6, 7]);
    expect(dsp.process(frame)).toBe(frame); // unity gain short-circuits
    expect(dsp.status()).toMatchObject({ gain: 1, aec: false, ns: 'off', erleDb: null });
  });

  it('applies input gain', async () => {
    const dsp = createMicDsp({ nsFactory: async () => stubNs(1) });
    await dsp.configure(cfg({ inputGain: 2 }));
    expect([...dsp.process(new Int16Array([100, -100]))]).toEqual([200, -200]);
  });

  it('activates RNNoise NS only for nsEngine=rnnoise (browser = client-side)', async () => {
    const ns = stubNs(42);
    const factory = vi.fn(async () => ns);
    const dsp = createMicDsp({ nsFactory: factory });

    await dsp.configure(cfg({ noiseSuppression: true, nsEngine: 'browser' }));
    expect(factory).not.toHaveBeenCalled();
    expect(dsp.status().ns).toBe('off');

    await dsp.configure(cfg({ noiseSuppression: true, nsEngine: 'rnnoise' }));
    expect(factory).toHaveBeenCalledOnce();
    expect(dsp.status().ns).toBe('rnnoise');
    expect(dsp.process(new Int16Array([1, 2]))[0]).toBe(42);

    // Flipping NS off destroys the engine.
    await dsp.configure(cfg({ noiseSuppression: false, nsEngine: 'rnnoise' }));
    expect(ns.destroyed).toBe(true);
    expect(dsp.status().ns).toBe('off');
  });

  it('routes far-end frames to the AEC and resets it on channel leave', async () => {
    const pushed: number[] = [];
    const fakeAec = {
      pushFarEnd: (f: Int16Array) => pushed.push(f.length),
      process: (f: Int16Array) => f,
      estimatedDelaySamples: () => 4800,
      erleDb: () => 18,
    } as unknown as NlmsAec;
    const factory = vi.fn(() => fakeAec);
    const dsp = createMicDsp({ aecFactory: factory, nsFactory: async () => stubNs(1) });

    await dsp.configure(cfg({ aec: true }));
    dsp.pushFarEnd(new Int16Array(960));
    expect(pushed).toEqual([960]);
    expect(dsp.status()).toMatchObject({ aec: true, aecDelaySamples: 4800, erleDb: 18 });

    dsp.reset();
    expect(factory).toHaveBeenCalledTimes(2); // fresh adaptive state

    await dsp.configure(cfg({ aec: false }));
    dsp.pushFarEnd(new Int16Array(960));
    expect(pushed).toEqual([960]); // no AEC → no routing
    expect(dsp.status().aec).toBe(false);
  });

  it('chains gain → AEC → NS in order', async () => {
    const seen: string[] = [];
    const fakeAec = {
      pushFarEnd: () => {},
      process: (f: Int16Array) => {
        seen.push(`aec:${f[0]}`);
        return f;
      },
      estimatedDelaySamples: () => null,
      erleDb: () => 0,
    } as unknown as NlmsAec;
    const ns: NoiseSuppressor = {
      process(f) {
        seen.push(`ns:${f[0]}`);
        return f;
      },
    };
    const dsp = createMicDsp({ aecFactory: () => fakeAec, nsFactory: async () => ns });
    await dsp.configure(cfg({ inputGain: 2, aec: true, noiseSuppression: true, nsEngine: 'rnnoise' }));
    dsp.process(new Int16Array([10]));
    expect(seen).toEqual(['aec:20', 'ns:20']); // gain applied before AEC; NS last
  });
});
