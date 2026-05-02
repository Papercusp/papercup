/**
 * POST /api/agent-mcp/operator-audit — log a single lifecycle event.
 *
 * Body shape: { cardId: string, kind: 'dispatched'|'acked'|'undo_cancel', context?: object }
 */

import { NextRequest } from 'next/server';
import { writeOperatorAudit, type OperatorAuditKind } from '@/lib/operator-audit';

export const dynamic = 'force-dynamic';

const ALLOWED: ReadonlySet<OperatorAuditKind> = new Set([
  'dispatched',
  'acked',
  'undo_cancel',
  'consumed',
  'escalated',
  'rejected',
  'failed',
  'dismissed',
  'superseded',
]);

export async function POST(req: NextRequest) {
  let body: { cardId?: unknown; kind?: unknown; context?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const cardId = typeof body.cardId === 'string' ? body.cardId : '';
  const kind = body.kind as OperatorAuditKind;
  if (!cardId || !ALLOWED.has(kind)) {
    return new Response('cardId and kind required (see OperatorAuditKind)', { status: 400 });
  }
  await writeOperatorAudit({
    cardId,
    kind,
    context: body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : undefined,
  });
  return Response.json({ ok: true });
}
