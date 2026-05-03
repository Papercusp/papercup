/**
 * GET    /api/agent-mcp/operator-credentials       — return MASKED credentials
 * PUT    /api/agent-mcp/operator-credentials       — set/clear ElevenLabs key
 *   body: { elevenlabsApiKey?: string | null }
 *
 * Only ElevenLabs is supported in v4. The credentials.json file may
 * contain other plugin/service keys; this route only reads/writes
 * the ElevenLabs slice.
 *
 * GET masks the value (`sk_••••3c2a`) — never returns the raw key.
 * PUT preserves missing fields (don't have to re-enter every time).
 * Pass `null` to clear.
 */

import { NextRequest } from 'next/server';
import {
  readElevenLabsKey,
  writeElevenLabsKey,
  readOpenAiKey,
  writeOpenAiKey,
  maskKey,
} from '@/lib/voice-credentials';

export const dynamic = 'force-dynamic';

export async function GET() {
  const elevenlabsRaw = readElevenLabsKey();
  const openaiRaw = readOpenAiKey();
  return Response.json({
    elevenlabs: { apiKey: maskKey(elevenlabsRaw), configured: !!elevenlabsRaw },
    openai:     { apiKey: maskKey(openaiRaw),     configured: !!openaiRaw     },
  });
}

export async function PUT(req: NextRequest) {
  let body: { elevenlabsApiKey?: unknown; openaiApiKey?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  // Preserve-missing semantics: only act on fields that are present.
  if ('elevenlabsApiKey' in body) {
    const v = body.elevenlabsApiKey;
    if (v === null) writeElevenLabsKey(null);
    else if (typeof v === 'string' && v.length > 0) writeElevenLabsKey(v);
    else return new Response('elevenlabsApiKey must be string or null', { status: 400 });
  }
  if ('openaiApiKey' in body) {
    const v = body.openaiApiKey;
    if (v === null) writeOpenAiKey(null);
    else if (typeof v === 'string' && v.length > 0) writeOpenAiKey(v);
    else return new Response('openaiApiKey must be string or null', { status: 400 });
  }
  const elevenlabsRaw = readElevenLabsKey();
  const openaiRaw = readOpenAiKey();
  return Response.json({
    elevenlabs: { apiKey: maskKey(elevenlabsRaw), configured: !!elevenlabsRaw },
    openai:     { apiKey: maskKey(openaiRaw),     configured: !!openaiRaw     },
  });
}
