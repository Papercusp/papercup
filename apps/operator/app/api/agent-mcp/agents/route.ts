/**
 * GET /api/agent-mcp/agents?slug=&limit=
 *
 * Browser-side handler for the agents.across-workspace registry query.
 * Mirrors what the delegate MCP server's listAgents tool exposes —
 * same data, different transport.
 */

import { NextRequest } from 'next/server';
import { listAgentsAcrossWorkspace } from '@/lib/agents-list';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? undefined;
  const limit = url.searchParams.get('limit')
    ? Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit')!, 10) || 40))
    : 40;
  const agents = await listAgentsAcrossWorkspace({ slug, limit });
  return Response.json({ agents });
}
