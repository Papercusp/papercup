/**
 * Realtime full-agent bootstrap.
 *
 * Hands the user's OpenAI key to the browser only when:
 *   - prefs.fullAgentEngine === 'openai-realtime' (user opted in)
 *   - OPENAI key is configured in voice-credentials
 *
 * The Realtime SDK opens a WebRTC connection direct to OpenAI from the
 * browser, so the key has to be available client-side. v1.5 will move
 * this to ephemeral session tokens (POST /v1/realtime/sessions) so the
 * raw key never leaves the server.
 */

import { readOpenAiKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';

export async function GET() {
  const prefs = loadVoicePrefs();
  if (prefs.fullAgentEngine !== 'openai-realtime') {
    return new Response('not-enabled', { status: 404 });
  }
  const apiKey = readOpenAiKey();
  if (!apiKey) return new Response('no-key', { status: 404 });
  return Response.json({ apiKey });
}
