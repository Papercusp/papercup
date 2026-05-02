/**
 * GET /api/agent-mcp/operator-message-status?ids=msg-1,msg-2,…
 *
 * Returns receiving-state for a batch of dispatched messages. The panel
 * polls this for cards in `dispatched` state to derive `consumed` /
 * `escalated` / `rejected`.
 */

import { NextRequest } from 'next/server';
import { readMessageStatuses } from '@/lib/operator-message-status';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const idsParam = new URL(req.url).searchParams.get('ids') ?? '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  if (!ids.length) return Response.json({ rows: [] });
  const rows = await readMessageStatuses(ids);
  return Response.json({ rows });
}
