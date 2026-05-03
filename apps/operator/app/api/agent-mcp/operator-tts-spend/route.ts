/**
 * GET    /api/agent-mcp/operator-tts-spend      — current spend state
 * PUT    /api/agent-mcp/operator-tts-spend      — update knobs
 *   body: { perKCharRate?, softCapUsd?, hardCapUsd? }
 */

import { NextRequest } from 'next/server';
import { loadSpend, saveSpend } from '@/lib/tts-spend';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(loadSpend());
}

export async function PUT(req: NextRequest) {
  let body: { perKCharRate?: number; softCapUsd?: number; hardCapUsd?: number } = {};
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const cur = loadSpend();
  const next = { ...cur };
  if (typeof body.perKCharRate === 'number' && body.perKCharRate >= 0) {
    next.perKCharRate = body.perKCharRate;
    // Re-compute today's estimate at the new rate (chars are unchanged).
    if (next.spend[0]) {
      next.spend[0].estimatedUsd = (next.spend[0].chars / 1000) * next.perKCharRate;
    }
  }
  if (typeof body.softCapUsd === 'number' && body.softCapUsd >= 0) next.softCapUsd = body.softCapUsd;
  if (typeof body.hardCapUsd === 'number' && body.hardCapUsd >= 0) next.hardCapUsd = body.hardCapUsd;
  saveSpend(next);
  return Response.json(next);
}
