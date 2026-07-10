/**
 * WI-3662: fetchElevenLabsVoices reads the account voice library SERVER-SIDE.
 * The settings page used to fetch /v1/voices directly from the browser with a
 * masked key (always 401), so the picker was stuck on one default; the server
 * proxy fixes that. These pin the mapping + the never-throw contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchElevenLabsVoices } from './elevenlabs';

function stubFetch(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('fetchElevenLabsVoices', () => {
  it('maps voice_id→id + name, carries a labels.language when present', async () => {
    stubFetch(async () => new Response(JSON.stringify({
      voices: [
        { voice_id: 'v1', name: 'Adam', labels: { language: 'en' } },
        { voice_id: 'v2', name: 'Bella' },
      ],
    }), { status: 200 }));
    try {
      const out = await fetchElevenLabsVoices('sk_key');
      expect(out).toEqual([
        { id: 'v1', name: 'Adam', lang: 'en' },
        { id: 'v2', name: 'Bella' },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends the key in the xi-api-key header (server-side only)', async () => {
    // Type the mock's params (url, init) so mock.calls[0] is a 2-tuple, not the
    // zero-arg `[]` vi.fn infers from a no-param impl (which has no index 1 and
    // makes the `as RequestInit` cast on `undefined` a tsc error).
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ voices: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await fetchElevenLabsVoices('sk_secret');
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.headers).toMatchObject({ 'xi-api-key': 'sk_secret' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops malformed entries (missing voice_id or name)', async () => {
    stubFetch(async () => new Response(JSON.stringify({
      voices: [
        { voice_id: 'ok', name: 'Good' },
        { name: 'no-id' },
        { voice_id: 'no-name' },
        null,
      ],
    }), { status: 200 }));
    try {
      expect(await fetchElevenLabsVoices('k')).toEqual([{ id: 'ok', name: 'Good' }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns [] (never throws) on a non-ok status', async () => {
    stubFetch(async () => new Response('', { status: 401 }));
    try {
      expect(await fetchElevenLabsVoices('k')).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns [] (never throws) when ElevenLabs is unreachable', async () => {
    stubFetch(async () => { throw new Error('ENOTFOUND'); });
    try {
      expect(await fetchElevenLabsVoices('k')).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
