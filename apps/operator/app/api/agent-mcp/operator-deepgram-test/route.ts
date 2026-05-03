/**
 * POST /api/agent-mcp/operator-deepgram-test
 *   body: { apiKey?: string }
 *
 * Connection test for Deepgram STT. Returns project count on success.
 */

import { NextRequest } from 'next/server';
import { readDeepgramKey } from '@/lib/voice-credentials';
import { testDeepgramConnection } from '@/lib/voice-engines/deepgram';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { apiKey?: unknown } = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
    ? body.apiKey
    : readDeepgramKey();
  if (!apiKey) {
    return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
  }
  const result = await testDeepgramConnection(apiKey);
  return Response.json(result);
}
