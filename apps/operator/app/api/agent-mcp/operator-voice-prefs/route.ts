/**
 * GET    /api/agent-mcp/operator-voice-prefs       — return current prefs
 * PUT    /api/agent-mcp/operator-voice-prefs       — partial save
 *   body: Partial<VoicePrefs>
 */

import { NextRequest } from 'next/server';
import { loadVoicePrefs, saveVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await loadVoicePrefs());
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response('expected JSON object', { status: 400 });
  }
  const next = await saveVoicePrefs(body as any);
  return Response.json(next);
}
