/**
 * voice-node/kokoro/kokoro-tts — vendored, trimmed port of kokoro-js@1.2.1
 * (https://github.com/hexgrad/kokoro · Apache-2.0; upstream author: Xenova/hexgrad).
 *
 * WHY VENDORED (P-009, plan D-009, WI-4449): kokoro-js pins @huggingface/transformers@^3.5.1
 * while this repo ships 4.2.0 — and npm's `overrides` do NOT apply to workspace-package
 * transitive deps (verified live 2026-07-12: global, nested, and $-reference override forms
 * all left a nested 3.8.1 copy — a 706MB duplicate onnxruntime+transformers stack in
 * node_modules, straight into the already >2GiB AppImage). The engine itself runs verified
 * on transformers 4.2.0 (spike 2026-07-12: identical output quality, warm rt 0.71–1.03 CPU
 * q8), so this port simply binds the SAME ~200 lines of glue to the repo's own transformers +
 * the tiny `phonemizer` package (~2.6MB). Behavioral parity is with kokoro-js's dist/kokoro.js,
 * ported statement-for-statement; upstream fixes should be diffed against that file.
 *
 * Deliberate trims vs upstream:
 *   - No TextSplitterStream / stream() (papercusp synthesizes whole replies; sentence
 *     streaming is a later latency optimization).
 *   - Voice style bins are NOT bundled (upstream ships all 27 ≈ 27MB in-package): they are
 *     fetched from the canonical HF repo on first use and cached on disk next to the model
 *     (`<cacheDir>/voices/<voice>.bin`) — the provision step pre-fetches the default voice.
 */
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env as _hfEnv } from '@huggingface/transformers';
import { phonemize as espeakPhonemize } from 'phonemizer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const KOKORO_HF_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_SAMPLE_RATE = 24_000;

// ---------------------------------------------------------------------------------------
// Text normalization + phonemization (upstream `m()` and helpers, ported verbatim)
// ---------------------------------------------------------------------------------------

/** Upstream `o()`: read a year/time-like number the way a speaker would. */
function splitNum(match: string): string {
  if (match.includes('.')) return match;
  if (match.includes(':')) {
    const [h, m] = match.split(':').map(Number);
    if (m === 0) return `${h} o'clock`;
    if (m < 10) return `${h} oh ${m}`;
    return `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

/** Upstream `c()`: read a currency amount. */
function flipMoney(match: string): string {
  const bill = match[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes('.')) {
    const suffix = match.slice(1) === '1' ? '' : 's';
    return `${match.slice(1)} ${bill}${suffix}`;
  }
  const [b, c] = match.slice(1).split('.');
  const cents = parseInt(c.padEnd(2, '0'), 10);
  const centUnit = match[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${cents} ${centUnit}`;
}

/** Upstream `g()`: read a decimal point-wise. */
function pointNum(match: string): string {
  const [a, b] = match.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

/** Upstream text normalization (the big replace chain), verbatim. */
function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/、/g, ', ')
    .replace(/。/g, '. ')
    .replace(/！/g, '! ')
    .replace(/，/g, ', ')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_PATTERN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

/** Upstream `m()`: normalize → phonemize the non-punctuation chunks → post-fixups. */
export async function phonemize(text: string, language: 'a' | 'b' = 'a', norm = true): Promise<string> {
  if (norm) text = normalizeText(text);
  // Split on punctuation, preserving the punctuation runs verbatim.
  const sections: Array<{ match: boolean; text: string }> = [];
  let lastIndex = 0;
  for (const m of text.matchAll(PUNCTUATION_PATTERN)) {
    if (lastIndex < m.index!) sections.push({ match: false, text: text.slice(lastIndex, m.index) });
    if (m[0].length > 0) sections.push({ match: true, text: m[0] });
    lastIndex = m.index! + m[0].length;
  }
  if (lastIndex < text.length) sections.push({ match: false, text: text.slice(lastIndex) });

  const lang = language === 'a' ? 'en-us' : 'en';
  const ps = (
    await Promise.all(sections.map(async ({ match, text: t }) => (match ? t : (await espeakPhonemize(t, lang)).join(' '))))
  ).join('');

  let processed = ps
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (language === 'a') processed = processed.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return processed.trim();
}

// ---------------------------------------------------------------------------------------
// Voices (metadata verbatim; style bins fetched + disk-cached instead of bundled)
// ---------------------------------------------------------------------------------------

export interface KokoroVoiceInfo {
  name: string;
  language: 'en-us' | 'en-gb';
  gender: 'Female' | 'Male';
}

/** Upstream voice table, trimmed to id → {name, language, gender} (grades dropped). */
export const KOKORO_VOICES: Readonly<Record<string, KokoroVoiceInfo>> = Object.freeze({
  af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' },
  af_alloy: { name: 'Alloy', language: 'en-us', gender: 'Female' },
  af_aoede: { name: 'Aoede', language: 'en-us', gender: 'Female' },
  af_bella: { name: 'Bella', language: 'en-us', gender: 'Female' },
  af_jessica: { name: 'Jessica', language: 'en-us', gender: 'Female' },
  af_kore: { name: 'Kore', language: 'en-us', gender: 'Female' },
  af_nicole: { name: 'Nicole', language: 'en-us', gender: 'Female' },
  af_nova: { name: 'Nova', language: 'en-us', gender: 'Female' },
  af_river: { name: 'River', language: 'en-us', gender: 'Female' },
  af_sarah: { name: 'Sarah', language: 'en-us', gender: 'Female' },
  af_sky: { name: 'Sky', language: 'en-us', gender: 'Female' },
  am_adam: { name: 'Adam', language: 'en-us', gender: 'Male' },
  am_echo: { name: 'Echo', language: 'en-us', gender: 'Male' },
  am_eric: { name: 'Eric', language: 'en-us', gender: 'Male' },
  am_fenrir: { name: 'Fenrir', language: 'en-us', gender: 'Male' },
  am_liam: { name: 'Liam', language: 'en-us', gender: 'Male' },
  am_michael: { name: 'Michael', language: 'en-us', gender: 'Male' },
  am_onyx: { name: 'Onyx', language: 'en-us', gender: 'Male' },
  am_puck: { name: 'Puck', language: 'en-us', gender: 'Male' },
  am_santa: { name: 'Santa', language: 'en-us', gender: 'Male' },
  bf_emma: { name: 'Emma', language: 'en-gb', gender: 'Female' },
  bf_isabella: { name: 'Isabella', language: 'en-gb', gender: 'Female' },
  bm_george: { name: 'George', language: 'en-gb', gender: 'Male' },
  bm_lewis: { name: 'Lewis', language: 'en-gb', gender: 'Male' },
  bf_alice: { name: 'Alice', language: 'en-gb', gender: 'Female' },
  bf_lily: { name: 'Lily', language: 'en-gb', gender: 'Female' },
  bm_daniel: { name: 'Daniel', language: 'en-gb', gender: 'Male' },
  bm_fable: { name: 'Fable', language: 'en-gb', gender: 'Male' },
});

export function kokoroVoiceUrl(voice: string): string {
  return `https://huggingface.co/${KOKORO_HF_REPO}/resolve/main/voices/${voice}.bin`;
}

// ---------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------

export interface KokoroTtsOptions {
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  device?: 'cpu' | null;
  /** transformers.js model cache dir (papercusp: ~/.papercusp/models/kokoro). */
  cacheDir?: string;
  /** Voice style bins cache dir (papercusp: `<cacheDir>/voices`). */
  voicesDir?: string;
  progress_callback?: (p: unknown) => void;
}

export interface KokoroRawAudio {
  audio: Float32Array;
  sampling_rate: number;
}

export class KokoroTts {
  private readonly voiceCache = new Map<string, Float32Array>();

  private constructor(
    private readonly model: Awaited<ReturnType<typeof StyleTextToSpeech2Model.from_pretrained>>,
    private readonly tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>,
    private readonly voicesDir: string | undefined,
  ) {}

  static async from_pretrained(modelId: string = KOKORO_HF_REPO, opts: KokoroTtsOptions = {}): Promise<KokoroTts> {
    const loadOpts = {
      dtype: opts.dtype ?? 'q8',
      device: opts.device ?? undefined,
      cache_dir: opts.cacheDir,
      progress_callback: opts.progress_callback,
    } as never;
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(modelId, loadOpts),
      AutoTokenizer.from_pretrained(modelId, { cache_dir: opts.cacheDir, progress_callback: opts.progress_callback } as never),
    ]);
    return new KokoroTts(model, tokenizer, opts.voicesDir);
  }

  get voices(): Readonly<Record<string, KokoroVoiceInfo>> {
    return KOKORO_VOICES;
  }

  private validateVoice(voice: string): 'a' | 'b' {
    if (!Object.hasOwn(KOKORO_VOICES, voice)) {
      throw new Error(`Voice "${voice}" not found. Should be one of: ${Object.keys(KOKORO_VOICES).join(', ')}.`);
    }
    return voice[0] as 'a' | 'b';
  }

  /** Fetch-or-read the 510×256 f32 style table for `voice` (disk-cached under voicesDir). */
  async loadVoiceStyle(voice: string): Promise<Float32Array> {
    const cached = this.voiceCache.get(voice);
    if (cached) return cached;
    let buffer: ArrayBufferLike | null = null;
    const diskPath = this.voicesDir ? `${this.voicesDir}/${voice}.bin` : null;
    if (diskPath && existsSync(diskPath)) {
      buffer = (await readFile(diskPath)).buffer;
    } else {
      const r = await fetch(kokoroVoiceUrl(voice));
      if (!r.ok) throw new Error(`kokoro voice fetch failed HTTP ${r.status} for ${voice}`);
      buffer = await r.arrayBuffer();
      if (diskPath) {
        await mkdir(dirname(diskPath), { recursive: true });
        await writeFile(diskPath, Buffer.from(buffer));
      }
    }
    const data = new Float32Array(buffer);
    this.voiceCache.set(voice, data);
    return data;
  }

  /** Upstream generate(): phonemize → tokenize → style row by token count → model. */
  async generate(text: string, { voice = 'af_heart', speed = 1 }: { voice?: string; speed?: number } = {}): Promise<KokoroRawAudio> {
    const language = this.validateVoice(voice);
    const phonemes = await phonemize(text, language);
    const { input_ids } = this.tokenizer(phonemes, { truncation: true });
    // Style row selection, verbatim from upstream: offset = 256 * min(max(tokens-2, 0), 509).
    const numTokens = Math.min(Math.max((input_ids.dims.at(-1) as number) - 2, 0), 509);
    const styleTable = await this.loadVoiceStyle(voice);
    const styleRow = styleTable.slice(numTokens * 256, numTokens * 256 + 256);
    const inputs = {
      input_ids,
      style: new Tensor('float32', styleRow, [1, 256]),
      speed: new Tensor('float32', [speed], [1]),
    };
    const { waveform } = (await this.model(inputs)) as { waveform: { data: Float32Array } };
    return { audio: waveform.data, sampling_rate: KOKORO_SAMPLE_RATE };
  }
}

// Re-export the transformers env for callers that must tune ONNX backend paths (parity with
// upstream's `env` export; unused in papercusp today).
export const env = _hfEnv;
