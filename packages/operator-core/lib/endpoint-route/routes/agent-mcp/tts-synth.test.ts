/**
 * tts-synth — the ONE server-side TTS provider registry (voice-consolidation,
 * WI-3448). Pins the properties that make "switch provider = one config change,
 * not a second implementation" true:
 *
 *   - each provider dispatches to the right endpoint with the right auth;
 *   - openai/cartesia read model+voice from PREFS (this is the exact drift that
 *     used to differ between operator-tts and operator-tts-preview — preview
 *     hardcoded tts-1/nova/sonic-2 — so it is pinned here);
 *   - an explicit voiceId overrides the pref;
 *   - a missing cloud key → 404 with NO upstream call; an unknown engine → 400;
 *   - `operator-tts` re-exports the SAME `synthesize` reference, i.e. both
 *     server routes share one implementation (local kokoro ↔ ElevenLabs is one
 *     `ttsEngine` flip against this single code path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const keys: { el: string | null; oa: string | null; ct: string | null } = {
  el: 'el-key',
  oa: 'oa-key',
  ct: 'ct-key',
};
vi.mock('../../../voice-credentials', () => ({
  readElevenLabsKey: async () => keys.el,
  readOpenAiKey: async () => keys.oa,
  readCartesiaKey: async () => keys.ct,
  readDeepgramKey: async () => null,
}));

import { synthesize } from './tts-synth';
import { synthesize as synthesizeFromRoute } from './operator-tts';
import type { VoicePrefs } from '../../../voice-prefs';

// Only the fields synthesize() reads; cast a partial to the full type.
const PREFS = {
  elevenlabsVoiceId: 'voice-EL',
  openaiVoice: 'shimmer',
  openaiModel: 'tts-1-hd',
  cartesiaVoiceId: 'voice-CT',
  cartesiaModel: 'sonic-2',
} as unknown as VoicePrefs;

function stubFetch(opts: { status?: number } = {}) {
  const mock = vi.fn(async () => new Response('AUDIO-BYTES', { status: opts.status ?? 200 }));
  vi.stubGlobal('fetch', mock);
  return mock;
}
function firstCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; body: any } {
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse((init.body as string) ?? '{}') };
}
const header = (init: RequestInit, k: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[k];

afterEach(() => {
  vi.unstubAllGlobals();
  keys.el = 'el-key';
  keys.oa = 'oa-key';
  keys.ct = 'ct-key';
});

describe('synthesize() — single server-side TTS registry', () => {
  it('kokoro → local kokoro server, WAV, default voice', async () => {
    const m = stubFetch();
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contentType).toBe('audio/wav');
    const { url, body } = firstCall(m);
    expect(url).toContain('/v1/audio/speech');
    expect(body).toMatchObject({ model: 'kokoro', input: 'hi', voice: 'af_bella', response_format: 'wav' });
  });

  it('elevenlabs → prefs voiceId in URL, turbo model, xi-api-key header', async () => {
    const m = stubFetch();
    const r = await synthesize('elevenlabs', 'hi', undefined, PREFS);
    expect(r.ok).toBe(true);
    const { url, init, body } = firstCall(m);
    expect(url).toContain('/text-to-speech/voice-EL/stream');
    expect(header(init, 'xi-api-key')).toBe('el-key');
    expect(body.model_id).toBe('eleven_turbo_v2_5');
  });

  it('openai → reads prefs.openaiModel + prefs.openaiVoice (drift fix — NOT hardcoded tts-1/nova)', async () => {
    const m = stubFetch();
    await synthesize('openai', 'hi', undefined, PREFS);
    const { url, init, body } = firstCall(m);
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(header(init, 'Authorization')).toBe('Bearer oa-key');
    expect(body).toMatchObject({ model: 'tts-1-hd', voice: 'shimmer' });
  });

  it('cartesia → reads prefs.cartesiaModel + prefs.cartesiaVoiceId', async () => {
    const m = stubFetch();
    await synthesize('cartesia', 'hi', undefined, PREFS);
    const { url, body } = firstCall(m);
    expect(url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(body.model_id).toBe('sonic-2');
    expect(body.voice).toMatchObject({ mode: 'id', id: 'voice-CT' });
  });

  it('explicit voiceId overrides the pref', async () => {
    const m = stubFetch();
    await synthesize('elevenlabs', 'hi', 'override-voice', PREFS);
    expect(firstCall(m).url).toContain('/text-to-speech/override-voice/stream');
  });

  it('missing cloud key → 404, no upstream call attempted', async () => {
    keys.el = null;
    const m = stubFetch();
    const r = await synthesize('elevenlabs', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(m).not.toHaveBeenCalled();
  });

  it('unknown engine → 400', async () => {
    const r = await synthesize('bogus', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('upstream non-ok → 502', async () => {
    stubFetch({ status: 500 });
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 502 });
  });

  it('operator-tts re-exports the SAME synthesize (one implementation shared by both routes)', () => {
    expect(synthesizeFromRoute).toBe(synthesize);
  });
});

/**
 * Upstream status classification (voice-thorough-test-2026-07-09, WI-3527).
 *
 * Every upstream failure used to collapse to 502, so "your ElevenLabs key was
 * rejected / you're out of credits" (401 — the user fixes it) was indisputable
 * from "the provider is down" (5xx — the user waits). A real defunded EL account
 * surfaced from the settings preview as a bare `502`. These pin the classes.
 */
describe('synthesize() — upstream failure classification', () => {
  const respond = (status: number, body: BodyInit | null = 'ERR') => {
    const mock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', mock);
    return mock;
  };

  it('upstream 401 → 401 (credential rejected / out of credits), not 502', async () => {
    respond(401);
    const r = await synthesize('elevenlabs', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 401 });
    if (!r.ok) expect(r.error).toContain('elevenlabs 401');
  });

  it('upstream 403 → 401 (also a credential problem)', async () => {
    respond(403);
    expect(await synthesize('elevenlabs', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 401 });
  });

  it('upstream 429 → 429 (rate-limited / quota exhausted), not 502', async () => {
    respond(429);
    expect(await synthesize('openai', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 429 });
  });

  it('upstream 400 → 400 (bad voice/model — e.g. kokoro rejecting an unknown voice)', async () => {
    respond(400);
    expect(await synthesize('kokoro', 'hi', 'zz_nonexistent', PREFS)).toMatchObject({ ok: false, status: 400 });
  });

  it('upstream 404 → 400, NEVER 404 (404 is reserved for the no-key contract)', async () => {
    respond(404);
    const r = await synthesize('cartesia', 'hi', undefined, PREFS);
    // If this leaked a 404, operator-tts-preview would mislabel a live provider
    // error as 'no-key' and the settings panel would tell the user to add a key
    // they already have.
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('upstream 5xx → 502 (infrastructure, not the user)', async () => {
    respond(503);
    expect(await synthesize('kokoro', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 502 });
  });

  it('2xx with an empty body → 502', async () => {
    respond(200, null);
    expect(await synthesize('kokoro', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 502 });
  });

  it('a thrown/timed-out fetch → 502 unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 502 });
    if (!r.ok) expect(r.error).toContain('unreachable');
  });

  it("the EL container:'wav' branch classifies through the same guard (no bespoke copy)", async () => {
    respond(401);
    expect(
      await synthesize('elevenlabs', 'hi', undefined, PREFS, { container: 'wav' }),
    ).toMatchObject({ ok: false, status: 401 });
  });
});
