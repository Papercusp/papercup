/**
 * GET /api/agent-mcp/decisions?limit=N
 *
 * Reads operator_decisions SQL view for the active workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export async function GET(req: NextRequest) {
  const limit = Math.min(
    Number(new URL(req.url).searchParams.get('limit') ?? 50),
    500,
  );
  const workspaceId = activeWorkspaceId();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return await tx<
      Array<{ id: string; ts: number; actor: string; action: string; target: string; details: unknown }>
    >`
      SELECT id, ts, actor, action, target, details
        FROM harness_shared.operator_decisions
       ORDER BY ts DESC
       LIMIT ${limit}
    `;
  }).catch(() => [] as any[]);
  return NextResponse.json({ workspaceId, rows });
}
