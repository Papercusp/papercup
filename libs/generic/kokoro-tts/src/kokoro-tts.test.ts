import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { KokoroTts } from './kokoro-tts';
import { normalizeText, phonemize } from './phonemize';
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
