/**
 * POST /api/agent-mcp/operator-cartesia-test
 *   body: { apiKey?: string }
 *
 * Connection test for Cartesia TTS. Returns voice count on success.
 * Mirrors the elevenlabs-test / openai-test routes.
 */

import { NextRequest } from 'next/server';
import { readCartesiaKey } from '@/lib/voice-credentials';
import { testCartesiaConnection } from '@/lib/voice-engines/cartesia';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { apiKey?: unknown } = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
    ? body.apiKey
    : await readCartesiaKey();
  if (!apiKey) {
    return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
  }
  const result = await testCartesiaConnection(apiKey);
  return Response.json(result);
}
