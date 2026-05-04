/**
 * GET /api/agent-mcp/operator-elevenlabs-bootstrap
 *
 * Mints a short-lived conversation token for the configured ElevenLabs
 * Conv AI agent so the browser can open a WebRTC session to it without
 * exposing the workspace API key.
 *
 * Returns:
 *   {
 *     conversationToken: string,    // pass as `conversationToken` to Conversation.startSession
 *     agentId: string,
 *     expiresAt?: number,            // unix ms
 *   }
 *
 * Errors are returned as JSON with 4xx/5xx status so the client-side
 * caller can fall back gracefully (toast → ask user to switch engine
 * in settings, etc.).
 */

import { readElevenLabsKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const prefs = loadVoicePrefs();
  if (prefs.fullAgentEngine !== 'elevenlabs-conv' &&
      prefs.fullAgentEngine !== 'elevenlabs-conversational') {
    return Response.json({ error: 'not-enabled' }, { status: 404 });
  }

  const agentId = prefs.elevenLabsAgentId?.trim();
  if (!agentId) {
    return Response.json(
      { error: 'no-agent-id', hint: 'Set the ElevenLabs agent ID in /settings/voice.' },
      { status: 404 },
    );
  }

  const apiKey = readElevenLabsKey();
  if (!apiKey) {
    return Response.json(
      { error: 'no-api-key', hint: 'Add your ElevenLabs API key in /settings/api-keys.' },
      { status: 404 },
    );
  }

  // Conversation token endpoint for WebRTC. Per ElevenLabs API:
  //   GET /v1/convai/conversation/token?agent_id=<id>
  //   Headers: xi-api-key
  //   Returns: { token: '...' } (the conversation token, ~1 min TTL)
  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
          'accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch (err: unknown) {
    return Response.json(
      { error: 'mint-failed', detail: (err as Error)?.message ?? String(err) },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return Response.json(
      { error: 'mint-rejected', status: res.status, detail: detail.slice(0, 400) },
      { status: 502 },
    );
  }

  const data = (await res.json().catch(() => ({}))) as { token?: string; conversation_token?: string };
  const token = data.token ?? data.conversation_token;
  if (typeof token !== 'string' || !token) {
    return Response.json(
      { error: 'mint-shape', detail: 'no token in response' },
      { status: 502 },
    );
  }

  return Response.json({
    conversationToken: token,
    agentId,
  });
}
