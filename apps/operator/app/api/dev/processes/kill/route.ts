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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isLoopbackOrigin(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  // Next.js binds to PAPERCUSP_BIND_HOST which defaults to 127.0.0.1.
  // The host header arrives as "127.0.0.1:3055" or "localhost:3055".
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isLoopbackOrigin(req)) {
    return NextResponse.json(
      { error: 'loopback-only' },
      { status: 403 },
    );
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
