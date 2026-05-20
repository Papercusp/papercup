/**
 * POST /api/dev/processes/kill — dashboard-only kill endpoint.
 *
 * Dashboard browser callers can't attach the bearer required by the
 * principal-bound `processes:kill` MCP tool (the superuser token lives
 * at ~/.papercusp/superuser-token, only readable server-side). This
 * route is the dashboard's path: it validates loopback origin, then
 * calls killProcess() directly. Agents (future) with a real bearer use
 * the projected /api/agent-tools/processes/kill path.
 *
 * Function-as-truth — same killProcess lib; this is just a different
 * transport gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { killProcess } from '@/lib/process-kill';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }

  let body: { pid?: number; signal?: 'SIGTERM' | 'SIGKILL' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (typeof body.pid !== 'number' || body.pid <= 0) {
    return NextResponse.json({ error: 'pid required' }, { status: 400 });
  }

  const result = await killProcess({
    pid: body.pid,
    signal: body.signal,
    actorSlug: 'system:dev-page',
    workspaceId: activeWorkspaceId(),
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
