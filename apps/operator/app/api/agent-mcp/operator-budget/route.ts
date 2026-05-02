/**
 * GET /api/agent-mcp/operator-budget       — current cap + today's spend
 * PUT /api/agent-mcp/operator-budget       — set cap (body: { dailyCapUsd })
 */

import { NextRequest } from 'next/server';
import { checkBudget, setBudget } from '@/lib/operator-budget';

export const dynamic = 'force-dynamic';

export async function GET() {
  const c = checkBudget();
  return Response.json({
    configured: !!c.state,
    dailyCapUsd: c.capUsd,
    todaySpendUsd: c.todaySpendUsd,
    exceeded: c.exceeded,
    spendHistory: c.state?.spend ?? [],
  });
}

export async function PUT(req: NextRequest) {
  let body: { dailyCapUsd?: unknown } = {};
  try {
    body = (await req.json()) as { dailyCapUsd?: unknown };
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const cap = Number(body.dailyCapUsd);
  if (!Number.isFinite(cap) || cap <= 0) {
    return new Response('dailyCapUsd must be a positive number', { status: 400 });
  }
  const next = setBudget(cap);
  return Response.json({ ok: true, dailyCapUsd: next.dailyCapUsd });
}
