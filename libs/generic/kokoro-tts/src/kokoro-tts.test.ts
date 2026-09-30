import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { KokoroTts } from './kokoro-tts';
import { EMSCRIPTEN_PROCESS_HOOKS, importWithoutProcessCrashHooks, normalizeText, phonemize } from './phonemize';
import { configureKokoroTts, isKokoroTtsConfigured, __resetKokoroTtsHostForTests, type KokoroTransformersHost } from './config';

describe('config seam', () => {
  afterEach(() => __resetKokoroTtsHostForTests());

  it('is unconfigured by default', () => {
    expect(isKokoroTtsConfigured()).toBe(false);
  });

  it('KokoroTts.from_pretrained throws a clear error before configuration', async () => {
    await expect(KokoroTts.from_pretrained()).rejects.toThrow(/not configured/);
  });

  it('configureKokoroTts wires the host; last call wins', () => {
    const hostA = fakeHost();
    const hostB = fakeHost();
    configureKokoroTts(hostA);
    expect(isKokoroTtsConfigured()).toBe(true);
    configureKokoroTts(hostB);
    expect(isKokoroTtsConfigured()).toBe(true);
  });
});

describe('normalizeText (pure)', () => {
  it('converts curly quotes to straight', () => {
    expect(normalizeText('it’s')).toBe("it's");
  });

  it('reads a currency amount aloud', () => {
    expect(normalizeText('$5')).toBe('5 dollars');
  });

  it('spells out Mr./Mrs./Dr. before a capitalized name', () => {
    expect(normalizeText('Dr. Smith')).toBe('Doctor Smith');
    expect(normalizeText('Mr. Jones')).toBe('Mister Jones');
  });
});

describe('WI-10004324: phonemizer must not install process-wide crash handlers', () => {
  const snapshot = () => new Map(EMSCRIPTEN_PROCESS_HOOKS.map((e) => [e, process.listeners(e)]));

  it('the real phonemizer DOES add crash handlers on load, and the loader removes every one of them', async () => {
    // Must be the first import of `phonemizer` in this worker: a cached module never
    // re-evaluates, so the positive control below would read 0 and prove nothing.
    const before = snapshot();
    let addedDuringLoad = 0;
    await importWithoutProcessCrashHooks(async () => {
      const mod = await import('phonemizer');
      for (const e of EMSCRIPTEN_PROCESS_HOOKS) addedDuringLoad += process.listenerCount(e) - before.get(e)!.length;
      return mod;
    });
    // Positive control: without this the guard below would pass vacuously.
    expect(addedDuringLoad).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
  });

  it('phonemize() leaves the process crash-handler set exactly as it found it', async () => {
    const before = snapshot();
    await phonemize('hello again');
    expect(snapshot()).toEqual(before);
  });

  it('keeps pre-existing listeners and removes only the ones the load added', async () => {
    const hostHandler = () => {};
    process.on('uncaughtException', hostHandler);
    try {
      const rethrow = (e: unknown) => {
        throw e;
      };
      await importWithoutProcessCrashHooks(async () => {
        process.on('uncaughtException', rethrow);
        process.on('unhandledRejection', rethrow);
        return 1;
      });
      expect(process.listeners('uncaughtException')).toContain(hostHandler);
      expect(process.listeners('uncaughtException')).not.toContain(rethrow);
      expect(process.listeners('unhandledRejection')).not.toContain(rethrow);
    } finally {
      process.removeListener('uncaughtException', hostHandler);
    }
  });

  it('still removes added listeners when the load itself fails', async () => {
    const before = snapshot();
    await expect(
      importWithoutProcessCrashHooks(async () => {
        process.on('unhandledRejection', () => {});
        throw new Error('load failed');
      }),
    ).rejects.toThrow('load failed');
    expect(snapshot()).toEqual(before);
  });
});

describe('phonemize (uses the real phonemizer package — no transformers involved)', () => {
  it('produces a non-empty IPA-ish string for plain English text', async () => {
    const out = await phonemize('hello world');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('KokoroTts.generate — wired against a FAKE injected host (no real model weights)', () => {
  let voiceFetchCalls = 0;

  beforeEach(() => {
    voiceFetchCalls = 0;
    configureKokoroTts(fakeHost());
    // KokoroTts.loadVoiceStyle falls back to `fetch` when no disk cache path is given.
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      voiceFetchCalls++;
      // 510 * 256 floats, enough to slice any token-count offset used below.
      const buf = new Float32Array(510 * 256).fill(0.5).buffer;
      return { ok: true, arrayBuffer: async () => buf } as unknown as Response;
    }) as typeof fetch;
  });
  afterEach(() => __resetKokoroTtsHostForTests());

  it('threads phonemize → tokenizer → style-row selection → model, and returns the model waveform', async () => {
    const engine = await KokoroTts.from_pretrained();
    const result = await engine.generate('hello there', { voice: 'af_bella', speed: 1 });
    expect(result.sampling_rate).toBe(24_000);
    expect(result.audio).toBeInstanceOf(Float32Array);
    expect(result.audio.length).toBeGreaterThan(0);
    expect(voiceFetchCalls).toBe(1); // fetched once, then cached in-process
  });

  it('caches the voice style table across calls (no second fetch for the same voice)', async () => {
    const engine = await KokoroTts.from_pretrained();
    await engine.generate('one', { voice: 'af_bella' });
    await engine.generate('two', { voice: 'af_bella' });
    expect(voiceFetchCalls).toBe(1);
  });

  it('rejects an unknown voice before touching the model', async () => {
    const engine = await KokoroTts.from_pretrained();
    await expect(engine.generate('hi', { voice: 'not_a_real_voice' })).rejects.toThrow(/not found/);
  });
});

/** A minimal fake transformers host: proves the injection wiring without loading real weights. */
function fakeHost(): KokoroTransformersHost {
  return {
    StyleTextToSpeech2Model: {
      async from_pretrained() {
        return async (_inputs: { input_ids: unknown; style: unknown; speed: unknown }) => ({
          waveform: { data: new Float32Array([0.1, 0.2, 0.3]) },
        });
      },
    },
    AutoTokenizer: {
      async from_pretrained() {
        return (_text: string, _opts: { truncation: boolean }) => ({
          input_ids: { dims: { at: (_index: number) => 5 } },
        });
      },
    },
    Tensor: class FakeTensor {
      constructor(
        public dtype: string,
        public data: unknown,
        public dims: number[],
      ) {}
    } as unknown as KokoroTransformersHost['Tensor'],
  };
}
