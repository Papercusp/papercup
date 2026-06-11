/**
 * POST /api/agent-mcp/operator-tts — full-reply TTS synthesis for non-browser
 * clients (the TUI's PTT path — voice-mode-tui-port-2026-06-05 D-006).
 *
 * Body: `{ text: string, engine?, voiceId? }` → `{ ok, engine, contentType,
 * audioBase64 }`. Unlike `operator-tts-preview` (200-char samples for the
 * settings page), this speaks whole replies (4000-char cap) and returns
 * base64 JSON instead of raw bytes — the TUI's IPC `sys:http` bridge is
 * binary-unsafe (UTF-8 string frames). Engine + voice default from the
 * operator's voice prefs (D-003: prefs reused as-is); `'browser'`
 * (speechSynthesis — meaningless outside a browser) falls back to kokoro
 * when kokoro's health check passes, else `{ ok:false, error:'no server-side
 * tts engine available' }`. Keys for the cloud engines stay server-side.
 * `auth: 'public'` like the sibling operator voice routes.
 */
import { readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import { loadVoicePrefs, type VoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';
import {
  KOKORO_URL,
  MAX_TEXT_CHARS,
  probeKokoroHealth,
  resolveTtsEngine,
} from './operator-voice-proxy-helpers';

const TTS_TIMEOUT_MS = 30_000;

type Synth =
  | { ok: true; audio: ArrayBuffer; contentType: string }
  | { ok: false; error: string; status: number };

/** Synthesize `text` on `engine`. Exported for unit tests (fetch stubbed). */
export async function synthesize(
  engine: string,
  text: string,
  voiceId: string | undefined,
  prefs: VoicePrefs,
): Promise<Synth> {
  const upstream = async (r: Response, contentType: string): Promise<Synth> => {
    if (!r.ok || !r.body) return { ok: false, error: `${engine} ${r.status}`, status: 502 };
    return { ok: true, audio: await r.arrayBuffer(), contentType };
  };
  try {
    switch (engine) {
      case 'kokoro': {
        const r = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'kokoro',
            input: text,
            voice: voiceId ?? 'af_bella',
            response_format: 'wav',
          }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
        return upstream(r, 'audio/wav');
      }
      case 'elevenlabs': {
        const key = await readElevenLabsKey();
        if (!key) return { ok: false, error: 'elevenlabs key not configured', status: 404 };
        const voice = voiceId ?? prefs.elevenlabsVoiceId;
        const r = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=2`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
            signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
          },
        );
        return upstream(r, 'audio/mpeg');
      }
      case 'openai': {
        const key = await readOpenAiKey();
        if (!key) return { ok: false, error: 'openai key not configured', status: 404 };
        const r = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            model: prefs.openaiModel,
            input: text,
            voice: voiceId ?? prefs.openaiVoice,
            response_format: 'mp3',
          }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
        return upstream(r, 'audio/mpeg');
      }
      case 'cartesia': {
        const key = await readCartesiaKey();
        if (!key) return { ok: false, error: 'cartesia key not configured', status: 404 };
        const r = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'X-API-Key': key,
            'Cartesia-Version': '2024-11-13',
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            model_id: prefs.cartesiaModel,
            transcript: text,
            voice: { mode: 'id', id: voiceId ?? prefs.cartesiaVoiceId },
            output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
          }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
        return upstream(r, 'audio/mpeg');
      }
      default:
        return { ok: false, error: `unsupported engine '${engine}'`, status: 400 };
    }
  } catch (e) {
    return { ok: false, error: `${engine} unreachable: ${(e as Error).message}`, status: 502 };
  }
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-tts',
  auth: 'loopback',
  async handler(req) {
    let body: { text?: unknown; engine?: unknown; voiceId?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return Response.json({ ok: false, error: 'text (string) required' }, { status: 400 });
    }
    const prefs = await loadVoicePrefs();
    // Resolve engine + apply the browser→kokoro health-gated fallback (D-006):
    // 'browser' (speechSynthesis) is meaningless in a terminal, so it maps to
    // local kokoro only when kokoro's health check passes — else a clean error.
    const resolved = await resolveTtsEngine(body.engine, prefs, () => probeKokoroHealth(KOKORO_URL));
    if (!resolved.ok) {
      return Response.json({ ok: false, error: resolved.error }, { status: resolved.status });
    }
    const engine = resolved.engine;
    const voiceId = typeof body.voiceId === 'string' && body.voiceId ? body.voiceId : undefined;

    const synth = await synthesize(engine, text.slice(0, MAX_TEXT_CHARS), voiceId, prefs);
    if (!synth.ok) {
      return Response.json({ ok: false, error: synth.error, engine }, { status: synth.status });
    }
    return Response.json({
      ok: true,
      engine,
      contentType: synth.contentType,
      audioBase64: Buffer.from(synth.audio).toString('base64'),
    });
  },
});
