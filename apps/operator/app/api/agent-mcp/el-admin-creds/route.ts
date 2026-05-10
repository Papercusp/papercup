/**
 * GET /api/agent-mcp/el-admin-creds
 *
 * Loopback-only admin endpoint that returns the raw ElevenLabs API key
 * + agent id from PG (operator_voice_credentials, operator_voice_prefs).
 * Used by scripts/el-agent-sync.mjs and scripts/el-voice-preview.mjs as
 * a fallback when the legacy ~/.papercusp/credentials.json file isn't
 * present (post-PG-migration).
 *
 * Bound to 127.0.0.1 by default (PAPERCUSP_BIND_HOST). Even with that,
 * we double-check the request comes from loopback before returning the
 * raw key — never expose this over a public host.
 */
import { NextRequest } from 'next/server';
import { readElevenLabsKey } from '@/lib/voice-credentials';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  if (host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost') {
    return true;
  }
  const xfwd = req.headers.get('x-forwarded-for') ?? '';
  if (xfwd && !xfwd.startsWith('127.') && xfwd !== '::1') return false;
  return host.endsWith(':3055') || host.endsWith(':3070');
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!isLoopback(req)) {
    return Response.json({ error: 'loopback only' }, { status: 403 });
  }
  const [apiKey, prefs] = await Promise.all([
    readElevenLabsKey(),
    loadVoicePrefs(),
  ]);
  return Response.json({
    apiKey: apiKey ?? null,
    agentId: prefs.elevenLabsAgentId || null,
  });
}
