/**
 * POST /api/agent-mcp/operator-dismissed — record a card-id as dismissed
 * so the parser filters re-emissions during the cooldown window.
 *
 * Body: { id: string }
 */

import { NextRequest } from 'next/server';
import { recordDismissed } from '@/lib/operator-dismissed-cache';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { id?: unknown } = {};
  try {
    body = (await req.json()) as { id?: unknown };
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return new Response('id required', { status: 400 });
  recordDismissed(id);
  return Response.json({ ok: true });
}
