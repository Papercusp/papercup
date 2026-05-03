/**
 * GET /api/agent-mcp/operator-stats — 7-day operator KPIs.
 *
 * Used by the /settings/operator stats panel. PG-driven; returns
 * empty zeros (never errors) when audit_log isn't reachable.
 */

import { readOperatorStats } from '@/lib/operator-stats';

export const dynamic = 'force-dynamic';

export async function GET() {
  const stats = await readOperatorStats();
  return Response.json(stats);
}
