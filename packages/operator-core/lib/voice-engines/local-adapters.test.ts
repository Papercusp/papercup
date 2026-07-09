/**
 * whisper transcribeChunk — the live local STT surface (voicemode / whisper).
 *
 * Scope: the fetch-based one-shot transcription helper the desktop chrome
 * (voice-mode.ts) calls on each finalized audio chunk. The browser-coupled
 * capture loop (MediaRecorder, VAD, blob URLs) lives in voice-mode.ts and is
 * covered at the integration/e2e layer, not here.
 *
 * (The old `createVoicemodeWhisper` / `createKokoroTts` engine-adapter shells
 * this file also exercised were part of the dead client `detectEngines`
 * framework — removed 2026-07-09, WI-3448.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeChunk } from './whisper';

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

describe('transcribeChunk() (voicemode whisper STT)', () => {
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
