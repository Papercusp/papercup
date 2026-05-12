/**
 * GET    /api/agent-mcp/operator-voice-prefs       — return current prefs
 * PUT    /api/agent-mcp/operator-voice-prefs       — partial save
 *   body: Partial<VoicePrefs>
 */

import { NextRequest } from 'next/server';
import { loadVoicePrefs, loadWorkspaceVoicePrefs, saveVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';

/**
 * GET ?layer=workspace returns workspace-only prefs (skipping the
 * per-user override merge). Default behavior (no layer param) returns
 * the merged effective prefs as before.
 */
export async function GET(req: NextRequest) {
  const layer = new URL(req.url).searchParams.get('layer');
  if (layer === 'workspace') {
    return Response.json(await loadWorkspaceVoicePrefs());
  }
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
