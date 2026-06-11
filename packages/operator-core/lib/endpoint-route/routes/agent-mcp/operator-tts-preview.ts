/**
 * POST /api/agent-mcp/operator-tts-preview — per-engine TTS preview synthesis.
 * Ported from app/api/agent-mcp/operator-tts-preview/route.ts. `auth: 'public'`.
 */
import { readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import { defineTool } from '@papercusp/agent-mcp';

const SAMPLE_TEXT = 'This is a sample of the operator voice.';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-tts-preview',
  auth: 'loopback',
  async handler(req) {
    let body: { engine?: string; text?: string; voiceId?: string } = {};
    try { body = (await req.json()) as typeof body; } catch { /* empty body OK */ }

    const text = body.text?.slice(0, 200) ?? SAMPLE_TEXT;
    const engine = body.engine;

    if (engine === 'elevenlabs') {
      const key = await readElevenLabsKey();
      if (!key) return new Response('no-key', { status: 404 });
      const voice = body.voiceId ?? '21m00Tcm4TlvDq8ikWAM';
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=2`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok || !r.body) return new Response(`elevenlabs ${r.status}`, { status: 502 });
      return new Response(r.body, { headers: { 'content-type': 'audio/mpeg' } });
    }

    if (engine === 'openai') {
      const key = await readOpenAiKey();
      if (!key) return new Response('no-key', { status: 404 });
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: body.voiceId ?? 'nova',
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok || !r.body) return new Response(`openai ${r.status}`, { status: 502 });
      return new Response(r.body, { headers: { 'content-type': 'audio/mpeg' } });
    }

    if (engine === 'cartesia') {
      const key = await readCartesiaKey();
      if (!key) return new Response('no-key', { status: 404 });
      const r = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'X-API-Key': key,
          'Cartesia-Version': '2024-11-13',
          'content-type': 'application/json',
          'accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          model_id: 'sonic-2',
          transcript: text,
          voice: { mode: 'id', id: body.voiceId ?? 'a0e99841-438c-4a64-b679-ae501e7d6091' },
          output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok || !r.body) return new Response(`cartesia ${r.status}`, { status: 502 });
      return new Response(r.body, { headers: { 'content-type': 'audio/mpeg' } });
    }

    if (engine === 'kokoro') {
      const r = await fetch('http://127.0.0.1:8880/v1/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'kokoro', input: text, voice: body.voiceId ?? 'af_bella', response_format: 'wav' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok || !r.body) return new Response(`kokoro ${r.status}`, { status: 502 });
      return new Response(r.body, { headers: { 'content-type': 'audio/wav' } });
    }

    return new Response('unsupported engine', { status: 400 });
  },
});
