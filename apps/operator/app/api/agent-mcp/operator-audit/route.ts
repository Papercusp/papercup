/**
 * POST /api/agent-mcp/operator-audit — log a single lifecycle event.
 *
 * Body shape: { cardId: string, kind: OperatorAuditKind, context?: object }
 */

import { NextRequest } from 'next/server';
import { writeOperatorAudit, type OperatorAuditKind, type ActorMethod } from '@/lib/operator-audit';

export const dynamic = 'force-dynamic';

const ALLOWED: ReadonlySet<OperatorAuditKind> = new Set<OperatorAuditKind>([
  // Current lifecycle (post-collapse).
  'accepted',
  'ignored',
  'accept_failed',
  'undo_cancel',
  // Legacy — kept so replayed audits + slow-migrating clients keep working.
  'dispatched',
  'acked',
  'consumed',
  'escalated',
  'rejected',
  'failed',
  'dismissed',
  'superseded',
]);

const ALLOWED_METHODS: ReadonlySet<NonNullable<ActorMethod>> = new Set(['voice', 'click', 'api']);

export async function POST(req: NextRequest) {
  let body: { cardId?: unknown; kind?: unknown; context?: unknown; actorMethod?: unknown } = {};
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
  let actorMethod: ActorMethod = null;
  if (typeof body.actorMethod === 'string' && ALLOWED_METHODS.has(body.actorMethod as any)) {
    actorMethod = body.actorMethod as ActorMethod;
  }
  await writeOperatorAudit({
    cardId,
    kind,
    context: body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : undefined,
    actorMethod,
  });
  return Response.json({ ok: true });
}
