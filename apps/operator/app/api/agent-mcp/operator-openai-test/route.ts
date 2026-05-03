/**
 * POST /api/agent-mcp/operator-openai-test
 *   body: { apiKey?: string }
 *
 * Connection test for OpenAI TTS. Returns available TTS models on
 * success — settings UI displays them. Mirrors the ElevenLabs test
 * route's shape.
 */

import { NextRequest } from 'next/server';
import { readOpenAiKey } from '@/lib/voice-credentials';
import { testOpenAiConnection } from '@/lib/voice-engines/openai';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { apiKey?: unknown } = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
    ? body.apiKey
    : readOpenAiKey();
  if (!apiKey) {
    return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
  }
  const result = await testOpenAiConnection(apiKey);
  return Response.json(result);
}
