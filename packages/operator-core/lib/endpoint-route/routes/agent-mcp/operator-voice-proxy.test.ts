/**
 * operator-voice-proxy.test.ts — the pure, network-free helpers shared by the
 * TUI voice proxy routes (voice-mode-tui-port-2026-06-05 D-006). The route-level
 * round-trips (multipart → whisper, text → engine) live in operator-voice-io.test.ts;
 * here we pin the validation / size-cap / engine-resolution decisions in isolation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  decodeAudioBase64,
  normalizeAudioFormat,
  isServerTtsEngine,
  resolveTtsEngine,
  MAX_AUDIO_BYTES,
  MIN_AUDIO_BYTES,
} from './operator-voice-proxy-helpers';

describe('decodeAudioBase64', () => {
  it('rejects missing / non-string / empty', () => {
    expect(decodeAudioBase64(undefined)).toMatchObject({ ok: false, status: 400 });
    expect(decodeAudioBase64(123)).toMatchObject({ ok: false, status: 400 });
    expect(decodeAudioBase64('')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects audio shorter than a WAV header (400)', () => {
    const tiny = Buffer.alloc(MIN_AUDIO_BYTES - 1).toString('base64');
    expect(decodeAudioBase64(tiny)).toMatchObject({
      ok: false,
      status: 400,
      error: 'audio too short to transcribe',
    });
  });

  it('rejects audio over the size cap (413)', () => {
    // Construct an oversized payload without allocating it twice: a base64 string
    // whose decoded length exceeds the cap. 4 b64 chars → 3 bytes.
    const overBytes = MAX_AUDIO_BYTES + 3;
    const b64 = 'A'.repeat(Math.ceil(overBytes / 3) * 4);
    const res = decodeAudioBase64(b64);
    expect(res).toMatchObject({ ok: false, status: 413 });
  });

  it('accepts a valid in-range payload and returns the decoded Buffer', () => {
    const audio = Buffer.alloc(MIN_AUDIO_BYTES + 100, 9);
    const res = decodeAudioBase64(audio.toString('base64'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.audio).toEqual(audio);
  });
});

describe('normalizeAudioFormat', () => {
  it('defaults to wav and only accepts webm explicitly', () => {
    expect(normalizeAudioFormat(undefined)).toBe('wav');
    expect(normalizeAudioFormat('wav')).toBe('wav');
    expect(normalizeAudioFormat('mp3')).toBe('wav'); // unknown → wav
    expect(normalizeAudioFormat('webm')).toBe('webm');
  });
});

describe('isServerTtsEngine', () => {
  it('recognizes the server-side engines, rejects browser/garbage', () => {
    for (const e of ['kokoro', 'elevenlabs', 'openai', 'cartesia']) {
      expect(isServerTtsEngine(e)).toBe(true);
    }
    expect(isServerTtsEngine('browser')).toBe(false);
    expect(isServerTtsEngine('webspeech')).toBe(false);
  });
});

describe('resolveTtsEngine', () => {
  const healthy = () => Promise.resolve(true);
  const unhealthy = () => Promise.resolve(false);

  it('honors an explicit, supported request over the prefs default', async () => {
    const r = await resolveTtsEngine('elevenlabs', { ttsEngine: 'kokoro' }, healthy);
    expect(r).toEqual({ ok: true, engine: 'elevenlabs' });
  });

  it('falls back to the prefs default when no engine is requested', async () => {
    const r = await resolveTtsEngine(undefined, { ttsEngine: 'openai' }, healthy);
    expect(r).toEqual({ ok: true, engine: 'openai' });
    // empty string is treated as "not requested" too
    const r2 = await resolveTtsEngine('', { ttsEngine: 'cartesia' }, healthy);
    expect(r2).toEqual({ ok: true, engine: 'cartesia' });
  });

  it("maps 'browser' to kokoro only when kokoro is healthy", async () => {
    const probe = vi.fn(healthy);
    const r = await resolveTtsEngine('browser', { ttsEngine: 'browser' }, probe);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("503s for 'browser' when kokoro is unreachable (no server-side engine)", async () => {
    const r = await resolveTtsEngine('browser', { ttsEngine: 'browser' }, unhealthy);
    expect(r).toEqual({ ok: false, error: 'no server-side tts engine available', status: 503 });
  });

  it('400s an unknown/unsupported engine', async () => {
    const r = await resolveTtsEngine('webspeech', { ttsEngine: 'kokoro' }, healthy);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('does not probe health when a real engine resolves (no needless network)', async () => {
    const probe = vi.fn(healthy);
    await resolveTtsEngine('kokoro', { ttsEngine: 'kokoro' }, probe);
    expect(probe).not.toHaveBeenCalled();
  });
});
