/**
 * POST /api/agent-mcp/run-command/result
 *
 * The leader tab POSTs back the result of a command request that
 * arrived via the SSE channel. Body:
 *   { requestId: string, result: CommandResult }
 *
 * The session-registry resolves the matching pending Promise; the
 * original `deliver()` caller then receives the result.
 */

import { NextRequest } from 'next/server';
import { resolveRequest } from '@/lib/commands/session-registry';
import type { CommandResult } from '@/lib/commands/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  requestId?: string;
  result?: CommandResult;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  if (!body.requestId || !body.result) {
    return new Response('missing requestId or result', { status: 400 });
  }
  const ok = resolveRequest(body.requestId, body.result);
  return Response.json({ ok });
}
