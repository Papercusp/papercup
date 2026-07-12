/**
 * P-009 hop 3: the kokoro engine's in-process fallback contract (plan D-009).
 * An external kokoro server (KOKORO_URL) takes precedence; an UNREACHABLE one falls back to
 * the provisioned kokoro-js engine; an answering-but-erroring one keeps its honest upstream
 * classification (the fallback must never mask a broken server).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../voice-node/kokoro-local', () => ({
  kokoroLocalSynthWav: vi.fn(),
}));

import { synthesize } from './tts-synth';
import { kokoroLocalSynthWav } from '../../../voice-node/kokoro-local';
import type { VoicePrefs } from '../../../voice-prefs';

const prefs = {} as VoicePrefs;
const realFetch = globalThis.fetch;

describe('tts-synth kokoro: in-process fallback', () => {
  beforeEach(() => {
    vi.mocked(kokoroLocalSynthWav).mockReset();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('unreachable HTTP kokoro + provisioned local engine → local WAV', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8880');
    }) as never;
    const wav = new ArrayBuffer(64);
    vi.mocked(kokoroLocalSynthWav).mockResolvedValue({ ok: true, audio: wav, contentType: 'audio/wav' });

    const r = await synthesize('kokoro', 'hello', undefined, prefs);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio).toBe(wav);
      expect(r.contentType).toBe('audio/wav');
    }
    expect(kokoroLocalSynthWav).toHaveBeenCalledWith('hello', undefined);
  });

  it('unreachable HTTP kokoro + NOT provisioned → honest 502 naming both failures', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8880');
    }) as never;
    vi.mocked(kokoroLocalSynthWav).mockResolvedValue({ ok: false, error: 'kokoro local model not provisioned' });

    const r = await synthesize('kokoro', 'hello', undefined, prefs);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.error).toMatch(/ECONNREFUSED/);
      expect(r.error).toMatch(/not provisioned/);
    }
  });

  it('an HTTP kokoro that ANSWERS with an error keeps upstream classification — no fallback masking', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as never;
    const r = await synthesize('kokoro', 'hello', undefined, prefs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
    expect(kokoroLocalSynthWav).not.toHaveBeenCalled();
  });

  it('a healthy HTTP kokoro is served as before — the local engine is never consulted', async () => {
    const audio = new Uint8Array([1, 2, 3]).buffer;
    globalThis.fetch = vi.fn(async () => new Response(audio, { status: 200, headers: { 'content-type': 'audio/wav' } })) as never;
    const r = await synthesize('kokoro', 'hello', 'af_bella', prefs);
    expect(r.ok).toBe(true);
    expect(kokoroLocalSynthWav).not.toHaveBeenCalled();
  });
});
