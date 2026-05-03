/**
 * POST /api/agent-mcp/operator-elevenlabs-test
 *   body: { apiKey?: string }
 *
 * Connection test for ElevenLabs. If body.apiKey is present, tests
 * that key (without persisting). Otherwise tests the currently-stored
 * key from credentials.json.
 *
 * Returns subscription tier on success — settings UI displays it
 * ("Connected as <email> — <tier> tier").
 */

import { NextRequest } from 'next/server';
import { readElevenLabsKey } from '@/lib/voice-credentials';
import { testElevenLabsConnection } from '@/lib/voice-engines/elevenlabs';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { apiKey?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — fall through to stored key */
  }
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
    ? body.apiKey
    : readElevenLabsKey();
  if (!apiKey) {
    return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
  }
  const result = await testElevenLabsConnection(apiKey);
  return Response.json(result);
}
