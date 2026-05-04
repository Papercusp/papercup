/**
 * STT bootstrap (server → browser key handoff for cloud STT capture).
 *
 * Cloud STT engines (Deepgram) connect via WebSocket from the browser
 * and need the raw API key. The credentials GET returns masked values,
 * so the browser capture loop calls this narrow endpoint to fetch the
 * unmasked key — gated by:
 *   - sttEngine matches (caller declares which engine it's bootstrapping)
 *   - prefs.webSpeechLeakAcked is true (same gate as Web Speech)
 *   - corresponding key is configured
 *
 * Returns 404 on any gate miss so callers can transparently fall back
 * to the wake-word listener.
 */

import { NextRequest } from 'next/server';
import { readDeepgramKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const engine = url.searchParams.get('engine');
  const prefs = loadVoicePrefs();
  if (!prefs.webSpeechLeakAcked) {
    return new Response('not-acked', { status: 404 });
  }
  if (engine === 'deepgram' && prefs.sttEngine === 'deepgram') {
    const k = readDeepgramKey();
    if (!k) return new Response('no-key', { status: 404 });
    return Response.json({ apiKey: k });
  }
  return new Response('unsupported', { status: 404 });
}
