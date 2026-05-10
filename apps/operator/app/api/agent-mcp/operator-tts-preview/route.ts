/**
 * TTS preview synthesis (per-engine A/B without saving prefs).
 *
 * Server-side fetch to the cloud TTS APIs using the user's stored keys
 * — keys never leave the server. Browser-based engines (Kokoro local,
 * Web Speech) preview client-side and don't hit this route.
 *
 * Body: { engine: 'kokoro'|'elevenlabs'|'openai'|'cartesia', text?: string, voiceId?: string }
 * Response: audio/mpeg (or audio/wav for Kokoro)
 */

import { NextRequest } from 'next/server';
import { readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '@/lib/voice-credentials';

export const dynamic = 'force-dynamic';

const SAMPLE_TEXT = 'This is a sample of the operator voice.';

export async function POST(req: NextRequest) {
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
    // Kokoro runs locally. Server proxies so the client can preview without
    // discovering the local port itself.
    // Use 127.0.0.1 explicitly: localhost resolves to ::1 first on this
    // Linux setup, but Kokoro/Voicemode binds IPv4. ::1 attempt → ECONNREFUSED.
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
}
