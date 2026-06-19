/**
 * operator-voice-io.test.ts — the TUI voice proxy routes
 * (voice-mode-tui-port-2026-06-05 D-006): POST /agent-mcp/operator-stt
 * (base64 WAV → voicemode whisper → text) and POST /agent-mcp/operator-tts
 * (text → prefs-resolved engine → base64 audio).
 *
 * Upstream engines are fetch-stubbed (pattern: local-adapters.test.ts);
 * voice-prefs + credentials are module-mocked (they read PG). The live
 * whisper/kokoro round-trip is covered by the plan's P-004 verification
 * against the staging operator.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DEFAULT_VOICE_PREFS } from '../../../voice-prefs';
import { decodeWavPcm16 } from '../../../voice-node/wav';

vi.mock('../../../voice-prefs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../voice-prefs')>();
  return { ...orig, loadVoicePrefs: vi.fn(async () => ({ ...orig.DEFAULT_VOICE_PREFS })) };
});
vi.mock('../../../voice-credentials', () => ({
  readElevenLabsKey: vi.fn(async () => null),
  readOpenAiKey: vi.fn(async () => null),
  readCartesiaKey: vi.fn(async () => null),
}));

import { loadVoicePrefs } from '../../../voice-prefs';
import { readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import sttRoute from './operator-stt';
import ttsRoute, { synthesize } from './operator-tts';

type Route = { handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response> };

function post(route: unknown, path: string, body: unknown): Promise<Response> {
  return (route as Route).handler(
    new Request(`http://localhost:3070/api/agent-mcp/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: {} },
  );
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    impl(String(url), init),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** A fake 1s-ish WAV payload (just bytes — upstream is stubbed). */
const FAKE_WAV = Buffer.alloc(2048, 7);
const FAKE_WAV_B64 = FAKE_WAV.toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS });
});
afterEach(() => vi.unstubAllGlobals());

// ─── operator-stt ────────────────────────────────────────────────────────────

describe('POST /agent-mcp/operator-stt', () => {
  it('proxies base64 WAV to whisper as multipart and returns the trimmed text', async () => {
    const mock = stubFetch(() => Response.json({ text: '  hello world ' }));
    const res = await post(sttRoute, 'operator-stt', { audioBase64: FAKE_WAV_B64 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, text: 'hello world' });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/audio\/transcriptions$/);
    const fd = init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('model')).toBe('whisper-1');
    const file = fd.get('file') as File;
    expect(file.size).toBe(FAKE_WAV.length);
    expect(file.name).toBe('audio.wav');
  });

  it('400s without audioBase64', async () => {
    stubFetch(() => Response.json({}));
    const res = await post(sttRoute, 'operator-stt', {});
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('400s on audio shorter than a WAV header', async () => {
    stubFetch(() => Response.json({}));
    const res = await post(sttRoute, 'operator-stt', {
      audioBase64: Buffer.alloc(10).toString('base64'),
    });
    expect(res.status).toBe(400);
  });

  it('502s when whisper is down (fetch throws)', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const res = await post(sttRoute, 'operator-stt', { audioBase64: FAKE_WAV_B64 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/unreachable/);
  });

  it('502s on a whisper non-2xx', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));
    const res = await post(sttRoute, 'operator-stt', { audioBase64: FAKE_WAV_B64 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('whisper 500');
  });
});

// ─── operator-tts ────────────────────────────────────────────────────────────

describe('POST /agent-mcp/operator-tts', () => {
  it('synthesizes via the prefs default engine (kokoro) and returns base64 wav', async () => {
    const audio = Buffer.from('RIFF-fake-wav-bytes');
    const mock = stubFetch(() => new Response(audio, { headers: { 'content-type': 'audio/wav' } }));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hello from the TUI' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.engine).toBe('kokoro'); // DEFAULT_VOICE_PREFS.ttsEngine
    expect(body.contentType).toBe('audio/wav');
    expect(Buffer.from(body.audioBase64, 'base64')).toEqual(audio);

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/audio\/speech$/);
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      model: 'kokoro',
      input: 'hello from the TUI',
      voice: 'af_bella',
      response_format: 'wav',
    });
  });

  it("maps ttsEngine 'browser' (no speechSynthesis in a terminal) to kokoro", async () => {
    (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS, ttsEngine: 'browser' });
    stubFetch(() => new Response(Buffer.from('x'), { status: 200 }));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hi' });
    expect((await res.json()).engine).toBe('kokoro');
  });

  it('400s without text', async () => {
    stubFetch(() => new Response(''));
    const res = await post(ttsRoute, 'operator-tts', {});
    expect(res.status).toBe(400);
  });

  it('400s on an unsupported engine', async () => {
    stubFetch(() => new Response(''));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hi', engine: 'webspeech' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unsupported engine/);
  });

  it('404s when the requested cloud engine has no key', async () => {
    stubFetch(() => new Response(''));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hi', engine: 'elevenlabs' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/key not configured/);
  });

  it('uses the prefs elevenlabs voice and caps text at 4000 chars', async () => {
    (readElevenLabsKey as Mock).mockResolvedValue('k-123');
    const mock = stubFetch(() => new Response(Buffer.from('mp3'), { status: 200 }));
    const long = 'a'.repeat(5000);
    const res = await post(ttsRoute, 'operator-tts', { text: long, engine: 'elevenlabs' });
    expect(res.status).toBe(200);
    expect((await res.json()).contentType).toBe('audio/mpeg');
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(DEFAULT_VOICE_PREFS.elevenlabsVoiceId);
    expect(JSON.parse(String(init.body)).text.length).toBe(4000);
  });

  it('502s when the engine is unreachable', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const synth = await synthesize('kokoro', 'hi', undefined, DEFAULT_VOICE_PREFS);
    expect(synth).toMatchObject({ ok: false, status: 502 });
  });

  // ── synthesize() container option (B1 — the p2p voice-channel say-path) ──────
  // voiceAgentSay requests container:'wav' so its decodeWavPcm16 path accepts
  // every server engine. ElevenLabs has no WAV container, so synthesize asks
  // for raw pcm_24000 and wraps it into a WAV here. These exercise synthesize()
  // directly (fetch stubbed) — the same seam voiceAgentSay calls.

  it("elevenlabs container:'wav' requests pcm_24000 and returns a decodable WAV", async () => {
    (readElevenLabsKey as Mock).mockResolvedValue('k-123');
    // What output_format=pcm_24000 yields: raw little-endian PCM16 @ 24kHz.
    const pcm = new Int16Array([0, 1000, -1000, 2000, -2000, 32767, -32768, 123]);
    const mock = stubFetch(() => new Response(Buffer.from(pcm.buffer), { status: 200 }));

    const synth = await synthesize('elevenlabs', 'narrate the demo', undefined, DEFAULT_VOICE_PREFS, {
      container: 'wav',
    });
    expect(synth.ok).toBe(true);
    if (!synth.ok) return;
    expect(synth.contentType).toBe('audio/wav');

    // Must have asked EL for raw PCM (so the WAV wrap is lossless).
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('output_format=pcm_24000');
    expect((init.headers as Record<string, string>).accept).toBe('audio/pcm');

    // The bytes are a real RIFF/WAVE the channel decoder accepts, round-tripping
    // the PCM at 24kHz — proving voiceAgentSay's decodeWavPcm16 path will work.
    const decoded = decodeWavPcm16(new Uint8Array(synth.audio));
    expect(decoded.sampleRate).toBe(24_000);
    expect([...decoded.samples]).toEqual([...pcm]);
  });

  it('elevenlabs default container stays mp3 (audio/mpeg, no output_format) — TUI path unchanged', async () => {
    (readElevenLabsKey as Mock).mockResolvedValue('k-123');
    const mock = stubFetch(() => new Response(Buffer.from('mp3-bytes'), { status: 200 }));
    const synth = await synthesize('elevenlabs', 'narrate the demo', undefined, DEFAULT_VOICE_PREFS);
    expect(synth.ok).toBe(true);
    if (!synth.ok) return;
    expect(synth.contentType).toBe('audio/mpeg');
    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('output_format');
  });

  it("openai/cartesia container:'wav' request a WAV response_format", async () => {
    (readOpenAiKey as Mock).mockResolvedValue('o-123');
    let mock = stubFetch(() => new Response(Buffer.from('RIFF....WAVE'), { status: 200 }));
    let synth = await synthesize('openai', 'hi', undefined, DEFAULT_VOICE_PREFS, { container: 'wav' });
    expect(synth.ok).toBe(true);
    if (synth.ok) expect(synth.contentType).toBe('audio/wav');
    expect(JSON.parse(String((mock.mock.calls[0] as [string, RequestInit])[1].body)).response_format).toBe('wav');

    (readCartesiaKey as Mock).mockResolvedValue('c-123');
    mock = stubFetch(() => new Response(Buffer.from('RIFF....WAVE'), { status: 200 }));
    synth = await synthesize('cartesia', 'hi', undefined, DEFAULT_VOICE_PREFS, { container: 'wav' });
    expect(synth.ok).toBe(true);
    if (synth.ok) expect(synth.contentType).toBe('audio/wav');
    expect(JSON.parse(String((mock.mock.calls[0] as [string, RequestInit])[1].body)).output_format.container).toBe('wav');
  });
});
