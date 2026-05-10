/**
 * POST /api/agent-mcp/voice-utterance-log — legacy browser entrypoint.
 *
 * Server-side audit log for voice utterances. Body shape documented in
 * `apps/operator/lib/voice-utterance-log.ts`. Degrades silently if the
 * table is missing.
 */

import { NextRequest } from 'next/server';
import { logVoiceUtterance, type VoiceUtteranceLogInput } from '@/lib/voice-utterance-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  let body: VoiceUtteranceLogInput;
  try {
    body = (await req.json()) as VoiceUtteranceLogInput;
  } catch {
    return Response.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }
  const result = await logVoiceUtterance(body);
  if (!result.ok) {
    return Response.json(result, { status: 500 });
  }
  return Response.json(result);
}
