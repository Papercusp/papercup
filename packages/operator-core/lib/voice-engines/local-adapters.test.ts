/**
 * local-adapters.test.ts — fetch-based health + transcription surfaces of
 * the local voice engine adapters: whisper (STT) and kokoro (TTS).
 * Plan 1 P-026 extension.
 *
 * Scope: health() probes + fetch-based helpers (transcribeChunk, voices()).
 * Browser-coupled paths (speak(), MediaRecorder, blob URLs, <audio>) are
 * not covered here — they require integration/e2e environment.
 *
 * Pattern mirrors cloud-adapters.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoicemodeWhisper, transcribeChunk } from './whisper';
import { createKokoroTts } from './kokoro';

function stubFetch(opts: { status?: number; body?: unknown; throws?: Error }) {
  const mock = vi.fn(async (..._args: unknown[]) => {
    if (opts.throws) throw opts.throws;
    return new Response(
      opts.body === undefined ? '' : JSON.stringify(opts.body),
      { status: opts.status ?? 200 },
    );
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

// ─── whisper (Voicemode STT) ─────────────────────────────────────────────────

describe('whisper (voicemode STT)', () => {
  describe('health()', () => {
    it('returns true when /health responds ok', async () => {
      stubFetch({ status: 200, body: { ok: true } });
      const engine = createVoicemodeWhisper('http://localhost:8080');
      expect(await engine.health()).toBe(true);
    });

    it('returns false when /health returns non-ok', async () => {
      stubFetch({ status: 503, body: {} });
      const engine = createVoicemodeWhisper('http://localhost:8080');
      expect(await engine.health()).toBe(false);
    });

    it('returns false when fetch throws (server unreachable)', async () => {
      stubFetch({ throws: new Error('ECONNREFUSED') });
      const engine = createVoicemodeWhisper('http://localhost:8080');
      expect(await engine.health()).toBe(false);
    });

    it('hits the right health endpoint URL', async () => {
      const m = stubFetch({ status: 200, body: {} });
      await createVoicemodeWhisper('http://vm:9000').health();
      expect(m.mock.calls[0][0]).toBe('http://vm:9000/health');
    });
  });

  describe('transcribeChunk()', () => {
    it('returns the transcript text on success', async () => {
      stubFetch({ body: { text: 'hello world' } });
      const audio = new Blob(['fake-audio'], { type: 'audio/webm' });
      const text = await transcribeChunk('http://localhost:8080', audio);
      expect(text).toBe('hello world');
    });

    it('returns empty string on non-ok response', async () => {
      stubFetch({ status: 500, body: {} });
      const audio = new Blob([], { type: 'audio/webm' });
      const text = await transcribeChunk('http://localhost:8080', audio);
      expect(text).toBe('');
    });

    it('POSTs to /v1/audio/transcriptions with FormData', async () => {
      const m = stubFetch({ body: { text: '' } });
      const audio = new Blob(['data'], { type: 'audio/webm' });
      await transcribeChunk('http://localhost:8080', audio);
      const [url, init] = m.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:8080/v1/audio/transcriptions');
      expect((init as any).method).toBe('POST');
      expect((init as any).body).toBeInstanceOf(FormData);
    });

    it('returns empty string when body has no text field', async () => {
      stubFetch({ body: {} });
      const audio = new Blob([], { type: 'audio/webm' });
      expect(await transcribeChunk('http://localhost:8080', audio)).toBe('');
    });
  });
});

// ─── kokoro (TTS) ────────────────────────────────────────────────────────────

describe('kokoro TTS', () => {
  describe('health()', () => {
    it('returns true when /health responds ok', async () => {
      stubFetch({ status: 200, body: {} });
      expect(await createKokoroTts('http://localhost:8000').health()).toBe(true);
    });

    it('returns false when /health returns non-ok', async () => {
      stubFetch({ status: 503 });
      expect(await createKokoroTts('http://localhost:8000').health()).toBe(false);
    });

    it('returns false on fetch error', async () => {
      stubFetch({ throws: new Error('ECONNREFUSED') });
      expect(await createKokoroTts('http://localhost:8000').health()).toBe(false);
    });
  });

  describe('voices()', () => {
    it('returns mapped voice list from OpenAI-compatible { data: [...] } shape', async () => {
      stubFetch({ body: { data: [{ id: 'af_bella', name: 'Bella' }, { id: 'am_echo', name: 'Echo' }] } });
      const voices = await createKokoroTts('http://localhost:8000').voices!();
      expect(voices).toEqual([
        { id: 'af_bella', name: 'Bella', lang: undefined },
        { id: 'am_echo', name: 'Echo', lang: undefined },
      ]);
    });

    it('handles bare array response', async () => {
      stubFetch({ body: [{ id: 'v1', name: 'Voice 1' }] });
      const voices = await createKokoroTts('http://localhost:8000').voices!();
      expect(voices[0].id).toBe('v1');
    });

    it('returns empty array on non-ok response', async () => {
      stubFetch({ status: 503 });
      const voices = await createKokoroTts('http://localhost:8000').voices!();
      expect(voices).toEqual([]);
    });

    it('returns empty array when fetch throws', async () => {
      stubFetch({ throws: new Error('unreachable') });
      const voices = await createKokoroTts('http://localhost:8000').voices!();
      expect(voices).toEqual([]);
    });
  });
});
