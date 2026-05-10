/**
 * GET  /api/agent-mcp/operator-conv-voice → { voiceId, voiceName, modelId, agentId }
 * POST /api/agent-mcp/operator-conv-voice  body: { voiceId, modelId? }
 *
 * Backed by `apps/operator/lib/conv-voice.ts` so the legacy route + the
 * MCP tool agree on a single API. POST handles the "voice not yet in
 * your library" case by adding the public voice first.
 */

import { NextRequest } from 'next/server';
import { readConvVoice, setConvVoice } from '@/lib/conv-voice';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const result = await readConvVoice();
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  const { ok: _ok, ...rest } = result;
  return Response.json(rest);
}

export async function POST(req: NextRequest) {
  let body: { voiceId?: string; modelId?: string } = {};
  try { body = await req.json(); } catch { /* tolerate empty */ }
  const voiceId = (body.voiceId ?? '').trim();
  if (!voiceId) {
    return Response.json({ error: 'voiceId required' }, { status: 400 });
  }
  const result = await setConvVoice({ voiceId, modelId: body.modelId });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, voiceId: result.voiceId, voiceName: result.voiceName, modelId: result.modelId });
}
