/**
 * Cloud provider connection-test helpers — the live key-validation surfaces
 * used by /settings/voice (operator-{elevenlabs,openai,cartesia}-test routes).
 *
 * For each: assert the right URL + auth header, that a success body maps to the
 * documented shape, and that a non-ok HTTP status / thrown fetch map to
 * {ok:false,error}. (The `create*Tts` speak/health adapters this file used to
 * also cover — plus the deepgram adapter — were part of the dead client
 * `detectEngines` framework, removed 2026-07-09, WI-3448. Server-side synthesis
 * is now the single `synthesize()` registry, covered by voice-tts-synth.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testOpenAiConnection } from './openai';
import { testCartesiaConnection, CARTESIA_API_VERSION } from './cartesia';
import { testElevenLabsConnection } from './elevenlabs';

/** Stub global fetch with a JSON response (or a thrown error). Returns the mock. */
function stubFetch(opts: { status?: number; body?: unknown; throws?: Error }) {
  const fetchMock = vi.fn(async () => {
    if (opts.throws) throw opts.throws;
    return new Response(opts.body === undefined ? '' : JSON.stringify(opts.body), {
      status: opts.status ?? 200,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function firstCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init };
}
const headerOf = (init: RequestInit, name: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[name];

afterEach(() => vi.unstubAllGlobals());

describe('openai', () => {
  it('testOpenAiConnection: success → only tts-* models, Bearer auth on /models', async () => {
    const m = stubFetch({ body: { data: [{ id: 'tts-1' }, { id: 'gpt-4o' }, { id: 'tts-1-hd' }] } });
    expect(await testOpenAiConnection('oa-key')).toEqual({ ok: true, models: ['tts-1', 'tts-1-hd'] });
    const { url, init } = firstCall(m);
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(headerOf(init, 'Authorization')).toBe('Bearer oa-key');
  });

  it('testOpenAiConnection: non-ok → HTTP error', async () => {
    stubFetch({ status: 403 });
    expect(await testOpenAiConnection('bad')).toEqual({ ok: false, error: 'HTTP 403' });
  });

  it('testOpenAiConnection: thrown fetch → {ok:false, error}', async () => {
    stubFetch({ throws: new Error('network down') });
    expect(await testOpenAiConnection('k')).toEqual({ ok: false, error: 'network down' });
  });
});

describe('cartesia', () => {
  it('testCartesiaConnection: success → voice count, X-API-Key + version on /voices', async () => {
    const m = stubFetch({ body: [{}, {}, {}] });
    expect(await testCartesiaConnection('ct-key')).toEqual({ ok: true, voicesAvailable: 3 });
    const { url, init } = firstCall(m);
    expect(url).toBe('https://api.cartesia.ai/voices');
    expect(headerOf(init, 'X-API-Key')).toBe('ct-key');
    // WI-3557: version now hoisted to the shared CARTESIA_API_VERSION const
    // (imported here so this test breaks if the two call sites ever re-diverge).
    expect(headerOf(init, 'Cartesia-Version')).toBe(CARTESIA_API_VERSION);
  });

  it('testCartesiaConnection: non-array body → 0 voices', async () => {
    stubFetch({ body: { not: 'an array' } });
    expect(await testCartesiaConnection('k')).toEqual({ ok: true, voicesAvailable: 0 });
  });

  it('testCartesiaConnection: non-ok → HTTP error', async () => {
    stubFetch({ status: 500 });
    expect(await testCartesiaConnection('k')).toEqual({ ok: false, error: 'HTTP 500' });
  });
});

describe('elevenlabs', () => {
  it('testElevenLabsConnection: success → subscription fields, xi-api-key on /user', async () => {
    const m = stubFetch({
      body: { subscription: { tier: 'pro', character_count: 10, character_limit: 1000 }, email: 'a@b.c' },
    });
    expect(await testElevenLabsConnection('el-key')).toEqual({
      ok: true,
      tier: 'pro',
      characterCount: 10,
      characterLimit: 1000,
      email: 'a@b.c',
    });
    const { url, init } = firstCall(m);
    expect(url).toBe('https://api.elevenlabs.io/v1/user');
    expect(headerOf(init, 'xi-api-key')).toBe('el-key');
  });

  it('testElevenLabsConnection: defaults missing subscription fields', async () => {
    stubFetch({ body: {} });
    expect(await testElevenLabsConnection('k')).toEqual({
      ok: true,
      tier: 'unknown',
      characterCount: 0,
      characterLimit: 0,
      email: null,
    });
  });

  it('testElevenLabsConnection: non-ok → HTTP error', async () => {
    stubFetch({ status: 401 });
    expect(await testElevenLabsConnection('bad')).toEqual({ ok: false, error: 'HTTP 401' });
  });
});
