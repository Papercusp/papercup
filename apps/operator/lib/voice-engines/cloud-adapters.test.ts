/**
 * P-026 (production-readiness-test-coverage) — cloud voice-engine adapters:
 * request shaping + error handling for the fetch-based connection-test + health
 * surfaces of deepgram / openai / cartesia / elevenlabs. These are the cleanly
 * unit-testable parts; the streaming-frame parse + speak/cancel paths are
 * browser-coupled (MediaRecorder / MediaSource / WebSocket / <audio>) and are
 * covered at the integration/e2e layer, not here.
 *
 * For each adapter we assert: the right URL + auth header, a success body maps
 * to the documented shape, a non-ok HTTP status maps to {ok:false,error:'HTTP …'},
 * a thrown fetch maps to {ok:false,error}, and health() reflects r.ok / catches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeepgramStt, testDeepgramConnection } from './deepgram';
import { createOpenAiTts, testOpenAiConnection } from './openai';
import { createCartesiaTts, testCartesiaConnection } from './cartesia';
import { createElevenLabsTts, testElevenLabsConnection } from './elevenlabs';

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

describe('deepgram', () => {
  it('testDeepgramConnection: success → project count + Token auth on /projects', async () => {
    const m = stubFetch({ body: { projects: [{}, {}] } });
    expect(await testDeepgramConnection('dg-key')).toEqual({ ok: true, projects: 2 });
    const { url, init } = firstCall(m);
    expect(url).toBe('https://api.deepgram.com/v1/projects');
    expect(headerOf(init, 'Authorization')).toBe('Token dg-key');
  });

  it('testDeepgramConnection: non-ok → {ok:false, error:"HTTP 401"}', async () => {
    stubFetch({ status: 401 });
    expect(await testDeepgramConnection('bad')).toEqual({ ok: false, error: 'HTTP 401' });
  });

  it('testDeepgramConnection: thrown fetch → {ok:false, error}', async () => {
    stubFetch({ throws: new Error('network down') });
    expect(await testDeepgramConnection('k')).toEqual({ ok: false, error: 'network down' });
  });

  it('health(): true when ok, false when fetch throws', async () => {
    stubFetch({ status: 200 });
    expect(await createDeepgramStt({ apiKey: 'k' }).health()).toBe(true);
    stubFetch({ throws: new Error('x') });
    expect(await createDeepgramStt({ apiKey: 'k' }).health()).toBe(false);
  });
});

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

  it('health(): hits /models/<model> with Bearer and reflects r.ok', async () => {
    const m = stubFetch({ status: 200 });
    expect(await createOpenAiTts({ apiKey: 'k', model: 'tts-1', voice: 'alloy' }).health()).toBe(true);
    expect(firstCall(m).url).toBe('https://api.openai.com/v1/models/tts-1');
  });
});

describe('cartesia', () => {
  it('testCartesiaConnection: success → voice count, X-API-Key + version on /voices', async () => {
    const m = stubFetch({ body: [{}, {}, {}] });
    expect(await testCartesiaConnection('ct-key')).toEqual({ ok: true, voicesAvailable: 3 });
    const { url, init } = firstCall(m);
    expect(url).toBe('https://api.cartesia.ai/voices');
    expect(headerOf(init, 'X-API-Key')).toBe('ct-key');
    expect(headerOf(init, 'Cartesia-Version')).toBe('2024-06-10');
  });

  it('testCartesiaConnection: non-array body → 0 voices', async () => {
    stubFetch({ body: { not: 'an array' } });
    expect(await testCartesiaConnection('k')).toEqual({ ok: true, voicesAvailable: 0 });
  });

  it('testCartesiaConnection: non-ok → HTTP error', async () => {
    stubFetch({ status: 500 });
    expect(await testCartesiaConnection('k')).toEqual({ ok: false, error: 'HTTP 500' });
  });

  it('health(): reflects r.ok', async () => {
    stubFetch({ status: 200 });
    expect(await createCartesiaTts({ apiKey: 'k', model: 'sonic', voiceId: 'v' }).health()).toBe(true);
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

  it('health(): true when ok, false when fetch throws', async () => {
    stubFetch({ status: 200 });
    expect(await createElevenLabsTts({ apiKey: 'k', voiceId: 'v' }).health()).toBe(true);
    stubFetch({ throws: new Error('x') });
    expect(await createElevenLabsTts({ apiKey: 'k', voiceId: 'v' }).health()).toBe(false);
  });
});
